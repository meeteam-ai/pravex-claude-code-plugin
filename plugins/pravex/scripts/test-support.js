'use strict';
/**
 * Shared scaffolding for the hook tests: an isolated HOME, a stand-in for the
 * Pravex API that captures every POST, and a runner that drives the real hook
 * with a payload on stdin. Not a `*.test.js`, so `node --test` does not run it.
 */
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPORT = path.join(__dirname, 'report-session.js');

/** A HOME nothing real lives in, so `~/.pravex`, `~/.claude` and `~/.codex` are the test's own. */
const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-home-'));

/** Env for a child: isolated HOME and, when a port is given, credentials pointing at the capture server. */
function envFor(home, port) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.PRAVEX_ACCESS_TOKEN;
  delete env.PRAVEX_API_HOST;
  if (port) Object.assign(env, { PRAVEX_ACCESS_TOKEN: 'test-access-token', PRAVEX_API_HOST: `http://127.0.0.1:${port}` });
  return env;
}

/**
 * Run the hook with a payload on stdin; resolves `{ code, ms, stdout }`.
 *
 * Asynchronous on purpose: `spawnSync` would block this event loop, so a capture
 * server here could not answer the child, which would time out, spool and exit 0
 * — and the assertions would pass against a request that was never answered.
 */
function runHook(input, env, args = []) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [REPORT, ...args], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, ms: Date.now() - started, stdout }));
    child.stdin.end(JSON.stringify(input));
  });
}

/**
 * Captures every POST body; `nth(n)` resolves with all bodies once `n` have arrived. Call `listen()` first.
 *
 * `GET /api/me/seat` is answered on its own and never counted as a body; each one
 * is recorded in `seatRequests`. `seat` decides the answer: absent or null is a
 * 404, a server from before seats; an object is that seat; `'error'` is a 500;
 * `'hang'` never answers, so only the hook's own timeout can end it; a function is
 * asked on every request.
 * `ingest` is the POST's `result` (`{ created: true }` by default), or a function
 * of the posted body.
 */
function captureServer({ seat, ingest } = {}) {
  const bodies = [];
  const seatRequests = [];
  const waiters = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/me/seat') {
      seatRequests.push({ auth: req.headers.authorization, at: Date.now() });
      const answer = typeof seat === 'function' ? seat() : seat;
      if (answer === 'hang') return;
      if (answer === 'error') return res.writeHead(500, { 'content-type': 'application/json' }).end('{"status":500}');
      res.writeHead(answer ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer ? { status: 200, result: answer } : { status: 404, error: { message: 'Cannot GET /api/me/seat' } }));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const result = typeof ingest === 'function' ? ingest(parsed) : ingest || { created: true };
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 201, result }));
      bodies.push(parsed);
      for (const w of waiters.splice(0)) w();
    });
  });
  const nth = (n) =>
    new Promise((r) => {
      const check = () => (bodies.length >= n ? r(bodies) : waiters.push(check));
      check();
    });
  const listen = () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  // `closeAllConnections` too: a request left hanging on purpose would hold `close` open.
  const close = () => {
    server.close();
    server.closeAllConnections();
  };
  return { server, bodies, seatRequests, nth, listen, close };
}

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

const PENDING = { status: 400, body: { error: 'authorization_pending' } };

/**
 * A stand-in for `/api/oauth/*`. `device` is a queue of answers for the device-code
 * poll; refresh tokens are issued as r1, r2, … and rotate.
 */
function oauthServer({ device = [], refreshLatencyMs = 0 } = {}) {
  const state = {
    deviceAuth: [],
    polls: [],
    refreshes: [],
    revocations: [],
    apiCalls: [],
    sessions: [],
    reused: false,
    revokedGrant: false,
    serial: 1,
    live: new Set(),
    /** Answer every refresh with this instead (an `{ status, body }`). */
    refreshOverride: null,
    /** Access tokens `GET /api/me` accepts. */
    validAccess: new Set(),
  };
  const queue = [...device];
  const issue = (fromRefresh) => {
    state.serial += 1;
    const pair = { access_token: `at${state.serial}`, refresh_token: `rt${state.serial}`, token_type: 'Bearer', expires_in: 900 };
    state.live.add(pair.refresh_token);
    state.validAccess.add(pair.access_token);
    if (fromRefresh) state.live.delete(fromRefresh);
    return pair;
  };
  state.issue = () => issue(null);

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const form = Object.fromEntries(new URLSearchParams(raw));
      const send = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
      if (req.url === '/api/oauth/device/auth') {
        state.deviceAuth.push({ form, type: req.headers['content-type'] });
        const base = `http://127.0.0.1:${server.address().port}/api/oauth/device`;
        return send(200, {
          device_code: 'dev-code-1',
          user_code: 'WDJB-MJHT',
          verification_uri: base,
          verification_uri_complete: `${base}?user_code=WDJB-MJHT`,
          expires_in: 600,
        });
      }
      if (req.url === '/api/oauth/token' && form.grant_type === DEVICE_GRANT) {
        state.polls.push(form);
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next === 'approve') return send(200, issue(null));
        return send(next.status, next.body);
      }
      if (req.url === '/api/oauth/token' && form.grant_type === 'refresh_token') {
        state.refreshes.push(form);
        const answer = () => {
          if (state.refreshOverride) return send(state.refreshOverride.status, state.refreshOverride.body);
          if (state.revokedGrant) return send(400, { error: 'invalid_grant' });
          if (!state.live.has(form.refresh_token)) {
            // Reuse detection: the whole connection dies with it.
            state.reused = true;
            state.revokedGrant = true;
            state.live.clear();
            return send(400, { error: 'invalid_grant' });
          }
          return send(200, issue(form.refresh_token));
        };
        return refreshLatencyMs ? setTimeout(answer, refreshLatencyMs) : answer();
      }
      if (req.url === '/api/oauth/token/revocation') {
        state.revocations.push(form);
        return send(200, {});
      }
      if (req.url === '/api/sessions' && req.method === 'POST') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        state.apiCalls.push(token);
        if (state.revokedGrant || !state.validAccess.has(token)) return send(401, { status: 401, error: { message: 'InvalidToken' } });
        state.sessions.push(JSON.parse(raw || '{}'));
        return send(201, { status: 201, result: { created: true } });
      }
      if (req.url === '/api/me/seat') return send(404, { status: 404, error: { message: 'Cannot GET /api/me/seat' } });
      if (req.url === '/api/me') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        state.apiCalls.push(token);
        if (state.revokedGrant || !state.validAccess.has(token)) return send(401, { status: 401, error: { message: 'InvalidToken' } });
        return send(200, { status: 200, result: { email: 'dana@northwind.co', orgName: 'Northwind' } });
      }
      return send(404, {});
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, state, host: `http://127.0.0.1:${server.address().port}` })),
  );
}

module.exports = { PENDING, REPORT, captureServer, envFor, oauthServer, runHook, tempHome };
