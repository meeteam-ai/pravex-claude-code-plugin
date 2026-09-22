# Pravex plugin for Claude Code

Reports each finished coding session to your [Pravex](https://pravex.tenox.ai)
workspace — model, tokens, cost, active duration, files touched and the pull
request it led to. Claude Code first; OpenAI's Codex CLI too, from the same
machine (`/pravex:codex --install`) or on its own
(`npx @meeteam/pravex-codex install`, see `packages/pravex-codex/`).

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
`/pravex:status` says whether this machine is connected, and the **Install** page
disconnects it — each login is its own connection, so one machine can be cut off
without touching the others.

## Know when Pravex is watching

Every new or resumed session opens with one line saying which of three states it
is in: **recording**, **incognito**, or **not connected — run `/pravex:login`**.

For an indicator that stays on screen, add it to the status line:

```
/pravex:statusline              # ● Pravex · ◌ Pravex incognito · ⚠ Pravex: /pravex:login
/pravex:statusline --uninstall
```

A plugin cannot declare Claude Code's status line (plugin `settings.json` supports
only `agent` and `subagentStatusLine`), so this writes `statusLine` in
`~/.claude/settings.json`. **An existing status line is kept**: it still runs
first and Pravex is appended to its last line. The script is copied to
`~/.pravex/statusline.js`, because the plugin's own directory changes on every
update, and each session start refreshes the copy. Under a managed
`allowManagedHooksOnly` policy only a managed status line shows.

## Incognito sessions

```
/pravex:incognito
```

The session still appears in Pravex, labelled incognito, with its **token usage,
cost, model and duration**. The conversation, title, repository and branch, files
touched and pull request are not sent, and the command reports straight away so
the server scrubs what earlier progress reports already sent. It lasts until the
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

**Knowledge graph.** `graphify-out/` holds a [graphify](https://github.com/Graphify-Labs/graphify)
graph of this repo (`graphify query "<question>"`). The hooks in `.githooks/`
rebuild it after each commit and branch switch — code only, no LLM — and do
nothing if graphify isn't installed. Enable them once per clone:

```
git config core.hooksPath .githooks
```

The rebuild runs after the commit, so the refreshed graph shows up as a change
to commit next. Doc changes need `/graphify . --update` in Claude Code.

Also once per clone: `graphify hook install` registers the union merge driver for
`graph.json` in your local git config. After `git pull`, run `graphify update .`
(or `git config --global alias.gpull '!git pull && graphify update .'`). Committed:
`graph.json`, `GRAPH_REPORT.md`, `graph.html`, `manifest.json`; ignored:
`cost.json`, `cache/` and machine-local state.

## Licence

MIT — see [LICENSE](./LICENSE).
