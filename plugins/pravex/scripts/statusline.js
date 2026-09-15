#!/usr/bin/env node
'use strict';
/**
 * A Pravex segment for Claude Code's status line.
 *
 *   node statusline.js              render (Claude Code runs this; session JSON on stdin)
 *   node statusline.js --install    point ~/.claude/settings.json at it, chaining any existing status line
 *   node statusline.js --uninstall  put the previous status line back
 *
 * Why it installs itself: a plugin cannot declare the main `statusLine`. Plugin
 * `settings.json` supports only `agent` and `subagentStatusLine`
 * (code.claude.com/docs/en/plugins-reference), so the only way onto the line is
 * the user's own settings — which is what other tools that show a status do too.
 *
 * Why it chains: there is one status line. Replacing somebody's existing one to add
 * a dot would be taking something away to add something, so the previous command
 * is saved and run first, and Pravex is appended to what it printed.
 *
 * Why it is copied to ~/.pravex: `${CLAUDE_PLUGIN_ROOT}` changes on every plugin
 * update and the old directory is deleted about two weeks later, which would leave
 * settings.json pointing at nothing. The SessionStart hook refreshes the copy.
 *
 * Standard library only, no requires of the rest of the plugin: this file runs from
 * its copy, away from the plugin directory.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CONFIG_DIR = path.join(os.homedir(), '.pravex');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
// Same directory `report-session.js` writes markers to. Change both together.
const INCOGNITO_DIR = path.join(CONFIG_DIR, 'incognito');
const INSTALLED_COPY = path.join(CONFIG_DIR, 'statusline.js');
const CHAIN_FILE = path.join(CONFIG_DIR, 'statusline.json');
// Written by `update-check.js`, which the SessionStart hook runs in the background.
const UPDATE_FILE = path.join(CONFIG_DIR, 'update-check.json');
const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
/** The status line blocks the UI while it runs; a slow chained command must not. */
const CHAIN_TIMEOUT_MS = 2000;

const COLOR = { green: '\x1b[32m', magenta: '\x1b[35m', yellow: '\x1b[33m', dim: '\x1b[2m', reset: '\x1b[0m' };

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** `watching`, `incognito` or `login` — the three things worth a glance. */
function stateFor(sessionId, env = process.env) {
  const config = readJson(CONFIG_FILE, {});
  const configured = Boolean((env.PRAVEX_API_KEY || config.apiKey) && (env.PRAVEX_API_HOST || config.apiHost));
  if (!configured) return 'login';
  const safe = String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (safe && fs.existsSync(path.join(INCOGNITO_DIR, safe))) return 'incognito';
  return 'watching';
}

function newerThan(latest, installed) {
  const parts = (v) => String(v || '').replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(latest);
  const b = parts(installed);
  for (let i = 0; i < 3; i += 1) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

/** From the cache only: the status line runs on every refresh and must never touch the network. */
function updateAvailable() {
  const cache = readJson(UPDATE_FILE, null);
  return Boolean(cache && cache.latest && cache.installed && newerThan(cache.latest, cache.installed));
}

function segmentFor(state, { color = true, update = false } = {}) {
  const paint = (c, text) => (color ? `${COLOR[c]}${text}${COLOR.reset}` : text);
  let segment;
  if (state === 'login') segment = paint('yellow', '⚠ Pravex: /pravex:login');
  else if (state === 'incognito') segment = paint('magenta', '◌ Pravex incognito');
  else segment = paint('green', '● Pravex');
  // The full command is in the session's start message; the bar only has room to say so.
  return update ? `${segment} ${paint('yellow', '⬆ update')}` : segment;
}

/** Run the status line that was there before, with the same stdin. Empty when there was none or it failed. */
function runPrevious(stdin) {
  const previous = readJson(CHAIN_FILE, {}).previous;
  if (!previous || previous.type !== 'command' || !previous.command) return '';
  const result = spawnSync(previous.command, {
    input: stdin,
    shell: true,
    encoding: 'utf8',
    timeout: CHAIN_TIMEOUT_MS,
    env: process.env,
  });
  return (result.stdout || '').replace(/\s+$/, '');
}

/** Pravex goes on the last line of whatever the previous status line printed. */
function compose(previousOutput, segment) {
  if (!previousOutput) return segment;
  const lines = previousOutput.split('\n');
  lines[lines.length - 1] = `${lines[lines.length - 1]} ${COLOR.dim}│${COLOR.reset} ${segment}`;
  return lines.join('\n');
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function render() {
  const stdin = readStdinSync();
  let session = {};
  try {
    session = JSON.parse(stdin || '{}');
  } catch {
    /* render the segment anyway */
  }
  process.stdout.write(`${compose(runPrevious(stdin), segmentFor(stateFor(session.session_id), { update: updateAvailable() }))}\n`);
}

function commandFor(file) {
  return `node "${file}"`;
}

function isOurs(statusLine) {
  return Boolean(statusLine && typeof statusLine.command === 'string' && statusLine.command.includes(INSTALLED_COPY));
}

/** Copy this file to its stable home. Called by --install and on every session start once installed. */
function refreshCopy(source = __filename) {
  if (path.resolve(source) === path.resolve(INSTALLED_COPY)) return;
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, INSTALLED_COPY);
}

function install() {
  refreshCopy();
  const settings = readJson(SETTINGS_FILE, null);
  if (settings === null && fs.existsSync(SETTINGS_FILE)) {
    console.log(`Pravex: ${SETTINGS_FILE} is not valid JSON, so it was left alone. Fix it and run this again.`);
    return 1;
  }
  const next = settings || {};
  if (isOurs(next.statusLine)) {
    console.log('Pravex: the status line is already installed.');
    return 0;
  }
  if (next.statusLine) {
    fs.writeFileSync(CHAIN_FILE, JSON.stringify({ previous: next.statusLine }, null, 2), { mode: 0o600 });
    fs.copyFileSync(SETTINGS_FILE, `${SETTINGS_FILE}.pravex-backup`);
  }
  next.statusLine = { type: 'command', command: commandFor(INSTALLED_COPY), ...(next.statusLine?.padding !== undefined ? { padding: next.statusLine.padding } : {}) };
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`);
  console.log('Pravex: status line installed. It shows ● Pravex while a session is recorded,');
  console.log('◌ Pravex incognito after /pravex:incognito, and ⚠ when this machine needs /pravex:login.');
  if (readJson(CHAIN_FILE, {}).previous) console.log('Your existing status line still runs first; Pravex is added after it.');
  return 0;
}

function uninstall() {
  const settings = readJson(SETTINGS_FILE, null);
  if (!settings || !isOurs(settings.statusLine)) {
    console.log('Pravex: the status line is not installed, so nothing changed.');
    return 0;
  }
  const previous = readJson(CHAIN_FILE, {}).previous;
  if (previous) settings.statusLine = previous;
  else delete settings.statusLine;
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
  for (const file of [CHAIN_FILE, INSTALLED_COPY]) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  }
  console.log(previous ? 'Pravex: status line removed; your previous one is back.' : 'Pravex: status line removed.');
  return 0;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--install')) process.exitCode = install();
  else if (argv.includes('--uninstall')) process.exitCode = uninstall();
  else {
    try {
      render();
    } catch {
      // A broken status line is worse than a missing segment.
      process.stdout.write('\n');
    }
  }
}

module.exports = { INCOGNITO_DIR, INSTALLED_COPY, UPDATE_FILE, compose, install, newerThan, refreshCopy, segmentFor, stateFor, uninstall };
