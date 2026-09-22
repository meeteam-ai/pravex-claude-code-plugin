'use strict';
/**
 * The reporter driven by Codex CLI hooks, end to end against a local server —
 * the same way `report-session.test.js` drives it for Claude Code.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { captureServer, envFor, runHook, tempHome } = require('./test-support.js');

const T0 = '2026-09-21T10:00:00.000Z';
const T1 = '2026-09-21T10:05:00.000Z';
const SESSION = '0f7a5b6c-1d2e-4f30-8a9b-c0d1e2f3a4b5';

/** A rollout under `$HOME/.codex/sessions/YYYY/MM/DD`, the way Codex files them. */
function writeRollout(home, sessionId, { cwd = '/work/acme', model = 'gpt-5.3-codex', mtime } = {}) {
  const dir = path.join(home, '.codex', 'sessions', '2026', '09', '21');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-21T10-00-00-${sessionId}.jsonl`);
  const u = { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 100, total_tokens: 1300 };
  const lines = [
    { timestamp: T0, type: 'session_meta', payload: { id: sessionId, timestamp: T0, cwd, originator: 'codex_cli_rs', cli_version: '0.155.1', model_provider: 'openai' } },
    { timestamp: T0, type: 'turn_context', payload: { turn_id: 'turn-1', cwd, model } },
    { timestamp: T0, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'port the retry middleware' }] } },
    { timestamp: T1, type: 'token_usage_record', payload: { thread_id: sessionId, turn_id: 'turn-1', session_id: sessionId, root_turn_id: 'turn-1', response_id: 'resp-1', usage: u, turn_token_usage: u, thread_token_usage: u } },
    { timestamp: T1, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

test('a Codex SessionEnd reports the rollout with agent codex and OpenAI token semantics', async () => {
  const home = tempHome();
  const { server, nth, listen } = captureServer();
  const port = await listen();
  const transcript = writeRollout(home, SESSION);

  const { code } = await runHook({ session_id: SESSION, transcript_path: transcript, cwd: '/work/acme', hook_event_name: 'SessionEnd', reason: 'other' }, envFor(home, port), ['--agent', 'codex']);
  assert.strictEqual(code, 0);

  const [body] = await nth(1);
  server.close();
  assert.strictEqual(body.agent, 'codex');
  assert.strictEqual(body.externalId, SESSION);
  assert.strictEqual(body.status, 'ended');
  assert.deepStrictEqual(body.usage, [{ model: 'gpt-5.3-codex', inputTokens: 400, outputTokens: 300, cacheReadTokens: 600, cacheWriteTokens: 0 }]);
  assert.strictEqual(body.title, 'port the retry middleware');
  assert.ok(body.transcript, 'the final report carries the conversation');
});

test('a rollout is recognised without the --agent flag', async () => {
  const home = tempHome();
  const { server, nth, listen } = captureServer();
  const port = await listen();
  const transcript = writeRollout(home, SESSION);

  await runHook({ session_id: SESSION, transcript_path: transcript, cwd: '/work/acme' }, envFor(home, port));

  const [body] = await nth(1);
  server.close();
  assert.strictEqual(body.agent, 'codex');
});

test('--end-detached returns at once and the child still delivers the report', async () => {
  const home = tempHome();
  const { server, nth, listen } = captureServer();
  const port = await listen();
  const transcript = writeRollout(home, SESSION);

  const { code, ms } = await runHook({ session_id: SESSION, transcript_path: transcript, cwd: '/work/acme' }, envFor(home, port), ['--end-detached', '--agent', 'codex']);
  assert.strictEqual(code, 0);
  // Codex kills a SessionEnd hook at three seconds; the parent must be well under it.
  assert.ok(ms < 1500, `parent took ${ms}ms`);

  const [body] = await nth(1);
  server.close();
  assert.strictEqual(body.agent, 'codex');
  assert.strictEqual(body.status, 'ended');
  assert.strictEqual(body.usage[0].model, 'gpt-5.3-codex');
});

test('SessionStart sweeps unreported rollouts under ~/.codex/sessions, filed under their own cwd', async () => {
  const home = tempHome();
  const { server, nth, listen } = captureServer();
  const port = await listen();
  const old = new Date(Date.now() - 60 * 60 * 1000);
  const forgotten = '11111111-2222-4333-8444-555555555555';
  const alreadySent = '66666666-7777-4888-8999-000000000000';
  writeRollout(home, forgotten, { cwd: '/work/other', mtime: old });
  writeRollout(home, alreadySent, { mtime: old });
  fs.mkdirSync(path.join(home, '.pravex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.pravex', 'reported.json'), JSON.stringify([alreadySent]));

  await runHook({ session_id: SESSION, transcript_path: path.join(home, 'none.jsonl'), cwd: '/work/acme', source: 'startup' }, envFor(home, port), ['--start', '--agent', 'codex']);

  const bodies = await nth(1);
  server.close();
  assert.deepStrictEqual(
    bodies.map((b) => [b.externalId, b.agent, b.status]),
    [[forgotten, 'codex', 'ended']]
  );
  const ledger = JSON.parse(fs.readFileSync(path.join(home, '.pravex', 'reported.json'), 'utf8'));
  assert.ok(ledger.includes(forgotten));
  assert.ok(ledger.includes(alreadySent), 'the ledger is shared across agents');
});

test('a Claude Code SessionStart sweeps Codex rollouts too', async () => {
  const home = tempHome();
  const { server, nth, listen } = captureServer();
  const port = await listen();
  const forgotten = '11111111-2222-4333-8444-555555555555';
  writeRollout(home, forgotten, { mtime: new Date(Date.now() - 60 * 60 * 1000) });

  await runHook({ session_id: 'claude-session', transcript_path: path.join(home, 'none.jsonl'), cwd: '/work/acme', source: 'startup' }, envFor(home, port), ['--start']);

  const [body] = await nth(1);
  server.close();
  assert.strictEqual(body.externalId, forgotten);
  assert.strictEqual(body.agent, 'codex');
});

test('a Claude Code report says so', async () => {
  const home = tempHome();
  const { server, nth, listen } = captureServer();
  const port = await listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-'));
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(
    transcript,
    [
      { type: 'user', timestamp: T0, message: { content: 'hi' } },
      { type: 'assistant', timestamp: T1, message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'hello' }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n')
  );

  await runHook({ session_id: 'claude-session', transcript_path: transcript, cwd: '/work/acme' }, envFor(home, port));

  const [body] = await nth(1);
  server.close();
  assert.strictEqual(body.agent, 'claude-code');
});
