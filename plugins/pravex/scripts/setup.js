#!/usr/bin/env node
/**
 * Writes ~/.pravex/config.json and verifies the API key against the Pravex host.
 *
 *   node setup.js --host https://api.pravex.dev --key pvx_xxx
 *   node setup.js --status
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const CONFIG_DIR = path.join(os.homedir(), '.pravex');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') out.host = argv[++i];
    else if (a === '--key') out.key = argv[++i];
    else if (a === '--status') out.status = true;
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

function get(apiHost, apiKey, route) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, apiHost);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(
      url,
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 8000 },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function verify(apiHost, apiKey) {
  const res = await get(apiHost, apiKey, '/api/me');
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  const json = JSON.parse(res.body);
  return json.result || json;
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
      console.log('Pravex: not configured. Run /pravex:setup');
      return;
    }
    const me = await verify(current.apiHost, current.apiKey);
    console.log(`Pravex: connected to ${current.apiHost} as ${me.email} (${me.orgName})`);
    return;
  }

  const host = (args.host || current.apiHost || '').replace(/\/+$/, '');
  const key = args.key || current.apiKey;
  if (!host || !key) {
    console.error('Usage: setup.js --host <url> --key <pvx_...>');
    process.exit(1);
  }
  if (!key.startsWith('pvx_')) {
    console.error('API key must start with "pvx_" (create one in Pravex → Install).');
    process.exit(1);
  }

  const me = await verify(host, key);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ apiHost: host, apiKey: key }, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(`Pravex: configured. Sessions will be reported as ${me.email} (${me.orgName}).`);
  console.log(`Config: ${CONFIG_FILE}`);
}

main().catch((err) => {
  console.error(`Pravex setup failed: ${err.message}`);
  process.exit(1);
});
