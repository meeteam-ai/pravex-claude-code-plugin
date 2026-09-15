'use strict';

// The sweep reports transcripts from every project on the machine, so the repo
// has to come from each transcript. It once came from the session starting, and
// filed a week of other repositories' sessions under whichever repo was opened
// next. These run the real hook against a local server, the way Claude Code does.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const REPORT = path.join(__dirname, 'report-session.js');
const TS = '2026-01-01T00:00:00.000Z';

function gitRepo(root, name, slug) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', `git@github.com:${slug}.git`], { cwd: dir });
  return dir;
}

function writeTranscript(home, sessionId, { cwd, gitBranch } = {}) {
  const dir = path.join(home, '.claude', 'projects', `-p-${sessionId}`);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = (o) => ({ ...o, ...(cwd ? { cwd } : {}), ...(gitBranch ? { gitBranch } : {}) });
  const lines = [
    stamp({ type: 'user', timestamp: TS, message: { content: 'fix the job form' } }),
    stamp({
      type: 'assistant',
      timestamp: TS,
      message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'Done.' }] },
    }),
  ];
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}

function captureServer() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      bodies.push(JSON.parse(data));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, bodies, host: `http://127.0.0.1:${server.address().port}` })));
}

function run(args, { input, env, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [REPORT, ...args], { env, cwd });
    child.on('error', reject);
    child.on('close', resolve);
    child.stdin.end(input);
  });
}

test('a swept session is filed under the repo it ran in, not the one starting', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-sweep-repo-'));
  const { server, bodies, host } = await captureServer();
  try {
    const current = gitRepo(home, 'current', 'acme/dashboard');
    const other = gitRepo(home, 'other', 'acme/talent');
    writeTranscript(home, 'from-other', { cwd: other, gitBranch: 'feature/slt-207' });
    writeTranscript(home, 'no-cwd');

    const env = { ...process.env, HOME: home, USERPROFILE: home, PRAVEX_API_KEY: 'pvx_test', PRAVEX_API_HOST: host };
    const code = await run(['--start'], {
      input: JSON.stringify({ session_id: 'starting', source: 'startup', cwd: current }),
      env,
      cwd: current,
    });

    assert.strictEqual(code, 0);
    const byId = Object.fromEntries(bodies.map((b) => [b.externalId, b]));
    assert.strictEqual(byId['from-other'].repo, 'acme/talent');
    assert.strictEqual(byId['from-other'].branch, 'feature/slt-207');
    // Unknown stays unknown rather than borrowing the current repo and branch.
    assert.strictEqual(byId['no-cwd'].repo, '');
    assert.strictEqual(byId['no-cwd'].branch, '');
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('transcriptCwd reads the first cwd and reports none as empty', async () => {
  const { transcriptCwd } = require('./report-session.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-cwd-'));
  try {
    writeTranscript(home, 'with', { cwd: '/work/talent' });
    writeTranscript(home, 'without');
    const file = (id) => path.join(home, '.claude', 'projects', `-p-${id}`, `${id}.jsonl`);

    assert.strictEqual(await transcriptCwd(file('with')), '/work/talent');
    assert.strictEqual(await transcriptCwd(file('without')), '');
    assert.strictEqual(await transcriptCwd(path.join(home, 'missing.jsonl')), '');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
