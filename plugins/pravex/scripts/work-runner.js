#!/usr/bin/env node
'use strict';
/**
 * Joins the build engine to Pravex: takes the requirements queued for this machine, runs each in its own process, and
 * reports what its journal says. The work never waits for Pravex: without a connection it goes on and reports later.
 *
 *   work-runner.js --poll          the minute's check: new requests, what people decided, runs that died
 *   work-runner.js --drive <dir>   one run, to its end (or to a pause)
 *
 * Only what its own person queued for this machine is run here: Pravex hands over nothing else.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const engine = require('./engine/engine');
const journal = require('./engine/journal');
const machine = require('./engine/machine');
const { project, fit, ENGINE_VERSION } = require('./engine/snapshot');
const { report } = require('./engine/report');

const WORK = 'work.json';
const SYNC_MS = 3000;
/** Pauses that end by themselves when their cause does. */
const SELF_RESUME = { 'claude-unavailable': 15 * 60e3, 'claude-signed-out': 60e3 };
/** Without a word from Pravex for this long, nobody could stop it: it finishes the step it is in and pauses. */
const ALONE_MS = 2 * 60 * 60e3;

const readJson = (f, d = null) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
function writeJson(f, v) {
  const t = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(t, JSON.stringify(v, null, 1), { mode: 0o600 });
  fs.renameSync(t, f);
}
const workOf = (dir) => readJson(path.join(dir, WORK));
const saveWork = (dir, more) => writeJson(path.join(dir, WORK), { ...(workOf(dir) || {}), ...more });

/** The builds on this machine that Pravex knows about. */
function localRuns(root = engine.BUILDS) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const id of fs.readdirSync(root).sort()) {
    const dir = path.join(root, id);
    const work = workOf(dir);
    if (!work || !work.runId) continue;
    const events = journal.read(dir);
    const state = machine.fold(events);
    out.push({ dir, engineId: id, work, events, state, status: work.cancelled ? 'cancelled' : state.final || (state.paused ? 'paused' : 'running') });
  }
  return out;
}

/** Whether a process is working on this run now. */
function alive(dir) {
  const pid = Number((readJson(path.join(dir, 'lock')) ?? 0) || 0);
  try {
    return pid > 0 && process.kill(pid, 0);
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** One report of a run, from its journal. Answers what Pravex said, or throws. */
async function sync(dir, api) {
  const work = workOf(dir);
  const events = journal.read(dir);
  if (!work || !events.length) return null;
  const p = project(events);
  const pr = [...events].reverse().find((e) => e.type === 'pr.opened' || e.type === 'pr.failed');
  const reportFile = path.join(dir, 'report.md');
  const body = {
    seq: events.length,
    ...p,
    status: work.cancelled ? 'cancelled' : p.status,
    jobs: p.jobs.filter((j) => j.n > (work.jobsSent || 0)).slice(0, 200),
    ...(pr && pr.url ? { prUrl: pr.url } : {}),
    ...(fs.existsSync(reportFile) ? { report: fs.readFileSync(reportFile, 'utf8').slice(0, 100_000) } : {}),
  };
  body.snapshot.process.pr = pr ? { state: pr.type === 'pr.opened' ? 'opened' : 'failed', ...(pr.url ? { url: pr.url } : {}), ...(pr.detail ? { detail: pr.detail } : {}) } : null;
  fit(body);
  const answer = await api('PATCH', `/api/work/${work.runId}/progress`, body);
  const lastJob = body.jobs.length ? body.jobs[body.jobs.length - 1].n : work.jobsSent || 0;
  saveWork(dir, { seqSent: body.seq, jobsSent: lastJob, sentAt: Date.now(), statusSent: body.status, unsent: p.jobs.length > lastJob });
  return answer;
}

/** Writes the cancellation in the journal, once the process that worked on it is gone: it is then like any other end. */
function cancelRun(dir) {
  const events = journal.read(dir);
  if (!machine.fold(events).final) journal.append(dir, { type: 'run.cancelled' });
}

/** Puts the branch on the remote and opens the pull request. A failure is written down; the work is still there. */
function openPr(dir, { gh = 'gh', run = spawnSync } = {}) {
  const events = journal.read(dir);
  const s = machine.fold(events);
  const repo = path.join(dir, 'repo');
  const fail = (detail) => journal.append(dir, { type: 'pr.failed', detail: String(detail || '').trim().slice(-400) });
  if (!s.base || !/github\.com/.test(s.base.origin || '')) return fail('this repository has no GitHub remote');
  if (events.some((e) => e.type === 'pr.opened')) return null;
  const opts = { cwd: repo, encoding: 'utf8', timeout: 180_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: dir } };
  const pushed = run('git', ['-c', 'core.hooksPath=/dev/null', 'push', '-q', 'origin', `${s.base.branch}:refs/heads/${s.base.branch}`], opts);
  if (pushed.status !== 0) return fail(pushed.stderr || pushed.error);
  const status = machine.finalStatus(s);
  const body = path.join(dir, 'pr-body.md');
  fs.writeFileSync(body, `${report(s, { status, events }).markdown}\n\n---\n${s.req.locale === 'en' ? 'Built by Pravex. Every line above comes from checks it ran, not from what an agent said.' : 'Construido por Pravex. Todo lo de arriba sale de comprobaciones que corrió, no de lo que dijo un agente.'}\n`);
  const title = `${s.req.text.split('\n')[0].slice(0, 70)}${status === 'partial' ? (s.req.locale === 'en' ? ' (partial)' : ' (en parte)') : ''}`;
  const base = String(s.base.ref || '').replace(/^refs\/remotes\/origin\//, '').replace(/^refs\/heads\//, '');
  const made = run(gh, ['pr', 'create', '--title', title, '--body-file', body, '--head', s.base.branch, ...(base && base !== 'HEAD' ? ['--base', base] : [])], opts);
  if (made.status !== 0) return fail(made.stderr || made.error);
  return journal.append(dir, { type: 'pr.opened', url: String(made.stdout).trim().split('\n').pop() });
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

async function drive(dir, { api, engineOpts = {}, pr = openPr, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retries = 5 } = {}) {
  let timer = null;
  let busy = null;
  let heard = now();
  const obey = (a) => {
    heard = now();
    if (!a) return;
    if (a.status === 'cancelled' || (a.wanted && a.wanted.action === 'cancel')) {
      saveWork(dir, { cancelled: true });
      engine.stop(dir);
    } else if (a.wanted && a.wanted.action === 'pause') engine.stop(dir);
  };
  const send = () => {
    if (busy) return busy;
    busy = sync(dir, api)
      .then(obey, (e) => {
        saveWork(dir, { lastError: String(e.message).slice(0, 200), lastErrorAt: now() });
        if (now() - heard > ALONE_MS) engine.stop(dir);
      })
      .finally(() => {
        busy = null;
      });
    return busy;
  };
  const soon = () => {
    if (!timer)
      timer = setTimeout(() => {
        timer = null;
        send();
      }, SYNC_MS);
  };
  const beat = setInterval(send, 30_000);
  let r;
  try {
    await send();
    const cfg = (workOf(dir) || {}).cfg;
    if (cfg) saveWork(dir, { cfg: undefined });
    r = await engine.drive(dir, { ...(cfg ? { cfg } : {}), ...engineOpts, onEvent: soon });
    const work = workOf(dir) || {};
    if (!work.cancelled && ['done', 'partial'].includes(r.status) && (work.autonomy ?? 1) >= 1) await pr(dir);
  } finally {
    clearInterval(beat);
    clearTimeout(timer);
    if (busy) await busy;
    if ((workOf(dir) || {}).cancelled) cancelRun(dir);
    // The last report is the one that matters: it is tried for a while, and the next minute's check has it too.
    for (let i = 0; i < retries; i++) {
      try {
        do await sync(dir, api);
        while ((workOf(dir) || {}).unsent);
        break;
      } catch {
        await sleep(Math.min(60_000, 2000 * 2 ** i));
      }
    }
  }
  return r;
}

// ---------------------------------------------------------------------------
// The minute's check
// ---------------------------------------------------------------------------

/** A requirement queued here becomes a build; what cannot even start is reported instead of waiting for ever. */
async function take(q, { api, machineId, findRepo, root, start }) {
  const repoDir = findRepo(q.repo);
  const id = `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${String(q.id).slice(0, 8)}`;
  await api('POST', `/api/work/${q.id}/claim`, { machineId, engineId: id });
  const failed = (code, detail) =>
    api('PATCH', `/api/work/${q.id}/progress`, { seq: 1, status: 'failed', reason: { code: 'environment', params: { code, detail: String(detail || '').slice(0, 600) } }, usd: 0, activeMs: 0, tasksTotal: 0, tasksDone: 0, fixes: 0, snapshot: null, decisions: [], inputs: [], jobs: [] });
  if (!repoDir) return failed('repo-missing', q.repo);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-inputs-'));
  try {
    const files = [];
    for (const f of q.files || []) {
      const got = await api('GET', `/api/work/${q.id}/files/${f.id}`);
      const to = path.join(tmp, path.basename(got.name));
      fs.writeFileSync(to, Buffer.from(got.base64, 'base64'));
      files.push(to);
    }
    const { dir } = engine.create({ repoDir, text: q.text, files, locale: q.locale || 'es', id, root, cfg: { autonomy: q.autonomy ?? 1, ...(q.maxUsd ? { maxUsd: Number(q.maxUsd) } : {}), ...(q.maxHours ? { maxHours: Number(q.maxHours) } : {}) } });
    saveWork(dir, { runId: q.id, engineId: id, autonomy: q.autonomy ?? 1 });
    start(dir);
    return dir;
  } catch (e) {
    return failed(e.code === 'ENOSPC' ? 'disk-full' : e.code || 'engine-error', e.message);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function poll({ api, machineId, findRepo, root = engine.BUILDS, start, signedIn = () => null, now = Date.now, log = () => {}, maxRuns = 1 }) {
  const runs = localRuns(root);
  const open = runs.filter((r) => !['done', 'partial', 'failed', 'infeasible', 'cancelled'].includes(r.status));
  // What the runs on this machine need does not depend on Pravex answering: a run whose process died goes on.
  for (const r of open) {
    if (alive(r.dir)) continue;
    const ended = (r.events[r.events.length - 1] || {}).at;
    const since = now() - Date.parse(ended || 0);
    const reason = r.state.paused;
    if (!reason) {
      log(`${r.engineId}: its process was gone; started again`);
      start(r.dir);
    } else if (SELF_RESUME[reason] && since > SELF_RESUME[reason] && (reason !== 'claude-signed-out' || signedIn() === true)) {
      log(`${r.engineId}: ${reason} is over; started again`);
      start(r.dir);
    }
  }
  const work = await api('POST', '/api/work/runner', { machineId, engineVersion: ENGINE_VERSION, runs: runs.filter((r) => open.includes(r) || r.work.seqSent !== r.events.length || r.work.unsent).slice(-50).map((r) => ({ id: r.work.runId, engineId: r.engineId, status: r.status })) });
  // Reports that could not be sent when they happened.
  for (const r of runs) {
    if (alive(r.dir) || (r.work.seqSent === r.events.length && !r.work.unsent && r.work.statusSent === r.status)) continue;
    try {
      await sync(r.dir, api);
    } catch (e) {
      log(`${r.engineId}: report: ${e.message}`);
    }
  }
  const byRun = new Map(runs.map((r) => [r.work.runId, r]));
  for (const o of work.objections || []) {
    const r = byRun.get(o.runId);
    if (!r || ['done', 'partial', 'failed', 'infeasible', 'cancelled'].includes(r.status)) continue;
    engine.tell(r.dir, { type: 'objection', n: o.n, title: o.title, reason: o.reason });
    try {
      await api('POST', `/api/work/${o.runId}/objections/${o.n}/taken`, {});
    } catch (e) {
      log(`objection ${o.n}: ${e.message}`);
    }
  }
  for (const c of work.commands || []) {
    const r = byRun.get(c.runId);
    if (!r) continue;
    if (c.action === 'cancel') {
      saveWork(r.dir, { cancelled: true });
      if (alive(r.dir)) engine.stop(r.dir);
      else {
        cancelRun(r.dir);
        await sync(r.dir, api).catch((e) => log(`${r.engineId}: ${e.message}`));
      }
    } else if (c.action === 'pause') {
      if (alive(r.dir)) engine.stop(r.dir);
    } else if (c.action === 'resume' && !alive(r.dir) && open.includes(r)) {
      const cfg = {};
      if (c.maxUsd) cfg.maxUsd = Number(c.maxUsd);
      if (c.maxHours) cfg.maxHours = Number(c.maxHours);
      if (Object.keys(cfg).length) saveWork(r.dir, { cfg });
      start(r.dir);
    }
  }
  // One at a time on a machine by default; the rest wait in Pravex's queue, in order.
  let free = maxRuns - localRuns(root).filter((r) => alive(r.dir)).length;
  for (const q of work.requests || []) {
    if (free <= 0) break;
    try {
      const dir = await take(q, { api, machineId, findRepo, root, start });
      if (typeof dir === 'string') free -= 1;
    } catch (e) {
      if (e.status !== 409) log(`request ${q.id}: ${e.message}`);
    }
  }
  return work;
}

/** A run in a process of its own, that outlives the one that started it. */
function startDetached(dir) {
  const out = fs.openSync(path.join(dir, 'drive.log'), 'a', 0o600);
  const c = spawn(process.execPath, [__filename, '--drive', dir], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
  c.unref();
  fs.closeSync(out);
}

async function main(argv) {
  const runner = require('./flow-runner');
  const environment = require('./environment');
  const api = (m, r, j) => runner.api(m, r, j);
  if (argv[0] === '--drive' && argv[1]) {
    await drive(path.resolve(argv[1]), { api, engineOpts: { log: (what, state) => console.log(new Date().toISOString(), what, state) } });
    return 0;
  }
  if (argv[0] === '--poll') {
    const machineId = runner.machineIdOf();
    if (!machineId) return 0;
    await poll({ api, machineId, findRepo: (r) => runner.findRepoDir(r), start: startDetached, signedIn: () => (environment.claudeStatus(os.homedir(), Date.now()) || {}).signedIn, log: runner.log });
    return 0;
  }
  console.error('work-runner.js --poll | --drive <dir>');
  return 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      // Signed out or offline: the next minute tries again.
      if (process.argv[2] !== '--poll') console.error(e.message);
      process.exit(1);
    }
  );
}

module.exports = { drive, poll, take, sync, openPr, localRuns, alive, saveWork, workOf, startDetached };
