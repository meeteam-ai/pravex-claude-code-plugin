#!/usr/bin/env node
/**
 * Installs the Pravex reporter as Codex CLI hooks, and removes it again.
 *
 *   node codex-install.js install
 *   node codex-install.js uninstall
 *   node codex-install.js status
 *
 * Codex has no plugin marketplace. Its hooks are entries in `~/.codex/hooks.json`
 * (or `.codex/hooks.json` in a repo) that run a command with the event payload on
 * stdin — the same shape Claude Code uses. So this copies the reporter and the
 * files it requires to `~/.pravex/codex/scripts/` and points three hooks at it:
 *
 *   SessionStart  --start    --agent codex   live report and the sweep
 *   Stop          --progress --agent codex   running numbers after each turn
 *   SessionEnd    --end-detached --agent codex   the final report, from a child
 *
 * `SessionEnd` is the one that differs: Codex caps it at three seconds, so the
 * hook only spawns a detached child and returns. Every `SessionStart` of either
 * agent refreshes the copy, which is how a plugin update reaches these hooks.
 *
 * The merge is idempotent and touches nothing that is not ours: entries are
 * recognised by the command pointing into `~/.pravex/codex/`. Invalid JSON in
 * `hooks.json` aborts rather than overwrites; the previous file is kept as
 * `hooks.json.pravex-backup` before every write.
 *
 * Standard library only, like everything else in this plugin.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CONFIG_DIR = path.join(os.homedir(), '.pravex');
const COPY_DIR = path.join(CONFIG_DIR, 'codex');
const COPY_SCRIPTS = path.join(COPY_DIR, 'scripts');
/**
 * The reporter and everything it requires, including this installer (the copy's
 * `SessionStart` refreshes itself through it). The one list: `report-session.js`
 * and the npm package's `sync-scripts.js` both read it from here.
 */
const COPY_FILES = ['report-session.js', 'codex-rollout.js', 'codex-install.js', 'update-check.js', 'statusline.js', 'login.js'];
const COPY_MANIFEST = path.join(COPY_DIR, '.claude-plugin', 'plugin.json');
const HOOKS_FILE = path.join(os.homedir(), '.codex', 'hooks.json');
const BACKUP_FILE = `${HOOKS_FILE}.pravex-backup`;

/** What each Codex event runs. Timeouts in seconds; SessionEnd's is Codex's own cap. */
const HOOKS = [
  ['SessionStart', '--start --agent codex', 30],
  ['Stop', '--progress --agent codex', 15],
  ['SessionEnd', '--end-detached --agent codex', 3],
];

function commandFor(args) {
  return `node "${path.join(COPY_SCRIPTS, 'report-session.js')}" ${args}`;
}

/** Whether a hook entry is one this installer wrote, whatever its arguments. */
function isOurs(hook) {
  return Boolean(hook && typeof hook.command === 'string' && hook.command.includes(path.join('.pravex', 'codex')));
}

/** Copy the reporter and its manifest so relative requires and the version lookup resolve. */
function copyScripts(sourceDir) {
  fs.mkdirSync(COPY_SCRIPTS, { recursive: true, mode: 0o700 });
  for (const file of COPY_FILES) fs.copyFileSync(path.join(sourceDir, file), path.join(COPY_SCRIPTS, file));
  const manifest = path.join(sourceDir, '..', '.claude-plugin', 'plugin.json');
  if (fs.existsSync(manifest)) {
    fs.mkdirSync(path.dirname(COPY_MANIFEST), { recursive: true, mode: 0o700 });
    fs.copyFileSync(manifest, COPY_MANIFEST);
  }
}

function versionOf(manifest) {
  try {
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).version || null;
  } catch {
    return null;
  }
}

/**
 * Keep an installed copy current, from the plugin's `SessionStart`.
 *
 * Opt-in: nothing is copied until `install` has run once. After that a copy is
 * refreshed only when its manifest version differs from the running plugin's —
 * one small read per session start rather than six file writes. A no-op when
 * the caller *is* the copy.
 */
function refresh(sourceDir) {
  if (path.resolve(sourceDir) === path.resolve(COPY_SCRIPTS)) return false;
  if (!fs.existsSync(path.join(COPY_SCRIPTS, 'report-session.js'))) return false;
  const running = versionOf(path.join(sourceDir, '..', '.claude-plugin', 'plugin.json'));
  if (running && running === versionOf(COPY_MANIFEST)) return false;
  copyScripts(sourceDir);
  return true;
}

/** `~/.codex/hooks.json` parsed, `{}` when absent. Throws on invalid JSON so nothing is overwritten. */
function readHooks() {
  if (!fs.existsSync(HOOKS_FILE)) return {};
  const raw = fs.readFileSync(HOOKS_FILE, 'utf8');
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${HOOKS_FILE} is not a JSON object`);
  return parsed;
}

function writeHooks(doc) {
  fs.mkdirSync(path.dirname(HOOKS_FILE), { recursive: true });
  if (fs.existsSync(HOOKS_FILE)) fs.copyFileSync(HOOKS_FILE, BACKUP_FILE);
  fs.writeFileSync(HOOKS_FILE, `${JSON.stringify(doc, null, 2)}\n`);
}

/** Drop our entries from every event, and empty groups that only held ours. */
function withoutOurs(doc) {
  const next = { ...doc, hooks: {} };
  for (const [event, groups] of Object.entries(doc.hooks || {})) {
    if (!Array.isArray(groups)) {
      next.hooks[event] = groups;
      continue;
    }
    const kept = groups
      .map((group) => (group && Array.isArray(group.hooks) ? { ...group, hooks: group.hooks.filter((h) => !isOurs(h)) } : group))
      .filter((group) => !(group && Array.isArray(group.hooks) && group.hooks.length === 0));
    if (kept.length) next.hooks[event] = kept;
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

function install(sourceDir = __dirname) {
  const doc = readHooks(); // throws first, before anything is copied
  copyScripts(sourceDir);
  const next = withoutOurs(doc);
  next.hooks = next.hooks || {};
  for (const [event, args, timeout] of HOOKS) {
    const groups = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    groups.push({ hooks: [{ type: 'command', command: commandFor(args), timeout }] });
    next.hooks[event] = groups;
  }
  writeHooks(next);
  return { hooksFile: HOOKS_FILE, scripts: COPY_SCRIPTS };
}

function uninstall() {
  if (!fs.existsSync(HOOKS_FILE)) return { removed: false };
  const doc = readHooks();
  const next = withoutOurs(doc);
  const removed = JSON.stringify(next) !== JSON.stringify(doc);
  if (removed) writeHooks(next);
  return { removed };
}

function status() {
  let doc;
  try {
    doc = readHooks();
  } catch (err) {
    return { installed: false, error: err && err.message, events: [] };
  }
  const events = Object.entries(doc.hooks || {})
    .filter(([, groups]) => Array.isArray(groups) && groups.some((g) => g && Array.isArray(g.hooks) && g.hooks.some(isOurs)))
    .map(([event]) => event);
  return { installed: events.length === HOOKS.length, events, scripts: COPY_SCRIPTS };
}

function main(argv) {
  const cmd = argv[0] || 'status';
  if (cmd === 'install') {
    const r = install();
    console.log(`Pravex: Codex hooks installed in ${r.hooksFile}`);
    console.log(`Reporter: ${r.scripts}`);
    console.log('Sessions report with the credential in ~/.pravex/config.json — run the login if that is empty.');
    return 0;
  }
  if (cmd === 'uninstall') {
    const r = uninstall();
    console.log(r.removed ? `Pravex: Codex hooks removed from ${HOOKS_FILE}` : 'Pravex: no Codex hooks to remove');
    return 0;
  }
  if (cmd === 'status') {
    const r = status();
    if (r.error) console.log(`Pravex: cannot read ${HOOKS_FILE} (${r.error})`);
    else if (r.installed) console.log(`Pravex: Codex hooks installed (${r.events.join(', ')})`);
    else if (r.events.length) console.log(`Pravex: Codex hooks partly installed (${r.events.join(', ')}) — run install again`);
    else console.log('Pravex: Codex hooks not installed');
    const login = spawnSync(process.execPath, [path.join(__dirname, 'login.js'), '--status'], { encoding: 'utf8' });
    if (login.stdout) process.stdout.write(login.stdout);
    return 0;
  }
  console.error(`usage: codex-install.js install | uninstall | status (got ${cmd})`);
  return 2;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`Pravex: ${err && err.message}`);
    process.exit(1);
  }
}

module.exports = { COPY_FILES, COPY_SCRIPTS, HOOKS_FILE, copyScripts, install, isOurs, refresh, status, uninstall };
