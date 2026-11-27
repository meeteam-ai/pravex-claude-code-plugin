'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const engine = require('./engine');
const journal = require('./journal');
const readiness = require('./readiness');
const { project } = require('./snapshot');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-ready-'));
const sh = (cwd, ...a) => spawnSync(a[0], a.slice(1), { cwd, encoding: 'utf8' });
const commitAll = (dir, m) => (sh(dir, 'git', 'add', '-A'), sh(dir, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t.t', 'commit', '-qm', m));

function repository(extra = {}) {
  const dir = tmp();
  const files = { 'package.json': '{"type":"module","scripts":{"test":"node --test"}}', 'sum.js': 'export const sum = (a, b) => a + b;\n', 'sum.test.js': "import t from 'node:test'; import a from 'node:assert'; import { sum } from './sum.js'; t('adds', () => a.equal(sum(1, 2), 3));\n", ...extra };
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  sh(dir, 'git', 'init', '-q', '-b', 'main');
  commitAll(dir, 'init');
  return dir;
}

/** A test file that, like a real e2e setup, stops before testing anything when its database variable is not set. */
const NEEDS = "if (!process.env.NEEDED_VAR) throw new Error('Falta NEEDED_VAR');\nimport t from 'node:test'; t('db', () => {});\n";
const ANALYSIS = { build: { ok: true, why: 'here' }, verify: { ok: true, why: 'tests' }, summary: 'It multiplies.', criteria: [{ id: 'AC-1', text: 'mul(2,3) is 6' }], decisions: [], missing: [], alternative: '' };
const TASK = { id: 'T1', title: 'Multiply', criteria: ['AC-1'], dependsOn: [], files: ['mul.js'], tests: ['mul.test.js'], risk: 'low', notes: '' };
const MUL_TEST = "import t from 'node:test'; import a from 'node:assert'; t('AC-1 multiplies', async () => { const { mul } = await import('./mul.js'); a.equal(mul(2, 3), 6); });\n";
const GOOD = 'export const mul = (a, b) => a * b;\n';
const ok = (value) => ({ ok: true, value, usd: 0.1, ms: 5, turns: 1, denied: [] });
const done = { status: 'DONE', summary: '', gaps: [], needs: [] };

function agents(over = {}) {
  const calls = {};
  const base = {
    analyst: () => ok(ANALYSIS),
    planner: () => ok({ tasks: [TASK] }),
    tester: (n, cwd) => (fs.writeFileSync(path.join(cwd, 'mul.test.js'), MUL_TEST), ok({ status: 'DONE', files: ['mul.test.js'], command: 'node --test mul.test.js', covers: [{ criterion: 'AC-1', test: 'multiplies' }], note: '' })),
    builder: (n, cwd) => (fs.writeFileSync(path.join(cwd, 'mul.js'), GOOD), ok(done)),
    reviewer: () => ok({ verdict: 'APPROVED', fixes: [], gaps: [], notes: [] }),
    diagnoser: () => ok({ cause: 'it adds', strategy: 'multiply', testsWrong: false }),
    ...over,
  };
  const ask = async (job) => {
    calls[job.role] = (calls[job.role] || 0) + 1;
    return base[job.role](calls[job.role], job.cwd, job);
  };
  ask.calls = calls;
  return ask;
}
const go = (dir, ask, opts = {}) => engine.drive(dir, { ask, keepAwake: false, sleep: async () => {}, ...opts });
const types = (dir) => journal.read(dir).map((e) => e.type);
const setup = (extra, checks = ['npm test']) => {
  const repoDir = repository(extra);
  const envFile = path.join(tmp(), 'machine.env');
  const { dir } = engine.create({ repoDir, text: 'Add a function that multiplies', root: tmp(), cfg: { checks } });
  return { repoDir, dir, envFile };
};

// --- telling "could not run" from "failed" ---------------------------------------------------------------------------

test('output that never got to test anything is told apart from a real failure', () => {
  const vitest = ['RUN  v3.2.7 /x/apps/api', ' ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command failed', 'No test files found, exiting with code 1', '⎯⎯⎯ Unhandled Error ⎯⎯⎯', 'Error: Falta TEST_DATABASE_URL', ' ❯ loadTestEnv test/load-env.ts:16:45', "15|   if (!process.env.TEST_DATABASE_URL) throw new Error('Falta TEST_DATA…"].join('\n');
  assert.deepEqual(readiness.envProblem(vitest), { line: 'Error: Falta TEST_DATABASE_URL', missing: 'TEST_DATABASE_URL' });
  assert.equal(readiness.envProblem('connect ECONNREFUSED 127.0.0.1:5432').line, 'connect ECONNREFUSED 127.0.0.1:5432');
  assert.equal(readiness.envProblem('STRIPE_KEY is not set').missing, 'STRIPE_KEY');
  assert.match(readiness.envProblem('No test files found, exiting with code 1').line, /No test files/);
  // A validated configuration that refuses to start (napa's API under Playwright, 2026-11-27): every variable, at once.
  const zod = ['Error: Process from config.webServer was not able to start. Exit code: 1', '[WebServer] Error: Variables de entorno inválidas:', '[WebServer]   SESSION_SECRET: Invalid input: expected string, received undefined', '[WebServer]   S3_BUCKET: Invalid input: expected string, received undefined', '[WebServer]   SESSION_SECRET: Invalid input: expected string, received undefined'].join('\n');
  assert.equal(readiness.envProblem(zod).missing, 'SESSION_SECRET, S3_BUCKET');
  assert.equal(readiness.envProblem('ZodError\n  API_KEY: Required').missing, 'API_KEY');
  assert.match(readiness.envProblem('Error: Process from config.webServer was not able to start. Exit code: 1').line, /webServer/);
  // A real failure, and a test that imports what the work has not written yet, are work for an agent.
  assert.equal(readiness.envProblem('FAIL a.test.ts > adds\nAssertionError: expected 2 to be 3'), null);
  assert.equal(readiness.envProblem("Error: Cannot find module './plan-summary'"), null);
  assert.equal(readiness.envProblem(''), null);
  // The same problem with other numbers or paths is the same problem.
  assert.equal(readiness.problemFp('c', { line: 'x /a/b:12' }), readiness.problemFp('c', { line: 'x /c/d:99' }));
});

test('the machine file, the project file and the setup commands are read carefully', () => {
  assert.deepEqual(readiness.parseEnv('# c\nexport A=1\nB = "two words"\nC=\'3\'\nnot a line\n9X=no'), { A: '1', B: 'two words', C: '3' });
  assert.equal(readiness.repoKey('https://github.com/meeteam-ai/napa.git'), 'meeteam-ai__napa');
  assert.equal(readiness.repoKey('git@github.com:meeteam-ai/napa.git'), 'meeteam-ai__napa');
  assert.equal(readiness.repoKey('', '/x/my repo'), 'my_repo');
  const file = path.join(tmp(), 'm.env');
  fs.writeFileSync(file, 'A=1\nEXTRA=2\n');
  assert.deepEqual(readiness.checkEnv({ file, names: ['A', 'B'], base: { B: 'from-shell' } }), { env: { A: '1', EXTRA: '2', B: 'from-shell' }, missing: [], file, names: ['A', 'EXTRA', 'B'] });
  assert.deepEqual(readiness.checkEnv({ file, names: ['A', 'Z'], base: {} }).missing, ['Z']);
  assert.deepEqual(readiness.checkEnv({ file, base: {} }).env, { A: '1', EXTRA: '2' }, 'without names, what a person put in the file');
  const programs = new Set(['pnpm']);
  assert.ok(readiness.setupAllowed('docker compose up -d db', programs));
  assert.ok(readiness.setupAllowed('pnpm db:migrate', programs));
  for (const bad of ['pnpm publish', 'docker push img', 'rm -rf x', 'pnpm x && curl y', 'docker run -v /:/h img', 'curl http://x']) assert.ok(!readiness.setupAllowed(bad, programs), bad);
  const repo = repository({ '.pravex/project.json': JSON.stringify({ checks: ['npm test', 3], setup: ['docker compose up -d'], env: ['TEST_DATABASE_URL', 'bad name'] }) });
  assert.deepEqual(readiness.projectConfig(repo), { checks: ['npm test'], setup: ['docker compose up -d'], env: ['TEST_DATABASE_URL'] });
  assert.match(readiness.fixRequirement({ command: 'pnpm test', line: 'Error: Falta X', missing: 'X' }), /`pnpm test`[\s\S]*Falta X[\s\S]*Necesita X[\s\S]*No pongas secretos/);
});

// --- the engine ------------------------------------------------------------------------------------------------------

test('checks that cannot run stop the run before any agent spends, and say what is missing and where it goes', async () => {
  const { dir, envFile } = setup({ 'needs.test.js': NEEDS });
  const ask = agents();
  const r = await go(dir, ask, { envFile });
  assert.equal(r.status, 'paused');
  assert.deepEqual(ask.calls, {}, 'no agent ran');
  const p = project(journal.read(dir));
  assert.equal(p.status, 'paused');
  assert.equal(p.reason.code, 'checks-cannot-run');
  assert.equal(p.reason.params.missing, 'NEEDED_VAR');
  assert.equal(p.reason.params.command, 'npm test');
  assert.match(p.reason.params.line, /Falta NEEDED_VAR/);
  assert.match(p.reason.params.envFile, /^~\/\.pravex\/env\/.+\.env$/);
  assert.match(p.reason.params.request, /`npm test`[\s\S]*NEEDED_VAR/);
  assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /Las pruebas no pueden correr[\s\S]*NEEDED_VAR[\s\S]*\.pravex\/env/);

  // A person sets the value on the machine and resumes: it is checked again and the run goes to the end.
  fs.writeFileSync(envFile, 'NEEDED_VAR=1\n');
  const again = await go(dir, ask, { envFile });
  assert.equal(again.status, 'done');
  assert.ok(types(dir).includes('prepare.reset'));
  assert.ok(journal.read(dir).filter((e) => e.type === 'run.prepared').pop().checks.every((c) => c.ok));
});

test('resumed without fixing it, the run goes on without those checks and says so', async () => {
  const { dir, envFile } = setup({ 'needs.test.js': NEEDS });
  const ask = agents();
  assert.equal((await go(dir, ask, { envFile })).status, 'paused');
  const r = await go(dir, ask, { envFile });
  assert.equal(r.status, 'done');
  const prepared = journal.read(dir).filter((e) => e.type === 'run.prepared').pop();
  assert.deepEqual(prepared.checks.map((c) => [c.command, c.ok, c.why]), [['npm test', false, 'environment']]);
  assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /ya fallaban antes de empezar: `npm test`/);
});

test('a variable the project says it needs, and this machine lacks, is asked for before anything runs', async () => {
  const { dir, envFile } = setup({ '.pravex/project.json': JSON.stringify({ env: ['NEEDED_VAR'] }) });
  const r = await go(dir, agents(), { envFile });
  assert.equal(r.status, 'paused');
  const p = project(journal.read(dir));
  assert.equal(p.reason.params.missing, 'NEEDED_VAR');
  assert.equal(p.reason.params.line, 'Falta NEEDED_VAR en esta máquina');
  assert.ok(!types(dir).includes('check.finished'), 'not even a check ran');
  fs.writeFileSync(envFile, 'NEEDED_VAR=x\nOTHER=y\n');
  assert.equal((await go(dir, agents(), { envFile })).status, 'done');
});

test('acceptance tests that fail only because they cannot run are not "red": it stops instead of building', async () => {
  const { dir, envFile } = setup({});
  const needy = "if (!process.env.MUL_DB) throw new Error('Falta MUL_DB');\n" + MUL_TEST;
  const ask = agents({ tester: (n, cwd) => (fs.writeFileSync(path.join(cwd, 'mul.test.js'), needy), ok({ status: 'DONE', files: ['mul.test.js'], command: 'node --test mul.test.js', covers: [{ criterion: 'AC-1', test: 'multiplies' }], note: '' })) });
  assert.equal((await go(dir, ask, { envFile })).status, 'paused');
  assert.equal(ask.calls.builder, undefined, 'nothing was built on tests that never ran');
  const p = project(journal.read(dir));
  assert.equal(p.reason.params.task, 'T1');
  assert.equal(p.reason.params.missing, 'MUL_DB');
  fs.writeFileSync(envFile, 'MUL_DB=1\n');
  assert.equal((await go(dir, ask, { envFile })).status, 'done');
  assert.equal(ask.calls.tester, 2, 'the part started over from its tests');
});

test('checks that stop running after the build pause the run at once, without more rounds', async () => {
  const { dir, envFile } = setup({});
  const needy = "if (!process.env.MUL_DB) throw new Error('Falta MUL_DB');\n" + GOOD;
  const ask = agents({ builder: (n, cwd) => (fs.writeFileSync(path.join(cwd, 'mul.js'), needy), ok(done)) });
  assert.equal((await go(dir, ask, { envFile })).status, 'paused');
  assert.equal(ask.calls.builder, 1);
  assert.equal(ask.calls.diagnoser, undefined);
  const blocked = journal.read(dir).find((e) => e.type === 'env.blocked');
  assert.equal(blocked.task, 'T1');
  assert.match(blocked.branch, /-t1-before-setup$/, 'what it built is kept on a branch');
  // Resumed without fixing: that part is set aside and the run ends saying why, never "something unexpected".
  const r = await go(dir, ask, { envFile });
  assert.equal(r.status, 'failed');
  const p = project(journal.read(dir));
  assert.equal(p.reason.code, 'checks-cannot-run');
  assert.equal(p.reason.params.task, 'T1');
});

test('a diagnosis that finds the cause in this copy stops the run instead of building again', async () => {
  const { dir, envFile } = setup({});
  const BAD = 'export const mul = (a, b) => a + b + 100;\n';
  const ask = agents({
    builder: (n, cwd) => (fs.writeFileSync(path.join(cwd, 'mul.js'), BAD), ok(done)),
    diagnoser: () => ok({ cause: 'Falta REDIS_URL: the test setup cannot reach Redis in this copy.', strategy: 'set it', testsWrong: false, kind: 'environment' }),
  });
  assert.equal((await go(dir, ask, { envFile })).status, 'paused');
  assert.equal(ask.calls.diagnoser, 1);
  assert.equal(ask.calls.builder, 2, 'no build after the diagnosis');
  const p = project(journal.read(dir));
  assert.equal(p.reason.code, 'checks-cannot-run');
  assert.equal(p.reason.params.missing, 'REDIS_URL');
});

test('what was fixed on the main branch meanwhile is taken in when it resumes', async () => {
  const { repoDir, dir, envFile } = setup({ 'needs.test.js': NEEDS });
  assert.equal((await go(dir, agents(), { envFile })).status, 'paused');
  // Someone merges a fix (here: the test no longer needs the variable) into the developer's main branch.
  fs.writeFileSync(path.join(repoDir, 'needs.test.js'), "import t from 'node:test'; t('db', () => {});\n");
  commitAll(repoDir, 'fix: the tests run without the variable');
  const r = await go(dir, agents(), { envFile });
  assert.equal(r.status, 'done');
  const rebased = journal.read(dir).find((e) => e.type === 'run.rebased');
  assert.equal(rebased.how, 'reset');
  assert.equal(rebased.sha, sh(repoDir, 'git', 'rev-parse', 'HEAD').stdout.trim());
  assert.ok(journal.read(dir).filter((e) => e.type === 'run.prepared').pop().checks.every((c) => c.ok));
});

test('a run whose parts were all set aside says why, instead of leaving the reason empty', async () => {
  const { dir, envFile } = setup({});
  const BAD = 'export const mul = (a, b) => a + b + 100;\n';
  const ask = agents({ builder: (n, cwd) => (fs.writeFileSync(path.join(cwd, 'mul.js'), BAD), ok(done)) });
  assert.equal((await go(dir, ask, { envFile })).status, 'failed');
  const p = project(journal.read(dir));
  assert.deepEqual([p.reason.code, p.reason.params.task], ['checks', 'T1']);
});

// --- preparing by itself ---------------------------------------------------------------------------------------------

test('what is not a secret is filled without asking; somebody else\'s keys never are', () => {
  for (const n of ['SESSION_SECRET', 'QR_TOKEN_SECRET', 'IP_HASH_SALT', 'S3_ACCESS_KEY', 'SUPERADMIN_PASSWORD', 'JWT_SIGNING_KEY']) {
    const v = readiness.fillValue(n);
    assert.equal(v.how, 'generated', n);
    assert.match(v.value, /^[0-9a-f]{48}$/);
  }
  assert.notEqual(readiness.fillValue('SESSION_SECRET').value, readiness.fillValue('SESSION_SECRET').value, 'random each time');
  assert.deepEqual(readiness.fillValue('S3_ENDPOINT'), { value: 'http://localhost:9000', how: 'placeholder' });
  assert.deepEqual(readiness.fillValue('S3_BUCKET'), { value: 'pravex-test', how: 'placeholder' });
  assert.deepEqual(readiness.fillValue('EMAIL_FROM'), { value: 'pruebas@pravex.invalid', how: 'placeholder' });
  assert.deepEqual(readiness.fillValue('TEST_DATABASE_URL', 'postgresql://napa:napa@localhost:55432/napa_test'), { value: 'postgresql://napa:napa@localhost:55432/napa_test', how: 'example' });
  for (const n of ['STRIPE_SECRET_KEY', 'APPLE_PASS_KEY_PEM', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'AWS_SECRET_ACCESS_KEY', 'SMTP_URL', 'OPENAI_API_KEY', 'NODE_ENV', 'REDIS_URL']) assert.equal(readiness.fillValue(n), null, n);
  assert.equal(readiness.fillValue('DATABASE_URL', 'postgres://u:p@db.example.com/x'), null, 'an address that is not this machine is not copied');

  const file = path.join(tmp(), 'env', 'm.env');
  assert.deepEqual(readiness.writeMachineEnv(file, [{ name: 'A', value: '1' }, { name: 'bad name', value: 'x' }, { name: 'B', value: 'two\nlines' }]), ['A']);
  assert.deepEqual(readiness.writeMachineEnv(file, [{ name: 'A', value: 'other' }, { name: 'C', value: '3' }]), ['C'], 'never over a value already there');
  assert.deepEqual(readiness.parseEnv(fs.readFileSync(file, 'utf8')), { A: '1', C: '3' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(file, 'utf8'), /# Puesto por Pravex .* nunca secretos reales/);

  const repo = repository({ 'docker-compose.yml': 'services:\n  api:\n    build: .\n  db:\n    image: postgres:16-alpine\n  cache:\n    image: "redis:7"\n  s3:\n    image: chrislusf/seaweedfs:latest\nvolumes:\n  data:\n', '.env.example': 'A=1\nSECRET=\n' });
  assert.deepEqual(readiness.composeServices(repo), { file: 'docker-compose.yml', services: ['db', 'cache', 's3'] });
  assert.equal(readiness.composeServices(repository()), null);
  assert.deepEqual(readiness.readExample(repo), { A: '1', SECRET: '' });
});

const NEEDS_SECRET = "if (!process.env.APP_SESSION_SECRET || !process.env.APP_DB_URL) { console.error('Error: Variables de entorno inválidas:\\n  APP_SESSION_SECRET: Invalid input: expected string, received undefined\\n  APP_DB_URL: Invalid input: expected string, received undefined'); process.exit(1); }\nimport t from 'node:test'; t('app', () => {});\n";

test('checks that only miss what Pravex can prepare go on by themselves, and the machine keeps it for next time', async () => {
  const { dir, envFile } = setup({ 'app.test.js': NEEDS_SECRET, '.env.example': 'APP_DB_URL=postgres://app:app@localhost:5432/app_test\nAPP_SESSION_SECRET=change-me\n' });
  const ask = agents();
  const r = await go(dir, ask, { envFile });
  assert.equal(r.status, 'done', 'no pause: nothing here needed a person');
  const prepared = journal.read(dir).find((e) => e.type === 'env.prepared');
  assert.deepEqual(prepared.names, [{ name: 'APP_SESSION_SECRET', how: 'generated' }, { name: 'APP_DB_URL', how: 'example' }]);
  assert.ok(!types(dir).includes('env.blocked'));
  const kept = readiness.parseEnv(fs.readFileSync(envFile, 'utf8'));
  assert.match(kept.APP_SESSION_SECRET, /^[0-9a-f]{48}$/);
  assert.equal(kept.APP_DB_URL, 'postgres://app:app@localhost:5432/app_test');
  assert.ok(!JSON.stringify(journal.read(dir)).includes(kept.APP_SESSION_SECRET), 'the value is never in the journal, so never sent to Pravex');
  assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /Preparé solo[\s\S]*`APP_SESSION_SECRET` \(generado\)[\s\S]*`APP_DB_URL` \(del ejemplo\)/);
});

test('somebody else\'s key still stops the run, after preparing the rest, and says only what is left', async () => {
  const needy = "if (!process.env.APP_SESSION_SECRET || !process.env.STRIPE_SECRET_KEY) { console.error('Error: Variables de entorno inválidas:\\n  APP_SESSION_SECRET: Invalid input: expected string, received undefined\\n  STRIPE_SECRET_KEY: Invalid input: expected string, received undefined'); process.exit(1); }\nimport t from 'node:test'; t('app', () => {});\n";
  const { dir, envFile } = setup({ 'app.test.js': needy });
  assert.equal((await go(dir, agents(), { envFile })).status, 'paused');
  const p = project(journal.read(dir));
  assert.equal(p.reason.code, 'checks-cannot-run');
  assert.equal(p.reason.params.missing, 'STRIPE_SECRET_KEY');
  assert.deepEqual(p.reason.params.prepared, ['APP_SESSION_SECRET']);
  assert.ok(readiness.parseEnv(fs.readFileSync(envFile, 'utf8')).APP_SESSION_SECRET);
});

test('acceptance tests that cannot run for want of a generated value are prepared and run again, without a pause', async () => {
  const { dir, envFile } = setup({});
  const needy = "if (!process.env.MUL_SECRET) { console.error('MUL_SECRET: Required'); process.exit(1); }\n" + MUL_TEST;
  const ask = agents({ tester: (n, cwd) => (fs.writeFileSync(path.join(cwd, 'mul.test.js'), needy), ok({ status: 'DONE', files: ['mul.test.js'], command: 'node --test mul.test.js', covers: [{ criterion: 'AC-1', test: 'multiplies' }], note: '' })) });
  assert.equal((await go(dir, ask, { envFile })).status, 'done');
  assert.equal(ask.calls.tester, 1);
  assert.equal(ask.calls.builder, 1);
  const red = journal.read(dir).find((e) => e.type === 'task.red');
  assert.equal(red.redBefore, true, 'red for a real reason once it could run');
  const history = project(journal.read(dir)).snapshot.tasks[0].history.map((h) => h.kind);
  assert.ok(history.includes('prepare'));
});

test('preparing by itself can be turned off for a run', async () => {
  const { dir, envFile } = setup({ 'app.test.js': NEEDS_SECRET });
  const { dir: d2 } = { dir };
  const r = await engine.drive(d2, { ask: agents(), keepAwake: false, sleep: async () => {}, envFile, cfg: { autoPrepare: false } });
  assert.equal(r.status, 'paused');
  assert.ok(!types(dir).includes('env.prepared'));
});
