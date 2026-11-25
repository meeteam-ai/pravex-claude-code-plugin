'use strict';
/**
 * The journal of a run: one JSON event per line, appended and flushed before anything is done about it. The state of
 * a run is rebuilt from here (machine.js), so a crash, a sleep or a closed laptop loses at most the job in progress.
 */
const fs = require('fs');
const path = require('path');

const FILE = 'events.jsonl';

/** Every event written so far. A last line cut short by a crash is dropped, not fatal. */
function read(dir) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(dir, FILE), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* the line a crash cut short */
    }
  }
  return out;
}

/** Appends one event and waits for the disk. A journal whose last line has no newline gets one first. */
function append(dir, event) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, FILE);
  const fd = fs.openSync(file, 'a+', 0o600);
  try {
    const { size } = fs.fstatSync(fd);
    let glue = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 10) glue = '\n';
    }
    const e = { at: new Date().toISOString(), ...event };
    fs.writeSync(fd, `${glue}${JSON.stringify(e)}\n`);
    fs.fsyncSync(fd);
    return e;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { FILE, read, append };
