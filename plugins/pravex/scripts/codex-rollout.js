'use strict';
/**
 * Reads an OpenAI Codex CLI rollout and reduces it to the same shape
 * `aggregate()` in `report-session.js` produces for a Claude Code transcript, so
 * the rest of the reporter — body, spool, POST — does not know which agent wrote
 * the session.
 *
 * A rollout is one JSON object per line, `{ timestamp, type, payload }`, kept
 * under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. The lines that matter:
 *
 *   session_meta         once, first: `payload.id`, `payload.cwd`, `payload.git.branch`
 *   turn_context         per turn: `payload.turn_id`, `payload.model` — the model
 *                        every usage record of that turn is attributed to
 *   token_usage_record   per model response: `payload.response_id`,
 *                        `payload.turn_id`, `payload.usage` (that response alone),
 *                        `payload.turn_token_usage`, `payload.thread_token_usage`.
 *                        Summed per model, deduped on `response_id`, because the
 *                        same record can be written again on resume.
 *   event_msg            `payload.type === 'token_count'` carries
 *                        `payload.info.total_token_usage`, which is CUMULATIVE for
 *                        the thread. Several arrive per turn as streaming
 *                        snapshots, so the last one is the session total and
 *                        summing them overcounts. Used only when a rollout has no
 *                        usage records at all (CLIs before 0.147), and then the
 *                        whole total goes to the last model seen.
 *   response_item        `message` (user / assistant / developer),
 *                   `function_call` + `function_call_output`,
 *                   `custom_tool_call` + `custom_tool_call_output` (apply_patch),
 *                   `local_shell_call` (older CLIs)
 *
 * Token semantics differ from Anthropic's and are normalised here, once:
 * `cached_input_tokens` is a SUBSET of `input_tokens` on the OpenAI API, so the
 * uncached input is the difference; `reasoning_output_tokens` is already inside
 * `output_tokens`; and there is no cache write charge, so that count is 0.
 *
 * Standard library only, like everything else in this plugin.
 */

const fs = require('fs');
const readline = require('readline');

/** Where Codex keeps rollouts, one directory per day. */
const SESSIONS_DIR_PARTS = ['.codex', 'sessions'];

/**
 * A `TokenUsage` as the Codex protocol writes it, in the shape `POST /sessions`
 * takes. `cached_input_tokens` is a subset of `input_tokens`, so billable input is
 * the difference; `reasoning_output_tokens` is already inside `output_tokens`; the
 * OpenAI API has no cache-write charge, so that count is 0 whatever the record
 * says (`cache_write_input_tokens` exists in the struct for other providers).
 */
function tokenUsageToModelUsage(usage, model) {
  const input = Math.max(0, Number(usage && usage.input_tokens) || 0);
  const cached = Math.min(input, Math.max(0, Number(usage && usage.cached_input_tokens) || 0));
  const output = Math.max(0, Number(usage && usage.output_tokens) || 0);
  return {
    model: model || 'unknown',
    inputTokens: input - cached,
    outputTokens: output,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

/** Add one normalised usage into a per-model accumulator. */
function addUsage(byModel, u) {
  const acc = byModel.get(u.model) || { model: u.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  acc.inputTokens += u.inputTokens;
  acc.outputTokens += u.outputTokens;
  acc.cacheReadTokens += u.cacheReadTokens;
  acc.cacheWriteTokens += u.cacheWriteTokens;
  byModel.set(u.model, acc);
}

/** Distinguishes a rollout from a Claude Code transcript by its first line. */
function isRollout(transcriptPath) {
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.toString('utf8', 0, n);
    return /"type"\s*:\s*"session_meta"/.test(head.split('\n')[0] || '');
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** `*** Update File: src/a.ts` lines out of an apply_patch body. */
function patchPaths(patch) {
  const out = [];
  if (typeof patch !== 'string') return out;
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  let m;
  while ((m = re.exec(patch)) !== null) out.push(m[1].trim());
  return out;
}

/** The command string of a shell-ish tool call, whatever the CLI version named it. */
function shellCommand(name, args) {
  if (!/^(shell|exec_command|container\.exec|local_shell)/.test(name || '')) return null;
  let a = args;
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a);
    } catch {
      return a;
    }
  }
  if (!a || typeof a !== 'object') return null;
  const cmd = a.command ?? a.cmd;
  if (Array.isArray(cmd)) return cmd.join(' ');
  return typeof cmd === 'string' ? cmd : null;
}

/**
 * Whether a tool output reports failure. Newer CLIs wrap shell output as JSON
 * with `metadata.exit_code`; older ones and apply_patch return plain text.
 */
function outputFailed(output) {
  if (typeof output !== 'string') return false;
  const s = output.trim();
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s);
      const code = o && o.metadata && o.metadata.exit_code;
      if (typeof code === 'number') return code !== 0;
      if (typeof o.output === 'string') return /^(error|failed)\b/i.test(o.output.trim());
    } catch {
      // fall through to the text check
    }
  }
  return /^(error|failed)\b/i.test(s);
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Reduce a rollout to the reporter's aggregate shape.
 *
 * @param helpers the text utilities from `report-session.js` — passed in rather
 *   than required, because that file requires this one.
 */
async function aggregate(transcriptPath, repo, { wantTranscript = true } = {}, helpers) {
  const { bashWrites, collectPrUrls, prUrlMatchesRepo, activeMinutes, clampText, packTranscript, redact, TEST_FILE_RE } = helpers;

  const files = new Set();
  const bashFiles = new Set();
  const prUrls = new Set();
  const stamps = [];
  const turns = [];
  // call_id -> paths, held until the output says the patch applied.
  const pendingPatches = new Map();
  // Per-response usage records, the primary source. Deduped on response_id.
  const byModel = new Map();
  const seenResponses = new Set();
  // turn_id -> model, so a record is priced at the model its turn ran on.
  const turnModel = new Map();
  let usage = null;
  let model = '';
  let branch = '';
  let cwd = '';
  let toolUses = 0;
  let toolErrors = 0;
  let assistantMessages = 0;
  let first = null;
  let last = null;
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
    const p = o.payload;
    if (!p || typeof p !== 'object') continue;

    if (o.type === 'session_meta') {
      if (typeof p.cwd === 'string') cwd = p.cwd;
      if (p.git && typeof p.git.branch === 'string' && p.git.branch !== 'HEAD') branch = p.git.branch;
      if (typeof p.model === 'string') model = p.model;
      continue;
    }
    if (o.type === 'turn_context') {
      if (typeof p.model === 'string' && p.model) {
        model = p.model;
        if (typeof p.turn_id === 'string') turnModel.set(p.turn_id, p.model);
      }
      continue;
    }
    if (o.type === 'token_usage_record') {
      if (!p.usage) continue;
      const key = typeof p.response_id === 'string' && p.response_id ? p.response_id : null;
      if (key) {
        if (seenResponses.has(key)) continue;
        seenResponses.add(key);
      }
      addUsage(byModel, tokenUsageToModelUsage(p.usage, (p.turn_id && turnModel.get(p.turn_id)) || model));
      continue;
    }
    if (o.type === 'event_msg') {
      if (p.type === 'token_count' && p.info && p.info.total_token_usage) {
        // Cumulative for the thread: the last snapshot is the total.
        usage = p.info.total_token_usage;
      }
      continue;
    }
    if (o.type !== 'response_item') continue;

    if (p.type === 'message') {
      const text = contentText(p.content).trim();
      if (p.role === 'assistant') {
        assistantMessages += 1;
        collectPrUrls(text, prUrls);
        if (wantTranscript && text) turns.push({ role: 'assistant', at: o.timestamp, text: clampText(text) });
      } else if (p.role === 'user') {
        // Codex wraps its own context in `<environment_context>` and friends,
        // and a slash command (`/status`) is an instruction to the CLI, not a prompt.
        if (text && !text.startsWith('<') && !text.startsWith('/')) {
          if (!firstPrompt) firstPrompt = text;
          if (wantTranscript) turns.push({ role: 'user', at: o.timestamp, text: clampText(text) });
        }
      }
      continue;
    }

    if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      toolUses += 1;
      const name = p.name || (p.type === 'local_shell_call' ? 'local_shell' : 'tool');
      if (wantTranscript) {
        const lastTurn = turns[turns.length - 1];
        if (lastTurn && lastTurn.role === 'assistant') (lastTurn.tools = lastTurn.tools || []).push(name);
        else turns.push({ role: 'assistant', at: o.timestamp, tools: [name] });
      }
      const argsRaw = p.type === 'custom_tool_call' ? p.input : p.type === 'local_shell_call' ? p.action : p.arguments;
      if (name === 'apply_patch') {
        const paths = patchPaths(typeof argsRaw === 'string' ? argsRaw : argsRaw && argsRaw.patch);
        if (paths.length && p.call_id) pendingPatches.set(p.call_id, paths);
      } else {
        const cmd = shellCommand(name, argsRaw);
        if (cmd) for (const f of bashWrites(cmd)) bashFiles.add(f);
      }
      continue;
    }

    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output' || p.type === 'local_shell_call_output') {
      const failed = outputFailed(p.output);
      if (failed) toolErrors += 1;
      const paths = pendingPatches.get(p.call_id);
      if (paths) {
        if (!failed) for (const f of paths) files.add(f);
        pendingPatches.delete(p.call_id);
      }
      if (typeof p.output === 'string') collectPrUrls(p.output, prUrls);
    }
  }

  for (const f of bashFiles) files.add(f);
  const testsAdded = [...files].filter((f) => TEST_FILE_RE.test(f)).length;
  const retryRate = toolUses ? Math.round((toolErrors / toolUses) * 1000) / 10 : 0;
  const title = redact((firstPrompt || '').replace(/\s+/g, ' ')).slice(0, 120);
  const ownPrUrls = [...prUrls].filter((u) => prUrlMatchesRepo(u, repo));
  const prUrl = ownPrUrls.length ? ownPrUrls[ownPrUrls.length - 1] : undefined;

  // Records win. The cumulative snapshot is the fallback for rollouts written
  // before records existed, and it can only name one model.
  const usageOut = byModel.size ? [...byModel.values()] : usage ? [tokenUsageToModelUsage(usage, model)] : [];

  return {
    usage: usageOut,
    startedAt: first,
    endedAt: last,
    branch,
    cwd,
    title,
    filesTouched: files.size,
    testsAdded,
    retryRate,
    prUrl,
    prUrlsRejected: prUrls.size - ownPrUrls.length,
    durationMinutes: activeMinutes(stamps),
    filesTouchedFromShell: bashFiles.size,
    assistantMessages,
    transcript: wantTranscript ? packTranscript(turns) : undefined,
  };
}

module.exports = { SESSIONS_DIR_PARTS, aggregate, isRollout, outputFailed, patchPaths, shellCommand, tokenUsageToModelUsage };
