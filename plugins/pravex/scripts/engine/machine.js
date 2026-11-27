'use strict';
/**
 * The build engine's state, as a pure function of its journal.
 *
 * `fold(events)` rebuilds the state of a run from the events written so far; `next(state)` says the one thing to do
 * now. Code decides the order of work, never a model: an agent only does the job it is handed and answers in a fixed
 * shape. Every path ends: a round counter bounds each task, a task that cannot pass is set aside and the rest goes on,
 * and a run always finishes as done, partial, failed or infeasible (or pauses, and can be resumed).
 */

const DEFAULTS = {
  maxRounds: 3, // build rounds per task before it is set aside
  extraRounds: 2, // more rounds once a diagnosis has changed the strategy
  redAttempts: 2, // tries to get acceptance tests that fail before the code exists
  planAttempts: 3,
  prepareAttempts: 2,
  maxWiden: 6, // files a builder may add to its task when it needs them
  jobRetries: 2, // retries of a job that failed for a reason that is not the work itself
  maxTasks: 12,
  maxUsd: 60,
  maxHours: 6,
};

const TASK_ID = /^T\d{1,3}$/;
const FINAL = new Set(['done', 'partial', 'failed', 'infeasible', 'cancelled']);

const initial = () => ({
  status: 'new',
  req: null,
  cfg: { ...DEFAULTS },
  base: null,
  tip: null, // the last commit the journal knows: after a crash the working copy goes back to it
  prepared: null,
  prepareFailures: 0,
  prepareError: null,
  feasibility: null,
  decisions: [], // every gap decided, numbered in the order it came up; a person can object to any of them
  objections: [], // { n, reason, state: 'pending' | 'applied' | 'failed' }
  tasks: [],
  planProblems: [],
  planAttempts: 0,
  failures: {}, // consecutive job failures, by job key
  open: null, // a job that started and has not finished: after a crash it is redone
  usd: 0,
  activeMs: 0,
  cost: {},
  jobs: 0,
  integrate: null,
  delivered: false,
  paused: null,
  approved: false, // the plan, when the project asks a person first
  final: null,
  reason: null,
  // Checks that could not run at all (a variable, a database): each stop, and whether a person resumed after it.
  envBlocks: [], // { at: 'prepare' | task id, command, line, missing, fp, resumed }
  autoPrepared: [], // the problems Pravex already prepared for by itself, once each
});

const newTask = (t) => ({
  id: t.id,
  title: t.title || t.id,
  criteria: t.criteria || [],
  dependsOn: t.dependsOn || [],
  files: t.files || [],
  tests: t.tests || [],
  risk: t.risk === 'high' ? 'high' : 'low',
  notes: t.notes || '',
  phase: 'new', // new → red → built → checked → reviewed → done | blocked
  round: 0,
  redAttempts: 0,
  redBefore: null,
  testHashes: {},
  testCommand: '',
  widened: 0,
  restarts: 0,
  extended: 0, // the review round whose missing tests were already added
  covers: [],
  baseSha: null,
  sha: null,
  ok: null,
  failures: [],
  fps: [],
  diagnosis: null,
  diagnosedFp: null,
  review: null,
  violations: [],
  gaps: [],
  blocked: null,
  evidence: null,
});

/** One decision, once: the same words from two agents are the same decision. */
function addDecision(s, d) {
  const title = String(d.title || '').trim();
  if (!title || s.decisions.some((x) => x.title === title)) return;
  s.decisions.push({ n: s.decisions.length + 1, title, decision: String(d.decision || ''), why: String(d.why || ''), reversible: d.reversible !== false, ...(d.task ? { task: d.task } : {}) });
}

/**
 * A gap an agent left open becomes a decision for a person, once. A gap that names a decision already listed ("decision 5",
 * "decisión D-5") is that decision said again, so it is not listed twice.
 */
function addGap(s, g, task) {
  const named = /\bdecisi(?:o|ó)n\s+(?:D-)?(\d+)\b/i.exec(String(g || ''));
  if (named && s.decisions.some((x) => x.n === Number(named[1]))) return;
  addDecision(s, { title: g, decision: g, why: '', reversible: true, task });
}

const taskOf = (s, id) => s.tasks.find((t) => t.id === id);

/** Applies one event. Unknown events are ignored, so an older engine can read a newer journal. */
function reduce(s, e) {
  const t = e.task ? taskOf(s, e.task) : null;
  switch (e.type) {
    case 'run.created':
      Object.assign(s, { status: 'running', req: e.req, base: e.base || null, tip: e.base ? e.base.sha : null, cfg: { ...DEFAULTS, ...(e.cfg || {}) } });
      break;
    case 'run.resumed':
      if (s.paused === 'plan-ready') s.approved = true;
      // Resumed after "the checks cannot run": whether or not it was fixed, the same problem again is the person's call.
      if (s.paused === 'checks-cannot-run' && s.envBlocks.length) s.envBlocks[s.envBlocks.length - 1].resumed = true;
      s.paused = null;
      s.cfg = { ...s.cfg, ...(e.cfg || {}) };
      // A job cut off by a crash left no result: its counters stay, the work is redone from the last commit.
      s.open = null;
      break;
    case 'run.paused':
      s.paused = e.reason || 'paused';
      break;
    case 'job.started':
      s.open = { job: e.job, role: e.role, task: e.task || null };
      s.jobs += 1;
      break;
    case 'job.finished': {
      s.open = null;
      s.usd += e.usd || 0;
      s.activeMs += e.ms || 0;
      s.cost[e.role] = (s.cost[e.role] || 0) + (e.usd || 0);
      const key = `${e.role}:${e.task || '-'}`;
      s.failures[key] = e.ok ? 0 : (s.failures[key] || 0) + 1;
      break;
    }
    case 'check.finished':
      s.activeMs += e.ms || 0;
      break;
    case 'run.prepared':
      Object.assign(s, { prepared: { checks: e.checks || [], install: e.install || null }, prepareError: null });
      break;
    case 'prepare.failed':
      s.prepareFailures += 1;
      s.prepareError = { code: e.code, detail: e.detail || '' };
      break;
    case 'analyze.done':
      s.feasibility = e.feasibility;
      for (const d of e.feasibility.decisions || []) addDecision(s, d);
      break;
    case 'plan.invalid':
      s.planAttempts += 1;
      s.planProblems = e.problems || [];
      break;
    case 'plan.done':
      s.tasks = (e.tasks || []).map(newTask);
      s.planProblems = [];
      break;
    case 'task.red.missing':
      if (t) {
        t.redAttempts += 1;
        t.redWhy = e.why || '';
      }
      break;
    case 'task.red':
      if (t) Object.assign(t, { phase: 'red', redBefore: !!e.redBefore, testHashes: e.testHashes || {}, covers: e.covers || [], testCommand: e.command || '', baseSha: e.baseSha || null, sha: e.sha || null });
      if (e.sha) s.tip = e.sha;
      break;
    case 'task.widened':
      if (t) {
        t.files.push(...(e.files || []));
        t.widened += (e.files || []).length;
      }
      break;
    case 'task.built':
      for (const g of e.gaps || []) addGap(s, g, e.task);
      if (t) Object.assign(t, { phase: 'built', round: e.round, sha: e.sha || t.sha, violations: [...t.violations, ...(e.violations || [])], gaps: [...t.gaps, ...(e.gaps || [])] });
      if (e.sha) s.tip = e.sha;
      break;
    case 'task.extended':
      if (t) Object.assign(t, { extended: t.round, ...(e.ok ? { testHashes: e.testHashes, testCommand: e.command || t.testCommand, covers: e.covers || t.covers, sha: e.sha } : {}) });
      if (e.ok && e.sha) s.tip = e.sha;
      break;
    case 'task.checked':
      if (t) {
        Object.assign(t, { phase: 'checked', ok: !!e.ok, failures: e.failures || [], checks: e.checks || [] });
        t.fps.push(e.ok ? null : e.fp || null);
      }
      break;
    case 'task.diagnosed':
      if (t) Object.assign(t, { diagnosis: { cause: e.cause || '', strategy: e.strategy || '', testsWrong: !!e.testsWrong, kind: e.kind || (e.testsWrong ? 'tests' : 'code') }, diagnosedFp: e.fp || null });
      break;
    case 'env.blocked':
      // The checks cannot run here. Nothing an agent does changes that, so it stops and says what is missing. The part it
      // was on starts over once someone resumes, from wherever the run is then (its work is kept on a branch).
      s.envBlocks.push({ at: e.task || 'prepare', command: e.command || '', line: e.line || '', missing: e.missing || null, fp: e.fp || null, resumed: false });
      s.paused = 'checks-cannot-run';
      if (t) {
        if (t.baseSha && t.sha && t.sha !== t.baseSha) s.tip = t.baseSha;
        Object.assign(t, { phase: 'new', round: 0, redWhy: '', fps: [], failures: [], diagnosis: null, diagnosedFp: null, review: null, testHashes: {}, testCommand: '', covers: [], extended: 0, baseSha: null, sha: null });
      }
      break;
    case 'env.prepared':
      s.autoPrepared.push(e.fp || null);
      break;
    case 'task.recheck':
      // What kept its checks from running was prepared: they run again on the same build, without another round.
      if (t) Object.assign(t, { phase: 'built', diagnosis: null, diagnosedFp: null });
      break;
    case 'prepare.reset':
      // Checked again from the start: what the repository and the machine have may have changed while it waited.
      Object.assign(s, { prepared: null, prepareFailures: 0, prepareError: null });
      break;
    case 'run.rebased':
      // What was fixed meanwhile on the main branch is taken in, so the run does not wait on its own old copy.
      if (e.sha) s.tip = e.sha;
      if (e.how === 'reset' && s.base) s.base = { ...s.base, sha: e.sha };
      break;
    case 'task.restarted':
      // Its tests were wrong: the task starts over from the commit before it, once.
      if (t) Object.assign(t, { phase: 'new', round: 0, redAttempts: 0, redWhy: e.why || '', restarts: t.restarts + 1, fps: [], failures: [], diagnosis: null, diagnosedFp: null, review: null, testHashes: {}, sha: t.baseSha });
      if (t && t.baseSha) s.tip = t.baseSha;
      break;
    case 'task.reviewed':
      for (const g of e.gaps || []) addGap(s, g, e.task);
      if (t) Object.assign(t, { phase: 'reviewed', review: { verdict: e.verdict, fixes: e.fixes || [], notes: e.notes || [], needsTests: !!e.needsTests, round: t.round }, gaps: [...t.gaps, ...(e.gaps || [])] });
      break;
    case 'task.done':
      if (t) Object.assign(t, { phase: 'done', sha: e.sha || t.sha, evidence: e.evidence || null });
      break;
    case 'task.blocked':
      if (t) Object.assign(t, { phase: 'blocked', blocked: { reason: e.reason, detail: e.detail || '' } });
      // Its commits are not part of the result: the next part starts from before it.
      if (t && t.baseSha && t.sha && t.sha !== t.baseSha) s.tip = t.baseSha;
      break;
    case 'decision.objected':
      if (!s.objections.some((o) => o.n === e.n)) s.objections.push({ n: e.n, reason: e.reason || '', title: e.title || (s.decisions[e.n - 1] || {}).title || '', state: 'pending' });
      break;
    case 'replan.done': {
      const o = s.objections.find((x) => x.n === e.n);
      if (o) o.state = e.ok ? 'applied' : 'failed';
      if (e.ok) {
        // What the result is changed with the objection: the report must not say the old thing.
        if (e.summary) s.feasibility.summary = e.summary;
        s.feasibility.criteria.push(...(e.criteria || []));
        for (const x of e.drop || []) s.feasibility.criteria = s.feasibility.criteria.filter((c) => c.id !== x);
        s.tasks.push(...(e.tasks || []).map(newTask));
        s.integrate = null;
        s.delivered = false;
      }
      break;
    }
    case 'integrate.done':
      s.integrate = { ok: !!e.ok, failures: e.failures || [] };
      break;
    case 'run.delivered':
      s.delivered = true;
      break;
    case 'run.cancelled':
      // A person's word is final, unless the run had already ended by itself.
      // Not paused any more either: a cancelled run is never shown or reported as one that can go on.
      if (!s.final) Object.assign(s, { status: 'cancelled', final: 'cancelled', reason: null, paused: null });
      break;
    case 'run.finished':
      Object.assign(s, { status: e.status, final: e.status, reason: e.reason || null });
      break;
    default:
  }
  return s;
}

const fold = (events) => events.reduce(reduce, initial());

const roundLimit = (s, t) => s.cfg.maxRounds + (t.diagnosis ? s.cfg.extraRounds : 0);
const settled = (t) => t.phase === 'done' || t.phase === 'blocked';
const stuck = (t) => {
  const [a, b] = t.fps.slice(-2);
  return t.fps.length >= 2 && a !== null && a === b;
};
const lastFp = (t) => t.fps[t.fps.length - 1] || null;

/** What a task needs next. Every branch either moves its phase forward, uses a round, or sets it aside. */
function taskAction(s, t) {
  const limit = roundLimit(s, t);
  if (t.phase === 'new') return { do: 'test', task: t.id, attempt: t.redAttempts + 1 };
  if (t.phase === 'red') return { do: 'build', task: t.id, round: 1, why: 'first' };
  if (t.phase === 'built') return { do: 'check', task: t.id };
  if (t.phase === 'checked') {
    if (t.ok) return { do: 'review', task: t.id, final: t.round >= limit };
    // The same failure twice: trying again the same way is wasted money. Someone who did not build it looks first.
    if (t.diagnosis && t.diagnosis.testsWrong && t.restarts < 1) return { do: 'restart', task: t.id };
    if (stuck(t) && t.diagnosedFp !== lastFp(t)) return { do: 'diagnose', task: t.id };
    if (t.round < limit) return { do: 'build', task: t.id, round: t.round + 1, why: 'checks' };
    if (!t.diagnosis) return { do: 'diagnose', task: t.id };
    return { do: 'block', task: t.id, reason: 'checks' };
  }
  if (t.phase === 'reviewed') {
    if (t.review.verdict === 'APPROVED') return { do: 'merge', task: t.id };
    // Tests the review found missing are written by whoever writes tests, before the code is sent back.
    if (t.round < limit && t.review.needsTests && t.extended !== t.round && !(s.failures[`tester:${t.id}`] > 0)) return { do: 'extend', task: t.id };
    if (t.round < limit) return { do: 'build', task: t.id, round: t.round + 1, why: 'review' };
    return { do: 'block', task: t.id, reason: 'review' };
  }
  return null;
}

const finalStatus = (s) => {
  if (s.feasibility && s.feasibility.build && s.feasibility.build.ok === false) return 'infeasible';
  const done = s.tasks.filter((t) => t.phase === 'done').length;
  if (!s.tasks.length || !done) return 'failed';
  return done === s.tasks.length && (!s.integrate || s.integrate.ok) ? 'done' : 'partial';
};

/** The one thing to do now: `{ do, … }`. `do: 'none'` when the run is over; `do: 'wait'` when it is paused. */
function next(s) {
  if (s.final) return { do: 'none' };
  if (s.paused) return { do: 'wait', reason: s.paused };
  if (!s.req) return { do: 'none' };
  const end = (reason) => (s.delivered ? { do: 'finish', status: finalStatus(s), reason: reason || null } : { do: 'deliver', reason: reason || null });

  // A job that keeps failing for reasons that are not the work (no answer, wrong shape) ends what depends on it.
  const failed = (key) => (s.failures[key] || 0) > s.cfg.jobRetries;

  if (!s.prepared) return s.prepareFailures >= s.cfg.prepareAttempts ? end('environment') : { do: 'prepare', attempt: s.prepareFailures + 1 };
  if (!s.feasibility) return failed('analyst:-') ? end('analyze-failed') : { do: 'analyze' };
  if (s.feasibility.build && s.feasibility.build.ok === false) return end('infeasible');
  if (!s.tasks.length) {
    if (s.planAttempts >= s.cfg.planAttempts || failed('planner:-')) return end('plan-failed');
    return { do: 'plan', problems: s.planProblems };
  }
  if (s.cfg.autonomy === 0 && !s.approved) return { do: 'pause', reason: 'plan-ready' };
  // What a person objected to is replanned before anything else is built on top of it.
  const objection = s.objections.find((o) => o.state === 'pending');
  if (objection && s.usd < s.cfg.maxUsd) return failed(`replanner:${objection.n}`) ? { do: 'drop-objection', n: objection.n } : { do: 'replan', n: objection.n };
  if (s.usd >= s.cfg.maxUsd) return { do: 'pause', reason: 'budget' };
  if (s.activeMs >= s.cfg.maxHours * 3600e3) return { do: 'pause', reason: 'time' };

  for (const t of s.tasks) {
    if (settled(t)) continue;
    const deps = t.dependsOn.map((id) => taskOf(s, id));
    // What it stood on was set aside: this one cannot be proven either. The rest of the run goes on.
    if (deps.some((d) => !d || d.phase === 'blocked')) return { do: 'block', task: t.id, reason: 'dependency' };
    if (deps.some((d) => d.phase !== 'done')) continue;
    for (const role of ['tester', 'builder', 'reviewer', 'diagnoser']) if (failed(`${role}:${t.id}`)) return { do: 'block', task: t.id, reason: 'job-failed', detail: role };
    if (t.phase === 'new' && t.redAttempts >= s.cfg.redAttempts) return { do: 'accept-red', task: t.id };
    return taskAction(s, t);
  }
  // Nothing is ready and something is not settled: it waits on a task that is not settled either. The plan is
  // checked for cycles before it is accepted, so this is a defect; it still ends instead of spinning.
  const waiting = s.tasks.find((t) => !settled(t));
  if (waiting) return { do: 'block', task: waiting.id, reason: 'unreachable' };

  if (!s.integrate && s.tasks.some((t) => t.phase === 'done')) return { do: 'integrate' };
  return end(null);
}

/**
 * Problems of a plan an agent proposed, and the order to run it in. A plan is only data until this accepts it: ids,
 * dependencies that exist and do not loop, paths that stay inside the repository and off the protected ones.
 */
function checkPlan(tasks, { criteria = [], protectedGlobs = [], maxTasks = DEFAULTS.maxTasks, existing = [] } = {}) {
  const problems = [];
  if (!Array.isArray(tasks) || !tasks.length) return { problems: ['the plan has no tasks'], order: [] };
  if (tasks.length > maxTasks) problems.push(`the plan has ${tasks.length} tasks; at most ${maxTasks}`);
  const ids = new Set();
  const safe = (g) => typeof g === 'string' && g.trim() && !g.startsWith('/') && !g.startsWith('~') && !g.split('/').includes('..') && !/[\u0000-\u001f]/.test(g);
  for (const t of tasks) {
    if (!t || !TASK_ID.test(String(t.id))) {
      problems.push(`task id ${JSON.stringify(t && t.id)} must look like T1`);
      continue;
    }
    if (ids.has(t.id) || existing.includes(t.id)) problems.push(`task id ${t.id} is repeated`);
    ids.add(t.id);
    for (const [name, list] of [['files', t.files], ['tests', t.tests]]) {
      if (!Array.isArray(list) || !list.length) problems.push(`${t.id} needs at least one path in ${name}`);
      for (const g of list || []) {
        if (!safe(g)) problems.push(`${t.id}: ${JSON.stringify(g)} is not a path inside the repository`);
        else if (protectedGlobs.some((p) => String(g).replace(/^\.\//, '').startsWith(p.replace(/\/?\*\*.*$/, '/')))) problems.push(`${t.id}: ${g} is protected`);
      }
    }
    if (!Array.isArray(t.criteria) || !t.criteria.length) problems.push(`${t.id} proves no criterion`);
  }
  for (const t of tasks) for (const d of t.dependsOn || []) if (!ids.has(d) && !existing.includes(d)) problems.push(`${t.id} depends on ${d}, which is not in the plan`);
  const known = new Set(criteria.map((c) => c.id));
  const covered = new Set(tasks.flatMap((t) => t.criteria || []));
  for (const c of known) if (!covered.has(c)) problems.push(`criterion ${c} is in no task`);
  for (const c of covered) if (known.size && !known.has(c)) problems.push(`criterion ${c} does not exist`);

  // Dependencies first; a loop leaves tasks that never become ready.
  const order = [];
  const left = new Map(tasks.filter((t) => t && ids.has(t.id)).map((t) => [t.id, t]));
  while (left.size) {
    const ready = [...left.values()].filter((t) => (t.dependsOn || []).every((d) => !left.has(d)));
    if (!ready.length) {
      problems.push(`these tasks wait on each other: ${[...left.keys()].join(', ')}`);
      break;
    }
    for (const t of ready) {
      order.push(t.id);
      left.delete(t.id);
    }
  }
  return { problems, order };
}

/** What is left, at list price and in working time. Rough until there is history: the range says so. */
function estimate(s) {
  const left = s.tasks.filter((t) => t.phase !== 'done' && t.phase !== 'blocked');
  if (!left.length) return null;
  // Only what is left: a high-risk part counts double. Money already spent is added once.
  const n = left.length + left.filter((t) => t.risk === 'high').length;
  const slow = ((s.prepared && s.prepared.checks) || []).filter((c) => c.ok).reduce((a, c) => a + (c.ms || 0), 0) / 60e3;
  const round = (x) => Math.round(x * 10) / 10;
  return { usd: [round(s.usd + n * 0.8), round(s.usd + n * 5)], minutes: [Math.ceil(n * (3 + slow)), Math.ceil(n * (18 + 4 * slow))], confidence: 'low' };
}

/** A person resumed after this same problem stopped the run here: it is not stopped for it again. */
const envAccepted = (s, at, fp) => s.envBlocks.some((b) => b.at === at && b.fp === fp && b.resumed);

module.exports = { envAccepted, estimate, DEFAULTS, FINAL, initial, reduce, fold, next, checkPlan, finalStatus, roundLimit, taskOf };
