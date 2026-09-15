#!/usr/bin/env node
'use strict';
/**
 * Is a newer Pravex plugin published?
 *
 *   node update-check.js           check now (the SessionStart hook runs this detached)
 *
 * Why this exists: Claude Code does not auto-update a third-party marketplace unless
 * the user turns it on, so an install silently stays on the version it started with.
 * One machine sat on 0.1.0 — no live reporting — until somebody noticed by hand.
 *
 * The pattern is the one other Claude Code tools use: the session-start hook spawns
 * this in the background so startup never waits on the network, it writes the answer
 * to a cache file, and the status line and the next session's start message read
 * that file. It never updates anything itself; updating is the user's call.
 *
 * Standard library only.
 */
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const CACHE_FILE = path.join(os.homedir(), '.pravex', 'update-check.json');
/** The published manifest. The repository is public, so no credentials are involved. */
const LATEST_URL = 'https://raw.githubusercontent.com/meeteam-ai/pravex-claude-code-plugin/main/plugins/pravex/.claude-plugin/plugin.json';
/** Twice a day is plenty for something released a few times a month. */
const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;
const TIMEOUT_MS = 5000;

function installedVersion() {
  try {
    return require('../.claude-plugin/plugin.json').version;
  } catch {
    return null;
  }
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** `1.2.3` → `[1, 2, 3]`; anything unparseable compares as zero. */
function parse(version) {
  return String(version || '')
    .replace(/^v/, '')
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function isNewer(latest, installed) {
  const a = parse(latest);
  const b = parse(installed);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

/**
 * Whether the cached answer is still good for this install. An update changes the
 * installed version, which invalidates the cache immediately — otherwise a machine
 * would keep saying "update available" for twelve hours after updating.
 */
function isFresh(cache, installed, now = Date.now()) {
  return Boolean(cache && cache.installed === installed && now - (cache.checkedAt || 0) < CHECK_EVERY_MS);
}

/** What the start message and the status line need, from the cache alone — never the network. */
function updateStatus(cache = readCache(), installed = installedVersion()) {
  if (!cache || !cache.latest || !installed) return { available: false };
  // Compare against the version running now, not the one cached: after an update the
  // cache is stale until the next check, and must not keep nagging.
  return { available: isNewer(cache.latest, installed), installed, latest: cache.latest };
}

function fetchLatest(url = LATEST_URL) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: TIMEOUT_MS, headers: { 'User-Agent': 'pravex-claude-code-plugin' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data).version || null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

async function check({ fetch = fetchLatest, now = Date.now() } = {}) {
  const installed = installedVersion();
  if (isFresh(readCache(), installed, now)) return readCache();
  const latest = await fetch();
  // A failed fetch writes nothing, so the last good answer stands and the next
  // session tries again.
  if (!latest) return readCache();
  const result = { installed, latest, checkedAt: now, updateAvailable: isNewer(latest, installed) };
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(result), { mode: 0o600 });
  return result;
}

if (require.main === module) {
  check()
    .catch(() => undefined)
    .finally(() => process.exit(0));
}

module.exports = { CACHE_FILE, check, isFresh, isNewer, parse, updateStatus };
