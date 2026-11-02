'use strict';
/**
 * The hook with OAuth credentials on disk: it renews the access token before a
 * report, retries once after a 401, never spends one refresh token twice across
 * overlapping hooks, and says so when the connection was revoked.
 *
 * Runs the real `report-session.js` against the stand-in OAuth server in
 * `test-support.js`, with an isolated HOME.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { oauthServer, runHook, tempHome, envFor } = require('./test-support.js');

function writeTranscript(home, id) {
  const file = path.join(home, `${id}.jsonl`);
  const at = new Date(Date.now() - 60_000).toISOString();
  const lines = [
    { type: 'user', timestamp: at, message: { role: 'user', content: 'hello' } },
    {
      type: 'assistant',
      timestamp: new Date(Date.now() - 30_000).toISOString(),
      message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [] },
    },
  ];
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return file;
}

function storeLogin(home, host, state, { expiresInMs = 15 * 60 * 1000 } = {}) {
  const pair = state.issue();
  fs.mkdirSync(path.join(home, '.pravex'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.pravex', 'config.json'),
    JSON.stringify({
      version: 2,
      apiHost: host,
      clientId: 'pravex-claude-code',
      accessToken: pair.access_token,
      refreshToken: pair.refresh_token,
      expiresAt: Date.now() + expiresInMs,
    }),
  );
  return pair;
}

const readStored = (home) => JSON.parse(fs.readFileSync(path.join(home, '.pravex', 'config.json'), 'utf8'));
const hookInput = (home, id) => ({ session_id: id, transcript_path: writeTranscript(home, id), cwd: home });

test('the report goes out with a Bearer access token from the stored login', async () => {
  const home = tempHome();
  const { server, state, host } = await oauthServer();
  try {
    const pair = storeLogin(home, host, state);
    const { code } = await runHook(hookInput(home, 'sess-a'), envFor(home), []);
    assert.strictEqual(code, 0);
    assert.strictEqual(state.sessions.length, 1);
    assert.strictEqual(state.sessions[0].externalId, 'sess-a');
    assert.deepStrictEqual(state.apiCalls, [pair.access_token]);
    assert.strictEqual(state.refreshes.length, 0);
  } finally {
    server.close();
  }
});

test('a token about to lapse is renewed first, and the report uses the new one', async () => {
  const home = tempHome();
  const { server, state, host } = await oauthServer();
  try {
    const pair = storeLogin(home, host, state, { expiresInMs: 20_000 });
    await runHook(hookInput(home, 'sess-b'), envFor(home), []);

    assert.strictEqual(state.refreshes.length, 1);
    assert.strictEqual(state.refreshes[0].refresh_token, pair.refresh_token);
    assert.strictEqual(state.sessions.length, 1);
    assert.strictEqual(state.apiCalls[0], readStored(home).accessToken);
    assert.notStrictEqual(state.apiCalls[0], pair.access_token);
  } finally {
    server.close();
  }
});

test('a 401 on a token the clock thought was good renews once and sends the report again', async () => {
  const home = tempHome();
  const { server, state, host } = await oauthServer();
  try {
    const pair = storeLogin(home, host, state);
    state.validAccess.delete(pair.access_token);
    await runHook(hookInput(home, 'sess-c'), envFor(home), []);

    assert.strictEqual(state.refreshes.length, 1);
    assert.strictEqual(state.sessions.length, 1, 'the report was not lost');
    assert.strictEqual(state.apiCalls.length, 2);
  } finally {
    server.close();
  }
});

test('hooks that overlap never spend one refresh token twice', async () => {
  const home = tempHome();
  const { server, state, host } = await oauthServer({ refreshLatencyMs: 200 });
  try {
    storeLogin(home, host, state, { expiresInMs: 10_000 });
    const runs = await Promise.all(
      ['one', 'two', 'three'].map((id) => runHook(hookInput(home, id), envFor(home), [])),
    );
    assert.ok(runs.every((r) => r.code === 0));
    assert.strictEqual(state.refreshes.length, 1);
    assert.strictEqual(state.reused, false, 'reuse would have revoked the connection');
    assert.strictEqual(state.sessions.length, 3);
  } finally {
    server.close();
  }
});

test('a revoked connection: a Stop says so once, drops the credentials, and later hooks stay quiet', async () => {
  const home = tempHome();
  const { server, state, host } = await oauthServer();
  try {
    storeLogin(home, host, state);
    state.revokedGrant = true;

    const first = await runHook(hookInput(home, 'sess-d'), envFor(home), ['--progress']);
    assert.strictEqual(first.code, 0);
    assert.match(JSON.parse(first.stdout).systemMessage, /disconnected.*\/pravex:login/);
    assert.strictEqual(readStored(home).refreshToken, undefined);
    assert.strictEqual(state.sessions.length, 0);

    const second = await runHook(hookInput(home, 'sess-d'), envFor(home), ['--progress']);
    assert.strictEqual(second.stdout, '');
    assert.strictEqual(state.refreshes.length, 1, 'it does not keep asking for a dead connection');
  } finally {
    server.close();
  }
});

test('the next session start after a revocation says to log in again', async () => {
  const home = tempHome();
  const { server, state, host } = await oauthServer();
  try {
    storeLogin(home, host, state);
    state.revokedGrant = true;
    await runHook(hookInput(home, 'sess-e'), envFor(home), ['--progress']);

    const start = await runHook({ session_id: 'sess-f', source: 'startup', cwd: home }, envFor(home), ['--start']);
    assert.match(JSON.parse(start.stdout).systemMessage, /disconnected.*Run \/pravex:login/);
  } finally {
    server.close();
  }
});

test('the final report of a session whose connection was revoked is kept and sent after the next login', async () => {
  const home = tempHome();
  const { server, state, host } = await oauthServer();
  try {
    storeLogin(home, host, state);
    state.revokedGrant = true;
    await runHook(hookInput(home, 'sess-g'), envFor(home), []);

    const spooled = fs.readdirSync(path.join(home, '.pravex', 'spool')).filter((f) => f.endsWith('.json'));
    assert.strictEqual(spooled.length, 1, 'the report waits for a login rather than being dropped');

    // The person logs in again: a fresh grant, and the next session end replays the spool.
    state.revokedGrant = false;
    const pair = state.issue();
    fs.writeFileSync(
      path.join(home, '.pravex', 'config.json'),
      JSON.stringify({ version: 2, apiHost: host, accessToken: pair.access_token, refreshToken: pair.refresh_token, expiresAt: Date.now() + 900_000 }),
    );
    await runHook(hookInput(home, 'sess-h'), envFor(home), []);

    assert.deepStrictEqual(state.sessions.map((s) => s.externalId).sort(), ['sess-g', 'sess-h']);
    assert.deepStrictEqual(fs.readdirSync(path.join(home, '.pravex', 'spool')).filter((f) => f.endsWith('.json')), []);
  } finally {
    server.close();
  }
});

test('a machine still holding a pvx_ key is told to log in again at session start, and the key is gone', async () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, '.pravex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.pravex', 'config.json'), JSON.stringify({ apiHost: 'http://127.0.0.1:1', apiKey: 'pvx_0000' }));

  const start = await runHook({ session_id: 'sess-i', source: 'startup', cwd: home }, envFor(home), ['--start']);

  assert.match(JSON.parse(start.stdout).systemMessage, /pvx_.*no longer accepts.*\/pravex:login/);
  assert.ok(!fs.readFileSync(path.join(home, '.pravex', 'config.json'), 'utf8').includes('pvx_0000'));
});

test('the status line asks for a login with no refresh token, and shows recording with one', async () => {
  const { spawnSync } = require('node:child_process');
  const home = tempHome();
  const statusline = path.join(__dirname, 'statusline.js');
  const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').trim();
  const show = () => plain(spawnSync(process.execPath, [statusline], { env: envFor(home), input: '{"session_id":"x"}', encoding: 'utf8' }).stdout);

  fs.mkdirSync(path.join(home, '.pravex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.pravex', 'config.json'), JSON.stringify({ apiHost: 'http://127.0.0.1:1', signedOut: 'revoked' }));
  assert.match(show(), /⚠ Pravex: \/pravex:login/);

  fs.writeFileSync(path.join(home, '.pravex', 'config.json'), JSON.stringify({ version: 2, apiHost: 'http://127.0.0.1:1', accessToken: 'a', refreshToken: 'r', expiresAt: 1 }));
  assert.strictEqual(show(), '● Pravex');
});
