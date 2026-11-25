'use strict';
/**
 * One job for one agent: a fresh `claude -p` that answers in a fixed shape, with only the tools its role needs. Readers
 * cannot write. Writers work inside Claude Code's own sandbox: their folder, no network, no credentials, no commits.
 * What an agent says about its work proves nothing here; the engine checks the work itself.
 */
const { run, cleanEnv } = require('./proc');

const READ = ['Read', 'Grep', 'Glob'];
const WRITE = [...READ, 'Edit', 'Write', 'Bash'];
const ROLES = {
  analyst: { tools: READ, model: 'opus', maxTurns: 60 },
  planner: { tools: READ, model: 'opus', maxTurns: 60 },
  tester: { tools: WRITE, model: 'opus', maxTurns: 100 },
  builder: { tools: WRITE, model: 'sonnet', maxTurns: 160 },
  reviewer: { tools: READ, model: 'opus', maxTurns: 60 },
  diagnoser: { tools: READ, model: 'opus', maxTurns: 60 },
};

/** Folders that hold keys: no agent reads them, with a file tool or from the shell. */
const PRIVATE = ['~/.ssh', '~/.aws', '~/.pravex', '~/.config/gh', '~/.config/gcloud', '~/.azure', '~/.kube', '~/.docker', '~/.gnupg', '~/.claude.json', '~/.claude', '~/.netrc', '~/.npmrc', '~/.pypirc'];
const NEVER = [
  'Bash(git push:*)', 'Bash(git commit:*)', 'Bash(git reset:*)', 'Bash(git checkout:*)', 'Bash(git switch:*)', 'Bash(git stash:*)', 'Bash(git config:*)', 'Bash(git remote:*)',
  'Bash(gh:*)', 'Bash(sudo:*)', 'Bash(npm publish:*)', 'Bash(pnpm publish:*)', 'Bash(yarn publish:*)',
  'Edit(.git/**)', 'Write(.git/**)', 'Edit(.claude/**)', 'Write(.claude/**)', 'Edit(.husky/**)', 'Write(.husky/**)',
  ...PRIVATE.flatMap((p) => [`Read(${p}/**)`, `Read(${p})`]), 'Read(**/.env)', 'Read(**/.env.*)',
];

const sandboxFor = () => ({
  disableAllHooks: true,
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: [], allowLocalBinding: true },
    filesystem: { denyRead: PRIVATE },
  },
});

function argsFor({ role, prompt, schema, model, maxUsd }) {
  const r = ROLES[role];
  const writes = r.tools.includes('Edit');
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(schema), '--max-turns', String(r.maxTurns), '--max-budget-usd', String(Math.max(0.1, maxUsd).toFixed(2))];
  args.push('--model', model || r.model, '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence', '--permission-mode', 'dontAsk');
  args.push('--settings', JSON.stringify(writes ? sandboxFor() : { disableAllHooks: true }));
  args.push('--tools', r.tools.join(','), '--disallowedTools', ...NEVER);
  args.push('--allowedTools', 'Read(./**)', ...(writes ? ['Edit(./**)', 'Write(./**)'] : []));
  return args;
}

/** What kind of failure this was, so the engine can answer it the same way every time. */
function classify({ r, result, limited, text }) {
  const said = `${text} ${result ? result.result || '' : ''} ${r.err}`.toLowerCase();
  if (r.why === 'stopped') return 'stopped';
  if (r.why === 'missing') return 'claude-missing';
  if (limited) return 'claude-limit';
  if (/not logged in|please run \/login|invalid api key|authentication_error|oauth token (has )?expired|401/.test(said)) return 'claude-signed-out';
  if (/unknown option|unrecognized option/.test(said)) return 'claude-old';
  if (r.why === 'timeout' || r.why === 'idle') return `claude-${r.why}`;
  if (result && /budget/.test(result.subtype || '')) return 'job-budget';
  if (result && /max_turns/.test(result.subtype || '')) return 'job-turns';
  if (/overloaded|529|503|502|500 |internal server error|econnreset|enotfound|etimedout|fetch failed|network|rate.?limit/.test(said)) return 'claude-unavailable';
  if (/sandbox/.test(said) && /unavailable|not available|failed to (start|initialize)/.test(said)) return 'sandbox-unavailable';
  return 'no-answer';
}

/**
 * Runs one job. Never rejects: `{ ok, value, usd, ms, turns, error, resetsAt, text, denied }`.
 */
async function ask(job, { claude = 'claude', timeoutMs = 45 * 60e3, idleMs = 10 * 60e3, signal, onProgress } = {}) {
  let result = null;
  let limited = null;
  let text = '';
  const denied = [];
  const progress = { turns: 0, tool: '' };
  const onLine = (line) => {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      if (!e.parent_tool_use_id) progress.turns += 1;
      for (const c of e.message.content) {
        if (c.type === 'tool_use') progress.tool = c.name;
        if (c.type === 'text') text = c.text;
      }
      if (onProgress) onProgress({ ...progress });
    } else if (e.type === 'system' && e.subtype === 'permission_denied') denied.push(`${e.tool_name}: ${String(e.message || '').slice(0, 120)}`);
    else if (e.type === 'rate_limit_event' && e.rate_limit_info && e.rate_limit_info.status === 'rejected') limited = e.rate_limit_info;
    else if (e.type === 'result') result = e;
  };
  const r = await run(claude, argsFor(job), {
    cwd: job.cwd,
    // Its own sign-in is all Claude Code keeps; everything else secret is gone.
    env: { ...cleanEnv(process.env, { keep: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK'] }), CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' },
    timeoutMs,
    idleMs,
    maxBytes: 200_000,
    onLine,
    signal,
  });
  const usd = (result && result.total_cost_usd) || 0;
  const base = { usd, ms: r.ms, turns: progress.turns, denied, text };
  // The exit code proves nothing: an answer in the shape that was asked for does.
  const value = result && !result.is_error ? result.structured_output : null;
  if (value && typeof value === 'object') return { ok: true, value, ...base };
  const error = classify({ r, result, limited, text });
  return { ok: false, error, resetsAt: limited && limited.resetsAt ? Number(limited.resetsAt) * 1000 : null, detail: String((result && result.result) || text || r.err || '').slice(-600), ...base };
}

module.exports = { ROLES, PRIVATE, ask, argsFor, classify, sandboxFor };
