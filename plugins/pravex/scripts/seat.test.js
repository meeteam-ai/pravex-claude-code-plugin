'use strict';
/**
 * Seats: only members holding one are tracked (pravex-backend ADR 0014).
 *
 * The hook runs as a process against a local server with its own HOME, the way
 * Claude Code and Codex run it. What these hold the plugin to, in order:
 * nobody's session is ever failed or slowed beyond the 1.5 s start check; someone
 * without a seat is told so once; and nothing is sent while they have none.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const seat = require('./seat.js');
const { captureServer, envFor, runHook, tempHome } = require('./test-support.js');

const NORTHWIND = { id: 'org-1', name: 'Northwind' };
const NONE_LINE = "Pravex: you don't have a seat in Northwind, so this session isn't tracked. Ask a workspace admin to assign you one.";
const PAUSED_LINE = "Pravex: your seat in Northwind is paused, so this session isn't tracked. A workspace admin can restore it.";
/** What `GET /api/me/seat` answers, field for field. */
const NONE = { status: 'none', workspace: NORTHWIND, admins: ['Ana Admin'], requestedAt: null, message: NONE_LINE };
const PAUSED = { status: 'suspended', workspace: NORTHWIND, admins: ['Ana Admin'], requestedAt: null, message: PAUSED_LINE };
const ACTIVE = { status: 'active', workspace: NORTHWIND, admins: ['Ana Admin'], requestedAt: null, message: null };
/** What `POST /api/sessions` answers, with and without a seat. */
const UNTRACKED = { tracked: false, seat: 'none', message: NONE_LINE };
const TRACKED = { id: 'row-1', created: true, tracked: true, seat: 'active' };

const TS = '2026-10-13T10:00:00.000Z';
const pravex = (home, ...parts) => path.join(home, '.pravex', ...parts);
const systemMessage = (stdout) => (stdout ? JSON.parse(stdout).systemMessage : null);
const logOf = (home) => {
  try {
    return fs.readFileSync(pravex(home, 'last-report.log'), 'utf8');
  } catch {
    return '';
  }
};
const reported = (home) => {
  try {
    return JSON.parse(fs.readFileSync(pravex(home, 'reported.json'), 'utf8'));
  } catch {
    return [];
  }
};

/** A Claude Code transcript with one real turn, under the projects directory the sweep reads. */
function writeTranscript(home, sessionId, { ageMinutes = 0 } = {}) {
  const dir = path.join(home, '.claude', 'projects', '-work-acme');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const lines = [
    { type: 'user', timestamp: TS, message: { content: 'add pagination to the invoices endpoint' } },
    { type: 'assistant', timestamp: TS, message: { id: `m-${sessionId}`, model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'Done.' }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  if (ageMinutes) {
    const at = Date.now() / 1000 - ageMinutes * 60;
    fs.utimesSync(file, at, at);
  }
  return file;
}

/** A Codex rollout with one real turn, filed under `~/.codex/sessions` by day the way Codex does. */
function writeRollout(home, sessionId) {
  const dir = path.join(home, '.codex', 'sessions', '2026', '10', '13');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-13T10-00-00-${sessionId}.jsonl`);
  const u = { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 300, reasoning_output_tokens: 100, total_tokens: 1300 };
  const lines = [
    { timestamp: TS, type: 'session_meta', payload: { id: sessionId, timestamp: TS, cwd: '/work/acme', originator: 'codex_cli_rs', model_provider: 'openai' } },
    { timestamp: TS, type: 'turn_context', payload: { turn_id: 'turn-1', cwd: '/work/acme', model: 'gpt-5.3-codex' } },
    { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'write tests for the seat service' }] } },
    { timestamp: TS, type: 'token_usage_record', payload: { thread_id: sessionId, turn_id: 'turn-1', session_id: sessionId, usage: u, turn_token_usage: u, thread_token_usage: u } },
    { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  return file;
}

function writeCache(home, cached) {
  fs.mkdirSync(pravex(home), { recursive: true });
  fs.writeFileSync(pravex(home, 'seat.json'), JSON.stringify(cached));
}
const readCache = (home) => JSON.parse(fs.readFileSync(pravex(home, 'seat.json'), 'utf8'));

function writeShown(home, sessionId, status) {
  fs.mkdirSync(pravex(home, 'seat-shown'), { recursive: true });
  fs.writeFileSync(pravex(home, 'seat-shown', sessionId), status);
}
const readShown = (home, sessionId) => fs.readFileSync(pravex(home, 'seat-shown', sessionId), 'utf8');

/** A `Stop` for the same session again, past the 90-second throttle. */
const forgetThrottle = (home) => fs.rmSync(pravex(home, 'progress.json'), { force: true });

const MIN = 60 * 1000;

// ── What is said ─────────────────────────────────────────────────────────────

test('the fallback lines are the server\'s own, word for word', () => {
  assert.strictEqual(seat.notTrackedMessage({ status: 'none', workspace: NORTHWIND }), NONE_LINE);
  assert.strictEqual(seat.notTrackedMessage({ status: 'suspended', workspace: NORTHWIND }), PAUSED_LINE);
  // The server's message wins whenever there is one.
  assert.strictEqual(seat.notTrackedMessage({ status: 'none', message: 'Pravex: custom.' }), 'Pravex: custom.');
  // No name rather than "a seat in your workspace".
  assert.strictEqual(
    seat.notTrackedMessage({ status: 'none' }),
    "Pravex: you don't have a seat, so this session isn't tracked. Ask a workspace admin to assign you one."
  );
  assert.strictEqual(seat.notTrackedMessage({ status: 'active', workspace: NORTHWIND }), null);
});

test('a change mid-session has one line each way, and none between the two untracked states', () => {
  assert.strictEqual(seat.changeMessage('active', 'none', 'Northwind'), "Pravex: your seat in Northwind was removed, so the rest of this session isn't tracked.");
  assert.strictEqual(seat.changeMessage('none', 'active', 'Northwind'), 'Pravex: you now have a seat in Northwind. This session is tracked from here on.');
  assert.strictEqual(seat.changeMessage('suspended', 'active', 'Northwind'), 'Pravex: you now have a seat in Northwind. This session is tracked from here on.');
  assert.strictEqual(seat.changeMessage('active', 'suspended', 'Northwind'), "Pravex: your seat in Northwind was paused, so the rest of this session isn't tracked.");
  assert.strictEqual(seat.changeMessage('none', 'suspended', 'Northwind'), null);
  assert.strictEqual(seat.changeMessage('suspended', 'none', 'Northwind'), null);
  assert.strictEqual(seat.changeMessage('active', 'active', 'Northwind'), null);
});

test('the status lines', () => {
  assert.strictEqual(seat.statusLine({ status: 'active' }), 'Seat: active. Every session is reported when it ends.');
  assert.strictEqual(seat.statusLine({ status: 'none' }), "Seat: not assigned. Sessions on this machine aren't tracked until a workspace admin assigns you one.");
  assert.strictEqual(seat.statusLine({ status: 'suspended' }), "Seat: paused. Sessions on this machine aren't tracked until a workspace admin restores it.");
  // A server from before seats, or no answer: nothing about seats at all.
  assert.strictEqual(seat.statusLine({ status: 'active', legacy: true }), null);
  assert.strictEqual(seat.statusLine(null), null);
});

// ── What the server says ─────────────────────────────────────────────────────

test('GET /api/me/seat is read through the response envelope, and a 404 is a server from before seats', () => {
  assert.deepStrictEqual(seat.parseSeatResponse(200, JSON.stringify({ status: 200, result: NONE })), { status: 'none', message: NONE_LINE, workspace: NORTHWIND });
  assert.deepStrictEqual(seat.parseSeatResponse(200, JSON.stringify(ACTIVE)), { status: 'active', message: null, workspace: NORTHWIND });
  assert.deepStrictEqual(seat.parseSeatResponse(404, '{}'), { status: 'active', message: null, workspace: null, legacy: true });
  // Anything that is not a seat could not say, and the cache answers instead.
  assert.strictEqual(seat.parseSeatResponse(500, '{}'), null);
  assert.strictEqual(seat.parseSeatResponse(401, '{}'), null);
  assert.strictEqual(seat.parseSeatResponse(200, '<html>'), null);
  assert.strictEqual(seat.parseSeatResponse(200, JSON.stringify({ result: { status: 'gold' } })), null);
});

test('an ingest response says tracked or not, and an older one says nothing', () => {
  assert.deepStrictEqual(seat.seatFromIngest(JSON.stringify({ status: 200, result: UNTRACKED })), { status: 'none', message: NONE_LINE });
  assert.deepStrictEqual(seat.seatFromIngest(JSON.stringify({ result: { tracked: false, seat: 'suspended', message: PAUSED_LINE } })), { status: 'suspended', message: PAUSED_LINE });
  assert.deepStrictEqual(seat.seatFromIngest(JSON.stringify({ result: TRACKED })), { status: 'active', message: null });
  assert.strictEqual(seat.seatFromIngest(JSON.stringify({ result: { created: true } })), null);
  assert.strictEqual(seat.seatFromIngest('not json'), null);
});

test('a cached "no seat" is trusted for five minutes, and never from the future', () => {
  const now = Date.now();
  assert.strictEqual(seat.noSeatRecently({ status: 'none', checkedAt: now - 4 * MIN }, now), true);
  assert.strictEqual(seat.noSeatRecently({ status: 'suspended', checkedAt: now - 4 * MIN }, now), true);
  assert.strictEqual(seat.noSeatRecently({ status: 'none', checkedAt: now - 6 * MIN }, now), false);
  assert.strictEqual(seat.noSeatRecently({ status: 'none', checkedAt: now + 60 * MIN }, now), false);
  assert.strictEqual(seat.noSeatRecently({ status: 'active', checkedAt: now }, now), false);
  assert.strictEqual(seat.noSeatRecently(null, now), false);
});

// ── SessionStart ─────────────────────────────────────────────────────────────

test('SessionStart without a seat says so instead of "recording", and sends nothing at all', async () => {
  const home = tempHome();
  const { bodies, seatRequests, listen, close } = captureServer({ seat: NONE });
  const port = await listen();
  // A resumed session, and a cold one the sweep would otherwise report.
  const current = writeTranscript(home, 'current');
  writeTranscript(home, 'abandoned', { ageMinutes: 30 });

  const { code, stdout } = await runHook({ session_id: 'current', transcript_path: current, cwd: '/work/acme', source: 'startup' }, envFor(home, port), ['--start']);
  close();

  assert.strictEqual(code, 0);
  assert.strictEqual(systemMessage(stdout), NONE_LINE);
  assert.strictEqual(seatRequests.length, 1);
  assert.strictEqual(seatRequests[0].auth, 'Bearer pvx_test');
  assert.strictEqual(bodies.length, 0, 'nothing is sent without a seat: not the sweep, not this session');
  // The abandoned one waits for a start with a seat rather than being dropped.
  assert.ok(!reported(home).includes('abandoned'));
  const cached = readCache(home);
  assert.deepStrictEqual([cached.status, cached.message, cached.workspace], ['none', NONE_LINE, NORTHWIND]);
  assert.strictEqual(typeof cached.checkedAt, 'number');
  assert.strictEqual(readShown(home, 'current'), 'none');
  assert.match(logOf(home), /skipped \(start\) current: no seat/);
});

test('a paused seat has its own line, which also wins over incognito', async () => {
  const home = tempHome();
  const { listen, close } = captureServer({ seat: PAUSED });
  const port = await listen();
  fs.mkdirSync(pravex(home, 'incognito'), { recursive: true });
  fs.writeFileSync(pravex(home, 'incognito', 's1'), '');

  const { stdout } = await runHook({ session_id: 's1', cwd: '/work/acme', source: 'resume' }, envFor(home, port), ['--start']);
  close();

  assert.strictEqual(systemMessage(stdout), PAUSED_LINE);
  assert.strictEqual(readShown(home, 's1'), 'suspended');
});

test('with a seat the start line is unchanged and the session reports as before', async () => {
  const home = tempHome();
  const { bodies, listen, close } = captureServer({ seat: ACTIVE, ingest: TRACKED });
  const port = await listen();
  const current = writeTranscript(home, 'current');

  const { stdout } = await runHook({ session_id: 'current', transcript_path: current, cwd: '/work/acme', source: 'startup' }, envFor(home, port), ['--start']);
  close();

  assert.match(systemMessage(stdout), /^Pravex: recording this session/);
  assert.deepStrictEqual(bodies.map((b) => [b.externalId, b.status]), [['current', 'active']]);
  assert.strictEqual(readCache(home).status, 'active');
  assert.strictEqual(readShown(home, 'current'), 'active');
});

test('Codex gets the start line as a systemMessage too, which it shows as a warning', async () => {
  const home = tempHome();
  const { listen, close } = captureServer({ seat: NONE });
  const port = await listen();

  const { code, stdout } = await runHook(
    { session_id: '0f7a5b6c-1d2e-4f30-8a9b-c0d1e2f3a4b5', cwd: '/work/acme', source: 'startup', hook_event_name: 'SessionStart' },
    envFor(home, port),
    ['--start', '--agent', 'codex']
  );
  close();

  assert.strictEqual(code, 0);
  // JSON, not plain text: Codex adds plain SessionStart stdout to the model's context.
  assert.deepStrictEqual(JSON.parse(stdout), { systemMessage: NONE_LINE });
});

test('Codex with a seat sees the usual recording line', async () => {
  const home = tempHome();
  const { listen, close } = captureServer({ seat: ACTIVE });
  const port = await listen();

  const { stdout } = await runHook({ session_id: 'codex-1', cwd: '/work/acme', source: 'startup' }, envFor(home, port), ['--start', '--agent', 'codex']);
  close();

  assert.match(systemMessage(stdout), /^Pravex: recording this session/);
});

test('a server from before seats (404) is treated as tracked', async () => {
  const home = tempHome();
  const { bodies, seatRequests, listen, close } = captureServer();
  const port = await listen();
  const current = writeTranscript(home, 'current');

  const { stdout } = await runHook({ session_id: 'current', transcript_path: current, cwd: '/work/acme', source: 'startup' }, envFor(home, port), ['--start']);
  close();

  assert.strictEqual(seatRequests.length, 1);
  assert.match(systemMessage(stdout), /^Pravex: recording this session/);
  assert.strictEqual(bodies.length, 1);
  assert.strictEqual(readCache(home).status, 'active');
});

test('the start waits at most 1.5 s for the seat, then the cache answers and a stale one still sends', async () => {
  const home = tempHome();
  const { bodies, seatRequests, listen, close } = captureServer({ seat: 'hang' });
  const port = await listen();
  const current = writeTranscript(home, 'current');
  // An hour-old "no seat": still the best line to show, too old to hold a report back.
  writeCache(home, { status: 'none', message: NONE_LINE, workspace: NORTHWIND, checkedAt: Date.now() - 60 * MIN });

  const { code, ms, stdout } = await runHook({ session_id: 'current', transcript_path: current, cwd: '/work/acme', source: 'startup' }, envFor(home, port), ['--start']);
  close();

  assert.strictEqual(code, 0);
  assert.strictEqual(seatRequests.length, 1);
  assert.ok(ms >= seat.START_TIMEOUT_MS - 100, `returned in ${ms}ms, before the seat check could have timed out`);
  assert.ok(ms < seat.START_TIMEOUT_MS + 1500, `the start took ${ms}ms`);
  assert.strictEqual(systemMessage(stdout), NONE_LINE);
  assert.strictEqual(bodies.length, 1, 'fails open: the server enforces the seat anyway');
});

test('a start with no credentials asks nothing and keeps the login line', async () => {
  const home = tempHome();
  writeCache(home, { status: 'none', message: NONE_LINE, workspace: NORTHWIND, checkedAt: Date.now() });

  const { code, stdout } = await runHook({ session_id: 's1', cwd: '/work/acme', source: 'startup' }, envFor(home), ['--start']);

  assert.strictEqual(code, 0);
  assert.match(systemMessage(stdout), /not connected.*\/pravex:login/);
});

// ── Stop ─────────────────────────────────────────────────────────────────────

test('Stop sends nothing while the cache says, recently, that there is no seat', async () => {
  const home = tempHome();
  const { bodies, seatRequests, listen, close } = captureServer({ seat: ACTIVE });
  const port = await listen();
  const transcript = writeTranscript(home, 's1');
  writeCache(home, { status: 'none', message: NONE_LINE, workspace: NORTHWIND, checkedAt: Date.now() - MIN });
  writeShown(home, 's1', 'none');

  const { code, stdout } = await runHook({ session_id: 's1', transcript_path: transcript, cwd: '/work/acme' }, envFor(home, port), ['--progress']);
  close();

  assert.strictEqual(code, 0);
  assert.strictEqual(bodies.length, 0);
  assert.strictEqual(seatRequests.length, 0, 'a fresh cache is not re-checked');
  assert.strictEqual(stdout, '', 'already told at the start; nothing to say again');
  assert.match(logOf(home), /skipped \(progress\) s1: no seat/);
});

test('once the answer is five minutes old Stop asks again, and says once that the seat arrived', async () => {
  const home = tempHome();
  const { bodies, seatRequests, listen, close } = captureServer({ seat: ACTIVE, ingest: TRACKED });
  const port = await listen();
  const transcript = writeTranscript(home, 's1');
  writeCache(home, { status: 'none', message: NONE_LINE, workspace: NORTHWIND, checkedAt: Date.now() - 6 * MIN });
  writeShown(home, 's1', 'none');
  const env = envFor(home, port);
  const input = { session_id: 's1', transcript_path: transcript, cwd: '/work/acme' };

  const first = await runHook(input, env, ['--progress']);
  assert.strictEqual(seatRequests.length, 1);
  assert.strictEqual(bodies.length, 1);
  assert.strictEqual(systemMessage(first.stdout), 'Pravex: you now have a seat in Northwind. This session is tracked from here on.');
  assert.strictEqual(readShown(home, 's1'), 'active');

  forgetThrottle(home);
  const second = await runHook(input, env, ['--progress']);
  close();
  assert.strictEqual(bodies.length, 2);
  assert.strictEqual(second.stdout, '', 'said once, not on every turn');
});

test('a seat removed mid-session is said once, and the rest of the session is not sent', async () => {
  const home = tempHome();
  const { bodies, seatRequests, listen, close } = captureServer({ seat: NONE, ingest: UNTRACKED });
  const port = await listen();
  const transcript = writeTranscript(home, 's1');
  writeCache(home, { status: 'active', message: null, workspace: NORTHWIND, checkedAt: Date.now() });
  writeShown(home, 's1', 'active');
  const env = envFor(home, port);
  const input = { session_id: 's1', transcript_path: transcript, cwd: '/work/acme' };

  const first = await runHook(input, env, ['--progress']);
  assert.strictEqual(bodies.length, 1, 'the cache said active, so the report went; the server declined it');
  assert.strictEqual(systemMessage(first.stdout), "Pravex: your seat in Northwind was removed, so the rest of this session isn't tracked.");
  const cached = readCache(home);
  assert.deepStrictEqual([cached.status, cached.message, cached.workspace], ['none', NONE_LINE, NORTHWIND]);

  forgetThrottle(home);
  const second = await runHook(input, env, ['--progress']);
  close();
  assert.strictEqual(bodies.length, 1, 'nothing more is sent');
  assert.strictEqual(seatRequests.length, 0);
  assert.strictEqual(second.stdout, '');
});

test('a session that started signed out and turns out untracked gets the plain line, not "was removed"', async () => {
  const home = tempHome();
  const { listen, close } = captureServer({ ingest: UNTRACKED });
  const port = await listen();
  const transcript = writeTranscript(home, 's1');

  const { stdout } = await runHook({ session_id: 's1', transcript_path: transcript, cwd: '/work/acme' }, envFor(home, port), ['--progress']);
  close();

  assert.strictEqual(systemMessage(stdout), NONE_LINE);
});

test('Codex Stop says it in JSON too, the only stdout its Stop accepts', async () => {
  const home = tempHome();
  const { bodies, listen, close } = captureServer({ ingest: UNTRACKED });
  const port = await listen();
  const id = '0f7a5b6c-1d2e-4f30-8a9b-c0d1e2f3a4b5';
  const transcript = writeRollout(home, id);
  writeShown(home, id, 'active');
  writeCache(home, { status: 'active', message: null, workspace: NORTHWIND, checkedAt: Date.now() });

  const { stdout } = await runHook({ session_id: id, transcript_path: transcript, cwd: '/work/acme', hook_event_name: 'Stop' }, envFor(home, port), ['--progress', '--agent', 'codex']);
  close();

  assert.strictEqual(bodies[0].agent, 'codex');
  assert.deepStrictEqual(JSON.parse(stdout), { systemMessage: "Pravex: your seat in Northwind was removed, so the rest of this session isn't tracked." });
});

for (const [label, answer] of [
  ['times out', 'hang'],
  ['fails', 'error'],
  ['is a server from before seats', null],
]) {
  test(`fail open: a Stop whose re-check ${label} still sends`, async () => {
    const home = tempHome();
    const { bodies, seatRequests, listen, close } = captureServer({ seat: answer });
    const port = await listen();
    const transcript = writeTranscript(home, 's1');
    writeCache(home, { status: 'none', message: NONE_LINE, workspace: NORTHWIND, checkedAt: Date.now() - 6 * MIN });

    const { code, ms } = await runHook({ session_id: 's1', transcript_path: transcript, cwd: '/work/acme' }, envFor(home, port), ['--progress']);
    close();

    assert.strictEqual(code, 0);
    assert.strictEqual(seatRequests.length, 1);
    assert.strictEqual(bodies.length, 1);
    assert.ok(ms < seat.START_TIMEOUT_MS + 1500, `the Stop took ${ms}ms`);
  });
}

// ── SessionEnd, the sweep and the spool ──────────────────────────────────────

test('SessionEnd without a seat sends nothing and remembers the session, so it is never swept later', async () => {
  const home = tempHome();
  const { bodies, listen, close } = captureServer({ seat: ACTIVE });
  const port = await listen();
  const transcript = writeTranscript(home, 's1');
  writeCache(home, { status: 'none', message: NONE_LINE, workspace: NORTHWIND, checkedAt: Date.now() });

  const { code, stdout } = await runHook({ session_id: 's1', transcript_path: transcript, cwd: '/work/acme' }, envFor(home, port));
  close();

  assert.strictEqual(code, 0);
  assert.strictEqual(bodies.length, 0);
  assert.strictEqual(stdout, '');
  assert.ok(reported(home).includes('s1'));
  assert.match(logOf(home), /skipped \(end\) s1: no seat/);
});

test('the sweep never sends a session that ran without a seat, even once there is one', async () => {
  const home = tempHome();
  const { bodies, listen, close } = captureServer({ seat: ACTIVE, ingest: TRACKED });
  const port = await listen();
  writeTranscript(home, 'unseated', { ageMinutes: 30 });
  writeTranscript(home, 'seated', { ageMinutes: 40 });
  writeShown(home, 'unseated', 'none');

  await runHook({ session_id: 'starting', cwd: '/work/acme', source: 'startup' }, envFor(home, port), ['--start']);
  close();

  assert.deepStrictEqual(bodies.map((b) => b.externalId), ['seated']);
  assert.ok(reported(home).includes('unseated'), 'remembered, so it is not reconsidered on every start');
});

test('the sweep drops a report the server declines for want of a seat, and stops there', async () => {
  const home = tempHome();
  // The start check says active; by the time the sweep posts, the seat is gone.
  const { bodies, listen, close } = captureServer({ seat: ACTIVE, ingest: UNTRACKED });
  const port = await listen();
  writeTranscript(home, 'newer', { ageMinutes: 20 });
  writeTranscript(home, 'older', { ageMinutes: 40 });
  const current = writeTranscript(home, 'current');

  const { code } = await runHook({ session_id: 'current', transcript_path: current, cwd: '/work/acme', source: 'startup' }, envFor(home, port), ['--start']);
  close();

  assert.strictEqual(code, 0);
  assert.deepStrictEqual(bodies.map((b) => b.externalId), ['newer'], 'no further sweep, and no live report');
  assert.ok(reported(home).includes('newer'), 'never re-sent');
  assert.ok(!reported(home).includes('older'), 'waits for a session with a seat');
  assert.strictEqual(readCache(home).status, 'none');
});

test('a spooled report the server declines for want of a seat is dropped, and the replay stops', async () => {
  const home = tempHome();
  const { bodies, listen, close } = captureServer({ ingest: UNTRACKED });
  const port = await listen();
  const spool = pravex(home, 'spool');
  fs.mkdirSync(spool, { recursive: true });
  fs.writeFileSync(path.join(spool, '1000-first.json'), JSON.stringify({ externalId: 'first', status: 'ended' }));
  fs.writeFileSync(path.join(spool, '2000-second.json'), JSON.stringify({ externalId: 'second', status: 'ended' }));
  const transcript = writeTranscript(home, 'ending');

  const { code } = await runHook({ session_id: 'ending', transcript_path: transcript, cwd: '/work/acme' }, envFor(home, port));
  close();

  assert.strictEqual(code, 0);
  assert.deepStrictEqual(bodies.map((b) => b.externalId), ['first', 'ending']);
  assert.deepStrictEqual(fs.readdirSync(spool), ['2000-second.json']);
  assert.ok(reported(home).includes('ending'));
});

// ── Housekeeping ─────────────────────────────────────────────────────────────

test('the reporter, the status line and the installer agree on where the seat lives', () => {
  assert.strictEqual(seat.SEAT_FILE, require('./statusline.js').SEAT_FILE);
  assert.ok(require('./codex-install.js').COPY_FILES.includes('seat.js'), 'the Codex copy and the npm package need it');
});

test('a seat-shown marker cannot escape its directory', () => {
  const home = tempHome();
  const script = `const s = require(${JSON.stringify(path.join(__dirname, 'seat.js'))}); s.writeShown('../../etc/passwd', 'none');`;
  const r = require('node:child_process').spawnSync(process.execPath, ['-e', script], { env: envFor(home), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(fs.readdirSync(pravex(home, 'seat-shown')), ['etcpasswd']);
});
