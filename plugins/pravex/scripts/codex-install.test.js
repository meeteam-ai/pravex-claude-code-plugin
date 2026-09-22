'use strict';
/**
 * Installing the reporter as Codex CLI hooks.
 *
 * Every test runs against its own HOME: the installer resolves ~/.codex and
 * ~/.pravex at load time, so the module is required fresh in a child process
 * with HOME pointed at a temp directory.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { isOurs } = require('./codex-install.js');
const { tempHome } = require('./test-support.js');

const INSTALLER = path.join(__dirname, 'codex-install.js');

function run(home, cmd) {
  return spawnSync(process.execPath, [INSTALLER, cmd], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
}

const hooksFile = (home) => path.join(home, '.codex', 'hooks.json');
const readHooks = (home) => JSON.parse(fs.readFileSync(hooksFile(home), 'utf8'));
const ourEntries = (doc) => Object.entries(doc.hooks).flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.filter(isOurs).map((h) => [event, h])));

test('install creates hooks.json when there is none, with one entry per event', () => {
  const home = tempHome();
  const r = run(home, 'install');
  assert.strictEqual(r.status, 0, r.stderr);

  const doc = readHooks(home);
  const events = ourEntries(doc).map(([event]) => event).sort();
  assert.deepStrictEqual(events, ['SessionEnd', 'SessionStart', 'Stop']);
  const end = ourEntries(doc).find(([event]) => event === 'SessionEnd')[1];
  assert.strictEqual(end.timeout, 3);
  assert.ok(end.command.includes('--end-detached --agent codex'));
  assert.strictEqual(end.type, 'command');
});

test('install copies the reporter so it runs from ~/.pravex, and its requires resolve there', () => {
  const home = tempHome();
  run(home, 'install');

  const copy = path.join(home, '.pravex', 'codex', 'scripts', 'report-session.js');
  assert.ok(fs.existsSync(copy));
  assert.ok(fs.existsSync(path.join(home, '.pravex', 'codex', '.claude-plugin', 'plugin.json')));
  // Loading the copy exercises every relative require and the version lookup.
  const probe = spawnSync(process.execPath, ['-e', `const r = require(${JSON.stringify(copy)}); console.log(r.AGENTS.join(','))`], { encoding: 'utf8' });
  assert.strictEqual(probe.status, 0, probe.stderr);
  assert.strictEqual(probe.stdout.trim(), 'claude-code,codex');
});

test('install merges into existing hooks without touching foreign entries, and is idempotent', () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const theirs = {
    model: 'gpt-5.5',
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo hello', timeout: 5 }] }],
      PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: '/usr/bin/policy' }] }],
    },
  };
  fs.writeFileSync(hooksFile(home), JSON.stringify(theirs));

  run(home, 'install');
  run(home, 'install');

  const doc = readHooks(home);
  assert.strictEqual(doc.model, 'gpt-5.5');
  assert.deepStrictEqual(doc.hooks.PreToolUse, theirs.hooks.PreToolUse);
  assert.ok(doc.hooks.SessionStart.some((g) => g.hooks.some((h) => h.command === 'echo hello')));
  const starts = ourEntries(doc).filter(([event]) => event === 'SessionStart');
  assert.strictEqual(starts.length, 1, 'a second install must not add a second entry');
  assert.ok(fs.existsSync(`${hooksFile(home)}.pravex-backup`));
});

test('install refuses to write over a hooks file it cannot parse', () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(hooksFile(home), '{ not json');

  const r = run(home, 'install');

  assert.strictEqual(r.status, 1);
  assert.strictEqual(fs.readFileSync(hooksFile(home), 'utf8'), '{ not json');
  assert.ok(!fs.existsSync(path.join(home, '.pravex', 'codex')), 'nothing is copied when the merge cannot happen');
});

test('uninstall removes only our entries and leaves the rest of the file alone', () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(hooksFile(home), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
  run(home, 'install');

  const r = run(home, 'uninstall');

  assert.strictEqual(r.status, 0, r.stderr);
  const doc = readHooks(home);
  assert.deepStrictEqual(Object.keys(doc.hooks).sort(), ['Stop']);
  assert.deepStrictEqual(doc.hooks.Stop, [{ hooks: [{ type: 'command', command: 'say done' }] }]);
});

test('status tells the three states apart', () => {
  const home = tempHome();
  assert.match(run(home, 'status').stdout, /not installed/);
  run(home, 'install');
  assert.match(run(home, 'status').stdout, /installed \(SessionStart, Stop, SessionEnd\)/);
  const doc = readHooks(home);
  delete doc.hooks.SessionEnd;
  fs.writeFileSync(hooksFile(home), JSON.stringify(doc));
  assert.match(run(home, 'status').stdout, /partly installed/);
});

test('refresh recopies only when the running plugin version differs from the copy', () => {
  const home = tempHome();
  run(home, 'install');
  const manifest = path.join(home, '.pravex', 'codex', '.claude-plugin', 'plugin.json');
  const copy = path.join(home, '.pravex', 'codex', 'scripts', 'report-session.js');
  const probe = (code) =>
    spawnSync(process.execPath, ['-e', `console.log(require(${JSON.stringify(INSTALLER)}).refresh(${JSON.stringify(__dirname)}))`], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
    }).stdout.trim();

  // Same version: nothing to do, and nothing written.
  fs.writeFileSync(copy, '// stale');
  assert.strictEqual(probe(), 'false');
  assert.strictEqual(fs.readFileSync(copy, 'utf8'), '// stale');

  // The copy claims an older version: everything is copied again.
  fs.writeFileSync(manifest, JSON.stringify({ version: '0.0.1' }));
  assert.strictEqual(probe(), 'true');
  assert.notStrictEqual(fs.readFileSync(copy, 'utf8'), '// stale');
  assert.notStrictEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')).version, '0.0.1');
});
