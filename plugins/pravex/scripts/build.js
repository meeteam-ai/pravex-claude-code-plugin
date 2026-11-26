#!/usr/bin/env node
'use strict';
/**
 * Builds a requirement end to end on this computer: `node build.js "what should be done" [--repo <dir>]`.
 *
 *   build.js "<requirement>" [--repo dir] [--file spec.pdf]… [--max-usd 60] [--max-hours 6] [--check "npm test"]…
 *   build.js --list | --status <id> | --resume <id> [--max-usd n] | --stop <id>
 */
const fs = require('fs');
const path = require('path');
const engine = require('./engine/engine');
const journal = require('./engine/journal');
const machine = require('./engine/machine');
const { explain } = require('./engine/report');

const LISTS = ['file', 'check', 'model'];
const FLAGS = ['list', 'json'];

function parse(argv) {
  const o = { file: [], check: [], model: [], _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      o._.push(a);
      continue;
    }
    const name = a.slice(2);
    if (FLAGS.includes(name)) o[name] = true;
    else {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      if (LISTS.includes(name)) o[name].push(value);
      else o[name] = value;
    }
  }
  return o;
}

function number(v, name) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a number above 0`);
  return n;
}

function cfgOf(o) {
  const cfg = {};
  for (const [flag, key] of [['max-usd', 'maxUsd'], ['max-hours', 'maxHours'], ['job-usd', 'jobUsd'], ['max-tasks', 'maxTasks']]) {
    const n = number(o[flag], flag);
    if (n !== undefined) cfg[key] = n;
  }
  if (o.check.length) cfg.checks = o.check;
  return cfg;
}

const builds = () => (fs.existsSync(engine.BUILDS) ? fs.readdirSync(engine.BUILDS).sort() : []);

function dirOf(id) {
  const found = builds().filter((x) => x === id || x.startsWith(String(id)));
  if (found.length !== 1) throw new Error(found.length ? `${id} matches ${found.length} builds` : `there is no build ${id}`);
  return path.join(engine.BUILDS, found[0]);
}

function summary(dir) {
  const s = machine.fold(journal.read(dir));
  const done = s.tasks.filter((t) => t.phase === 'done').length;
  return { id: path.basename(dir), status: s.final || (s.paused ? `paused: ${s.paused}` : 'open'), parts: `${done}/${s.tasks.length}`, usd: s.usd.toFixed(2), text: String((s.req && s.req.text) || '').slice(0, 60) };
}

function log(what, state, more) {
  const spent = more && more.usd !== undefined ? ` (US$${more.usd.toFixed(2)}, ${Math.round(more.ms / 1000)} s)` : '';
  console.log(`${new Date().toISOString().slice(11, 19)} ${what}: ${state}${spent}`);
}

async function main(argv) {
  const o = parse(argv);
  if (o.list) {
    for (const x of builds()) console.log(Object.values(summary(path.join(engine.BUILDS, x))).join('  '));
    return 0;
  }
  if (o.status) {
    const dir = dirOf(o.status);
    const s = machine.fold(journal.read(dir));
    const tasks = s.tasks.map((t) => ({ id: t.id, title: t.title, phase: t.phase, round: t.round, blocked: t.blocked && t.blocked.reason }));
    console.log(JSON.stringify({ ...summary(dir), next: machine.next(s).do, explain: explain(s), tasks, cost: s.cost }, null, 2));
    return 0;
  }
  if (o.stop) {
    engine.stop(dirOf(o.stop));
    console.log('It will stop within a second. Nothing is lost.');
    return 0;
  }
  let dir;
  if (o.resume) dir = dirOf(o.resume);
  else {
    if (!o._.length) throw new Error('say what should be done');
    const isFile = o._.length === 1 && fs.existsSync(o._[0]) && fs.statSync(o._[0]).isFile();
    const text = isFile ? fs.readFileSync(o._[0], 'utf8') : o._.join(' ');
    const made = engine.create({ repoDir: path.resolve(o.repo || process.cwd()), text, files: o.file, base: o.base, locale: o.locale || 'es', cfg: cfgOf(o) });
    dir = made.dir;
    console.log(`build ${made.id}`);
  }
  const cfg = o.resume ? cfgOf(o) : {};
  const models = Object.fromEntries(o.model.map((m) => m.split('=')));
  const r = await engine.drive(dir, { log, models, ...(Object.keys(cfg).length ? { cfg } : {}) });
  const file = path.join(dir, 'report.md');
  if (fs.existsSync(file)) console.log(`\n${fs.readFileSync(file, 'utf8')}`);
  if (r.explain) console.log(`${r.explain.what} ${r.explain.did} ${r.explain.todo}`);
  console.log(dir);
  return { done: 0, partial: 2, infeasible: 3 }[r.status] ?? 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`Pravex: ${e.message}`);
      process.exit(1);
    }
  );
}

module.exports = { parse, main };
