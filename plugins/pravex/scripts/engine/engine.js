'use strict';
/**
 * Runs a build: reads the journal, does the one thing the state asks for, writes what happened, and goes on. Nothing is
 * kept in memory that the journal and git do not have, so it can stop anywhere and start again.
 *
 *   ~/.pravex-builds/<id>/   events.jsonl  the journal        repo/       its own clone, never the developer's copy
 *                            report.md     what was done      evidence.json  what proves it
 *                            STOP          asks it to stop     lock        the process that has it
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const journal = require('./journal');
const machine = require('./machine');
const integrity = require('./integrity');
const { fingerprint, tail } = require('./fingerprint');
const { check, allowed } = require('./checks');
const { matches, clean } = require('./globs');
const { run, cleanEnv } = require('./proc');
const worker = require('./worker');
const prompts = require('./prompts');
const schemas = require('./schemas');
const { report, explain } = require('./report');

// Outside ~/.pravex, which holds the sign-in and no agent may read.
const BUILDS = path.join(os.homedir(), '.pravex-builds');
const INPUTS = '.pravex-inputs';

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

const GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'diff.external=', '-c', 'commit.gpgsign=false', '-c', 'core.quotepath=off', '-c', 'gc.auto=0'];
/** In a run's own clone git never looks above it: with the clone's `.git` gone, a reset must fail, not hit another repository. */
function git(cwd, args, { allowFail = false, above = false } = {}) {
  const env = { ...process.env, ...(above ? {} : { GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(cwd)) }) };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  const r = spawnSync('git', [...GIT, ...args], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
  if (r.status !== 0 && !allowFail) throw Object.assign(new Error(`git ${args[0]}: ${(r.stderr || r.error?.message || '').trim().slice(-400)}`), { code: 'git-failed' });
  return r.status === 0 ? r.stdout : '';
}
/**
 * What git itself would obey is never an agent's to change: after every agent that can write, the clone's own
 * configuration is put back as it was made, before git is asked anything.
 */
function guardGit(dir, repo) {
  const dot = path.join(repo, '.git');
  if (!fs.existsSync(dot) || !fs.lstatSync(dot).isDirectory()) throw Object.assign(new Error('the working copy lost its git folder'), { code: 'git-lost' });
  const kept = path.join(dir, 'git-config');
  if (!fs.existsSync(kept)) fs.copyFileSync(path.join(dot, 'config'), kept);
  else if (!fs.existsSync(path.join(dot, 'config')) || fs.readFileSync(kept, 'utf8') !== fs.readFileSync(path.join(dot, 'config'), 'utf8')) fs.copyFileSync(kept, path.join(dot, 'config'));
  for (const f of ['config.worktree', 'info/attributes', 'info/grafts', 'objects/info/alternates']) fs.rmSync(path.join(dot, f), { force: true });
}
const head = (repo) => git(repo, ['rev-parse', 'HEAD']).trim();

/** Every path that differs from the last commit, new files one by one. */
function changedFiles(repo) {
  const out = [];
  const parts = git(repo, ['status', '--porcelain', '-z', '-uall', '--no-renames']).split('\0');
  for (const p of parts) if (p.length > 3) out.push({ state: p.slice(0, 2), file: p.slice(3) });
  return out;
}

/** Puts paths back as the last commit has them; a file that is new goes away. */
function putBack(repo, files) {
  for (const f of files) {
    const known = git(repo, ['ls-files', '--error-unmatch', '--', f], { allowFail: true });
    if (known) git(repo, ['checkout', '-q', 'HEAD', '--', f], { allowFail: true });
    else if (path.resolve(repo, f).startsWith(`${path.resolve(repo)}${path.sep}`)) fs.rmSync(path.join(repo, f), { force: true });
  }
}

function commit(repo, files, message) {
  if (!files.length) return head(repo);
  git(repo, ['add', '-A', '--', ...files]);
  if (git(repo, ['diff', '--cached', '--name-only']).trim()) git(repo, ['-c', 'user.name=Pravex', '-c', 'user.email=build@pravex.invalid', 'commit', '-q', '--no-verify', '-m', message]);
  return head(repo);
}

/** Back to a commit with nothing left over, keeping what git ignores (installed packages). */
function resetTo(repo, sha) {
  git(repo, ['reset', '-q', '--hard', sha]);
  git(repo, ['clean', '-fdq', '-e', INPUTS]);
}

// ---------------------------------------------------------------------------
// Creating a run
// ---------------------------------------------------------------------------

const slugOf = (text) => String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'build';

/** The branch new work starts from: what the remote's default branch was when it was last fetched, or HEAD. */
function baseOf(repoDir, wanted) {
  const candidates = wanted ? [wanted, `refs/remotes/origin/${wanted}`, `refs/heads/${wanted}`] : [git(repoDir, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], { allowFail: true }).trim(), 'refs/remotes/origin/main', 'refs/remotes/origin/master', 'HEAD'];
  for (const c of candidates.filter(Boolean)) {
    const sha = git(repoDir, ['rev-parse', '--verify', '-q', `${c}^{commit}`], { allowFail: true }).trim();
    if (sha) return { ref: c, sha };
  }
  throw Object.assign(new Error('this repository has no commits yet'), { code: 'no-commits' });
}

/** A folder for the run with its own clone, and the first line of its journal. */
function create({ repoDir, text, files = [], base, locale = 'es', cfg = {}, id, root = BUILDS }) {
  if (!String(text || '').trim()) throw Object.assign(new Error('the requirement is empty'), { code: 'requirement-empty' });
  const top = git(repoDir, ['rev-parse', '--show-toplevel'], { allowFail: true, above: true }).trim();
  if (!top) throw Object.assign(new Error(`${repoDir} is not a git repository`), { code: 'not-a-repository' });
  const from = baseOf(top, base);
  const runId = id || `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${slugOf(text)}-${crypto.randomBytes(2).toString('hex')}`;
  const dir = path.join(root, runId);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true, mode: 0o700 });
  git(repo, ['init', '-q']);
  git(repo, ['fetch', '-q', '--no-tags', top, `+${from.ref === 'HEAD' ? 'HEAD' : from.ref}:refs/heads/pravex-base`]);
  const branch = `pravex/${slugOf(text)}-${runId.slice(0, 12)}`;
  git(repo, ['checkout', '-q', '-b', branch, from.sha]);
  const origin = git(top, ['remote', 'get-url', 'origin'], { allowFail: true }).trim();
  if (origin) git(repo, ['remote', 'add', 'origin', origin]);
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), `\n${INPUTS}/\n`);
  guardGit(dir, repo);
  const given = [];
  for (const f of files) {
    const name = path.basename(f).replace(/[^\w.@ -]+/g, '_');
    fs.mkdirSync(path.join(repo, INPUTS), { recursive: true });
    fs.copyFileSync(f, path.join(repo, INPUTS, name));
    given.push(`${INPUTS}/${name}`);
  }
  journal.append(dir, { type: 'run.created', id: runId, req: { text: String(text).trim(), files: given, locale }, base: { ...from, branch, repo: top, origin }, cfg });
  return { id: runId, dir };
}

// ---------------------------------------------------------------------------
// Preparing
// ---------------------------------------------------------------------------

function installCommand(repo) {
  const has = (f) => fs.existsSync(path.join(repo, f));
  if (has('pnpm-lock.yaml')) return ['pnpm', 'install', '--frozen-lockfile'];
  if (has('package-lock.json')) return ['npm', 'ci'];
  if (has('yarn.lock')) return ['yarn', 'install', '--frozen-lockfile'];
  if (has('bun.lockb') || has('bun.lock')) return ['bun', 'install', '--frozen-lockfile'];
  return null;
}

/** The commands that check this repository: the ones the project chose, or the ones it has. */
function findChecks(repo, cfg) {
  if (Array.isArray(cfg.checks) && cfg.checks.length) return cfg.checks;
  try {
    const own = JSON.parse(fs.readFileSync(path.join(repo, '.pravex', 'project.json'), 'utf8'));
    if (Array.isArray(own.checks) && own.checks.length) return own.checks.filter((c) => typeof c === 'string');
  } catch {
    /* no project file */
  }
  let found = [];
  try {
    const c = require('../environment').commandsOf(repo);
    found = ((c && c.suggested) || []).filter((x) => x.kind !== 'build').map((x) => x.command);
  } catch {
    /* none known */
  }
  if (!found.length) {
    if (fs.existsSync(path.join(repo, 'go.mod'))) found = ['go vet ./...', 'go test ./...'];
    else if (fs.existsSync(path.join(repo, 'Cargo.toml'))) found = ['cargo test'];
    else if (['pytest.ini', 'pyproject.toml', 'setup.cfg'].some((f) => fs.existsSync(path.join(repo, f)))) found = ['python3 -m pytest -q'];
    else if (fs.existsSync(path.join(repo, 'pom.xml'))) found = ['mvn -q test'];
  }
  return found.filter(allowed);
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** Takes the run for this process; a lock whose process is gone is nobody's. */
function takeLock(dir) {
  const file = path.join(dir, 'lock');
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      return () => fs.rmSync(file, { force: true });
    } catch {
      const pid = Number(fs.readFileSync(file, 'utf8').trim() || 0);
      let alive = false;
      try {
        if (pid && pid !== process.pid) alive = process.kill(pid, 0);
      } catch (e) {
        alive = e.code === 'EPERM';
      }
      if (alive) return null;
      fs.rmSync(file, { force: true });
    }
  }
  return null;
}

/** Keeps the computer awake while the run works; it ends with this process. */
function keepAwake() {
  if (process.platform !== 'darwin') return () => {};
  const c = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  c.on('error', () => {});
  return () => c.kill();
}

/** Answers to failures of the job itself, always the same: wait, pause with an explanation, or count it. */
const PAUSES = { 'claude-signed-out': 'claude-signed-out', 'claude-missing': 'claude-missing', 'claude-old': 'claude-old', 'sandbox-unavailable': 'sandbox-unavailable' };

async function drive(dir, opts = {}) {
  const { log = () => {}, ask = worker.ask, claude, models = {}, sleep = (ms, signal) => new Promise((res) => { const t = setTimeout(res, ms); if (signal) signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); }), waitForLimit = true, maxSteps = 5000, onEvent = () => {}, jobTimeoutMs, checkTimeoutMs } = opts;
  const release = takeLock(dir);
  if (!release) throw Object.assign(new Error('this run is already going in another process'), { code: 'already-running' });
  const awake = opts.keepAwake === false ? () => {} : keepAwake();
  const stopFile = path.join(dir, 'STOP');
  const inbox = path.join(dir, 'inbox');
  const ac = new AbortController();
  const watch = setInterval(() => fs.existsSync(stopFile) && ac.abort(), 1000);
  const onSignal = () => ac.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const repo = path.join(dir, 'repo');
  let events = journal.read(dir);
  let s = machine.fold(events);
  const put = (e) => {
    const written = journal.append(dir, e);
    s = machine.reduce(s, written);
    try {
      onEvent(written, s);
    } catch {
      /* who watches never breaks the work */
    }
    return written;
  };
  const taskOf = (id) => machine.taskOf(s, id);

  /** One agent job with everything that can go wrong around it. Returns the answer, or null when there is none. */
  async function job(role, task, prompt, schema) {
    let waits = 0;
    for (;;) {
      const n = `j${s.jobs + 1}`;
      put({ type: 'job.started', job: n, role, task: task || undefined });
      const left = Math.max(0.2, s.cfg.maxUsd - s.usd);
      const model = models[role] || (role === 'builder' && task && taskOf(task).round >= 2 ? 'opus' : undefined);
      log(`${task || ''} ${role}`.trim(), 'start');
      let r = await ask({ role, prompt, schema, cwd: repo, model, maxUsd: Math.min(left, s.cfg.jobUsd || left) }, { claude, signal: ac.signal, timeoutMs: jobTimeoutMs });
      guardGit(dir, repo);
      const wrong = r.ok ? schemas.checkShape(schema, r.value) : null;
      if (wrong) r = { ...r, ok: false, error: 'wrong-shape', detail: wrong };
      // It ran out because the run did, not because the job was badly asked: that is the limit, not a failed try.
      const spent = r.error === 'job-budget' && !(s.cfg.jobUsd && s.cfg.jobUsd < left);
      const counts = r.ok || (!spent && !['claude-limit', 'claude-unavailable', 'stopped', ...Object.keys(PAUSES)].includes(r.error));
      put({ type: 'job.finished', job: n, role, task: task || undefined, ok: r.ok || !counts, done: r.ok, usd: r.usd, ms: r.ms, turns: r.turns, model: model || worker.ROLES[role].model, ...(r.ok ? {} : { error: r.error, detail: String(r.detail || '').slice(0, 400) }), ...(r.denied && r.denied.length ? { denied: r.denied.slice(0, 5) } : {}) });
      log(`${task || ''} ${role}`.trim(), r.ok ? 'done' : r.error, { usd: r.usd, ms: r.ms });
      if (r.ok) return r.value;
      if (r.error === 'stopped' || ac.signal.aborted) return pause('stopped');
      if (spent) return pause('budget');
      if (PAUSES[r.error]) return pause(PAUSES[r.error]);
      if (r.error === 'claude-limit') {
        if (!waitForLimit) return pause('claude-limit');
        const until = r.resetsAt && r.resetsAt > Date.now() ? r.resetsAt + 60e3 : Date.now() + 30 * 60e3;
        put({ type: 'run.waiting', why: 'claude-limit', until: new Date(until).toISOString() });
        log('waiting', 'claude-limit', { until });
        await sleep(until - Date.now(), ac.signal);
        if (ac.signal.aborted) return pause('stopped');
        continue;
      }
      if (r.error === 'claude-unavailable') {
        waits += 1;
        if (waits > 6) return pause('claude-unavailable');
        const wait = Math.min(15 * 60e3, 20e3 * 2 ** (waits - 1));
        put({ type: 'run.waiting', why: 'claude-unavailable', until: new Date(Date.now() + wait).toISOString() });
        await sleep(wait, ac.signal);
        if (ac.signal.aborted) return pause('stopped');
        continue;
      }
      return null; // counted as a failed try: the state decides what comes next
    }
  }
  /** What people decided while it worked, left as files by whoever heard it: taken once, in order, between steps. */
  function takeInbox() {
    if (!fs.existsSync(inbox)) return;
    for (const f of fs.readdirSync(inbox).filter((x) => !x.startsWith('.')).sort()) {
      const file = path.join(inbox, f);
      try {
        const m = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (m.type === 'objection' && Number.isInteger(m.n) && !s.objections.some((o) => o.n === m.n)) put({ type: 'decision.objected', n: m.n, title: m.title, reason: String(m.reason || '').slice(0, 1000) });
      } catch {
        /* not something a person wrote */
      }
      fs.rmSync(file, { force: true });
    }
  }
  const pause = (reason) => {
    if (!s.paused) put({ type: 'run.paused', reason });
    return null;
  };
  const checkCmd = (c, o = {}) => check(c, { cwd: repo, signal: ac.signal, timeoutMs: checkTimeoutMs, ...o });
  const diffOf = (t) => git(repo, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', `${t.baseSha}..HEAD`], { allowFail: true });

  /** After a job that writes: keep what the role may change, put the rest back, and commit it. */
  function settle({ allow, frozen = {}, message }) {
    const changed = changedFiles(repo).map((c) => c.file).filter((f) => !clean(f).startsWith(`${INPUTS}/`));
    const { kept, violations } = integrity.judge(changed, { allow, frozen, protectedGlobs: s.cfg.protected || [] });
    putBack(repo, violations.map((v) => v.file));
    const added = kept.length ? (git(repo, ['add', '-AN', '--', ...kept]), git(repo, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD', '--', ...kept])) : '';
    const dodges = integrity.dodges(added);
    const sha = commit(repo, kept, message);
    // Anything else left over (a file a test run made) is not part of the work.
    resetTo(repo, sha);
    return { kept, violations, dodges, sha };
  }

  const ACT = {
    async prepare() {
      const install = installCommand(repo);
      if (install) {
        log('prepare', install.join(' '));
        const r = await run(install[0], install.slice(1), { cwd: repo, env: cleanEnv(process.env, { keep: ['NPM_TOKEN', 'NODE_AUTH_TOKEN'] }), timeoutMs: 20 * 60e3, signal: ac.signal });
        if (ac.signal.aborted) return pause('stopped');
        if (r.code !== 0) return put({ type: 'prepare.failed', code: r.why === 'missing' ? 'tool-missing' : 'install-failed', detail: r.why === 'missing' ? install[0] : tail(`${r.out}\n${r.err}`, 1500) });
        // The lockfile decides what is installed: an install that changed files is put back.
        putBack(repo, changedFiles(repo).map((c) => c.file));
      }
      const results = [];
      for (const c of findChecks(repo, s.cfg)) {
        log('check', c);
        const r = await checkCmd(c);
        if (ac.signal.aborted) return pause('stopped');
        results.push({ command: c, ok: r.ok, ms: r.ms, ...(r.why ? { why: r.why } : {}), ...(r.flaky ? { flaky: true } : {}) });
      }
      resetTo(repo, head(repo));
      return put({ type: 'run.prepared', install: install ? install.join(' ') : null, checks: results, ms: results.reduce((a, r) => a + r.ms, 0) });
    },

    async analyze() {
      const v = await job('analyst', null, prompts.analyst(s), schemas.ANALYSIS);
      if (!v) return;
      const seen = new Set();
      const criteria = v.criteria.filter((c) => c.text.trim()).slice(0, 12).map((c, i) => {
        const id = /^AC-\d+$/.test(c.id) && !seen.has(c.id) ? c.id : `AC-${i + 1}`;
        seen.add(id);
        return { id, text: c.text.trim() };
      });
      const build = v.build.ok && !criteria.length ? { ok: false, why: 'nothing here can be checked' } : v.build;
      put({ type: 'analyze.done', feasibility: { ...v, build, criteria } });
    },

    async plan(a) {
      const v = await job('planner', null, prompts.planner(s, a.problems), schemas.PLAN);
      if (!v) return;
      const { problems, order } = machine.checkPlan(v.tasks, { criteria: s.feasibility.criteria, protectedGlobs: [...integrity.ALWAYS_PROTECTED, ...(s.cfg.protected || [])], maxTasks: s.cfg.maxTasks });
      if (problems.length) put({ type: 'plan.invalid', problems: problems.slice(0, 12) });
      else put({ type: 'plan.done', tasks: order.map((id) => v.tasks.find((t) => t.id === id)) });
    },

    /** An objection changes the plan, not the work already proven: new parts are added on top of it. */
    async replan(a) {
      const o = s.objections.find((x) => x.n === a.n);
      const v = await job('replanner', String(a.n), prompts.replanner(s, o), schemas.REPLAN);
      if (!v) return;
      const used = new Set(s.feasibility.criteria.map((c) => c.id));
      const criteria = v.criteria.filter((c) => c.text.trim() && !used.has(c.id));
      const drop = v.drop.filter((x) => used.has(x));
      const all = [...s.feasibility.criteria.filter((c) => !drop.includes(c.id)), ...criteria].map((c) => c.id);
      const { problems, order } = machine.checkPlan(v.tasks, { protectedGlobs: [...integrity.ALWAYS_PROTECTED, ...(s.cfg.protected || [])], maxTasks: s.cfg.maxTasks, existing: s.tasks.map((t) => t.id) });
      for (const c of criteria) if (!v.tasks.some((t) => t.criteria.includes(c.id))) problems.push(`criterion ${c.id} is in no task`);
      for (const t of v.tasks) for (const c of t.criteria) if (!all.includes(c)) problems.push(`criterion ${c} does not exist`);
      if (problems.length) {
        put({ type: 'replan.invalid', n: a.n, problems });
        // Twice without a plan that holds: the objection is reported as not applied, and the work goes on.
        if (journal.read(dir).filter((e) => e.type === 'replan.invalid' && e.n === a.n).length >= 2) put({ type: 'replan.done', n: a.n, ok: false });
        return;
      }
      put({ type: 'replan.done', n: a.n, ok: true, criteria, drop, tasks: order.map((id) => v.tasks.find((t) => t.id === id)) });
    },
    async 'drop-objection'(a) {
      put({ type: 'replan.done', n: a.n, ok: false });
    },

    async test(a) {
      const t = taskOf(a.task);
      const before = t.baseSha || s.tip;
      resetTo(repo, before);
      const v = await job('tester', t.id, prompts.tester(s, t), schemas.TESTS);
      if (!v) return;
      const missing = (why) => {
        resetTo(repo, before);
        put({ type: 'task.red.missing', task: t.id, why });
      };
      const { kept, violations, dodges, sha } = settle({ allow: t.tests, message: `test: ${t.title} (${t.id})` });
      if (!kept.length) return missing(`no test file matches ${t.tests.join(', ')}${violations.length ? `; these were put back: ${violations.map((x) => x.file).join(', ')}` : ''}`);
      if (dodges.length) return missing(`skipped tests or silenced checks: ${dodges.map((d) => `${d.file}: ${d.line}`).join('; ')}`);
      if (!allowed(v.command)) return missing(`\`${v.command}\` is not a plain command that only runs these tests`);
      const r = await checkCmd(v.command, { retry: false });
      if (ac.signal.aborted) return pause('stopped');
      resetTo(repo, sha);
      put({ type: 'check.finished', task: t.id, command: v.command, ok: r.ok, ms: r.ms });
      if (r.why) return missing(`\`${v.command}\` did not run: ${r.why}`);
      const last = t.redAttempts + 1 >= s.cfg.redAttempts;
      // Passing before the code exists proves nothing yet. One more try; after that it goes on, and says so.
      if (r.ok && !last) return missing(`the tests already pass before the code exists, so they prove nothing. Test the behaviour that is missing.`);
      put({ type: 'task.red', task: t.id, redBefore: !r.ok, testHashes: integrity.hashFiles(repo, kept), command: v.command, covers: v.covers, baseSha: before, sha, output: tail(r.output, 800) });
    },

    /** The tester could not write tests that are accepted. Without them nothing proves the task: it is set aside. */
    async 'accept-red'(a) {
      put({ type: 'task.blocked', task: a.task, reason: 'no-tests', detail: taskOf(a.task).redWhy });
    },

    async build(a) {
      const t = taskOf(a.task);
      resetTo(repo, t.sha);
      const v = await job('builder', t.id, prompts.builder(s, t, a.why), schemas.BUILD);
      if (!v) return;
      const { kept, violations, dodges, sha } = settle({ allow: t.files, frozen: t.testHashes, message: `feat: ${t.title} (${t.id}, round ${a.round})` });
      // What it says it needs, when it is a plain path nobody protects, becomes part of the task instead of a block.
      const wants = [...new Set([...v.needs, ...violations.filter((x) => x.rule === 'out-of-scope').map((x) => x.file)].map(clean))].filter((f) => f && !f.startsWith('/') && !f.startsWith('~') && !f.split('/').includes('..') && !/[*?\s]/.test(f) && !matches(f, t.files) && !matches(f, t.tests) && !matches(f, integrity.ALWAYS_PROTECTED) && !matches(f, s.cfg.protected || []) && !/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(f));
      const room = s.cfg.maxWiden - t.widened;
      if (wants.length && room > 0) put({ type: 'task.widened', task: t.id, files: wants.slice(0, room) });
      put({ type: 'task.built', task: t.id, round: a.round, sha, files: kept, violations, dodges, gaps: v.gaps.slice(0, 3), summary: v.summary.slice(0, 600), says: v.status });
    },

    async check(a) {
      const t = taskOf(a.task);
      resetTo(repo, t.sha);
      const built = [...journal.read(dir)].reverse().find((e) => e.type === 'task.built' && e.task === t.id);
      const failures = [];
      const done = [];
      const broken = integrity.changedTests(repo, t.testHashes);
      if (broken.length) failures.push({ kind: 'tests-changed', output: broken.join('\n') });
      for (const d of (built && built.dodges) || []) failures.push({ kind: d.rule, output: `${d.file}: ${d.line}` });
      if (t.sha === t.baseSha || (built && !built.files.length && built.round === 1)) failures.push({ kind: 'no-change', output: 'nothing was changed' });
      const list = [t.testCommand, ...s.prepared.checks.filter((c) => c.ok && c.command !== t.testCommand).map((c) => c.command)];
      for (const c of list) {
        if (failures.length && c !== t.testCommand) break; // the first real failure is enough to work on
        log(`${t.id} check`, c);
        const r = await checkCmd(c);
        if (ac.signal.aborted) return pause('stopped');
        done.push({ command: r.command, ok: r.ok, ms: r.ms, ...(r.flaky ? { flaky: true } : {}) });
        put({ type: 'check.finished', task: t.id, command: r.command, ok: r.ok, ms: r.ms, ...(r.flaky ? { flaky: true } : {}) });
        if (!r.ok) failures.push({ command: r.command, output: r.output });
      }
      resetTo(repo, t.sha);
      put({ type: 'task.checked', task: t.id, round: t.round, ok: !failures.length, failures, checks: done, fp: failures.length ? fingerprint(failures) : null });
      log(`${t.id} check`, failures.length ? 'failed' : 'passed');
    },

    /** Tests a review found missing. The ones that were there stay: a file that lost a test is not accepted. */
    async extend(a) {
      const t = taskOf(a.task);
      resetTo(repo, t.sha);
      const before = Object.fromEntries(Object.keys(t.testHashes).map((f) => [f, (fs.readFileSync(path.join(repo, f), 'utf8').match(/\b(?:it|test|t)\s*\(/g) || []).length]));
      const v = await job('tester', t.id, prompts.extender(s, t), schemas.TESTS);
      if (!v) return;
      const { kept, dodges, sha } = settle({ allow: t.tests, message: `test: ${t.title} (${t.id}, more proof)` });
      const files = [...new Set([...Object.keys(t.testHashes), ...kept])];
      const lost = Object.keys(before).filter((f) => !fs.existsSync(path.join(repo, f)) || (fs.readFileSync(path.join(repo, f), 'utf8').match(/\b(?:it|test|t)\s*\(/g) || []).length < before[f]);
      const fine = kept.length > 0 && !dodges.length && !lost.length && allowed(v.command);
      if (!fine) resetTo(repo, t.sha);
      put({ type: 'task.extended', task: t.id, ok: fine, ...(fine ? { testHashes: integrity.hashFiles(repo, files), command: v.command, covers: v.covers, sha } : { why: lost.length ? `lost tests in ${lost.join(', ')}` : 'no tests were added' }) });
    },

    async diagnose(a) {
      const t = taskOf(a.task);
      const v = await job('diagnoser', t.id, prompts.diagnoser(s, t, { diff: diffOf(t) }), schemas.DIAGNOSIS);
      if (v) put({ type: 'task.diagnosed', task: t.id, ...v, fp: t.fps[t.fps.length - 1] });
    },

    async restart(a) {
      const t = taskOf(a.task);
      resetTo(repo, t.baseSha);
      put({ type: 'task.restarted', task: t.id, why: `An independent diagnosis found the previous tests wrong: ${t.diagnosis.cause}` });
    },

    async review(a) {
      const t = taskOf(a.task);
      resetTo(repo, t.sha);
      const v = await job('reviewer', t.id, prompts.reviewer(s, t, { diff: diffOf(t), final: a.final }), schemas.REVIEW);
      if (!v) return;
      const verdict = v.verdict === 'FIX' && v.fixes.length ? 'FIX' : 'APPROVED';
      put({ type: 'task.reviewed', task: t.id, round: t.round, verdict, fixes: v.fixes, gaps: v.gaps.slice(0, 3), notes: v.notes.slice(0, 5), needsTests: v.fixes.some((f) => prompts.isTest(t, f.file)) });
    },

    async merge(a) {
      const t = taskOf(a.task);
      const broken = integrity.changedTests(repo, t.testHashes);
      if (broken.length || head(repo) !== t.sha) return put({ type: 'task.blocked', task: t.id, reason: 'evidence-lost', detail: broken.join(', ') });
      put({ type: 'task.done', task: t.id, sha: t.sha, evidence: { sha: t.sha, redBefore: t.redBefore, rounds: t.round, testsIntact: true, tests: Object.keys(t.testHashes), testHashes: t.testHashes, covers: t.covers, checks: t.checks, review: { verdict: t.review.verdict, round: t.review.round } } });
      log(t.id, 'done');
    },

    /** Set aside: its work stays on a branch of its own, and the main one goes on as if it had not been tried. */
    async block(a) {
      const t = taskOf(a.task);
      let kept = null;
      if (t.baseSha && t.sha && t.sha !== t.baseSha) {
        kept = `${s.base.branch}-${t.id.toLowerCase()}-unfinished`;
        git(repo, ['branch', '-f', kept, t.sha], { allowFail: true });
        resetTo(repo, t.baseSha);
      }
      put({ type: 'task.blocked', task: t.id, reason: a.reason, detail: a.detail || (t.failures[0] ? `${t.failures[0].command || t.failures[0].kind}` : ''), branch: kept });
      log(t.id, `set aside: ${a.reason}`);
    },

    async integrate() {
      const failures = [];
      const replaced = s.tasks.flatMap((t) => (t.phase === 'done' ? t.files : []));
      for (const t of s.tasks.filter((x) => x.phase === 'done')) if (integrity.changedTests(repo, t.testHashes).some((f) => !matches(f, replaced))) failures.push({ kind: 'tests-changed', output: t.id });
      const list = [...new Set([...s.tasks.filter((t) => t.phase === 'done').map((t) => t.testCommand), ...s.prepared.checks.filter((c) => c.ok).map((c) => c.command)])];
      for (const c of list) {
        const r = await checkCmd(c);
        if (ac.signal.aborted) return pause('stopped');
        put({ type: 'check.finished', command: r.command, ok: r.ok, ms: r.ms });
        if (!r.ok) failures.push({ command: r.command, output: r.output });
      }
      resetTo(repo, head(repo));
      put({ type: 'integrate.done', ok: !failures.length, failures, sha: head(repo) });
    },

    async deliver(a) {
      const out = report(s, { reason: a.reason, status: machine.finalStatus(s), events: journal.read(dir) });
      fs.writeFileSync(path.join(dir, 'report.md'), out.markdown);
      fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify(out.evidence, null, 2));
      put({ type: 'run.delivered', branch: s.base.branch, sha: fs.existsSync(path.join(repo, '.git')) ? head(repo) : null });
    },
  };

  try {
    if (fs.existsSync(stopFile)) fs.rmSync(stopFile, { force: true });
    if (s.open || s.paused || opts.cfg) put({ type: 'run.resumed', ...(opts.cfg ? { cfg: opts.cfg } : {}) });
    // A commit half made by a crash, or a lock it left: the working copy goes back to its last commit.
    fs.rmSync(path.join(repo, '.git', 'index.lock'), { force: true });
    guardGit(dir, repo);
    resetTo(repo, s.tip);
    let last = '';
    let same = 0;
    for (let n = 0; n < maxSteps; n++) {
      if (ac.signal.aborted) pause('stopped');
      takeInbox();
      const a = machine.next(s);
      if (a.do === 'none') break;
      if (a.do === 'wait') break;
      if (a.do === 'pause') {
        pause(a.reason);
        break;
      }
      if (a.do === 'finish') {
        put({ type: 'run.finished', status: a.status, reason: a.reason });
        break;
      }
      // The state must change with every step; one that does not is a defect, and it is not allowed to spin.
      const mark = JSON.stringify([a, s.jobs, s.usd, s.prepareFailures]);
      same = mark === last ? same + 1 : 0;
      last = mark;
      if (same >= 3) {
        if (a.task) put({ type: 'task.blocked', task: a.task, reason: 'engine-stuck', detail: a.do });
        else {
          pause('engine-stuck');
          break;
        }
        continue;
      }
      try {
        await ACT[a.do](a);
      } catch (e) {
        log(a.do, `error: ${e.message}`);
        put({ type: 'step.failed', do: a.do, task: a.task, code: e.code || 'engine', detail: String(e.message).slice(0, 400) });
        const again = journal.read(dir).filter((x) => x.type === 'step.failed' && x.do === a.do && x.task === a.task).length;
        // Twice on the same step: that task is set aside and the rest goes on; without a task, it pauses and says so.
        if (e.code === 'ENOSPC' || e.code === 'git-lost') {
          pause(e.code === 'ENOSPC' ? 'disk-full' : 'git-lost');
          break;
        }
        if (again >= 2) {
          if (a.task) put({ type: 'task.blocked', task: a.task, reason: 'engine-error', detail: String(e.message).slice(0, 200) });
          else {
            pause('engine-error');
            break;
          }
        }
      }
    }
    if (s.paused) {
      const out = report(s, { reason: s.paused, status: 'paused', events: journal.read(dir) });
      fs.writeFileSync(path.join(dir, 'report.md'), out.markdown);
    }
    return { state: s, status: s.final || (s.paused ? 'paused' : 'stopped'), explain: explain(s) };
  } finally {
    clearInterval(watch);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    awake();
    release();
  }
}

/** Asks a run to stop, with or without a connection. Its process sees it within a second. */
const stop = (dir) => fs.writeFileSync(path.join(dir, 'STOP'), new Date().toISOString());

/** Leaves what a person decided for a run, whether it is working or not. */
function tell(dir, message) {
  const inbox = path.join(dir, 'inbox');
  fs.mkdirSync(inbox, { recursive: true, mode: 0o700 });
  const name = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`;
  fs.writeFileSync(path.join(inbox, `.${name}`), JSON.stringify(message), { mode: 0o600 });
  fs.renameSync(path.join(inbox, `.${name}`), path.join(inbox, name));
}

module.exports = { BUILDS, create, tell, drive, stop, takeLock, findChecks, installCommand, changedFiles, git, head };
