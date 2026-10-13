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
  delete env.PRAVEX_API_KEY;
  delete env.PRAVEX_API_HOST;
  if (port) Object.assign(env, { PRAVEX_API_KEY: 'pvx_test', PRAVEX_API_HOST: `http://127.0.0.1:${port}` });
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

module.exports = { REPORT, captureServer, envFor, runHook, tempHome };
