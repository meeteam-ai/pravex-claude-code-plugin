#!/usr/bin/env node
/**
 * Pravex SessionEnd hook.
 *
 * Reads the hook payload from stdin, aggregates the session transcript
 * (tokens per model, duration, files touched, tool errors, PR url) and
 * POSTs it to `POST /api/sessions` on the configured Pravex host.
 *
 * Config (first match wins):
 *   - env PRAVEX_API_KEY + PRAVEX_API_HOST
 *   - ~/.pravex/config.json  { "apiHost": "...", "apiKey": "pvx_..." }
 *
 * Never blocks Claude Code: every failure is logged to ~/.pravex/last-report.log
 * and the process exits 0.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const readline = require('readline');
const { execFileSync } = require('child_process');

const CONFIG_DIR = path.join(os.homedir(), '.pravex');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const LOG_FILE = path.join(CONFIG_DIR, 'last-report.log');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TEST_FILE_RE = /(\.test\.|\.spec\.|_test\.|(^|\/)test_|\/tests?\/|__tests__\/)/;
const PR_URL_RE =
  /https?:\/\/(?:www\.)?(?:github\.com\/[^\s"'<>)]+\/pull\/\d+|gitlab\.com\/[^\s"'<>)]+\/merge_requests\/\d+|bitbucket\.org\/[^\s"'<>)]+\/pull-requests\/\d+)/g;

function log(msg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* ignore */
  }
}

function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    /* no config file */
  }
  const apiKey = process.env.PRAVEX_API_KEY || file.apiKey;
  const apiHost = (process.env.PRAVEX_API_HOST || file.apiHost || '').replace(/\/+$/, '');
  return { apiKey, apiHost };
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    // Hook stdin always closes; guard anyway.
    setTimeout(() => resolve(data), 2000).unref();
  });
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

function repoSlug(cwd) {
  const url = git(['remote', 'get-url', 'origin'], cwd);
  if (!url) return cwd ? path.basename(cwd) : '';
  // git@github.com:owner/name.git | https://github.com/owner/name.git
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url);
  return m ? m[1] : url;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && b.type === 'text' ? b.text : typeof b === 'string' ? b : ''))
    .join('\n');
}

function collectPrUrls(str, into) {
  if (!str) return;
  let m;
  PR_URL_RE.lastIndex = 0;
  while ((m = PR_URL_RE.exec(str)) !== null) into.add(m[0]);
}

async function aggregate(transcriptPath) {
  const byMessage = new Map(); // message.id -> { model, usage }
  const files = new Set();
  const prUrls = new Set();
  let toolUses = 0;
  let toolErrors = 0;
  let first = null;
  let last = null;
  let branch = '';
  let aiTitle = '';
  let firstPrompt = '';

  const rl = readline.createInterface({
    input: fs.createReadStream(transcriptPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.timestamp) {
      if (!first || o.timestamp < first) first = o.timestamp;
      if (!last || o.timestamp > last) last = o.timestamp;
    }
    if (o.gitBranch && o.gitBranch !== 'HEAD' && !branch) branch = o.gitBranch;
    if (o.type === 'ai-title' && o.aiTitle) aiTitle = o.aiTitle;

    const msg = o.message;
    if (!msg || typeof msg !== 'object') continue;

    if (o.type === 'assistant') {
      // Streaming writes one line per content block with the same message.id — dedupe.
      if (msg.id && msg.usage) byMessage.set(msg.id, { model: msg.model, usage: msg.usage });
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (!b) continue;
          if (b.type === 'tool_use') {
            toolUses += 1;
            const fp = b.input && (b.input.file_path || b.input.notebook_path);
            if (EDIT_TOOLS.has(b.name) && typeof fp === 'string') files.add(fp);
          } else if (b.type === 'text') {
            collectPrUrls(b.text, prUrls);
          }
        }
      }
    } else if (o.type === 'user') {
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (!b) continue;
          if (b.type === 'tool_result') {
            if (b.is_error) toolErrors += 1;
            collectPrUrls(textOf(b.content), prUrls);
          }
        }
      }
      if (!firstPrompt && !o.isMeta) {
        const t = textOf(msg.content).trim();
        // Skip system tags and slash commands so the title is a real prompt.
        if (t && !t.startsWith('<') && !t.startsWith('/')) firstPrompt = t;
      }
    }
  }

  const usageByModel = new Map();
  for (const { model, usage } of byMessage.values()) {
    const key = model || 'unknown';
    const u = usageByModel.get(key) || {
      model: key,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    u.inputTokens += usage.input_tokens || 0;
    u.outputTokens += usage.output_tokens || 0;
    u.cacheReadTokens += usage.cache_read_input_tokens || 0;
    u.cacheWriteTokens += usage.cache_creation_input_tokens || 0;
    usageByModel.set(key, u);
  }

  const testsAdded = [...files].filter((f) => TEST_FILE_RE.test(f)).length;
  const retryRate = toolUses ? Math.round((toolErrors / toolUses) * 1000) / 10 : 0;
  const title = (aiTitle || firstPrompt || '').replace(/\s+/g, ' ').slice(0, 120);
  const prUrl = prUrls.size ? [...prUrls].pop() : undefined;

  return {
    usage: [...usageByModel.values()],
    startedAt: first,
    endedAt: last,
    branch,
    title,
    filesTouched: files.size,
    testsAdded,
    retryRate,
    prUrl,
    assistantMessages: byMessage.size,
  };
}

function post(apiHost, apiKey, body) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/sessions', apiHost);
    const payload = JSON.stringify(body);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': 'pravex-claude-code-plugin/0.1.0',
        },
        timeout: 10000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  const { apiKey, apiHost } = loadConfig();
  if (!apiKey || !apiHost) {
    log('skipped: no apiKey/apiHost (run /pravex:setup)');
    return;
  }

  let input = {};
  try {
    input = JSON.parse((await readStdin()) || '{}');
  } catch {
    log('skipped: could not parse hook stdin');
    return;
  }

  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path && input.transcript_path.replace(/^~/, os.homedir());
  const cwd = input.cwd || process.cwd();
  if (!sessionId || !transcriptPath || !fs.existsSync(transcriptPath)) {
    log(`skipped: missing session_id or transcript (${transcriptPath})`);
    return;
  }

  const agg = await aggregate(transcriptPath);
  if (!agg.assistantMessages || !agg.startedAt) {
    log(`skipped ${sessionId}: empty transcript`);
    return;
  }

  const body = {
    externalId: sessionId,
    title: agg.title || undefined,
    repo: repoSlug(cwd),
    branch: agg.branch || git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).replace(/^HEAD$/, ''),
    startedAt: agg.startedAt,
    endedAt: agg.endedAt,
    usage: agg.usage,
    filesTouched: agg.filesTouched,
    testsAdded: agg.testsAdded,
    retryRate: agg.retryRate,
    prUrl: agg.prUrl,
  };

  try {
    const res = await post(apiHost, apiKey, body);
    if (res.status >= 200 && res.status < 300) {
      log(`ok ${sessionId} -> ${res.status} ${res.body.slice(0, 200)}`);
    } else {
      log(`error ${sessionId} -> ${res.status} ${res.body.slice(0, 500)}`);
    }
  } catch (err) {
    log(`error ${sessionId} -> ${err && err.message}`);
  }
}

main()
  .catch((err) => log(`fatal: ${err && err.stack}`))
  .finally(() => process.exit(0));
