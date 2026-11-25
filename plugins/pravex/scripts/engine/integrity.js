'use strict';
/**
 * What an agent may have changed, checked by code after every job: the files of its task and nothing else, never the
 * frozen tests, the protected paths or the checks themselves. What breaks a rule is put back as it was.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { matches, clean } = require('./globs');

/** Never an agent's to change, whatever a plan says. */
const ALWAYS_PROTECTED = ['.git/**', '.github/workflows/**', '.husky/**', '.claude/**', '.pravex/**', '.mcp.json', '.env', '**/.env', '**/.env.*'];

const hashOf = (dir, file) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex');
  } catch {
    return null;
  }
};

const hashFiles = (dir, files) => Object.fromEntries(files.map((f) => [f, hashOf(dir, f)]));

/** The frozen tests whose content is not what was frozen (changed or deleted). */
const changedTests = (dir, hashes) => Object.keys(hashes || {}).filter((f) => hashOf(dir, f) !== hashes[f]);

/**
 * Splits changed files into what the role may change and what it may not. A tester writes tests; a builder writes the
 * task's files, new or existing, and never a frozen test.
 */
function judge(changed, { allow = [], frozen = {}, protectedGlobs = [] }) {
  const kept = [];
  const violations = [];
  for (const raw of changed) {
    const f = clean(raw);
    if (matches(f, ALWAYS_PROTECTED) || matches(f, protectedGlobs)) violations.push({ file: f, rule: 'protected' });
    else if (Object.prototype.hasOwnProperty.call(frozen, f)) violations.push({ file: f, rule: 'frozen-test' });
    else if (!matches(f, allow)) violations.push({ file: f, rule: 'out-of-scope' });
    else kept.push(f);
  }
  return { kept, violations };
}

/**
 * Ways to make a check pass without doing the work, in the lines a change adds: skipped or focused tests, silenced
 * type or lint errors. A finding sends the task back; it is never "done" with one.
 */
const DODGES = [
  [/\b(?:it|test|describe|suite|context)\.(?:skip|only|todo)\b|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/, 'skipped-test'],
  [/@pytest\.mark\.(?:skip|xfail)|@(?:Disabled|Ignore)\b|\bt\.Skip\(/, 'skipped-test'],
  [/@ts-(?:ignore|nocheck)\b|eslint-disable(?!-next-line\s+\S+\s+--)|biome-ignore(?!\s+\S+:\s*\S)|#\s*(?:type:\s*ignore|noqa)\b|\/\/\s*nolint\b/, 'silenced-check'],
];

function dodges(diff) {
  const found = [];
  let file = '';
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '').trim();
    else if (line.startsWith('+')) for (const [re, rule] of DODGES) if (re.test(line)) found.push({ file, rule, line: line.slice(1).trim().slice(0, 160) });
  }
  return found;
}

module.exports = { ALWAYS_PROTECTED, hashFiles, hashOf, changedTests, judge, dodges };
