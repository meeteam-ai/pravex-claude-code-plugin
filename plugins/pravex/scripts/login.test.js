'use strict';
/**
 * Tests for `/pravex:login`, `/pravex:status` and logout: the device flow end to
 * end, what is printed, and what is stored. The protocol itself (polling, refresh,
 * the lock) is in `auth.test.js`.
 *
 * `node --test`, standard library only. The Pravex API is a real local HTTP server.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-login-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.PRAVEX_ACCESS_TOKEN;
delete process.env.PRAVEX_API_HOST;

const auth = require('./auth.js');
const { clientIdFor, connect, deviceFlow, parseArgs, afterLogin } = require('./login.js');
const { PENDING, oauthServer } = require('./test-support.js');

const LOGIN = path.join(__dirname, 'login.js');
const CONFIG = auth.CONFIG_FILE;
const instantly = { sleep: async () => {} };

/** Captures stdout so a test can assert on what the user is shown. */
function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = original;
    })
    .then((value) => ({ value, output: lines.join('\n') }));
}

const reset = () => {
  for (const f of [CONFIG, auth.LOCK_FILE, path.join(HOME, '.pravex', 'seat.json')]) fs.rmSync(f, { force: true });
};

test('parseArgs accepts --api-url and the older --host as the same flag', () => {
  assert.strictEqual(parseArgs(['--api-url', 'http://localhost:3000']).host, 'http://localhost:3000');
  assert.strictEqual(parseArgs(['--host', 'http://localhost:3000']).host, 'http://localhost:3000');
  assert.strictEqual(parseArgs(['--status']).status, true);
  assert.strictEqual(parseArgs(['--logout']).logout, true);
  assert.strictEqual(parseArgs(['--client', 'codex']).client, 'codex');
  assert.strictEqual(parseArgs([]).host, undefined);
});

test('the client names map to the OAuth client ids', () => {
  assert.strictEqual(clientIdFor(undefined), 'pravex-claude-code');
  assert.strictEqual(clientIdFor('claude-code'), 'pravex-claude-code');
  assert.strictEqual(clientIdFor('codex'), 'pravex-codex');
  assert.strictEqual(clientIdFor('pravex-codex'), 'pravex-codex');
});

test('the device flow shows the code and the page, and never a token', async () => {
  reset();
  const { server, state, host } = await oauthServer({ device: [PENDING, 'approve'] });
  try {
    const { value, output } = await captureLog(() => deviceFlow(host, { noBrowser: true, ...instantly }));

    assert.strictEqual(value.accessToken, 'at2');
    assert.ok(output.includes('WDJB-MJHT'), 'the code is what the person compares');
    assert.ok(output.includes('/api/oauth/device'), 'and the page they approve it on');
    for (const secret of [value.accessToken, value.refreshToken]) {
      assert.ok(!output.includes(secret), 'a credential must never be printed');
    }
    assert.strictEqual(state.deviceAuth[0].form.client_id, 'pravex-claude-code');
  } finally {
    server.close();
  }
});

test('connecting stores the pair, names the account, and caches the seat', async () => {
  reset();
  const { server, state, host } = await oauthServer({ device: ['approve'] });
  try {
    const { value } = await captureLog(() => connect(host, { noBrowser: true, clientId: 'pravex-codex', ...instantly }));

    assert.strictEqual(value.account.email, 'dana@northwind.co');
    const stored = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    assert.deepStrictEqual(
      [stored.version, stored.apiHost, stored.clientId, stored.accessToken, stored.refreshToken],
      [2, host, 'pravex-codex', 'at2', 'rt2'],
    );
    assert.ok(stored.expiresAt > Date.now() + 14 * 60 * 1000);
    assert.strictEqual(fs.statSync(CONFIG).mode & 0o777, 0o600);
    // The first call to the API used the new access token as a Bearer.
    assert.strictEqual(state.apiCalls[0], 'at2');
    assert.strictEqual(state.deviceAuth[0].form.client_id, 'pravex-codex');
  } finally {
    server.close();
  }
});

test('a refused sign-in stores nothing', async () => {
  reset();
  const { server, host } = await oauthServer({ device: [{ status: 400, body: { error: 'access_denied' } }] });
  try {
    await assert.rejects(() => captureLog(() => connect(host, { noBrowser: true, ...instantly })), /refused/);
    assert.ok(!fs.existsSync(CONFIG));
  } finally {
    server.close();
  }
});

test('after a login, "every session is reported" gives way to the seat line when there is none', () => {
  assert.match(afterLogin({ status: 'active' }), /every session is reported/);
  assert.match(afterLogin(null), /every session is reported/);
  assert.match(afterLogin({ status: 'none' }), /^Seat: not assigned\./);
  assert.match(afterLogin({ status: 'suspended' }), /^Seat: paused\./);
});

// ── the command, as a person runs it ────────────────────────────────────────

/** `login.js <args>` with its own HOME. Resolves `{ code, stdout, stderr, lines }`. */
function run(args, home, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LOGIN, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home, PRAVEX_ACCESS_TOKEN: '', PRAVEX_API_HOST: '', ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, lines: stdout.trim().split('\n') }));
  });
}

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-login-cli-'));

/** `/api/me` and `/api/me/seat`, answering `seat`: a seat object, or a bare status code. */
function accountServer(seat) {
  const server = http.createServer((req, res) => {
    const send = (code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (req.url === '/api/me') return send(200, { status: 200, result: { email: 'dana@northwind.co', orgName: 'Northwind' } });
    if (req.url === '/api/me/seat') return typeof seat === 'number' ? send(seat, { status: seat }) : send(200, { status: 200, result: seat });
    return send(404, {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, host: `http://127.0.0.1:${server.address().port}` })));
}

const staticToken = (host) => ({ PRAVEX_ACCESS_TOKEN: 'test-access-token', PRAVEX_API_HOST: host });
const workspace = { id: 'org-1', name: 'Northwind' };

for (const [label, seat, line] of [
  ['an active seat', { status: 'active', workspace, admins: [], requestedAt: null, message: null }, 'Seat: active. Every session is reported when it ends.'],
  ['no seat', { status: 'none', workspace, admins: ['Ana Admin'], requestedAt: null, message: 'x' }, "Seat: not assigned. Sessions on this machine aren't tracked until a workspace admin assigns you one."],
  ['a paused seat', { status: 'suspended', workspace, admins: [], requestedAt: null, message: 'x' }, "Seat: paused. Sessions on this machine aren't tracked until a workspace admin restores it."],
]) {
  test(`/pravex:status says so under the account line for ${label}, and caches it`, async () => {
    const home = tempHome();
    const { server, host } = await accountServer(seat);
    try {
      const { code, lines } = await run(['--status'], home, staticToken(host));
      assert.strictEqual(code, 0);
      assert.deepStrictEqual(lines, [`Pravex: connected to ${host} as dana@northwind.co (Northwind)`, line]);
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, '.pravex', 'seat.json'), 'utf8')).status, seat.status);
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

for (const [label, code] of [
  ['a server from before seats', 404],
  ['a seat check that fails', 500],
]) {
  test(`/pravex:status says nothing about the seat for ${label}`, async () => {
    const home = tempHome();
    const { server, host } = await accountServer(code);
    try {
      const result = await run(['--status'], home, staticToken(host));
      assert.strictEqual(result.code, 0);
      assert.deepStrictEqual(result.lines, [`Pravex: connected to ${host} as dana@northwind.co (Northwind)`]);
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

test('/pravex:status renews an expiring token from the stored login and uses the new one', async () => {
  const home = tempHome();
  const { server, state, host } = await oauthServer();
  try {
    const pair = state.issue();
    fs.mkdirSync(path.join(home, '.pravex'));
    fs.writeFileSync(
      path.join(home, '.pravex', 'config.json'),
      JSON.stringify({ version: 2, apiHost: host, clientId: 'pravex-claude-code', accessToken: pair.access_token, refreshToken: pair.refresh_token, expiresAt: Date.now() + 5000 }),
    );
    const result = await run(['--status'], home);
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.lines[0], /connected to .* as dana@northwind\.co/);
    assert.strictEqual(state.refreshes.length, 1);
    assert.notStrictEqual(state.apiCalls[0], pair.access_token);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('/pravex:status on a machine that never logged in says so', async () => {
  const home = tempHome();
  const result = await run(['--status'], home);
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stdout.trim(), 'Pravex: not configured. Run /pravex:login');
  fs.rmSync(home, { recursive: true, force: true });
});

test('/pravex:status on a revoked connection says it was disconnected and to log in again', async () => {
  const home = tempHome();
  const { server, state, host } = await oauthServer();
  try {
    const pair = state.issue();
    state.revokedGrant = true;
    fs.mkdirSync(path.join(home, '.pravex'));
    fs.writeFileSync(
      path.join(home, '.pravex', 'config.json'),
      JSON.stringify({ version: 2, apiHost: host, accessToken: pair.access_token, refreshToken: pair.refresh_token, expiresAt: Date.now() + 5000 }),
    );
    const result = await run(['--status'], home);
    assert.strictEqual(result.code, 1);
    assert.match(result.stdout, /disconnected.*\/pravex:login/);
    assert.ok(!result.stdout.includes(pair.refresh_token));
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('/pravex:status on a machine still holding a pvx_ key drops it and says to log in again', async () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, '.pravex'));
  fs.writeFileSync(path.join(home, '.pravex', 'config.json'), JSON.stringify({ apiHost: 'http://127.0.0.1:1', apiKey: 'pvx_0000' }));
  const result = await run(['--status'], home);
  assert.strictEqual(result.code, 1);
  assert.match(result.stdout, /API key.*no longer accepts.*\/pravex:login/);
  assert.ok(!fs.readFileSync(path.join(home, '.pravex', 'config.json'), 'utf8').includes('pvx_'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('a pasted key is refused with the reason, not silently accepted', async () => {
  const home = tempHome();
  const result = await run(['--api-url', 'http://127.0.0.1:1', '--key', 'pvx_0000'], home);
  assert.strictEqual(result.code, 1);
  assert.match(result.stderr, /API keys .* are gone/);
  assert.ok(!fs.existsSync(path.join(home, '.pravex', 'config.json')));
  fs.rmSync(home, { recursive: true, force: true });
});

test('--logout revokes the connection, clears the seat cache and the credentials', async () => {
  const home = tempHome();
  const { server, state, host } = await oauthServer();
  try {
    const pair = state.issue();
    fs.mkdirSync(path.join(home, '.pravex'));
    fs.writeFileSync(
      path.join(home, '.pravex', 'config.json'),
      JSON.stringify({ version: 2, apiHost: host, clientId: 'pravex-claude-code', accessToken: pair.access_token, refreshToken: pair.refresh_token, expiresAt: Date.now() + 900_000 }),
    );
    fs.writeFileSync(path.join(home, '.pravex', 'seat.json'), JSON.stringify({ status: 'active', checkedAt: Date.now() }));

    const result = await run(['--logout'], home);

    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /disconnected.*revoked on the server/);
    assert.deepStrictEqual(state.revocations.map((r) => r.token), [pair.refresh_token]);
    const stored = JSON.parse(fs.readFileSync(path.join(home, '.pravex', 'config.json'), 'utf8'));
    assert.strictEqual(stored.refreshToken, undefined);
    assert.ok(!fs.existsSync(path.join(home, '.pravex', 'seat.json')));
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('--logout on a machine that is not connected says so', async () => {
  const home = tempHome();
  const result = await run(['--logout'], home);
  assert.strictEqual(result.code, 0);
  assert.match(result.stdout, /was not connected/);
  fs.rmSync(home, { recursive: true, force: true });
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
