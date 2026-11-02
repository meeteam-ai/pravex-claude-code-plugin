'use strict';
/**
 * How this machine proves who it is to Pravex: OAuth 2.0 tokens from Pravex's own
 * authorization server (pravex-backend ADR 0033, `docs/AUTH.md`).
 *
 *   ~/.pravex/config.json   { version: 2, apiHost, clientId, accessToken, refreshToken, expiresAt }
 *   ~/.pravex/auth.lock     held while a refresh is in flight
 *
 * Shared by the Claude Code plugin and `@pravex/codex`, which ship these files
 * byte for byte. It does the device grant (RFC 8628) and keeps the token pair
 * fresh for the hooks.
 *
 * ⚠️ **Refresh tokens rotate.** The old one dies the moment it is used, and
 * presenting a used one revokes the whole connection. Hooks of several sessions
 * overlap (every `Stop`, every `SessionEnd`, a detached Codex child), so a refresh
 * is one critical section behind a lock file: read the config, re-check that
 * someone else has not already refreshed, call the server, write the new pair
 * atomically. Nothing uses a new access token before its refresh token is on disk.
 *
 * Standard library only, like everything else in this plugin.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const CONFIG_DIR = path.join(os.homedir(), '.pravex');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const LOCK_FILE = path.join(CONFIG_DIR, 'auth.lock');
const DEFAULT_HOST = 'https://pravex.tenox.ai';

const CLIENTS = { 'claude-code': 'pravex-claude-code', codex: 'pravex-codex' };
const DEFAULT_CLIENT_ID = CLIENTS['claude-code'];
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** Refresh this long before the access token lapses, so a request never leaves with one about to die. */
const REFRESH_SKEW_MS = 60 * 1000;
/** RFC 8628 §3.5: poll no faster than this, and add it again on every `slow_down`. */
const DEVICE_MIN_INTERVAL_MS = 5000;
/** Stop polling after this long whatever the server says, so it cannot spin forever. */
const DEVICE_CEILING_MS = 10 * 60 * 1000;
/** A refresh that long ago started is dead (a killed hook), so its lock may be broken. Longer than any request below. */
const LOCK_STALE_MS = 30 * 1000;
/** The longest a hook waits for another process's refresh. */
const LOCK_WAIT_MS = 15 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;

const PLUGIN_VERSION = (() => {
  try {
    return require('../.claude-plugin/plugin.json').version;
  } catch {
    return 'unknown';
  }
})();

const MESSAGES = {
  'legacy-key':
    'Pravex: this machine was connected with an API key (pvx_…), which Pravex no longer accepts. Run /pravex:login to connect again.',
  revoked:
    'Pravex: this machine was disconnected (from the Install page, by a workspace admin, or after 30 days unused). Run /pravex:login to connect again.',
  'signed-out': 'Pravex: not connected, so this session will not be reported. Run /pravex:login.',
  unavailable: 'Pravex: could not reach the server to renew this machine\u2019s access. It will try again on the next session.',
};

/** Why a machine is not connected, in words for a person. */
const messageFor = (reason) => MESSAGES[reason] || MESSAGES['signed-out'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── transport ───────────────────────────────────────────────────────────────

/**
 * One HTTP exchange; rejects on a transport failure and never on a status.
 * `form` is sent form-encoded (the OAuth endpoints), `json` as JSON. The whole
 * exchange is bounded by `timeoutMs`, not just an idle socket.
 */
function request(apiHost, route, { method = 'GET', headers = {}, form, json, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiHost);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${route}`;
    const client = url.protocol === 'https:' ? https : http;
    let payload;
    let type;
    if (form) {
      payload = new URLSearchParams(form).toString();
      type = 'application/x-www-form-urlencoded';
    } else if (json !== undefined) {
      payload = JSON.stringify(json);
      type = 'application/json';
    }
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = client.request(
      url,
      {
        method,
        headers: {
          Accept: 'application/json',
          'User-Agent': `pravex-claude-code-plugin/${PLUGIN_VERSION}`,
          ...headers,
          ...(payload === undefined ? {} : { 'Content-Type': type, 'Content-Length': Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => done(resolve, { status: res.statusCode, body: data }));
        res.on('error', (err) => done(reject, err));
      },
    );
    const timer = setTimeout(() => {
      done(reject, new Error('timeout'));
      req.destroy();
    }, timeoutMs);
    req.on('error', (err) => done(reject, err));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** An OAuth endpoint's own answer: `{ status, json }`, where `json` is `{}` when the body was not JSON. */
async function oauthPost(apiHost, route, form, timeoutMs) {
  const res = await request(apiHost, route, { method: 'POST', form, timeoutMs });
  let json = {};
  try {
    json = JSON.parse(res.body) || {};
  } catch {
    /* an HTML error page from a proxy; the status says enough */
  }
  return { status: res.status, json, body: res.body };
}

function oauthError(res, what) {
  const detail = res.json.error_description || (typeof res.json.error === 'string' && res.json.error) || `HTTP ${res.status}`;
  return new Error(`${what}: ${detail}`);
}

// ── config ──────────────────────────────────────────────────────────────────

function readRaw() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Write through a temporary file and a rename, so a reader never sees half a pair. */
function writeConfigAtomic(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = path.join(CONFIG_DIR, `config.json.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 2, ...config }, null, 2)}\n`, { mode: 0o600 });
    // `mode` only applies on creation; the temp file is always new, but be explicit.
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, CONFIG_FILE);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never created */
    }
    throw err;
  }
}

/**
 * The stored configuration.
 *
 * A config from before OAuth holds a `pvx_` key that the server no longer
 * accepts. There is nothing to migrate it to, so it is dropped on first sight:
 * the host is kept and the file records why, so the next session start says
 * "run /pravex:login again" instead of silently reporting nothing.
 */
function readConfig() {
  const raw = readRaw();
  if (raw.apiKey !== undefined) {
    const next = { apiHost: raw.apiHost, signedOut: 'legacy-key' };
    try {
      writeConfigAtomic(next);
    } catch {
      /* read-only home; the answer is still right for this run */
    }
    return { version: 2, ...next };
  }
  return raw;
}

const hasTokens = (config) => Boolean(config.apiHost && config.refreshToken && config.accessToken);

// ── the lock ────────────────────────────────────────────────────────────────

/**
 * Run `fn` while holding `~/.pravex/auth.lock`; resolves `{ locked: false }` when
 * the lock could not be had in time (the caller decides what that means).
 *
 * The lock is a file created with `wx`, so exactly one process makes it. One whose
 * owner died is older than `LOCK_STALE_MS` and is renamed away before a retry: the
 * rename succeeds for one process only, so two waiters cannot both break it and
 * both proceed.
 */
async function withLock(fn, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS, lockFile = LOCK_FILE } = {}) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const owner = `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  const deadline = Date.now() + waitMs;
  let delay = 25;
  for (;;) {
    try {
      fs.writeFileSync(lockFile, owner, { flag: 'wx', mode: 0o600 });
      break;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
    try {
      if (Date.now() - fs.statSync(lockFile).mtimeMs > staleMs) {
        fs.renameSync(lockFile, `${lockFile}.stale.${owner}`);
        try {
          fs.unlinkSync(`${lockFile}.stale.${owner}`);
        } catch {
          /* already gone */
        }
        continue;
      }
    } catch {
      continue; // released between the open and the stat; try again at once
    }
    if (Date.now() >= deadline) return { locked: false };
    await sleep(delay);
    delay = Math.min(delay * 2, 250);
  }
  try {
    return { locked: true, value: await fn() };
  } finally {
    try {
      // Only our own: a lock we held past `staleMs` may have been taken over.
      if (fs.readFileSync(lockFile, 'utf8') === owner) fs.unlinkSync(lockFile);
    } catch {
      /* already gone */
    }
  }
}

// ── tokens ──────────────────────────────────────────────────────────────────

function tokensFrom(json, previousRefresh, now) {
  if (typeof json.access_token !== 'string' || !json.access_token) throw new Error('the server sent no access token');
  const seconds = Number(json.expires_in);
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : previousRefresh,
    expiresAt: now + (Number.isFinite(seconds) && seconds > 0 ? seconds : 900) * 1000,
  };
}

/**
 * Exchange the refresh token. Resolves the new pair, or throws an error with
 * `.revoked = true` when the server says the grant is gone (`invalid_grant`):
 * revoked from the Install page or by an admin, expired from 30 idle days, or a
 * rotated token used twice. Anything else is transient and leaves the credentials alone.
 */
async function exchangeRefreshToken(config, { now = Date.now(), timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const res = await oauthPost(
    config.apiHost,
    '/api/oauth/token',
    { grant_type: 'refresh_token', refresh_token: config.refreshToken, client_id: config.clientId || DEFAULT_CLIENT_ID },
    timeoutMs,
  );
  if (res.status === 200) return tokensFrom(res.json, config.refreshToken, now);
  const err = oauthError(res, 'refresh failed');
  if (res.status >= 400 && res.status < 500 && res.json.error === 'invalid_grant') err.revoked = true;
  throw err;
}

/** Drop the credentials, keep the host, and record why. */
function signOutLocally(config, reason) {
  const next = { apiHost: config.apiHost, clientId: config.clientId, signedOut: reason };
  try {
    writeConfigAtomic(next);
  } catch {
    /* read-only home */
  }
}

/**
 * Make sure the stored access token is good for at least `REFRESH_SKEW_MS`, refreshing
 * under the lock if not. `rejected` is a token the server just refused: it counts as
 * stale even if its `exp` says otherwise (a revoked grant, a clock that is off).
 *
 * Resolves `{ ok: true, apiHost, accessToken }` or `{ ok: false, reason, message }`
 * where `reason` is `signed-out`, `legacy-key`, `revoked` or `unavailable`.
 */
async function ensureFresh({ now = Date.now(), rejected, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const usable = (config) =>
    hasTokens(config) && config.accessToken !== rejected && config.expiresAt - now > REFRESH_SKEW_MS;
  const ok = (config) => ({ ok: true, apiHost: config.apiHost, accessToken: config.accessToken });
  // `unavailable` still carries the stale pair: a hook can go on with it and let the server say.
  const fail = (reason) => ({
    ok: false,
    reason,
    message: messageFor(reason),
    ...(reason === 'unavailable' ? { apiHost: config.apiHost, accessToken: config.accessToken } : {}),
  });

  let config = readConfig();
  if (!config.refreshToken) return fail(config.signedOut || 'signed-out');
  if (usable(config)) return ok(config);

  let outcome;
  try {
    outcome = await withLock(async () => {
      // Another process may have refreshed while we waited: use its pair, never spend ours.
      config = readConfig();
      if (!config.refreshToken) return fail(config.signedOut || 'signed-out');
      if (usable(config)) return ok(config);
      try {
        const tokens = await exchangeRefreshToken(config, { now: Date.now(), timeoutMs });
        const next = { apiHost: config.apiHost, clientId: config.clientId || DEFAULT_CLIENT_ID, ...tokens };
        // The new refresh token is on disk before anyone uses the new access token.
        writeConfigAtomic(next);
        return ok(next);
      } catch (err) {
        if (err.revoked) {
          signOutLocally(config, 'revoked');
          return fail('revoked');
        }
        return fail('unavailable');
      }
    });
  } catch {
    return fail('unavailable');
  }
  if (outcome.locked) return outcome.value;

  // The lock was held the whole wait. If the holder finished, its pair is on disk.
  config = readConfig();
  if (usable(config)) return ok(config);
  return fail(config.refreshToken ? 'unavailable' : config.signedOut || 'signed-out');
}

/**
 * What a hook or command authenticates with.
 *
 * `PRAVEX_ACCESS_TOKEN` + `PRAVEX_API_HOST` in the environment win, and are not
 * refreshed: they exist so the tests can point the real scripts at a local server.
 * Otherwise the stored pair, renewed when it is within a minute of lapsing.
 */
async function getCredentials(options = {}) {
  const env = options.env || process.env;
  if (env.PRAVEX_ACCESS_TOKEN && env.PRAVEX_API_HOST) {
    return { ok: true, static: true, apiHost: env.PRAVEX_API_HOST.replace(/\/+$/, ''), accessToken: env.PRAVEX_ACCESS_TOKEN };
  }
  const result = await ensureFresh(options);
  if (result.ok) result.apiHost = result.apiHost.replace(/\/+$/, '');
  return result;
}

/**
 * The server answered `401` to `rejected`. Get a token that can work: another process's
 * newer one, or one refreshed here. Same result shape as `getCredentials`.
 */
function refreshAfterRejection(rejected, options = {}) {
  const env = options.env || process.env;
  if (env.PRAVEX_ACCESS_TOKEN && env.PRAVEX_API_HOST) {
    return Promise.resolve({ ok: false, reason: 'static', message: 'The access token in PRAVEX_ACCESS_TOKEN was refused.' });
  }
  return ensureFresh({ ...options, rejected });
}

/** An authorized request. On a `401` it refreshes once and tries again; `res.revoked` says the connection is gone. */
async function authorized(creds, route, options = {}) {
  const send = (token) => request(creds.apiHost, route, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
  const res = await send(creds.accessToken);
  if (res.status !== 401) return res;
  const next = await refreshAfterRejection(creds.accessToken);
  if (next.ok) return send(next.accessToken);
  if (next.reason === 'unavailable') throw new Error('could not renew the access token');
  return { ...res, revoked: next.reason === 'revoked' };
}

// ── the device grant ────────────────────────────────────────────────────────

/** Where the person approves, and the code to compare. */
async function startDeviceAuth(host, clientId = DEFAULT_CLIENT_ID) {
  const res = await oauthPost(host, '/api/oauth/device/auth', { client_id: clientId, scope: 'api' });
  if (res.status !== 200 || !res.json.device_code) {
    if (!Object.keys(res.json).length) throw new Error(`${host} did not answer like the Pravex API (HTTP ${res.status}) — is that the right host?`);
    throw oauthError(res, 'could not start the sign-in');
  }
  return res.json;
}

/**
 * Poll the token endpoint until the person approves, refuses, or the code expires.
 *
 * RFC 8628 §3.5: `authorization_pending` means ask again later, `slow_down` means ask
 * again later and add 5 s to every wait from now on, `access_denied` and
 * `expired_token` are final. The first poll waits a full interval too. A network
 * blip or a 5xx is not an answer, so it is retried, up to `maxFailures` in a row.
 *
 * `sleep` and `now` are injectable so the tests do not wait five real seconds.
 */
async function pollDeviceToken(host, start, { clientId = DEFAULT_CLIENT_ID, sleep: wait = sleep, now = Date.now, minIntervalMs = DEVICE_MIN_INTERVAL_MS, maxFailures = 5 } = {}) {
  let intervalMs = Math.max(minIntervalMs, (Number(start.interval) || 0) * 1000);
  const lifetime = (Number(start.expires_in) || 600) * 1000;
  const deadline = now() + Math.min(DEVICE_CEILING_MS, lifetime);
  let failures = 0;

  while (now() < deadline) {
    await wait(intervalMs);
    let res;
    try {
      res = await oauthPost(host, '/api/oauth/token', { grant_type: DEVICE_GRANT, device_code: start.device_code, client_id: clientId });
    } catch (err) {
      failures += 1;
      if (failures >= maxFailures) throw new Error(`lost contact with ${host} while waiting for approval (${err.message}). Run /pravex:login again.`);
      continue;
    }
    if (res.status === 200) return tokensFrom(res.json, undefined, now());
    const code = res.json.error;
    if (code === 'authorization_pending') {
      failures = 0;
    } else if (code === 'slow_down') {
      failures = 0;
      intervalMs += DEVICE_MIN_INTERVAL_MS;
    } else if (code === 'access_denied') {
      throw new Error('That request was refused in the browser. Nothing was connected.');
    } else if (code === 'expired_token') {
      throw new Error('That code expired. Run /pravex:login again.');
    } else if (res.status >= 500 || !code) {
      failures += 1;
      if (failures >= maxFailures) throw oauthError(res, 'the sign-in failed');
    } else {
      throw oauthError(res, 'the sign-in failed');
    }
  }
  throw new Error('Timed out waiting for approval. Run /pravex:login again.');
}

// ── login and logout ────────────────────────────────────────────────────────

/** Best effort: the server forgets the grant, or we could not tell it, and either way the machine moves on. */
async function revokeRemotely(config, timeoutMs = 5000) {
  if (!config.apiHost || !config.refreshToken) return false;
  try {
    const res = await oauthPost(
      config.apiHost,
      '/api/oauth/token/revocation',
      { token: config.refreshToken, token_type_hint: 'refresh_token', client_id: config.clientId || DEFAULT_CLIENT_ID },
      timeoutMs,
    );
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Store a fresh login. Under the lock, so it cannot interleave with a refresh, and
 * the connection it replaces is revoked rather than left behind on the server.
 */
async function saveLogin(apiHost, clientId, tokens) {
  const outcome = await withLock(async () => {
    const previous = readRaw();
    writeConfigAtomic({ apiHost, clientId, ...tokens });
    return previous;
  });
  const previous = outcome.locked ? outcome.value : {};
  if (previous.refreshToken && previous.refreshToken !== tokens.refreshToken) await revokeRemotely(previous);
  return outcome.locked;
}

/** Disconnect this machine. Resolves `{ wasConnected, revoked }`. */
async function logout() {
  const outcome = await withLock(async () => {
    const config = readRaw();
    const wasConnected = Boolean(config.refreshToken);
    writeConfigAtomic({ apiHost: config.apiHost, clientId: config.clientId });
    return { config, wasConnected };
  });
  if (!outcome.locked) throw new Error('another Pravex process is refreshing the credentials; try again in a moment');
  const { config, wasConnected } = outcome.value;
  const revoked = wasConnected ? await revokeRemotely(config) : false;
  return { wasConnected, revoked };
}

module.exports = {
  CLIENTS,
  CONFIG_FILE,
  DEFAULT_CLIENT_ID,
  DEFAULT_HOST,
  DEVICE_GRANT,
  DEVICE_MIN_INTERVAL_MS,
  LOCK_FILE,
  REFRESH_SKEW_MS,
  authorized,
  ensureFresh,
  exchangeRefreshToken,
  getCredentials,
  logout,
  messageFor,
  pollDeviceToken,
  readConfig,
  refreshAfterRejection,
  request,
  revokeRemotely,
  saveLogin,
  startDeviceAuth,
  withLock,
  writeConfigAtomic,
};
