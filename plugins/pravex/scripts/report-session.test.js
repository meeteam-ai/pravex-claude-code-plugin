'use strict';
/**
 * Tests for the SessionEnd hook.
 *
 * `node --test`. Standard library only — the plugin runs inside someone else's
 * session and must not pull anything at install time, and a test runner would be a
 * dependency even if it never shipped.
 *
 * These cover the things that were found wrong against real transcripts rather than
 * the things that are easy to assert.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SECRET_RE,
  activeMinutes,
  aggregate,
  bashWrites,
  prUrlMatchesRepo,
  prUrlSlug,
  redact,
} = require('./report-session.js');

// Every fixture below that looks like a credential is SYNTHETIC. This suite once used
// the real pasted key that prompted it, which put a live secret in git history.
const FAKE_KEY = 're_notarealkey00000000000000000000';

test('redact masks anything key-shaped', () => {
  assert.ok(!redact(`${FAKE_KEY} key`).includes('notarealkey'));
  assert.ok(!redact('sk-test00000000000000000000').includes('test0000'));
  assert.ok(!redact('ghp_abcdef1234567890abcdef1234').includes('abcdef1234'));
});

test('redact leaves an ordinary session title alone', () => {
  for (const title of [
    'Bump actions/checkout from 6 to 7',
    'Fix the billing page layout on mobile',
    'why is the dashboard showing 0 sessions',
  ]) {
    assert.strictEqual(redact(title), title);
  }
});

test('SECRET_RE is global, so redact replaces every occurrence', () => {
  assert.ok(SECRET_RE.global);
  const masked = redact(`${FAKE_KEY} and ${FAKE_KEY}`);
  assert.ok(!masked.includes('notarealkey'));
});

test('prUrlSlug reads owner/name off all three forges', () => {
  assert.strictEqual(prUrlSlug('https://github.com/acme/widgets/pull/42'), 'acme/widgets');
  assert.strictEqual(prUrlSlug('https://gitlab.com/acme/widgets/-/merge_requests/9'), 'acme/widgets');
  assert.strictEqual(prUrlSlug('https://bitbucket.org/acme/widgets/pull-requests/4'), 'acme/widgets');
  assert.strictEqual(prUrlSlug('not a url'), '');
});

test('a pull request from another repo is not this session', () => {
  // The bug this exists for: a PR from an unrelated organisation, scraped out of a
  // browser tab list in tool output, reported as the session's own.
  assert.ok(!prUrlMatchesRepo('https://github.com/other-org/other-repo/pull/1879', 'acme/widgets'));
  assert.ok(!prUrlMatchesRepo('https://github.com/acme/different/pull/1', 'acme/widgets'));
});

test('a pull request from this repo is', () => {
  assert.ok(prUrlMatchesRepo('https://github.com/acme/widgets/pull/42', 'acme/widgets'));
  assert.ok(prUrlMatchesRepo('https://github.com/ACME/Widgets/pull/42', 'acme/widgets'));
  assert.ok(prUrlMatchesRepo('https://github.com/acme/widgets/pull/42', 'acme/widgets.git'));
});

test('with no origin remote, only the repository name can be compared', () => {
  // repoSlug falls back to the directory name, which has no owner to match on.
  assert.ok(prUrlMatchesRepo('https://github.com/acme/widgets/pull/42', 'widgets'));
  assert.ok(!prUrlMatchesRepo('https://github.com/acme/widgets/pull/42', 'something-else'));
});

test('an unknown repo believes nothing', () => {
  assert.ok(!prUrlMatchesRepo('https://github.com/acme/widgets/pull/42', ''));
});

// Transcript timestamps are ISO strings, which is what activeMinutes parses.
const at = (min) => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString();

test('activeMinutes drops idle gaps instead of measuring wall clock', () => {
  // Two ten-minute stretches of work either side of a four-hour break. Wall clock
  // would call this 260 minutes; one real session measured 7,237 that way.
  assert.strictEqual(activeMinutes([at(0), at(5), at(10), at(250), at(255), at(260)]), 20);
});

test('activeMinutes counts a long think, which is not idle', () => {
  assert.strictEqual(activeMinutes([at(0), at(4)]), 4);
});

test('activeMinutes needs two stamps to measure anything', () => {
  assert.strictEqual(activeMinutes([at(0)]), 0);
  assert.strictEqual(activeMinutes([]), 0);
});

/** bashWrites returns a Set; compare as a sorted array. */
const writes = (cmd) => [...bashWrites(cmd)].sort();

test('bashWrites finds the ordinary redirections', () => {
  assert.deepStrictEqual(writes('echo hi > src/out.txt'), ['src/out.txt']);
  assert.deepStrictEqual(writes('cat x | tee -a logs/app.log'), ['logs/app.log']);
  assert.deepStrictEqual(writes("sed -i '' s/a/b/ src/file.ts"), ['src/file.ts']);
});

test('bashWrites ignores what is not a file being written', () => {
  assert.deepStrictEqual(writes('ls > /dev/null'), []);
  assert.deepStrictEqual(writes('grep x file 2>&1'), []);
  // An inline script carries its own code, and a > inside it is not a redirection.
  assert.deepStrictEqual(writes('node -e "const fs=require(\'fs\'); if (a>0) {}"'), []);
});

/** A transcript on disk, in the shape Claude Code writes. */
function writeTranscript(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-')), 'transcript.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  return file;
}

const TS = '2026-01-01T00:00:00.000Z';

test('aggregate sums usage per model and ignores synthetic turns', async () => {
  const file = writeTranscript([
    {
      type: 'assistant',
      timestamp: TS,
      gitBranch: 'main',
      message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900 }, content: [] },
    },
    {
      // A placeholder turn for an API error. Not a model, and must never be reported.
      type: 'assistant',
      timestamp: TS,
      message: { id: 'm2', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 }, content: [] },
    },
  ]);
  const agg = await aggregate(file, 'acme/widgets');
  assert.strictEqual(agg.usage.length, 1);
  assert.strictEqual(agg.usage[0].model, 'claude-opus-5');
  assert.strictEqual(agg.usage[0].inputTokens, 10);
  assert.strictEqual(agg.usage[0].cacheReadTokens, 900);
  assert.strictEqual(agg.branch, 'main');
});

test('aggregate counts an edit only once its result confirms it landed', async () => {
  const file = writeTranscript([
    {
      type: 'assistant',
      timestamp: TS,
      message: {
        id: 'm1',
        model: 'claude-opus-5',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'src/landed.ts' } },
          { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'src/denied.ts' } },
        ],
      },
    },
    {
      type: 'user',
      timestamp: TS,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'ok' },
          { type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'denied' },
        ],
      },
    },
  ]);
  const agg = await aggregate(file, 'acme/widgets');
  assert.strictEqual(agg.filesTouched, 1);
  // One of two tool calls errored.
  assert.strictEqual(agg.retryRate, 50);
});

test('aggregate reports this repo\'s pull request and drops a foreign one', async () => {
  const file = writeTranscript([
    {
      type: 'assistant',
      timestamp: TS,
      message: {
        id: 'm1',
        model: 'claude-opus-5',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          {
            type: 'text',
            text: 'open tab: https://github.com/other-org/other-repo/pull/1879 — mine is https://github.com/acme/widgets/pull/42',
          },
        ],
      },
    },
  ]);
  const agg = await aggregate(file, 'acme/widgets');
  assert.strictEqual(agg.prUrl, 'https://github.com/acme/widgets/pull/42');
  assert.strictEqual(agg.prUrlsRejected, 1);
});

test('aggregate counts test files it touched', async () => {
  const file = writeTranscript([
    {
      type: 'assistant',
      timestamp: TS,
      message: {
        id: 'm1',
        model: 'claude-opus-5',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'src/thing.test.ts' } },
          { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'src/thing.ts' } },
        ],
      },
    },
    {
      type: 'user',
      timestamp: TS,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'ok' },
          { type: 'tool_result', tool_use_id: 't2', is_error: false, content: 'ok' },
        ],
      },
    },
  ]);
  const agg = await aggregate(file, 'acme/widgets');
  assert.strictEqual(agg.filesTouched, 2);
  assert.strictEqual(agg.testsAdded, 1);
});

test('a title falling back to the first prompt is redacted', async () => {
  const file = writeTranscript([
    { type: 'user', timestamp: TS, message: { content: `${FAKE_KEY} key` } },
    {
      type: 'assistant',
      timestamp: TS,
      message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
    },
  ]);
  const agg = await aggregate(file, 'acme/widgets');
  assert.ok(!agg.title.includes('notarealkey'), `title leaked a credential: ${agg.title}`);
});

// ── End to end ──────────────────────────────────────────────
// The hook as it actually runs: spawned as a process, hook payload on stdin, posting
// to a server. This used to live as a heredoc inside the CI workflow, where it could
// not be run locally and failures surfaced as bash noise.

const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');

/**
 * Run the hook with a payload on stdin and resolve its exit code.
 *
 * Asynchronous on purpose. `spawnSync` blocks this process's event loop, so a capture
 * server running here cannot answer while the child is alive — the child waits out its
 * 10s POST timeout, spools the report and exits 0, and the request is only handled
 * once the parent unblocks. The assertions then pass against a request that was never
 * actually answered, which is exactly what happened when this was written.
 */
function runHook(input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'report-session.js')], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
    child.stdin.end(JSON.stringify(input));
  });
}

/** A server that captures one POST, standing in for the Pravex API. */
function captureServer() {
  let resolve;
  const received = new Promise((r) => (resolve = r));
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 201, result: { created: true } }));
      resolve({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
    });
  });
  return { server, received };
}

test('the hook reads stdin, aggregates and posts the session', async () => {
  const { server, received } = captureServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const transcript = writeTranscript([
    {
      type: 'assistant',
      timestamp: TS,
      gitBranch: 'main',
      message: {
        id: 'm1',
        model: 'claude-opus-5',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900 },
        content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'src/a.ts' } }],
      },
    },
    {
      type: 'user',
      timestamp: TS,
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'ok' }] },
    },
  ]);

  const code = await runHook(
    { session_id: 'test-session', transcript_path: transcript, cwd: process.cwd() },
    {
      PRAVEX_API_KEY: 'pvx_test',
      PRAVEX_API_HOST: `http://127.0.0.1:${port}`,
      // An isolated home, so the hook cannot read a real ~/.pravex — a spooled report
      // from an earlier run would replay before this session's own.
      HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-home-')),
    }
  );
  // The hook must never fail a developer's session, whatever happens inside it.
  assert.strictEqual(code, 0);

  const req = await received;
  server.close();

  assert.strictEqual(req.path, '/api/sessions');
  assert.strictEqual(req.auth, 'Bearer pvx_test');
  assert.strictEqual(req.body.externalId, 'test-session');
  assert.strictEqual(req.body.filesTouched, 1);
  assert.strictEqual(typeof req.body.durationMinutes, 'number');
  assert.ok(req.body.usage.length > 0);
  assert.ok(!req.body.usage.some((u) => u.model === '<synthetic>'));
});

test('the hook exits quietly when it has no credentials', () => {
  const transcript = writeTranscript([
    { type: 'assistant', timestamp: TS, message: { id: 'm1', model: 'claude-opus-5', usage: {}, content: [] } },
  ]);
  const env = { ...process.env };
  delete env.PRAVEX_API_KEY;
  delete env.PRAVEX_API_HOST;
  // A home directory with no config, so an installed one cannot make this pass.
  env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-home-'));

  const result = spawnSync(process.execPath, [path.join(__dirname, 'report-session.js')], {
    input: JSON.stringify({ session_id: 's', transcript_path: transcript, cwd: process.cwd() }),
    env,
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0);
});

test('a report that cannot be delivered is spooled for the next session', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-home-'));
  const transcript = writeTranscript([
    {
      type: 'assistant',
      timestamp: TS,
      message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
    },
  ]);

  // Nothing listening: a session ends offline more often than you would think.
  const code = await runHook(
    { session_id: 'offline-session', transcript_path: transcript, cwd: process.cwd() },
    { PRAVEX_API_KEY: 'pvx_test', PRAVEX_API_HOST: 'http://127.0.0.1:1', HOME: home }
  );
  assert.strictEqual(code, 0, 'a failed report must never fail the session');

  const spooled = fs.readdirSync(path.join(home, '.pravex', 'spool')).filter((f) => f.endsWith('.json'));
  assert.strictEqual(spooled.length, 1);
  const body = JSON.parse(fs.readFileSync(path.join(home, '.pravex', 'spool', spooled[0]), 'utf8'));
  assert.strictEqual(body.externalId, 'offline-session');
});

// ── Transcript extraction ────────────────────────────────────────────────────
//
// What is kept and what is dropped is a privacy decision as much as a size one:
// attachments and hook output are 79.9% of a real transcript's bytes AND the part
// most likely to carry somebody's environment. These assert both halves.

const zlib = require('node:zlib');
const { randomBytes } = require('node:crypto');
const { TRANSCRIPT_FORMAT, TRANSCRIPT_MAX_TEXT, clampText, extractTurn, packTranscript } = require('./report-session.js');

const unpack = (packed) => JSON.parse(zlib.gunzipSync(Buffer.from(packed.data, 'base64')).toString('utf8'));

test('extractTurn keeps what a person typed', () => {
  const turn = extractTurn({
    type: 'user',
    timestamp: '2026-09-14T10:00:00.000Z',
    message: { content: 'why is the dashboard showing 0 sessions' },
  });

  assert.deepStrictEqual(turn, {
    role: 'user',
    at: '2026-09-14T10:00:00.000Z',
    text: 'why is the dashboard showing 0 sessions',
  });
});

test('extractTurn keeps assistant prose and the names of the tools it called', () => {
  const turn = extractTurn({
    type: 'assistant',
    timestamp: '2026-09-14T10:00:05.000Z',
    message: {
      content: [
        { type: 'text', text: 'Reading the config first.' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/etc/passwd' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'curl -H "Authorization: Bearer sk-live-abc" https://api.internal' } },
      ],
    },
  });

  assert.deepStrictEqual(turn.tools, ['Read', 'Bash']);
  assert.strictEqual(turn.text, 'Reading the config first.');
});

// Names, never arguments. A `Bash` command line or a `Read` path is exactly the
// sort of thing that carries a hostname, a path or a token.
test('extractTurn never carries a tool argument', () => {
  const turn = extractTurn({
    type: 'assistant',
    timestamp: '2026-09-14T10:00:05.000Z',
    message: {
      content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ssh deploy@10.0.0.4 cat /etc/shadow' } }],
    },
  });

  const serialised = JSON.stringify(turn);
  assert.ok(!serialised.includes('10.0.0.4'));
  assert.ok(!serialised.includes('/etc/shadow'));
  assert.deepStrictEqual(turn.tools, ['Bash']);
});

// Tool results are `user` entries whose content is all `tool_result` blocks, so
// they reduce to empty text and fall out here. This is what keeps command output
// — the largest and most sensitive part of a transcript — on the machine.
test('extractTurn drops tool output', () => {
  assert.strictEqual(
    extractTurn({
      type: 'user',
      timestamp: '2026-09-14T10:00:06.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'root:x:0:0:root:/root:/bin/bash' }] },
    }),
    null,
  );
});

test('extractTurn drops meta entries and system tags', () => {
  assert.strictEqual(
    extractTurn({ type: 'user', isMeta: true, timestamp: 't', message: { content: 'internal' } }),
    null,
  );
  assert.strictEqual(
    extractTurn({ type: 'user', timestamp: 't', message: { content: '<system-reminder>be good</system-reminder>' } }),
    null,
  );
});

test('extractTurn drops anything that is not a turn', () => {
  assert.strictEqual(extractTurn({ type: 'attachment', message: { content: 'x'.repeat(50000) } }), null);
  assert.strictEqual(extractTurn({ type: 'system', message: { content: 'x' } }), null);
  assert.strictEqual(extractTurn({ type: 'user' }), null);
  assert.strictEqual(extractTurn({ type: 'assistant', message: { content: 'not an array' } }), null);
  assert.strictEqual(extractTurn({ type: 'assistant', timestamp: 't', message: { content: [] } }), null);
});

// Redact first, then cut. Truncating first could leave the front half of a key in
// place, and half a token is still most of a token.
test('clampText redacts before truncating', () => {
  const key = `${FAKE_KEY}`;
  const padded = `${'a '.repeat(TRANSCRIPT_MAX_TEXT / 2 - 20)}${key} trailing`;

  const clamped = clampText(padded);

  assert.ok(!clamped.includes('notarealkey'));
  assert.ok(clamped.length <= TRANSCRIPT_MAX_TEXT + 1);
});

test('clampText leaves a short ordinary message untouched', () => {
  assert.strictEqual(clampText('fix the billing page'), 'fix the billing page');
});

test('packTranscript gzips into a base64 envelope that names its format', () => {
  const packed = packTranscript([{ role: 'user', at: 't', text: 'hello' }]);

  assert.strictEqual(packed.encoding, 'gzip+base64');
  assert.strictEqual(packed.format, TRANSCRIPT_FORMAT);
  assert.strictEqual(packed.turns, 1);
  assert.strictEqual(packed.dropped, 0);
  assert.deepStrictEqual(unpack(packed), { v: TRANSCRIPT_FORMAT, turns: [{ role: 'user', at: 't', text: 'hello' }] });
});

// The front, because the end of a session is what a summary is about — what was
// decided, what was built, what broke. The opening of a long session is setup.
test('packTranscript drops from the front when it has to drop something', () => {
  // Genuinely incompressible: `Math.random().toString(36).repeat(n)` looks random
  // and gzips to almost nothing, which is how this test first failed to fail.
  const big = Array.from({ length: 3000 }, (_, i) => ({
    role: 'assistant',
    at: 't',
    text: `${i} ${randomBytes(700).toString('base64')}`,
  }));

  const packed = packTranscript(big);

  assert.ok(packed.dropped > 0, 'expected some turns to be dropped');
  assert.strictEqual(packed.turns + packed.dropped, big.length);
  const { turns } = unpack(packed);
  // The last turn survived; the first did not.
  assert.strictEqual(turns[turns.length - 1].text, big[big.length - 1].text);
  assert.notStrictEqual(turns[0].text, big[0].text);
});

// A transcript that cannot be packed must not cost the session its metrics, which
// are what somebody is actually looking at a dashboard for.
test('packTranscript returns null rather than throwing on something unserialisable', () => {
  const circular = { role: 'user', at: 't' };
  circular.self = circular;

  assert.strictEqual(packTranscript([circular]), null);
});
