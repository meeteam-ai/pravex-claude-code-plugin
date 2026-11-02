'use strict';
/**
 * Tests for `auth.js`: the device grant, polling, refresh-token rotation behind a
 * lock file, and what happens when the connection is revoked.
 *
 * Driven against a real local HTTP server that behaves like the Pravex OAuth
 * server where it matters here: refresh tokens rotate, and presenting a used one
 * revokes the whole connection (pravex-backend `docs/AUTH.md`). A mocked transport
 * would hide exactly the races these tests are about.
 *
 * HOME is set before `auth.js` is required, because its paths are resolved from
 * `os.homedir()` at load time. `node --test` gives each file its own process.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-auth-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.PRAVEX_ACCESS_TOKEN;
delete process.env.PRAVEX_API_HOST;

const auth = require('./auth.js');

const CONFIG = auth.CONFIG_FILE;
const { PENDING, oauthServer } = require('./test-support.js');

/** Put a stored login on disk: a pair that the server knows (`state.issue`) and an `expiresAt`. */
function storeLogin(host, state, { expiresInMs = 15 * 60 * 1000, clientId = 'pravex-claude-code' } = {}) {
  const pair = state.issue();
  auth.writeConfigAtomic({
    apiHost: host,
    clientId,
    accessToken: pair.access_token,
    refreshToken: pair.refresh_token,
    expiresAt: Date.now() + expiresInMs,
  });
  return pair;
}

const readStored = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const reset = () => {
  for (const f of [CONFIG, auth.LOCK_FILE]) fs.rmSync(f, { force: true });
};

// ── the device grant ────────────────────────────────────────────────────────

test('it starts the device grant form-encoded, as the right client, asking for the api scope', async () => {
  const { server, state, host } = await oauthServer();
  try {
    const start = await auth.startDeviceAuth(host, 'pravex-codex');
    assert.strictEqual(start.user_code, 'WDJB-MJHT');
    assert.ok(start.verification_uri_complete.endsWith('?user_code=WDJB-MJHT'));
    assert.strictEqual(state.deviceAuth[0].type, 'application/x-www-form-urlencoded');
    assert.deepStrictEqual(state.deviceAuth[0].form, { client_id: 'pravex-codex', scope: 'api' });
  } finally {
    server.close();
  }
});

test('the Claude Code client is the default', async () => {
  const { server, state, host } = await oauthServer();
  try {
    await auth.startDeviceAuth(host);
    assert.strictEqual(state.deviceAuth[0].form.client_id, 'pravex-claude-code');
  } finally {
    server.close();
  }
});

test('a host that is not the Pravex API is called out rather than reported as a bare status', async () => {
  const server = http.createServer((req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(() => auth.startDeviceAuth(`http://127.0.0.1:${server.address().port}`), /did not answer like the Pravex API/);
  } finally {
    server.close();
  }
});

/** A clock and a `sleep` that moves it, so polling takes no real time and every wait is on record. */
function fakeTime() {
  const time = { at: 1_000_000, waits: [] };
  return {
    time,
    now: () => time.at,
    sleep: async (ms) => {
      time.waits.push(ms);
      time.at += ms;
    },
  };
}

test('polling waits the interval before every poll, keeps the same device code, and ends on approval', async () => {
  const { server, state, host } = await oauthServer({ device: [PENDING, PENDING, 'approve'] });
  const clock = fakeTime();
  try {
    const start = await auth.startDeviceAuth(host);
    const tokens = await auth.pollDeviceToken(host, start, { clientId: 'pravex-claude-code', ...clock });

    assert.deepStrictEqual(clock.time.waits, [5000, 5000, 5000], 'no faster than every 5 s, first poll included');
    assert.strictEqual(state.polls.length, 3);
    for (const poll of state.polls) {
      assert.deepStrictEqual(poll, { grant_type: auth.DEVICE_GRANT, device_code: 'dev-code-1', client_id: 'pravex-claude-code' });
    }
    assert.strictEqual(tokens.accessToken, 'at2');
    assert.strictEqual(tokens.refreshToken, 'rt2');
    assert.strictEqual(tokens.expiresAt, clock.time.at + 900 * 1000);
  } finally {
    server.close();
  }
});

test('slow_down adds five seconds to every wait from then on', async () => {
  const slow = { status: 400, body: { error: 'slow_down' } };
  const { server, host } = await oauthServer({ device: [PENDING, slow, PENDING, slow, 'approve'] });
  const clock = fakeTime();
  try {
    await auth.pollDeviceToken(host, await auth.startDeviceAuth(host), clock);
    assert.deepStrictEqual(clock.time.waits, [5000, 5000, 10000, 10000, 15000]);
  } finally {
    server.close();
  }
});

test('a refusal in the browser is final: one poll, no retry', async () => {
  const { server, state, host } = await oauthServer({ device: [{ status: 400, body: { error: 'access_denied' } }] });
  try {
    await assert.rejects(() => auth.pollDeviceToken(host, { device_code: 'x', expires_in: 600 }, fakeTime()), /refused in the browser/);
    assert.strictEqual(state.polls.length, 1);
  } finally {
    server.close();
  }
});

test('an expired code is final and points at logging in again', async () => {
  const { server, state, host } = await oauthServer({ device: [PENDING, { status: 400, body: { error: 'expired_token' } }] });
  try {
    await assert.rejects(() => auth.pollDeviceToken(host, { device_code: 'x', expires_in: 600 }, fakeTime()), /expired\. Run \/pravex:login again/);
    assert.strictEqual(state.polls.length, 2);
  } finally {
    server.close();
  }
});

test('it gives up when the code\u2019s lifetime runs out, whatever the server keeps answering', async () => {
  const { server, state, host } = await oauthServer({ device: [PENDING] });
  const clock = fakeTime();
  try {
    await assert.rejects(() => auth.pollDeviceToken(host, { device_code: 'x', expires_in: 30 }, clock), /Timed out/);
    assert.strictEqual(state.polls.length, 6, '30 s at one poll per 5 s');
  } finally {
    server.close();
  }
});

test('it never polls for longer than ten minutes even if the server offers more', async () => {
  const { server, host } = await oauthServer({ device: [PENDING] });
  const clock = fakeTime();
  try {
    await assert.rejects(() => auth.pollDeviceToken(host, { device_code: 'x', expires_in: 86400 }, clock), /Timed out/);
    assert.ok(clock.time.waits.reduce((a, b) => a + b, 0) <= 10 * 60 * 1000 + 5000);
  } finally {
    server.close();
  }
});

test('a server error mid-poll is retried, and the sign-in still completes', async () => {
  const { server, host } = await oauthServer({ device: [{ status: 502, body: {} }, PENDING, 'approve'] });
  try {
    const tokens = await auth.pollDeviceToken(host, { device_code: 'x', expires_in: 600 }, fakeTime());
    assert.ok(tokens.accessToken);
  } finally {
    server.close();
  }
});

test('it stops after repeated failures instead of waiting out the whole code', async () => {
  const { server, state, host } = await oauthServer({ device: [{ status: 500, body: {} }] });
  try {
    await assert.rejects(() => auth.pollDeviceToken(host, { device_code: 'x', expires_in: 600 }, fakeTime()), /sign-in failed/);
    assert.strictEqual(state.polls.length, 5);
  } finally {
    server.close();
  }
});

test('any other OAuth error is reported, not retried', async () => {
  const { server, state, host } = await oauthServer({ device: [{ status: 400, body: { error: 'invalid_client', error_description: 'unknown client' } }] });
  try {
    await assert.rejects(() => auth.pollDeviceToken(host, { device_code: 'x', expires_in: 600 }, fakeTime()), /unknown client/);
    assert.strictEqual(state.polls.length, 1);
  } finally {
    server.close();
  }
});

// ── storing the pair ────────────────────────────────────────────────────────

test('the stored pair is readable only by its owner, and is written whole', () => {
  reset();
  auth.writeConfigAtomic({ apiHost: 'https://pravex.test', clientId: 'pravex-codex', accessToken: 'a', refreshToken: 'r', expiresAt: 5 });
  assert.strictEqual(fs.statSync(CONFIG).mode & 0o777, 0o600);
  assert.deepStrictEqual(readStored(), { version: 2, apiHost: 'https://pravex.test', clientId: 'pravex-codex', accessToken: 'a', refreshToken: 'r', expiresAt: 5 });
  assert.deepStrictEqual(fs.readdirSync(path.dirname(CONFIG)).filter((f) => f.endsWith('.tmp')), [], 'no temporary file left behind');
});

test('it tightens the permissions of a config file that already existed looser', () => {
  reset();
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, '{}', { mode: 0o644 });
  fs.chmodSync(CONFIG, 0o644);
  auth.writeConfigAtomic({ apiHost: 'https://pravex.test' });
  assert.strictEqual(fs.statSync(CONFIG).mode & 0o777, 0o600);
});

test('a config from before OAuth is dropped with a message to log in again, keeping the host', () => {
  reset();
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify({ apiHost: 'https://pravex.test', apiKey: 'pvx_0000' }));

  const config = auth.readConfig();
  assert.strictEqual(config.apiKey, undefined);
  assert.strictEqual(config.signedOut, 'legacy-key');

  const onDisk = readStored();
  assert.ok(!JSON.stringify(onDisk).includes('pvx_'), 'the old key must not stay on disk');
  assert.strictEqual(onDisk.apiHost, 'https://pravex.test');
  assert.match(auth.messageFor('legacy-key'), /Run \/pravex:login to connect again/);
});

test('a machine with the old key reports itself as needing a login, without calling the server', async () => {
  reset();
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify({ apiHost: 'http://127.0.0.1:1', apiKey: 'pvx_0000' }));
  const result = await auth.getCredentials({ env: {} });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'legacy-key');
  assert.match(result.message, /pvx_/);
  assert.match(result.message, /\/pravex:login/);
});

test('never signed in is its own state, not an error', async () => {
  reset();
  const result = await auth.getCredentials({ env: {} });
  assert.deepStrictEqual([result.ok, result.reason], [false, 'signed-out']);
});

test('the environment token wins and is never renewed', async () => {
  reset();
  const env = { PRAVEX_ACCESS_TOKEN: 'static', PRAVEX_API_HOST: 'http://127.0.0.1:1/' };
  const creds = await auth.getCredentials({ env });
  assert.deepStrictEqual([creds.ok, creds.accessToken, creds.apiHost], [true, 'static', 'http://127.0.0.1:1']);
});

// ── refreshing ──────────────────────────────────────────────────────────────

test('a token with time left is used as it is: no request to the server', async () => {
  reset();
  const { server, state, host } = await oauthServer();
  try {
    const pair = storeLogin(host, state);
    const creds = await auth.getCredentials({ env: {} });
    assert.deepStrictEqual([creds.ok, creds.accessToken], [true, pair.access_token]);
    assert.strictEqual(state.refreshes.length, 0);
  } finally {
    server.close();
  }
});

test('it refreshes a minute before the token lapses, not after', async () => {
  reset();
  const { server, state, host } = await oauthServer();
  try {
    const first = storeLogin(host, state, { expiresInMs: 59 * 1000 });
    const creds = await auth.getCredentials({ env: {} });
    assert.strictEqual(state.refreshes.length, 1);
    assert.notStrictEqual(creds.accessToken, first.access_token);
  } finally {
    server.close();
  }
});

test('a token with just over a minute left is not refreshed yet', async () => {
  reset();
  const { server, state, host } = await oauthServer();
  try {
    storeLogin(host, state, { expiresInMs: 90 * 1000 });
    await auth.getCredentials({ env: {} });
    assert.strictEqual(state.refreshes.length, 0);
  } finally {
    server.close();
  }
});

test('the rotated pair is on disk before the new access token is handed out', async () => {
  reset();
  const { server, state, host } = await oauthServer();
  try {
    const first = storeLogin(host, state, { expiresInMs: 1000 });
    const creds = await auth.getCredentials({ env: {} });
    const stored = readStored();
    assert.strictEqual(stored.accessToken, creds.accessToken);
    assert.notStrictEqual(stored.refreshToken, first.refresh_token, 'the used refresh token is gone');
    assert.strictEqual(state.refreshes[0].refresh_token, first.refresh_token);
    assert.strictEqual(state.refreshes[0].client_id, 'pravex-claude-code');
    assert.ok(stored.expiresAt > Date.now() + 14 * 60 * 1000);
    assert.strictEqual(stored.apiHost, host);
  } finally {
    server.close();
  }
});

test('a refresh keeps the client the login was made with', async () => {
  reset();
  const { server, state, host } = await oauthServer();
  try {
    storeLogin(host, state, { expiresInMs: 1000, clientId: 'pravex-codex' });
    await auth.getCredentials({ env: {} });
    assert.strictEqual(state.refreshes[0].client_id, 'pravex-codex');
    assert.strictEqual(readStored().clientId, 'pravex-codex');
  } finally {
    server.close();
  }
});

test('overlapping refreshes in one process share a single use of the refresh token', async () => {
  reset();
  const { server, state, host } = await oauthServer({ refreshLatencyMs: 60 });
  try {
    storeLogin(host, state, { expiresInMs: 1000 });
    const results = await Promise.all(Array.from({ length: 6 }, () => auth.getCredentials({ env: {} })));
    assert.strictEqual(state.refreshes.length, 1);
    assert.strictEqual(state.reused, false);
    assert.strictEqual(new Set(results.map((r) => r.accessToken)).size, 1, 'everyone ends up with the same pair');
  } finally {
    server.close();
  }
});

test('hooks in separate processes serialise on the lock file: one refresh, no reuse, nobody revoked', async () => {
  reset();
  const { server, state, host } = await oauthServer({ refreshLatencyMs: 150 });
  try {
    storeLogin(host, state, { expiresInMs: 1000 });
    const script = `require(${JSON.stringify(path.join(__dirname, 'auth.js'))}).getCredentials({ env: {} }).then((r) => console.log(JSON.stringify(r)));`;
    const run = () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, HOME }, stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        child.stdout.on('data', (c) => (out += c));
        child.on('error', reject);
        child.on('close', () => resolve(JSON.parse(out)));
      });
    const results = await Promise.all([run(), run(), run(), run()]);

    assert.strictEqual(state.refreshes.length, 1, 'the refresh token was spent exactly once');
    assert.strictEqual(state.reused, false);
    assert.ok(results.every((r) => r.ok));
    assert.strictEqual(new Set(results.map((r) => r.accessToken)).size, 1);
    assert.strictEqual(readStored().accessToken, results[0].accessToken);
    assert.ok(!fs.existsSync(auth.LOCK_FILE), 'the lock is released');
  } finally {
    server.close();
  }
});

test('two refreshes a token apart each rotate cleanly', async () => {
  reset();
  const { server, state, host } = await oauthServer();
  try {
    storeLogin(host, state, { expiresInMs: 1000 });
    const one = await auth.getCredentials({ env: {} });
    // Lapse the new pair on disk, as 15 minutes would.
    auth.writeConfigAtomic({ ...readStored(), expiresAt: Date.now() + 1000 });
    const two = await auth.getCredentials({ env: {} });
    assert.strictEqual(state.refreshes.length, 2);
    assert.strictEqual(state.reused, false);
    assert.notStrictEqual(one.accessToken, two.accessToken);
  } finally {
    server.close();
  }
});

test('a lock left by a killed hook is broken once it is stale', async () => {
  reset();
  const { server, state, host } = await oauthServer();
  try {
    storeLogin(host, state, { expiresInMs: 1000 });
    fs.writeFileSync(auth.LOCK_FILE, 'dead-process');
    const old = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(auth.LOCK_FILE, old, old);

    const creds = await auth.getCredentials({ env: {} });
    assert.strictEqual(creds.ok, true);
    assert.strictEqual(state.refreshes.length, 1);
    assert.ok(!fs.existsSync(auth.LOCK_FILE));
  } finally {
    server.close();
  }
});

test('a live lock is waited for, and not stolen', async () => {
  reset();
  fs.mkdirSync(path.dirname(auth.LOCK_FILE), { recursive: true });
  fs.writeFileSync(auth.LOCK_FILE, 'someone-else');
  let ran = false;
  const outcome = await auth.withLock(
    async () => {
      ran = true;
    },
    { waitMs: 150 },
  );
  assert.deepStrictEqual(outcome, { locked: false });
  assert.strictEqual(ran, false);
  assert.strictEqual(fs.readFileSync(auth.LOCK_FILE, 'utf8'), 'someone-else', 'someone else\u2019s lock is left alone');
  fs.unlinkSync(auth.LOCK_FILE);
});

test('the lock is released when the work inside it throws', async () => {
  reset();
  await assert.rejects(() => auth.withLock(async () => Promise.reject(new Error('boom'))), /boom/);
  assert.ok(!fs.existsSync(auth.LOCK_FILE));
});

test('when the lock cannot be had, it falls back to the pair another process just wrote', async () => {
  reset();
  const { server, state, host } = await oauthServer();
  try {
    storeLogin(host, state, { expiresInMs: 1000 });
    fs.writeFileSync(auth.LOCK_FILE, 'busy');
    // Simulate the holder finishing: a fresh pair appears while we wait.
    setTimeout(() => auth.writeConfigAtomic({ ...readStored(), accessToken: 'from-the-other-hook', expiresAt: Date.now() + 900_000 }), 100);
    setTimeout(() => fs.rmSync(auth.LOCK_FILE, { force: true }), 200);
    const creds = await auth.getCredentials({ env: {} });
    assert.strictEqual(creds.accessToken, 'from-the-other-hook');
    assert.strictEqual(state.refreshes.length, 0, 'it used the other hook\u2019s pair instead of spending its own');
  } finally {
    server.close();
  }
});

// ── revocation ──────────────────────────────────────────────────────────────

test('a refresh the server refuses as invalid_grant drops the credentials and says to log in again', async () => {
  reset();
  const { server, state, host } = await oauthServer();
  try {
    storeLogin(host, state, { expiresInMs: 1000 });
    state.revokedGrant = true;

    const creds = await auth.getCredentials({ env: {} });
    assert.deepStrictEqual([creds.ok, creds.reason], [false, 'revoked']);
    assert.match(creds.message, /disconnected/);
    assert.match(creds.message, /\/pravex:login/);

    const stored = readStored();
    assert.strictEqual(stored.refreshToken, undefined);
    assert.strictEqual(stored.accessToken, undefined);
    assert.strictEqual(stored.signedOut, 'revoked');
    assert.strictEqual(stored.apiHost, host, 'the host is kept so the next login goes to the same place');

    // And it stays that way without asking the server again.
    const again = await auth.getCredentials({ env: {} });
    assert.strictEqual(again.reason, 'revoked');
    assert.strictEqual(state.refreshes.length, 1);
  } finally {
    server.close();
  }
});

test('an unreachable server does not cost the credentials: it is retried on the next run', async () => {
  reset();
  const { server, state, host } = await oauthServer();
  try {
    const pair = storeLogin(host, state, { expiresInMs: 1000 });
    state.refreshOverride = { status: 503, body: {} };

    const creds = await auth.getCredentials({ env: {} });
    assert.deepStrictEqual([creds.ok, creds.reason], [false, 'unavailable']);
    assert.strictEqual(creds.accessToken, pair.access_token, 'the stale token is still offered to a hook that wants to try');
    assert.strictEqual(readStored().refreshToken, pair.refresh_token, 'the refresh token was not thrown away');

    state.refreshOverride = null;
    assert.strictEqual((await auth.getCredentials({ env: {} })).ok, true);
  } finally {
    server.close();
  }
});

test('a refused connection is not mistaken for a revocation either', async () => {
  reset();
  auth.writeConfigAtomic({ apiHost: 'http://127.0.0.1:1', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1000 });
  const creds = await auth.getCredentials({ env: {} });
  assert.strictEqual(creds.reason, 'unavailable');
  assert.strictEqual(readStored().refreshToken, 'r');
});

test('a 401 on a live token refreshes once and retries, so an expiry the clock missed costs nothing', async () => {
  reset();
  const { server, state, host } = await oauthServer();
  try {
    const pair = storeLogin(host, state);
    state.validAccess.delete(pair.access_token); // the server no longer honours it, whatever its exp says

    const creds = await auth.getCredentials({ env: {} });
    const res = await auth.authorized(creds, '/api/me');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(state.refreshes.length, 1);
    assert.deepStrictEqual(state.apiCalls, [pair.access_token, readStored().accessToken]);
  } finally {
    server.close();
  }
});

test('a 401 from a revoked grant ends in "revoked", not a loop', async () => {
  reset();
  const { server, state, host } = await oauthServer();
  try {
    storeLogin(host, state);
    state.revokedGrant = true;

    const creds = await auth.getCredentials({ env: {} });
    const res = await auth.authorized(creds, '/api/me');

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.revoked, true);
    assert.strictEqual(state.refreshes.length, 1);
    assert.strictEqual(readStored().signedOut, 'revoked');
  } finally {
    server.close();
  }
});

test('refreshAfterRejection hands over another hook\u2019s newer pair instead of spending the refresh token again', async () => {
  reset();
  const { server, state, host } = await oauthServer();
  try {
    const old = storeLogin(host, state);
    // Another hook already refreshed.
    auth.writeConfigAtomic({ ...readStored(), accessToken: 'newer', expiresAt: Date.now() + 900_000 });
    const next = await auth.refreshAfterRejection(old.access_token, { env: {} });
    assert.deepStrictEqual([next.ok, next.accessToken], [true, 'newer']);
    assert.strictEqual(state.refreshes.length, 0);
  } finally {
    server.close();
  }
});

test('a static environment token that is refused is reported, not refreshed', async () => {
  const next = await auth.refreshAfterRejection('static', { env: { PRAVEX_ACCESS_TOKEN: 'static', PRAVEX_API_HOST: 'http://127.0.0.1:1' } });
  assert.deepStrictEqual([next.ok, next.reason], [false, 'static']);
});

// ── login and logout ────────────────────────────────────────────────────────

test('logging out revokes the refresh token on the server and removes the credentials', async () => {
  reset();
  const { server, state, host } = await oauthServer();
  try {
    const pair = storeLogin(host, state, { clientId: 'pravex-codex' });
    const result = await auth.logout();

    assert.deepStrictEqual(result, { wasConnected: true, revoked: true });
    assert.deepStrictEqual(state.revocations, [{ token: pair.refresh_token, token_type_hint: 'refresh_token', client_id: 'pravex-codex' }]);
    const stored = readStored();
    assert.strictEqual(stored.refreshToken, undefined);
    assert.strictEqual(stored.accessToken, undefined);
    assert.strictEqual(stored.apiHost, host);
    assert.deepStrictEqual((await auth.getCredentials({ env: {} })).reason, 'signed-out');
  } finally {
    server.close();
  }
});

test('logging out offline still removes the credentials, and says the server was not told', async () => {
  reset();
  auth.writeConfigAtomic({ apiHost: 'http://127.0.0.1:1', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 900_000 });
  const result = await auth.logout();
  assert.deepStrictEqual(result, { wasConnected: true, revoked: false });
  assert.strictEqual(readStored().refreshToken, undefined);
});

test('logging out when not connected is a no-op that says so', async () => {
  reset();
  assert.deepStrictEqual(await auth.logout(), { wasConnected: false, revoked: false });
});

test('a new login replaces the stored pair and revokes the connection it replaces', async () => {
  reset();
  const { server, state, host } = await oauthServer();
  try {
    const previous = storeLogin(host, state);
    await auth.saveLogin(host, 'pravex-codex', { accessToken: 'new-a', refreshToken: 'new-r', expiresAt: Date.now() + 900_000 });

    const stored = readStored();
    assert.deepStrictEqual([stored.accessToken, stored.refreshToken, stored.clientId], ['new-a', 'new-r', 'pravex-codex']);
    assert.strictEqual(state.revocations.length, 1);
    assert.strictEqual(state.revocations[0].token, previous.refresh_token);
  } finally {
    server.close();
  }
});

test('a login clears the "signed out" record', async () => {
  reset();
  auth.writeConfigAtomic({ apiHost: 'https://pravex.test', signedOut: 'revoked' });
  await auth.saveLogin('https://pravex.test', 'pravex-claude-code', { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 900_000 });
  assert.strictEqual(readStored().signedOut, undefined);
});

test('the first login with nothing stored revokes nothing', async () => {
  reset();
  const { server, state, host } = await oauthServer();
  try {
    await auth.saveLogin(host, 'pravex-claude-code', { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 900_000 });
    assert.strictEqual(state.revocations.length, 0);
  } finally {
    server.close();
  }
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
