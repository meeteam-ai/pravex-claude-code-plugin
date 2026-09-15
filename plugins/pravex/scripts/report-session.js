#!/usr/bin/env node
/**
 * Pravex session-reporting hook. Runs at three points in a session's life.
 *
 *   --start      SessionStart: report this session as live, and sweep for any
 *                previous session that was never reported at all
 *   --progress   Stop: update the running numbers after an assistant turn
 *   (none)       SessionEnd: the final report
 *
 * Reads the hook payload from stdin, aggregates the session transcript
 * (tokens per model, duration, files touched, tool errors, PR url) and
 * POSTs it to `POST /api/sessions` on the configured Pravex host.
 *
 * ⚠️ **`SessionEnd` does not always fire.** It fires on `clear`, `logout`,
 * `prompt_input_exit` and `other` — closing the terminal or killing the process
 * fires nothing, and that session would never be reported. Measured, not
 * assumed. The `SessionStart` sweep is what covers it: ingest is idempotent on
 * `externalId`, so re-reporting a session already sent is free.
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
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const CONFIG_DIR = path.join(os.homedir(), '.pravex');
const PLUGIN_VERSION = (() => {
  try {
    return require('../.claude-plugin/plugin.json').version;
  } catch {
    return 'unknown';
  }
})();
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const LOG_FILE = path.join(CONFIG_DIR, 'last-report.log');
const SPOOL_DIR = path.join(CONFIG_DIR, 'spool');
// A session ends offline more often than you would think — VPN down, laptop closed on a
// plane. Ingest is idempotent on `externalId`, so replaying a spooled report is safe.
const SPOOL_MAX = 50;
/** Where Claude Code keeps transcripts, one directory per project. */
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
/** Records which sessions have been reported, so the sweep does not re-send everything. */
const REPORTED_FILE = path.join(CONFIG_DIR, 'reported.json');
/**
 * Transcripts the sweep will look at, newest first.
 *
 * Bounded because the directory grows without limit — a machine with two years
 * of history should not read all of it on every session start. A session missed
 * by more than this many transcripts ago is lost, which is the acceptable trade:
 * the alternative is a hook that takes seconds to run.
 */
const SWEEP_MAX_FILES = 40;
/** Sessions older than this are not worth sweeping for; they are nobody's current work. */
const SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How many ids to remember. Enough to cover the sweep window several times over. */
const REPORTED_MAX = 500;
/**
 * Wall-clock budget for the whole sweep.
 *
 * This runs on `SessionStart`, before the user's first prompt, and the hook is
 * killed at 30 seconds. Measured on a real machine the first sweep after
 * upgrading read 460 MB across 40 transcripts in 2.7s — comfortable, but that is
 * one machine's numbers on one day, and the POSTs that follow are sequential and
 * as slow as the network is.
 *
 * So the bound is stated rather than inferred. Whatever is left over is picked up
 * by the next session start, because each reported id is recorded as it succeeds.
 */
const SWEEP_BUDGET_MS = 10_000;
/** Records when each session last sent a progress report, so `Stop` can throttle. */
const PROGRESS_FILE = path.join(CONFIG_DIR, 'progress.json');
/**
 * One empty file per session the user took incognito with `/pravex:incognito`.
 *
 * A file per session rather than a JSON map: the command, the `Stop` hook and the
 * status line can all touch it at once, and creating a file is atomic where
 * rewriting a shared map is a lost update. `statusline.js` reads the same path —
 * change both together.
 */
const INCOGNITO_DIR = path.join(CONFIG_DIR, 'incognito');
/** Markers outlive the session by a month, then go: long enough for the sweep and any spooled replay. */
const INCOGNITO_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Least time between two `Stop` reports for the same session.
 *
 * ⚠️ **This is the single most expensive decision in the hook, so it is stated
 * rather than left implicit.** `Stop` fires after *every* assistant turn, and each
 * report re-reads and re-parses the whole transcript from byte 0 — O(final size)
 * per turn, so O(turns x size) per session. A session reaching 20 MB over 60 turns
 * would read and parse ~600 MB, of which ~98% is lines already seen, and add
 * 0.1-0.3s of blocking latency to every turn plus a database write on the server.
 *
 * None of that buys anything: the server's own liveness window is fifteen minutes
 * (`LIVE_GRACE_MS`), so it cannot tell per-turn reporting from per-minute
 * reporting. Ninety seconds keeps the indicator honest and cuts the work by an
 * order of magnitude.
 */
const PROGRESS_MIN_INTERVAL_MS = 90_000;

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
/**
 * Version of the extracted-transcript format. Bumped when its shape changes, so
 * the server can read an older plugin's upload instead of guessing.
 */
const TRANSCRIPT_FORMAT = 1;
/** Longest single message kept. Past this a turn is context, not content. */
const TRANSCRIPT_MAX_TEXT = 4000;
/**
 * Ceiling on the gzipped upload, before base64.
 *
 * Measured across 358 real transcripts the worst single file was 49.3 MB raw,
 * 141 KB extracted, **50 KB gzipped** — so 1 MB is roughly twenty times the
 * worst case seen. It exists for the transcript nobody has measured yet: without
 * it one pathological session could post a body large enough to be refused, and
 * the whole report would be lost rather than the transcript alone.
 */
const TRANSCRIPT_MAX_GZIP = 1024 * 1024;

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

/** Session ids are UUIDs; anything else must not become a path segment. */
function incognitoMarker(sessionId) {
  const safe = String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '');
  return safe ? path.join(INCOGNITO_DIR, safe) : null;
}

function isIncognito(sessionId) {
  const marker = incognitoMarker(sessionId);
  return Boolean(marker && fs.existsSync(marker));
}

/** One-way for the life of the session: there is no un-incognito, so nothing already withheld can be sent later. */
function markIncognito(sessionId) {
  const marker = incognitoMarker(sessionId);
  if (!marker) return false;
  fs.mkdirSync(INCOGNITO_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(marker, '', { mode: 0o600 });
  return true;
}

function pruneIncognito(now = Date.now()) {
  let entries = [];
  try {
    entries = fs.readdirSync(INCOGNITO_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(INCOGNITO_DIR, entry);
    try {
      if (now - fs.statSync(full).mtimeMs > INCOGNITO_MAX_AGE_MS) fs.unlinkSync(full);
    } catch {
      /* already gone */
    }
  }
}

/**
 * The line shown to the user when a session starts — the indicator that Pravex is
 * watching, or that it cannot.
 *
 * `null` after `/clear` and compaction: the session did not change hands, and a
 * banner every time the context is compacted would be noise nobody reads.
 */
function startMessage({ configured, incognito, source }) {
  if (source === 'clear' || source === 'compact') return null;
  if (!configured) return 'Pravex: not connected, so this session will not be reported. Run /pravex:login.';
  if (incognito) return 'Pravex: incognito. Only usage and cost are reported for this session.';
  return 'Pravex: recording this session. Run /pravex:incognito to keep the conversation private.';
}

/**
 * Keep the installed status line copy current. Only once somebody ran
 * `/pravex:statusline`: installing it is theirs to choose, updating it is ours.
 */
function refreshStatusline() {
  try {
    const statusline = require('./statusline.js');
    if (fs.existsSync(statusline.INSTALLED_COPY)) statusline.refreshCopy(path.join(__dirname, 'statusline.js'));
  } catch (err) {
    log(`statusline refresh failed: ${err && err.message}`);
  }
}

/** Where Claude Code keeps a session's transcript, for the command that has only its id. */
function findTranscript(sessionId) {
  const name = `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '')}.jsonl`;
  try {
    for (const project of fs.readdirSync(PROJECTS_DIR)) {
      const full = path.join(PROJECTS_DIR, project, name);
      if (fs.existsSync(full)) return full;
    }
  } catch {
    /* no projects directory */
  }
  return null;
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
 * Keep the prompts and the replies; throw away everything else.
 *
 * Measured across 358 real transcripts (1.4 GB): `attachment` lines are **79.9%**
 * of the bytes — `hook_success` alone is 64% of a file — and most of what is left
 * under `user` is tool *output* rather than anything a person typed. Keeping only
 * user prompts, assistant prose and the tool **names** comes to 0.38% of raw, and
 * 0.13% gzipped.
 *
 * That ratio is the whole reason this is cheap enough to do at all, and it is also
 * what keeps attachments and hook output — the two things most likely to contain
 * somebody's environment — from ever leaving the machine.
 *
 * Tool *names*, never arguments or results: "it ran Edit and Bash" is what a
 * summary needs, and a `Bash` command line or a `Read` result is exactly the sort
 * of thing that carries a path, a hostname or a token.
 */
function extractTurn(entry) {
  const msg = entry.message;
  if (!msg || typeof msg !== 'object') return null;

  if (entry.type === 'user') {
    if (entry.isMeta) return null;
    const text = textOf(msg.content).trim();
    // A tool result reduces to empty here, which is what drops it.
    if (!text || text.startsWith('<')) return null;
    return { role: 'user', at: entry.timestamp, text: clampText(text) };
  }

  if (entry.type === 'assistant') {
    if (!Array.isArray(msg.content)) return null;
    const text = [];
    const tools = [];
    for (const block of msg.content) {
      if (!block) continue;
      if (block.type === 'text' && block.text) text.push(block.text);
      else if (block.type === 'tool_use' && block.name) tools.push(block.name);
    }
    const joined = text.join('\n').trim();
    if (!joined && !tools.length) return null;
    const turn = { role: 'assistant', at: entry.timestamp };
    if (joined) turn.text = clampText(joined);
    if (tools.length) turn.tools = tools;
    return turn;
  }

  return null;
}

/**
 * Redacted, then cut.
 *
 * In that order on purpose: truncating first could leave the front half of a key
 * in place, and half a token is still most of a token.
 */
function clampText(text) {
  const safe = redact(text);
  return safe.length > TRANSCRIPT_MAX_TEXT ? `${safe.slice(0, TRANSCRIPT_MAX_TEXT)}…` : safe;
}

/**
 * Gzip the extracted turns, dropping from the **front** if the result is too big.
 *
 * The front, because the end of a session is what a summary is about — what was
 * decided, what was built, what broke. The opening of a long session is setup.
 *
 * Returns null rather than throwing: a transcript that cannot be packed must not
 * cost the session its metrics, which are the part somebody is looking at a
 * dashboard for.
 */
function packTranscript(turns) {
  try {
    let kept = turns;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ v: TRANSCRIPT_FORMAT, turns: kept }), 'utf8'), { level: 9 });
      if (gz.length <= TRANSCRIPT_MAX_GZIP) {
        return { encoding: 'gzip+base64', format: TRANSCRIPT_FORMAT, turns: kept.length, dropped: turns.length - kept.length, data: gz.toString('base64') };
      }
      if (kept.length <= 1) return null;
      kept = kept.slice(Math.ceil(kept.length / 2));
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * @param repo `owner/name` for the working directory, used to reject pull-request
 *   URLs that belong to some other repository. See `prUrlMatchesRepo`.
 */
async function aggregate(transcriptPath, repo, { wantTranscript = true } = {}) {
  const byMessage = new Map(); // message.id -> { model, usage }
  // tool_use.id -> file path, resolved to a real edit only once its result says it
  // succeeded. A denied or failed edit never touched the file.
  const pendingEdits = new Map();
  const files = new Set();
  const bashFiles = new Set();
  const prUrls = new Set();
  const stamps = [];
  // Collected in this same pass. The transcript can be 50 MB; reading it twice
  // to extract what a summary needs would double the I/O for no benefit.
  const turns = [];
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

    // Skipped entirely on a progress report, which discards the result: extraction
    // runs `redact` over every prompt and reply and holds the whole turn list in
    // memory, and the gzip at the end is the cheapest part of it.
    if (wantTranscript) {
      const turn = extractTurn(o);
      if (turn) turns.push(turn);
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
    transcript: wantTranscript ? packTranscript(turns) : undefined,
  };
}

/**
 * Whether enough time has passed to send another progress report for a session.
 *
 * Reads and writes a small map keyed on session id. Failing open on any I/O error
 * is deliberate: the throttle is an optimisation, and a corrupt state file must
 * not stop a session being reported at all.
 */
function shouldSendProgress(sessionId, now = Date.now()) {
  let seen = {};
  try {
    seen = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')) || {};
  } catch {
    /* no file yet, or unreadable — send, and rewrite it below */
  }
  if (typeof seen[sessionId] === 'number' && now - seen[sessionId] < PROGRESS_MIN_INTERVAL_MS) {
    return false;
  }
  try {
    // Only sessions touched recently are kept, so this cannot grow without bound
    // on a machine that has run thousands of sessions.
    const fresh = { [sessionId]: now };
    for (const [id, at] of Object.entries(seen)) {
      if (id !== sessionId && typeof at === 'number' && now - at < SWEEP_MAX_AGE_MS) fresh[id] = at;
    }
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(fresh), { mode: 0o600 });
  } catch {
    /* housekeeping */
  }
  return true;
}

/**
 * Session ids this machine has already reported, newest last.
 *
 * A file rather than asking the server, because the sweep runs on `SessionStart`
 * — before anything else — and a network round trip there would delay every
 * session's first prompt. Being wrong is cheap in one direction only: a forgotten
 * id means one redundant POST, and ingest is idempotent.
 */
function readReported() {
  try {
    const parsed = JSON.parse(fs.readFileSync(REPORTED_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rememberReported(sessionId) {
  try {
    const seen = readReported().filter((id) => id !== sessionId);
    seen.push(sessionId);
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(REPORTED_FILE, JSON.stringify(seen.slice(-REPORTED_MAX)), { mode: 0o600 });
  } catch {
    /* housekeeping; a failure here costs a redundant POST, nothing more */
  }
}

/**
 * Transcripts for sessions that were never reported.
 *
 * This is the fix for the silent data loss: `SessionEnd` does not fire when a
 * terminal is closed or the process is killed, so those sessions are simply
 * never sent. The spool does not help — it replays POSTs that *failed*, not
 * hooks that never *ran*.
 *
 * Deliberately bounded by both count and age. The projects directory grows
 * without limit, and a hook that reads two years of history on every session
 * start would be worse than the problem it solves.
 */
function findUnreported(currentSessionId) {
  const reported = new Set(readReported());
  reported.add(currentSessionId);

  let files = [];
  try {
    for (const project of fs.readdirSync(PROJECTS_DIR)) {
      const dir = path.join(PROJECTS_DIR, project);
      let entries;
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;
        const full = path.join(dir, entry);
        try {
          const stat = fs.statSync(full);
          files.push({ full, sessionId: entry.replace(/\.jsonl$/, ''), mtime: stat.mtimeMs });
        } catch {
          /* vanished between readdir and stat */
        }
      }
    }
  } catch {
    return [];
  }

  const cutoff = Date.now() - SWEEP_MAX_AGE_MS;
  files = files
    .filter((f) => f.mtime >= cutoff && !reported.has(f.sessionId))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, SWEEP_MAX_FILES);

  return files;
}

/**
 * Report sessions the machine never sent.
 *
 * ⚠️ Reported as **ended**, never active. They are finished by definition — the
 * terminal they ran in is gone — and marking them live would put a permanent
 * green dot on somebody's dashboard for a session nobody is working on.
 *
 * Errors are swallowed per session: one unreadable transcript must not stop the
 * sweep, and none of this may delay the session the user is actually starting.
 */
async function sweepUnreported(apiHost, apiKey, currentSessionId, cwd) {
  const candidates = findUnreported(currentSessionId);
  if (!candidates.length) return;

  log(`sweep: ${candidates.length} unreported session(s)`);
  const repo = repoSlug(cwd);
  const deadline = Date.now() + SWEEP_BUDGET_MS;

  for (let index = 0; index < candidates.length; index += 1) {
    const { full, sessionId } = candidates[index];
    // Checked before each session rather than after: stopping here leaves the
    // rest for the next session start, and being killed mid-POST does not.
    if (Date.now() > deadline) {
      log(`sweep: out of time after ${index} of ${candidates.length}; the rest wait for the next session`);
      return;
    }
    try {
      const agg = await aggregate(full, repo, { wantTranscript: !isIncognito(sessionId) });
      if (!agg.assistantMessages || !agg.startedAt) {
        // An empty transcript is not a session. Remembered anyway so the sweep
        // does not reconsider it on every start for the next week.
        rememberReported(sessionId);
        continue;
      }
      const res = await post(apiHost, apiKey, buildBody(sessionId, repo, agg, cwd, 'ended'));
      if (res.status >= 200 && res.status < 300) {
        rememberReported(sessionId);
        log(`sweep: reported ${sessionId} -> ${res.status}`);
      } else if (res.status < 500) {
        // Our own bad request; it will never succeed on a replay either.
        rememberReported(sessionId);
        log(`sweep: ${sessionId} rejected -> ${res.status}`);
      } else {
        log(`sweep: ${sessionId} deferred -> ${res.status}`);
      }
    } catch (err) {
      log(`sweep: ${sessionId} failed (${err && err.message})`);
    }
  }
}

/** The payload, shared by every report so the three hooks cannot drift apart. */
function buildBody(sessionId, repo, agg, cwd, status, { incognito = isIncognito(sessionId) } = {}) {
  if (incognito) {
    // Usage and cost only. No title (it is the first prompt, or a summary of it),
    // no repo or branch, no files, no pull request and never the transcript. The
    // server also scrubs, because progress reports sent before the user went
    // incognito already carried a title.
    return {
      externalId: sessionId,
      incognito: true,
      startedAt: agg.startedAt,
      endedAt: agg.endedAt,
      durationMinutes: agg.durationMinutes,
      usage: agg.usage,
      status,
    };
  }
  return {
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
    status,
    // Extracted and gzipped here so attachments and hook output never leave the
    // machine. Absent rather than null when it could not be packed — the metrics
    // are still worth reporting on their own.
    //
    // ⚠️ Only on the final report. A `Stop` hook fires after every assistant
    // turn, and re-uploading tens of kilobytes each time would be pure waste:
    // the server only summarises once, when the transcript arrives.
    transcript: status === 'ended' ? agg.transcript || undefined : undefined,
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
          'User-Agent': `pravex-claude-code-plugin/${PLUGIN_VERSION}`,
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

/** Which point in the session's life this invocation is. */
function modeFrom(argv) {
  if (argv.includes('--incognito')) return 'incognito';
  if (argv.includes('--start')) return 'start';
  if (argv.includes('--progress')) return 'progress';
  return 'end';
}

/**
 * `/pravex:incognito`. Marks the session, then reports it straight away so the
 * server scrubs the title that earlier progress reports already sent, rather
 * than waiting up to 90 seconds for the next `Stop`.
 *
 * Prints for a person: the command shows this output verbatim.
 */
async function goIncognito(sessionId) {
  if (!markIncognito(sessionId)) {
    console.log('Pravex: could not tell which session this is, so nothing changed.');
    return;
  }
  log(`incognito ${sessionId}`);
  console.log('Pravex: this session is incognito. The conversation, title, repository, files and pull request');
  console.log('will not be sent; only usage and cost are recorded. This lasts until the session ends.');

  const { apiKey, apiHost } = loadConfig();
  const transcriptPath = findTranscript(sessionId);
  if (!apiKey || !apiHost || !transcriptPath) return;
  try {
    const agg = await aggregate(transcriptPath, '', { wantTranscript: false });
    if (!agg.assistantMessages || !agg.startedAt) return;
    const res = await post(apiHost, apiKey, buildBody(sessionId, '', agg, process.cwd(), 'active', { incognito: true }));
    log(`ok (incognito) ${sessionId} -> ${res.status}`);
  } catch (err) {
    // The marker is what matters; the next Stop or SessionEnd sends the scrubbed report.
    log(`error (incognito) ${sessionId} -> ${err && err.message}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = modeFrom(argv);
  if (mode === 'incognito') {
    await goIncognito(argv[argv.indexOf('--incognito') + 1]);
    return;
  }

  let input = {};
  try {
    input = JSON.parse((await readStdin()) || '{}');
  } catch {
    log(`skipped (${mode}): could not parse hook stdin`);
    return;
  }

  const { apiKey, apiHost } = loadConfig();
  if (mode === 'start') {
    // Before anything that can fail or take time: the indicator is the one part
    // of this hook the user actually sees.
    const message = startMessage({ configured: Boolean(apiKey && apiHost), incognito: isIncognito(input.session_id), source: input.source });
    if (message) process.stdout.write(JSON.stringify({ systemMessage: message }));
    pruneIncognito();
    refreshStatusline();
  }
  if (!apiKey || !apiHost) {
    log(`skipped (${mode}): no apiKey/apiHost (run /pravex:login)`);
    return;
  }

  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path && input.transcript_path.replace(/^~/, os.homedir());
  const cwd = input.cwd || process.cwd();
  if (!sessionId) {
    log(`skipped (${mode}): missing session_id`);
    return;
  }

  // Resolved before aggregating: it is what a pull-request URL has to match.
  const repo = repoSlug(cwd);

  // The sweep runs first and only on start. It is the fix for sessions whose
  // terminal was closed, which `SessionEnd` never reported at all.
  if (mode === 'start') {
    await sweepUnreported(apiHost, apiKey, sessionId, cwd);
  }

  // Before the transcript is opened, so a throttled turn costs one small file
  // read rather than a full re-parse of a file that can be tens of megabytes.
  if (mode === 'progress' && !shouldSendProgress(sessionId)) {
    log(`skipped (progress) ${sessionId}: reported less than ${PROGRESS_MIN_INTERVAL_MS / 1000}s ago`);
    return;
  }

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    // Normal on `SessionStart`: the file does not exist until the first turn.
    // There is nothing to report yet, and the `Stop` hook will be along shortly.
    log(`skipped (${mode}): no transcript at ${transcriptPath}`);
    return;
  }

  const agg = await aggregate(transcriptPath, repo, { wantTranscript: mode === 'end' && !isIncognito(sessionId) });
  if (!agg.assistantMessages || !agg.startedAt) {
    log(`skipped (${mode}) ${sessionId}: empty transcript`);
    return;
  }
  if (agg.prUrlsRejected) {
    log(`${sessionId}: ignored ${agg.prUrlsRejected} pull-request url(s) from outside ${repo}`);
  }

  const body = buildBody(sessionId, repo, agg, cwd, mode === 'end' ? 'ended' : 'active');

  // Only on the final report. Replaying the spool on every `Stop` would retry a
  // dead host once per assistant turn, which is neither kind nor useful.
  if (mode === 'end') {
    await flushSpool(apiHost, apiKey);
  }

  try {
    const res = await post(apiHost, apiKey, body);
    if (res.status >= 200 && res.status < 300) {
      log(`ok (${mode}) ${sessionId} -> ${res.status} ${res.body.slice(0, 200)}`);
      if (mode === 'end') rememberReported(sessionId);
    } else if (res.status >= 500) {
      // The server's problem, so it is worth replaying. A 4xx is ours and never
      // will be. Progress reports are NOT spooled: the next one is one assistant
      // turn away and carries the same numbers, only fresher, so spooling them
      // would fill the spool with stale copies of a session still running.
      const spooled = mode === 'end' && spool(body) ? ' (spooled)' : '';
      log(`error (${mode}) ${sessionId} -> ${res.status} ${res.body.slice(0, 500)}${spooled}`);
    } else {
      log(`error (${mode}) ${sessionId} -> ${res.status} ${res.body.slice(0, 500)}`);
    }
  } catch (err) {
    const spooled = mode === 'end' && spool(body) ? ' (spooled)' : '';
    log(`error (${mode}) ${sessionId} -> ${err && err.message}${spooled}`);
  }
}

// Run as a hook; importable as a module so the tests exercise these functions
// directly rather than scraping them out of the source text.
if (require.main === module) {
  main()
    .catch((err) => log(`fatal: ${err && err.stack}`))
    .finally(() => process.exit(0));
}

module.exports = {
  INCOGNITO_DIR,
  PROGRESS_MIN_INTERVAL_MS,
  findTranscript,
  isIncognito,
  markIncognito,
  pruneIncognito,
  startMessage,
  SECRET_RE,
  buildBody,
  shouldSendProgress,
  findUnreported,
  modeFrom,
  readReported,
  rememberReported,
  TRANSCRIPT_FORMAT,
  TRANSCRIPT_MAX_GZIP,
  TRANSCRIPT_MAX_TEXT,
  activeMinutes,
  aggregate,
  bashWrites,
  clampText,
  extractTurn,
  packTranscript,
  collectPrUrls,
  prUrlMatchesRepo,
  prUrlSlug,
  redact,
  repoSlug,
  textOf,
};
