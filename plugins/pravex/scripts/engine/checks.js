'use strict';
/** The commands that decide whether work is done. The engine runs them itself; an agent's word is not a result. */
const { run, cleanEnv } = require('./proc');
const { tail } = require('./fingerprint');

/** No shell characters at all: a command from a plan or an agent is only ever a program and its arguments. */
const PLAIN = /^[A-Za-z0-9 _./@=:+-]+$/;
const PROGRAMS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'node', 'deno', 'python', 'python3', 'pytest', 'uv', 'poetry', 'ruff', 'mypy', 'go', 'cargo', 'dotnet', 'mvn', './mvnw', 'gradle', './gradlew', 'make', 'bundle', 'rake', 'php', 'composer', 'phpunit', 'vendor/bin/phpunit', 'swift', 'mix', 'turbo', 'nx', 'vitest', 'jest', 'tsc']);
/** Ways a plain command would fetch or publish something instead of checking. */
const NOT_A_CHECK = /^(npm|pnpm|yarn|bun) (publish|login|adduser|dlx|x|create|init|add|install|i|remove|config|run (deploy|release|publish)|deploy|release)\b|\b(deploy|publish|release|migrate)\b/;

const allowed = (command) => {
  const c = String(command || '').trim().replace(/\s+/g, ' ');
  return PLAIN.test(c) && PROGRAMS.has(c.split(' ')[0]) && !NOT_A_CHECK.test(c) && !c.includes('..') && !/(^| )\//.test(c);
};

/**
 * One command. A failure is tried once more: a check that fails and then passes with nothing changed is unstable, and
 * says so, instead of sending an agent after a problem that is not there.
 */
async function check(command, { cwd, timeoutMs = 20 * 60e3, signal, retry = true, env } = {}) {
  const c = String(command).trim().replace(/\s+/g, ' ');
  if (!allowed(c)) return { command: c, ok: false, refused: true, ms: 0, output: `not a command the engine runs: ${c}` };
  const [program, ...args] = c.split(' ');
  const once = () => run(program, args, { cwd, timeoutMs, signal, env: env || cleanEnv(), maxBytes: 200_000 });
  let r = await once();
  let flaky = false;
  let ms = r.ms;
  if (r.code !== 0 && retry && !r.why) {
    const again = await once();
    ms += again.ms;
    flaky = again.code === 0;
    r = again;
  }
  const ok = r.code === 0 && !r.why;
  // Read on the whole output: the line that says why it could not run is usually at the top, and `output` keeps the end.
  const problem = ok || r.why ? null : require('./readiness').envProblem(`${r.out}\n${r.err}`);
  return { command: c, ok, ...(flaky ? { flaky } : {}), ...(r.why ? { why: r.why } : {}), ...(problem ? { problem } : {}), exit: r.code, ms, output:ok ? '' : tail(`${r.out}\n${r.err}${r.why === 'timeout' ? `\nstopped: it took longer than ${Math.round(timeoutMs / 60e3)} min` : ''}`) };
}

module.exports = { check, allowed, PLAIN };
