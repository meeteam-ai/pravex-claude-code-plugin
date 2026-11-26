'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fold, next, checkPlan, initial, reduce, DEFAULTS } = require('./machine');

const T = (id, over = {}) => ({ id, title: id, criteria: ['AC-1'], dependsOn: [], files: ['src/**'], tests: ['test/**'], ...over });
const started = (tasks, cfg = {}) => [
  { type: 'run.created', req: { text: 'x' }, cfg },
  { type: 'run.prepared' },
  { type: 'analyze.done', feasibility: { build: { ok: true }, verify: { ok: true }, criteria: [] } },
  ...(tasks ? [{ type: 'plan.done', tasks }] : []),
];
const red = (id) => ({ type: 'task.red', task: id, redBefore: true, testHashes: {}, sha: 'a' });

test('a run goes from the requirement to the end, one thing at a time', () => {
  const ev = [{ type: 'run.created', req: { text: 'x' } }];
  assert.equal(next(fold(ev)).do, 'prepare');
  ev.push({ type: 'run.prepared' });
  const step = (e) => ev.push(e) && next(fold(ev));
  assert.equal(next(fold(ev)).do, 'analyze');
  assert.equal(step({ type: 'analyze.done', feasibility: { build: { ok: true } } }).do, 'plan');
  assert.deepEqual(step({ type: 'plan.done', tasks: [T('T1')] }), { do: 'test', task: 'T1', attempt: 1 });
  assert.deepEqual(step(red('T1')), { do: 'build', task: 'T1', round: 1, why: 'first' });
  assert.equal(step({ type: 'task.built', task: 'T1', round: 1 }).do, 'check');
  assert.equal(step({ type: 'task.checked', task: 'T1', ok: true }).do, 'review');
  assert.equal(step({ type: 'task.reviewed', task: 'T1', verdict: 'APPROVED' }).do, 'merge');
  assert.equal(step({ type: 'task.done', task: 'T1' }).do, 'integrate');
  assert.equal(step({ type: 'integrate.done', ok: true }).do, 'deliver');
  assert.deepEqual(step({ type: 'run.delivered' }), { do: 'finish', status: 'done', reason: null });
  assert.equal(step({ type: 'run.finished', status: 'done' }).do, 'none');
});

test('what cannot be built ends before spending, and still delivers the explanation', () => {
  const ev = [{ type: 'run.created', req: {} }, { type: 'run.prepared' }, { type: 'analyze.done', feasibility: { build: { ok: false, why: 'moves real money' } } }];
  assert.deepEqual(next(fold(ev)), { do: 'deliver', reason: 'infeasible' });
  assert.equal(next(fold([...ev, { type: 'run.delivered' }])).status, 'infeasible');
});

test('the same failure twice brings a diagnosis before another try', () => {
  const ev = [...started([T('T1')]), red('T1'), { type: 'task.built', task: 'T1', round: 1 }, { type: 'task.checked', task: 'T1', ok: false, fp: 'aa' }];
  assert.equal(next(fold(ev)).do, 'build');
  ev.push({ type: 'task.built', task: 'T1', round: 2 }, { type: 'task.checked', task: 'T1', ok: false, fp: 'aa' });
  assert.equal(next(fold(ev)).do, 'diagnose');
  ev.push({ type: 'task.diagnosed', task: 'T1', cause: 'c', strategy: 's', fp: 'aa' });
  assert.deepEqual(next(fold(ev)), { do: 'build', task: 'T1', round: 3, why: 'checks' });
});

test('a different failure each time is progress, not a stuck task', () => {
  const ev = [...started([T('T1')]), red('T1')];
  for (const [r, fp] of [[1, 'aa'], [2, 'bb']]) ev.push({ type: 'task.built', task: 'T1', round: r }, { type: 'task.checked', task: 'T1', ok: false, fp });
  assert.equal(next(fold(ev)).do, 'build');
});

test('a task that cannot pass is set aside, what stood on it too, and the rest goes on', () => {
  const ev = [...started([T('T1'), T('T2', { dependsOn: ['T1'] }), T('T3')]), { type: 'task.blocked', task: 'T1', reason: 'checks' }];
  assert.deepEqual(next(fold(ev)), { do: 'block', task: 'T2', reason: 'dependency' });
  ev.push({ type: 'task.blocked', task: 'T2', reason: 'dependency' });
  assert.equal(next(fold(ev)).task, 'T3');
  ev.push({ type: 'task.done', task: 'T3' }, { type: 'integrate.done', ok: true }, { type: 'run.delivered' });
  assert.equal(next(fold(ev)).status, 'partial');
});

test('money and time pause the run; a raise lets it go on from where it was', () => {
  const ev = [...started([T('T1')], { maxUsd: 1 }), { type: 'job.finished', role: 'builder', task: 'T1', ok: true, usd: 1.2 }];
  assert.deepEqual(next(fold(ev)), { do: 'pause', reason: 'budget' });
  ev.push({ type: 'run.paused', reason: 'budget' });
  assert.equal(next(fold(ev)).do, 'wait');
  ev.push({ type: 'run.resumed', cfg: { maxUsd: 5 } });
  assert.equal(next(fold(ev)).do, 'test');
});

test('a job cut off by a crash is asked for again', () => {
  const ev = [...started([T('T1')]), { type: 'job.started', job: 'j1', role: 'tester', task: 'T1' }];
  assert.equal(fold(ev).open.job, 'j1');
  ev.push({ type: 'run.resumed' });
  assert.equal(fold(ev).open, null);
  assert.equal(next(fold(ev)).do, 'test');
});

test('a job that keeps failing ends what depends on it instead of looping', () => {
  const ev = [{ type: 'run.created', req: {} }, { type: 'run.prepared' }];
  for (let i = 0; i < DEFAULTS.jobRetries + 1; i++) ev.push({ type: 'job.finished', role: 'analyst', ok: false });
  assert.deepEqual(next(fold(ev)), { do: 'deliver', reason: 'analyze-failed' });
});

test('a plan is refused when it loops, leaves the repository, touches what is protected or forgets a criterion', () => {
  const ok = checkPlan([T('T1'), T('T2', { dependsOn: ['T1'] })], { criteria: [{ id: 'AC-1' }] });
  assert.deepEqual(ok, { problems: [], order: ['T1', 'T2'] });
  const bad = (tasks, opts) => checkPlan(tasks, opts).problems.join('\n');
  assert.match(bad([T('T1', { dependsOn: ['T2'] }), T('T2', { dependsOn: ['T1'] })]), /wait on each other/);
  assert.match(bad([T('T1', { dependsOn: ['T9'] })]), /not in the plan/);
  assert.match(bad([T('T1', { files: ['../x'] })]), /not a path inside/);
  assert.match(bad([T('T1', { files: ['/etc/passwd'] })]), /not a path inside/);
  assert.match(bad([T('T1', { files: ['.github/workflows/ci.yml'] })], { protectedGlobs: ['.github/workflows/**'] }), /protected/);
  assert.match(bad([T('T1')], { criteria: [{ id: 'AC-1' }, { id: 'AC-2' }] }), /AC-2 is in no task/);
  assert.match(bad([T('1; rm')]), /must look like/);
  assert.match(bad([]), /no tasks/);
});

/** Plays a whole run against answers chosen at random: whatever happens, it must end, and soon. */
function play(seed) {
  let x = seed;
  const rnd = () => (x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const ev = [{ type: 'run.created', req: {}, cfg: { maxUsd: 1e9, maxHours: 1e9 } }];
  for (let n = 0; n < 3000; n++) {
    const s = fold(ev);
    if (rnd() > 0.97 && s.objections.length < 3) ev.push({ type: 'decision.objected', n: s.objections.length + 1, reason: 'x' });
    const a = next(fold(ev));
    const job = (role, task, ok) => ev.push({ type: 'job.started', role, task, job: `j${n}` }, { type: 'job.finished', role, task, ok, usd: 0.1, ms: 1 });
    const ok = rnd() > 0.15;
    switch (a.do) {
      case 'none':
        return { s, n };
      case 'wait':
        ev.push({ type: 'run.resumed' });
        break;
      case 'prepare':
        ev.push(ok ? { type: 'run.prepared' } : { type: 'prepare.failed', code: 'install' });
        break;
      case 'analyze':
        job('analyst', null, ok);
        if (ok) ev.push({ type: 'analyze.done', feasibility: { build: { ok: rnd() > 0.1 }, criteria: [] } });
        break;
      case 'plan':
        job('planner', null, ok);
        if (ok) ev.push(rnd() > 0.3 ? { type: 'plan.done', tasks: [T('T1'), T('T2', { dependsOn: rnd() > 0.5 ? ['T1'] : [] }), T('T3', { dependsOn: ['T2'] }), T('T4', { dependsOn: rnd() > 0.8 ? ['T9'] : [] })] } : { type: 'plan.invalid', problems: ['x'] });
        break;
      case 'replan':
        job('replanner', String(a.n), ok);
        if (ok) ev.push({ type: 'replan.done', n: a.n, ok: rnd() > 0.4, criteria: [], tasks: rnd() > 0.5 ? [T(`T${50 + a.n}`, { dependsOn: ['T1'] })] : [] });
        break;
      case 'drop-objection':
        ev.push({ type: 'replan.done', n: a.n, ok: false });
        break;
      case 'test':
        job('tester', a.task, ok);
        if (ok) ev.push(rnd() > 0.3 ? red(a.task) : { type: 'task.red.missing', task: a.task });
        break;
      case 'accept-red':
        ev.push({ ...red(a.task), redBefore: false });
        break;
      case 'build':
        job('builder', a.task, ok);
        if (ok) ev.push({ type: 'task.built', task: a.task, round: a.round });
        break;
      case 'check':
        ev.push({ type: 'task.checked', task: a.task, ok: rnd() > 0.5, fp: rnd() > 0.5 ? 'aa' : `f${n}` });
        break;
      case 'diagnose':
        job('diagnoser', a.task, ok);
        if (ok) ev.push({ type: 'task.diagnosed', task: a.task, testsWrong: rnd() > 0.7, fp: fold(ev).tasks.find((t) => t.id === a.task).fps.slice(-1)[0] });
        break;
      case 'restart':
        ev.push({ type: 'task.restarted', task: a.task });
        break;
      case 'extend':
        job('tester', a.task, ok);
        if (ok) ev.push({ type: 'task.extended', task: a.task, ok: rnd() > 0.3, testHashes: {} });
        break;
      case 'review':
        job('reviewer', a.task, ok);
        if (ok) ev.push({ type: 'task.reviewed', task: a.task, verdict: rnd() > 0.5 ? 'APPROVED' : 'FIX', needsTests: rnd() > 0.5 });
        break;
      case 'merge':
        ev.push({ type: 'task.done', task: a.task });
        break;
      case 'block':
        ev.push({ type: 'task.blocked', task: a.task, reason: a.reason });
        break;
      case 'integrate':
        ev.push({ type: 'integrate.done', ok: rnd() > 0.2 });
        break;
      case 'deliver':
        ev.push({ type: 'run.delivered' });
        break;
      case 'pause':
        ev.push({ type: 'run.paused', reason: a.reason });
        break;
      case 'finish':
        ev.push({ type: 'run.finished', status: a.status });
        break;
      default:
        throw new Error(`nothing handles ${a.do}`);
    }
  }
  throw new Error(`seed ${seed} never ended`);
}

test('no run can get stuck: 5,000 random runs all end, each with an explanation', () => {
  const ends = {};
  let longest = 0;
  for (let seed = 1; seed <= 5000; seed++) {
    const { s, n } = play(seed);
    assert.ok(['done', 'partial', 'failed', 'infeasible'].includes(s.final), `seed ${seed}: ${s.final}`);
    for (const t of s.tasks) assert.ok(t.phase === 'done' || (t.phase === 'blocked' && t.blocked.reason) || s.final === 'failed', `seed ${seed}: ${t.id} left at ${t.phase}`);
    ends[s.final] = (ends[s.final] || 0) + 1;
    longest = Math.max(longest, n);
  }
  assert.ok(ends.done && ends.partial && ends.failed && ends.infeasible, JSON.stringify(ends));
  assert.ok(longest < 200, `the longest run took ${longest} steps`);
});

test('an event this engine does not know changes nothing', () => {
  assert.deepEqual(reduce(initial(), { type: 'from.the.future' }), initial());
});

test('a report of a long run always fits what Pravex accepts, keeping what people must see', () => {
  const { fit } = require('./snapshot');
  const history = Array.from({ length: 40 }, (_, i) => ({ at: 'x', round: i, kind: 'check', ok: false, text: 't', output: 'e'.repeat(1500) }));
  const body = { status: 'running', report: 'r'.repeat(100_000), jobs: Array.from({ length: 200 }, (_, n) => ({ n })), snapshot: { tasks: Array.from({ length: 12 }, (_, i) => ({ id: `T${i}`, history: [...history] })), criteria: [{ id: 'AC-1', tests: ['a', 'b', 'c'] }], notes: Array(30).fill('n'.repeat(400)) } };
  fit(body);
  assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 280_000);
  assert.equal(body.snapshot.tasks.length, 12);
  assert.equal(body.snapshot.criteria.length, 1);
  assert.equal(body.status, 'running');
});
