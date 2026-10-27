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
you are already signed in to, and the plugin collects its credential itself.

**Nothing is copied and nothing is pasted.** This is the OAuth 2.0 Device
Authorization Grant (RFC 8628), the flow `gh auth login` and `docker login` use,
and it matters here more than most places: a pasted key lands in the clipboard,
in terminal scrollback, and in the session transcript **this plugin uploads**.
One real key was burned exactly that way.

`--api-url` points it elsewhere (`/pravex:login --api-url http://localhost:3000`).
`/pravex:status` says whether this machine is connected and whether you hold a seat, and the **Install** page
disconnects it — each login is its own connection, so one machine can be cut off
without touching the others.

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

## Layout

```
plugins/pravex/
├── .claude-plugin/plugin.json
├── hooks/hooks.json               SessionEnd → scripts/report-session.js
├── commands/{login,status}.md      /pravex:login, /pravex:status
└── scripts/
    ├── report-session.js           reads the transcript, posts the session
    ├── report-session.test.js
    ├── seat.js                     whether you hold a seat; caches ~/.pravex/seat.json
    ├── login.js                    the device flow; writes ~/.pravex/config.json
    └── login.test.js
```

## Development

```
node --test plugins/pravex/scripts/*.test.js
```

**No dependencies, by design.** This runs inside someone else's Claude Code
session, so it must not pull anything at install time. The scripts import only
the Node standard library, the tests use `node:test`, and CI asserts that nothing
else creeps in.

Configuration comes from `PRAVEX_API_KEY` / `PRAVEX_API_HOST`, or
`~/.pravex/config.json`, in that order — the environment variables are how the
tests drive it against a local server.

## Licence

MIT — see [LICENSE](./LICENSE).
