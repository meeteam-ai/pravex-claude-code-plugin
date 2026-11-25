'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const engine = require('./engine');
const journal = require('./journal');
const machine = require('./machine');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-engine-'));
const sh = (cwd, ...a) => spawnSync(a[0], a.slice(1), { cwd, encoding: 'utf8' });

/** A small repository with a check that works. */
function repository(extra = {}) {
  const dir = tmp();
  const files = { 'package.json': '{"type":"module","scripts":{"test":"node --test"}}', 'sum.js': 'export const sum = (a, b) => a + b;\n', 'sum.test.js': "import t from 'node:test'; import a from 'node:assert'; import { sum } from './sum.js'; t('adds', () => a.equal(sum(1, 2), 3));\n", ...extra };
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  sh(dir, 'git', 'init', '-q', '-b', 'main');
  sh(dir, 'git', 'add', '-A');
  sh(dir, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t.t', 'commit', '-qm', 'init');
  return dir;
}

const ANALYSIS = { build: { ok: true, why: 'it is here' }, verify: { ok: true, why: 'tests' }, summary: 'It multiplies.', criteria: [{ id: 'AC-1', text: 'mul(2,3) is 6' }], decisions: [{ title: 'Zero', decision: 'mul with 0 is 0.', why: 'usual', reversible: true }], missing: [], alternative: '' };
const TASK = { id: 'T1', title: 'Multiply', criteria: ['AC-1'], dependsOn: [], files: ['mul.js'], tests: ['mul.test.js'], risk: 'low', notes: '' };
const MUL_TEST = "import t from 'node:test'; import a from 'node:assert'; t('AC-1 multiplies', async () => { const { mul } = await import('./mul.js'); a.equal(mul(2, 3), 6); });\n";
const GOOD = 'export const mul = (a, b) => a * b;\n';
const BAD = 'export const mul = (a, b) => a + b + 100;\n';
const ok = (value, usd = 0.1) => ({ ok: true, value, usd, ms: 5, turns: 1, denied: [] });
const fail = (error, more = {}) => ({ ok: false, error, usd: 0.01, ms: 5, turns: 0, denied: [], ...more });
const done = { status: 'DONE', summary: '', gaps: [], needs: [] };

/** Agents that answer what a test says. Each role is a function of (attempt, cwd), counting from 1. */
function agents(over = {}) {
  const calls = {};
  const base = {
    analyst: () => ok(ANALYSIS),
    planner: () => ok({ tasks: [TASK] }),
    tester: (n, cwd) => (fs.writeFileSync(path.join(cwd, 'mul.test.js'), MUL_TEST), ok({ status: 'DONE', files: ['mul.test.js'], command: 'node --test mul.test.js', covers: [{ criterion: 'AC-1', test: 'multiplies' }], note: '' })),
    builder: (n, cwd) => (fs.writeFileSync(path.join(cwd, 'mul.js'), GOOD), ok(done)),
    reviewer: () => ok({ verdict: 'APPROVED', fixes: [], gaps: [], notes: ['nice'] }),
    diagnoser: () => ok({ cause: 'it adds', strategy: 'multiply', testsWrong: false }),
    ...over,
  };
  const ask = async (job) => {
    calls[job.role] = (calls[job.role] || 0) + 1;
    ask.prompts.push([job.role, job.prompt]);
    return base[job.role](calls[job.role], job.cwd, job);
  };
  ask.calls = calls;
  ask.prompts = [];
  return ask;
}
const start = (over = {}) => engine.create({ repoDir: repository(), text: 'Add a function that multiplies', root: tmp(), cfg: { checks: ['npm test'] }, ...over });
const go = (dir, ask, opts = {}) => engine.drive(dir, { ask, keepAwake: false, sleep: async () => {}, ...opts });
const types = (dir) => journal.read(dir).map((e) => e.type);

test('a requirement ends as done, with evidence, on its own branch and its own clone', async () => {
  const repoDir = repository();
  const { dir } = engine.create({ repoDir, text: 'Add a function that multiplies', root: tmp(), cfg: { checks: ['npm test'] } });
  const r = await go(dir, agents());
  assert.equal(r.status, 'done');
  const ev = JSON.parse(fs.readFileSync(path.join(dir, 'evidence.json')));
  assert.deepEqual(ev.criteria, [{ id: 'AC-1', text: 'mul(2,3) is 6', ok: true, tests: ['multiplies'], redBefore: true }]);
  assert.equal(ev.tasks[0].evidence.testsIntact, true);
  assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /# Listo/);
  assert.equal(sh(path.join(dir, 'repo'), 'node', '-e', "import('./mul.js').then(m=>console.log(m.mul(4,5)))").stdout.trim(), '20');
  assert.ok(!fs.existsSync(path.join(repoDir, 'mul.js')), "the developer's copy is never touched");
  assert.ok(!fs.existsSync(path.join(dir, 'lock')));
});

test('what cannot be done stops before building and offers what can', async () => {
  const { dir } = start();
  const ask = agents({ analyst: () => ok({ ...ANALYSIS, build: { ok: false, why: 'It charges real cards.' }, alternative: 'Build it in test mode.' }) });
  const r = await go(dir, ask);
  assert.equal(r.status, 'infeasible');
  assert.deepEqual(Object.keys(ask.calls), ['analyst']);
  assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /No se puede[\s\S]*real cards[\s\S]*test mode/);
});

test('a builder that changes the tests, or anything that is not its own, is put back', async () => {
  const { dir } = start();
  const ask = agents({
    builder: (n, cwd) => {
      fs.writeFileSync(path.join(cwd, 'mul.test.js'), "import t from 'node:test'; t('AC-1 multiplies', () => {});\n");
      fs.writeFileSync(path.join(cwd, 'mul.js'), n === 1 ? BAD : GOOD);
      fs.mkdirSync(path.join(cwd, '.github/workflows'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.github/workflows/x.yml'), 'on: push');
      return ok(done);
    },
  });
  const r = await go(dir, ask);
  assert.equal(r.status, 'done');
  assert.equal(fs.readFileSync(path.join(dir, 'repo/mul.test.js'), 'utf8'), MUL_TEST);
  assert.ok(!fs.existsSync(path.join(dir, 'repo/.github')));
  const rules = JSON.parse(fs.readFileSync(path.join(dir, 'evidence.json'))).tasks[0].violations.map((v) => v.rule);
  assert.ok(rules.includes('frozen-test') && rules.includes('protected'));
});

test('a file the task turns out to need is added to it instead of blocking', async () => {
  const { dir } = start();
  const ask = agents({
    builder: (n, cwd) => {
      fs.writeFileSync(path.join(cwd, 'mul.js'), "export { mul } from './impl.js';\n");
      fs.writeFileSync(path.join(cwd, 'impl.js'), GOOD);
      return ok(done);
    },
  });
  assert.equal((await go(dir, ask)).status, 'done');
  assert.deepEqual(journal.read(dir).find((e) => e.type === 'task.widened').files, ['impl.js']);
});

test('skipping a test or silencing an error is never done', async () => {
  const { dir } = start();
  const ask = agents({ builder: (n, cwd) => (fs.writeFileSync(path.join(cwd, 'mul.js'), n < 2 ? `// @ts-ignore\n${GOOD}` : GOOD), ok(done)) });
  assert.equal((await go(dir, ask)).status, 'done');
  assert.equal(journal.read(dir).find((e) => e.type === 'task.checked').failures[0].kind, 'silenced-check');
  assert.equal(ask.calls.builder, 2);
});

test('a failing check goes back with the exact error; stuck twice, someone else looks first', async () => {
  const { dir } = start();
  const ask = agents({ builder: (n, cwd) => (fs.writeFileSync(path.join(cwd, 'mul.js'), n < 3 ? BAD : GOOD), ok(done)) });
  assert.equal((await go(dir, ask)).status, 'done');
  assert.equal(ask.calls.diagnoser, 1);
  const prompts = ask.prompts.filter(([r]) => r === 'builder').map(([, p]) => p);
  assert.match(prompts[1], /node --test mul\.test\.js[\s\S]*(105|AssertionError)/);
  assert.match(prompts[2], /Cause: it adds/);
});

test('a part that never passes is set aside on its own branch and the rest is delivered', async () => {
  const { dir } = start();
  const T2 = { ...TASK, id: 'T2', title: 'Other', files: ['other.js'], tests: ['other.test.js'] };
  const T3 = { ...TASK, id: 'T3', title: 'On top', dependsOn: ['T1'], files: ['top.js'], tests: ['top.test.js'] };
  const ask = agents({
    planner: () => ok({ tasks: [TASK, T2, T3] }),
    tester: (n, cwd, job) => {
      const name = job.prompt.includes('"T2"') ? 'other' : 'mul';
      fs.writeFileSync(path.join(cwd, `${name}.test.js`), MUL_TEST.replaceAll('mul.js', `${name}.js`));
      return ok({ status: 'DONE', files: [], command: `node --test ${name}.test.js`, covers: [], note: '' });
    },
    builder: (n, cwd, job) => (job.prompt.includes('"id": "T2"') ? fs.writeFileSync(path.join(cwd, 'other.js'), GOOD) : fs.writeFileSync(path.join(cwd, 'mul.js'), `${BAD}// ${n}\n`), ok(done)),
  });
  const r = await go(dir, ask);
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.state.tasks.map((t) => [t.id, t.phase, t.blocked && t.blocked.reason]), [['T1', 'blocked', 'checks'], ['T2', 'done', null], ['T3', 'blocked', 'dependency']]);
  assert.ok(!fs.existsSync(path.join(dir, 'repo/mul.js')));
  assert.match(sh(path.join(dir, 'repo'), 'git', 'branch').stdout, /t1-unfinished/);
  assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /Listo en parte[\s\S]*Sus comprobaciones no pasaron/);
});

test('tests that pass before the code exists get one more try, and are marked when they still do', async () => {
  const { dir } = start();
  const ask = agents({ tester: (n, cwd) => (fs.writeFileSync(path.join(cwd, 'mul.test.js'), "import t from 'node:test'; t('AC-1', () => {});\n"), ok({ status: 'DONE', files: [], command: 'node --test mul.test.js', covers: [], note: '' })) });
  await go(dir, ask);
  assert.equal(ask.calls.tester, 2);
  assert.match(ask.prompts.find(([r]) => r === 'reviewer')[1], /WARNING/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'evidence.json'))).criteria[0].redBefore, false);
});

test('a command that is not a plain check is never run', async () => {
  const { dir } = start();
  const mark = path.join(dir, 'pwned');
  const ask = agents({ tester: (n, cwd) => (fs.writeFileSync(path.join(cwd, 'mul.test.js'), MUL_TEST), ok({ status: 'DONE', files: [], command: n === 1 ? `node -e 1; touch ${mark}` : 'npx evil', covers: [], note: '' })) });
  const r = await go(dir, ask);
  assert.equal(r.state.tasks[0].blocked.reason, 'no-tests');
  assert.ok(!fs.existsSync(mark));
});

test('a reviewer sends it back with exact points, and they reach the builder', async () => {
  const { dir } = start();
  const ask = agents({ reviewer: (n) => ok(n === 1 ? { verdict: 'FIX', fixes: [{ file: 'mul.js', problem: 'negative numbers', check: 'mul(-1,2)' }], gaps: ['big numbers'], notes: [] } : { verdict: 'APPROVED', fixes: [], gaps: [], notes: [] }) });
  assert.equal((await go(dir, ask)).status, 'done');
  assert.match(ask.prompts.filter(([r]) => r === 'builder')[1][1], /negative numbers/);
  assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /big numbers/);
});

test("Claude's limit waits for the reset and goes on; the service being down is tried again, then pauses", async () => {
  const a = start();
  const waited = [];
  const ask = agents({ analyst: (n) => (n === 1 ? fail('claude-limit', { resetsAt: Date.now() + 5000 }) : ok(ANALYSIS)) });
  assert.equal((await go(a.dir, ask, { sleep: async (ms) => waited.push(ms) })).status, 'done');
  assert.ok(waited[0] > 60_000);
  const b = start();
  const r = await go(b.dir, agents({ analyst: () => fail('claude-unavailable') }));
  assert.equal(r.status, 'paused');
  assert.equal(r.explain.code, 'claude-unavailable');
  assert.ok(r.explain.todo);
});

test('a missing sign-in pauses with what to do, and resuming goes on from there', async () => {
  const { dir } = start();
  const r = await go(dir, agents({ builder: () => fail('claude-signed-out') }));
  assert.equal(r.explain.code, 'claude-signed-out');
  assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /claude auth login/);
  const ask = agents();
  assert.equal((await go(dir, ask)).status, 'done');
  assert.deepEqual(Object.keys(ask.calls), ['builder', 'reviewer'], 'nothing already done is done again');
});

test('the cost limit pauses; raising it goes on', async () => {
  const { dir } = start({ cfg: { checks: ['npm test'], maxUsd: 0.25 } });
  assert.equal((await go(dir, agents())).explain.code, 'budget');
  assert.equal((await go(dir, agents(), { cfg: { maxUsd: 9 } })).status, 'done');
});

test('a wrong answer is asked again, and then given up without looping', async () => {
  const { dir } = start();
  const ask = agents({ analyst: () => ok({ nonsense: true }) });
  const r = await go(dir, ask);
  assert.equal(r.status, 'failed');
  assert.equal(ask.calls.analyst, 3);
  assert.equal(r.state.reason, 'analyze-failed');
});

test('a plan that loops or leaves the repository is refused, with the reasons', async () => {
  const { dir } = start();
  const ask = agents({ planner: (n) => ok({ tasks: n === 1 ? [{ ...TASK, files: ['../../etc/passwd'] }] : [TASK] }) });
  assert.equal((await go(dir, ask)).status, 'done');
  assert.match(ask.prompts.filter(([r]) => r === 'planner')[1][1], /not a path inside the repository/);
});

test('a check that was already failing is not blamed on the work', async () => {
  const { dir } = start({ repoDir: repository({ 'old.test.js': "import t from 'node:test'; t('old', () => { throw new Error('old'); });\n" }) });
  const r = await go(dir, agents());
  assert.equal(r.status, 'done');
  assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /ya fallaban antes de empezar: `npm test`/);
});

test('a working copy whose git folder is gone pauses, and never reaches the repository around it', async () => {
  const around = repository();
  const { dir } = start({ root: path.join(around, 'builds') });
  const before = sh(around, 'git', 'rev-parse', 'HEAD').stdout;
  const r = await go(dir, agents({ builder: (n, cwd) => (fs.rmSync(path.join(cwd, '.git'), { recursive: true, force: true }), ok(done)) }));
  assert.equal(r.status, 'paused');
  assert.equal(r.explain.code, 'git-lost');
  assert.equal(sh(around, 'git', 'rev-parse', 'HEAD').stdout, before);
  assert.ok(fs.existsSync(path.join(around, 'sum.js')));
});

test('git settings an agent plants are put back before git obeys them', async () => {
  const { dir } = start();
  const mark = path.join(dir, 'pwned');
  const ask = agents({
    builder: (n, cwd) => {
      fs.writeFileSync(path.join(cwd, 'mul.js'), GOOD);
      fs.appendFileSync(path.join(cwd, '.git/config'), `[core]\n\tfsmonitor = touch ${mark}\n[filter "x"]\n\tclean = touch ${mark}\n\tsmudge = touch ${mark}\n`);
      fs.writeFileSync(path.join(cwd, '.git/info/attributes'), '* filter=x\n');
      fs.mkdirSync(path.join(cwd, '.git/hooks'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.git/hooks/pre-commit'), `#!/bin/sh\ntouch ${mark}\n`, { mode: 0o755 });
      return ok(done);
    },
  });
  assert.equal((await go(dir, ask)).status, 'done');
  assert.ok(!fs.existsSync(mark));
});

test('two processes never run the same build', async () => {
  const { dir } = start();
  const other = spawn('sleep', ['30']);
  fs.writeFileSync(path.join(dir, 'lock'), String(other.pid));
  await assert.rejects(go(dir, agents()), { code: 'already-running' });
  other.kill();
  await new Promise((r) => other.on('exit', r));
  assert.equal((await go(dir, agents())).status, 'done', 'a lock whose process is gone is nobody’s');
});

test('stopping works without a connection, and nothing is lost', async () => {
  const { dir } = start();
  const ask = agents({ builder: async (n, cwd, job) => (engine.stop(dir), await new Promise((r) => setTimeout(r, 1500)), fail('stopped')) });
  const r = await go(dir, ask);
  assert.equal(r.explain.code, 'stopped');
  assert.equal((await go(dir, agents())).status, 'done');
});

test('killed at any moment, it starts again and reaches the same end', async () => {
  const worker = path.join(tmp(), 'child.js');
  fs.writeFileSync(
    worker,
    `const engine=require(${JSON.stringify(path.join(__dirname, 'engine.js'))}),fs=require('fs'),path=require('path');
     const ok=value=>({ok:true,value,usd:.1,ms:5,turns:1,denied:[]});const wait=()=>new Promise(r=>setTimeout(r,30));
     const A=${JSON.stringify(ANALYSIS)},T=${JSON.stringify(TASK)},MT=${JSON.stringify(MUL_TEST)},G=${JSON.stringify(GOOD)};
     const ask=async j=>{await wait();const w=(f,c)=>fs.writeFileSync(path.join(j.cwd,f),c);
      if(j.role==='tester')w('mul.test.js',MT);if(j.role==='builder')w('mul.js',G);await wait();
      return ok({analyst:A,planner:{tasks:[T]},tester:{status:'DONE',files:[],command:'node --test mul.test.js',covers:[],note:''},builder:{status:'DONE',summary:'',gaps:[],needs:[]},reviewer:{verdict:'APPROVED',fixes:[],gaps:[],notes:[]}}[j.role])};
     engine.drive(process.argv[2],{ask,keepAwake:false}).then(r=>{if(r.status!=='done')console.error(r.status,JSON.stringify(r.explain),JSON.stringify(r.state.tasks));process.exit(r.status==='done'?0:9)});`
  );
  const { dir } = start();
  let kills = 0;
  let code = null;
  for (let i = 0; i < 25 && code !== 0; i++) {
    const c = spawn('node', [worker, dir], { stdio: ['ignore', 'ignore', 'inherit'] });
    const t = setTimeout(() => c.kill('SIGKILL'), i < 12 ? 120 + i * 55 : 60_000);
    code = await new Promise((r) => c.on('exit', (x, sig) => r(sig ? null : x)));
    clearTimeout(t);
    if (code === null) kills++;
  }
  assert.equal(code, 0);
  assert.ok(kills >= 3, `killed ${kills} times`);
  const s = machine.fold(journal.read(dir));
  assert.equal(s.final, 'done');
  assert.equal(types(dir).filter((t) => t === 'run.finished').length, 1);
  assert.equal(sh(path.join(dir, 'repo'), 'git', 'status', '--porcelain').stdout, '');
});

test('every reason a run or a part can end with has words for a person', () => {
  const src = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8') + fs.readFileSync(path.join(__dirname, 'machine.js'), 'utf8');
  const { MESSAGES } = require('./messages');
  const used = new Set([...src.matchAll(/(?:pause\(|reason: |end\()'([a-z-]+)'/g)].map((m) => m[1]));
  for (const code of ['claude-signed-out', 'claude-missing', 'claude-old', 'sandbox-unavailable', 'install-failed', 'tool-missing', 'engine-error']) used.add(code);
  for (const code of used) for (const lang of ['es', 'en']) assert.equal((MESSAGES[code] || {})[lang]?.length, 3, `${code} (${lang})`);
});

test('a commit the journal never heard of is not part of the work', async () => {
  const { dir } = start();
  await assert.rejects(
    go(dir, agents({ tester: (n, cwd) => (fs.writeFileSync(path.join(cwd, 'mul.test.js'), MUL_TEST), ok({ status: 'DONE', files: [], command: 'node --test mul.test.js', covers: [], note: '' })) }), {
      onEvent: () => {},
      // The process "dies" after the tests are committed and before the journal says so.
      log: (what) => {
        if (what === 'T1 tester') throw new Error('crash');
      },
    }).then((r) => {
      if (r.status !== 'done') throw new Error(r.status);
    })
  );
  const repo = path.join(dir, 'repo');
  fs.writeFileSync(path.join(repo, 'mul.test.js'), MUL_TEST);
  sh(repo, 'git', 'add', '-A');
  sh(repo, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t.t', 'commit', '-qm', 'unknown to the journal');
  const { dir: fresh } = start();
  const r2 = path.join(fresh, 'repo');
  fs.writeFileSync(path.join(r2, 'mul.test.js'), MUL_TEST);
  sh(r2, 'git', 'add', '-A');
  sh(r2, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t.t', 'commit', '-qm', 'unknown to the journal');
  const r = await go(fresh, agents());
  assert.equal(r.status, 'done');
  assert.doesNotMatch(sh(r2, 'git', 'log', '--format=%s').stdout, /unknown/);
});
