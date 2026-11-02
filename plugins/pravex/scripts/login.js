#!/usr/bin/env node
/**
 * Connects this machine to a Pravex workspace, reports whether it is connected, and
 * disconnects it.
 *
 *   node login.js                            sign in with the device flow, default host
 *   node login.js --api-url http://localhost:3000   point it somewhere else
 *   node login.js --client codex             sign in as the Codex client (`npx @pravex/codex login`)
 *   node login.js --status
 *   node login.js --logout
 *
 * The OAuth 2.0 Device Authorization Grant (RFC 8628), the flow `gh auth login`,
 * `stripe login` and `docker login` use: this prints a short code and opens the
 * browser, the person approves it where they are already signed in, and this
 * collects the tokens over HTTPS. The tokens are never displayed and never typed,
 * so there is nothing for the clipboard, the scrollback or the session transcript
 * (which this plugin uploads) to capture. See `auth.js` for the token handling.
 *
 * No dependencies, by design: this runs inside someone else's Claude Code session
 * and must not fetch anything at install time.
 */
'use strict';

const { spawn } = require('child_process');
const seatLib = require('./seat.js');
const auth = require('./auth.js');

/** Someone ran a command and is waiting for the answer, so this is longer than the session start's 1.5 s. */
const SEAT_TIMEOUT_MS = 5000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // `--api-url` is the name the docs use; `--host` is kept because the first
    // version shipped with it and it is in people's shell history.
    if (a === '--host' || a === '--api-url' || a === '--client' || a === '--key') {
      const value = argv[i + 1];
      // Without this, `login.js --api-url` (no value) silently reuses the stored
      // config and reports success for a command that set nothing.
      if (value === undefined || value.startsWith('--')) {
        console.error(`Missing value for ${a}.`);
        process.exit(1);
      }
      out[a === '--client' ? 'client' : a === '--key' ? 'key' : 'host'] = value;
      i += 1;
    } else if (a === '--status') out.status = true;
    else if (a === '--logout') out.logout = true;
    else if (a === '--no-browser') out.noBrowser = true;
  }
  return out;
}

/** `codex`, `claude-code` or a full client id, as the OAuth `client_id`. */
function clientIdFor(name) {
  if (!name) return auth.DEFAULT_CLIENT_ID;
  const id = auth.CLIENTS[name] || (Object.values(auth.CLIENTS).includes(name) ? name : null);
  if (!id) {
    console.error(`Unknown client "${name}". Use claude-code or codex.`);
    process.exit(1);
  }
  return id;
}

/** `GET /api/me`, with a refresh-and-retry on a `401`. Throws with a sentence a person can act on. */
async function verify(creds) {
  const res = await auth.authorized(creds, '/api/me');
  if (res.revoked) throw new Error(auth.messageFor('revoked'));
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new Error(`${creds.apiHost} did not return JSON — is that the Pravex API host?`);
  }
  // The API wraps every response in `{ status, result }`.
  return json.result === undefined ? json : json.result;
}

/**
 * Best effort, and deliberately silent on failure.
 *
 * A headless box, an SSH session or a locked-down desktop has no browser to open,
 * and that is not an error — the code and the URL are already on screen, which is
 * the whole design. Printing a failure here would make a working flow look broken.
 */
function openBrowser(url) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask for this credential's seat and cache the answer, so the status line and the
 * next session start agree with what is printed here. Null when the server could
 * not say. The caller then prints nothing about the seat.
 */
async function seatFor(host, accessToken) {
  const seat = await seatLib.fetchSeat(host, accessToken, { timeoutMs: SEAT_TIMEOUT_MS });
  if (seat) seatLib.writeSeat(seat);
  return seat;
}

/**
 * After a login. A cached answer belongs to the previous credential, which may be
 * another workspace, so it goes first. Then the new answer, when there is one.
 */
async function refreshSeat(host, accessToken) {
  seatLib.forgetSeat();
  return seatFor(host, accessToken);
}

/** "Every session is reported", unless the new seat says otherwise. */
function afterLogin(seat) {
  if (seat && seat.status !== 'active') {
    const line = seatLib.statusLine(seat);
    if (line) return line;
  }
  return 'Nothing else to do — every session is reported automatically when it ends.';
}

/** Print the code, open the browser, and wait for the approval. Resolves the new `{ accessToken, refreshToken, expiresAt }`. */
async function deviceFlow(host, { clientId = auth.DEFAULT_CLIENT_ID, noBrowser, ...poll } = {}) {
  const start = await auth.startDeviceAuth(host, clientId);

  console.log('');
  console.log(`  Your code:  ${start.user_code}`);
  console.log(`  Open:       ${start.verification_uri}`);
  console.log('');

  const opened = noBrowser ? false : openBrowser(start.verification_uri_complete || start.verification_uri);
  console.log(
    opened
      ? 'Opening your browser. Approve the code above, and this will finish on its own.'
      : 'Open that page, sign in if you need to, and enter the code. This is waiting.',
  );

  return auth.pollDeviceToken(host, start, { clientId, ...poll });
}

/** The whole sign-in: the device flow, storing the pair, the seat, and who this is. */
async function connect(host, options = {}) {
  const clientId = options.clientId || auth.DEFAULT_CLIENT_ID;
  const tokens = await deviceFlow(host, { ...options, clientId });
  await auth.saveLogin(host, clientId, tokens);
  const seat = await refreshSeat(host, tokens.accessToken);
  let account = {};
  try {
    account = await verify({ apiHost: host, accessToken: tokens.accessToken });
  } catch {
    /* connected all the same; only the greeting loses the name */
  }
  return { account, seat };
}

async function showStatus() {
  if (process.env.PRAVEX_API_KEY) console.log('Note: PRAVEX_API_KEY is no longer used. Pravex signs in with /pravex:login.');
  const creds = await auth.getCredentials();
  if (!creds.ok) {
    const quiet = creds.reason === 'signed-out';
    console.log(quiet ? 'Pravex: not configured. Run /pravex:login' : creds.message);
    if (!quiet) process.exitCode = 1;
    return;
  }
  let me;
  try {
    me = await verify(creds);
  } catch (err) {
    console.error(`Pravex: not connected to ${creds.apiHost} — ${err.message}`);
    process.exit(1);
  }
  console.log(`Pravex: connected to ${creds.apiHost} as ${me.email} (${me.orgName})`);
  // On any error, or from a server that has no seats, nothing about the seat.
  const seatLine = seatLib.statusLine(await seatFor(creds.apiHost, creds.accessToken));
  if (seatLine) console.log(seatLine);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.key) {
    console.error('API keys (pvx_…) are gone: Pravex now signs in with OAuth. Run /pravex:login with no key.');
    process.exit(1);
  }
  if (args.status) return showStatus();

  if (args.logout) {
    const { wasConnected, revoked } = await auth.logout();
    seatLib.forgetSeat();
    if (!wasConnected) console.log('Pravex: this machine was not connected.');
    else if (revoked) console.log('Pravex: disconnected. This machine\u2019s access was revoked on the server and its credentials removed.');
    else console.log('Pravex: disconnected locally. The server could not be reached, so remove this machine on the Install page too.');
    return;
  }

  const stored = auth.readConfig();
  const host = (args.host || stored.apiHost || auth.DEFAULT_HOST).replace(/\/+$/, '');
  const clientId = clientIdFor(args.client);

  const { account, seat } = await connect(host, { clientId, noBrowser: args.noBrowser });
  console.log('');
  console.log(`Pravex: connected. Sessions will be reported as ${account.email || 'you'}${account.orgName ? ` (${account.orgName})` : ''}.`);
  console.log(`Config: ${auth.CONFIG_FILE}`);
  console.log(afterLogin(seat));
  console.log('Tip: /pravex:statusline shows in the status line whether a session is recorded, and /pravex:incognito keeps one private.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Pravex login failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { afterLogin, clientIdFor, connect, deviceFlow, parseArgs, verify };
