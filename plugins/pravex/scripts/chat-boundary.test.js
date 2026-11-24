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
 * Plugin 0.13.0 adds one more request (PL-X03, ADR 0044): the setup snapshot,
 * `PUT /api/claude-setup/snapshot`, sent at session start. It describes the machine's
 * Claude Code by name (MCP servers, agents, skills, commands, plugins, hooks, permission
 * counts) and carries nothing from any conversation. Its fields are pinned here too.
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
  'flowRun',
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

/** Every field a setup snapshot may carry, and every field of its user and project scopes. */
const SETUP_FIELDS = new Set(['v', 'machineId', 'hostname', 'platform', 'arch', 'pluginVersion', 'claudeVersion', 'user', 'project', 'environment']);
/** The machine status every start sends (plans 0011 and 0013): plan usage, the flow runner and the sign-in, nothing from the session. */
const STATUS_FIELDS = new Set(['machineId', 'planUsage', 'runner', 'claude']);
const SCOPE_FIELDS = new Set(['claudeMd', 'settings', 'mcpServers', 'plugins', 'agents', 'skills', 'commands', 'hooks']);
const PROJECT_FIELDS = new Set([...SCOPE_FIELDS, 'repo', 'workflows']);

/** Method and route of every request the plugin may make. */
const ROUTES = new Set(['POST /api/sessions', 'GET /api/me/seat', 'PUT /api/claude-setup/snapshot', 'PUT /api/claude-setup/machine-status']);

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
      if (req.method === 'PUT') return res.end(JSON.stringify({ status: 200, result: { tracked: true } }));
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
      assert.ok(ROUTES.has(`${r.method} ${r.url}`), `called ${r.method} ${r.url}`);
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

/** A transcript with a prompt and a reply in it, so the test can look for them where they must not be. */
function chattyTranscript() {
  const transcript = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-')), 'transcript.jsonl');
  const lines = [
    { type: 'user', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'PROMPT-ZEBRA-7731 please refactor the uploader' } },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:05.000Z',
      message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 3, output_tokens: 2 }, content: [{ type: 'text', text: 'REPLY-OKAPI-4410 done' }] },
    },
  ];
  fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n'));
  return transcript;
}

test('at session start the setup snapshot is the only other request, with pinned fields and no conversation in it', async () => {
  const { server, requests } = recordingServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = tempHome();
  const transcript = chattyTranscript();
  try {
    const { code } = await runHook(
      { session_id: 'coding-session', transcript_path: transcript, cwd: process.cwd(), source: 'startup' },
      envFor(home, server.address().port),
      ['--start'],
    );
    assert.strictEqual(code, 0);

    for (const r of requests) assert.ok(ROUTES.has(`${r.method} ${r.url}`), `called ${r.method} ${r.url}`);
    const setups = requests.filter((r) => r.method === 'PUT' && r.url === '/api/claude-setup/snapshot');
    assert.strictEqual(setups.length, 1, 'one setup snapshot per start');
    const statuses = requests.filter((r) => r.url === '/api/claude-setup/machine-status');
    assert.strictEqual(statuses.length, 1, 'one machine status per start');
    for (const key of Object.keys(statuses[0].body)) assert.ok(STATUS_FIELDS.has(key), `unexpected status field ${key}`);
    assert.deepStrictEqual(Object.keys(statuses[0].body.claude).sort(), ['expiresAt', 'signedIn'], 'the sign-in says two things');
    assert.ok(!JSON.stringify(statuses[0].body).includes('coding-session'), 'the status carried the session');
    const body = setups[0].body;
    for (const key of Object.keys(body)) assert.ok(SETUP_FIELDS.has(key), `unexpected setup field ${key}`);
    for (const key of Object.keys(body.user)) assert.ok(SCOPE_FIELDS.has(key), `unexpected user field ${key}`);
    if (body.project) for (const key of Object.keys(body.project)) assert.ok(PROJECT_FIELDS.has(key), `unexpected project field ${key}`);
    assert.ok(!('kind' in body), 'the setup named a kind');
    const json = JSON.stringify(body);
    for (const said of ['PROMPT-ZEBRA-7731', 'REPLY-OKAPI-4410', 'coding-session']) {
      assert.ok(!json.includes(said), `the setup carried ${said}`);
    }
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('an incognito session start sends no setup snapshot at all', async () => {
  const { server, requests } = recordingServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = tempHome();
  fs.mkdirSync(path.join(home, '.pravex', 'incognito'), { recursive: true });
  fs.writeFileSync(path.join(home, '.pravex', 'incognito', 'private-session'), '');
  try {
    const { code } = await runHook(
      { session_id: 'private-session', transcript_path: chattyTranscript(), cwd: process.cwd(), source: 'resume' },
      envFor(home, server.address().port),
      ['--start'],
    );
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(requests.filter((r) => r.method === 'PUT'), []);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
