'use strict';
/**
 * PL-X03: the setup snapshot (ADR 0044). Names and shapes, never values.
 *
 * The fixture below is a synthetic home and repository stuffed with fake secrets in every
 * place real ones live: MCP `env`, `headers` and `args`, tokens in URL paths and queries,
 * hook commands, permission rules, `CLAUDE.md` bodies and agent prompts. None of them may
 * appear anywhere in the snapshot.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const setup = require('./setup-snapshot.js');
const { SECRET_RE } = require('./report-session.js');

/** Every fake secret planted in the fixture. */
const SECRETS = [
  'sk-live-FAKE0000secretAAAA1111',
  'Bearer FAKEbearer9999token',
  'FAKEbearer9999token',
  'ghp_FAKEgithubTOKEN000000000000',
  'tok3n-in-path-FAKE',
  'query-secret-FAKE',
  'FAKEhookPASSWORD42',
  'curl -H',
  'CLAUDE_MD_BODY_FAKE_LINE',
  'PROJECT_MD_BODY_FAKE_LINE',
  'SKILL_BODY_FAKE',
  'COMMAND_BODY_FAKE',
  'Read(./.env)',
  'Bash(rm -rf:*)',
  'git push --force',
  'FAKE_DB_PASSWORD_VALUE',
  'plugin-env-FAKE-secret',
  'workflow-secret-FAKE',
  '/v1/sse',
  'mcp/endpoint',
  '--token=',
  'API_KEY',
  'Authorization',
  'X-Api-Key',
  '8443',
  'user:pass',
];

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

function md(fields, body) {
  return `---\n${fields}\n---\n\n${body}\n`;
}

/** A synthetic home and repository. Nothing here comes from a real machine. */
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-setup-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  const claude = path.join(home, '.claude');
  const pluginDir = path.join(claude, 'plugins', 'cache', 'acme', 'ops', '1.2.3');
  const disabledDir = path.join(claude, 'plugins', 'cache', 'acme', 'off', '0.1.0');

  write(path.join(claude, 'settings.json'), {
    model: 'opus',
    effortLevel: 'high',
    permissions: {
      defaultMode: 'acceptEdits',
      allow: ['Bash(npm test:*)', 'Read(src/**)', 'Bash(git push --force)'],
      ask: ['Bash(rm -rf:*)'],
      deny: ['Read(./.env)', 'Read(./secrets/**)'],
    },
    skipDangerousModePermissionPrompt: true,
    statusLine: { type: 'command', command: 'node ~/.pravex/statusline.js --token=FAKEhookPASSWORD42' },
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'curl -H "Authorization: Bearer FAKEbearer9999token" https://hooks.example' }] }],
      PostToolUse: [
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo FAKEhookPASSWORD42' }, { type: 'command', command: 'lint' }] },
        { matcher: 'Write', hooks: [{ type: 'command', command: 'fmt' }] },
      ],
    },
    enabledPlugins: { 'ops@acme': true, 'off@acme': false, 'ghost@nowhere': true },
    mcpServers: {
      'settings-server': { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['server.js', '--token=FAKEhookPASSWORD42'] },
    },
  });
  // Rules repeated across the two files count once; the local file wins on values.
  write(path.join(claude, 'settings.local.json'), {
    model: 'sonnet',
    permissions: { allow: ['Read(src/**)', 'WebFetch(domain:example.com)'] },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo again' }] }] },
  });
  write(path.join(claude, 'CLAUDE.md'), 'CLAUDE_MD_BODY_FAKE_LINE 1\nline 2\nline 3\n');

  write(path.join(home, '.claude.json'), {
    mcpServers: {
      github: {
        type: 'stdio',
        command: '/usr/local/bin/npx',
        args: ['-y', '@modelcontextprotocol/server-github', '--token=ghp_FAKEgithubTOKEN000000000000'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_FAKEgithubTOKEN000000000000', API_KEY: 'sk-live-FAKE0000secretAAAA1111' },
      },
      linear: {
        type: 'http',
        url: 'https://user:pass@mcp.linear.example:8443/mcp/endpoint/tok3n-in-path-FAKE?key=query-secret-FAKE',
        headers: { Authorization: 'Bearer FAKEbearer9999token', 'X-Api-Key': 'sk-live-FAKE0000secretAAAA1111' },
      },
      events: { type: 'sse', url: 'https://events.example.com/v1/sse?token=query-secret-FAKE' },
      inferred: { url: 'https://inferred.example.com/mcp/endpoint' },
      uvx: { command: 'uvx.cmd', args: ['mcp-server-fetch'] },
      'bad name with spaces': { command: 'npx' },
      '-leading-dash': { command: 'npx' },
      nothing: { description: 'neither command nor url' },
      templated: { type: 'http', url: '${MCP_URL}/path' },
    },
    projects: {
      [repo]: {
        mcpServers: {
          'local-db': { command: 'docker', args: ['run', '-e', 'FAKE_DB_PASSWORD_VALUE'], env: { PASSWORD: 'FAKE_DB_PASSWORD_VALUE' } },
        },
        allowedTools: ['Bash(git push --force)'],
      },
      '/somewhere/else': { mcpServers: { elsewhere: { command: 'npx' } } },
    },
  });

  write(
    path.join(claude, 'agents', 'reviewer.md'),
    md('name: reviewer\ndescription: Reviews diffs for bugs\nmodel: sonnet\ntools: Read, Grep, Bash(git push --force)', 'AGENT_PROMPT_BODY_FAKE'),
  );
  write(
    path.join(claude, 'agents', 'listy.md'),
    md('name: listy\ndescription: |\n  Line one\n  line two\nmodel: haiku\ntools:\n  - Read\n  - mcp__github__search', 'AGENT_PROMPT_BODY_FAKE'),
  );
  write(path.join(claude, 'agents', 'inline.md'), md('name: "inline"\ntools: [Read, "Edit"]', 'AGENT_PROMPT_BODY_FAKE'));
  write(path.join(claude, 'agents', 'nofront.md'), 'AGENT_PROMPT_BODY_FAKE with no frontmatter');
  write(path.join(claude, 'agents', 'evil.md'), md('name: evil name; rm -rf\ndescription: x', 'AGENT_PROMPT_BODY_FAKE'));
  write(
    path.join(claude, 'skills', 'deploy', 'SKILL.md'),
    md(`name: deploy\ndescription: "Deploys\u0007 the app\twith ${'x'.repeat(300)}"`, 'SKILL_BODY_FAKE'),
  );
  write(path.join(claude, 'skills', 'unnamed', 'SKILL.md'), md('description: Uses the folder name, key ghp_FAKEgithubTOKEN000000000000', 'SKILL_BODY_FAKE'));
  write(path.join(claude, 'skills', 'empty-folder', 'README.md'), 'not a skill');
  write(path.join(claude, 'commands', 'ship.md'), md('description: Ships it', 'COMMAND_BODY_FAKE'));
  write(path.join(claude, 'commands', 'gsd', 'do.md'), 'COMMAND_BODY_FAKE');

  write(path.join(claude, 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'ops@acme': [{ scope: 'user', installPath: pluginDir, version: '1.2.3', gitCommitSha: 'abc' }],
      'off@acme': [{ scope: 'user', installPath: disabledDir, version: '0.1.0' }],
    },
  });
  write(path.join(pluginDir, '.claude-plugin', 'plugin.json'), {
    name: 'ops',
    mcpServers: { 'plugin-inline': { command: 'node', env: { TOKEN: 'plugin-env-FAKE-secret' } } },
  });
  write(path.join(pluginDir, '.mcp.json'), {
    mcpServers: { 'plugin-api': { type: 'http', url: 'https://api.ops.example/mcp/endpoint?k=plugin-env-FAKE-secret' } },
  });
  write(path.join(pluginDir, 'hooks', 'hooks.json'), {
    description: 'ops hooks',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/x.sh FAKEhookPASSWORD42' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] }],
    },
  });
  write(path.join(pluginDir, 'agents', 'oncall.md'), md('name: oncall\ndescription: Handles pages\ntools: Bash', 'AGENT_PROMPT_BODY_FAKE'));
  write(path.join(pluginDir, 'skills', 'rollback', 'SKILL.md'), md('name: rollback\ndescription: Rolls back', 'SKILL_BODY_FAKE'));
  write(path.join(pluginDir, 'commands', 'page.md'), 'COMMAND_BODY_FAKE');
  // Installed but turned off: none of this counts.
  write(path.join(disabledDir, 'agents', 'disabled-agent.md'), md('name: disabled-agent', 'x'));
  write(path.join(disabledDir, '.mcp.json'), { 'disabled-mcp': { command: 'npx' } });

  write(path.join(repo, 'CLAUDE.md'), 'PROJECT_MD_BODY_FAKE_LINE\nb\n');
  write(path.join(repo, '.claude', 'CLAUDE.md'), 'one\ntwo\nthree');
  write(path.join(repo, '.mcp.json'), {
    mcpServers: {
      sentry: { type: 'http', url: 'https://mcp.sentry.example/mcp/endpoint', headers: { Authorization: 'Bearer FAKEbearer9999token' } },
      pg: { command: 'npx', args: ['pg-mcp', 'postgres://user:pass@db/FAKE_DB_PASSWORD_VALUE'] },
    },
  });
  write(path.join(repo, '.claude', 'settings.json'), {
    permissions: { allow: ['Bash(pnpm test)'], deny: ['Bash(git push --force)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard FAKEhookPASSWORD42' }] }] },
  });
  write(path.join(repo, '.claude', 'settings.local.json'), '{ this is not json');
  write(path.join(repo, '.claude', 'agents', 'migrator.md'), md('name: migrator\ndescription: Writes migrations', 'AGENT_PROMPT_BODY_FAKE'));
  write(path.join(repo, '.claude', 'skills', 'release', 'SKILL.md'), md('name: release', 'SKILL_BODY_FAKE'));
  write(path.join(repo, '.claude', 'commands', 'review-pr.md'), 'COMMAND_BODY_FAKE');
  write(path.join(repo, '.github', 'workflows', 'ci.yml'), 'jobs: {}\n# workflow-secret-FAKE\n');
  write(path.join(repo, '.github', 'workflows', 'claude.yaml'), 'steps:\n  - uses: anthropics/claude-code-action@v1\n');
  write(path.join(repo, '.github', 'workflows', 'notes.txt'), 'anthropics/claude-code-action');

  return { base, home, repo };
}

const build = (fx, extra = {}) =>
  setup.buildSnapshot({ home: fx.home, cwd: fx.repo, root: fx.repo, repo: 'acme/widgets', env: {}, pluginVersion: '0.13.0', machineId: 'machine-1', ...extra });

const byName = (list, name) => list.find((i) => i.name === name);

test('a fixture full of secrets produces a snapshot that contains none of them', () => {
  const fx = fixture();
  const json = JSON.stringify(build(fx));
  for (const secret of SECRETS) assert.ok(!json.includes(secret), `the snapshot carried ${secret}`);
  // Nor any value of the keys that hold them.
  assert.ok(!/"(?:env|headers|args|url|command|allowedTools)"/.test(json), 'a value-holding key leaked');
});

test('emits exactly the wire shape', () => {
  const fx = fixture();
  const s = build(fx, { claudeVersion: '2.3.1' });
  assert.deepStrictEqual(Object.keys(s), ['v', 'machineId', 'hostname', 'platform', 'arch', 'pluginVersion', 'claudeVersion', 'user', 'project', 'environment']);
  assert.strictEqual(s.v, 2);
  assert.deepStrictEqual(Object.keys(s.environment), ['directories', 'connections', 'clis']);
  assert.strictEqual(s.machineId, 'machine-1');
  assert.strictEqual(s.pluginVersion, '0.13.0');
  assert.strictEqual(s.claudeVersion, '2.3.1');
  const scopeKeys = ['claudeMd', 'settings', 'mcpServers', 'plugins', 'agents', 'skills', 'commands', 'hooks'];
  assert.deepStrictEqual(Object.keys(s.user), scopeKeys);
  assert.deepStrictEqual(Object.keys(s.project), ['repo', ...scopeKeys, 'workflows']);
  assert.deepStrictEqual(Object.keys(s.user.settings), ['model', 'effort', 'defaultMode', 'allow', 'ask', 'deny', 'denyCoversSecrets', 'capabilities', 'skipDangerousPrompt', 'statusLine']);
  for (const m of [...s.user.mcpServers, ...s.project.mcpServers]) assert.deepStrictEqual(Object.keys(m), ['name', 'transport', 'scope', 'launcher', 'host', 'plugin']);
  for (const a of s.user.agents) assert.deepStrictEqual(Object.keys(a), ['name', 'description', 'model', 'tools', 'prompt', 'source', 'plugin']);
  for (const k of s.user.skills) assert.deepStrictEqual(Object.keys(k), ['name', 'description', 'source', 'plugin']);
  for (const c of s.user.commands) assert.deepStrictEqual(Object.keys(c), ['name', 'source', 'plugin']);
  for (const h of s.user.hooks) assert.deepStrictEqual(Object.keys(h), ['event', 'count', 'source', 'plugin']);
  for (const p of s.user.plugins) assert.deepStrictEqual(Object.keys(p), ['id', 'enabled', 'version']);
  assert.ok(!s.hostname.includes('.') && s.hostname.length <= 64);
});

test('claudeVersion comes from CLAUDE_CODE_VERSION when not given, and is left out when unknown', () => {
  const fx = fixture();
  assert.strictEqual(build(fx, { env: { CLAUDE_CODE_VERSION: '2.4.0' } }).claudeVersion, '2.4.0');
  assert.ok(!('claudeVersion' in build(fx)));
});

test('settings: values, rule counts across both files, secrets coverage, never a rule string', () => {
  const fx = fixture();
  const { user, project } = build(fx);
  assert.deepStrictEqual(user.settings, {
    model: 'sonnet',
    effort: 'high',
    defaultMode: 'acceptEdits',
    allow: 4,
    ask: 1,
    deny: 2,
    denyCoversSecrets: true,
    capabilities: { edit: 'allow', write: 'allow', bash: user.settings.capabilities.bash, 'git-push': user.settings.capabilities['git-push'], 'gh-pr': user.settings.capabilities['gh-pr'], 'run-tests': user.settings.capabilities['run-tests'], 'web-fetch': user.settings.capabilities['web-fetch'] },
    skipDangerousPrompt: true,
    statusLine: true,
  });
  assert.ok(Object.values(user.settings.capabilities).every((v) => ['allow', 'ask', 'deny'].includes(v)));
  // The broken settings.local.json is skipped; settings.json still counts.
  assert.deepStrictEqual(project.settings, {
    model: null,
    effort: null,
    defaultMode: null,
    allow: 1,
    ask: 0,
    deny: 1,
    denyCoversSecrets: false,
    capabilities: project.settings.capabilities,
    skipDangerousPrompt: false,
    statusLine: false,
  });
});

test('MCP servers: transports, launchers, hosts and scopes', () => {
  const fx = fixture();
  const { user, project } = build(fx);
  const u = (name) => byName(user.mcpServers, name);
  assert.deepStrictEqual(u('github'), { name: 'github', transport: 'stdio', scope: 'user', launcher: 'npx', host: null, plugin: null });
  assert.deepStrictEqual(u('linear'), { name: 'linear', transport: 'http', scope: 'user', launcher: null, host: 'mcp.linear.example', plugin: null });
  assert.deepStrictEqual(u('events'), { name: 'events', transport: 'sse', scope: 'user', launcher: null, host: 'events.example.com', plugin: null });
  assert.strictEqual(u('inferred').transport, 'http');
  assert.strictEqual(u('inferred').host, 'inferred.example.com');
  assert.strictEqual(u('uvx').launcher, 'uvx');
  assert.strictEqual(u('settings-server').launcher, 'node');
  assert.strictEqual(u('templated').host, null);
  assert.deepStrictEqual(u('plugin-inline'), { name: 'plugin-inline', transport: 'stdio', scope: 'plugin', launcher: 'node', host: null, plugin: 'ops@acme' });
  assert.deepStrictEqual(u('plugin-api'), { name: 'plugin-api', transport: 'http', scope: 'plugin', launcher: null, host: 'api.ops.example', plugin: 'ops@acme' });
  for (const gone of ['bad name with spaces', '-leading-dash', 'nothing', 'disabled-mcp', 'elsewhere', 'local-db']) assert.ok(!u(gone), `${gone} is in the user scope`);

  const p = (name) => byName(project.mcpServers, name);
  assert.deepStrictEqual(p('sentry'), { name: 'sentry', transport: 'http', scope: 'project', launcher: null, host: 'mcp.sentry.example', plugin: null });
  assert.deepStrictEqual(p('pg'), { name: 'pg', transport: 'stdio', scope: 'project', launcher: 'npx', host: null, plugin: null });
  assert.deepStrictEqual(p('local-db'), { name: 'local-db', transport: 'stdio', scope: 'local', launcher: 'docker', host: null, plugin: null });
  assert.ok(!p('elsewhere'), 'another project’s local server');
});

test('launcherOf and hostOf keep the base name and the host alone', () => {
  assert.strictEqual(setup.launcherOf('/opt/homebrew/bin/uvx'), 'uvx');
  assert.strictEqual(setup.launcherOf('C:\\tools\\npx.CMD'), 'npx');
  assert.strictEqual(setup.launcherOf('docker.exe'), 'docker');
  assert.strictEqual(setup.launcherOf('npx -y pkg --token=abc'), 'npx');
  assert.strictEqual(setup.launcherOf('API_KEY=abc npx'), null);
  assert.strictEqual(setup.launcherOf(42), null);
  assert.strictEqual(setup.hostOf('https://a:b@Host.Example.com:9000/p?q=1#f'), 'host.example.com');
  assert.strictEqual(setup.hostOf('not a url'), null);
  assert.strictEqual(setup.hostOf('http://[::1]:3000/x'), null);
});

test('plugins: installed and enabled, with versions; only enabled plugins bring agents, skills, commands and hooks', () => {
  const fx = fixture();
  const { user } = build(fx);
  assert.deepStrictEqual(user.plugins, [
    { id: 'ghost@nowhere', enabled: true, version: null },
    { id: 'off@acme', enabled: false, version: '0.1.0' },
    { id: 'ops@acme', enabled: true, version: '1.2.3' },
  ]);
  assert.deepStrictEqual(byName(user.agents, 'oncall'), { name: 'oncall', description: 'Handles pages', model: null, tools: ['Bash'], prompt: 'AGENT_PROMPT_BODY_FAKE', source: 'plugin', plugin: 'ops@acme' });
  assert.deepStrictEqual(byName(user.skills, 'rollback'), { name: 'rollback', description: 'Rolls back', source: 'plugin', plugin: 'ops@acme' });
  assert.deepStrictEqual(byName(user.commands, 'page'), { name: 'page', source: 'plugin', plugin: 'ops@acme' });
  const pluginHooks = user.hooks.filter((h) => h.source === 'plugin');
  assert.deepStrictEqual(pluginHooks, [
    { event: 'SessionStart', count: 2, source: 'plugin', plugin: 'ops@acme' },
    { event: 'Stop', count: 1, source: 'plugin', plugin: 'ops@acme' },
  ]);
  assert.ok(!byName(user.agents, 'disabled-agent'));
});

test('installed_plugins.json version 1 (one entry per id) is read too', () => {
  const fx = fixture();
  const file = path.join(fx.home, '.claude', 'plugins', 'installed_plugins.json');
  const v2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  write(file, { version: 1, plugins: { 'ops@acme': v2.plugins['ops@acme'][0] } });
  const { user } = build(fx);
  assert.deepStrictEqual(byName(user.plugins.map((p) => ({ ...p, name: p.id })), 'ops@acme').version, '1.2.3');
  assert.ok(byName(user.agents, 'oncall'));
});

test('agents, skills and commands: frontmatter only, tools as a string or a list, descriptions clamped', () => {
  const fx = fixture();
  const { user, project } = build(fx);
  assert.deepStrictEqual(byName(user.agents, 'reviewer'), {
    name: 'reviewer',
    description: 'Reviews diffs for bugs',
    model: 'sonnet',
    tools: ['Read', 'Grep', 'Bash'],
    prompt: 'AGENT_PROMPT_BODY_FAKE',
    source: 'user',
    plugin: null,
  });
  assert.deepStrictEqual(byName(user.agents, 'listy'), {
    name: 'listy',
    description: 'Line one line two',
    model: 'haiku',
    tools: ['Read', 'mcp__github__search'],
    prompt: 'AGENT_PROMPT_BODY_FAKE',
    source: 'user',
    plugin: null,
  });
  assert.deepStrictEqual(byName(user.agents, 'inline').tools, ['Read', 'Edit']);
  assert.deepStrictEqual(byName(user.agents, 'nofront'), { name: 'nofront', description: null, model: null, tools: null, prompt: 'AGENT_PROMPT_BODY_FAKE with no frontmatter', source: 'user', plugin: null });
  assert.ok(!user.agents.some((a) => a.name.startsWith('evil')), 'a name that is not one is dropped, not rewritten');

  const deploy = byName(user.skills, 'deploy');
  assert.strictEqual(deploy.description.length, setup.MAX_DESCRIPTION);
  assert.ok(!/[\u0000-\u001f]/.test(deploy.description));
  assert.ok(deploy.description.startsWith('Deploys the app with xxx'));
  assert.strictEqual(byName(user.skills, 'unnamed').description, 'Uses the folder name, key [redacted]');
  assert.ok(!byName(user.skills, 'empty-folder'));

  assert.deepStrictEqual(user.commands.filter((c) => c.source === 'user').map((c) => c.name), ['gsd:do', 'ship']);
  assert.deepStrictEqual(project.agents.map((a) => [a.name, a.source]), [['migrator', 'project']]);
  assert.deepStrictEqual(project.skills, [{ name: 'release', description: null, source: 'project', plugin: null }]);
  assert.deepStrictEqual(project.commands, [{ name: 'review-pr', source: 'project', plugin: null }]);
});

test('hooks: event and count per source, never the command', () => {
  const fx = fixture();
  const { user, project } = build(fx);
  assert.deepStrictEqual(user.hooks.filter((h) => h.source === 'user'), [
    { event: 'PostToolUse', count: 3, source: 'user', plugin: null },
    { event: 'SessionStart', count: 2, source: 'user', plugin: null },
  ]);
  assert.deepStrictEqual(project.hooks, [{ event: 'PreToolUse', count: 1, source: 'project', plugin: null }]);
});

test('CLAUDE.md is present and counted, never read out; workflows are counted', () => {
  const fx = fixture();
  const { user, project } = build(fx);
  assert.deepStrictEqual(user.claudeMd, { present: true, lines: 3 });
  assert.deepStrictEqual(project.claudeMd, { present: true, lines: 5 });
  assert.deepStrictEqual(project.workflows, { files: 2, claudeCodeAction: 1 });
  assert.strictEqual(project.repo, 'acme/widgets');
  fs.unlinkSync(path.join(fx.repo, 'CLAUDE.md'));
  fs.unlinkSync(path.join(fx.repo, '.claude', 'CLAUDE.md'));
  assert.strictEqual(build(fx).project.claudeMd, null);
});

test('no project outside a repository, or for a repo slug that is not one', () => {
  const fx = fixture();
  assert.ok(!('project' in build(fx, { root: '' })));
  assert.ok(!('project' in build(fx, { repo: '' })));
  assert.ok(!('project' in build(fx, { repo: 'https://user:tok3n-in-path-FAKE@git.example/acme/widgets' })));
});

test('finds the repository with git when no root is given', () => {
  const fx = fixture();
  try {
    execFileSync('git', ['init', '-q', fx.repo], { stdio: 'ignore' });
  } catch {
    return; // no git here; the explicit-root tests cover the rest
  }
  const s = setup.buildSnapshot({ home: fx.home, cwd: path.join(fx.repo, '.claude'), repo: 'acme/widgets', env: {}, machineId: 'm' });
  assert.deepStrictEqual(s.project.workflows, { files: 2, claudeCodeAction: 1 });
});

test('every list stops at 100 and is sorted, so the same setup hashes the same', () => {
  const fx = fixture();
  for (let i = 0; i < 130; i++) write(path.join(fx.home, '.claude', 'commands', `c${String(i).padStart(3, '0')}.md`), 'x');
  const servers = {};
  for (let i = 0; i < 120; i++) servers[`srv-${i}`] = { command: 'npx' };
  write(path.join(fx.repo, '.mcp.json'), { mcpServers: servers });
  const a = build(fx);
  assert.strictEqual(a.user.commands.length, setup.MAX_LIST);
  assert.strictEqual(a.project.mcpServers.length, setup.MAX_LIST);
  assert.strictEqual(setup.hashOf(a), setup.hashOf(build(fx)));
});

test('malformed and missing files are skipped, never fatal', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-setup-broken-'));
  const home = path.join(base, 'home');
  write(path.join(home, '.claude', 'settings.json'), '{ "model": ');
  write(path.join(home, '.claude.json'), 'not json at all');
  write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), '[1,2');
  write(path.join(home, '.claude', 'agents', 'ok.md'), md('name: ok', 'x'));
  const s = setup.buildSnapshot({ home, cwd: base, root: '', env: {}, machineId: 'm' });
  assert.deepStrictEqual(s.user.mcpServers, []);
  assert.deepStrictEqual(s.user.plugins, []);
  assert.deepStrictEqual(s.user.agents.map((a) => a.name), ['ok']);
  assert.strictEqual(s.user.settings.model, null);
  // An empty home is fine too.
  const empty = setup.buildSnapshot({ home: path.join(base, 'nobody'), cwd: base, root: '', env: {}, machineId: 'm' });
  assert.strictEqual(empty.user.claudeMd, null);
});

test('the name pattern is the server’s, and descriptions are masked like report titles', () => {
  assert.strictEqual(setup.FACET_NAME_RE.source, '^[A-Za-z0-9][\\w.:@/-]{0,63}$');
  assert.strictEqual(setup.SECRET_RE.source, SECRET_RE.source);
  assert.strictEqual(setup.cleanDescription('a\u0000b\nc'), 'a b c');
  assert.strictEqual(setup.cleanDescription('   '), null);
  assert.deepStrictEqual(setup.cleanTools('Read, Bash(git:*), *, '), ['Read', 'Bash']);
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const ok = { status: 200, body: JSON.stringify({ status: 200, result: { tracked: true } }) };

function sender(answer = ok) {
  const calls = [];
  const send = async (route, body) => {
    calls.push({ route, body });
    return typeof answer === 'function' ? answer() : answer;
  };
  return { calls, send };
}

const sendWith = (fx, extra) =>
  setup.maybeSendSetup({ home: fx.home, cwd: fx.repo, root: fx.repo, repo: 'acme/widgets', env: {}, pluginVersion: '0.13.0', ...extra });

test('the machine id is a UUID v4 kept in ~/.pravex/machine-id, 0600, and reused', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-home-'));
  const id = setup.machineId(home);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const file = path.join(home, '.pravex', 'machine-id');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(setup.machineId(home), id);
  fs.writeFileSync(file, 'garbage');
  assert.notStrictEqual(setup.machineId(home), 'garbage');
});

test('sends once, then only when the setup changes or 24 h have passed', async () => {
  const fx = fixture();
  const { calls, send } = sender();
  const t0 = Date.UTC(2026, 10, 17);
  assert.deepStrictEqual(await sendWith(fx, { send, now: t0 }), { sent: true, accepted: true, reason: 'ok' });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].route, '/api/claude-setup/snapshot');
  assert.match(calls[0].body.machineId, /^[0-9a-f-]{36}$/);

  const sent = JSON.parse(fs.readFileSync(path.join(fx.home, '.pravex', 'setup-sent.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(sent), [`${calls[0].body.machineId}|acme/widgets`]);
  assert.strictEqual(sent[Object.keys(sent)[0]].hash, setup.hashOf(calls[0].body));

  assert.strictEqual((await sendWith(fx, { send, now: t0 + 60_000 })).reason, 'unchanged');
  assert.strictEqual(calls.length, 1);

  write(path.join(fx.home, '.claude', 'commands', 'new-one.md'), 'x');
  assert.strictEqual((await sendWith(fx, { send, now: t0 + 120_000 })).reason, 'ok');
  assert.strictEqual(calls.length, 2);

  assert.strictEqual((await sendWith(fx, { send, now: t0 + 120_000 + setup.RESEND_AFTER_MS - 1 })).reason, 'unchanged');
  assert.strictEqual((await sendWith(fx, { send, now: t0 + 120_000 + setup.RESEND_AFTER_MS })).reason, 'ok');
  assert.strictEqual(calls.length, 3);

  // Another repository on the same machine is its own entry.
  assert.strictEqual((await sendWith(fx, { send, now: t0 + 1, repo: 'acme/other' })).reason, 'ok');
  assert.strictEqual(calls.length, 4);
});

test('a snapshot the server did not accept is sent again next time', async () => {
  const fx = fixture();
  const declined = sender({ status: 200, body: JSON.stringify({ status: 200, result: { tracked: false } }) });
  assert.strictEqual((await sendWith(fx, { send: declined.send })).accepted, false);
  const failed = sender({ status: 500, body: '{}' });
  assert.strictEqual((await sendWith(fx, { send: failed.send })).accepted, false);
  const thrown = sender(() => {
    throw new Error('ECONNREFUSED');
  });
  assert.match((await sendWith(fx, { send: thrown.send })).reason, /^error/);
  const good = sender();
  assert.strictEqual((await sendWith(fx, { send: good.send })).reason, 'ok');
  // A bare { tracked: true } (no envelope) counts as accepted too.
  const fx2 = fixture();
  const bare = sender({ status: 201, body: '{"tracked":true}' });
  await sendWith(fx2, { send: bare.send });
  assert.strictEqual((await sendWith(fx2, { send: bare.send })).reason, 'unchanged');
});

test('skipped when incognito, without a seat, or with PRAVEX_SETUP=0 — before reading anything', async () => {
  const fx = fixture();
  const { calls, send } = sender();
  assert.deepStrictEqual(await sendWith(fx, { send, incognito: true }), { sent: false, reason: 'incognito' });
  assert.deepStrictEqual(await sendWith(fx, { send, seat: false }), { sent: false, reason: 'no-seat' });
  assert.deepStrictEqual(await sendWith(fx, { send, env: { PRAVEX_SETUP: '0' } }), { sent: false, reason: 'disabled' });
  assert.strictEqual(calls.length, 0);
  assert.ok(!fs.existsSync(path.join(fx.home, '.pravex', 'machine-id')), 'a skipped start created a machine id');
  assert.strictEqual((await sendWith(fx, { send, env: { PRAVEX_SETUP: '1' } })).reason, 'ok');
});

test('never waits past its cap for a server that does not answer', async () => {
  const fx = fixture();
  const started = Date.now();
  // The cap's timer is unref'd so a real hook can exit; with a send that never settles, nothing else would keep this
  // test's event loop alive (Node 22 then cancels the test), so hold it open for the test's duration.
  const keepAlive = setInterval(() => {}, 1000);
  const r = await sendWith(fx, { send: () => new Promise(() => {}), timeoutMs: 150 }).finally(() => clearInterval(keepAlive));
  assert.deepStrictEqual(r, { sent: false, reason: 'timeout' });
  assert.ok(Date.now() - started < 1000);
  assert.strictEqual(setup.SEND_TIMEOUT_MS, 2000);
});

test('the real start hook sends the snapshot once with a seat, and not again unchanged', async () => {
  const { captureServer, envFor, runHook, tempHome } = require('./test-support.js');
  const cap = captureServer({ seat: { status: 'active', workspace: { id: 'o', name: 'Northwind' }, message: null } });
  const port = await cap.listen();
  const home = tempHome();
  write(path.join(home, '.claude.json'), { mcpServers: { github: { command: 'npx', env: { TOKEN: 'sk-live-FAKE0000secretAAAA1111' } } } });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-cwd-'));
  try {
    const input = { session_id: 's-1', transcript_path: path.join(cwd, 'none.jsonl'), cwd, source: 'startup' };
    const first = await runHook(input, envFor(home, port), ['--start']);
    assert.strictEqual(first.code, 0);
    assert.strictEqual(cap.setupBodies.length, 1);
    const body = cap.setupBodies[0];
    assert.deepStrictEqual(body.user.mcpServers, [{ name: 'github', transport: 'stdio', scope: 'user', launcher: 'npx', host: null, plugin: null }]);
    assert.ok(!JSON.stringify(body).includes('sk-live'));
    assert.ok(!('project' in body), 'a directory outside a repository has no project');
    // The start line went out regardless.
    assert.match(first.stdout, /recording this session/);

    await runHook({ ...input, session_id: 's-2' }, envFor(home, port), ['--start']);
    assert.strictEqual(cap.setupBodies.length, 1, 'an unchanged setup is not sent twice');

    const off = { ...envFor(home, port), PRAVEX_SETUP: '0' };
    fs.unlinkSync(path.join(home, '.pravex', 'setup-sent.json'));
    await runHook({ ...input, session_id: 's-3' }, off, ['--start']);
    assert.strictEqual(cap.setupBodies.length, 1, 'PRAVEX_SETUP=0 sends nothing');
  } finally {
    cap.close();
  }
});

test('the real start hook sends no snapshot without a seat', async () => {
  const { captureServer, envFor, runHook, tempHome } = require('./test-support.js');
  const cap = captureServer({ seat: { status: 'none', workspace: { id: 'o', name: 'Northwind' }, message: null } });
  const port = await cap.listen();
  const home = tempHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-cwd-'));
  try {
    const { code } = await runHook({ session_id: 's-1', transcript_path: path.join(cwd, 'x.jsonl'), cwd, source: 'startup' }, envFor(home, port), ['--start']);
    assert.strictEqual(code, 0);
    assert.strictEqual(cap.seatRequests.length, 1);
    assert.deepStrictEqual(cap.setupBodies, []);
  } finally {
    cap.close();
  }
});
