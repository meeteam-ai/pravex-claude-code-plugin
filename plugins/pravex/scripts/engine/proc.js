'use strict';
/** Starting programs: own process group, a time limit, an idle limit, and nothing secret in their environment. */
const { spawn } = require('child_process');

const isWindows = process.platform === 'win32';

/** Variables a check or an agent never needs and must not see. */
const SECRET = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIALS?)($|_)|^AWS_|^GH_|^GITHUB_|^NPM_CONFIG_.*AUTH|^PRAVEX_|^DATABASE_URL$|^SSH_AUTH_SOCK$/i;

/** Variables of whatever started the engine that would change what a check or an agent does: a nested `node --test` passes without running. */
const INHERITED = /^NODE_TEST_CONTEXT$|^NODE_OPTIONS$|^NODE_V8_COVERAGE$|^VITEST|^JEST_|^CLAUDECODE$|^CLAUDE_CODE_|^CLAUDE_PLUGIN_|^CLAUDE_PROJECT_DIR$|^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG)/;

/** The environment of everything the engine starts: no secrets, and no way to push or sign in to anything. */
function cleanEnv(base = process.env, { keep = [] } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if ((!SECRET.test(k) && !INHERITED.test(k)) || keep.includes(k)) env[k] = v;
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'false',
    GIT_SSH_COMMAND: 'false',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'url.https://pravex-no-push.invalid/.pushInsteadOf',
    GIT_CONFIG_VALUE_1: 'https://',
    GIT_CONFIG_KEY_2: 'url.https://pravex-no-push.invalid/ssh/.pushInsteadOf',
    GIT_CONFIG_VALUE_2: 'git@',
    GH_PROMPT_DISABLED: '1',
    AWS_EC2_METADATA_DISABLED: 'true',
    CI: env.CI || '1',
  });
  return env;
}

function killGroup(child, signal) {
  try {
    if (isWindows) spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    else process.kill(-child.pid, signal);
  } catch {
    /* already gone */
  }
}

/**
 * Runs a program to its end. Never rejects: `{ code, out, err, ms, why }`, where `why` is null or what stopped it
 * (`timeout`, `idle`, `stopped`, `missing`). Output is kept from its end, so a chatty program cannot fill the memory.
 */
function run(cmd, args = [], { cwd, env, input, timeoutMs = 20 * 60e3, idleMs = 0, maxBytes = 400_000, onLine, signal, shell = false } = {}) {
  return new Promise((resolve) => {
    const began = Date.now();
    let out = '';
    let err = '';
    let why = null;
    let settled = false;
    let pending = '';
    let idle = null;
    let child;
    const keep = (s, d) => {
      const t = s + d;
      return t.length > maxBytes ? t.slice(-maxBytes) : t;
    };
    const timers = [];
    const stop = (reason) => {
      if (why || settled) return;
      why = reason;
      if (!child || !child.pid) return;
      killGroup(child, 'SIGTERM');
      timers.push(setTimeout(() => killGroup(child, 'SIGKILL'), 5000));
    };
    const finish = (code) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      clearTimeout(idle);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (onLine && pending.trim()) onLine(pending);
      resolve({ code, out, err, ms: Date.now() - began, why });
    };
    const onAbort = () => stop('stopped');
    const bump = () => {
      if (!idleMs) return;
      clearTimeout(idle);
      idle = setTimeout(() => stop('idle'), idleMs);
    };
    try {
      child = spawn(cmd, args, { cwd, env, shell, detached: !isWindows, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      err = e.message;
      why = 'missing';
      return finish(127);
    }
    child.on('error', (e) => {
      err = keep(err, e.message);
      if (e.code === 'ENOENT') why = 'missing';
      finish(127);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      bump();
      out = keep(out, d);
      if (!onLine) return;
      pending += d;
      let i;
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 1);
        if (line.trim()) onLine(line);
      }
    });
    child.stderr.on('data', (d) => {
      bump();
      err = keep(err, d);
    });
    // A grandchild can hold the pipes open after the program ended: do not wait for it for ever.
    child.on('exit', (code) => timers.push(setTimeout(() => finish(code === null ? 1 : code), 3000)));
    child.on('close', (code) => finish(code === null ? 1 : code));
    timers.push(setTimeout(() => stop('timeout'), timeoutMs));
    bump();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort);
    }
  });
}

module.exports = { run, cleanEnv, SECRET };
