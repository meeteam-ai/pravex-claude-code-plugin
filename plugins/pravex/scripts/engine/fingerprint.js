'use strict';
/**
 * Whether two failures are the same failure. The output of a check is reduced to what does not change between two
 * runs of the same problem: no paths of this machine, numbers of lines, times, ids or colours.
 */
const crypto = require('crypto');

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const SIGNAL = /\b(error|fail(ed|ing|ure)?|not ok|expected|received|actual|assert|exception|cannot|undefined|TS\d{4}|✗|✕|×|●)\b|^\s*[-+]\s|✗|✕|×|●/i;

function normalise(output) {
  return String(output || '')
    .replace(ANSI, '')
    .replace(/\r/g, '')
    .replace(/(?:[A-Za-z]:)?(?:\/[\w.@+~-]+)+\/([\w.@+-]+)/g, '$1') // absolute paths → file name
    .replace(/\b[0-9a-f]{7,64}\b/gi, '#')
    .replace(/\b\d{4}-\d\d-\d\d[T ][\d:.]+Z?\b/g, '#')
    .replace(/\b\d+(\.\d+)?\s?(ms|s|m|sec|seconds|minutes)\b/gi, '#')
    .replace(/:\d+(:\d+)?/g, ':#')
    .replace(/\(\d+,\d+\)/g, '(#)')
    .replace(/\b(duration_ms|pid|port)\b\D{0,3}\d+(\.\d+)?/gi, '$1 #')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** A short stable id of a failure: what command failed and the lines that say why. */
function fingerprint(failures) {
  const parts = [];
  for (const f of failures || []) {
    const lines = normalise(f.output);
    const said = lines.filter((l) => SIGNAL.test(l));
    parts.push(f.command || f.kind || '', ...[...new Set(said.length ? said : lines.slice(-12))].sort().slice(0, 40));
  }
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 12);
}

/** The end of an output, where tools say what went wrong, without colours. */
const tail = (text, max = 3000) => {
  const t = String(text || '').replace(ANSI, '');
  return t.length > max ? `…${t.slice(-max)}` : t;
};

module.exports = { normalise, fingerprint, tail };
