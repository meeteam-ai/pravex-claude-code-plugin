'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const work = require('./work-runner');
const engine = require('./engine/engine');
const journal = require('./engine/journal');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-work-'));
const sh = (cwd, ...a) => spawnSync(a[0], a.slice(1), { cwd, encoding: 'utf8' });
function repository() {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module","scripts":{"test":"node --test"}}');
  fs.writeFileSync(path.join(dir, 'a.test.js'), "import t from 'node:test'; t('a', () => {});\n");
  sh(dir, 'git', 'init', '-q', '-b', 'main');
  sh(dir, 'git', 'add', '-A');
  sh(dir, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t.t', 'commit', '-qm', 'init');
  return dir;
}

/** Pravex, as the contract says it behaves. */
function pravex({ queued = [], files = {} } = {}) {
  const p = { queued, runs: {}, commands: [], objections: [], taken: [], calls: [], down: false };
  p.api = async (method, route, body) => {
    p.calls.push(`${method} ${route}`);
    if (p.down) throw new Error('offline');
    if (route === '/api/work/runner') {
      for (const r of body.runs) (p.runs[r.id] = p.runs[r.id] || {}).beat = true;
      return { requests: p.queued.slice(0, 3), commands: p.commands, objections: p.objections };
    }
    let m = route.match(/^\/api\/work\/([\w-]+)\/claim$/);
    if (m) {
      if (!p.queued.some((q) => q.id === m[1])) throw Object.assign(new Error('taken'), { status: 409 });
      p.queued = p.queued.filter((q) => q.id !== m[1]);
      p.runs[m[1]] = { status: 'running', seq: 0, jobs: [], engineId: body.engineId };
      return { ok: true };
    }
    m = route.match(/^\/api\/work\/([\w-]+)\/files\/([\w-]+)$/);
    if (m) return files[m[2]];
    m = route.match(/^\/api\/work\/([\w-]+)\/progress$/);
    if (m) {
      const r = (p.runs[m[1]] = p.runs[m[1]] || { seq: 0, jobs: [] });
      if (body.seq > (r.seq || 0)) {
        Object.assign(r, { ...body, jobs: r.jobs || [] });
        for (const j of body.jobs) if (!r.jobs.some((x) => x.n === j.n)) r.jobs.push(j);
      }
      return { status: r.status, wanted: p.wanted || null };
    }
    m = route.match(/^\/api\/work\/([\w-]+)\/objections\/(\d+)\/taken$/);
    if (m) {
      p.taken.push(Number(m[2]));
      p.objections = [];
      return { ok: true };
    }
    throw new Error(`no route ${route}`);
  };
  return p;
}

const ANALYSIS = { build: { ok: true, why: '' }, verify: { ok: false, why: 'no keys' }, summary: 's', criteria: [{ id: 'AC-1', text: 'mul' }], decisions: [{ title: 'Zero', decision: 'zero', why: 'w', reversible: true }], missing: [{ what: 'keys', owner: 'client', meanwhile: 'stand-in' }], alternative: '' };
const TASK = { id: 'T1', title: 'Multiply', criteria: ['AC-1'], dependsOn: [], files: ['mul.js'], tests: ['mul.test.js'], risk: 'low', notes: '' };
const ok = (value) => ({ ok: true, value, usd: 0.1, ms: 5, turns: 1, denied: [] });
const testOf = (f, n) => `import t from 'node:test'; import a from 'node:assert'; t('x', async () => { const { mul } = await import('./${f}.js'); a.equal(mul(2, 3), ${n}); });\n`;
function ask(over = {}) {
  const base = {
    analyst: () => ok(ANALYSIS),
    planner: () => ok({ tasks: [TASK] }),
    tester: (j) => (fs.writeFileSync(path.join(j.cwd, 'mul.test.js'), testOf('mul', 6)), ok({ status: 'DONE', files: [], command: 'node --test mul.test.js', covers: [{ criterion: 'AC-1', test: 'x' }], note: '' })),
    builder: (j) => (fs.writeFileSync(path.join(j.cwd, 'mul.js'), 'export const mul = (a, b) => a * b;\n'), ok({ status: 'DONE', summary: 'done', gaps: [], needs: [] })),
    reviewer: () => ok({ verdict: 'APPROVED', fixes: [], gaps: [], notes: [] }),
    ...over,
  };
  return async (j) => base[j.role](j);
}
const opts = (p, over = {}) => ({ api: p.api, pr: async () => null, sleep: async () => {}, engineOpts: { ask: ask(over), keepAwake: false, sleep: async () => {} } });
const polling = (p, root, more = {}) => ({ api: p.api, machineId: 'm1', root, findRepo: () => more.repo ?? repository(), start: more.start || (() => {}), ...more });

test('a queued requirement is claimed, built and reported to its end', async () => {
  const root = tmp();
  const p = pravex({ queued: [{ id: 'r-1', repo: 'a/b', text: 'multiply', locale: 'es', autonomy: 1, maxUsd: 9, files: [{ id: 'f1', name: 'x' }] }], files: { f1: { name: '../../spec.md', mime: 'text/markdown', base64: Buffer.from('hello').toString('base64') } } });
  let dir;
  await work.poll(polling(p, root, { start: (d) => (dir = d) }));
  assert.equal(fs.readFileSync(path.join(dir, 'repo/.pravex-inputs/spec.md'), 'utf8'), 'hello');
  await work.drive(dir, opts(p));
  const r = p.runs['r-1'];
  assert.equal(r.status, 'done');
  assert.equal(r.tasksDone, 1);
  assert.deepEqual(r.jobs.map((j) => j.role), ['analyst', 'planner', 'tester', 'builder', 'reviewer']);
  assert.deepEqual(r.snapshot.tasks[0].stages, { test: 'ok', build: 'ok', check: 'ok', review: 'ok' });
  assert.equal(r.decisions[0].title, 'Zero');
  assert.equal(r.inputs[0].what, 'keys');
  assert.match(r.report, /pendiente de verificar/);
});

test('what cannot start is reported, not left waiting', async () => {
  const p = pravex({ queued: [{ id: 'r-2', repo: 'a/missing', text: 'x', files: [] }] });
  await work.poll(polling(p, tmp(), { findRepo: () => null }));
  assert.equal(p.runs['r-2'].status, 'failed');
  assert.deepEqual(p.runs['r-2'].reason, { code: 'environment', params: { code: 'repo-missing', detail: 'a/missing' } });
});

test('without a connection the work goes on, and everything is reported when it is back', async () => {
  const root = tmp();
  const p = pravex({ queued: [{ id: 'r-3', repo: 'a/b', text: 'x', files: [] }] });
  let dir;
  await work.poll(polling(p, root, { start: (d) => (dir = d) }));
  p.down = true;
  const r = await work.drive(dir, { ...opts(p), retries: 2 });
  assert.equal(r.status, 'done');
  p.down = false;
  await work.poll(polling(p, root));
  assert.equal(p.runs['r-3'].status, 'done');
  assert.equal(p.runs['r-3'].jobs.length, 5);
  const before = p.calls.length;
  await work.poll(polling(p, root));
  assert.equal(p.calls.length, before + 1, 'nothing is sent twice');
});

test('a run whose process died is started again; one that is paused by a person is not', async () => {
  const root = tmp();
  const p = pravex({ queued: [{ id: 'r-4', repo: 'a/b', text: 'x', files: [] }] });
  let dir;
  await work.poll(polling(p, root, { start: (d) => (dir = d) }));
  const started = [];
  await work.poll(polling(p, root, { start: (d) => started.push(d) }));
  assert.deepEqual(started, [dir]);
  const alive = spawn('sleep', ['30']);
  fs.writeFileSync(path.join(dir, 'lock'), String(alive.pid));
  await work.poll(polling(p, root, { start: (d) => started.push(d) }));
  assert.equal(started.length, 1, 'a living process is left alone');
  alive.kill();
  fs.rmSync(path.join(dir, 'lock'));
  journal.append(dir, { type: 'run.paused', reason: 'stopped' });
  await work.poll(polling(p, root, { start: (d) => started.push(d) }));
  assert.equal(started.length, 1);
});

test('a pause whose cause is over ends by itself', async () => {
  const root = tmp();
  const p = pravex({ queued: [{ id: 'r-5', repo: 'a/b', text: 'x', files: [] }] });
  let dir;
  await work.poll(polling(p, root, { start: (d) => (dir = d) }));
  journal.append(dir, { type: 'run.paused', reason: 'claude-signed-out' });
  const started = [];
  const later = { now: () => Date.now() + 10 * 60e3, start: (d) => started.push(d) };
  await work.poll(polling(p, root, { ...later, signedIn: () => false }));
  assert.equal(started.length, 0);
  await work.poll(polling(p, root, { ...later, signedIn: () => true }));
  assert.equal(started.length, 1);
});

test('what people decide reaches the run: cancel, resume with a higher limit', async () => {
  const root = tmp();
  const p = pravex({ queued: [{ id: 'r-6', repo: 'a/b', text: 'x', maxUsd: 0.25, files: [] }] });
  let dir;
  await work.poll(polling(p, root, { start: (d) => (dir = d) }));
  await work.drive(dir, opts(p));
  assert.equal(p.runs['r-6'].status, 'paused');
  assert.equal(p.runs['r-6'].reason.code, 'budget');
  p.commands = [{ runId: 'r-6', action: 'resume', maxUsd: 9 }];
  const started = [];
  await work.poll(polling(p, root, { start: (d) => started.push(d) }));
  assert.deepEqual(started, [dir]);
  p.commands = [{ runId: 'r-6', action: 'cancel' }];
  await work.poll(polling(p, root));
  assert.equal(p.runs['r-6'].status, 'cancelled');
  // Seen end to end: a run paused and then cancelled was stored with reason "stopped" and a report saying "go on".
  assert.equal(p.runs['r-6'].reason, null);
  assert.match(p.runs['r-6'].report, /^# Cancelada/);
  assert.doesNotMatch(p.runs['r-6'].report, /En pausa/);
  p.commands = [{ runId: 'r-6', action: 'resume' }];
  await work.poll(polling(p, root, { start: (d) => started.push(d) }));
  assert.equal(started.length, 1, 'a cancelled run never comes back');
});

test('a pause asked for while it works stops it within a step and loses nothing', async () => {
  const root = tmp();
  const p = pravex({ queued: [{ id: 'r-7', repo: 'a/b', text: 'x', files: [] }] });
  let dir;
  await work.poll(polling(p, root, { start: (d) => (dir = d) }));
  p.wanted = { action: 'pause' };
  await work.drive(dir, opts(p, { builder: async () => (await new Promise((r) => setTimeout(r, 5000)), { ok: false, error: 'stopped', usd: 0, ms: 1, turns: 0, denied: [] }) }));
  assert.equal(p.runs['r-7'].status, 'paused');
  p.wanted = null;
  await work.drive(dir, opts(p));
  assert.equal(p.runs['r-7'].status, 'done');
});

test('an objection adds a part on top of what is proven', async () => {
  const root = tmp();
  const p = pravex({ queued: [{ id: 'r-8', repo: 'a/b', text: 'x', files: [] }] });
  let dir;
  await work.poll(polling(p, root, { start: (d) => (dir = d) }));
  p.objections = [{ runId: 'r-8', n: 1, title: 'Zero', reason: 'zero must fail' }];
  await work.poll(polling(p, root));
  assert.deepEqual(p.taken, [1]);
  const seen = [];
  await work.drive(dir, opts(p, {
    replanner: (j) => (seen.push(j.prompt), ok({ summary: 'It multiplies, and zero fails.', criteria: [{ id: 'AC-2', text: 'zero fails' }], drop: [], tasks: [{ ...TASK, id: 'T2', title: 'Zero', criteria: ['AC-2'], dependsOn: ['T1'], files: ['zero.js'], tests: ['zero.test.js'] }] })),
    tester: (j) => {
      const f = j.prompt.includes('"id": "T2"') ? 'zero' : 'mul';
      fs.writeFileSync(path.join(j.cwd, `${f}.test.js`), testOf(f, 6));
      return ok({ status: 'DONE', files: [], command: `node --test ${f}.test.js`, covers: [], note: '' });
    },
    builder: (j) => (fs.writeFileSync(path.join(j.cwd, j.prompt.includes('"id": "T2"') ? 'zero.js' : 'mul.js'), 'export const mul = (a, b) => a * b;\n'), ok({ status: 'DONE', summary: '', gaps: [], needs: [] })),
  }));
  const r = p.runs['r-8'];
  assert.equal(r.status, 'done');
  assert.match(seen[0], /zero must fail/);
  assert.deepEqual(r.snapshot.tasks.map((t) => [t.id, t.phase]), [['T1', 'done'], ['T2', 'done']]);
  assert.match(r.report, /objetada y replanteada: zero must fail/);
  // The result says what was built after the objection, not what was planned before it.
  assert.match(r.report, /## Resultado\n\nIt multiplies, and zero fails\./);
  assert.match(seen[0], /it replaces "s"/);
});

test('the pull request is opened by the runner, once, and a failure is written down', () => {
  const { dir } = engine.create({ repoDir: repository(), text: 'multiply', root: tmp() });
  assert.equal(work.openPr(dir).type, 'pr.failed', 'no GitHub remote');
  const repoDir = repository();
  sh(repoDir, 'git', 'remote', 'add', 'origin', 'https://github.com/acme/x.git');
  const made = engine.create({ repoDir, text: 'multiply', root: tmp() });
  const ran = [];
  const run = (cmd, args) => (ran.push([cmd, ...args]), { status: 0, stdout: 'https://github.com/acme/x/pull/7\n', stderr: '' });
  assert.equal(work.openPr(made.dir, { run }).url, 'https://github.com/acme/x/pull/7');
  assert.ok(ran[0].includes('push') && !ran[0].some((a) => /force|^\+|main$/.test(a)));
  assert.equal(work.openPr(made.dir, { run }), null);
  assert.equal(ran.length, 2);
});

test('with credentials from the environment the minute check never writes in the person\'s ~/.pravex', () => {
  const said = [];
  const stored = [];
  const toStderr = work.logOf({ PRAVEX_API_HOST: 'http://127.0.0.1:1', PRAVEX_ACCESS_TOKEN: 't' }, (l) => stored.push(l), (l) => said.push(l));
  toStderr('request x: refused');
  assert.deepStrictEqual(stored, []);
  assert.match(said[0], /request x: refused$/);
  const toFile = work.logOf({}, (l) => stored.push(l), (l) => said.push(l));
  toFile('kept');
  assert.deepStrictEqual(stored, ['kept']);
});
