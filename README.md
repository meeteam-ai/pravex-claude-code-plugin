# Pravex plugin for Claude Code

Reports each finished coding session to your [Pravex](https://pravex.tenox.ai)
workspace — model, tokens, cost, active duration, files touched and the pull
request it led to. Claude Code first; OpenAI's Codex CLI too, from the same
machine (`/pravex:codex --install`) or on its own
(`npx @pravex/codex install`, see `packages/pravex-codex/`).

## Install

```
/plugin marketplace add meeteam-ai/pravex-claude-code-plugin
/plugin install pravex@pravex
/pravex:login
```

`/pravex:login` prints a short code and opens your browser. Approve it on a page
you are already signed in to, and the plugin collects its credentials itself.

**Nothing is copied and nothing is pasted.** This is the OAuth 2.0 Device
Authorization Grant (RFC 8628), the flow `gh auth login` and `docker login` use,
and it matters here more than most places: a pasted key lands in the clipboard,
in terminal scrollback, and in the session transcript **this plugin uploads**.
One real key was burned exactly that way.

`--api-url` points it elsewhere (`/pravex:login --api-url http://localhost:3000`).
`/pravex:status` says whether this machine is connected and whether you hold a
seat. `/pravex:logout` disconnects it: the server revokes this machine's access
and the credentials are removed. The **Install** page disconnects a machine
remotely. Each login is its own connection, so one machine can be cut off without
touching the others.

### How the sign-in is kept alive

Pravex is its own OAuth 2.1 authorization server. The login returns a short-lived
**access token** (15 minutes, sent as `Authorization: Bearer`) and a **refresh
token** (30 days of non-use, rotated on every use). Both live in
`~/.pravex/config.json` (mode 600):

```json
{ "version": 2, "apiHost": "https://pravex.tenox.ai", "clientId": "pravex-claude-code",
  "accessToken": "…", "refreshToken": "…", "expiresAt": 1762100000000 }
```

The hooks renew the access token a minute before it lapses. A refresh token works
once: the server replaces it on every refresh, and **presenting a used one revokes
the whole connection**. Hooks of several sessions overlap, so a refresh takes the
lock file `~/.pravex/auth.lock`, re-reads the config in case another hook already
renewed, and writes the new pair atomically before anything uses it. A lock left by
a killed hook is broken after 30 seconds. An unreachable server costs nothing: the
credentials stay and the next hook tries again.

If the connection was revoked (from the Install page, by a workspace admin, or by
30 idle days) the plugin removes the credentials and says so: the next prompt after
a `Stop` shows *Pravex: this machine was disconnected… Run /pravex:login to connect
again*, and so does the next session start. A final report that could not be sent
is kept in the spool and goes out after you log in.

**Upgrading from a version with `pvx_` keys:** the old key no longer exists on the
server. The first run drops it from `~/.pravex/config.json` and asks you to run
`/pravex:login` once more. `PRAVEX_API_KEY` is no longer read.

## Know when Pravex is watching

Every new or resumed session opens with one line saying which of four states it
is in: **recording**, **incognito**, **not tracked — no seat** (see [Seats](#seats)),
or **not connected — run `/pravex:login`**.

For an indicator that stays on screen, add it to the status line:

```
/pravex:statusline              # ● Pravex · ◌ Pravex incognito · ⚠ Pravex: no seat · ⚠ Pravex: /pravex:login
/pravex:statusline --uninstall
```

A plugin cannot declare Claude Code's status line (plugin `settings.json` supports
only `agent` and `subagentStatusLine`), so this writes `statusLine` in
`~/.claude/settings.json`. **An existing status line is kept**: it still runs
first and Pravex is appended to its last line. The script is copied to
`~/.pravex/statusline.js`, because the plugin's own directory changes on every
update, and each session start refreshes the copy. Under a managed
`allowManagedHooksOnly` policy only a managed status line shows.

## Seats

A workspace pays per seat, and only members holding one are tracked. Without a
seat nothing is blocked or slowed down, and nothing is sent. The session opens
with the server's own line instead of "recording":

```
Pravex: you don't have a seat in Northwind, so this session isn't tracked. Ask a workspace admin to assign you one.
```

A paused seat has its own line, and the status line shows `⚠ Pravex: no seat`.
When an admin assigns or removes a seat while a session runs, the next reply says
so, once: *you now have a seat in Northwind. This session is tracked from here
on.* or *your seat in Northwind was removed, so the rest of this session isn't
tracked.* Codex shows the same lines as warnings. `/pravex:status` adds a `Seat:`
line.

The answer is cached in `~/.pravex/seat.json`. Session start refreshes it,
waiting 1.5 s at most before falling back to the cache, and so does every
report. While the cache says there is no seat the hooks send nothing, and they
ask the server again after five minutes. Any error sends as before, because the
server checks the seat on ingest anyway. That is also why an older plugin simply
stops being tracked, without saying so. A server from before seats tracks
everyone. A session that ran without a seat is never sent later, even after a
seat arrives.

## Incognito sessions

```
/pravex:incognito
```

The session still appears in Pravex, labelled incognito, with its **token usage,
cost, model and duration**, plus the machine's time zone. The conversation, title,
repository and branch, files touched, pull request and session facets are not
sent, and the command reports straight away so the server scrubs what earlier
progress reports already sent. It lasts until the
session ends and cannot be undone for that session.

Markers live in `~/.pravex/incognito/<session id>` and are pruned after 30 days.

## Keep it up to date

Claude Code does not auto-update third-party marketplaces by default, so an
install stays on the version it started with. The plugin checks for a newer version in
the background at session start (at most twice a day, never blocking startup) and
says so in the start message and as `⬆ /pravex:update` on the status line. It never
updates itself. Run `/pravex:update` (it refreshes the
marketplace, updates, and tells you to `/reload-plugins`), or turn auto-update on
under `/plugin` → Marketplaces → pravex.
Organizations rolling it out through managed settings set `"autoUpdate": true`.

## What it sends

A session is reported once, when it ends. The payload is metrics — **no prompts,
no code, no file contents**:

| Field | Notes |
| --- | --- |
| `externalId` | The Claude Code session id. Re-posting the same id updates the row |
| `title` | The session's own title, or the first prompt. **Key-shaped strings are masked before the payload leaves the machine** |
| `repo`, `branch` | From `git remote get-url origin` and the transcript |
| `durationMinutes` | **Active** time, not wall clock — see below |
| `usage` | Input, output, cache-read and cache-write tokens, per model |
| `filesTouched` | Only edits a `tool_result` confirmed. A denied or failed edit did not touch anything |
| `testsAdded` | How many of those look like test files |
| `retryRate` | Percentage of tool calls that errored |
| `prUrl` | Only a pull request belonging to this session's own repo |
| `tz` | The machine's IANA time zone (`America/Bogota`), so sessions land in your own day and hour |
| `facets` | What kind of work it was, as **counts only** — see below |

`facets` is counts, categories and the **names** of what was invoked — never a
path, file name, command line or argument. Everything in it is computed in the same
single pass over the transcript and its subagents' transcripts:

| Facet | Notes |
| --- | --- |
| `languages` | Edited files per language, by extension (`TypeScript`, `Python`, `Dockerfile`, … unknown is `Other`) |
| `fileKinds` | Edited files that are tests, docs, ADRs, CI, config, migrations, dependency manifests or infra. A file can count as several |
| `tools` | Tool calls by category — edit, shell, read, search, web, subagent, plan, mcp, other — the same vocabulary for Claude Code and Codex |
| `toolUses`, `toolErrors` | Tool calls, and how many of them failed |
| `linesAdded`, `linesRemoved` | From edits whose result confirmed they landed |
| `commits`, `prsOpened` | Successful `git commit` and `gh pr create` calls |
| `testRuns` | Test-runner calls (`vitest`, `jest`, `pytest`, `go test`, `npm test`, …) that passed and failed |
| `commands` | Slash commands by name (`model`, `compact`, `code-review`), never their arguments |
| `skills` | Skills invoked through the Skill tool, by name |
| `subagents` | Subagents launched, by type (`Explore`, `Plan`, `general-purpose`, a plugin's own agent) |
| `mcpServers` | MCP tool calls by **server** (`linear`, `Claude_Browser`); the tool and its input are dropped. claude.ai connectors, which Claude Code names by UUID, count as `claude-ai-connector` |
| `prompts`, `interrupts` | Prompts a person typed, and how many times they stopped Claude mid-turn |
| `permissionDenials` | Tool calls a person or the auto-mode classifier refused (not ones that failed) |
| `compactions`, `apiErrors` | Context compactions and API errors (overloaded, auth) during the session |
| `permissionMode`, `surface`, `effort` | The permission mode, where it ran (`cli`, `claude-desktop`, …) and effort level seen most in the session |

A name is kept only if it looks like one — letters, digits and `.:@/_-`, at most 64
characters — and each map holds at most 50 names. Subagents write their own
transcripts (`<session>/subagents/*.jsonl`): their tokens, tool calls and edits
count toward the session they ran in, while prompts, title and duration come from
the main transcript only.

A facet that cannot be computed never costs the report: `facets` is simply left
out. **Incognito sends usage only, plus the time zone** — never `facets`.

Three of those are deliberate and were measured rather than guessed:

- **Duration is active time.** One real session left open overnight measured
  7,237 wall-clock minutes against ~110 minutes of work. Gaps over five minutes
  are dropped, so a long think counts and lunch does not.
- **`filesTouched` counts what landed.** Holding each edit until its result
  confirms it is what keeps denied edits out of the number.
- **`prUrl` has to name this repo.** A pull request from an unrelated
  organisation, open in another browser tab, once turned up in tool output and
  was reported as the session's own.

If a session ends offline the report is spooled to `~/.pravex/spool` and sent at
the start of the next one. A failure never blocks or fails your session; it is
logged to `~/.pravex/last-report.log`.

## Agent flows on this machine (0.14.0)

Since 0.14.0 the setup snapshot (below) also carries what an agent flow needs to know
before it runs here, and the plugin can run flows for you:

| Part | What is sent |
| --- | --- |
| Folders | The folders Claude Code was opened in (from `~/.claude.json`), `permissions.additionalDirectories`, and the folders Claude Desktop's filesystem server may read; your home directory is written `~`; each with the repository (`owner/name`) it holds |
| Check commands (0.16.0) | For each of those folders with a `package.json`: the package manager, the **names** of its scripts (never their bodies, at most 60) and up to four commands worth checking with (lint, types, test, build). Read from `package.json` files, lock file names, `turbo.json` and the workspace list; nothing is run |
| Connections | GitHub, GitLab, AWS, Google Cloud, Azure, Kubernetes, Docker, Vercel, Supabase, npm: whether each is connected, configured or only installed, read from the tools' own config files. Only names come out (gh's account name, registry hosts, profile and context counts); **no token is ever read into the snapshot** |
| Capabilities | Whether your permission rules allow, ask or deny `edit`, `write`, `bash`, `git-push`, `gh-pr`, `run-tests` and `web-fetch`. The rules themselves stay here |
| Agent prompts | The body of each agent file, with key-shaped strings masked, at most 6,000 characters each and 250,000 in all |

Every session start also sends a small machine status to `PUT /api/claude-setup/machine-status`:
the plan usage the Pravex status line last saw (Claude Code's 5-hour and 7-day
`used_percentage`, kept in `~/.pravex/plan-usage.json`), the flow runner's state and
whether Claude Code is signed in and until when (`claude auth status --json`, 0.16.0;
**never the account, e-mail or organisation**).

**The flow runner** is opt-in: `/pravex:flows install` schedules `flow-runner.js --tick`
every minute (launchd, cron or Task Scheduler). It runs only the flows **you**
assigned to this machine in Pravex, with your Claude Code, each live run in its own
git worktree on a new branch, and respects each flow's plan limits (start only below
a percentage, stop above another). `/pravex:flow-test <flow>` tests a flow here
without changing anything: agents run in plan mode and say whether they could do
their task. `/pravex:flows uninstall` removes the schedule.

In a live run (0.15.1): while a check is failing nothing leaves the machine (no pull
request, deploy or approval); each agent's report is handed to the next one; an agent
that edits may run the flow's own check commands, exactly as written; and work that
did not reach a pull request is committed to the run's local branch, never pushed.
A run ends early, saying so, when Claude Code is signed out on the machine
(`claude auth login`).

A flow with plan limits asks Claude where the plan stands before it runs (0.15.2): one
word to the smallest model, with no tools, hooks or saved session, so no terminal has
to be open. The scheduled check asks too, at most once an hour, when nothing has read
the plan lately.

Since 0.16.0 flows are safer, sooner and visible:

- **Agents and checks do not push.** Every agent starts with `git push`, `gh pr merge`
  and `gh workflow run` denied, and agents, check commands and the dependency install
  run with a git that has nowhere to push to, so a script an agent edited cannot push
  either. The runner's own push, after the checks, is the only one. It is a strong
  protection, not a sandbox: a command that rewrites its own environment or git options
  can undo it, so give an agent no more tools than its task needs. A check whose own
  tests push to a temporary repository fails under it.
- **No repeated work.** A scheduled run of a flow that opens pull requests is skipped
  while its last one is still open. A run you ask for goes on.
- **You confirm the first scheduled run** of a flow on your machine, in Pravex.
- **It starts within a minute.** A tick with nothing to do is one small request, and a
  tick during a run is silent. A schedule installed before 0.16.0 moves from every 15
  minutes to every minute at a session start, never during a run, and keeps its PATH.
- **You see it work, and stop it at once.** While an agent works, Pravex is told its
  turns and the *name* of its tool every 15 seconds, when they change. Stopping the run
  in Pravex ends the agent or check and everything it started, and keeps the work on the
  run's local branch.
- **It says why it failed.** When a check or an agent fails a live run, one question to
  the smallest model (no tools, hooks or saved session) reads the end of its output, with
  key-shaped strings masked, and its answer is shown with the run. Not asked when Claude
  Code is signed out or the plan limits say stop; its cost counts in the run's.

## The setup snapshot

Since 0.13.0, a session start that holds a seat also sends a snapshot of how this
machine's Claude Code is set up, so the workspace can see which MCP servers,
agents, skills, commands, plugins and hooks you have, and suggest improvements.
**Your workspace admins can see it.** It goes to `PUT /api/claude-setup/snapshot`,
in the background (two seconds at most, never delaying the start), and only when
it changed or 24 hours after the last one the server accepted for this machine and
repository (`~/.pravex/setup-sent.json`).

It is **names and shapes, never values**:

| Part | What is sent |
| --- | --- |
| Machine | A random id kept in `~/.pravex/machine-id` (not derived from the hardware), the hostname's first label, platform, architecture, plugin and Claude Code versions |
| MCP servers | Name, transport (`stdio`, `http`, `sse`), scope (`user`, `project`, `local`, `plugin`), the launcher's base name for stdio (`npx`, `uvx`, `docker`) or the URL's **host** for http |
| Agents, skills, commands | Name, the first 160 characters of the frontmatter description, and an agent's model and tool names |
| Plugins | Installed plugin ids, whether each is enabled, and its version |
| Hooks | Event and how many hooks run on it, per source |
| Permissions | How many allow, ask and deny rules there are, the default mode, the model and effort, whether a deny rule covers `.env` files or secrets, whether the dangerous-mode prompt is skipped, whether a status line is set |
| `CLAUDE.md` | Whether it exists, and how many lines |
| Workflows | How many GitHub workflows the repository has, and how many use `anthropics/claude-code-action` |

It reads `~/.claude/settings*.json`, `~/.claude.json`, `~/.claude/{agents,skills,commands}`,
each enabled plugin's directory, and in the session's repository `CLAUDE.md`,
`.claude/CLAUDE.md`, `.mcp.json`, `.claude/settings*.json`, `.claude/{agents,skills,commands}`
and `.github/workflows/`. **Never sent:** MCP `env`, `headers` or `args`, URL paths
or queries, permission rule strings, hook commands, or the content of any file
beyond those frontmatter fields. A name that does not look like one (letters,
digits and `.:@/_-`, at most 64 characters) is dropped, and every list stops at 100.
A broken file is skipped.

Nothing is sent for an incognito session or without a seat, and nothing reads
your setup for Codex. Set `PRAVEX_SETUP=0` to turn it off on this machine.
`scripts/setup-snapshot.test.js` builds a fixture full of fake keys and asserts
that none of them reaches the snapshot.

## Layout

```
plugins/pravex/
├── .claude-plugin/plugin.json
├── hooks/hooks.json               SessionEnd → scripts/report-session.js
├── commands/{login,logout,status}.md /pravex:login, :logout, :status
└── scripts/
    ├── report-session.js           reads the transcript, posts the session
    ├── report-session.test.js
    ├── seat.js                     whether you hold a seat; caches ~/.pravex/seat.json
    ├── setup-snapshot.js           the setup snapshot: names of MCP servers, agents, skills, hooks
    ├── auth.js                     OAuth: device grant, token refresh behind a lock, logout
    ├── login.js                    /pravex:login, --status, --logout; writes ~/.pravex/config.json
    └── login.test.js, auth.test.js, auth-hooks.test.js
```

## Development

```
node --test plugins/pravex/scripts/*.test.js
```

**No dependencies, by design.** This runs inside someone else's Claude Code
session, so it must not pull anything at install time. The scripts import only
the Node standard library, the tests use `node:test`, and CI asserts that nothing
else creeps in.

Credentials come from `~/.pravex/config.json`. `PRAVEX_ACCESS_TOKEN` +
`PRAVEX_API_HOST` in the environment override them without renewal; that is how the
tests drive the real scripts against a local server, and it is not for daily use
(an access token lives 15 minutes).

## Licence

MIT — see [LICENSE](./LICENSE).
