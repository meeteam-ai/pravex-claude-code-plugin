#!/usr/bin/env node
'use strict';
/**
 * `/pravex:update` — bring the plugin up to date without remembering two commands.
 *
 * Runs the same `claude plugin` commands a person would, in order: refresh the
 * marketplace (otherwise `update` compares against a stale copy and finds nothing),
 * then update the plugin. Then it clears the update-check cache, so the status line
 * stops saying `⬆ update` straight away instead of at the next session start.
 *
 * Standard library only. Prints for a person: the command shows this verbatim.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLUGIN = 'pravex@pravex';
const MARKETPLACE = 'pravex';
const CACHE_FILE = path.join(os.homedir(), '.pravex', 'update-check.json');

function installedVersion() {
  try {
    return require('../.claude-plugin/plugin.json').version;
  } catch {
    return 'unknown';
  }
}

/** `claude` itself. Overridable so the tests can stand a fake in. */
function run(args, { bin = process.env.PRAVEX_CLAUDE_BIN || 'claude' } = {}) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 180_000, shell: process.platform === 'win32' });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  return { ok: result.status === 0, output, missing: result.error && result.error.code === 'ENOENT' };
}

function main() {
  const before = installedVersion();
  console.log(`Pravex: installed ${before}. Checking for updates…`);

  const marketplace = run(['plugin', 'marketplace', 'update', MARKETPLACE]);
  if (marketplace.missing) {
    console.log('Pravex: the `claude` command is not on PATH here. Run these in a terminal instead:');
    console.log(`  claude plugin marketplace update ${MARKETPLACE}`);
    console.log(`  claude plugin update ${PLUGIN}`);
    return 1;
  }
  if (!marketplace.ok) {
    console.log(`Pravex: could not refresh the marketplace.\n${marketplace.output}`);
    return 1;
  }

  const update = run(['plugin', 'update', PLUGIN]);
  if (!update.ok) {
    console.log(`Pravex: the update failed.\n${update.output}`);
    return 1;
  }
  console.log(update.output);

  try {
    fs.unlinkSync(CACHE_FILE);
  } catch {
    /* nothing cached */
  }

  if (/updated from/i.test(update.output)) {
    console.log('Pravex: updated. Run /reload-plugins to use it in this session (new sessions pick it up on their own).');
  } else {
    console.log('Pravex: already up to date.');
  }
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { main };
