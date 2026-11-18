'use strict';
/**
 * What a flow needs to know about this machine before it runs here (pravex-backend plan 0011):
 * the folders Claude Code and Claude Desktop can reach, the environments the developer is connected
 * to, what the permission rules let Claude do, the plan usage and the flow runner's state.
 *
 * **Names and states, never secrets.** Pravex makes no connection of its own: everything here is
 * read from the tools' own config files on this machine, and only names come out of them. A token
 * file is checked for existence or for the *keys* it has (a host, a profile name), never read into
 * the result. The permission rules stay here too: only whether a fixed capability is allowed,
 * asked or denied leaves the machine.
 *
 * Standard library only, like everything else in this plugin. Every read is its own try.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_DIRS = 100;
const MAX_PATH = 300;
/** Agent prompt limits: per agent, and for the whole snapshot. */
const MAX_PROMPT = 6000;
const MAX_PROMPTS_TOTAL = 250000;
const PROMPT_BYTES = 64 * 1024;
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,62}\.)*[a-z0-9-]{1,63}(:\d{1,5})?$/i;
const NAME_RE = /^[A-Za-z0-9][\w.@:/-]{0,63}$/;
const REPO_RE = /^[A-Za-z0-9][\w.-]{0,99}\/[A-Za-z0-9][\w.-]{0,99}$/;
/** Same as `SECRET_RE` in report-session.js. */
const SECRET_RE = /\b(?:[A-Za-z0-9]{2,10}[_-])?(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file, max = 256 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* closed */
      }
    }
  }
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `~/code/app` for a folder under the home directory; null for anything that is not an absolute path. */
function homeRel(raw, home) {
  if (typeof raw !== 'string') return null;
  let p = raw.replace(CONTROL_RE, '').trim();
  if (p.startsWith('~')) p = path.join(home, p.slice(1));
  if (!path.isAbsolute(p)) return null;
  p = path.normalize(p).replace(/[\\/]+$/, '') || path.sep;
  const h = path.normalize(home).replace(/[\\/]+$/, '');
  let out = p;
  if (p === h) out = '~';
  else if (p.startsWith(h + path.sep)) out = `~/${p.slice(h.length + 1).split(path.sep).join('/')}`;
  return out.length <= MAX_PATH ? out : null;
}

/** Back from `~/x` to an absolute path, for the runner. */
function expandHome(rel, home = os.homedir()) {
  if (rel === '~') return home;
  if (typeof rel === 'string' && rel.startsWith('~/')) return path.join(home, ...rel.slice(2).split('/'));
  return rel;
}

/** `owner/name` from a git remote URL (https or ssh), or null. Credentials in the URL never come out. */
function repoFromRemote(url) {
  if (typeof url !== 'string') return null;
  const m = /(?:[:/])([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m) return null;
  const slug = `${m[1]}/${m[2]}`;
  return REPO_RE.test(slug) ? slug : null;
}

/** The `origin` remote's `owner/name` of a working copy, read from `.git/config` (no git process). */
function repoOf(dir) {
  let gitDir = path.join(dir, '.git');
  try {
    if (fs.statSync(gitDir).isFile()) {
      // A worktree or submodule: `.git` points at the real git directory.
      const m = /gitdir:\s*(.+)/.exec(readText(gitDir, 4096) || '');
      if (!m) return null;
      gitDir = path.resolve(dir, m[1].trim());
      const common = readText(path.join(gitDir, 'commondir'), 1024);
      if (common) gitDir = path.resolve(gitDir, common.trim());
    }
  } catch {
    return null;
  }
  const config = readText(path.join(gitDir, 'config'), 64 * 1024);
  if (!config) return null;
  const block = /\[remote "origin"\]([\s\S]*?)(?:\n\[|$)/.exec(config);
  const url = block && /\burl\s*=\s*(.+)/.exec(block[1]);
  return url ? repoFromRemote(url[1]) : null;
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

function claudeDesktopDir(home, platform = process.platform, env = process.env) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude');
}

/**
 * The folders Claude can work in on this machine, newest first:
 * - `project`: every folder Claude Code was opened in (`~/.claude.json`), with its repository;
 * - `additional`: `permissions.additionalDirectories` in user and project settings;
 * - `desktop`: Claude Desktop's own folder and the folders its filesystem server may read.
 */
function directoriesOf({ home = os.homedir(), claudeJson, settingsFiles = [], platform = process.platform, env = process.env } = {}) {
  const out = [];
  const seen = new Set();
  const add = (raw, kind, extra = {}) => {
    const rel = homeRel(raw, home);
    if (!rel || seen.has(`${kind}|${rel}`)) return;
    seen.add(`${kind}|${rel}`);
    const abs = expandHome(rel, home);
    const present = isDir(abs);
    out.push({ path: rel, kind, exists: present, repo: present ? repoOf(abs) : null, ...extra });
  };

  const projects = isObject(claudeJson) && isObject(claudeJson.projects) ? claudeJson.projects : {};
  const recent = Object.entries(projects)
    .map(([dir, p]) => ({ dir, at: isObject(p) && typeof p.lastSessionModified === 'number' ? p.lastSessionModified : 0, trusted: isObject(p) && p.hasTrustDialogAccepted === true }))
    .sort((a, b) => b.at - a.at);
  for (const p of recent) add(p.dir, 'project', { lastUsedAt: p.at || null, trusted: p.trusted });

  for (const f of settingsFiles) {
    const dirs = isObject(f) && isObject(f.permissions) ? f.permissions.additionalDirectories : null;
    if (Array.isArray(dirs)) for (const d of dirs) add(d, 'additional');
  }

  const desktop = readJson(path.join(claudeDesktopDir(home, platform, env), 'claude_desktop_config.json'));
  if (isObject(desktop)) {
    if (typeof desktop.coworkUserFilesPath === 'string') add(desktop.coworkUserFilesPath, 'desktop');
    const servers = isObject(desktop.mcpServers) ? desktop.mcpServers : {};
    for (const config of Object.values(servers)) {
      // Only arguments that are existing folders: never a token, a flag or a file.
      const args = isObject(config) && Array.isArray(config.args) ? config.args : [];
      for (const a of args) if (typeof a === 'string' && path.isAbsolute(a.replace(/^~/, home)) && isDir(a.replace(/^~/, home))) add(a, 'desktop');
    }
  }
  return out.slice(0, MAX_DIRS);
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

const CLIS = ['git', 'gh', 'glab', 'aws', 'gcloud', 'az', 'kubectl', 'docker', 'vercel', 'supabase', 'npm', 'pnpm', 'claude'];

/** The CLIs on the `PATH`, by looking for the files (nothing is run). */
function installedClis(env = process.env, platform = process.platform) {
  const dirs = String(env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean);
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  return CLIS.filter((cli) => dirs.some((d) => exts.some((e) => exists(path.join(d, cli + e)))));
}

/** Top-level YAML keys that look like hosts (`github.com:`), and the `user:` under the first one. */
function yamlHosts(text) {
  const hosts = [];
  let user = null;
  if (typeof text !== 'string') return { hosts, user };
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const top = /^([A-Za-z0-9.-]+):\s*$/.exec(line);
    if (top) {
      current = top[1].toLowerCase();
      if (HOST_RE.test(current) && current.includes('.')) hosts.push(current);
      continue;
    }
    const u = /^\s+user:\s*["']?([A-Za-z0-9][\w-]{0,38})["']?\s*$/.exec(line);
    if (u && current && hosts[0] === current && !user) user = u[1];
  }
  return { hosts, user };
}

function iniSections(text) {
  if (typeof text !== 'string') return [];
  return [...text.matchAll(/^\s*\[([^\]\r\n]{1,80})\]\s*$/gm)].map((m) => m[1].replace(/^profile\s+/, '').trim());
}

/**
 * One entry per environment a flow may need: `connected` (signed in), `configured` (set up, sign-in
 * not provable from files), `installed` (the CLI is there, not set up) or `missing`.
 */
function connectionsOf({ home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const clis = installedClis(env, platform);
  const has = (cli) => clis.includes(cli);
  const out = [];
  const push = (id, status, extra = {}) => out.push({ id, status, ...extra });

  // GitHub: gh's hosts file (account name only), a token in the environment, or an SSH key GitHub knows.
  const ghDir = env.GH_CONFIG_DIR || (platform === 'win32' && env.APPDATA ? path.join(env.APPDATA, 'GitHub CLI') : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'gh'));
  const gh = yamlHosts(readText(path.join(ghDir, 'hosts.yml'), 64 * 1024));
  const sshKeys = (() => {
    try {
      return fs.readdirSync(path.join(home, '.ssh')).filter((f) => /^id_[a-z0-9]+$/.test(f)).length;
    } catch {
      return 0;
    }
  })();
  const knowsGithub = /(^|[\s,])github\.com[\s,]/m.test(readText(path.join(home, '.ssh', 'known_hosts'), 512 * 1024) || '');
  if (gh.hosts.includes('github.com')) push('github', 'connected', { method: 'gh', account: gh.user, hosts: gh.hosts.slice(0, 5) });
  else if (env.GH_TOKEN || env.GITHUB_TOKEN) push('github', 'connected', { method: 'token' });
  else if (sshKeys && knowsGithub) push('github', 'configured', { method: 'ssh' });
  else push('github', has('gh') ? 'installed' : 'missing');

  const glab = yamlHosts(readText(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'glab-cli', 'config.yml'), 64 * 1024));
  if (glab.hosts.length) push('gitlab', 'connected', { method: 'glab', hosts: glab.hosts.slice(0, 5) });
  else if (has('glab')) push('gitlab', 'installed');

  const awsProfiles = new Set([...iniSections(readText(path.join(home, '.aws', 'config'))), ...iniSections(readText(path.join(home, '.aws', 'credentials')))]);
  if (awsProfiles.size || env.AWS_PROFILE || env.AWS_ACCESS_KEY_ID) push('aws', 'configured', { count: awsProfiles.size });
  else if (has('aws')) push('aws', 'installed');

  const gcloudDir = env.CLOUDSDK_CONFIG || (platform === 'win32' && env.APPDATA ? path.join(env.APPDATA, 'gcloud') : path.join(home, '.config', 'gcloud'));
  if (exists(path.join(gcloudDir, 'credentials.db')) || exists(path.join(gcloudDir, 'application_default_credentials.json'))) push('gcloud', 'connected');
  else if (exists(path.join(gcloudDir, 'configurations'))) push('gcloud', 'configured');
  else if (has('gcloud')) push('gcloud', 'installed');

  const azure = readJson(path.join(home, '.azure', 'azureProfile.json'));
  const subs = isObject(azure) && Array.isArray(azure.subscriptions) ? azure.subscriptions.length : 0;
  if (subs) push('azure', 'connected', { count: subs });
  else if (has('az')) push('azure', 'installed');

  const kube = readText(env.KUBECONFIG ? env.KUBECONFIG.split(path.delimiter)[0] : path.join(home, '.kube', 'config'));
  if (kube) {
    const contexts = (kube.match(/^\s*-\s*context:/gm) || []).length;
    const current = /^current-context:\s*["']?([^"'\s]+)/m.exec(kube);
    const name = current && NAME_RE.test(current[1]) ? current[1] : null;
    push('kubernetes', contexts ? 'configured' : 'installed', { count: contexts, current: name });
  } else if (has('kubectl')) push('kubernetes', 'installed');

  const docker = readJson(path.join(home, '.docker', 'config.json'));
  const registries = isObject(docker) && isObject(docker.auths) ? Object.keys(docker.auths).map((h) => h.replace(/^https?:\/\//, '').split('/')[0].toLowerCase()).filter((h) => HOST_RE.test(h)) : [];
  if (registries.length) push('docker', 'connected', { hosts: registries.slice(0, 5) });
  else if (has('docker')) push('docker', 'installed');

  const vercelAuth = [path.join(home, 'Library', 'Application Support', 'com.vercel.cli', 'auth.json'), path.join(home, '.local', 'share', 'com.vercel.cli', 'auth.json'), path.join(env.APPDATA || home, 'com.vercel.cli', 'Data', 'auth.json')];
  if (vercelAuth.some(exists)) push('vercel', 'connected');
  else if (has('vercel')) push('vercel', 'installed');

  if (exists(path.join(home, '.supabase', 'access-token')) || env.SUPABASE_ACCESS_TOKEN) push('supabase', 'connected');
  else if (has('supabase')) push('supabase', 'installed');

  const npmrc = readText(path.join(home, '.npmrc'), 64 * 1024) || '';
  if (/_authToken\s*=/.test(npmrc)) push('npm', 'connected');
  else if (has('npm')) push('npm', 'installed');

  return { connections: out, clis };
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** What a flow step may need, and the permission rule that grants it. `command` prefixes are for Bash. */
const CAPABILITIES = {
  edit: { tools: ['Edit', 'MultiEdit'] },
  write: { tools: ['Write'] },
  bash: { tools: ['Bash'] },
  'git-push': { tools: ['Bash'], commands: ['git push'] },
  'gh-pr': { tools: ['Bash'], commands: ['gh pr create', 'gh pr comment'] },
  'run-tests': { tools: ['Bash'], commands: ['npm test', 'npm run test', 'pnpm test', 'yarn test', 'npx jest', 'npx vitest', 'pytest', 'go test', 'cargo test'] },
  'web-fetch': { tools: ['WebFetch'] },
};

/** `Bash(git push:*)` → { tool: 'Bash', content: 'git push:*' }. */
function parseRule(rule) {
  const m = /^([A-Za-z_][\w-]*)(?:\((.*)\))?$/s.exec(String(rule).trim());
  return m ? { tool: m[1], content: m[2] === undefined ? null : m[2] } : null;
}

/** Whether a rule covers this capability. A bare tool covers all of it; a Bash rule covers a command it is a prefix of. */
function ruleCovers(rule, cap) {
  const r = parseRule(rule);
  if (!r || !cap.tools.includes(r.tool)) return false;
  if (r.content === null || r.content === '*' || r.content === '') return true;
  if (!cap.commands) return r.tool !== 'Bash';
  const prefix = r.content.replace(/:\*$/, '').replace(/\s*\*$/, '').trim();
  return cap.commands.some((c) => c === prefix || c.startsWith(`${prefix} `) || (r.content.endsWith('*') && c.startsWith(prefix)));
}

/**
 * `{ capability: 'allow' | 'ask' | 'deny' }` from the rules of settings files and `~/.claude.json`'s
 * per-project `allowedTools`. Deny wins, then allow (or a default mode that allows it), else Claude
 * asks. A headless run passes its own `--allowedTools`, so for the runner only `deny` blocks.
 */
function capabilitiesOf({ settingsFiles = [], projectAllowed = [] } = {}) {
  const rules = (kind) => settingsFiles.flatMap((f) => (isObject(f) && isObject(f.permissions) && Array.isArray(f.permissions[kind]) ? f.permissions[kind] : [])).filter((r) => typeof r === 'string');
  const allow = [...rules('allow'), ...projectAllowed.filter((r) => typeof r === 'string')];
  const deny = rules('deny');
  let mode = null;
  for (const f of settingsFiles) if (isObject(f) && isObject(f.permissions) && typeof f.permissions.defaultMode === 'string') mode = f.permissions.defaultMode;
  const out = {};
  for (const [name, cap] of Object.entries(CAPABILITIES)) {
    if (deny.some((r) => ruleCovers(r, cap))) out[name] = 'deny';
    else if (mode === 'bypassPermissions' || allow.some((r) => ruleCovers(r, cap))) out[name] = 'allow';
    else if (mode === 'acceptEdits' && (name === 'edit' || name === 'write')) out[name] = 'allow';
    else out[name] = 'ask';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Agent prompts, plan usage, runner
// ---------------------------------------------------------------------------

/** Key-shaped strings people paste into prompts. Same list as the server's `maskSecrets` (claude-setup.types.ts). */
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted]'],
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, '[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[redacted]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, '$1 [redacted]'],
  [/\b((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)["']?[^\s"']{6,}/gi, '$1[redacted]'],
  [SECRET_RE, '[redacted]'],
];

function maskSecrets(text) {
  return SECRET_PATTERNS.reduce((t, [re, to]) => t.replace(re, to), String(text));
}

/** The body of an agent file after its frontmatter: masked, trimmed, capped. Null when empty. */
function agentPrompt(file) {
  const text = readText(file, PROMPT_BYTES);
  if (typeof text !== 'string') return null;
  const body = text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
  const clean = maskSecrets(body.replace(CONTROL_RE, '')).replace(/\n{3,}/g, '\n\n').trim();
  return clean ? clean.slice(0, MAX_PROMPT) : null;
}

/** Drops prompts past the snapshot's total, in the order given, and says so on the agent. */
function capPrompts(agents, budget = MAX_PROMPTS_TOTAL) {
  let used = 0;
  for (const a of agents) {
    if (typeof a.prompt !== 'string') continue;
    if (used + a.prompt.length > budget) {
      a.prompt = null;
      a.promptOmitted = true;
    } else used += a.prompt.length;
  }
  return agents;
}

const pravexDir = (home) => path.join(home, '.pravex');

/** What the status line last saw (`~/.pravex/plan-usage.json`), or null. */
function readPlanUsage(home = os.homedir()) {
  const json = readJson(path.join(pravexDir(home), 'plan-usage.json'));
  if (!isObject(json) || typeof json.at !== 'number') return null;
  const win = (w) => (isObject(w) && typeof w.pct === 'number' ? { pct: w.pct, resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null } : null);
  return { fiveHour: win(json.fiveHour), sevenDay: win(json.sevenDay), at: json.at };
}

/** The flow runner's state (`~/.pravex/runner.json`, written by `flow-runner.js`), or `{ installed: false }`. */
function readRunnerState(home = os.homedir()) {
  const json = readJson(path.join(pravexDir(home), 'runner.json'));
  if (!isObject(json) || json.installed !== true) return { installed: false };
  return {
    installed: true,
    scheduler: typeof json.scheduler === 'string' ? json.scheduler : null,
    version: typeof json.version === 'string' ? json.version : null,
    lastTickAt: typeof json.lastTickAt === 'number' ? json.lastTickAt : null,
  };
}

module.exports = {
  CAPABILITIES,
  MAX_PROMPT,
  MAX_PROMPTS_TOTAL,
  agentPrompt,
  capabilitiesOf,
  capPrompts,
  claudeDesktopDir,
  connectionsOf,
  directoriesOf,
  expandHome,
  maskSecrets,
  homeRel,
  installedClis,
  parseRule,
  readPlanUsage,
  readRunnerState,
  repoFromRemote,
  repoOf,
  ruleCovers,
  yamlHosts,
};
