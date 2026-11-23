'use strict';
/**
 * The runner end to end, in a child process with its own HOME: a real git repository with an origin, fake `claude`
 * and `gh` on the PATH, and a local server standing in for Pravex. A dry test changes nothing; a live run works in its
 * own worktree, opens a pull request and removes the worktree.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const RUNNER = path.join(__dirname, 'flow-runner.js');
const MACHINE = '6f1c2a9e-3b7d-4e21-9a55-0c8d7e6f5a41';

function setUp() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-run-home-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const origin = path.join(home, 'remote', 'acme', 'app.git');
  fs.mkdirSync(origin, { recursive: true });
  const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString();
  git(['init', '--bare', '-b', 'main', origin], home);
  const repo = path.join(home, 'code', 'app');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-b', 'main'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# app\n');
  git(['add', '.'], repo);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init'], repo);
  git(['remote', 'add', 'origin', origin], repo);
  git(['push', '-u', 'origin', 'main'], repo);
  git(['remote', 'set-head', 'origin', 'main'], repo);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [repo]: { lastSessionModified: 1 } } }));
  fs.mkdirSync(path.join(home, '.pravex'));
  fs.writeFileSync(path.join(home, '.pravex', 'machine-id'), `${MACHINE}\n`);
  // A fake Claude Code: the dry test answers with a verdict; a live agent writes a file.
  fs.writeFileSync(
    path.join(bin, 'claude'),
    `#!/bin/sh
case "$*" in
  *"--permission-mode plan"*) printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.1,"num_turns":3,"result":"ok\\n{\\"canRun\\": true, \\"missing\\": [], \\"summary\\": \\"I can read the repo\\"}"}' ;;
  *) echo "done" > done.txt; printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.2,"num_turns":5,"result":"Wrote done.txt"}' ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh
case "$1 $2" in
  "auth status") exit 0 ;;
  "repo view") echo WRITE ;;
  "pr create") echo https://github.com/acme/app/pull/7 ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  return { home, bin, repo, origin, git };
}

const flowDef = {
  nodes: [
    { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Now', type: 'manual' } },
    { id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Writer', model: 'sonnet', tools: ['Read', 'Write'], instructions: 'Write done.txt' } },
    { id: 'c', type: 'check', position: { x: 0, y: 0 }, data: { label: 'File exists', type: 'custom', command: 'test -f done.txt' } },
    { id: 'p', type: 'action', position: { x: 0, y: 0 }, data: { label: 'Open PR', type: 'open_pr' } },
  ],
  edges: [
    { id: 'e1', source: 't', target: 'a' },
    { id: 'e2', source: 'a', target: 'c' },
    { id: 'e3', source: 'c', target: 'p' },
  ],
  budget: { maxUsd: 5, maxTurns: 20, stopAfterFailures: 1 },
};

function pravex({ assigned = true, definition = flowDef } = {}) {
  const patches = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const send = (result, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status, result }));
      };
      if (req.method === 'POST' && req.url === '/api/agent-flow-runs') {
        return send({ id: 'run-1', created: true, assigned, flow: { id: 'f1', name: 'Write a file', slug: 'write-a-file', version: 1, repo: 'acme/app', definition }, mode: body.mode }, 201);
      }
      if (req.method === 'PATCH' && req.url === '/api/agent-flow-runs/run-1') {
        patches.push(body);
        return send({ id: 'run-1', status: body.status || 'running' });
      }
      if (req.method === 'GET' && req.url === '/api/agent-flow-runs/run-1') return send({ id: 'run-1', steps: [] });
      send({ error: { message: 'nope' } }, 404);
    });
  });
  return { server, patches };
}

function runNow(env, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function withServer(opts, fn) {
  const { server, patches } = pravex(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, patches);
  } finally {
    server.close();
  }
}

const IDENTITY = { GIT_AUTHOR_NAME: 'Pravex Test', GIT_AUTHOR_EMAIL: 'test@pravex.test', GIT_COMMITTER_NAME: 'Pravex Test', GIT_COMMITTER_EMAIL: 'test@pravex.test' };
const envFor = (fx, host, extra = IDENTITY) => ({ ...process.env, HOME: fx.home, USERPROFILE: fx.home, PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`, PRAVEX_ACCESS_TOKEN: 'test-token', PRAVEX_API_HOST: host, ...extra });
const stepsOf = (patches) => {
  const last = {};
  for (const p of patches) for (const s of p.steps || []) last[s.nodeId] = s;
  return last;
};

test('a dry test changes nothing and reports each step', { skip: process.platform === 'win32' }, async () => {
  const fx = setUp();
  await withServer({}, async (host, patches) => {
    const { code, out } = await runNow(envFor(fx, host), ['--run', 'f1', '--dry']);
    assert.equal(code, 1, out); // the check fails: the dry agent wrote nothing
    const steps = stepsOf(patches);
    assert.equal(steps.a.status, 'passed');
    assert.deepEqual(steps.a.summary, { code: 'agent-verdict', params: { text: 'I can read the repo', missing: [] } });
    assert.equal(steps.c.status, 'failed');
    assert.equal(steps.p.summary.code, 'pr-would-open');
    assert.equal(patches.at(-1).status, 'failed');
    assert.ok(!fs.existsSync(path.join(fx.repo, 'done.txt')));
  });
});

test('a test of a flow not assigned here skips its commands', { skip: process.platform === 'win32' }, async () => {
  const fx = setUp();
  await withServer({ assigned: false }, async (host, patches) => {
    const { code, out } = await runNow(envFor(fx, host), ['--run', 'f1', '--dry']);
    assert.equal(code, 0, out);
    assert.match(out, /its commands are not run/);
    const steps = stepsOf(patches);
    assert.deepEqual(steps.c.summary, { code: 'check-not-run', params: { command: 'test -f done.txt' } });
    assert.equal(steps.c.status, 'skipped');
  });
});

test('a live run works in its own worktree, opens a pull request and cleans up', { skip: process.platform === 'win32' }, async () => {
  const fx = setUp();
  await withServer({}, async (host, patches) => {
    const { code, out } = await runNow(envFor(fx, host), ['--run', 'f1']);
    assert.equal(code, 0, out);
    const steps = stepsOf(patches);
    assert.deepEqual(['t', 'a', 'c', 'p'].map((id) => steps[id].status), ['passed', 'passed', 'passed', 'passed']);
    assert.deepEqual(steps.p.summary, { code: 'pr-opened', params: { url: 'https://github.com/acme/app/pull/7' } });
    const branch = patches.find((p) => p.branch).branch;
    assert.match(branch, /^pravex\/write-a-file-/);
    // The branch reached the origin with the agent's file; the developer's copy and the run folder are untouched/gone.
    assert.match(fx.git(['ls-tree', '-r', '--name-only', branch], fx.origin), /done\.txt/);
    assert.ok(!fs.existsSync(path.join(fx.repo, 'done.txt')));
    assert.ok(!fs.existsSync(path.join(fx.home, '.pravex', 'runs', 'run-1')));
    assert.equal(patches.at(-1).status, 'passed');
    assert.ok(Math.abs(patches.at(-1).costUsd - 0.2) < 1e-9);
  });
});

test('a live run without a git identity says the commit failed instead of opening an empty pull request', { skip: process.platform === 'win32' }, async () => {
  const fx = setUp();
  await withServer({}, async (host, patches) => {
    const env = envFor(fx, host, { GIT_CONFIG_GLOBAL: path.join(fx.home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' });
    for (const k of Object.keys(IDENTITY)) delete env[k];
    for (const k of ['EMAIL', 'GIT_AUTHOR_DATE']) delete env[k];
    execFileSync('git', ['config', 'user.useConfigOnly', 'true'], { cwd: fx.repo });
    const { code } = await runNow(env, ['--run', 'f1']);
    assert.equal(code, 1);
    assert.equal(stepsOf(patches).p.summary.code, 'commit-failed');
  });
});

// What a live run promises -------------------------------------------------

/** A claude that records how it was called and then does `script`. */
function fakeClaude(fx, script) {
  fs.writeFileSync(
    path.join(fx.bin, 'claude'),
    `#!/bin/sh
if [ "$1" = auth ]; then echo '{"loggedIn": true}'; exit 0; fi
n=$(ls "${fx.home}"/call-* 2>/dev/null | wc -l | tr -d ' ')
printf '%s\\n' "$@" > "${fx.home}/call-$n"
${script}
`,
    { mode: 0o755 },
  );
}
const say = (text) => `printf '%s\\n' '${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1, num_turns: 1, result: text })}'`;
const chain = (nodes, budget = {}) => ({
  nodes: nodes.map((n) => ({ position: { x: 0, y: 0 }, ...n })),
  edges: nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: nodes[i].id, target: n.id })),
  budget: { maxUsd: 5, maxTurns: 20, stopAfterFailures: 3, ...budget },
});
const T = { id: 't', type: 'trigger', data: { label: 'Now', type: 'manual' } };
const agent = (id, tools = ['Read', 'Write']) => ({ id, type: 'agent', data: { label: `Agent ${id}`, model: 'sonnet', tools, instructions: `Task ${id}` } });
const check = (id, command) => ({ id, type: 'check', data: { label: `Check ${id}`, type: 'custom', command } });
const PR = { id: 'p', type: 'action', data: { label: 'Open PR', type: 'open_pr' } };
const branches = (fx) => fx.git(['branch', '--list', 'pravex/*', '--format=%(refname:short)'], fx.repo).trim().split('\n').filter(Boolean);
const posix = { skip: process.platform === 'win32' };

test('a failing check stops the pull request even below the failure limit, and the work stays on the local branch', posix, async () => {
  const fx = setUp();
  fakeClaude(fx, `echo half > half.txt; ${say('Half done')}`);
  await withServer({ definition: chain([T, agent('a'), check('c', 'false'), PR]) }, async (host, patches) => {
    const { code, out } = await runNow(envFor(fx, host), ['--run', 'f1']);
    assert.equal(code, 1, out);
    const steps = stepsOf(patches);
    assert.equal(steps.p.status, 'skipped');
    assert.deepEqual(steps.p.summary, { code: 'blocked-by-check', params: { label: 'Check c' } });
    const [branch] = branches(fx);
    assert.deepEqual(patches.at(-1).reason, { code: 'step-failed', params: { label: 'Check c', branch } });
    assert.match(fx.git(['ls-tree', '-r', '--name-only', branch], fx.repo), /half\.txt/);
    assert.equal(fx.git(['branch', '--list', 'pravex/*'], fx.origin).trim(), '', 'nothing was pushed');
    assert.ok(!fs.existsSync(path.join(fx.home, '.pravex', 'runs', 'run-1')));
    assert.equal(fx.git(['status', '--porcelain'], fx.repo).trim(), '', "the developer's copy is untouched");
  });
});

test('a failing check also stops an approval from being asked for', posix, async () => {
  const fx = setUp();
  fakeClaude(fx, say('ok'));
  await withServer({ definition: chain([T, check('c', 'false'), { id: 'g', type: 'approval', data: { label: 'Gate' } }, PR]) }, async (host, patches) => {
    await runNow(envFor(fx, host), ['--run', 'f1']);
    assert.equal(stepsOf(patches).g.status, 'skipped');
    assert.ok(!patches.some((p) => p.status === 'waiting'));
    assert.equal(patches.at(-1).status, 'failed');
  });
});

test('an agent after a failed check reads its output, and the same check passing opens the pull request', posix, async () => {
  const fx = setUp();
  fakeClaude(fx, `case "$*" in *"Task b"*) echo ok > fixed.txt ;; *) echo x > x.txt ;; esac; ${say('Report of the step')}`);
  const command = 'test -f fixed.txt || (echo MISSING-FIXED-FILE; exit 1)';
  await withServer({ definition: chain([T, agent('a'), check('c1', command), agent('b'), check('c2', command), PR]) }, async (host, patches) => {
    const { code, out } = await runNow(envFor(fx, host), ['--run', 'f1']);
    assert.equal(code, 0, out);
    assert.equal(stepsOf(patches).p.summary.code, 'pr-opened');
    assert.equal(patches.at(-1).status, 'passed');
    const second = fs.readFileSync(path.join(fx.home, 'call-1'), 'utf8');
    assert.match(second, /### Agent a\nReport of the step/);
    assert.match(second, /MISSING-FIXED-FILE/);
    assert.doesNotMatch(fs.readFileSync(path.join(fx.home, 'call-0'), 'utf8'), /earlier steps/);
  });
});

test('a night with nothing to change passes without pushing a branch or opening a pull request', posix, async () => {
  const fx = setUp();
  fakeClaude(fx, say('Nothing safe to change'));
  await withServer({ definition: chain([T, agent('a'), check('c', 'true'), PR]) }, async (host, patches) => {
    const { code, out } = await runNow(envFor(fx, host), ['--run', 'f1']);
    assert.equal(code, 0, out);
    assert.deepEqual(stepsOf(patches).p.summary, { code: 'nothing-to-commit', params: {} });
    assert.equal(fx.git(['branch', '--list', 'pravex/*'], fx.origin).trim(), '');
  });
});

test('a signed-out Claude Code ends the run before anything is copied, dry or live', posix, async () => {
  const fx = setUp();
  fs.writeFileSync(path.join(fx.bin, 'claude'), `#!/bin/sh\necho '{"loggedIn": false}'; exit 1\n`, { mode: 0o755 });
  for (const args of [['--run', 'f1'], ['--run', 'f1', '--dry']]) {
    await withServer({}, async (host, patches) => {
      const { code } = await runNow(envFor(fx, host), args);
      assert.equal(code, 1);
      assert.deepEqual(patches.at(-1).reason, { code: 'claude-not-signed-in', params: {} });
      assert.deepEqual(branches(fx), []);
    });
  }
});

test('work is kept on a machine without a git identity', posix, async () => {
  const fx = setUp();
  fakeClaude(fx, `echo half > half.txt; ${say('Half done')}`);
  await withServer({ definition: chain([T, agent('a'), check('c', 'false'), PR]) }, async (host) => {
    const env = envFor(fx, host, { GIT_CONFIG_GLOBAL: path.join(fx.home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' });
    for (const k of [...Object.keys(IDENTITY), 'EMAIL']) delete env[k];
    execFileSync('git', ['config', 'user.useConfigOnly', 'true'], { cwd: fx.repo });
    await runNow(env, ['--run', 'f1']);
    assert.match(fx.git(['ls-tree', '-r', '--name-only', branches(fx)[0]], fx.repo), /half\.txt/);
  });
});

/** A claude whose plan stands at `pct` of the five-hour window when asked. */
const planAt = (pct) => `case "$*" in *"Reply with: ok"*) printf '%s\\n' '${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: pct / 100, resetsAt: 4102444800 } } } })}'; exit 0 ;; esac`;
const guardedFlow = { ...chain([T, agent('a'), check('c', 'true'), PR]), guard: { days: null, window: 'five_hour', runBelowPct: 30, stopAbovePct: 80, whenUnknown: 'skip' } };

test('a guarded live run asks Claude where the plan stands: below the limit it runs, above it does not', posix, async () => {
  for (const [pct, status, code] of [
    [13, 'passed', null],
    [45, 'skipped', 'plan-above-start'],
  ]) {
    const fx = setUp();
    fakeClaude(fx, `${planAt(pct)}; echo x > x.txt; ${say('done')}`);
    await withServer({ definition: guardedFlow }, async (host, patches) => {
      await runNow(envFor(fx, host), ['--run', 'f1']);
      assert.equal(patches.at(-1).status, status);
      assert.equal(patches.at(-1).reason ? patches.at(-1).reason.code : null, code);
      assert.equal(patches.at(-1).planUsage.start.fiveHour.pct, pct);
      assert.equal(JSON.parse(fs.readFileSync(path.join(fx.home, '.pravex', 'plan-usage.json'), 'utf8')).fiveHour.pct, pct);
    });
  }
});

test('a guarded run is still skipped when Claude does not say', posix, async () => {
  const fx = setUp();
  fakeClaude(fx, say('done'));
  await withServer({ definition: guardedFlow }, async (host, patches) => {
    await runNow(envFor(fx, host), ['--run', 'f1']);
    assert.equal(patches.at(-1).reason.code, 'plan-unknown');
  });
});

test('a fresh answer replaces an old reading whose window has reset', posix, async () => {
  const fx = setUp();
  const at = Date.now() - 86400000;
  fs.writeFileSync(path.join(fx.home, '.pravex', 'plan-usage.json'), JSON.stringify({ fiveHour: { pct: 2, resetsAt: at + 1000 }, sevenDay: null, at }));
  fakeClaude(fx, `${planAt(90)}; ${say('done')}`);
  await withServer({ definition: guardedFlow }, async (host, patches) => {
    await runNow(envFor(fx, host), ['--run', 'f1']);
    assert.equal(patches.at(-1).reason.code, 'plan-above-start');
  });
});

test('a guarded run on a signed-out machine says so instead of an unknown plan', posix, async () => {
  const fx = setUp();
  fs.writeFileSync(path.join(fx.bin, 'claude'), `#!/bin/sh\necho '{"loggedIn": false}'; exit 1\n`, { mode: 0o755 });
  await withServer({ definition: guardedFlow }, async (host, patches) => {
    await runNow(envFor(fx, host), ['--run', 'f1']);
    assert.equal(patches.at(-1).reason.code, 'claude-not-signed-in');
  });
});
