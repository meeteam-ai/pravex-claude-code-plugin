#!/usr/bin/env node
/**
 * Copies the reporter out of the plugin into this package before packing.
 *
 * `plugins/pravex/scripts` is the only source of truth: the Claude Code plugin
 * and this npm package ship byte-identical files, so a fix lands in both by
 * being made once. The copy is gitignored; `npm pack` and `npm publish` run
 * this through `prepack`.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..', '..', 'plugins', 'pravex');
/** The installer owns the list of what a working copy needs; this package ships exactly that. */
const FILES = require(path.join(PLUGIN, 'scripts', 'codex-install.js')).COPY_FILES;

function sync() {
  const scripts = path.join(__dirname, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  for (const file of FILES) fs.copyFileSync(path.join(PLUGIN, 'scripts', file), path.join(scripts, file));
  const manifestDir = path.join(__dirname, '.claude-plugin');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.copyFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), path.join(manifestDir, 'plugin.json'));
  return FILES.length;
}

if (require.main === module) {
  console.log(`synced ${sync()} scripts from plugins/pravex`);
}

module.exports = { FILES, sync };
