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
