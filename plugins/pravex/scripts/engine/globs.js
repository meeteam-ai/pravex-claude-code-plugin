'use strict';
/** Path patterns of a plan: `**` any depth, `*` within a name, a folder covers what is in it. Nothing else. */

const clean = (p) => String(p || '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');

function toRegExp(glob) {
  let g = clean(glob);
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // A pattern with no wildcard in its last part also covers a folder of that name.
  return new RegExp(`^${re}(?:/.*)?$`);
}

const matches = (file, globs) => (globs || []).some((g) => toRegExp(g).test(clean(file)));

module.exports = { clean, toRegExp, matches };
