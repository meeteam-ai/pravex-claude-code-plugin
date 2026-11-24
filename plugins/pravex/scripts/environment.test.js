'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const env = require('./environment');

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pravex-env-'));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

test('homeRel writes folders under home as ~ and refuses relative paths', () => {
  const home = '/Users/ada';
  assert.equal(env.homeRel('/Users/ada/code/app/', home), '~/code/app');
  assert.equal(env.homeRel('/Users/ada', home), '~');
  assert.equal(env.homeRel('~/x', home), '~/x');
  assert.equal(env.homeRel('/srv/data', home), '/srv/data');
  assert.equal(env.homeRel('relative/dir', home), null);
  assert.equal(env.homeRel(42, home), null);
});

test('repoFromRemote keeps owner/name and never the credentials', () => {
  assert.equal(env.repoFromRemote('git@github.com:meeteam-ai/pravex-backend.git'), 'meeteam-ai/pravex-backend');
  assert.equal(env.repoFromRemote('https://x-access-token:ghp_secret@github.com/meeteam-ai/app'), 'meeteam-ai/app');
  assert.equal(env.repoFromRemote('not a url'), null);
});

test('directoriesOf lists projects newest first with their repository, extra and desktop folders', () => {
  const home = tempHome();
  const app = path.join(home, 'code', 'app');
  write(path.join(app, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/app.git\n');
  const shared = path.join(home, 'shared');
  fs.mkdirSync(shared);
  const desktopFolder = path.join(home, 'Docs');
  fs.mkdirSync(desktopFolder);
  write(path.join(env.claudeDesktopDir(home, 'linux', {}), 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', 'server-filesystem', desktopFolder, '--token=abc'] } } }));
  const claudeJson = { projects: { [path.join(home, 'old')]: { lastSessionModified: 1 }, [app]: { lastSessionModified: 5, hasTrustDialogAccepted: true } } };
  const dirs = env.directoriesOf({ home, claudeJson, settingsFiles: [{ permissions: { additionalDirectories: [shared, 'relative'] } }], platform: 'linux', env: {} });
  assert.deepEqual(
    dirs.map((d) => [d.kind, d.path, d.exists, d.repo]),
    [
      ['project', '~/code/app', true, 'acme/app'],
      ['project', '~/old', false, null],
      ['additional', '~/shared', true, null],
      ['desktop', '~/Docs', true, null],
    ],
  );
});

test('connectionsOf reads names and states only', () => {
  const home = tempHome();
  write(path.join(home, '.config', 'gh', 'hosts.yml'), 'github.com:\n    oauth_token: gho_SECRETSECRETSECRET123\n    user: ada-l\n    git_protocol: ssh\n');
  write(path.join(home, '.aws', 'config'), '[default]\nregion = us-east-1\n[profile prod]\nregion = us-east-1\n');
  write(path.join(home, '.docker', 'config.json'), JSON.stringify({ auths: { 'https://ghcr.io': { auth: 'c2VjcmV0' } } }));
  write(path.join(home, '.kube', 'config'), 'contexts:\n- context:\n    cluster: a\n  name: staging\ncurrent-context: staging\n');
  const { connections } = env.connectionsOf({ home, env: { PATH: '' }, platform: 'linux' });
  const byId = Object.fromEntries(connections.map((c) => [c.id, c]));
  assert.deepEqual(byId.github, { id: 'github', status: 'connected', method: 'gh', account: 'ada-l', hosts: ['github.com'] });
  assert.equal(byId.aws.count, 2);
  assert.deepEqual(byId.docker.hosts, ['ghcr.io']);
  assert.equal(byId.kubernetes.current, 'staging');
  assert.ok(!JSON.stringify(connections).includes('SECRET'));
  assert.ok(!JSON.stringify(connections).includes('c2VjcmV0'));
});

test('connectionsOf says GitHub is missing when nothing is set up', () => {
  const { connections } = env.connectionsOf({ home: tempHome(), env: { PATH: '' }, platform: 'linux' });
  assert.deepEqual(connections, [{ id: 'github', status: 'missing' }]);
});

test('capabilitiesOf: deny wins, allow rules and modes allow, the rest asks', () => {
  const caps = env.capabilitiesOf({
    settingsFiles: [{ permissions: { allow: ['Edit', 'Bash(npm test:*)', 'Bash(gh pr create:*)'], deny: ['Bash(git push:*)'], defaultMode: 'default' } }],
    projectAllowed: ['WebFetch'],
  });
  assert.deepEqual(caps, { edit: 'allow', write: 'ask', bash: 'ask', 'git-push': 'deny', 'gh-pr': 'allow', 'run-tests': 'allow', 'web-fetch': 'allow' });
  const bypass = env.capabilitiesOf({ settingsFiles: [{ permissions: { defaultMode: 'bypassPermissions' } }] });
  assert.equal(bypass['git-push'], 'allow');
  const accept = env.capabilitiesOf({ settingsFiles: [{ permissions: { defaultMode: 'acceptEdits' } }] });
  assert.deepEqual([accept.edit, accept.write, accept.bash], ['allow', 'allow', 'ask']);
});

test('agentPrompt takes the body, masks keys and caps it; capPrompts keeps the total', () => {
  const home = tempHome();
  const file = path.join(home, 'agent.md');
  write(file, `---\nname: reviewer\n---\n\nReview the diff.\nUse key ${['sk', 'live', `${'Q'.repeat(24)}9`].join('_')} never.\n${'x'.repeat(9000)}`);
  const prompt = env.agentPrompt(file);
  assert.ok(prompt.startsWith('Review the diff.'));
  assert.ok(prompt.includes('[redacted]'));
  assert.equal(prompt.length, env.MAX_PROMPT);
  const agents = env.capPrompts([{ prompt: 'a'.repeat(6) }, { prompt: 'b'.repeat(6) }, { prompt: null }], 10);
  assert.deepEqual(agents.map((a) => [a.prompt && a.prompt.length, a.promptOmitted === true]), [[6, false], [null, true], [null, false]]);
});

test('readPlanUsage and readRunnerState read what the status line and runner wrote', () => {
  const home = tempHome();
  assert.equal(env.readPlanUsage(home), null);
  assert.deepEqual(env.readRunnerState(home), { installed: false });
  write(path.join(home, '.pravex', 'plan-usage.json'), JSON.stringify({ fiveHour: { pct: 42, resetsAt: 9 }, sevenDay: null, at: 100 }));
  write(path.join(home, '.pravex', 'runner.json'), JSON.stringify({ installed: true, scheduler: 'cron', version: '1', lastTickAt: 5, paths: { gh: '/x' } }));
  assert.deepEqual(env.readPlanUsage(home), { fiveHour: { pct: 42, resetsAt: 9 }, sevenDay: null, at: 100 });
  assert.deepEqual(env.readRunnerState(home), { installed: true, scheduler: 'cron', version: '1', lastTickAt: 5 });
});

test('the status line keeps the plan usage Claude Code gives it', () => {
  const statusline = require('./statusline');
  const file = path.join(tempHome(), '.pravex', 'plan-usage.json');
  assert.equal(statusline.planUsageOf({}), null);
  const session = { rate_limits: { five_hour: { used_percentage: 23.46, resets_at: 1800000000 }, seven_day: { used_percentage: 61 } } };
  assert.deepEqual(statusline.planUsageOf(session), { fiveHour: { pct: 23.5, resetsAt: 1800000000000 }, sevenDay: { pct: 61, resetsAt: null } });
  assert.equal(statusline.rememberPlanUsage(session, 1000, file), true);
  assert.equal(statusline.rememberPlanUsage(session, 2000, file), false, 'unchanged within a minute');
  assert.equal(statusline.rememberPlanUsage(session, 70000, file), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).at, 70000);
});

test('maskSecrets masks the keys people paste into prompts, same list as the server', () => {
  const masked = env.maskSecrets(`${'sk' + '-live-'}9f8e7d6c5b4a ${'ghp' + '_'}ABCDEFGHIJKLMNOP1234 password = hunter2hunter2 Bearer abc.def.ghi-jkl_mno`);
  for (const s of ['9f8e7d6c5b4a', 'ABCDEFGHIJKLMNOP1234', 'hunter2', 'abc.def.ghi']) assert.ok(!masked.includes(s), s);
  assert.equal(env.maskSecrets('Run npm test.'), 'Run npm test.');
});

// A repository's own check commands (plan 0013) -----------------------------

/** Modelled on a real repository: pnpm, Turbo, packages built with tsc into a dist that Turbo does not keep. */
function turboRepo(changes = {}) {
  const dir = tempHome();
  const files = {
    'package.json': { name: 'app', private: true, packageManager: 'pnpm@10.0.0', scripts: { lint: 'turbo run lint', 'check-types': 'turbo run check-types', 'db:seed': 'SECRET_BODY=1 node seed.js' } },
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'pnpm-workspace.yaml': "# the workspace\npackages:\n  - 'apps/*' # apps\n  - \"packages/*\"\n  - '!packages/old'\ncatalog:\n  - not/*\n",
    'turbo.json': '{\n  // comments, as Turbo allows\n  "$schema": "https://turborepo.com/schema.json", /* "x": 1 */\n  "tasks": {\n    "build": { "dependsOn": ["^build"], "outputs": [".next/**", "!.next/cache/**"] },\n    "lint": { "dependsOn": ["^lint"] },\n    "check-types": { "dependsOn": ["^build"] },\n    "test": { "dependsOn": ["^build"], },\n    "dev": { "cache": false },\n  },\n}\n',
    'apps/web/package.json': { name: '@app/web', scripts: { build: 'next build', test: 'vitest run', lint: 'eslint .' } },
    'packages/shared/package.json': { name: '@app/shared', main: 'dist/index.js', types: './dist/index.d.ts', scripts: { build: 'tsc -p tsconfig.json', test: 'jest', 'check-types': 'tsc --noEmit' } },
    'packages/old/package.json': { name: '@app/old', scripts: { build: 'tsc' }, main: 'dist/x.js' },
    'packages/node_modules/evil/package.json': { scripts: { test: 'x' } },
    ...changes,
  };
  for (const [f, v] of Object.entries(files)) if (v !== null) write(path.join(dir, f), typeof v === 'string' ? v : JSON.stringify(v));
  return dir;
}
const commandList = (dir) => env.commandsOf(dir).suggested.map((s) => s.command);

test('the commands of a pnpm and Turbo repository whose packages build into an uncached dist', () => {
  const found = env.commandsOf(turboRepo());
  assert.deepEqual(found, {
    manager: 'pnpm',
    scripts: ['lint', 'check-types', 'db:seed'],
    suggested: [
      { kind: 'lint', command: 'pnpm lint' },
      { kind: 'types', command: 'pnpm turbo run check-types --force' },
      { kind: 'test', command: 'pnpm turbo run test --concurrency=1 --force' },
    ],
  });
  for (const s of found.suggested) assert.match(s.command, env.PLAIN_COMMAND);
  assert.ok(!JSON.stringify(found).includes('SECRET'), 'names only, never bodies');
});

test('without the stale dist the plain forms are enough', () => {
  const turbo = (outputs) => JSON.stringify({ tasks: { build: { dependsOn: ['^build'], outputs }, 'check-types': { dependsOn: ['^build'] }, test: { dependsOn: ['^build'] }, lint: {} } });
  for (const outputs of [['.next/**', 'dist/**'], ['./dist/**'], ['**/dist/**'], ['{dist,build}/**'], ['**']]) {
    assert.deepEqual(commandList(turboRepo({ 'turbo.json': turbo(outputs) })), ['pnpm lint', 'pnpm check-types', 'pnpm turbo run test --concurrency=1'], outputs.join());
  }
  assert.match(commandList(turboRepo({ 'turbo.json': turbo(['!dist/**', 'distribution/**', 'build/**']) })).join(), /--force/);
  // The package itself says what its build leaves.
  assert.deepEqual(commandList(turboRepo({ 'packages/shared/turbo.json': '{"extends": ["//"], "tasks": {"build": {"outputs": ["dist/**"]}}}' })).filter((c) => c.includes('--force')), []);
  // Built with something else, or somewhere else.
  assert.ok(!commandList(turboRepo({ 'packages/shared/package.json': { name: 's', main: 'dist/i.js', scripts: { build: 'tsup', test: 'x', 'check-types': 'x' } } })).join().includes('--force'));
  assert.ok(!commandList(turboRepo({ 'packages/shared/package.json': { name: 's', main: 'src/i.ts', scripts: { build: 'tsc', test: 'x', 'check-types': 'x' } } })).join().includes('--force'));
});

test('a task that builds through another one counts, and a root script that is not just the task is kept', () => {
  const turbo = JSON.stringify({ tasks: { build: { dependsOn: ['^build'] }, test: { dependsOn: ['build'] }, 'check-types': { dependsOn: ['^check-types'] } } });
  assert.deepEqual(commandList(turboRepo({ 'turbo.json': turbo })), ['pnpm lint', 'pnpm check-types', 'pnpm turbo run test --concurrency=1 --force']);
  const root = (test) => ({ name: 'app', scripts: { test } });
  assert.deepEqual(commandList(turboRepo({ 'package.json': root('turbo run test --filter=@app/web') })).at(-1), 'pnpm test');
  assert.deepEqual(commandList(turboRepo({ 'package.json': root('vitest run') })).at(-1), 'pnpm test');
  assert.deepEqual(commandList(turboRepo({ 'package.json': root('turbo run test --ui=stream') })).at(-1), 'pnpm turbo run test --concurrency=1 --force');
});

test('each package manager runs its own scripts, and a build is proposed when the repository has one', () => {
  const repo = (lock, scripts, extra = {}) => {
    const dir = tempHome();
    write(path.join(dir, 'package.json'), JSON.stringify({ scripts, ...extra }));
    if (lock) write(path.join(dir, lock), '');
    return env.commandsOf(dir);
  };
  const all = { build: 'x', test: 'x', typecheck: 'x', lint: 'x' };
  assert.deepEqual(repo('package-lock.json', all).suggested.map((s) => s.command), ['npm run lint', 'npm run typecheck', 'npm test', 'npm run build']);
  assert.deepEqual(repo('yarn.lock', all).suggested.map((s) => s.command), ['yarn lint', 'yarn typecheck', 'yarn test', 'yarn build']);
  assert.deepEqual(repo('bun.lock', all).suggested.map((s) => s.command), ['bun run lint', 'bun run typecheck', 'bun run test', 'bun run build']);
  assert.equal(repo('bun.lockb', {}).manager, 'bun');
  assert.equal(repo(null, all, { packageManager: 'pnpm@9.1.0+sha512.x' }).manager, 'pnpm');
  assert.deepEqual(repo(null, all), { manager: null, scripts: ['build', 'test', 'typecheck', 'lint'], suggested: [] });
  assert.deepEqual(repo('package-lock.json', { test: 'echo "Error: no test specified" && exit 1' }).suggested, []);
  assert.deepEqual(repo('package-lock.json', { 'type-check': 'x' }).suggested, [{ kind: 'types', command: 'npm run type-check' }]);
  const npmTurbo = tempHome();
  write(path.join(npmTurbo, 'package.json'), JSON.stringify({ workspaces: { packages: ['packages/**'] } }));
  write(path.join(npmTurbo, 'package-lock.json'), '');
  write(path.join(npmTurbo, 'turbo.json'), '{"pipeline": {"test": {}, "build": {}}}');
  write(path.join(npmTurbo, 'packages', 'group', 'a', 'package.json'), '{"scripts": {"test": "x", "build": "x"}}');
  assert.deepEqual(commandList(npmTurbo), ['npx turbo run test --concurrency=1', 'npx turbo run build']);
});

test('broken, huge or hostile files cost nothing and leave nothing behind', () => {
  assert.equal(env.commandsOf(tempHome()), null);
  assert.equal(env.commandsOf(turboRepo({ 'package.json': '{ broken' })), null);
  assert.equal(env.commandsOf(turboRepo({ 'package.json': `{"scripts": {"a": "${'x'.repeat(300 * 1024)}"}}` })), null);
  assert.deepEqual(commandList(turboRepo({ 'turbo.json': '{ "tasks": ' })), ['pnpm lint', 'pnpm check-types']);
  assert.deepEqual(commandList(turboRepo({ 'pnpm-workspace.yaml': 'packages: [\'apps/*\', "packages/*"]\n' })).length, 3);
  assert.deepEqual(commandList(turboRepo({ 'pnpm-workspace.yaml': "packages:\n- '../*'\n- '/etc/*'\n- '*a*b*c*d*'\n" })), ['pnpm lint', 'pnpm check-types']);
  const dir = turboRepo({ 'package.json': { scripts: Object.fromEntries([...Array.from({ length: 90 }, (_, i) => [`z${i}`, 'x']), ['bad name; rm', 'x'], ['test', 'x'], ['__proto__', 'x']]) } });
  const { scripts } = env.commandsOf(dir);
  assert.equal(scripts.length, 60);
  assert.equal(scripts[0], 'test', 'the cap never drops a check');
  assert.ok(!scripts.includes('bad name; rm'));
  const many = turboRepo();
  for (let i = 0; i < 300; i += 1) write(path.join(many, 'packages', `p${i}`, 'package.json'), '{"scripts": {"test": "x"}}');
  const budget = { packages: 150 };
  assert.equal(env.commandsOf(many, budget).suggested.length, 3);
  assert.equal(budget.packages, 50, 'at most a hundred packages of one repository');
  const began = Date.now();
  env.parseJsonc('/*'.repeat(100000));
  env.parseJsonc('"\\'.repeat(100000));
  assert.ok(Date.now() - began < 2000);
  assert.deepEqual(env.parseJsonc('\ufeff{"a": "// not, a comment ,}", "b": [1, 2, /* x */ ], }'), { a: '// not, a comment ,}', b: [1, 2] });
});

test('a workspace folder that is a link out of the repository is not read', { skip: process.platform === 'win32' }, () => {
  const outside = tempHome();
  write(path.join(outside, 'package.json'), '{"scripts": {"test": "x"}}');
  const dir = turboRepo({ 'apps/web/package.json': null, 'packages/shared/package.json': null });
  fs.mkdirSync(path.join(dir, 'apps'), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, 'apps', 'linked'));
  assert.deepEqual(commandList(dir), ['pnpm lint', 'pnpm check-types']);
});

test('the folders say their commands when asked, and only then', () => {
  const home = tempHome();
  const app = path.join(home, 'app');
  write(path.join(app, 'package.json'), '{"scripts": {"lint": "x"}}');
  write(path.join(app, 'yarn.lock'), '');
  const claudeJson = { projects: { [app]: { lastSessionModified: 2 }, [path.join(home, 'gone')]: { lastSessionModified: 1 } } };
  const dirs = env.directoriesOf({ home, claudeJson, platform: 'linux', env: {}, commands: true });
  assert.deepEqual(dirs.map((d) => d.commands), [{ manager: 'yarn', scripts: ['lint'], suggested: [{ kind: 'lint', command: 'yarn lint' }] }, null]);
  assert.ok(!('commands' in env.directoriesOf({ home, claudeJson, platform: 'linux', env: {} })[0]));
});

// Claude Code's sign-in (plan 0013) -----------------------------------------

const AUTH_JSON = { loggedIn: true, authMethod: 'claude.ai', email: 'ada@acme.test', orgId: 'org-SECRET', orgName: 'Acme SECRET', subscriptionType: 'max', loginExpiresAt: '2026-12-01T10:00:00.000Z' };

test('the sign-in is two things: signed in, and until when', () => {
  assert.deepEqual(env.claudeAuthFrom(JSON.stringify(AUTH_JSON, null, 2)), { signedIn: true, expiresAt: '2026-12-01T10:00:00.000Z' });
  assert.deepEqual(env.claudeAuthFrom(`A notice first\n${JSON.stringify({ loggedIn: true, loginExpiresAt: null })}`), { signedIn: true, expiresAt: null });
  assert.deepEqual(env.claudeAuthFrom('{"loggedIn": false, "loginExpiresAt": "2026-12-01T10:00:00Z"}'), { signedIn: false, expiresAt: null });
  assert.deepEqual(env.claudeAuthFrom('{"loggedIn": true, "loginExpiresAt": "soon"}'), { signedIn: true, expiresAt: null });
  for (const bad of ['', 'Unknown command', '{"loggedIn": "yes"}', '[]']) assert.equal(env.claudeAuthFrom(bad), null);
});

test('the sign-in is kept without the account, and without an answer the last one stays for a day', { skip: process.platform === 'win32' }, async () => {
  const home = tempHome();
  const claude = path.join(home, 'claude');
  write(claude, `#!/bin/sh\n[ "$1 $2 $3" = "auth status --json" ] || exit 9\necho '${JSON.stringify(AUTH_JSON)}'\n`);
  fs.chmodSync(claude, 0o755);
  const now = Date.now();
  assert.deepEqual(env.claudeStatus(home, now), { signedIn: null, expiresAt: null });
  assert.deepEqual(await env.refreshClaudeAuth({ home, claude, env: { PATH: process.env.PATH }, now }), { signedIn: true, expiresAt: '2026-12-01T10:00:00.000Z' });
  const kept = fs.readFileSync(path.join(home, '.pravex', 'claude-auth.json'), 'utf8');
  assert.doesNotMatch(kept, /ada|acme|SECRET|max|claude\.ai/i);
  assert.deepEqual(await env.refreshClaudeAuth({ home, claude: null, now: now + 60000 }), { signedIn: true, expiresAt: '2026-12-01T10:00:00.000Z' });
  assert.equal(env.readClaudeAuth(home).triedAt, now + 60000);
  assert.deepEqual(env.claudeStatus(home, now + 25 * 3600000), { signedIn: null, expiresAt: null });
});

test('the question leaves out what only this session was handed', () => {
  assert.deepEqual(Object.keys(env.withoutSessionAuth({ PATH: 'x', HOME: 'h', CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 'a', CLAUDE_CONFIG_DIR: 'd' })), ['PATH', 'HOME', 'CLAUDE_CONFIG_DIR']);
});
