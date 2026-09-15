#!/usr/bin/env node
/**
 * Connects this machine to a Pravex workspace, and reports whether it is connected.
 *
 *   node login.js                            device flow against the default host
 *   node login.js --api-url http://localhost:3000   point it somewhere else
 *   node login.js --status
 *   node login.js --api-url <url> --key pvx_xxx     legacy, discouraged — see below
 *
 * The normal path is the OAuth 2.0 Device Authorization Grant (RFC 8628), the flow
 * `gh auth login`, `stripe login` and `docker login` all use: this prints a short
 * code, the person approves it in a browser where they are already signed in, and
 * this collects the credential over HTTPS.
 *
 * Why that matters here more than most places. A pasted key does not stay in the
 * prompt: it lands in the clipboard, in terminal scrollback, and in the session
 * transcript — the same transcript this plugin uploads. One real key was burned
 * exactly that way. With the device grant the `pvx_` string is never displayed and
 * never typed, so there is nothing for any of those to capture.
 *
 * No dependencies, by design: this runs inside someone else's Claude Code session
 * and must not fetch anything at install time.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const CONFIG_DIR = path.join(os.homedir(), '.pravex');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_HOST = 'https://pravex.tenox.ai';

/** Stop polling after this long whatever the server says, so it cannot spin forever. */
const POLL_CEILING_MS = 10 * 60 * 1000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // `--api-url` is the name the docs use; `--host` is kept because the first
    // version shipped with it and it is in people's shell history.
    if (a === '--host' || a === '--api-url' || a === '--key') {
      const value = argv[i + 1];
      // Without this, `login.js --api-url` (no value) silently reuses the stored
      // config and reports success for a command that set nothing.
      if (value === undefined || value.startsWith('--')) {
        console.error(`Missing value for ${a}.`);
        process.exit(1);
      }
      out[a === '--key' ? 'key' : 'host'] = value;
      i += 1;
    } else if (a === '--status') out.status = true;
    else if (a === '--no-browser') out.noBrowser = true;
  }
  return out;
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(host, key) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify({ apiHost: host, apiKey: key }, null, 2)}\n`, { mode: 0o600 });
  // `mode` only applies when the file is created, so an existing looser file would keep
  // its permissions and leave the credential readable by everyone on the machine.
  fs.chmodSync(CONFIG_FILE, 0o600);
}

function request(apiHost, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiHost);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${route}`;
    const client = url.protocol === 'https:' ? https : http;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = client.request(
      url,
      {
        method,
        timeout: 10000,
        headers: {
          ...headers,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** The API wraps every response in `{ status, result }`; older builds did not. */
function unwrap(res, what) {
  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new Error(`${what} did not return JSON — is that the Pravex API host?`);
  }
  if (res.status >= 400) {
    const message = (json.error && json.error.message) || json.message || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return json.result === undefined ? json : json.result;
}

async function verify(apiHost, apiKey) {
  const res = await request(apiHost, '/api/me', { headers: { Authorization: `Bearer ${apiKey}` } });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  return unwrap(res, apiHost);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function deviceFlow(host, { noBrowser } = {}) {
  const clientName = `Claude Code on ${os.hostname()}`;
  const start = unwrap(
    await request(host, '/api/auth/device/code', { method: 'POST', body: { clientName } }),
    host,
  );

  console.log('');
  console.log(`  Your code:  ${start.userCode}`);
  console.log(`  Open:       ${start.verificationUri}`);
  console.log('');

  const opened = noBrowser ? false : openBrowser(start.verificationUriComplete);
  console.log(
    opened
      ? 'Opening your browser. Approve the code above, and this will finish on its own.'
      : 'Open that page, sign in if you need to, and enter the code. This is waiting.',
  );

  // The server tells us how often to poll and pushes back if we ignore it, so the
  // interval is read from the response rather than assumed.
  let intervalMs = (start.interval || 5) * 1000;
  const deadline = Date.now() + Math.min(POLL_CEILING_MS, (start.expiresIn || 600) * 1000);

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const result = unwrap(
      await request(host, '/api/auth/device/token', { method: 'POST', body: { deviceCode: start.deviceCode } }),
      host,
    );

    if (result.status === 'approved') return result;
    if (result.status === 'denied') throw new Error('That request was refused in the browser. Nothing was connected.');
    if (result.status === 'expired') throw new Error('That code expired. Run /pravex:login again.');
    // `slow_down` carries the new floor. Honour it — the server enforces it, so
    // ignoring it only makes every subsequent poll slower.
    if (result.status === 'slow_down' && result.interval) intervalMs = result.interval * 1000;
  }

  throw new Error('Timed out waiting for approval. Run /pravex:login again.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = readConfig();
  const current = {
    apiHost: process.env.PRAVEX_API_HOST || file.apiHost,
    apiKey: process.env.PRAVEX_API_KEY || file.apiKey,
  };

  if (args.status) {
    if (!current.apiKey || !current.apiHost) {
      console.log('Pravex: not configured. Run /pravex:login');
      return;
    }
    let me;
    try {
      me = await verify(current.apiHost, current.apiKey);
    } catch (err) {
      console.error(`Pravex: not connected to ${current.apiHost} — ${err.message}`);
      process.exit(1);
    }
    console.log(`Pravex: connected to ${current.apiHost} as ${me.email} (${me.orgName})`);
    return;
  }

  const host = (args.host || current.apiHost || DEFAULT_HOST).replace(/\/+$/, '');

  // `--key` still works, for a CI box that cannot open a browser or approve
  // anything. It is not what /install tells anyone to do, and the warning says why.
  if (args.key) {
    if (!args.key.startsWith('pvx_')) {
      console.error('An API key must start with "pvx_".');
      process.exit(1);
    }
    const me = await verify(host, args.key);
    writeConfig(host, args.key);
    console.log('');
    console.log('⚠  A pasted key is now in your clipboard, your scrollback, and this session transcript.');
    console.log('   Run /pravex:login with no arguments instead — it never displays the key.');
    console.log('');
    console.log(`Pravex: configured. Sessions will be reported as ${me.email} (${me.orgName}).`);
    console.log(`Config: ${CONFIG_FILE}`);
    return;
  }

  const approved = await deviceFlow(host, { noBrowser: args.noBrowser });
  writeConfig(host, approved.apiKey);

  const account = approved.account || {};
  console.log('');
  console.log(`Pravex: connected. Sessions will be reported as ${account.email || 'you'}${account.orgName ? ` (${account.orgName})` : ''}.`);
  console.log(`Config: ${CONFIG_FILE}`);
  console.log('Nothing else to do — every session is reported automatically when it ends.');
  console.log('Tip: /pravex:statusline shows in the status line whether a session is recorded, and /pravex:incognito keeps one private.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Pravex login failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { deviceFlow, parseArgs, readConfig, unwrap, verify, writeConfig };
