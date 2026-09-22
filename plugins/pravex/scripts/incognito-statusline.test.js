'use strict';
/**
 * Incognito sessions, the start indicator and the status line.
 *
 * Each test runs the scripts in a child process with its own HOME, because both
 * resolve ~/.pravex and ~/.claude at load time and must never touch the real ones.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REPORT = path.join(__dirname, 'report-session.js');
const STATUSLINE = path.join(__dirname, 'statusline.js');
const TS = '2026-01-01T00:00:00.000Z';

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-home-'));

function envFor(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...extra };
  if (!('PRAVEX_API_KEY' in extra)) delete env.PRAVEX_API_KEY;
  if (!('PRAVEX_API_HOST' in extra)) delete env.PRAVEX_API_HOST;
  return env;
}

function writeTranscript(home, sessionId) {
  const dir = path.join(home, '.claude', 'projects', '-tmp-project');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const lines = [
    { type: 'user', timestamp: TS, gitBranch: 'feat/secret-launch', message: { content: 'rotate the prod database password' } },
    {
      type: 'assistant',
      timestamp: TS,
      message: {
        id: 'm1',
        model: 'claude-opus-5',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [
          { type: 'text', text: 'Done. See https://github.com/acme/widgets/pull/7' },
          { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'src/a.ts' } },
        ],
      },
    },
    { type: 'user', timestamp: TS, message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'ok' }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  return file;
}

function captureServer() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      bodies.push(JSON.parse(data));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, bodies, host: `http://127.0.0.1:${server.address().port}` })));
}

function run(script, args, { input = '', env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(input);
  });
}

test('startMessage says whether the session is recorded, incognito or needs a login', () => {
  const { startMessage } = require('./report-session.js');
  assert.match(startMessage({ configured: false, source: 'startup' }), /not connected.*\/pravex:login/);
  assert.match(startMessage({ configured: true, source: 'startup' }), /recording.*\/pravex:incognito/);
  assert.match(startMessage({ configured: true, incognito: true, source: 'resume' }), /incognito/);
  // Compaction and /clear do not change who is watching; a banner there is noise.
  assert.strictEqual(startMessage({ configured: true, source: 'compact' }), null);
  assert.strictEqual(startMessage({ configured: true, source: 'clear' }), null);
});

test('an incognito body carries usage and cost inputs, and nothing about the work', () => {
  const { buildBody } = require('./report-session.js');
  const agg = {
    title: 'rotate the prod database password',
    branch: 'feat/secret-launch',
    startedAt: TS,
    endedAt: TS,
    durationMinutes: 3,
    usage: [{ model: 'claude-opus-5', inputTokens: 10, outputTokens: 5 }],
    filesTouched: 4,
    testsAdded: 1,
    retryRate: 0.5,
    prUrl: 'https://github.com/acme/widgets/pull/7',
    transcript: { encoding: 'gzip+base64', data: 'x' },
  };

  const body = buildBody('s1', 'acme/widgets', agg, process.cwd(), 'ended', { incognito: true });

  assert.deepStrictEqual(Object.keys(body).sort(), ['agent', 'durationMinutes', 'endedAt', 'externalId', 'incognito', 'startedAt', 'status', 'usage']);
  assert.strictEqual(body.incognito, true);
});

test('the start hook shows the login indicator even with no credentials', async () => {
  const home = tempHome();
  const { code, stdout } = await run(REPORT, ['--start'], {
    input: JSON.stringify({ session_id: 's1', source: 'startup', cwd: process.cwd() }),
    env: envFor(home),
  });
  assert.strictEqual(code, 0);
  assert.match(JSON.parse(stdout).systemMessage, /\/pravex:login/);
});

test('/pravex:incognito marks the session and reports it scrubbed at once', async () => {
  const home = tempHome();
  const { server, bodies, host } = await captureServer();
  writeTranscript(home, 'sess-1');

  const { code, stdout } = await run(REPORT, ['--incognito', 'sess-1'], {
    env: envFor(home, { PRAVEX_API_KEY: 'pvx_test', PRAVEX_API_HOST: host }),
  });
  server.close();

  assert.strictEqual(code, 0);
  assert.match(stdout, /incognito/);
  assert.ok(fs.existsSync(path.join(home, '.pravex', 'incognito', 'sess-1')));
  assert.strictEqual(bodies.length, 1);
  assert.strictEqual(bodies[0].incognito, true);
  const sent = JSON.stringify(bodies[0]);
  for (const leak of ['rotate the prod', 'secret-launch', 'pull/7', 'src/a.ts', 'transcript']) {
    assert.ok(!sent.includes(leak), `incognito report leaked ${leak}`);
  }
});

test('after /pravex:incognito the end-of-session report sends no transcript', async () => {
  const home = tempHome();
  const { server, bodies, host } = await captureServer();
  const transcript = writeTranscript(home, 'sess-2');
  const env = envFor(home, { PRAVEX_API_KEY: 'pvx_test', PRAVEX_API_HOST: host });
  await run(REPORT, ['--incognito', 'sess-2'], { env });

  await run(REPORT, [], { input: JSON.stringify({ session_id: 'sess-2', transcript_path: transcript, cwd: process.cwd() }), env });
  server.close();

  const end = bodies.at(-1);
  assert.strictEqual(end.status, 'ended');
  assert.strictEqual(end.incognito, true);
  assert.strictEqual(end.transcript, undefined);
  assert.strictEqual(end.title, undefined);
});

test('the incognito marker cannot escape its directory', () => {
  const home = tempHome();
  const result = spawnSync(process.execPath, [REPORT, '--incognito', '../../etc/passwd'], { env: envFor(home), encoding: 'utf8' });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(fs.readdirSync(path.join(home, '.pravex', 'incognito')), ['etcpasswd']);
});

test('both scripts agree on where incognito markers live', () => {
  // Loaded in one process with one HOME, so the paths are comparable.
  assert.strictEqual(require('./report-session.js').INCOGNITO_DIR, require('./statusline.js').INCOGNITO_DIR);
});

test('the status line shows the login, watching and incognito states', async () => {
  const home = tempHome();
  const input = JSON.stringify({ session_id: 'sess-3' });
  const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').trim();

  assert.match(plain((await run(STATUSLINE, [], { input, env: envFor(home) })).stdout), /⚠ Pravex: \/pravex:login/);

  const env = envFor(home, { PRAVEX_API_KEY: 'pvx_test', PRAVEX_API_HOST: 'http://127.0.0.1:1' });
  assert.strictEqual(plain((await run(STATUSLINE, [], { input, env })).stdout), '● Pravex');

  await run(REPORT, ['--incognito', 'sess-3'], { env: envFor(home) });
  assert.strictEqual(plain((await run(STATUSLINE, [], { input, env })).stdout), '◌ Pravex incognito');
});

test('install keeps an existing status line, chains it, and uninstall puts it back', async () => {
  const home = tempHome();
  const settingsFile = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const previous = { type: 'command', command: `"${process.execPath}" -e "process.stdout.write('GSD phase 3')"`, padding: 1 };
  fs.writeFileSync(settingsFile, JSON.stringify({ model: 'opus', statusLine: previous }));
  const env = envFor(home, { PRAVEX_API_KEY: 'pvx_test', PRAVEX_API_HOST: 'http://127.0.0.1:1' });

  assert.strictEqual((await run(STATUSLINE, ['--install'], { env })).code, 0);
  const installed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.strictEqual(installed.model, 'opus');
  assert.match(installed.statusLine.command, /\.pravex[\\/]statusline\.js/);
  assert.strictEqual(installed.statusLine.padding, 1);
  assert.ok(fs.existsSync(path.join(home, '.pravex', 'statusline.js')));

  // Rendered from the installed copy, the way Claude Code runs it.
  const copy = path.join(home, '.pravex', 'statusline.js');
  const rendered = (await run(copy, [], { input: JSON.stringify({ session_id: 'x' }), env })).stdout.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(rendered, /^GSD phase 3 │ ● Pravex/);

  // Idempotent: a second install must not chain Pravex onto itself.
  await run(STATUSLINE, ['--install'], { env });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, '.pravex', 'statusline.json'), 'utf8')).previous, previous);

  await run(STATUSLINE, ['--uninstall'], { env });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).statusLine, previous);
  assert.ok(!fs.existsSync(copy));
});

test('install on a machine with no status line and no settings file', async () => {
  const home = tempHome();
  const env = envFor(home);

  assert.strictEqual((await run(STATUSLINE, ['--install'], { env })).code, 0);
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.strictEqual(settings.statusLine.type, 'command');

  await run(STATUSLINE, ['--uninstall'], { env });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).statusLine, undefined);
});

test('install refuses to rewrite a settings file it cannot parse', async () => {
  const home = tempHome();
  const settingsFile = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, '{ not json');

  const { code } = await run(STATUSLINE, ['--install'], { env: envFor(home) });

  assert.strictEqual(code, 1);
  assert.strictEqual(fs.readFileSync(settingsFile, 'utf8'), '{ not json');
});

test('update-check compares versions numerically, not as strings', () => {
  const { isNewer } = require('./update-check.js');
  assert.strictEqual(isNewer('0.10.0', '0.9.0'), true);
  assert.strictEqual(isNewer('0.4.0', '0.4.0'), false);
  assert.strictEqual(isNewer('0.3.9', '0.4.0'), false);
  assert.strictEqual(isNewer('v1.0.0', '0.9.9'), true);
});

test('a cached check goes stale the moment the installed version changes', () => {
  const { isFresh } = require('./update-check.js');
  const now = Date.now();
  assert.strictEqual(isFresh({ installed: '0.4.0', checkedAt: now - 1000 }, '0.4.0', now), true);
  // Just updated: the old "update available" must not survive twelve more hours.
  assert.strictEqual(isFresh({ installed: '0.4.0', checkedAt: now - 1000 }, '0.5.0', now), false);
  assert.strictEqual(isFresh({ installed: '0.4.0', checkedAt: now - 13 * 60 * 60 * 1000 }, '0.4.0', now), false);
});

test('updateStatus reads only the cache and compares with the running version', () => {
  const { updateStatus } = require('./update-check.js');
  assert.deepStrictEqual(updateStatus({ latest: '0.5.0', installed: '0.4.0' }, '0.4.0'), { available: true, installed: '0.4.0', latest: '0.5.0' });
  assert.strictEqual(updateStatus({ latest: '0.5.0', installed: '0.4.0' }, '0.5.0').available, false);
  assert.strictEqual(updateStatus(null, '0.4.0').available, false);
});

test('check writes the answer, and a failed fetch keeps the last good one', async () => {
  const home = tempHome();
  const script = `
    const u = require(${JSON.stringify(path.join(__dirname, 'update-check.js'))});
    (async () => {
      const first = await u.check({ fetch: async () => '9.9.9', now: 1 });
      const failed = await u.check({ fetch: async () => null, now: 1 + 13 * 3600 * 1000 });
      process.stdout.write(JSON.stringify({ first, failed }));
    })();`;
  const result = spawnSync(process.execPath, ['-e', script], { env: envFor(home), encoding: 'utf8' });
  const { first, failed } = JSON.parse(result.stdout);
  assert.strictEqual(first.latest, '9.9.9');
  assert.strictEqual(first.updateAvailable, true);
  assert.deepStrictEqual(failed, first);
  assert.ok(fs.existsSync(path.join(home, '.pravex', 'update-check.json')));
});

test('the start message and the status line both say when an update is waiting', async () => {
  const { startMessage } = require('./report-session.js');
  assert.match(
    startMessage({ configured: true, source: 'startup', update: { available: true, installed: '0.4.0', latest: '0.5.0' } }),
    /0\.4\.0 → 0\.5\.0.*\/pravex:update/
  );

  const home = tempHome();
  fs.mkdirSync(path.join(home, '.pravex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.pravex', 'update-check.json'), JSON.stringify({ installed: '0.4.0', latest: '0.5.0' }));
  const env = envFor(home, { PRAVEX_API_KEY: 'pvx_test', PRAVEX_API_HOST: 'http://127.0.0.1:1' });
  const out = (await run(STATUSLINE, [], { input: '{"session_id":"s"}', env })).stdout.replace(/\x1b\[[0-9;]*m/g, '').trim();
  assert.strictEqual(out, '● Pravex ⬆ /pravex:update');
});

test('alone, the status line still shows the model and context use', async () => {
  const home = tempHome();
  const env = envFor(home, { PRAVEX_API_KEY: 'pvx_test', PRAVEX_API_HOST: 'http://127.0.0.1:1' });
  const input = JSON.stringify({ session_id: 's', model: { display_name: 'Opus 5' }, context_window: { used_percentage: 41.6 } });

  const out = (await run(STATUSLINE, [], { input, env })).stdout.replace(/\x1b\[[0-9;]*m/g, '').trim();

  assert.strictEqual(out, 'Opus 5 │ ctx 42% │ ● Pravex');
});

test('with nothing to show but Pravex, it prints just the segment', async () => {
  const home = tempHome();
  const env = envFor(home, { PRAVEX_API_KEY: 'pvx_test', PRAVEX_API_HOST: 'http://127.0.0.1:1' });
  const out = (await run(STATUSLINE, [], { input: '{"session_id":"s"}', env })).stdout.replace(/\x1b\[[0-9;]*m/g, '').trim();
  assert.strictEqual(out, '● Pravex');
});

function fakeClaude(dir, updateOutput, exitCode = 0) {
  const bin = path.join(dir, 'claude');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\n` +
      `if (process.argv[3] === 'update' && process.argv[2] === 'plugin') { process.stdout.write(${JSON.stringify(updateOutput)}); process.exit(${exitCode}); }\n`,
    { mode: 0o755 }
  );
  return { bin, log };
}

test('/pravex:update refreshes the marketplace, then updates, then clears the cache', async () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, '.pravex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.pravex', 'update-check.json'), '{"installed":"0.4.0","latest":"0.5.0"}');
  const { bin, log } = fakeClaude(home, 'Plugin "pravex" updated from 0.4.0 to 0.5.0 for scope user.');

  const { code, stdout } = await run(path.join(__dirname, 'update.js'), [], { env: envFor(home, { PRAVEX_CLAUDE_BIN: bin }) });

  assert.strictEqual(code, 0);
  assert.deepStrictEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['plugin marketplace update pravex', 'plugin update pravex@pravex']);
  assert.match(stdout, /\/reload-plugins/);
  assert.ok(!fs.existsSync(path.join(home, '.pravex', 'update-check.json')));
});

test('/pravex:update says so when there is nothing to update', async () => {
  const home = tempHome();
  const { bin } = fakeClaude(home, 'pravex is already at the latest version (0.5.1).');
  const { stdout } = await run(path.join(__dirname, 'update.js'), [], { env: envFor(home, { PRAVEX_CLAUDE_BIN: bin }) });
  assert.match(stdout, /already up to date/);
});

test('/pravex:update reports a failed update and exits non-zero', async () => {
  const home = tempHome();
  const { bin } = fakeClaude(home, 'network down', 1);
  const { code, stdout } = await run(path.join(__dirname, 'update.js'), [], { env: envFor(home, { PRAVEX_CLAUDE_BIN: bin }) });
  assert.strictEqual(code, 1);
  assert.match(stdout, /update failed[\s\S]*network down/);
});

test('/pravex:update explains what to run when claude is not on PATH', async () => {
  const home = tempHome();
  const { code, stdout } = await run(path.join(__dirname, 'update.js'), [], {
    env: envFor(home, { PRAVEX_CLAUDE_BIN: path.join(home, 'does-not-exist') }),
  });
  assert.strictEqual(code, 1);
  assert.match(stdout, /claude plugin update pravex@pravex/);
});
