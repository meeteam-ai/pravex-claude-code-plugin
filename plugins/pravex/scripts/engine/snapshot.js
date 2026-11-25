'use strict';
/** The state of a run as the screens show it, built from its journal alone, so the screens can never disagree with it. */
const os = require('os');
const { fold, estimate } = require('./machine');
const { proven } = require('./report');

const ENGINE_VERSION = '1';
const cut = (t, n) => String(t === undefined || t === null ? '' : t).slice(0, n);
const last = (a) => a[a.length - 1];

/** The four steps of a part's loop, as the ring draws them. */
function stages(t, open) {
  const mine = open && open.task === t.id ? open.role : null;
  const st = { test: '', build: '', check: '', review: '' };
  if (t.phase === 'done') return { test: 'ok', build: 'ok', check: 'ok', review: 'ok' };
  const at = ['new', 'red', 'built', 'checked', 'reviewed'].indexOf(t.phase);
  if (at >= 1) st.test = 'ok';
  if (at >= 2) st.build = 'ok';
  if (at >= 3) st.check = t.ok ? 'ok' : 'bad';
  if (at >= 4) st.review = t.review && t.review.verdict === 'APPROVED' ? 'ok' : 'bad';
  if (mine === 'tester') st.test = 'run';
  if (mine === 'builder') Object.assign(st, { build: 'run', check: '', review: '' });
  if (mine === 'diagnoser') st.build = 'warn';
  if (mine === 'reviewer') st.review = 'run';
  if (!mine && t.phase === 'built') st.check = 'run';
  if (t.phase === 'blocked') for (const k of Object.keys(st)) if (st[k] === 'run') st[k] = 'bad';
  return st;
}

function history(events, id) {
  const out = [];
  let round = 0;
  for (const e of events) {
    if (e.task !== id) continue;
    const add = (kind, ok, text, output) => out.push({ at: e.at, round, kind, ok, text: cut(text, 400), ...(output ? { output: cut(output, 1500) } : {}) });
    if (e.type === 'task.red') add('test', e.redBefore, (e.covers || []).map((c) => c.test).join('; '));
    else if (e.type === 'task.red.missing') add('test', false, e.why);
    else if (e.type === 'task.built') {
      round = e.round;
      add('build', true, e.summary || (e.files || []).join(', '));
    } else if (e.type === 'task.checked') add('check', e.ok, e.ok ? '' : (e.failures || []).map((f) => f.command || f.kind).join(', '), e.ok ? '' : ((e.failures || [])[0] || {}).output);
    else if (e.type === 'task.diagnosed') add('diagnose', true, `${e.cause} ${e.strategy}`);
    else if (e.type === 'task.reviewed') add('review', e.verdict === 'APPROVED', (e.fixes || []).map((f) => f.problem).join('; '));
    else if (e.type === 'task.restarted') add('restart', true, e.why);
    else if (e.type === 'task.done') add('done', true, '');
    else if (e.type === 'task.blocked') add('blocked', false, e.detail || e.reason);
  }
  return out.slice(-40);
}

/** Everything the backend stores about a run: `{ status, reason, usd, …, snapshot, decisions, inputs, jobs }`. */
function project(events) {
  const s = fold(events);
  const f = s.feasibility;
  const waiting = last(events.filter((e) => e.type === 'run.waiting' || e.type === 'job.started' || e.type === 'run.resumed'));
  const jobs = events
    .filter((e) => e.type === 'job.finished')
    .map((e, i) => ({ n: i + 1, at: e.at, role: e.role, ...(e.task ? { task: e.task } : {}), ...(e.model ? { model: e.model } : {}), ms: Math.round(e.ms || 0), usd: e.usd || 0, ok: e.done !== undefined ? !!e.done : !!e.ok, ...(e.error ? { error: e.error } : {}) }));
  const fixes = s.tasks.reduce((n, t) => n + Math.max(0, t.round - 1), 0) + events.filter((e) => e.type === 'task.diagnosed' || e.type === 'task.restarted').length;
  return {
    status: s.final || (s.paused ? 'paused' : 'running'),
    reason: s.paused ? { code: s.paused } : s.reason ? { code: s.reason, ...(s.reason === 'environment' && s.prepareError ? { params: { code: s.prepareError.code, detail: cut(s.prepareError.detail, 600) } } : {}) } : null,
    usd: s.usd,
    activeMs: Math.round(s.activeMs),
    tasksTotal: s.tasks.length,
    tasksDone: s.tasks.filter((t) => t.phase === 'done').length,
    fixes,
    branch: s.base ? s.base.branch : null,
    decisions: s.decisions.map((d) => ({ n: d.n, title: cut(d.title, 300), decision: cut(d.decision, 1000), why: cut(d.why, 600), reversible: d.reversible })),
    inputs: ((f && f.missing) || []).map((m, i) => ({ n: i + 1, what: cut(m.what, 400), owner: cut(m.owner, 200), meanwhile: cut(m.meanwhile, 400) })),
    jobs,
    snapshot: {
      feasibility: f ? { build: f.build, verify: f.verify, summary: cut(f.summary, 1500), alternative: cut(f.alternative, 1500) } : null,
      criteria: proven(s).map((c) => ({ ...c, text: cut(c.text, 500), tests: c.tests.slice(0, 6).map((t) => cut(t, 200)) })),
      checks: ((s.prepared && s.prepared.checks) || []).map((c) => ({ command: c.command, ok: c.ok })),
      tasks: s.tasks.map((t) => ({
        id: t.id,
        title: cut(t.title, 200),
        phase: t.phase,
        round: t.round,
        criteria: t.criteria,
        dependsOn: t.dependsOn,
        risk: t.risk,
        stages: stages(t, s.open),
        blocked: t.blocked ? { reason: t.blocked.reason, detail: cut(t.blocked.detail, 300) } : null,
        branch: (last(events.filter((e) => e.type === 'task.blocked' && e.task === t.id)) || {}).branch || null,
        history: history(events, t.id),
        trust: { testsIntact: t.evidence ? t.evidence.testsIntact : null, violations: t.violations.length, redBefore: t.redBefore },
      })),
      estimate: estimate(s),
      integrate: s.integrate ? { ok: s.integrate.ok } : null,
      cost: s.cost,
      notes: [...new Set(s.tasks.flatMap((t) => (t.review && t.review.notes) || []))].slice(0, 30).map((n) => cut(n, 400)),
      process: { engineVersion: ENGINE_VERSION, pid: process.pid, hostname: cut(os.hostname(), 120), jobs: s.jobs, events: events.length, waiting: waiting && waiting.type === 'run.waiting' ? { why: waiting.why, until: waiting.until } : null },
    },
  };
}

module.exports = { ENGINE_VERSION, project };
