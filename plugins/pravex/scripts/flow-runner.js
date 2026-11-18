#!/usr/bin/env node
'use strict';
/**
 * The Pravex flow runner (pravex-backend plan 0011): runs the agent flows a person assigned to
 * this machine, with their own Claude Code, and reports every step to Pravex.
 *
 *   node flow-runner.js --install         schedule `--tick` every 15 minutes (launchd, cron or Task Scheduler)
 *   node flow-runner.js --uninstall       remove the schedule
 *   node flow-runner.js --status          what is installed, the plan usage, the flows assigned here
 *   node flow-runner.js --tick            the scheduled entry: due schedules, requested runs, resumed approvals
 *   node flow-runner.js --run <flowId> [--dry]   run one flow now (`/pravex:flow-test` uses --dry)
 *
 * **Opt-in and own machine only.** Nothing runs until the person installs the schedule, and the
 * server hands this machine only the flows its owner assigned to it.
 *
 * **What a run does.** Steps run in order from the trigger. An agent is `claude -p` with its
 * instructions, model and tools; a check is its command; an action opens a pull request with `gh`
 * or starts a workflow; a live approval pauses the run until someone approves it in Pravex. A
 * live run works in its own git worktree on a new branch, so the developer's working copy is never
 * touched. A dry run (the test) changes nothing: agents run in plan mode and say whether they
 * could do their task, checks run, actions are verified instead of done.
 *
 * **The guard.** Before starting and between steps, the plan usage the status line last saw
 * (`~/.pravex/plan-usage.json`, and any `rate_limit_event` in Claude's output) is compared with the
 * flow's limits: start only below `runBelowPct`, stop above `stopAbovePct`.
 *
 * Standard library only. Copied to `~/.pravex/runner/` on install, with what it needs, so the
 * schedule survives plugin updates; the SessionStart hook keeps the copy fresh.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const auth = require('./auth');
const envLib = require('./environment');

const RUNNER_VERSION = '1';
const TICK_MINUTES = 15;
const HOME = os.homedir();
const PRAVEX_DIR = path.join(HOME, '.pravex');
const RUNNER_DIR = path.join(PRAVEX_DIR, 'runner');
const STATE_FILE = path.join(PRAVEX_DIR, 'runner.json');
const LOCK_FILE = path.join(PRAVEX_DIR, 'runner.lock');
const LOG_FILE = path.join(PRAVEX_DIR, 'runner.log');
const RUNS_DIR = path.join(PRAVEX_DIR, 'runs');
const LAUNCHD_LABEL = 'ai.pravex.flow-runner';
const CRON_MARK = '# pravex-flow-runner';
const WINDOWS_TASK = 'PravexFlowRunner';
/** A tick older than this is dead (the machine slept mid-run); its lock may be broken. */
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;
const AGENT_TIMEOUT_MS = { live: 45 * 60 * 1000, dry: 10 * 60 * 1000 };
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
/** Plan usage older than this says nothing about the window. */
const USAGE_FRESH_MS = { five_hour: 3 * 60 * 60 * 1000, seven_day: 24 * 60 * 60 * 1000 };
const OUTPUT_TAIL = 1500;
const SHELL_TOOLS_RE = /^[A-Za-z_][\w-]*(\(.*\))?$/s;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function log(line) {
  try {
    fs.mkdirSync(PRAVEX_DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {
    /* logging never breaks a run */
  }
}

const tail = (text, n = OUTPUT_TAIL) => envLib.maskSecrets(String(text || '')).slice(-n).trim();

// ---------------------------------------------------------------------------
// Schedules (pure)
// ---------------------------------------------------------------------------

/** `*`, `5`, `1-5`, `*\/15`, `1,3,5` against a value. */
function fieldMatches(field, value, min, max) {
  for (const part of String(field).split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) continue;
    let lo;
    let hi;
    if (range === '*') [lo, hi] = [min, max];
    else if (/^\d+-\d+$/.test(range)) [lo, hi] = range.split('-').map(Number);
    else if (/^\d+$/.test(range)) [lo, hi] = stepRaw ? [Number(range), max] : [Number(range), Number(range)];
    else continue;
    if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
  }
  return false;
}

/** The wall-clock fields of `date` in `timeZone` (falls back to UTC for an unknown zone). */
function zoned(date, timeZone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      hourCycle: 'h23',
      weekday: 'short',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    }).formatToParts(date);
  } catch {
    return zoned(date, 'UTC');
  }
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { minute: Number(get('minute')), hour: Number(get('hour')), day: Number(get('day')), month: Number(get('month')), weekday: days[get('weekday')] };
}

const DAY_NAMES = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const MONTH_NAMES = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const named = (field, names) => String(field).toUpperCase().replace(/[A-Z]{3}/g, (n) => (n in names ? String(names[n]) : n));

/**
 * Whether a five-field cron matches `date` in `timeZone`, as cron reads it: Sunday is 0 or 7, day and month names
 * are allowed, and when both day of month and weekday are restricted either one matching is enough.
 */
function cronMatches(cron, date, timeZone) {
  const f = String(cron || '').trim().split(/\s+/);
  if (f.length !== 5) return false;
  const z = zoned(date, timeZone);
  const dom = f[2];
  const dow = named(f[4], DAY_NAMES);
  const dayOfMonth = fieldMatches(dom, z.day, 1, 31);
  // 0-7 covers Sunday at both ends: try the day as 0 and, for Sunday, as 7.
  const weekday = fieldMatches(dow, z.weekday, 0, 7) || (z.weekday === 0 && fieldMatches(dow, 7, 0, 7));
  const day = dom !== '*' && f[4] !== '*' ? dayOfMonth || weekday : dayOfMonth && weekday;
  return fieldMatches(f[0], z.minute, 0, 59) && fieldMatches(f[1], z.hour, 0, 23) && fieldMatches(named(f[3], MONTH_NAMES), z.month, 1, 12) && day;
}

/** The minutes in `(from, to]` the cron matches, newest last, at most a day back. */
function dueMinutes(cron, timeZone, from, to) {
  const out = [];
  const start = Math.max(from, to - 24 * 60 * 60 * 1000);
  let t = Math.floor(start / 60000) * 60000 + 60000;
  for (; t <= to; t += 60000) if (cronMatches(cron, new Date(t), timeZone)) out.push(t);
  return out;
}

/** Steps in the order a run walks them: from the trigger, breadth first; notes and unreachable steps are left out. */
function runOrder(definition) {
  const nodes = Array.isArray(definition && definition.nodes) ? definition.nodes : [];
  const edges = Array.isArray(definition && definition.edges) ? definition.edges : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const trigger = nodes.find((n) => n.type === 'trigger');
  if (!trigger) return [];
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) if (indegree.has(e.target)) indegree.set(e.target, indegree.get(e.target) + 1);
  const order = [];
  const queue = [trigger.id];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (node && node.type !== 'note') order.push(node);
    for (const e of edges.filter((x) => x.source === id)) {
      indegree.set(e.target, indegree.get(e.target) - 1);
      if (indegree.get(e.target) <= 0) queue.push(e.target);
    }
  }
  return order;
}

// ---------------------------------------------------------------------------
// The guard (pure)
// ---------------------------------------------------------------------------

const DEFAULT_GUARD = { days: null, runBelowPct: null, stopAbovePct: null, window: 'five_hour', whenUnknown: 'skip' };

function guardOf(definition) {
  const g = isObject(definition && definition.guard) ? definition.guard : {};
  const pct = (v) => (typeof v === 'number' && v > 0 && v <= 100 ? v : null);
  return {
    days: Array.isArray(g.days) && g.days.length ? g.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : null,
    runBelowPct: pct(g.runBelowPct),
    stopAbovePct: pct(g.stopAbovePct),
    window: g.window === 'seven_day' ? 'seven_day' : 'five_hour',
    whenUnknown: g.whenUnknown === 'run' ? 'run' : 'skip',
  };
}

/**
 * The usage of the guard's window, or null when unknown. A reading whose window has reset since is 0 % (nothing was
 * used in the new window that anyone saw); otherwise a reading older than the window's freshness says nothing.
 */
function usagePct(usage, window, now = Date.now()) {
  if (!isObject(usage) || typeof usage.at !== 'number') return null;
  const w = window === 'seven_day' ? usage.sevenDay : usage.fiveHour;
  if (!isObject(w) || typeof w.pct !== 'number') return null;
  if (typeof w.resetsAt === 'number' && w.resetsAt > usage.at && now >= w.resetsAt) return 0;
  return now - usage.at > USAGE_FRESH_MS[window] ? null : w.pct;
}

/** The newer of two readings. */
const newerUsage = (a, b) => (!a ? b : !b ? a : (b.at || 0) > (a.at || 0) ? b : a);

/**
 * `{ ok: true }` or `{ ok: false, code, params }`. `phase` is `start` (days and `runBelowPct`) or
 * `step` (`stopAbovePct`, between steps). A manual run ignores the days.
 */
function guardDecision(guard, usage, { phase = 'start', now = Date.now(), timeZone, manual = false } = {}) {
  if (phase === 'start' && !manual && guard.days) {
    const day = zoned(new Date(now), timeZone).weekday;
    if (!guard.days.includes(day)) return { ok: false, code: 'guard-day', params: { day } };
  }
  const limit = phase === 'start' ? guard.runBelowPct : guard.stopAbovePct;
  if (limit === null) return { ok: true };
  const pct = usagePct(usage, guard.window, now);
  if (pct === null) return guard.whenUnknown === 'run' ? { ok: true } : { ok: false, code: 'plan-unknown', params: { window: guard.window } };
  if (phase === 'start' && pct >= limit) return { ok: false, code: 'plan-above-start', params: { pct, limit, window: guard.window } };
  if (phase === 'step' && pct >= limit) return { ok: false, code: 'plan-above-stop', params: { pct, limit, window: guard.window } };
  return { ok: true, params: { pct } };
}

// ---------------------------------------------------------------------------
// Steps (pure parts)
// ---------------------------------------------------------------------------

/** Tool rules for `--allowedTools`; anything that is not a tool rule is dropped. */
function toolsOf(data) {
  const tools = Array.isArray(data && data.tools) ? data.tools : [];
  return tools.filter((t) => typeof t === 'string' && SHELL_TOOLS_RE.test(t.trim())).map((t) => t.trim());
}

const MODELS = new Set(['opus', 'sonnet', 'haiku']);

/** What an agent is asked. A dry run asks whether the task could be done here, and to change nothing. */
function agentPrompt(flow, node, { mode, branch, index, total }) {
  const data = node.data || {};
  const task = String(data.instructions || '').trim() || String(data.label || '');
  const tools = toolsOf(data);
  if (mode === 'dry') {
    return [
      `PRAVEX FLOW TEST — read only. Do not create, edit or delete anything, do not run commands that change state.`,
      `This is step ${index} of ${total} of the flow "${flow.name}", the agent "${data.label || node.id}".`,
      `When the flow runs for real, this agent will be asked to:`,
      '---',
      task,
      '---',
      `It will be allowed these tools: ${tools.length ? tools.join(', ') : 'none listed'}.`,
      `Check, in this repository and on this machine, whether that task can be done: the files and folders it needs exist and are readable, the commands it would run exist, nothing it needs is missing.`,
      `Finish with ONE line of JSON and nothing after it: {"canRun": true|false, "missing": ["short item", ...], "summary": "one sentence"}`,
    ].join('\n');
  }
  return [
    `You are the agent "${data.label || node.id}", step ${index} of ${total} of the Pravex flow "${flow.name}".`,
    `You work in a fresh copy of the repository on the branch ${branch}. Do not push and do not open pull requests: Pravex does that after the last step.`,
    `Your task:`,
    task,
    `When you finish, end with one short sentence saying what you did.`,
  ].join('\n');
}

function agentArgs(flow, node, { mode, maxTurns, prompt }) {
  const data = node.data || {};
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', String(maxTurns)];
  if (MODELS.has(data.model)) args.push('--model', data.model);
  if (mode === 'dry') args.push('--permission-mode', 'plan');
  else {
    args.push('--permission-mode', 'acceptEdits');
    const tools = toolsOf(data);
    if (tools.length) args.push('--allowedTools', ...tools);
  }
  return args;
}

/** Folds one `stream-json` line into the step's running totals. */
function foldStream(acc, line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return acc;
  }
  if (!isObject(msg)) return acc;
  if (msg.type === 'result') {
    acc.costUsd = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : acc.costUsd;
    acc.turns = typeof msg.num_turns === 'number' ? msg.num_turns : acc.turns;
    acc.isError = msg.is_error === true || msg.subtype !== 'success';
    acc.result = typeof msg.result === 'string' ? msg.result : acc.result;
  } else if (msg.type === 'rate_limit_event' && isObject(msg.rate_limit_info)) {
    const info = msg.rate_limit_info;
    const pct = typeof info.utilization === 'number' ? Math.round(info.utilization * (info.utilization <= 1 ? 100 : 1)) : null;
    const window = info.rateLimitType === 'seven_day' ? 'sevenDay' : info.rateLimitType === 'five_hour' ? 'fiveHour' : null;
    if (pct !== null && window) acc.usage = { ...(acc.usage || {}), [window]: { pct, resetsAt: null } };
    if (info.status === 'rejected') acc.limited = true;
  }
  return acc;
}

/** `{ canRun, missing, summary }` from a dry agent's last JSON line, or null. */
function verdictOf(text) {
  const lines = String(text || '').trim().split('\n').reverse();
  for (const line of lines) {
    const m = /\{.*"canRun".*\}/.exec(line);
    if (!m) continue;
    try {
      const v = JSON.parse(m[0]);
      return {
        canRun: v.canRun === true,
        missing: Array.isArray(v.missing) ? v.missing.filter((x) => typeof x === 'string').map((x) => x.slice(0, 160)).slice(0, 10) : [],
        summary: typeof v.summary === 'string' ? v.summary.slice(0, 300) : '',
      };
    } catch {
      /* not JSON after all */
    }
  }
  return null;
}

/** The install command for a fresh worktree, from the lock file there; null when there is none. */
function installCommand(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has('pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile';
  if (has('package-lock.json')) return 'npm ci';
  if (has('yarn.lock')) return 'yarn install --frozen-lockfile';
  if (has('bun.lockb') || has('bun.lock')) return 'bun install --frozen-lockfile';
  return null;
}

/** The folder of `repo` on this machine: a git root Claude Code was opened in, the main copy before a worktree. */
function findRepoDir(repo, { home = HOME, claudeJson } = {}) {
  if (!repo) return null;
  const json = claudeJson === undefined ? readJson(path.join(home, '.claude.json')) : claudeJson;
  const dirs = envLib.directoriesOf({ home, claudeJson: json });
  const candidates = dirs.filter((d) => d.exists && d.repo && d.repo.toLowerCase() === repo.toLowerCase()).map((d) => envLib.expandHome(d.path, home));
  const roots = candidates.filter((d) => {
    try {
      return fs.statSync(path.join(d, '.git')).isDirectory();
    } catch {
      return false;
    }
  });
  return roots[0] || candidates[0] || null;
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

/** The full path of a CLI, from the PATH saved at install time and the current one. */
function which(cli, state = readJson(STATE_FILE, {})) {
  const saved = isObject(state.paths) && typeof state.paths[cli] === 'string' ? state.paths[cli] : null;
  if (saved && fs.existsSync(saved)) return saved;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const e of exts) {
      const full = path.join(dir, cli + e);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

function run(cmd, args, { cwd, timeoutMs = COMMAND_TIMEOUT_MS, shell = false, onLine } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let pending = '';
    let child;
    try {
      // Its own process group, so a timeout stops everything a shell command started, not just the shell.
      child = spawn(cmd, args, { cwd, shell, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    } catch (e) {
      resolve({ code: -1, out: '', err: String(e && e.message), timedOut: false });
      return;
    }
    let timedOut = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      // Children that ignore the signal still hold the pipes; do not wait on them.
      setTimeout(() => finish({ code: -1, out, err, timedOut: true }), 5000).unref();
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      const s = d.toString();
      if (out.length < 2_000_000) out += s;
      if (onLine) {
        pending += s;
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const l of lines) onLine(l);
      }
    });
    child.stderr.on('data', (d) => {
      if (err.length < 200_000) err += d.toString();
    });
    child.on('error', (e) => finish({ code: -1, out, err: String(e && e.message), timedOut }));
    child.on('close', (code) => {
      if (onLine && pending) onLine(pending);
      finish({ code: code === null ? -1 : code, out, err, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// Pravex API
// ---------------------------------------------------------------------------

async function api(method, route, json) {
  const creds = await auth.getCredentials();
  if (!creds.ok) throw new Error('not signed in to Pravex: run /pravex:login');
  const res = await auth.authorized(creds, route, { method, json, timeoutMs: 20000 });
  let body = null;
  try {
    const parsed = JSON.parse(res.body);
    body = isObject(parsed) && parsed.result !== undefined ? parsed.result : parsed;
  } catch {
    /* not JSON */
  }
  if (res.status < 200 || res.status >= 300) {
    const message = isObject(body) && isObject(body.error) ? body.error.message : `HTTP ${res.status}`;
    const e = new Error(message);
    e.status = res.status;
    throw e;
  }
  return body;
}

function machineIdOf() {
  try {
    return fs.readFileSync(path.join(PRAVEX_DIR, 'machine-id'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Running a flow
// ---------------------------------------------------------------------------

/**
 * One run, start to finish (or to a live approval). Reports each step as it goes; never throws.
 *
 * `trusted` is false for a test of a flow not assigned to this machine by its owner (a `/pravex:flow-test` of a
 * colleague's flow): its agents still run in plan mode, but its check commands are not run, because nobody here
 * chose them. `startCost` carries what a resumed run had already spent.
 */
async function executeRun({ run: record, flow, mode, fromNodeId = null, branch: knownBranch = null, manual = false, trusted = true, startCost = 0 }) {
  const runId = record.id;
  const definition = flow.definition || {};
  const guard = guardOf(definition);
  const order = runOrder(definition);
  const trigger = order[0];
  const timeZone = trigger && trigger.data ? trigger.data.timezone : undefined;
  const budget = isObject(definition.budget) ? definition.budget : {};
  const maxUsd = typeof budget.maxUsd === 'number' ? budget.maxUsd : 5;
  const maxTurns = typeof budget.maxTurns === 'number' ? budget.maxTurns : 60;
  const steps = [];
  let costUsd = startCost;
  let usage = envLib.readPlanUsage(HOME);
  const startUsage = usage;
  let cancelled = false;
  let workdir = null;
  let repoDir = null;
  let git = null;
  let final = false;

  const patch = async (body) => {
    try {
      const res = await api('PATCH', `/api/agent-flow-runs/${runId}`, body);
      if (res && res.status === 'cancelled') cancelled = true;
    } catch (e) {
      log(`run ${runId}: report failed: ${e.message}`);
    }
  };
  const step = async (node, status, extra = {}) => {
    const entry = { nodeId: node.id, stepKind: node.type, label: (node.data && node.data.label) || node.id, status, at: Date.now(), ...extra };
    const i = steps.findIndex((s) => s.nodeId === node.id);
    if (i >= 0) steps[i] = { ...steps[i], ...entry };
    else steps.push(entry);
    await patch({ steps: [entry], costUsd });
  };
  const finish = async (status, code = null, params = {}) => {
    final = true;
    await patch({ status, reason: code ? { code, params } : null, costUsd, planUsage: { start: startUsage, end: usage } });
    log(`run ${runId}: ${status}${code ? ` (${code})` : ''}`);
    return { status, code };
  };

  try {
    if (!fromNodeId) {
      const g = guardDecision(guard, usage, { phase: 'start', timeZone, manual: manual || mode === 'dry' });
      if (!g.ok && mode === 'live') return await finish('skipped', g.code, g.params);
    }

    repoDir = findRepoDir(flow.repo);
    if (!repoDir) return await finish('failed', 'repo-not-found', { repo: flow.repo || '' });
    git = which('git');
    const claude = which('claude');
    const gh = which('gh');
    if (!git) return await finish('failed', 'cli-missing', { cli: 'git' });
    if (!claude && order.some((n) => n.type === 'agent')) return await finish('failed', 'cli-missing', { cli: 'claude' });

    // A live run works on its own branch in its own worktree; a dry run reads the developer's copy.
    workdir = repoDir;
    let branch = knownBranch;
    if (mode === 'live') {
      branch = branch || `pravex/${String(flow.slug || 'flow').slice(0, 40)}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
      workdir = path.join(RUNS_DIR, runId);
      if (!fs.existsSync(workdir)) {
        fs.mkdirSync(RUNS_DIR, { recursive: true, mode: 0o700 });
        let added;
        if (knownBranch) {
          // Resuming after an approval whose worktree is gone: the branch is still there.
          added = await run(git, ['worktree', 'add', workdir, branch], { cwd: repoDir, timeoutMs: 120000 });
        } else {
          await run(git, ['fetch', 'origin', '--quiet'], { cwd: repoDir, timeoutMs: 120000 });
          const base = (await run(git, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoDir })).out.trim() || 'origin/main';
          added = await run(git, ['worktree', 'add', '-b', branch, workdir, base], { cwd: repoDir, timeoutMs: 120000 });
        }
        if (added.code !== 0) return await finish('failed', 'worktree-failed', { output: tail(added.err, 300) });
        const install = installCommand(workdir);
        if (install) {
          const r = await run(install, [], { cwd: workdir, shell: true });
          if (r.code !== 0) return await finish('failed', 'install-failed', { command: install, output: tail(r.err || r.out, 300) });
        }
      }
      await patch({ status: 'running', branch });
    } else {
      await patch({ status: 'running' });
    }

    let started = !fromNodeId;
    let failures = 0;
    for (const [i, node] of order.entries()) {
      if (!started) {
        if (node.id === fromNodeId) {
          started = true;
          // The gate was settled in Pravex; record it as passed so a later gate is the one to resume from.
          await step(node, 'passed', { summary: { code: 'approval-given', params: {} } });
        }
        continue;
      }
      if (cancelled) {
        log(`run ${runId}: cancelled from Pravex`);
        final = true;
        return { status: 'cancelled' };
      }
      const data = node.data || {};
      const index = i + 1;
      if (node.type === 'trigger') {
        await step(node, 'passed', { summary: { code: 'trigger', params: { type: data.type || 'manual' } } });
        continue;
      }
      if (costUsd >= maxUsd) return await finish(mode === 'dry' ? 'passed' : 'stopped', 'budget', { maxUsd });
      if (mode === 'live') {
        usage = newerUsage(usage, envLib.readPlanUsage(HOME));
        const g = guardDecision(guard, usage, { phase: 'step', timeZone });
        if (!g.ok) {
          await step(node, 'skipped', { summary: { code: g.code, params: g.params } });
          return await finish('stopped', g.code, g.params);
        }
      }
      await step(node, 'running');
      const began = Date.now();

      if (node.type === 'agent') {
        const prompt = agentPrompt(flow, node, { mode, branch, index, total: order.length });
        const acc = { costUsd: 0, turns: 0, isError: false, result: '', usage: null, limited: false };
        const r = await run(claude, agentArgs(flow, node, { mode, maxTurns: mode === 'dry' ? Math.min(maxTurns, 15) : maxTurns, prompt }), {
          cwd: workdir,
          timeoutMs: AGENT_TIMEOUT_MS[mode],
          onLine: (l) => foldStream(acc, l),
        });
        costUsd += acc.costUsd;
        if (acc.usage) usage = { ...(usage || {}), ...acc.usage, at: Date.now() };
        const ms = Date.now() - began;
        if (acc.limited) {
          await step(node, 'failed', { ms, costUsd: acc.costUsd, turns: acc.turns, summary: { code: 'plan-limited', params: {} } });
          return await finish('stopped', 'plan-limited', {});
        }
        if (r.timedOut || r.code !== 0 || acc.isError) {
          failures += 1;
          await step(node, 'failed', { ms, costUsd: acc.costUsd, turns: acc.turns, summary: { code: r.timedOut ? 'timeout' : 'agent-error', params: { output: tail(acc.result || r.err, 400) } } });
          if (mode === 'live') return await finish('failed', 'step-failed', { label: data.label || node.id });
          continue;
        }
        if (mode === 'dry') {
          const v = verdictOf(acc.result);
          const ok = v ? v.canRun : true;
          if (!ok) failures += 1;
          const params = v
            ? { text: envLib.maskSecrets(v.summary), missing: v.missing.map((m) => envLib.maskSecrets(m)) }
            : { text: tail(acc.result, 300), missing: [] };
          await step(node, ok ? 'passed' : 'failed', { ms, costUsd: acc.costUsd, turns: acc.turns, summary: { code: v ? 'agent-verdict' : 'agent-done', params } });
        } else {
          await step(node, 'passed', { ms, costUsd: acc.costUsd, turns: acc.turns, summary: { code: 'agent-done', params: { text: tail(acc.result, 300) } } });
        }
        continue;
      }

      if (node.type === 'check') {
        const command = String(data.command || '').trim() || (data.type === 'lint_pass' ? 'npm run lint' : data.type === 'build_pass' ? 'npm run build' : 'npm test');
        if (!trusted) {
          await step(node, 'skipped', { ms: 0, summary: { code: 'check-not-run', params: { command } } });
          continue;
        }
        const r = await run(command, [], { cwd: workdir, shell: true });
        const ok = r.code === 0;
        if (!ok) failures += 1;
        await step(node, ok ? 'passed' : 'failed', { ms: Date.now() - began, summary: { code: ok ? 'check-passed' : r.timedOut ? 'timeout' : 'check-failed', params: { command, exit: r.code, output: ok ? '' : tail(r.out + r.err, 600) } } });
        if (!ok && mode === 'live' && failures >= (budget.stopAfterFailures || 1)) return await finish('failed', 'step-failed', { label: data.label || node.id });
        continue;
      }

      if (node.type === 'approval') {
        if (mode === 'dry') {
          await step(node, 'passed', { ms: 0, summary: { code: 'approval-would-wait', params: { approvers: String(data.approvers || '') } } });
          continue;
        }
        await step(node, 'waiting', { summary: { code: 'approval-waiting', params: { approvers: String(data.approvers || '') } } });
        await patch({ status: 'waiting', branch });
        log(`run ${runId}: waiting for approval at ${node.id}`);
        return { status: 'waiting' };
      }

      if (node.type === 'action') {
        const r = await doAction({ node, mode, gh, git, workdir, flow, branch, steps });
        if (!r.ok) failures += 1;
        await step(node, r.ok ? (r.skipped ? 'skipped' : 'passed') : 'failed', { ms: Date.now() - began, summary: r.summary });
        if (!r.ok && mode === 'live') return await finish('failed', 'step-failed', { label: data.label || node.id });
      }
    }

    return await finish(failures ? 'failed' : 'passed', failures ? 'steps-failed' : null, failures ? { count: failures } : {});
  } catch (e) {
    log(`run ${runId}: crashed: ${e && e.message}`);
    return await finish('failed', 'runner-error', { output: tail(e && e.message, 300) });
  } finally {
    // Whatever ended the run (passed, failed, stopped, cancelled), its worktree goes; a paused one stays for the resume.
    if (final && mode === 'live' && git && repoDir && workdir && workdir !== repoDir) cleanupWorktree(git, repoDir, workdir);
  }
}

/** Worktrees of runs Pravex no longer lists as open (cancelled while paused, or left by a crash). */
function sweepWorktrees(active) {
  let names = [];
  try {
    names = fs.readdirSync(RUNS_DIR);
  } catch {
    return;
  }
  const git = which('git');
  for (const name of names) {
    if (active.includes(name)) continue;
    const dir = path.join(RUNS_DIR, name);
    let repo = null;
    try {
      const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(path.join(dir, '.git'), 'utf8'));
      if (m) repo = path.resolve(m[1].trim(), '..', '..', '..');
    } catch {
      /* not a worktree */
    }
    if (git && repo) cleanupWorktree(git, repo, dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* left for next time */
    }
  }
}

async function ghOk(gh, args, cwd) {
  if (!gh) return { ok: false, out: '' };
  const r = await run(gh, args, { cwd, timeoutMs: 60000 });
  return { ok: r.code === 0, out: r.out, err: r.err };
}

/** An action, done (live) or verified (dry). */
async function doAction({ node, mode, gh, git, workdir, flow, branch, steps }) {
  const data = node.data || {};
  const type = data.type || 'open_pr';
  if (!gh && type !== 'notify') return { ok: false, summary: { code: 'cli-missing', params: { cli: 'gh' } } };

  if (type === 'open_pr' || type === 'comment_pr') {
    const authed = await ghOk(gh, ['auth', 'status'], workdir);
    if (!authed.ok) return { ok: false, summary: { code: 'github-not-connected', params: {} } };
    const perm = await ghOk(gh, ['repo', 'view', flow.repo, '--json', 'viewerPermission', '-q', '.viewerPermission'], workdir);
    const level = perm.out.trim();
    if (!['WRITE', 'MAINTAIN', 'ADMIN'].includes(level)) return { ok: false, summary: { code: 'github-no-write', params: { permission: level || 'NONE' } } };
    if (mode === 'dry') return { ok: true, summary: { code: 'pr-would-open', params: { repo: flow.repo, permission: level } } };
    if (type === 'comment_pr') return { ok: true, skipped: true, summary: { code: 'comment-needs-pr', params: {} } };
    const status = await run(git, ['status', '--porcelain'], { cwd: workdir });
    if (status.out.trim()) {
      await run(git, ['add', '-A'], { cwd: workdir });
      await run(git, ['commit', '-m', `${flow.name} (Pravex flow)`, '--no-verify'], { cwd: workdir });
    }
    const ahead = await run(git, ['rev-list', '--count', '@{upstream}..HEAD'], { cwd: workdir });
    const commits = await run(git, ['log', '--oneline', 'HEAD', '--not', '--remotes'], { cwd: workdir });
    if (!commits.out.trim() && ahead.code !== 0) return { ok: true, skipped: true, summary: { code: 'nothing-to-commit', params: {} } };
    const pushed = await run(git, ['push', '-u', 'origin', branch], { cwd: workdir, timeoutMs: 120000 });
    if (pushed.code !== 0) return { ok: false, summary: { code: 'push-failed', params: { output: tail(pushed.err, 300) } } };
    const body = ['Opened by a Pravex flow.', '', ...steps.filter((s) => s.status === 'passed').map((s) => `- ${s.label}`)].join('\n');
    const pr = await run(gh, ['pr', 'create', '--title', `${flow.name}`, '--body', body, '--head', branch], { cwd: workdir, timeoutMs: 60000 });
    if (pr.code !== 0) return { ok: false, summary: { code: 'pr-failed', params: { output: tail(pr.err, 300) } } };
    return { ok: true, summary: { code: 'pr-opened', params: { url: pr.out.trim().split('\n').pop() } } };
  }

  if (type === 'deploy_staging' || type === 'deploy_production') {
    const workflow = String(data.workflow || '').trim();
    if (!workflow) return { ok: false, summary: { code: 'workflow-missing', params: {} } };
    const view = await ghOk(gh, ['workflow', 'view', workflow, '--repo', flow.repo], workdir);
    if (!view.ok) return { ok: false, summary: { code: 'workflow-not-found', params: { workflow } } };
    if (mode === 'dry') return { ok: true, summary: { code: 'deploy-would-run', params: { workflow } } };
    const started = await ghOk(gh, ['workflow', 'run', workflow, '--repo', flow.repo, '--ref', branch], workdir);
    return started.ok ? { ok: true, summary: { code: 'deploy-started', params: { workflow } } } : { ok: false, summary: { code: 'deploy-failed', params: { output: tail(started.err, 300) } } };
  }

  return { ok: true, summary: { code: 'notified', params: {} } };
}

function cleanupWorktree(git, repoDir, workdir) {
  try {
    spawnSync(git, ['worktree', 'remove', '--force', workdir], { cwd: repoDir, timeout: 60000 });
  } catch {
    /* left for the next run to reuse or for the person to remove */
  }
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

function acquireLock() {
  try {
    const held = readJson(LOCK_FILE, null);
    if (held && Date.now() - held.at < LOCK_STALE_MS) {
      try {
        process.kill(held.pid, 0);
        return false;
      } catch {
        /* the holder is gone */
      }
    }
    writeJson(LOCK_FILE, { pid: process.pid, at: Date.now() });
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    /* already gone */
  }
}

function saveState(patch) {
  const state = readJson(STATE_FILE, {});
  writeJson(STATE_FILE, { ...state, ...patch });
}

/** Asks Pravex what this machine should do, runs it, and says it was here. */
async function tick({ now = Date.now() } = {}) {
  if (!acquireLock()) {
    log('tick: another tick is running');
    return;
  }
  try {
    const state = readJson(STATE_FILE, {});
    const machineId = machineIdOf();
    if (!machineId) throw new Error('no machine id yet: start a Claude Code session with the plugin first');
    const lastTickAt = typeof state.lastTickAt === 'number' ? state.lastTickAt : now - TICK_MINUTES * 60000;
    const work = await api('POST', '/api/agent-flows/runner', {
      machineId,
      planUsage: envLib.readPlanUsage(HOME),
      runner: { ...envLib.readRunnerState(HOME), lastTickAt: now },
    });
    // Only once Pravex answered: a tick that fails offline keeps its schedules for the next one.
    saveState({ lastTickAt: now });
    const flows = Array.isArray(work && work.flows) ? work.flows : [];
    sweepWorktrees(Array.isArray(work && work.active) ? work.active : []);

    // Approved live runs pick up where they paused.
    for (const r of Array.isArray(work && work.resume) ? work.resume : []) {
      const flow = flows.find((f) => f.id === r.flowId);
      if (flow) await executeRun({ run: { id: r.runId }, flow, mode: 'live', fromNodeId: r.fromNodeId, branch: r.branch, startCost: Number(r.costUsd) || 0 });
    }
    // Runs requested from the app (a test or "run now").
    for (const r of Array.isArray(work && work.requests) ? work.requests : []) {
      // Pravex hands over only requests for flows this machine's owner assigned here, at the version asked for.
      const flow = flows.find((f) => f.id === r.flowId);
      if (!flow) continue;
      try {
        await api('POST', `/api/agent-flow-runs/${r.runId}/claim`, { machineId });
      } catch (e) {
        log(`claim ${r.runId}: ${e.message}`);
        continue;
      }
      await executeRun({ run: { id: r.runId }, flow, mode: r.mode === 'live' ? 'live' : 'dry', manual: true });
    }
    // Schedules that came due since the last tick.
    for (const flow of flows) {
      const trigger = runOrder(flow.definition)[0];
      const data = (trigger && trigger.data) || {};
      if (!trigger || data.type !== 'schedule' || !data.cron) continue;
      const due = dueMinutes(data.cron, data.timezone, lastTickAt, now);
      if (!due.length) continue;
      const scheduledFor = new Date(due[due.length - 1]).toISOString();
      let created;
      try {
        created = await api('POST', '/api/agent-flow-runs', { flowId: flow.id, machineId, mode: 'live', trigger: 'schedule', scheduledFor });
      } catch (e) {
        log(`schedule ${flow.id}: ${e.message}`);
        continue;
      }
      if (created && created.id && created.created !== false) await executeRun({ run: created, flow, mode: 'live' });
    }
  } catch (e) {
    log(`tick: ${e && e.message}`);
  } finally {
    releaseLock();
  }
}

/** Run one flow now, from Claude Code (`/pravex:flow-test`). Prints a short report. */
async function runNow(flowId, { dry = true } = {}) {
  const machineId = machineIdOf();
  if (!machineId) {
    console.log('Pravex: this machine has no id yet. Start a new Claude Code session with the plugin, then try again.');
    return 1;
  }
  let created;
  try {
    created = await api('POST', '/api/agent-flow-runs', { flowId, machineId, mode: dry ? 'dry' : 'live', trigger: dry ? 'test' : 'manual' });
  } catch (e) {
    console.log(`Pravex: could not start the run: ${e.message}`);
    return 1;
  }
  const flow = created.flow;
  console.log(`Pravex: ${dry ? 'testing' : 'running'} "${flow.name}" on this machine…`);
  if (!created.assigned) console.log("  This flow is not assigned to this machine by you, so its commands are not run: only its agents check, in plan mode.");
  const result = await executeRun({ run: created, flow, mode: dry ? 'dry' : 'live', manual: true, trusted: created.assigned === true });
  let final = null;
  try {
    final = await api('GET', `/api/agent-flow-runs/${created.id}`);
  } catch {
    /* the summary below is still right */
  }
  for (const s of (final && final.steps) || []) {
    const mark = s.status === 'passed' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'waiting' ? '…' : '·';
    const missing = s.summary && s.summary.params && Array.isArray(s.summary.params.missing) && s.summary.params.missing.length ? ` — missing: ${s.summary.params.missing.join('; ')}` : '';
    console.log(`  ${mark} ${s.label}${missing}`);
  }
  console.log(`Result: ${result.status}${result.code ? ` (${result.code})` : ''}. Details in Pravex › Flows › ${flow.name} › Runs.`);
  return result.status === 'passed' || result.status === 'waiting' ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/** Copy the runner and what it requires to `~/.pravex/runner/`, so the schedule outlives plugin updates. */
function refreshCopy(from = __dirname) {
  fs.mkdirSync(RUNNER_DIR, { recursive: true, mode: 0o700 });
  for (const f of ['flow-runner.js', 'auth.js', 'environment.js']) fs.copyFileSync(path.join(from, f), path.join(RUNNER_DIR, f));
  try {
    const manifest = path.join(from, '..', '.claude-plugin', 'plugin.json');
    fs.mkdirSync(path.join(PRAVEX_DIR, '.claude-plugin'), { recursive: true });
    fs.copyFileSync(manifest, path.join(PRAVEX_DIR, '.claude-plugin', 'plugin.json'));
  } catch {
    /* the version then reads as unknown */
  }
}

function launchdPlist(node, script) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(node)}</string><string>${esc(script)}</string><string>--tick</string></array>
  <key>StartInterval</key><integer>${TICK_MINUTES * 60}</integer>
  <key>RunAtLoad</key><false/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(process.env.PATH || '/usr/bin:/bin')}</string></dict>
  <key>StandardOutPath</key><string>${esc(LOG_FILE)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG_FILE)}</string>
</dict>
</plist>
`;
}

function install() {
  refreshCopy();
  const node = process.execPath;
  const script = path.join(RUNNER_DIR, 'flow-runner.js');
  let scheduler;
  if (process.platform === 'darwin') {
    const plist = path.join(HOME, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    spawnSync('launchctl', ['unload', plist], { stdio: 'ignore' });
    fs.writeFileSync(plist, launchdPlist(node, script));
    const r = spawnSync('launchctl', ['load', '-w', plist], { encoding: 'utf8' });
    if (r.status !== 0) {
      console.log(`Pravex: launchd refused the schedule: ${(r.stderr || '').trim()}`);
      return 1;
    }
    scheduler = 'launchd';
  } else if (process.platform === 'win32') {
    const r = spawnSync('schtasks', ['/Create', '/F', '/SC', 'MINUTE', '/MO', String(TICK_MINUTES), '/TN', WINDOWS_TASK, '/TR', `"${node}" "${script}" --tick`], { encoding: 'utf8' });
    if (r.status !== 0) {
      console.log(`Pravex: Task Scheduler refused the schedule: ${(r.stderr || r.stdout || '').trim()}`);
      return 1;
    }
    scheduler = 'schtasks';
  } else {
    const current = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
    const lines = (current.status === 0 ? current.stdout : '').split('\n').filter((l) => l && !l.includes(CRON_MARK));
    lines.push(`*/${TICK_MINUTES} * * * * PATH="${process.env.PATH}" "${node}" "${script}" --tick >> "${LOG_FILE}" 2>&1 ${CRON_MARK}`);
    const r = spawnSync('crontab', ['-'], { input: `${lines.join('\n')}\n`, encoding: 'utf8' });
    if (r.status !== 0) {
      console.log(`Pravex: cron refused the schedule: ${(r.stderr || '').trim()}`);
      return 1;
    }
    scheduler = 'cron';
  }
  const paths = {};
  for (const cli of ['claude', 'git', 'gh', 'node', 'npm', 'pnpm']) {
    const p = which(cli, {});
    if (p) paths[cli] = p;
  }
  saveState({ installed: true, scheduler, version: RUNNER_VERSION, installedAt: Date.now(), paths });
  console.log(`Pravex: the flow runner is installed (${scheduler}, every ${TICK_MINUTES} minutes).`);
  console.log('It runs only the flows you assign to this machine in Pravex, with your Claude Code.');
  if (!paths.claude) console.log('⚠ Claude Code (claude) is not on the PATH, so agent steps cannot run.');
  if (!paths.gh) console.log('⚠ GitHub CLI (gh) is not installed, so steps that open pull requests cannot run.');
  if (!envLib.readPlanUsage(HOME)) console.log('Tip: run /pravex:statusline so the runner can see your plan usage and respect each flow\'s limit.');
  return 0;
}

function uninstall() {
  if (process.platform === 'darwin') {
    const plist = path.join(HOME, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    spawnSync('launchctl', ['unload', '-w', plist], { stdio: 'ignore' });
    try {
      fs.unlinkSync(plist);
    } catch {
      /* not there */
    }
  } else if (process.platform === 'win32') {
    spawnSync('schtasks', ['/Delete', '/F', '/TN', WINDOWS_TASK], { stdio: 'ignore' });
  } else {
    const current = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
    if (current.status === 0) spawnSync('crontab', ['-'], { input: `${current.stdout.split('\n').filter((l) => l && !l.includes(CRON_MARK)).join('\n')}\n` });
  }
  saveState({ installed: false });
  console.log('Pravex: the flow runner is removed. Flows assigned to this machine will not run until you install it again.');
  return 0;
}

async function status() {
  const state = envLib.readRunnerState(HOME);
  const usage = envLib.readPlanUsage(HOME);
  console.log(state.installed ? `Runner: installed (${state.scheduler}), last check ${state.lastTickAt ? new Date(state.lastTickAt).toLocaleString() : 'never'}` : 'Runner: not installed (/pravex:flows install)');
  if (usage) {
    const w = (x) => (x ? `${x.pct}%` : '—');
    console.log(`Plan usage: 5 h ${w(usage.fiveHour)} · 7 days ${w(usage.sevenDay)} (seen ${new Date(usage.at).toLocaleString()})`);
  } else console.log('Plan usage: unknown (install the status line with /pravex:statusline)');
  for (const cli of ['claude', 'git', 'gh']) console.log(`${cli}: ${which(cli) ? 'found' : 'missing'}`);
  const machineId = machineIdOf();
  if (!machineId) return 0;
  try {
    const work = await api('POST', '/api/agent-flows/runner', { machineId, planUsage: usage, runner: state, peek: true });
    const flows = (work && work.flows) || [];
    console.log(flows.length ? `Flows assigned here: ${flows.map((f) => f.name).join(', ')}` : 'No flows are assigned to this machine yet.');
  } catch (e) {
    console.log(`Pravex: ${e.message}`);
  }
  return 0;
}

function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--install')) return install();
  if (argv.includes('--uninstall')) return uninstall();
  if (argv.includes('--status')) return status();
  if (argv.includes('--tick')) {
    await tick();
    return 0;
  }
  const flowId = flagValue(argv, '--run');
  if (flowId) return runNow(flowId, { dry: argv.includes('--dry') });
  console.log('Usage: flow-runner.js --install | --uninstall | --status | --tick | --run <flowId> [--dry]');
  return 1;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code || 0),
    (e) => {
      log(`fatal: ${e && e.message}`);
      process.exit(1);
    },
  );
}

module.exports = {
  DEFAULT_GUARD,
  agentArgs,
  agentPrompt,
  cronMatches,
  dueMinutes,
  executeRun,
  fieldMatches,
  findRepoDir,
  foldStream,
  guardDecision,
  guardOf,
  installCommand,
  launchdPlist,
  refreshCopy,
  runOrder,
  toolsOf,
  usagePct,
  verdictOf,
  zoned,
  newerUsage,
  sweepWorktrees,
};
