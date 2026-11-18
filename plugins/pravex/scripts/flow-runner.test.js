'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runner = require('./flow-runner');

const flow = {
  name: 'Nightly review',
  definition: {
    nodes: [
      { id: 'note', type: 'note', data: { label: 'n' } },
      { id: 'pr', type: 'action', data: { label: 'Open PR', type: 'open_pr' } },
      { id: 'a', type: 'agent', data: { label: 'Reviewer', model: 'sonnet', instructions: 'Review open PRs', tools: ['Read', 'Bash(npm test:*)', 'rm -rf /;'] } },
      { id: 't', type: 'trigger', data: { label: 'Nightly', type: 'schedule', cron: '0 2 * * 1-5', timezone: 'America/Bogota' } },
      { id: 'c', type: 'check', data: { label: 'Tests', command: 'npm test' } },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'a' },
      { id: 'e2', source: 'a', target: 'c' },
      { id: 'e3', source: 'c', target: 'pr' },
    ],
    budget: { maxUsd: 5, maxTurns: 60, stopAfterFailures: 1 },
  },
};

test('runOrder walks from the trigger and leaves notes out', () => {
  assert.deepEqual(runner.runOrder(flow.definition).map((n) => n.id), ['t', 'a', 'c', 'pr']);
  assert.deepEqual(runner.runOrder({ nodes: [{ id: 'a', type: 'agent' }], edges: [] }), []);
});

test('cron fields and time zones', () => {
  assert.ok(runner.fieldMatches('*/15', 30, 0, 59));
  assert.ok(!runner.fieldMatches('*/15', 31, 0, 59));
  assert.ok(runner.fieldMatches('1-5', 3, 0, 6));
  assert.ok(runner.fieldMatches('1,3', 3, 0, 6));
  // 02:00 in Bogotá (UTC-5) is 07:00 UTC; 2026-11-18 is a Wednesday.
  assert.ok(runner.cronMatches('0 2 * * 1-5', new Date('2026-11-18T07:00:00Z'), 'America/Bogota'));
  assert.ok(!runner.cronMatches('0 2 * * 1-5', new Date('2026-11-18T02:00:00Z'), 'America/Bogota'));
  assert.ok(!runner.cronMatches('0 2 * * 1-5', new Date('2026-11-22T07:00:00Z'), 'America/Bogota'), 'Sunday');
  assert.ok(runner.cronMatches('0 7 * * 0', new Date('2026-11-22T07:00:00Z'), 'Not/AZone'), 'unknown zone falls back to UTC');
});

test('dueMinutes finds the schedule between two ticks, once', () => {
  const at = Date.parse('2026-11-18T07:00:00Z');
  assert.deepEqual(runner.dueMinutes('0 2 * * *', 'America/Bogota', at - 15 * 60000, at + 60000), [at]);
  assert.deepEqual(runner.dueMinutes('0 2 * * *', 'America/Bogota', at, at + 15 * 60000), []);
});

test('the guard: days, start below, stop above, unknown usage', () => {
  const now = Date.parse('2026-11-18T12:00:00Z'); // Wednesday
  const usage = (pct) => ({ fiveHour: { pct }, sevenDay: { pct: 10 }, at: now - 60000 });
  const guard = runner.guardOf({ guard: { days: [1, 2, 3, 4, 5], runBelowPct: 30, stopAbovePct: 80 } });
  assert.deepEqual(runner.guardDecision(guard, usage(20), { now }), { ok: true, params: { pct: 20 } });
  assert.equal(runner.guardDecision(guard, usage(35), { now }).code, 'plan-above-start');
  assert.equal(runner.guardDecision(guard, usage(85), { now, phase: 'step' }).code, 'plan-above-stop');
  assert.equal(runner.guardDecision(guard, usage(50), { now, phase: 'step' }).ok, true);
  assert.equal(runner.guardDecision(guard, null, { now }).code, 'plan-unknown');
  assert.equal(runner.guardDecision(guard, { ...usage(5), at: now - 4 * 3600000 }, { now }).code, 'plan-unknown', 'stale');
  const sunday = Date.parse('2026-11-22T12:00:00Z');
  assert.equal(runner.guardDecision(guard, usage(5), { now: sunday }).code, 'guard-day');
  assert.equal(runner.guardDecision(guard, { ...usage(5), at: sunday }, { now: sunday, manual: true }).ok, true);
  const lenient = runner.guardOf({ guard: { runBelowPct: 30, whenUnknown: 'run', window: 'seven_day' } });
  assert.equal(runner.guardDecision(lenient, null, { now }).ok, true);
  assert.equal(runner.guardDecision(runner.guardOf({}), null, { now }).ok, true);
});

test('agent arguments: dry runs in plan mode, live gets its tools; bad tool rules are dropped', () => {
  const node = flow.definition.nodes[2];
  assert.deepEqual(runner.toolsOf(node.data), ['Read', 'Bash(npm test:*)']);
  const dry = runner.agentArgs(flow, node, { mode: 'dry', maxTurns: 10, prompt: 'p' });
  assert.deepEqual(dry.slice(-4), ['--model', 'sonnet', '--permission-mode', 'plan']);
  assert.ok(!dry.includes('--allowedTools'));
  const live = runner.agentArgs(flow, node, { mode: 'live', maxTurns: 60, prompt: 'p' });
  assert.deepEqual(live.slice(-5), ['acceptEdits', '--allowedTools', 'Read', 'Bash(npm test:*)'].length === 4 ? ['--permission-mode', 'acceptEdits', '--allowedTools', 'Read', 'Bash(npm test:*)'] : []);
  assert.match(runner.agentPrompt(flow, node, { mode: 'dry', index: 2, total: 4 }), /read only[\s\S]*Review open PRs[\s\S]*"canRun"/);
  assert.match(runner.agentPrompt(flow, node, { mode: 'live', branch: 'pravex/x', index: 2, total: 4 }), /pravex\/x[\s\S]*Review open PRs/);
});

test('foldStream reads cost, turns, errors and rate limits; verdictOf reads the dry answer', () => {
  const acc = { costUsd: 0, turns: 0, isError: false, result: '', usage: null, limited: false };
  runner.foldStream(acc, 'not json');
  runner.foldStream(acc, JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.82 } }));
  runner.foldStream(acc, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.42, num_turns: 7, result: 'ok\n{"canRun": false, "missing": ["gh login"], "summary": "No GitHub"}' }));
  assert.equal(acc.costUsd, 0.42);
  assert.equal(acc.turns, 7);
  assert.equal(acc.isError, false);
  assert.deepEqual(acc.usage, { fiveHour: { pct: 82, resetsAt: null } });
  assert.deepEqual(runner.verdictOf(acc.result), { canRun: false, missing: ['gh login'], summary: 'No GitHub' });
  assert.equal(runner.verdictOf('no json here'), null);
  runner.foldStream(acc, JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }));
  assert.equal(acc.limited, true);
});

test('installCommand follows the lock file; findRepoDir prefers the main copy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-run-'));
  assert.equal(runner.installCommand(dir), null);
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
  assert.equal(runner.installCommand(dir), 'pnpm install --frozen-lockfile');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-home-'));
  const main = path.join(home, 'app');
  const wt = path.join(home, 'app-wt');
  fs.mkdirSync(path.join(main, '.git'), { recursive: true });
  fs.writeFileSync(path.join(main, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/app.git\n');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git')}\n`);
  const claudeJson = { projects: { [wt]: { lastSessionModified: 9 }, [main]: { lastSessionModified: 1 } } };
  assert.equal(runner.findRepoDir('acme/app', { home, claudeJson }), main);
  assert.equal(runner.findRepoDir('acme/other', { home, claudeJson }), null);
});

test('launchd plist escapes paths and runs the tick every 15 minutes', () => {
  const plist = runner.launchdPlist('/usr/local/bin/node', '/Users/a&b/.pravex/runner/flow-runner.js');
  assert.match(plist, /<integer>900<\/integer>/);
  assert.match(plist, /a&amp;b/);
  assert.match(plist, /--tick/);
});

test('cron reads like cron: names, Sunday as 7, day of month or weekday', () => {
  const wed = new Date('2026-11-18T12:00:00Z'); // Wednesday the 18th
  assert.ok(runner.cronMatches('0 12 * * WED', wed, 'UTC'));
  assert.ok(runner.cronMatches('0 12 * NOV *', wed, 'UTC'));
  assert.ok(runner.cronMatches('0 12 * * 1-7', new Date('2026-11-22T12:00:00Z'), 'UTC'), 'Sunday inside 1-7');
  assert.ok(runner.cronMatches('0 12 1 * 3', wed, 'UTC'), 'weekday matches although the day of month does not');
  assert.ok(!runner.cronMatches('0 12 1 * 4', wed, 'UTC'));
});

test('usage: a window that reset since the reading is 0 %, and the newer reading wins', () => {
  const now = Date.parse('2026-11-19T07:00:00Z');
  const evening = { fiveHour: { pct: 70, resetsAt: Date.parse('2026-11-18T23:00:00Z') }, sevenDay: { pct: 40, resetsAt: null }, at: Date.parse('2026-11-18T20:00:00Z') };
  assert.equal(runner.usagePct(evening, 'five_hour', now), 0);
  assert.equal(runner.usagePct(evening, 'seven_day', now), 40);
  assert.equal(runner.usagePct({ ...evening, at: now - 26 * 3600000 }, 'seven_day', now), null);
  const a = { at: 1 };
  const b = { at: 2 };
  assert.equal(runner.newerUsage(a, b), b);
  assert.equal(runner.newerUsage(b, a), b);
  assert.equal(runner.newerUsage(null, a), a);
});
