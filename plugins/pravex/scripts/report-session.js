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
const SPOOL_DIR = path.join(CONFIG_DIR, 'spool');
// A session ends offline more often than you would think — VPN down, laptop closed on a
// plane. Ingest is idempotent on `externalId`, so replaying a spooled report is safe.
const SPOOL_MAX = 50;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Claude Code writes placeholder assistant turns (API errors, interrupts) as `<synthetic>`
// with an all-zero usage block. They are not a model and must never reach the dashboard.
const SYNTHETIC_MODEL = '<synthetic>';
// A fallback title is raw user input, which is routinely a pasted credential. Mask anything
// that looks like a key before it leaves the machine.
const SECRET_RE =
  /\b(?:[A-Za-z0-9]{2,10}[_-])?(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g;
const TEST_FILE_RE = /(\.test\.|\.spec\.|_test\.|(^|\/)test_|\/tests?\/|__tests__\/)/;
// Gaps longer than this are somebody walking away, not working. Measured across real
// transcripts the curve flattens between 5 and 10 minutes, and one session left open
// overnight reported 7,237 wall-clock minutes against ~110 minutes of actual activity.
const IDLE_GAP_MS = 5 * 60 * 1000;
// Files a `Bash` call wrote, for the shapes that can be read off the command line.
// Deliberately partial: a heredoc into a python script is unknowable from here, so this
// finds the common redirections rather than pretending to be exhaustive.
const BASH_WRITE_RES = [
  /(?:^|[;&|]|\s)(?:>>?)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|>]+))/g,
  /\btee\s+(?:-a\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g,
  /\bsed\s+[^;&|]*-i[^;&|]*\s(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*$/gm,
  /\b(?:cp|mv|install)\s+[^;&|]*\s(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:$|[;&|])/gm,
];
// Redirections that are not a file being written.
const NOT_A_FILE = /^(?:\/dev\/|&\d|\d>|$)/;
// What a path actually looks like: a directory somewhere in it, or a bare filename with
// an extension. Without this the redirection patterns happily match `fs=require("fs")`,
// `start:` and `0)` out of the middle of an inline script.
const LOOKS_LIKE_PATH = /^(?:\.{0,2}\/|~\/|[A-Za-z0-9._-]+\/)[A-Za-z0-9._\/-]+$|^[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8}$/;
// `node -e`, `python -c` and friends carry their own code, and a `>` inside that code is
// not a shell redirection. Their bodies are unreadable from here, so skip them whole.
const INLINE_SCRIPT = /\b(?:node|python3?|ruby|perl|deno|bun|osascript)\s+-(?:e|c)\b/;
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

/**
 * `owner/name` out of a pull-request URL, lowercased.
 *
 * Works off the tail of the path rather than the host, so all three forges are one
 * code path: strip the `/pull/123`, `/merge_requests/9`, `/pull-requests/4` suffix
 * and GitLab's `/-` separator, then take the last two segments. A nested GitLab
 * subgroup yields `subgroup/name`, which is still specific enough to match on.
 */
function prUrlSlug(url) {
  try {
    const segments = new URL(url).pathname
      .replace(/\/(?:pull|merge_requests|pull-requests)\/\d+.*$/, '')
      .replace(/\/-$/, '')
      .split('/')
      .filter(Boolean);
    if (segments.length < 2) return '';
    return segments.slice(-2).join('/').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Does this pull-request URL belong to the repo the session was worked in?
 *
 * PR URLs are collected from assistant text and tool output, and tool output
 * includes things like a browser's open-tab list. Measured against a real
 * transcript, that reported a pull request from an unrelated repo belonging to a
 * different organisation — it was simply open in another tab — and the dashboard
 * would have shown it to every admin as the PR for this session.
 *
 * So a URL has to name the session's own repo to be believed. When the repo cannot
 * be determined (no `origin` remote, so `repoSlug` falls back to the directory
 * name) only the repository name is compared, and a URL is dropped rather than
 * guessed at.
 */
function prUrlMatchesRepo(url, repo) {
  const slug = prUrlSlug(url);
  if (!slug || !repo) return false;
  const own = repo.toLowerCase().replace(/\.git$/, '');
  if (own.includes('/')) return slug === own.split('/').slice(-2).join('/');
  return slug.split('/')[1] === own;
}

/**
 * Minutes the session was actually being worked on.
 *
 * Wall clock between the first and last transcript line counts a laptop left open
 * overnight as work: one real session measured 7,237 wall-clock minutes against ~110
 * minutes of activity. Gaps longer than `IDLE_GAP_MS` are dropped rather than clamped,
 * so a long think still counts and a lunch break does not.
 */
function activeMinutes(stamps) {
  if (stamps.length < 2) return 0;
  const ms = stamps.map((s) => Date.parse(s)).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  let active = 0;
  for (let i = 1; i < ms.length; i += 1) {
    const gap = ms[i] - ms[i - 1];
    if (gap > 0 && gap <= IDLE_GAP_MS) active += gap;
  }
  return Math.round(active / 60000);
}

/**
 * Files a shell command wrote, as far as the command line can tell.
 *
 * Partial on purpose. Redirections, `tee`, `sed -i`, `cp`/`mv` are readable; a python
 * script that opens its own files is not, and under `--dangerously-skip-permissions`
 * that is a common way to edit. Undercounting is the acceptable failure here —
 * inventing a file that was never written is not.
 */
function bashWrites(command) {
  const out = new Set();
  if (INLINE_SCRIPT.test(command)) return out;
  for (const re of BASH_WRITE_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(command)) !== null) {
      const file = m[1] || m[2] || m[3];
      if (!file || NOT_A_FILE.test(file)) continue;
      // Variables, globs and shell syntax are not a path we can attribute.
      if (/[$*?()=`{}'"<>|;&]/.test(file)) continue;
      if (!LOOKS_LIKE_PATH.test(file)) continue;
      out.add(file);
    }
  }
  return out;
}

/** Mask key-shaped tokens so a pasted secret never ships as a session title. */
function redact(str) {
  return str.replace(SECRET_RE, '[redacted]');
}

/**
 * @param repo `owner/name` for the working directory, used to reject pull-request
 *   URLs that belong to some other repository. See `prUrlMatchesRepo`.
 */
async function aggregate(transcriptPath, repo) {
  const byMessage = new Map(); // message.id -> { model, usage }
  // tool_use.id -> file path, resolved to a real edit only once its result says it
  // succeeded. A denied or failed edit never touched the file.
  const pendingEdits = new Map();
  const files = new Set();
  const bashFiles = new Set();
  const prUrls = new Set();
  const stamps = [];
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
      stamps.push(o.timestamp);
    }
    // Last wins: a session that starts on `main` and ends on a feature branch belongs to
    // the branch the work landed on, which is also what the git fallback below reports.
    if (o.gitBranch && o.gitBranch !== 'HEAD') branch = o.gitBranch;
    if (o.type === 'ai-title' && o.aiTitle) aiTitle = o.aiTitle;

    const msg = o.message;
    if (!msg || typeof msg !== 'object') continue;

    if (o.type === 'assistant') {
      // Streaming writes one line per content block with the same message.id — dedupe.
      if (msg.id && msg.usage && msg.model !== SYNTHETIC_MODEL) {
        byMessage.set(msg.id, { model: msg.model, usage: msg.usage });
      }
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (!b) continue;
          if (b.type === 'tool_use') {
            toolUses += 1;
            const fp = b.input && (b.input.file_path || b.input.notebook_path);
            // Held until the matching tool_result confirms it landed.
            if (EDIT_TOOLS.has(b.name) && typeof fp === 'string' && b.id) pendingEdits.set(b.id, fp);
            if (b.name === 'Bash' && b.input && typeof b.input.command === 'string') {
              for (const f of bashWrites(b.input.command)) bashFiles.add(f);
            }
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
            const fp = pendingEdits.get(b.tool_use_id);
            if (fp !== undefined) {
              if (!b.is_error) files.add(fp);
              pendingEdits.delete(b.tool_use_id);
            }
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

  // Shell-written files join the edit-tool files, deduped by path.
  for (const f of bashFiles) files.add(f);
  const testsAdded = [...files].filter((f) => TEST_FILE_RE.test(f)).length;
  const retryRate = toolUses ? Math.round((toolErrors / toolUses) * 1000) / 10 : 0;
  const title = redact((aiTitle || firstPrompt || '').replace(/\s+/g, ' ')).slice(0, 120);
  // Last one wins, but only among URLs that actually name this repo.
  const ownPrUrls = [...prUrls].filter((u) => prUrlMatchesRepo(u, repo));
  const prUrl = ownPrUrls.length ? ownPrUrls[ownPrUrls.length - 1] : undefined;
  const prUrlsRejected = prUrls.size - ownPrUrls.length;

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
    prUrlsRejected,
    durationMinutes: activeMinutes(stamps),
    filesTouchedFromShell: bashFiles.size,
    assistantMessages: byMessage.size,
  };
}

/** Park a report that could not be delivered, oldest dropped once the spool is full. */
function spool(body) {
  try {
    fs.mkdirSync(SPOOL_DIR, { recursive: true, mode: 0o700 });
    const entries = fs.readdirSync(SPOOL_DIR).filter((f) => f.endsWith('.json')).sort();
    for (const stale of entries.slice(0, Math.max(0, entries.length - (SPOOL_MAX - 1)))) {
      try { fs.unlinkSync(path.join(SPOOL_DIR, stale)); } catch { /* already gone */ }
    }
    const name = `${Date.now()}-${String(body.externalId).replace(/[^A-Za-z0-9_-]/g, '')}.json`;
    fs.writeFileSync(path.join(SPOOL_DIR, name), JSON.stringify(body), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Retry whatever is parked, oldest first, before reporting this session.
 *
 * Stops at the first failure rather than hammering a host that is still down, and only
 * deletes an entry the server actually accepted — or rejected as its own fault (4xx),
 * which will never succeed on a replay either.
 */
async function flushSpool(apiHost, apiKey) {
  let entries;
  try {
    entries = fs.readdirSync(SPOOL_DIR).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return;
  }
  for (const file of entries) {
    const full = path.join(SPOOL_DIR, file);
    let body;
    try {
      body = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      try { fs.unlinkSync(full); } catch { /* already gone */ }
      continue;
    }
    try {
      const res = await post(apiHost, apiKey, body);
      if (res.status >= 500) {
        log(`spool: ${file} still failing (${res.status}), keeping`);
        return;
      }
      try { fs.unlinkSync(full); } catch { /* already gone */ }
      log(`spool: replayed ${file} -> ${res.status}`);
    } catch (err) {
      log(`spool: ${file} deferred (${err && err.message})`);
      return;
    }
  }
}

/** Join a route onto the configured host, keeping any path the host already carries. */
function apiUrl(apiHost, route) {
  const base = new URL(apiHost);
  base.pathname = `${base.pathname.replace(/\/+$/, '')}${route}`;
  return base;
}

function post(apiHost, apiKey, body) {
  return new Promise((resolve, reject) => {
    const url = apiUrl(apiHost, '/api/sessions');
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

  // Resolved before aggregating: it is what a pull-request URL has to match.
  const repo = repoSlug(cwd);

  const agg = await aggregate(transcriptPath, repo);
  if (!agg.assistantMessages || !agg.startedAt) {
    log(`skipped ${sessionId}: empty transcript`);
    return;
  }
  if (agg.prUrlsRejected) {
    log(`${sessionId}: ignored ${agg.prUrlsRejected} pull-request url(s) from outside ${repo}`);
  }

  const body = {
    externalId: sessionId,
    title: agg.title || undefined,
    repo,
    branch: agg.branch || git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).replace(/^HEAD$/, ''),
    startedAt: agg.startedAt,
    endedAt: agg.endedAt,
    // Sent explicitly so the server does not fall back to wall clock.
    durationMinutes: agg.durationMinutes,
    usage: agg.usage,
    filesTouched: agg.filesTouched,
    testsAdded: agg.testsAdded,
    retryRate: agg.retryRate,
    prUrl: agg.prUrl,
  };

  await flushSpool(apiHost, apiKey);

  try {
    const res = await post(apiHost, apiKey, body);
    if (res.status >= 200 && res.status < 300) {
      log(`ok ${sessionId} -> ${res.status} ${res.body.slice(0, 200)}`);
    } else if (res.status >= 500) {
      // The server's problem, so it is worth replaying. A 4xx is ours and never will be.
      log(`error ${sessionId} -> ${res.status} ${res.body.slice(0, 500)}${spool(body) ? ' (spooled)' : ''}`);
    } else {
      log(`error ${sessionId} -> ${res.status} ${res.body.slice(0, 500)}`);
    }
  } catch (err) {
    log(`error ${sessionId} -> ${err && err.message}${spool(body) ? ' (spooled)' : ''}`);
  }
}

main()
  .catch((err) => log(`fatal: ${err && err.stack}`))
  .finally(() => process.exit(0));
