'use strict';
/**
 * The setup snapshot (PL-X03, pravex-backend ADR 0044): what this machine's Claude Code
 * has installed and configured, by **name**, for the workspace's X-ray.
 *
 * Sent from `report-session.js --start`, after the seat check, to
 * `PUT /api/claude-setup/snapshot`. Only when its hash changed, or 24 h after the last
 * snapshot the server accepted for this machine and repository. Never for an incognito
 * session, never without a seat, never with `PRAVEX_SETUP=0`. A failure is silent and the
 * whole thing is capped at two seconds.
 *
 * **Names and shapes, never values.** These files routinely hold secrets: MCP `env`,
 * `headers` and `args`, tokens in URLs, hook command lines, permission rules naming paths.
 * None of that is read into the snapshot. What is:
 *
 * - MCP servers: name, transport, scope, the launcher's base name (stdio) or the URL's
 *   host (http/sse);
 * - agents, skills, commands: the frontmatter `name`, the first 160 characters of its
 *   `description`, and for agents `model` and the tool names;
 * - permissions: counts of allow/ask/deny rules, the default mode, whether a deny rule
 *   covers secrets, whether the dangerous-mode prompt is skipped;
 * - hooks: event and count per source;
 * - `CLAUDE.md`: present, and how many lines;
 * - workflows: how many, and how many run `anthropics/claude-code-action`.
 *
 * Since version 2 (pravex-backend plan 0011, `environment.js`): the folders Claude can reach
 * (home as `~`), the environments the developer is connected to (names and states from the
 * tools' config files, never a token), whether the permission rules allow, ask or deny a fixed
 * list of capabilities (never the rules), and each agent's prompt, masked and capped.
 *
 * Every name must match the server's facet name pattern or the entry is dropped (never
 * rewritten), and every list stops at 100.
 *
 *   ~/.pravex/machine-id        a random UUID v4, created on first use (0600)
 *   ~/.pravex/setup-sent.json   { "<machineId>|<repo>": { hash, at } }: the last accepted snapshot
 *
 * Standard library only, like everything else in this plugin.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const envLib = require('./environment');

/** 2: folders, connections, capabilities and agent prompts (plan 0011). */
const SETUP_VERSION = 2;
const SETUP_ROUTE = '/api/claude-setup/snapshot';
/** The server's `FACET_NAME_RE`. An entry whose name does not match is dropped, not mangled. */
const FACET_NAME_RE = /^[A-Za-z0-9][\w.:@/-]{0,63}$/;
const MAX_LIST = 100;
const MAX_DESCRIPTION = 160;
/** Tools listed on one agent. More is not a setup anybody reads. */
const MAX_TOOLS = 50;
const RESEND_AFTER_MS = 24 * 60 * 60 * 1000;
/** The longest a session start keeps the hook alive for this. */
const SEND_TIMEOUT_MS = 2000;
/** Frontmatter sits at the top; a skill's body can be long and is never needed. */
const HEAD_BYTES = 16 * 1024;
/** Throttle entries older than this are forgotten. */
const SENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SENT_MAX_ENTRIES = 200;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Same as `SECRET_RE` in report-session.js: a description is free text, and free text gets pasted keys. */
const SECRET_RE = /\b(?:[A-Za-z0-9]{2,10}[_-])?(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g;
/** A deny rule that keeps Claude out of `.env` files, secrets or credentials. */
const SECRET_RULE_RE = /\.env|secret|credential/i;
/** A short setting value (model, effort, mode, version). Anything else is not one. */
const VALUE_RE = /^[\w.:@/[\]+-]{1,64}$/;
const HOST_RE = /^[a-z0-9.-]{1,253}$/;
/** `owner/name`, or a bare directory name for a repository without a remote. Never a URL. */
const REPO_RE = /^[^\s:@?#]{1,200}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const TRANSPORTS = ['stdio', 'http', 'sse'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validName = (n) => typeof n === 'string' && FACET_NAME_RE.test(n);

/** Parsed JSON, or null for a file that is missing, unreadable or broken. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The first `HEAD_BYTES` of a file, or null. */
function readHead(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
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

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
  } catch {
    return '';
  }
}

/** The repository `cwd` is in, or '' outside one. */
function gitRoot(cwd) {
  return cwd ? git(['rev-parse', '--show-toplevel'], cwd) : '';
}

function unquote(s) {
  const t = String(s).trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

const FRONTMATTER_KEYS = new Set(['name', 'description', 'model', 'tools']);

/**
 * `name`, `description`, `model` and `tools` from a Markdown file's YAML frontmatter, and
 * nothing else from the file. Enough YAML for what Claude Code writes: plain and quoted
 * scalars, `|`/`>` blocks, `[a, b]` and `- a` lists.
 */
function frontmatter(text) {
  const out = {};
  if (typeof text !== 'string') return out;
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const km = /^([A-Za-z_-]+):[ \t]*(.*)$/.exec(lines[i]);
    if (!km) continue;
    const key = km[1];
    const value = km[2].trim();
    const nested = [];
    while (i + 1 < lines.length && (/^[ \t]+\S/.test(lines[i + 1]) || /^-[ \t]/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
      nested.push(lines[++i].trim());
    }
    if (!FRONTMATTER_KEYS.has(key)) continue;
    const items = nested.filter(Boolean);
    if (value === '' && items.length && items.every((l) => l.startsWith('- '))) {
      out[key] = items.map((l) => unquote(l.slice(2)));
    } else if (value === '' || /^[|>][-+]?$/.test(value)) {
      out[key] = items.join(' ');
    } else if (value.startsWith('[') && value.endsWith(']')) {
      out[key] = value
        .slice(1, -1)
        .split(',')
        .map(unquote)
        .filter(Boolean);
    } else {
      out[key] = [unquote(value), ...items].join(' ');
    }
  }
  return out;
}

/** At most 160 characters, no control characters, key-shaped strings masked; null when empty. */
function cleanDescription(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(CONTROL_RE, ' ').replace(SECRET_RE, '[redacted]').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, MAX_DESCRIPTION) : null;
}

function cleanValue(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(CONTROL_RE, '').trim();
  return VALUE_RE.test(s) ? s : null;
}

/** Tool names only: `Bash(git push:*)` is a rule, and the rule is dropped with its argument. */
function cleanTools(raw) {
  let list;
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string') list = raw.split(',');
  else return null;
  const names = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const base = item.trim().replace(/\(.*$/s, '').trim();
    if (validName(base) && !names.includes(base)) names.push(base);
  }
  return names.slice(0, MAX_TOOLS);
}

/** Sorted, so the same setup always hashes the same, then capped. */
function capped(list, keyOf) {
  return list
    .map((item) => [keyOf(item), item])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, item]) => item)
    .slice(0, MAX_LIST);
}

const itemKey = (i) => `${i.source}\u0000${i.plugin || ''}\u0000${i.name || i.event || i.id}`;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function ruleList(settings, kind) {
  const p = settings && isObject(settings.permissions) ? settings.permissions[kind] : null;
  return Array.isArray(p) ? p.filter((r) => typeof r === 'string') : [];
}

/**
 * One scope's settings, from `settings.json` and `settings.local.json` together: the
 * local file wins on a value, and rules are counted once across both.
 */
function settingsSummary(files, projectAllowed = []) {
  const present = files.filter(isObject);
  const pick = (get) => {
    for (const f of [...present].reverse()) {
      const v = get(f);
      if (v !== undefined && v !== null) return v;
    }
    return null;
  };
  const rules = (kind) => new Set(present.flatMap((f) => ruleList(f, kind)));
  const deny = rules('deny');
  return {
    model: cleanValue(pick((f) => f.model)),
    effort: cleanValue(pick((f) => f.effortLevel)),
    defaultMode: cleanValue(pick((f) => (isObject(f.permissions) ? f.permissions.defaultMode : null))),
    allow: rules('allow').size,
    ask: rules('ask').size,
    deny: deny.size,
    denyCoversSecrets: [...deny].some((r) => SECRET_RULE_RE.test(r)),
    capabilities: envLib.capabilitiesOf({ settingsFiles: present, projectAllowed }),
    skipDangerousPrompt: present.some((f) => f.skipDangerousModePermissionPrompt === true),
    statusLine: present.some((f) => Boolean(f.statusLine)),
  };
}

/** `{ event: count }` from a `hooks` object: one per hook command, never the command. */
function hookCounts(hooks, into = {}) {
  if (!isObject(hooks)) return into;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!validName(event) || !Array.isArray(groups)) continue;
    let count = 0;
    for (const g of groups) {
      if (isObject(g) && Array.isArray(g.hooks)) count += g.hooks.length;
      else if (isObject(g)) count += 1;
    }
    if (count) into[event] = (into[event] || 0) + count;
  }
  return into;
}

function hookEntries(counts, source, plugin = null) {
  return Object.entries(counts).map(([event, count]) => ({ event, count, source, plugin }));
}

/** Plugin ids a settings file turns on or off. */
function enabledPluginsOf(files) {
  const out = {};
  for (const f of files) {
    if (!isObject(f) || !isObject(f.enabledPlugins)) continue;
    for (const [id, on] of Object.entries(f.enabledPlugins)) out[id] = on === true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

/**
 * `npx` out of `/usr/local/bin/npx`, `C:\\Program Files\\nodejs\\npx.cmd` or `npx -y pkg`;
 * null if it is not a plain name. Only the executable: anything after it is an argument.
 */
function launcherOf(command) {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim().replace(/^["']|["']$/g, '');
  const windows = /^(.*?\.(?:exe|cmd|bat))(?:\s|$)/i.exec(trimmed);
  let exe = windows ? windows[1] : trimmed.split(/\s+/)[0] || '';
  if (!windows && /\s/.test(trimmed)) {
    try {
      if (fs.statSync(trimmed).isFile()) exe = trimmed; // a path with a space in it
    } catch {
      /* `cmd args`, not a path */
    }
  }
  const base = exe.split(/[\\/]/).pop().replace(/\.(?:exe|cmd|bat)$/i, '');
  return validName(base) ? base : null;
}

/** The hostname alone: never the scheme's user info, port, path or query. */
function hostOf(url) {
  if (typeof url !== 'string') return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return HOST_RE.test(host) ? host : null;
  } catch {
    return null;
  }
}

function mcpEntry(name, config, scope, plugin = null) {
  if (!validName(name) || !isObject(config)) return null;
  const type = typeof config.type === 'string' ? config.type.toLowerCase() : '';
  let transport;
  if (TRANSPORTS.includes(type)) transport = type;
  else if (type === 'streamable-http' || type === 'streamablehttp') transport = 'http';
  else if (typeof config.command === 'string') transport = 'stdio';
  else if (typeof config.url === 'string') transport = 'http';
  else return null;
  return {
    name,
    transport,
    scope,
    launcher: transport === 'stdio' ? launcherOf(config.command) : null,
    host: transport === 'stdio' ? null : hostOf(config.url),
    plugin,
  };
}

function mcpEntries(servers, scope, plugin = null) {
  if (!isObject(servers)) return [];
  return Object.entries(servers)
    .map(([name, config]) => mcpEntry(name, config, scope, plugin))
    .filter(Boolean);
}

/** A `.mcp.json`: `{ mcpServers: {...} }`, or the servers themselves at the top. */
function mcpFile(file) {
  const json = readJson(file);
  if (!isObject(json)) return null;
  return isObject(json.mcpServers) ? json.mcpServers : json;
}

// ---------------------------------------------------------------------------
// Agents, skills, commands
// ---------------------------------------------------------------------------

function mdFiles(dir, depth = 2, prefix = []) {
  const out = [];
  for (const e of listDir(dir)) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth > 1) out.push(...mdFiles(full, depth - 1, [...prefix, e.name]));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push({ file: full, parts: [...prefix, e.name.slice(0, -3)] });
  }
  return out;
}

function agentsIn(dir, source, plugin = null) {
  const out = [];
  for (const { file, parts } of mdFiles(dir)) {
    const fm = frontmatter(readHead(file));
    const name = typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : parts[parts.length - 1];
    if (!validName(name)) continue;
    out.push({
      name,
      description: cleanDescription(fm.description),
      model: cleanValue(fm.model),
      tools: cleanTools(fm.tools),
      prompt: envLib.agentPrompt(file),
      source,
      plugin,
    });
  }
  return out;
}

function skillsIn(dir, source, plugin = null) {
  const out = [];
  for (const e of listDir(dir)) {
    if (!e.isDirectory()) continue;
    const text = readHead(path.join(dir, e.name, 'SKILL.md'));
    if (text === null) continue;
    const fm = frontmatter(text);
    const name = typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : e.name;
    if (!validName(name)) continue;
    out.push({ name, description: cleanDescription(fm.description), source, plugin });
  }
  return out;
}

/** A command's name is its path: `commands/gsd/do.md` is `gsd:do`, as Claude Code calls it. */
function commandsIn(dir, source, plugin = null) {
  return mdFiles(dir)
    .map(({ parts }) => parts.join(':'))
    .filter(validName)
    .map((name) => ({ name, source, plugin }));
}

function claudeMd(files) {
  let present = false;
  let lines = 0;
  for (const f of files) {
    const text = readText(f);
    if (text === null) continue;
    present = true;
    if (text) lines += text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  }
  return present ? { present: true, lines } : null;
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

/**
 * `{ id: { version, installPath } }` from `installed_plugins.json`. Version 1 maps an id to
 * one entry; version 2 to a list of them, one per scope. A user-scope entry wins, then one
 * installed for this repository, then the first.
 */
function installedPlugins(home, root) {
  const json = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'));
  const plugins = isObject(json) && isObject(json.plugins) ? json.plugins : {};
  const out = {};
  for (const [id, raw] of Object.entries(plugins)) {
    const entries = (Array.isArray(raw) ? raw : [raw]).filter(isObject);
    const entry =
      entries.find((e) => !e.scope || e.scope === 'user') ||
      entries.find((e) => root && typeof e.projectPath === 'string' && path.resolve(e.projectPath) === path.resolve(root)) ||
      entries[0];
    if (!entry) continue;
    out[id] = {
      version: cleanValue(entry.version),
      installPath: typeof entry.installPath === 'string' ? entry.installPath : null,
    };
  }
  return out;
}

/** What one installed plugin brings: its agents, skills, commands, hooks and MCP servers. */
function pluginContents(id, installPath) {
  const out = { agents: [], skills: [], commands: [], hooks: [], mcpServers: [] };
  if (!installPath) return out;
  out.agents = agentsIn(path.join(installPath, 'agents'), 'plugin', id);
  out.skills = skillsIn(path.join(installPath, 'skills'), 'plugin', id);
  out.commands = commandsIn(path.join(installPath, 'commands'), 'plugin', id);
  const manifest = readJson(path.join(installPath, '.claude-plugin', 'plugin.json'));
  const hooksJson = readJson(path.join(installPath, 'hooks', 'hooks.json'));
  let hooks = isObject(hooksJson) ? hooksJson.hooks : null;
  if (!hooks && isObject(manifest) && isObject(manifest.hooks)) hooks = manifest.hooks.hooks || manifest.hooks;
  out.hooks = hookEntries(hookCounts(hooks), 'plugin', id);
  out.mcpServers = mcpEntries(mcpFile(path.join(installPath, '.mcp.json')), 'plugin', id);
  if (isObject(manifest)) {
    let servers = manifest.mcpServers;
    if (typeof servers === 'string') {
      const file = path.resolve(installPath, servers);
      servers = file.startsWith(path.resolve(installPath) + path.sep) ? mcpFile(file) : null;
    }
    out.mcpServers.push(...mcpEntries(servers, 'plugin', id));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

function scope({ md, settingsFiles, projectAllowed, mcpServers, plugins, agents, skills, commands, hooks }) {
  return {
    claudeMd: md,
    settings: settingsSummary(settingsFiles, projectAllowed),
    mcpServers: capped(mcpServers, (m) => `${m.scope}\u0000${m.plugin || ''}\u0000${m.name}`),
    plugins: capped(plugins, (p) => p.id),
    agents: capped(agents, itemKey),
    skills: capped(skills, itemKey),
    commands: capped(commands, itemKey),
    hooks: capped(hooks, itemKey),
  };
}

function workflows(root) {
  const dir = path.join(root, '.github', 'workflows');
  let files = 0;
  let claudeCodeAction = 0;
  for (const e of listDir(dir)) {
    if (!e.isFile() || !/\.ya?ml$/i.test(e.name)) continue;
    files += 1;
    const text = readText(path.join(dir, e.name));
    if (text && text.includes('anthropics/claude-code-action')) claudeCodeAction += 1;
  }
  return { files, claudeCodeAction };
}

/** `Joses-MacBook-Pro` out of `Joses-MacBook-Pro.local`. */
function shortHostname(raw = os.hostname()) {
  const first = String(raw || '')
    .split('.')[0]
    .replace(CONTROL_RE, '')
    .trim();
  return first.slice(0, 64) || 'unknown';
}

/**
 * The snapshot body for `PUT /api/claude-setup/snapshot`. Reads files only; every read is
 * its own try, so a broken file is skipped rather than costing the rest.
 *
 * `repo` is the session's `owner/name` (the same slug its reports carry). `root` is the
 * repository's top directory, found with git when not given. Without both there is no
 * `project`.
 */
function buildSnapshot({ home = os.homedir(), cwd = process.cwd(), repo = '', root, env = process.env, pluginVersion = 'unknown', machineId = null, claudeVersion } = {}) {
  const claudeDir = path.join(home, '.claude');
  const userSettings = [readJson(path.join(claudeDir, 'settings.json')), readJson(path.join(claudeDir, 'settings.local.json'))];
  const claudeJson = readJson(path.join(home, '.claude.json'));
  const projectRoot = root === undefined ? gitRoot(cwd) : root;
  // A remote that did not reduce to `owner/name` is left out: it can carry credentials.
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) repo = '';
  const hasProject = Boolean(projectRoot && repo);
  const projectSettings = hasProject
    ? [readJson(path.join(projectRoot, '.claude', 'settings.json')), readJson(path.join(projectRoot, '.claude', 'settings.local.json'))]
    : [];

  const installed = installedPlugins(home, projectRoot);
  const userEnabled = enabledPluginsOf(userSettings);
  const projectEnabled = enabledPluginsOf(projectSettings);

  const plugins = [...new Set([...Object.keys(installed), ...Object.keys(userEnabled)])]
    .filter(validName)
    .map((id) => ({ id, enabled: userEnabled[id] === true, version: installed[id] ? installed[id].version : null }));

  // A plugin's contents count where it is turned on: user settings, or this repository's.
  const contentsFor = (ids) => {
    const merged = { agents: [], skills: [], commands: [], hooks: [], mcpServers: [] };
    for (const id of ids) {
      if (!validName(id) || !installed[id]) continue;
      const c = pluginContents(id, installed[id].installPath);
      for (const k of Object.keys(merged)) merged[k].push(...c[k]);
    }
    return merged;
  };
  const userPluginIds = Object.keys(userEnabled).filter((id) => userEnabled[id]);
  const fromUserPlugins = contentsFor(userPluginIds);

  const userHooks = {};
  for (const f of userSettings) hookCounts(isObject(f) ? f.hooks : null, userHooks);

  const user = scope({
    md: claudeMd([path.join(claudeDir, 'CLAUDE.md')]),
    settingsFiles: userSettings,
    mcpServers: [
      ...mcpEntries(isObject(claudeJson) ? claudeJson.mcpServers : null, 'user'),
      ...userSettings.flatMap((f) => mcpEntries(isObject(f) ? f.mcpServers : null, 'user')),
      ...fromUserPlugins.mcpServers,
    ],
    plugins,
    agents: [...agentsIn(path.join(claudeDir, 'agents'), 'user'), ...fromUserPlugins.agents],
    skills: [...skillsIn(path.join(claudeDir, 'skills'), 'user'), ...fromUserPlugins.skills],
    commands: [...commandsIn(path.join(claudeDir, 'commands'), 'user'), ...fromUserPlugins.commands],
    hooks: [...hookEntries(userHooks, 'user'), ...fromUserPlugins.hooks],
  });

  const body = {
    v: SETUP_VERSION,
    machineId,
    hostname: shortHostname(),
    platform: process.platform,
    arch: process.arch,
    pluginVersion: cleanValue(pluginVersion) || 'unknown',
  };
  const version = cleanValue(claudeVersion || (env && env.CLAUDE_CODE_VERSION));
  if (version) body.claudeVersion = version;
  body.user = user;

  if (hasProject) {
    const projects = isObject(claudeJson) && isObject(claudeJson.projects) ? claudeJson.projects : {};
    const local = projects[projectRoot] || projects[cwd];
    const projectPluginIds = Object.keys(projectEnabled).filter((id) => projectEnabled[id] && !userEnabled[id]);
    const fromProjectPlugins = contentsFor(projectPluginIds);
    const projectHooks = {};
    for (const f of projectSettings) hookCounts(isObject(f) ? f.hooks : null, projectHooks);
    const projectAllowed = isObject(local) && Array.isArray(local.allowedTools) ? local.allowedTools : [];
    body.project = {
      repo,
      ...scope({
        md: claudeMd([path.join(projectRoot, 'CLAUDE.md'), path.join(projectRoot, '.claude', 'CLAUDE.md')]),
        settingsFiles: projectSettings,
        projectAllowed,
        mcpServers: [
          ...mcpEntries(mcpFile(path.join(projectRoot, '.mcp.json')), 'project'),
          ...mcpEntries(isObject(local) ? local.mcpServers : null, 'local'),
          ...fromProjectPlugins.mcpServers,
        ],
        plugins: [],
        agents: [...agentsIn(path.join(projectRoot, '.claude', 'agents'), 'project'), ...fromProjectPlugins.agents],
        skills: [...skillsIn(path.join(projectRoot, '.claude', 'skills'), 'project'), ...fromProjectPlugins.skills],
        commands: [...commandsIn(path.join(projectRoot, '.claude', 'commands'), 'project'), ...fromProjectPlugins.commands],
        hooks: [...hookEntries(projectHooks, 'project'), ...fromProjectPlugins.hooks],
      }),
      workflows: workflows(projectRoot),
    };
    // What Claude may do in this repository: user and project rules together, as Claude Code applies them.
    body.project.settings.capabilities = envLib.capabilitiesOf({ settingsFiles: [...userSettings, ...projectSettings].filter(isObject), projectAllowed });
  }
  envLib.capPrompts([...body.user.agents, ...(body.project ? body.project.agents : [])]);
  const { connections, clis } = envLib.connectionsOf({ home, env });
  body.environment = {
    directories: envLib.directoriesOf({ home, claudeJson, settingsFiles: [...userSettings, ...projectSettings] }),
    connections,
    clis,
  };
  return body;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function pravexDir(home) {
  return path.join(home, '.pravex');
}

/** This machine's random id, created on first use. Null if it cannot be kept, so no new machine appears on every start. */
function machineId(home = os.homedir()) {
  const file = path.join(pravexDir(home), 'machine-id');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (UUID_V4_RE.test(existing)) return existing.toLowerCase();
  } catch {
    /* first use */
  }
  try {
    const id = crypto.randomUUID();
    fs.mkdirSync(pravexDir(home), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${id}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return id;
  } catch {
    return null;
  }
}

function hashOf(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function sentFile(home) {
  return path.join(pravexDir(home), 'setup-sent.json');
}

function readSent(home) {
  const json = readJson(sentFile(home));
  return isObject(json) ? json : {};
}

function writeSent(home, map, now) {
  const kept = Object.entries(map)
    .filter(([, v]) => isObject(v) && typeof v.at === 'number' && now - v.at < SENT_MAX_AGE_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, SENT_MAX_ENTRIES);
  const file = sentFile(home);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(pravexDir(home), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept)), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never written */
    }
  }
}

/** Whether a snapshot with this hash is due: never sent, changed, or accepted over 24 h ago. */
function isDue(home, key, hash, now = Date.now()) {
  const last = readSent(home)[key];
  if (!isObject(last) || typeof last.at !== 'number') return true;
  return last.hash !== hash || now - last.at >= RESEND_AFTER_MS;
}

function remember(home, key, hash, now = Date.now()) {
  const map = readSent(home);
  map[key] = { hash, at: now };
  writeSent(home, map, now);
}

/** `{ tracked: true }`, bare or in the API's `{ status, result }` envelope. */
function accepted(res) {
  if (!res || res.status < 200 || res.status >= 300) return false;
  try {
    const json = JSON.parse(res.body);
    const result = isObject(json) && json.result !== undefined ? json.result : json;
    return isObject(result) && result.tracked === true;
  } catch {
    return false;
  }
}

/**
 * Build and send the snapshot when it is due. Resolves `{ sent, reason }` and never
 * rejects; never takes longer than `timeoutMs`.
 *
 * `send(route, body)` does the request with the hook's own credentials and headers, and
 * resolves `{ status, body }`. `seat` is false when the seat check said there is none.
 */
function maybeSendSetup({
  home = os.homedir(),
  cwd = process.cwd(),
  repo = '',
  root,
  env = process.env,
  pluginVersion,
  claudeVersion,
  incognito = false,
  seat = true,
  send,
  now = Date.now(),
  timeoutMs = SEND_TIMEOUT_MS,
} = {}) {
  // Incognito first: nothing about this session's machine is even read.
  if (incognito) return Promise.resolve({ sent: false, reason: 'incognito' });
  if (env && env.PRAVEX_SETUP === '0') return Promise.resolve({ sent: false, reason: 'disabled' });
  if (!seat) return Promise.resolve({ sent: false, reason: 'no-seat' });
  if (typeof send !== 'function') return Promise.resolve({ sent: false, reason: 'no-sender' });

  const work = (async () => {
    // Let the hook's own requests go out before the synchronous file reads.
    await new Promise((r) => setImmediate(r));
    const id = machineId(home);
    if (!id) return { sent: false, reason: 'no-machine-id' };
    const body = buildSnapshot({ home, cwd, repo, root, env, pluginVersion, machineId: id, claudeVersion });
    const key = `${id}|${body.project ? body.project.repo : ''}`;
    const hash = hashOf(body);
    if (!isDue(home, key, hash, now)) return { sent: false, reason: 'unchanged' };
    const res = await send(SETUP_ROUTE, body);
    if (!accepted(res)) return { sent: true, accepted: false, reason: `status ${res && res.status}` };
    remember(home, key, hash, now);
    return { sent: true, accepted: true, reason: 'ok' };
  })().catch((err) => ({ sent: false, reason: `error: ${err && err.message}` }));

  let timer;
  const cap = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ sent: false, reason: 'timeout' }), timeoutMs);
    if (timer.unref) timer.unref();
  });
  return Promise.race([work, cap]).finally(() => clearTimeout(timer));
}

const STATUS_ROUTE = '/api/claude-setup/machine-status';

/**
 * The plan usage the status line last saw and the flow runner's state, on every session start
 * (plan 0011). Small and not throttled: unlike the snapshot it changes all the time, and the
 * flow guard is only as good as its freshness. Same rules as the snapshot: never incognito,
 * never without a seat, never with `PRAVEX_SETUP=0`, capped in time, never rejects.
 */
function maybeSendStatus({ home = os.homedir(), env = process.env, incognito = false, seat = true, send, timeoutMs = SEND_TIMEOUT_MS } = {}) {
  if (incognito || !seat || (env && env.PRAVEX_SETUP === '0') || typeof send !== 'function') return Promise.resolve({ sent: false });
  const work = (async () => {
    const id = machineId(home);
    if (!id) return { sent: false };
    const res = await send(STATUS_ROUTE, { machineId: id, planUsage: envLib.readPlanUsage(home), runner: envLib.readRunnerState(home) });
    return { sent: true, status: res && res.status };
  })().catch(() => ({ sent: false }));
  let timer;
  const cap = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ sent: false, reason: 'timeout' }), timeoutMs);
    if (timer.unref) timer.unref();
  });
  return Promise.race([work, cap]).finally(() => clearTimeout(timer));
}

module.exports = {
  FACET_NAME_RE,
  STATUS_ROUTE,
  MAX_DESCRIPTION,
  MAX_LIST,
  RESEND_AFTER_MS,
  SECRET_RE,
  SEND_TIMEOUT_MS,
  SETUP_ROUTE,
  SETUP_VERSION,
  buildSnapshot,
  cleanDescription,
  cleanTools,
  frontmatter,
  hashOf,
  hostOf,
  isDue,
  launcherOf,
  machineId,
  maybeSendSetup,
  maybeSendStatus,
  shortHostname,
};
