'use strict';
/**
 * PL-X01: the plugin reports coding sessions only, never a Pravex chat.
 *
 * Chat sessions are written by the chat app itself (`kind = chat`, agent `pravex-chat`, ADR 0021).
 * If the plugin could report one too, the same work would be counted twice. These tests pin the
 * three things that keep it out:
 *
 * - what it reads: only Claude Code and Codex transcripts, so it has no chat to see;
 * - what it sends: one coding agent and never a `kind`, so the server files every report as coding;
 * - where it sends it: `POST /api/sessions` (and the seat check), never a chat route.
 *
 * The server holds the same line on its side: a `pravex-chat` agent is a 400, a `kind` in the body
 * is dropped, and a report whose id is a chat's is a 409 that the spool discards rather than retries.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { AGENTS, agentFrom, buildBody } = require('./report-session.js');
const { envFor, runHook, tempHome } = require('./test-support.js');

/** Every field a report may carry. A new one is a decision; `kind` must never be one. */
const REPORT_FIELDS = new Set([
  'externalId',
  'agent',
  'incognito',
  'title',
  'repo',
  'branch',
  'startedAt',
  'endedAt',
  'durationMinutes',
  'usage',
  'filesTouched',
  'testsAdded',
  'retryRate',
  'prUrl',
  'status',
  'tz',
  'facets',
  'transcript',
]);

const AGG = {
  title: 'Fix the uploader',
  branch: 'main',
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:10:00.000Z',
  durationMinutes: 10,
  usage: [{ model: 'claude-opus-5', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }],
  filesTouched: 1,
  testsAdded: 0,
  retryRate: 0,
  prUrl: null,
  transcript: null,
};

test('knows only the coding agents, and never takes pravex-chat from the command line', () => {
  assert.deepStrictEqual(AGENTS, ['claude-code', 'codex']);
  assert.strictEqual(agentFrom(['--agent', 'pravex-chat'], null), 'claude-code');
  assert.strictEqual(agentFrom(['--agent', 'chat'], null), 'claude-code');
});

test('a report carries a coding agent and never a kind, private or not, whichever agent wrote it', () => {
  for (const agent of AGENTS) {
    for (const incognito of [false, true]) {
      for (const status of ['active', 'ended']) {
        const body = buildBody('session-1', 'acme/widgets', AGG, null, status, { agent, incognito });
        const label = `${agent}, incognito ${incognito}, ${status}`;
        assert.ok(!('kind' in body), `${label}: sent a kind`);
        assert.strictEqual(body.agent, agent, label);
        for (const key of Object.keys(body)) assert.ok(REPORT_FIELDS.has(key), `${label}: unexpected field ${key}`);
      }
    }
  }
});

test('no shipped script names a chat route, the chat agent or a session kind', () => {
  const dirs = [__dirname, path.join(__dirname, '..', '..', '..', 'packages', 'pravex-codex')];
  for (const dir of dirs) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'test-support.js')) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.ok(!source.includes('/api/chat'), `${file} calls a chat route`);
      assert.ok(!source.includes('pravex-chat'), `${file} names the chat agent`);
      assert.ok(!/\bkind\s*:/.test(source), `${file} sets a kind`);
    }
  }
});

/** Records every request the hook makes, answering like the API. */
function recordingServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
      if (req.method === 'GET') return res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 200, result: { created: true, tracked: true, seat: 'active' } }));
    });
  });
  return { server, requests };
}

test('the real hook, even told it is pravex-chat, posts one coding report to /api/sessions and calls nothing else', async () => {
  const { server, requests } = recordingServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = tempHome();
  const transcript = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-')), 'transcript.jsonl');
  fs.writeFileSync(
    transcript,
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 3, output_tokens: 2 }, content: [] },
    }),
  );
  try {
    const { code } = await runHook(
      { session_id: 'coding-session', transcript_path: transcript, cwd: process.cwd() },
      envFor(home, server.address().port),
      ['--agent', 'pravex-chat'],
    );
    assert.strictEqual(code, 0);

    const posts = requests.filter((r) => r.method === 'POST');
    assert.ok(posts.length >= 1, 'nothing was reported');
    for (const r of requests) {
      assert.ok(['/api/sessions', '/api/me/seat'].includes(r.url), `called ${r.method} ${r.url}`);
      assert.ok(!r.url.startsWith('/api/chat'), `called a chat route: ${r.url}`);
    }
    for (const { body } of posts) {
      assert.strictEqual(body.externalId, 'coding-session');
      assert.strictEqual(body.agent, 'claude-code');
      assert.ok(!('kind' in body), 'the report named a kind');
    }
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
