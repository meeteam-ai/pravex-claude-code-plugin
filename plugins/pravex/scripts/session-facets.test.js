'use strict';
/**
 * Session facets: the classifiers on their own, both parsers feeding them from a
 * real-shaped transcript, and the body that carries them.
 *
 * `node --test`, standard library only, like the rest of the suite.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MAX_NAMES,
  claudeEditLines,
  cleanName,
  codexMcpServerOf,
  commandsIn,
  isDenial,
  isInterrupt,
  mcpServerOf,
  claudeToolCategory,
  classifyShell,
  codexToolCategory,
  countLines,
  createFacets,
  fileKindsOf,
  languageOf,
  patchLines,
} = require('./session-facets.js');
const { aggregate, aggregateFor, buildBody, timeZone } = require('./report-session.js');

// ── Languages ───────────────────────────────────────────────

test('languageOf maps by extension, Linguist-style', () => {
  assert.strictEqual(languageOf('src/App.tsx'), 'TypeScript');
  assert.strictEqual(languageOf('src/index.ts'), 'TypeScript');
  assert.strictEqual(languageOf('lib/x.mjs'), 'JavaScript');
  assert.strictEqual(languageOf('lib/x.cjs'), 'JavaScript');
  assert.strictEqual(languageOf('api/main.py'), 'Python');
  assert.strictEqual(languageOf('include/x.h'), 'C');
  assert.strictEqual(languageOf('src/x.cpp'), 'C++');
  assert.strictEqual(languageOf('.github/workflows/ci.yml'), 'YAML');
  assert.strictEqual(languageOf('schema.proto'), 'Protocol Buffers');
  assert.strictEqual(languageOf('analysis/model.R'), 'R');
  assert.strictEqual(languageOf('C:\\work\\App.CS'), 'C#');
});

test('languageOf knows the files that have no extension to go by', () => {
  assert.strictEqual(languageOf('Dockerfile'), 'Dockerfile');
  assert.strictEqual(languageOf('deploy/Dockerfile.prod'), 'Dockerfile');
  assert.strictEqual(languageOf('Makefile'), 'Makefile');
});

test('languageOf calls anything unrecognised Other', () => {
  assert.strictEqual(languageOf('notes.xyz'), 'Other');
  assert.strictEqual(languageOf('LICENSE'), 'Other');
  assert.strictEqual(languageOf('.gitignore'), 'Other');
});

// ── File kinds ──────────────────────────────────────────────

test('fileKindsOf recognises each kind', () => {
  assert.deepStrictEqual(fileKindsOf('src/thing.test.ts'), ['test']);
  assert.deepStrictEqual(fileKindsOf('README.md'), ['docs']);
  assert.deepStrictEqual(fileKindsOf('docs/guide.txt'), ['docs']);
  assert.deepStrictEqual(fileKindsOf('.github/workflows/ci.yml'), ['ci']);
  assert.deepStrictEqual(fileKindsOf('Jenkinsfile'), ['ci']);
  assert.deepStrictEqual(fileKindsOf('tsconfig.json'), ['config']);
  assert.deepStrictEqual(fileKindsOf('.eslintrc'), ['config']);
  assert.deepStrictEqual(fileKindsOf('.env.local'), ['config']);
  assert.deepStrictEqual(fileKindsOf('vite.config.ts'), ['config']);
  assert.deepStrictEqual(fileKindsOf('db/migrations/add_users.sql'), ['migration']);
  assert.deepStrictEqual(fileKindsOf('prisma/20260921120000_init.sql'), ['migration']);
  assert.deepStrictEqual(fileKindsOf('Cargo.lock'), ['deps']);
  assert.deepStrictEqual(fileKindsOf('requirements-dev.txt'), ['deps']);
  assert.deepStrictEqual(fileKindsOf('Gemfile.lock'), ['deps']);
  assert.deepStrictEqual(fileKindsOf('infra/main.tf'), ['infra']);
  assert.deepStrictEqual(fileKindsOf('k8s/app/service.ts'), ['infra']);
  assert.deepStrictEqual(fileKindsOf('Dockerfile'), ['infra']);
  assert.deepStrictEqual(fileKindsOf('src/index.ts'), []);
});

test('a file can count as several kinds at once', () => {
  assert.deepStrictEqual(fileKindsOf('docs/adr/0007-use-postgres.md'), ['docs', 'adr']);
  assert.deepStrictEqual(fileKindsOf('0012-split-billing.md'), ['docs', 'adr']);
  assert.deepStrictEqual(fileKindsOf('docker-compose.yml'), ['config', 'infra']);
  assert.deepStrictEqual(fileKindsOf('docs/tests/example.test.md'), ['test', 'docs']);
});

test('config steps aside for deps and CI, which explain the file better', () => {
  assert.deepStrictEqual(fileKindsOf('package.json'), ['deps']);
  assert.deepStrictEqual(fileKindsOf('pnpm-lock.yaml'), ['deps']);
  assert.deepStrictEqual(fileKindsOf('pyproject.toml'), ['deps']);
  assert.deepStrictEqual(fileKindsOf('.gitlab-ci.yml'), ['ci']);
});

test('fileKindsOf is case-insensitive', () => {
  assert.deepStrictEqual(fileKindsOf('DOCS/Guide.MD'), ['docs']);
  assert.deepStrictEqual(fileKindsOf('Package.JSON'), ['deps']);
});

// ── Tools ───────────────────────────────────────────────────

test('claudeToolCategory maps every Claude Code tool into the shared vocabulary', () => {
  const cases = {
    Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
    Bash: 'shell',
    Read: 'read', NotebookRead: 'read',
    Grep: 'search', Glob: 'search', LS: 'search',
    WebFetch: 'web', WebSearch: 'web',
    Task: 'subagent', Agent: 'subagent',
    TodoWrite: 'plan', ExitPlanMode: 'plan',
    mcp__github__create_issue: 'mcp',
    Skill: 'other', BashOutput: 'other', '': 'other',
  };
  for (const [name, category] of Object.entries(cases)) assert.strictEqual(claudeToolCategory(name), category, name);
});

test('codexToolCategory maps every Codex tool into the same vocabulary', () => {
  const cases = {
    apply_patch: 'edit',
    shell: 'shell', exec_command: 'shell', local_shell: 'shell', 'container.exec': 'shell',
    web_search: 'web',
    update_plan: 'plan',
    mcp__linear__list_issues: 'mcp',
    linear__list_issues: 'mcp',
    view_image: 'other',
  };
  for (const [name, category] of Object.entries(cases)) assert.strictEqual(codexToolCategory(name), category, name);
});

// ── Lines ───────────────────────────────────────────────────

test('countLines does not count a trailing newline as another line', () => {
  assert.strictEqual(countLines(''), 0);
  assert.strictEqual(countLines(undefined), 0);
  assert.strictEqual(countLines('one'), 1);
  assert.strictEqual(countLines('one\ntwo'), 2);
  assert.strictEqual(countLines('one\ntwo\n'), 2);
});

test('claudeEditLines reads Edit, MultiEdit, Write and NotebookEdit inputs', () => {
  assert.deepStrictEqual(claudeEditLines('Edit', { old_string: 'a', new_string: 'b\nc\nd' }), { added: 3, removed: 1 });
  assert.deepStrictEqual(
    claudeEditLines('MultiEdit', { edits: [{ old_string: 'a\nb', new_string: 'c' }, { old_string: 'x', new_string: 'y\nz' }] }),
    { added: 3, removed: 3 },
  );
  assert.deepStrictEqual(claudeEditLines('Write', { content: 'l1\nl2\nl3\nl4\n' }), { added: 4, removed: 0 });
  assert.deepStrictEqual(claudeEditLines('NotebookEdit', { new_source: 'print(1)\nprint(2)' }), { added: 2, removed: 0 });
  assert.deepStrictEqual(claudeEditLines('Edit', null), { added: 0, removed: 0 });
});

test('patchLines counts +/- body lines and never the *** or @@ headers', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/a.ts',
    '@@ function a()',
    ' context',
    '-old one',
    '-old two',
    '+new one',
    '*** Add File: src/b.ts',
    '+b1',
    '+b2',
    '*** End Patch',
  ].join('\n');
  assert.deepStrictEqual(patchLines(patch), { added: 3, removed: 2 });
  assert.deepStrictEqual(patchLines(undefined), { added: 0, removed: 0 });
});

// ── Shell ───────────────────────────────────────────────────

test('classifyShell recognises commits, pull requests and test runners', () => {
  assert.deepStrictEqual(classifyShell('git add -A && git commit -m "feat: x"'), { commit: true, pr: false, test: false });
  assert.strictEqual(classifyShell('git -C repo commit --amend --no-edit').commit, true);
  assert.strictEqual(classifyShell('gh pr create --fill').pr, true);
  for (const cmd of ['npx vitest run', 'pnpm test', 'npm run test -- --watch=false', 'yarn test', 'bun test', 'python -m pytest -q', 'go test ./...', 'cargo test', 'bundle exec rspec', 'vendor/bin/phpunit', 'dotnet test', 'mvn test', './gradlew test', 'node --test scripts/*.test.js', 'bash -lc npm test']) {
    assert.strictEqual(classifyShell(cmd).test, true, cmd);
  }
});

test('classifyShell is not fooled by the words inside a command', () => {
  // A commit message is somebody's words, not a test run.
  assert.deepStrictEqual(classifyShell('git commit -m "add jest tests and run npm test"'), { commit: true, pr: false, test: false });
  assert.strictEqual(classifyShell('cat jest.config.js').test, false);
  assert.strictEqual(classifyShell('git log --grep commit').commit, false);
  assert.strictEqual(classifyShell('gh pr view 12').pr, false);
  assert.deepStrictEqual(classifyShell(undefined), { commit: false, pr: false, test: false });
});

// ── The accumulator ─────────────────────────────────────────

test('createFacets counts commits and PRs only when they worked, and test runs by outcome', () => {
  const f = createFacets();
  f.shell(classifyShell('git commit -m x'), true);
  f.shell(classifyShell('git commit -m x'), false); // hook rejected it
  f.shell(classifyShell('gh pr create --fill'), true);
  f.shell(classifyShell('gh pr create --fill'), false);
  f.shell(classifyShell('npm test'), true);
  f.shell(classifyShell('npm test'), false);
  f.shell(classifyShell('npm test'), false);
  const out = f.result(new Set(), 7, 3);
  assert.strictEqual(out.commits, 1);
  assert.strictEqual(out.prsOpened, 1);
  assert.deepStrictEqual(out.testRuns, { passed: 1, failed: 2 });
});

test('a facet that throws breaks only the facets, and quietly', () => {
  const f = createFacets();
  f.tool('edit');
  // A key whose conversion throws stands in for any bug in a classifier.
  assert.doesNotThrow(() => f.tool({ toString() { throw new Error('boom'); } }));
  assert.strictEqual(f.result(new Set(['a.ts']), 2, 0), undefined);
});

// ── Both parsers, end to end ────────────────────────────────

function writeLines(lines, name) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-facets-')), name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  return file;
}

const TS = '2026-09-21T10:00:00.000Z';
const assistant = (id, content) => ({ type: 'assistant', timestamp: TS, message: { id, model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content } });
const results = (...blocks) => ({ type: 'user', timestamp: TS, message: { content: blocks.map(([id, is_error]) => ({ type: 'tool_result', tool_use_id: id, is_error, content: is_error ? 'error' : 'ok' })) } });
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });

test('a Claude Code transcript reduces to the full facets object', async () => {
  const file = writeLines(
    [
      { type: 'user', timestamp: TS, message: { content: 'add retries to the client' } },
      assistant('m1', [
        use('t1', 'Read', { file_path: 'src/client.ts' }),
        use('t2', 'Grep', { pattern: 'fetch' }),
        use('t3', 'Edit', { file_path: 'src/client.ts', old_string: 'fetch(url)', new_string: 'retry(() =>\n  fetch(url)\n)' }),
        use('t4', 'Write', { file_path: 'src/client.test.ts', content: 'a\nb\nc\nd\n' }),
        use('t5', 'Write', { file_path: 'docs/adr/0003-retries.md', content: '# Retries\n' }),
        // Denied: neither its file nor its lines count.
        use('t6', 'Edit', { file_path: 'package.json', old_string: '"a"', new_string: '"b"\n"c"' }),
        use('t7', 'MultiEdit', { file_path: 'package.json', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'p\nq', new_string: 'r' }] }),
      ]),
      results(['t1', false], ['t2', false], ['t3', false], ['t4', false], ['t5', false], ['t6', true], ['t7', false]),
      assistant('m2', [
        use('t8', 'Bash', { command: 'pnpm test' }),
        use('t9', 'Bash', { command: 'pnpm test' }),
        use('t10', 'Bash', { command: 'git add -A && git commit -m "feat: retries"' }),
        use('t11', 'Bash', { command: 'gh pr create --fill' }),
        use('t12', 'TodoWrite', { todos: [] }),
        use('t13', 'mcp__linear__update_issue', { id: 'X-1' }),
        use('t14', 'WebFetch', { url: 'https://example.com' }),
        use('t15', 'Task', { prompt: 'review' }),
        use('t16', 'Skill', { skill: 'code-review', args: 'check the retry client' }),
        use('t17', 'Agent', { subagent_type: 'Explore', prompt: 'find the pager' }),
        use('t18', 'mcp__1a59c906-04da-521d-bda7-7f71b9f9e01c__read', {}),
      ]),
      results(['t8', true], ['t9', false], ['t10', false], ['t11', false], ['t12', false], ['t13', false], ['t14', false], ['t15', false], ['t16', false], ['t17', false], ['t18', false]),
    ],
    'transcript.jsonl',
  );

  const agg = await aggregate(file, 'acme/widgets', { wantTranscript: false });

  assert.deepStrictEqual(agg.facets, {
    v: 2,
    languages: { TypeScript: 2, Markdown: 1, JSON: 1 },
    fileKinds: { test: 1, docs: 1, adr: 1, deps: 1 },
    tools: { read: 1, search: 1, edit: 5, shell: 4, plan: 1, mcp: 2, web: 1, subagent: 2, other: 1 },
    toolUses: 18,
    toolErrors: 2,
    linesAdded: 10,
    linesRemoved: 4,
    commits: 1,
    prsOpened: 1,
    testRuns: { passed: 1, failed: 1 },
    commands: {},
    skills: { 'code-review': 1 },
    subagents: { 'general-purpose': 1, Explore: 1 },
    mcpServers: { linear: 1, 'claude-ai-connector': 1 },
    prompts: 1,
    interrupts: 0,
    permissionDenials: 0,
    compactions: 0,
    apiErrors: 0,
  });
  // Names of what was invoked, never what it was given: no paths, commands or arguments.
  const wire = JSON.stringify(agg.facets);
  for (const leak of ['client', 'package', 'pnpm', 'gh pr', 'pager', 'update_issue']) assert.ok(!wire.includes(leak), `facets leaked ${leak}`);
});

test('a Codex rollout reduces to the full facets object, in the same vocabulary', async () => {
  const T1 = '2026-09-21T10:01:00.000Z';
  const call = (call_id, name, args) => ({ timestamp: T1, type: 'response_item', payload: { type: 'function_call', name, call_id, arguments: JSON.stringify(args) } });
  const exit = (call_id, code) => ({ timestamp: T1, type: 'response_item', payload: { type: 'function_call_output', call_id, output: JSON.stringify({ output: '', metadata: { exit_code: code, duration_seconds: 0.1 } }) } });
  const patch = (call_id, input) => ({ timestamp: T1, type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id, input } });
  const patchOut = (call_id, output) => ({ timestamp: T1, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id, output } });
  const file = writeLines(
    [
      { timestamp: TS, type: 'session_meta', payload: { id: '0f7a5b6c-1d2e-4f30-8a9b-c0d1e2f3a4b5', cwd: '/work/acme' } },
      { timestamp: TS, type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-5.3-codex' } },
      { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'port the retry middleware' }] } },
      patch('c1', '*** Begin Patch\n*** Update File: src/retry.go\n@@\n-old\n+new\n+newer\n*** Add File: src/retry_test.go\n+t1\n+t2\n*** End Patch'),
      patchOut('c1', 'Success. Updated the following files:\nM src/retry.go'),
      // Failed to apply: not a file, not a line.
      patch('c2', '*** Begin Patch\n*** Update File: go.mod\n-a\n+b\n*** End Patch'),
      patchOut('c2', 'error: patch failed to apply'),
      call('c3', 'shell', { command: ['bash', '-lc', 'go test ./...'] }),
      exit('c3', 1),
      call('c4', 'shell', { command: ['bash', '-lc', 'go test ./...'] }),
      exit('c4', 0),
      call('c5', 'exec_command', { cmd: 'git commit -am "port retry"' }),
      exit('c5', 0),
      call('c6', 'exec_command', { cmd: 'gh pr create --fill' }),
      exit('c6', 1),
      call('c7', 'update_plan', { plan: [] }),
      call('c8', 'linear__list_issues', {}),
      { timestamp: T1, type: 'response_item', payload: { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'x' } } },
      { timestamp: T1, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
    ],
    'rollout-2026-09-21T10-00-00-0f7a5b6c-1d2e-4f30-8a9b-c0d1e2f3a4b5.jsonl',
  );

  const agg = await aggregateFor('codex', file, 'acme/api', { wantTranscript: false });

  assert.deepStrictEqual(agg.facets, {
    v: 2,
    languages: { Go: 2 },
    fileKinds: { test: 1 },
    tools: { edit: 2, shell: 4, plan: 1, mcp: 1, web: 1 },
    toolUses: 9,
    toolErrors: 3,
    linesAdded: 4,
    linesRemoved: 1,
    commits: 1,
    prsOpened: 0,
    testRuns: { passed: 1, failed: 1 },
    commands: {},
    skills: {},
    subagents: {},
    mcpServers: { linear: 1 },
    prompts: 0,
    interrupts: 0,
    permissionDenials: 0,
    compactions: 0,
    apiErrors: 0,
  });
});

// ── v2: names, friction and modes ─────────────────────────────

test('cleanName keeps names and drops anything that reads like content', () => {
  assert.strictEqual(cleanName('/code-review'), 'code-review');
  assert.strictEqual(cleanName('caveman:cavecrew-reviewer'), 'caveman:cavecrew-reviewer');
  assert.strictEqual(cleanName('rm -rf /'), null);
  assert.strictEqual(cleanName('"quoted"'), null);
  assert.strictEqual(cleanName('x'.repeat(65)), null);
  assert.strictEqual(cleanName(undefined), null);
});

test('mcpServerOf keeps the server and never the tool; connectors are one name', () => {
  assert.strictEqual(mcpServerOf('mcp__linear__update_issue'), 'linear');
  assert.strictEqual(mcpServerOf('mcp__Claude_Browser__computer'), 'Claude_Browser');
  assert.strictEqual(mcpServerOf('mcp__1a59c906-04da-521d-bda7-7f71b9f9e01c__read'), 'claude-ai-connector');
  assert.strictEqual(mcpServerOf('Bash'), null);
  assert.strictEqual(codexMcpServerOf('linear__list_issues'), 'linear');
  assert.strictEqual(codexMcpServerOf('mcp__github__get_pr'), 'github');
  assert.strictEqual(codexMcpServerOf('shell'), null);
});

test('commandsIn reads Claude Code slash-command tags and nothing after them', () => {
  assert.deepStrictEqual(commandsIn('<command-name>/model</command-name>\n<command-args>opus</command-args>'), ['model']);
  assert.deepStrictEqual(commandsIn('please run /model'), []);
});

test('isDenial tells a refusal from a failure; isInterrupt spots both interrupt forms', () => {
  assert.ok(isDenial("The user doesn't want to proceed with this tool use. The tool use was rejected"));
  assert.ok(isDenial('Permission for this action was denied by the Claude Code auto mode classifier. Reason: x'));
  assert.ok(!isDenial('Exit code 1'));
  assert.ok(isInterrupt('[Request interrupted by user]'));
  assert.ok(isInterrupt('[Request interrupted by user for tool use]'));
  assert.ok(!isInterrupt('I was interrupted'));
});

test('a names map stops growing at MAX_NAMES distinct names but keeps counting known ones', () => {
  const f = createFacets();
  for (let i = 0; i < MAX_NAMES + 5; i++) f.name('skills', `skill-${i}`);
  f.name('skills', 'skill-0');
  const skills = f.result(new Set(), 0, 0).skills;
  assert.strictEqual(Object.keys(skills).length, MAX_NAMES);
  assert.strictEqual(skills['skill-0'], 2);
});

test('a session records commands, prompts, interrupts, refusals, compactions, API errors and its dominant modes', async () => {
  const base = { timestamp: TS, entrypoint: 'claude-desktop', effort: 'high' };
  const file = writeLines(
    [
      { ...base, type: 'user', permissionMode: 'plan', message: { content: 'plan the retries' } },
      { ...base, type: 'user', permissionMode: 'bypassPermissions', message: { content: '<command-name>/model</command-name>\n<command-args>opus</command-args>' } },
      { ...base, type: 'user', permissionMode: 'bypassPermissions', message: { content: [{ type: 'text', text: 'now build it' }] } },
      assistant('m1', [use('t1', 'Bash', { command: 'rm -rf dist' })]),
      { ...base, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: "The user doesn't want to proceed with this tool use." }] } },
      { ...base, type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
      { ...base, type: 'user', permissionMode: 'bypassPermissions', message: { content: '<command-name>/compact</command-name>' } },
      { ...base, type: 'system', subtype: 'compact_boundary' },
      { ...base, type: 'system', subtype: 'api_error', error: { status: 529 } },
      { ...base, type: 'user', isMeta: true, message: { content: 'meta, never a prompt' } },
    ],
    'modes.jsonl',
  );

  const { facets } = await aggregate(file, 'acme/widgets', { wantTranscript: false });

  assert.deepStrictEqual(facets.commands, { model: 1, compact: 1 });
  assert.strictEqual(facets.prompts, 2);
  assert.strictEqual(facets.interrupts, 1);
  assert.strictEqual(facets.permissionDenials, 1);
  assert.strictEqual(facets.compactions, 1);
  assert.strictEqual(facets.apiErrors, 1);
  assert.strictEqual(facets.permissionMode, 'bypassPermissions');
  assert.strictEqual(facets.surface, 'claude-desktop');
  assert.strictEqual(facets.effort, 'high');
  assert.ok(!JSON.stringify(facets).includes('opus'), 'a command argument leaked');
});

test("subagent transcripts add their usage, tools and edits to the session, but not their prompts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-subagents-'));
  const id = 'abc-123';
  const main = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(
    main,
    [
      { type: 'user', timestamp: TS, message: { content: 'review the pager' } },
      assistant('m1', [use('t1', 'Agent', { subagent_type: 'Explore', prompt: 'look around' })]),
      results(['t1', false]),
    ]
      .map((l) => JSON.stringify(l))
      .join('\n'),
  );
  fs.mkdirSync(path.join(dir, id, 'subagents'), { recursive: true });
  const subAssistant = (mid, content) => ({ type: 'assistant', timestamp: TS, isSidechain: true, message: { id: mid, model: 'claude-haiku-4-5', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5000 }, content } });
  fs.writeFileSync(
    path.join(dir, id, 'subagents', 'agent-a1.jsonl'),
    [
      { type: 'user', timestamp: TS, isSidechain: true, message: { content: 'look around' } },
      subAssistant('s1', [use('u1', 'Grep', { pattern: 'pager' }), use('u2', 'Edit', { file_path: 'src/pager.ts', old_string: 'a', new_string: 'b' })]),
      { type: 'user', timestamp: TS, isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok' }, { type: 'tool_result', tool_use_id: 'u2', content: 'ok' }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n'),
  );

  const agg = await aggregate(main, 'acme/widgets', { wantTranscript: false });

  const haiku = agg.usage.find((u) => u.model === 'claude-haiku-4-5');
  assert.deepStrictEqual(haiku, { model: 'claude-haiku-4-5', inputTokens: 100, outputTokens: 20, cacheReadTokens: 5000, cacheWriteTokens: 0 });
  assert.strictEqual(agg.filesTouched, 1);
  assert.strictEqual(agg.facets.toolUses, 3);
  assert.deepStrictEqual(agg.facets.tools, { subagent: 1, search: 1, edit: 1 });
  assert.deepStrictEqual(agg.facets.subagents, { Explore: 1 });
  // The orchestrator's brief to its subagent is not a person typing.
  assert.strictEqual(agg.facets.prompts, 1);
});

test('a session without a subagents folder reads exactly as before', async () => {
  const file = writeLines([{ type: 'user', timestamp: TS, message: { content: 'hi' } }, assistant('m1', [])], 'lonely.jsonl');

  const agg = await aggregate(file, 'acme/widgets', { wantTranscript: false });

  assert.deepStrictEqual(agg.usage, [{ model: 'claude-opus-5', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }]);
});

// ── The body ────────────────────────────────────────────────

const FACETS = { v: 1, languages: { TypeScript: 1 }, fileKinds: {}, tools: { edit: 1 }, toolUses: 1, toolErrors: 0, linesAdded: 3, linesRemoved: 0, commits: 0, prsOpened: 0, testRuns: { passed: 0, failed: 0 } };
const baseAgg = () => ({ usage: [], startedAt: TS, endedAt: TS, durationMinutes: 1, filesTouched: 1, testsAdded: 0, retryRate: 0, title: 'x', branch: 'main', facets: FACETS });

test('an incognito body carries the time zone and never the facets', () => {
  const body = buildBody('s1', 'acme/widgets', baseAgg(), process.cwd(), 'ended', { incognito: true });
  assert.strictEqual(body.tz, timeZone());
  assert.strictEqual(body.facets, undefined);
  assert.ok(!('facets' in body));
});

test('a normal body carries both the time zone and the facets', () => {
  const body = buildBody('s1', 'acme/widgets', baseAgg(), process.cwd(), 'active', { incognito: false });
  assert.ok(typeof body.tz === 'string' && body.tz.length > 0, `tz was ${body.tz}`);
  assert.deepStrictEqual(body.facets, FACETS);
});

test('facets that failed to compute are omitted and the report is still built', () => {
  const agg = baseAgg();
  Object.defineProperty(agg, 'facets', { get() { throw new Error('boom'); } });
  const body = buildBody('s1', 'acme/widgets', agg, process.cwd(), 'ended', { incognito: false });
  assert.strictEqual(body.facets, undefined);
  assert.strictEqual(body.externalId, 's1');
  assert.strictEqual(body.status, 'ended');
  assert.deepStrictEqual(body.usage, []);

  // And the shape a broken accumulator actually hands over: nothing.
  const none = buildBody('s1', 'acme/widgets', { ...baseAgg(), facets: undefined }, process.cwd(), 'ended', { incognito: false });
  assert.ok(!JSON.stringify(none).includes('"facets"'));
});
