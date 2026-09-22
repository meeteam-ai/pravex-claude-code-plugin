'use strict';
/**
 * Reading an OpenAI Codex CLI rollout.
 *
 * The fixture lines are written from the Codex protocol structs
 * (`codex-rs/protocol/src/protocol.rs` at rust-v0.155.1): `SessionMeta`,
 * `TurnContextItem`, `TokenUsageRecord`, `TokenUsage`, plus the response items
 * the CLI persists. TODO(real-fixture): replace with an anonymised rollout from a
 * machine that has Codex — none did when this was written — and confirm the
 * `token_usage_record` line type tag against it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const codex = require('./codex-rollout.js');
const reporter = require('./report-session.js');

const HELPERS = {
  bashWrites: reporter.bashWrites,
  collectPrUrls: reporter.collectPrUrls,
  prUrlMatchesRepo: reporter.prUrlMatchesRepo,
  activeMinutes: reporter.activeMinutes,
  clampText: reporter.clampText,
  packTranscript: reporter.packTranscript,
  redact: reporter.redact,
  TEST_FILE_RE: /(\.test\.|\.spec\.|_test\.|(^|\/)test_|\/tests?\/|__tests__\/)/,
};

const T0 = '2026-09-21T10:00:00.000Z';
const T1 = '2026-09-21T10:01:00.000Z';
const T2 = '2026-09-21T10:02:00.000Z';

function writeRollout(lines, name = 'rollout-2026-09-21T10-00-00-0f7a5b6c-1d2e-4f30-8a9b-c0d1e2f3a4b5.jsonl') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-codex-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  return file;
}

const meta = (over = {}) => ({
  timestamp: T0,
  type: 'session_meta',
  payload: { id: '0f7a5b6c-1d2e-4f30-8a9b-c0d1e2f3a4b5', timestamp: T0, cwd: '/work/acme', originator: 'codex_cli_rs', cli_version: '0.155.1', model_provider: 'openai', ...over },
});
const turn = (turn_id, model, at = T0) => ({ timestamp: at, type: 'turn_context', payload: { turn_id, cwd: '/work/acme', model } });
const usage = (over = {}) => ({ input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 120, total_tokens: 1300, ...over });
const record = (turn_id, response_id, u, at = T1) => ({
  timestamp: at,
  type: 'token_usage_record',
  payload: { thread_id: 't', turn_id, session_id: 's', root_turn_id: turn_id, response_id, usage: u, turn_token_usage: u, thread_token_usage: u },
});
const userMsg = (text, at = T0) => ({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const assistantMsg = (text, at = T1) => ({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });

test('tokenUsageToModelUsage subtracts cached input and never adds reasoning on top of output', () => {
  const u = codex.tokenUsageToModelUsage(usage(), 'gpt-5.3-codex');
  assert.deepStrictEqual(u, { model: 'gpt-5.3-codex', inputTokens: 400, outputTokens: 300, cacheReadTokens: 600, cacheWriteTokens: 0 });
});

test('tokenUsageToModelUsage clamps cached input to the input it is part of and ignores cache writes', () => {
  const u = codex.tokenUsageToModelUsage(usage({ input_tokens: 100, cached_input_tokens: 250, cache_write_input_tokens: 999 }), 'gpt-5.5');
  assert.strictEqual(u.inputTokens, 0);
  assert.strictEqual(u.cacheReadTokens, 100);
  assert.strictEqual(u.cacheWriteTokens, 0);
});

test('isRollout recognises a Codex rollout by its first line, and nothing else', () => {
  assert.strictEqual(codex.isRollout(writeRollout([meta()])), true);
  const claude = writeRollout([{ type: 'user', timestamp: T0, message: { content: 'hi' } }], 'x.jsonl');
  assert.strictEqual(codex.isRollout(claude), false);
  assert.strictEqual(codex.isRollout('/nowhere/none.jsonl'), false);
});

test('aggregate sums usage records per model and dedupes on response_id', async () => {
  const file = writeRollout([
    meta(),
    turn('turn-1', 'gpt-5.3-codex'),
    userMsg('port the retry middleware'),
    record('turn-1', 'resp-1', usage()),
    record('turn-1', 'resp-1', usage()), // written again on resume
    record('turn-1', 'resp-2', usage({ input_tokens: 200, cached_input_tokens: 0, output_tokens: 50 }), T2),
    assistantMsg('Done.', T2),
  ]);

  const agg = await codex.aggregate(file, 'acme/api', {}, HELPERS);

  assert.deepStrictEqual(agg.usage, [{ model: 'gpt-5.3-codex', inputTokens: 600, outputTokens: 350, cacheReadTokens: 600, cacheWriteTokens: 0 }]);
  assert.strictEqual(agg.assistantMessages, 1);
  assert.strictEqual(agg.title, 'port the retry middleware');
  assert.strictEqual(agg.cwd, '/work/acme');
  assert.strictEqual(agg.startedAt, T0);
  assert.strictEqual(agg.endedAt, T2);
});

test('aggregate attributes each record to the model of its turn', async () => {
  const file = writeRollout([
    meta(),
    turn('turn-1', 'gpt-5.3-codex'),
    userMsg('first'),
    record('turn-1', 'resp-1', usage({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 })),
    assistantMsg('ok'),
    turn('turn-2', 'gpt-5.5', T1),
    userMsg('second', T1),
    record('turn-2', 'resp-2', usage({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 }), T2),
    assistantMsg('ok again', T2),
  ]);

  const agg = await codex.aggregate(file, 'acme/api', {}, HELPERS);

  assert.deepStrictEqual(
    agg.usage.map((u) => [u.model, u.outputTokens]),
    [
      ['gpt-5.3-codex', 10],
      ['gpt-5.5', 20],
    ]
  );
});

test('aggregate falls back to the last cumulative token_count when a rollout has no records', async () => {
  const snapshot = (u, at) => ({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: u, last_token_usage: u, model_context_window: null }, rate_limits: null } });
  const file = writeRollout([
    meta(),
    turn('turn-1', 'gpt-5-codex'),
    userMsg('hello'),
    snapshot(usage({ input_tokens: 100, cached_input_tokens: 20, output_tokens: 5 }), T0),
    assistantMsg('hi'),
    snapshot(usage({ input_tokens: 300, cached_input_tokens: 100, output_tokens: 40 }), T2),
  ]);

  const agg = await codex.aggregate(file, 'acme/api', {}, HELPERS);

  // The last snapshot is the total; summing them would double count.
  assert.deepStrictEqual(agg.usage, [{ model: 'gpt-5-codex', inputTokens: 200, outputTokens: 40, cacheReadTokens: 100, cacheWriteTokens: 0 }]);
});

test('aggregate reports no usage at all when a rollout carries neither', async () => {
  const file = writeRollout([meta(), turn('turn-1', 'gpt-5.5'), userMsg('hi'), assistantMsg('hello')]);
  const agg = await codex.aggregate(file, 'acme/api', {}, HELPERS);
  assert.deepStrictEqual(agg.usage, []);
});

test('aggregate counts an apply_patch only when its output did not fail, and files from shell writes', async () => {
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/a.test.ts\n*** End Patch';
  const file = writeRollout([
    meta(),
    turn('turn-1', 'gpt-5.3-codex'),
    userMsg('edit'),
    { timestamp: T1, type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c1', input: patch } },
    { timestamp: T1, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'Success. Updated the following files:\nM src/a.ts' } },
    { timestamp: T1, type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: src/b.ts\n*** End Patch' } },
    { timestamp: T1, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'error: patch failed to apply' } },
    { timestamp: T1, type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c3', arguments: JSON.stringify({ command: ['bash', '-lc', 'echo hi > notes.md'] }) } },
    { timestamp: T1, type: 'response_item', payload: { type: 'function_call_output', call_id: 'c3', output: JSON.stringify({ output: '', metadata: { exit_code: 0, duration_seconds: 0.1 } }) } },
    { timestamp: T2, type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c4', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }) } },
    { timestamp: T2, type: 'response_item', payload: { type: 'function_call_output', call_id: 'c4', output: JSON.stringify({ output: 'FAIL', metadata: { exit_code: 1, duration_seconds: 2 } }) } },
    assistantMsg('Applied.', T2),
  ]);

  const agg = await codex.aggregate(file, 'acme/api', {}, HELPERS);

  assert.strictEqual(agg.filesTouched, 3); // a.ts, a.test.ts, notes.md — b.ts failed
  assert.strictEqual(agg.testsAdded, 1);
  assert.strictEqual(agg.filesTouchedFromShell, 1);
  // Four tool calls, two failed: the patch and the exit code 1.
  assert.strictEqual(agg.retryRate, 50);
});

test('aggregate ignores developer messages and the context Codex injects as user text', async () => {
  const file = writeRollout([
    meta(),
    turn('turn-1', 'gpt-5.3-codex'),
    { timestamp: T0, type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex.' }] } },
    userMsg('<environment_context>\n<cwd>/work</cwd>\n</environment_context>'),
    userMsg('/status'),
    userMsg('real prompt about the billing page'),
    assistantMsg('On it.'),
  ]);

  const agg = await codex.aggregate(file, 'acme/api', { wantTranscript: true }, HELPERS);

  assert.strictEqual(agg.title, 'real prompt about the billing page');
  const turns = JSON.parse(require('node:zlib').gunzipSync(Buffer.from(agg.transcript.data, 'base64')).toString()).turns;
  assert.deepStrictEqual(
    turns.map((t) => [t.role, t.text]),
    [
      ['user', 'real prompt about the billing page'],
      ['assistant', 'On it.'],
    ]
  );
});

test('an unknown line type is skipped rather than fatal', async () => {
  const file = writeRollout([meta(), turn('turn-1', 'gpt-5.5'), { timestamp: T0, type: 'world_state', payload: { anything: true } }, userMsg('hi'), assistantMsg('hello')]);
  const agg = await codex.aggregate(file, 'acme/api', {}, HELPERS);
  assert.strictEqual(agg.assistantMessages, 1);
});
