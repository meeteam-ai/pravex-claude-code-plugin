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
