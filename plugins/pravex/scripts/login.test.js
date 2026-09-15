'use strict';
/**
 * Tests for `/pravex:login` — the device flow.
 *
 * `node --test`. Standard library only, like the rest of the plugin: this runs
 * inside someone else's session and must not pull anything at install time.
 *
 * The device flow is driven against a **real local HTTP server** rather than a
 * stubbed `request`. What is worth asserting here is the conversation — that the
 * poll honours `slow_down`, that a denial is not retried, that a credential is
 * never printed — and none of that is visible if the transport is mocked away.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { deviceFlow, parseArgs, unwrap, writeConfig } = require('./login.js');

/** Synthetic. Nothing in this file is a real credential. */
const FAKE_KEY = 'pvx_0000000000000000000000000000000000000000000000';

/**
 * A stand-in Pravex API.
 *
 * `answers` is a queue of poll results, so a test describes the sequence the
 * server will give back rather than the internals of the loop.
 */
function startServer({ answers, interval = 0.01, expiresIn = 5 }) {
  const seen = { codeRequests: [], polls: [], pollTimes: [] };
  const queue = [...answers];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      const send = (result) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 200, result }));
      };

      if (req.url === '/api/auth/device/code') {
        seen.codeRequests.push(json);
        const base = `http://127.0.0.1:${server.address().port}`;
        return send({
          deviceCode: 'device-code-abc',
          userCode: 'WDJB-MJHT',
          verificationUri: `${base}/link`,
          verificationUriComplete: `${base}/link?code=WDJB-MJHT`,
          interval,
          expiresIn,
        });
      }
      if (req.url === '/api/auth/device/token') {
        seen.polls.push(json);
        seen.pollTimes.push(Date.now());
        return send(queue.length > 1 ? queue.shift() : queue[0]);
      }
      res.writeHead(404).end('{}');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, host: `http://127.0.0.1:${server.address().port}` }));
  });
}

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

test('parseArgs accepts --api-url and the older --host as the same flag', () => {
  assert.strictEqual(parseArgs(['--api-url', 'http://localhost:3000']).host, 'http://localhost:3000');
  assert.strictEqual(parseArgs(['--host', 'http://localhost:3000']).host, 'http://localhost:3000');
  assert.strictEqual(parseArgs(['--status']).status, true);
  assert.strictEqual(parseArgs([]).host, undefined);
});

test('parseArgs reads a key when one is given', () => {
  assert.strictEqual(parseArgs(['--key', FAKE_KEY]).key, FAKE_KEY);
});

test('unwrap reads the envelope, and reports an error message rather than a status code', () => {
  assert.deepStrictEqual(unwrap({ status: 200, body: '{"status":200,"result":{"a":1}}' }, 'h'), { a: 1 });
  // An older build without the envelope still parses.
  assert.deepStrictEqual(unwrap({ status: 200, body: '{"a":1}' }, 'h'), { a: 1 });
  assert.throws(
    () => unwrap({ status: 404, body: '{"error":{"message":"That code is not valid."}}' }, 'h'),
    /That code is not valid/,
  );
  assert.throws(() => unwrap({ status: 200, body: '<html>' }, 'example.test'), /example\.test did not return JSON/);
});

test('the device flow collects a credential without ever printing one', async () => {
  const { server, seen, host } = await startServer({
    answers: [{ status: 'pending' }, { status: 'approved', apiKey: FAKE_KEY, account: { email: 'ada@b.test', orgName: 'Northwind' } }],
  });
  try {
    const { value, output } = await captureLog(() => deviceFlow(host, { noBrowser: true }));

    assert.strictEqual(value.status, 'approved');
    assert.strictEqual(value.apiKey, FAKE_KEY);

    // The entire point of the grant: the key is never on screen.
    assert.ok(!output.includes(FAKE_KEY), 'the credential must never be printed');
    // The short code and the URL are, because those are what the person needs.
    assert.ok(output.includes('WDJB-MJHT'));
    assert.ok(output.includes('/link'));
  } finally {
    server.close();
  }
});

test('it tells the server what it is, so the approval screen can name it', async () => {
  const { server, seen, host } = await startServer({ answers: [{ status: 'approved', apiKey: FAKE_KEY, account: {} }] });
  try {
    await captureLog(() => deviceFlow(host, { noBrowser: true }));

    assert.match(seen.codeRequests[0].clientName, /^Claude Code on /);
  } finally {
    server.close();
  }
});

test('it keeps polling with the same device code until the answer changes', async () => {
  const { server, seen, host } = await startServer({
    answers: [{ status: 'pending' }, { status: 'pending' }, { status: 'approved', apiKey: FAKE_KEY, account: {} }],
  });
  try {
    await captureLog(() => deviceFlow(host, { noBrowser: true }));

    assert.ok(seen.polls.length >= 3);
    for (const poll of seen.polls) assert.strictEqual(poll.deviceCode, 'device-code-abc');
  } finally {
    server.close();
  }
});

// The server enforces `slow_down` by raising the floor, so a client that ignores
// it only makes every later poll slower. Honouring it is the client's half.
test('it slows down when the server says to', async () => {
  const { server, seen, host } = await startServer({
    answers: [{ status: 'slow_down', interval: 0.25 }, { status: 'approved', apiKey: FAKE_KEY, account: {} }],
    interval: 0.01,
  });
  try {
    await captureLog(() => deviceFlow(host, { noBrowser: true }));

    const gap = seen.pollTimes[1] - seen.pollTimes[0];
    assert.ok(gap >= 200, `expected the second poll to wait ~250ms, waited ${gap}ms`);
  } finally {
    server.close();
  }
});

test('a refusal stops immediately and says so', async () => {
  const { server, seen, host } = await startServer({ answers: [{ status: 'denied' }] });
  try {
    await assert.rejects(() => captureLog(() => deviceFlow(host, { noBrowser: true })), /refused/i);
    // One poll, not a loop: a denial is final and retrying it is noise.
    assert.strictEqual(seen.polls.length, 1);
  } finally {
    server.close();
  }
});

test('an expired code stops and points at running the command again', async () => {
  const { server, host } = await startServer({ answers: [{ status: 'expired' }] });
  try {
    await assert.rejects(() => captureLog(() => deviceFlow(host, { noBrowser: true })), /\/pravex:login again/);
  } finally {
    server.close();
  }
});

// Without a ceiling, a server that answered `pending` forever would leave the
// command hanging in the user's session with no way out but Ctrl-C.
test('it gives up rather than polling forever', async () => {
  const { server, host } = await startServer({ answers: [{ status: 'pending' }], interval: 0.01, expiresIn: 0.3 });
  try {
    await assert.rejects(() => captureLog(() => deviceFlow(host, { noBrowser: true })), /Timed out/);
  } finally {
    server.close();
  }
});

// `CONFIG_FILE` is resolved from `os.homedir()` at require time, so this runs the
// real `writeConfig` in a child process with an isolated HOME rather than
// asserting around it — and rather than writing into the developer's own config,
// which an earlier version of the sibling suite did.
test('the stored credential is readable only by its owner', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-login-'));
  try {
    const script = `const { writeConfig } = require(${JSON.stringify(path.join(__dirname, 'login.js'))});
      writeConfig('https://pravex.test', ${JSON.stringify(FAKE_KEY)});`;

    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exited ${code}`))));
    });

    const configFile = path.join(home, '.pravex', 'config.json');
    assert.strictEqual(fs.statSync(configFile).mode & 0o777, 0o600, 'config.json must not be world-readable');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), {
      apiHost: 'https://pravex.test',
      apiKey: FAKE_KEY,
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// `mode` on writeFileSync only applies when the file is created, so an existing
// looser file would keep its permissions and leave the credential readable by
// everyone on the machine. The explicit chmod is what closes that.
test('it tightens the permissions of a config file that already existed', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-login-'));
  try {
    fs.mkdirSync(path.join(home, '.pravex'), { recursive: true });
    const configFile = path.join(home, '.pravex', 'config.json');
    fs.writeFileSync(configFile, '{}', { mode: 0o644 });
    fs.chmodSync(configFile, 0o644);

    const script = `const { writeConfig } = require(${JSON.stringify(path.join(__dirname, 'login.js'))});
      writeConfig('https://pravex.test', ${JSON.stringify(FAKE_KEY)});`;
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exited ${code}`))));
    });

    assert.strictEqual(fs.statSync(configFile).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
