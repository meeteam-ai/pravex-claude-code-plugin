'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { sync } = require('./sync-scripts.js');
const CLI = path.join(__dirname, 'cli.js');

test('install writes the Codex hooks under a temp HOME from the packed layout', () => {
  sync();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-home-'));
  const r = spawnSync(process.execPath, [CLI, 'install'], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);

  const doc = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(doc.hooks).sort(), ['SessionEnd', 'SessionStart', 'Stop']);
  assert.ok(fs.existsSync(path.join(home, '.pravex', 'codex', 'scripts', 'codex-rollout.js')));
});

test('an unknown command explains itself and exits 2', () => {
  const r = spawnSync(process.execPath, [CLI, 'dance'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /usage: pravex-codex/);
});

// `status` runs `login.js`, which requires `seat.js`. A file missing from the
// sync would crash it, and the seat line would quietly disappear.
test('status from the packed layout reaches the seat check', async () => {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  sync();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-home-'));
  const server = http.createServer((req, res) => {
    const send = (body) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 200, result: body }));
    if (req.url === '/api/me') return send({ email: 'dana@northwind.co', orgName: 'Northwind' });
    if (req.url === '/api/me/seat') return send({ status: 'active', workspace: { id: 'o', name: 'Northwind' }, admins: [], requestedAt: null, message: null });
    res.writeHead(404).end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, PRAVEX_ACCESS_TOKEN: 'test-access-token', PRAVEX_API_HOST: `http://127.0.0.1:${server.address().port}` };
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, 'status'], { env });
      let out = '';
      child.stdout.on('data', (c) => (out += c));
      child.on('error', reject);
      child.on('close', () => resolve(out));
    });
    assert.match(stdout, /^Seat: active\. Every session is reported when it ends\.$/m);
    assert.ok(fs.existsSync(path.join(__dirname, 'scripts', 'seat.js')));
  } finally {
    server.close();
  }
});

// This package signs in as its own OAuth client, so its connection is named for
// Codex on the Install page and its refresh token is bound to `pravex-codex`.
test('login asks the server for the pravex-codex client', async () => {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  sync();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-home-'));
  let asked;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      asked = { url: req.url, form: Object.fromEntries(new URLSearchParams(raw)) };
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_client', error_description: 'stop here' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, PRAVEX_ACCESS_TOKEN: '', PRAVEX_API_HOST: '' };
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, 'login', '--api-url', `http://127.0.0.1:${server.address().port}`, '--no-browser'], { env, stdio: 'ignore' });
      child.on('error', reject);
      child.on('close', resolve);
    });
    assert.strictEqual(code, 1);
    assert.strictEqual(asked.url, '/api/oauth/device/auth');
    assert.deepStrictEqual(asked.form, { client_id: 'pravex-codex', scope: 'api' });
  } finally {
    server.close();
  }
});

test('logout from the packed layout reaches the OAuth code and is a no-op when signed out', () => {
  sync();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-home-'));
  const r = spawnSync(process.execPath, [CLI, 'logout'], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /was not connected/);
  assert.ok(fs.existsSync(path.join(__dirname, 'scripts', 'auth.js')));
});
