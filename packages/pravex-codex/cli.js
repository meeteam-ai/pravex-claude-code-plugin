#!/usr/bin/env node
/**
 * `npx @pravex/codex <command>` — Pravex for OpenAI's Codex CLI on a
 * machine that has no Claude Code.
 *
 *   install               write the three hooks into ~/.codex/hooks.json and copy the reporter
 *   uninstall             remove exactly those hooks
 *   status                what is installed, whether this machine is signed in, and the seat
 *   login [--api-url u]   sign in with the device flow (OAuth, RFC 8628) — nothing to copy or paste
 *   logout                revoke this machine's access and remove its credentials
 *
 * Everything runs the same scripts the Claude Code plugin ships; see
 * `sync-scripts.js`. No dependencies, so `npx` has nothing to fetch beyond this.
 */
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPTS = path.join(__dirname, 'scripts');

function usage() {
  console.error('usage: pravex-codex install | uninstall | status | login [--api-url <url>] | logout');
  return 2;
}

const SCRIPT_FOR = {
  install: 'codex-install.js',
  uninstall: 'codex-install.js',
  status: 'codex-install.js',
  login: 'login.js',
  logout: 'login.js',
};

function main(argv) {
  const [cmd, ...rest] = argv;
  const script = SCRIPT_FOR[cmd];
  if (!script) return usage();
  // codex-install takes the subcommand itself; login.js takes flags. This package signs in
  // as its own OAuth client, `pravex-codex`, so the connection is named for what it is
  // on the Install page.
  const args = cmd === 'login' ? [...rest, '--client', 'codex'] : cmd === 'logout' ? ['--logout'] : [cmd, ...rest];
  return spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { stdio: 'inherit' }).status ?? 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main };
