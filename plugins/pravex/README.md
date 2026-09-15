# pravex

Claude Code plugin that reports each finished session to your [Pravex](https://github.com/meeteam-ai) workspace: model mix, tokens, cost, duration, files touched, tests added, tool-error rate and PR link.

## Install

```bash
/plugin marketplace add meeteam-ai/pravex-claude-code-plugin
/plugin install pravex@pravex
```

## Sign in

```
/pravex:login
```

It prints a short code and opens your browser. Approve the code on a page you
are already signed in to, and the plugin collects its credential itself.

**Nothing is copied and nothing is pasted.** This is the OAuth 2.0 Device
Authorization Grant (RFC 8628) — the flow `gh auth login` and `docker login` use.
It matters here more than most places: a pasted key lands in the clipboard, in
terminal scrollback, and in the session transcript *this plugin uploads*. One
real key was burned exactly that way.

Point it somewhere else with `--api-url`:

```
/pravex:login --api-url http://localhost:3000
```

The credential is stored in `~/.pravex/config.json` (mode 600). `PRAVEX_API_HOST`
/ `PRAVEX_API_KEY` override it, which is how CI and the test suite drive it.

`/pravex:status` says whether this machine is connected. Revoke it from the
**Install** page in Pravex — each `/pravex:login` is its own connection, so one
machine can be cut off without touching the others.

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

## How it works

The plugin reports at three points in a session's life:

| Hook | What it does |
| --- | --- |
| `SessionStart` | Reports the session as **live**, and sweeps for any earlier session that was never reported at all |
| `Stop` | Updates the running numbers after each assistant turn |
| `SessionEnd` | The final report, with the transcript |

⚠️ **`SessionEnd` does not always fire.** It fires on `clear`, `logout`,
`prompt_input_exit` and `other` — closing the terminal or killing the process
fires **nothing**, and that session would never be reported at all. That is
measured, not assumed, and the spool does not help: it replays POSTs that
*failed*, not hooks that never *ran*. The `SessionStart` sweep is the fix, and
ingest is idempotent on the session id, so re-reporting costs nothing.

The sweep is bounded to recent transcripts by both count and age: the projects
directory grows without limit, and a hook that read two years of history on every
session start would be worse than the problem it solves.

The transcript is sent **only on the final report**. A `Stop` hook fires after
every assistant turn, and re-uploading tens of kilobytes each time would be pure
waste — the server summarises once, when the transcript arrives.

- `scripts/report-session.js` serves all three.
- The script parses the session transcript (`transcript_path`), aggregates usage per model (deduped by message id, `<synthetic>` error turns excluded), and grabs any PR URL.

**Duration is active time, not wall clock.** Gaps longer than five minutes are dropped, because the first and last transcript timestamps count a laptop left open overnight as work — one real session measured 7,237 wall-clock minutes against ~110 minutes of activity.

**`filesTouched` undercounts on purpose.** An `Edit`/`Write`/`MultiEdit`/`NotebookEdit` call counts only once its `tool_result` confirms it landed, so a denied or failed edit is not a touched file. Files written through `Bash` are picked up for the shapes a command line can be read from — redirections, `tee`, `sed -i`, `cp`/`mv` — but a script that opens its own files (common under `--dangerously-skip-permissions`) is invisible from here. Undercounting is the deliberate trade: inventing a file that was never written would be worse.

**A report that cannot be delivered is spooled, not lost.** Failures from the network or a 5xx are parked under `~/.pravex/spool/` (at most 50, oldest dropped) and replayed at the start of the next session. Ingest is idempotent on `externalId`, so a replay is safe. A 4xx is our own bad request and is never retried.

**Titles are redacted.** When a session has no `ai-title`, the title falls back to the first user prompt — which is routinely a pasted credential. Key-shaped tokens are masked before the payload leaves the machine.
- It `POST`s to `/api/sessions` with the API key. Cost is computed **server-side** from list prices.
- Idempotent: re-posting the same `session_id` updates the row.
- Never blocks Claude Code — errors go to `~/.pravex/last-report.log`. Check with `/pravex:status`.

## What it sends about the conversation

The session report carries an **extracted** transcript, not the file on disk.

Measured across 358 real transcripts (1.4 GB), `attachment` lines are **79.9%**
of the bytes — `hook_success` alone is 64% of a file — and most of what is left
under `user` is tool *output* rather than anything a person typed. Keeping only
user prompts, assistant prose and the tool **names** comes to 0.076% of raw:

```
51.7 MB raw  ->  847 turns  ->  39 KB gzipped  ->  51 KB on the wire
```

That ratio is why this is cheap enough to do at all, and it is also what keeps
attachments and hook output — the two things most likely to carry somebody's
environment — from ever leaving the machine.

- **Tool names, never arguments or results.** "It ran `Edit` and `Bash`" is what
  a summary needs. A `Bash` command line or a `Read` result is exactly the sort
  of thing that carries a path, a hostname or a token.
- **Redacted before it is cut.** Key-shaped tokens are masked first, then long
  messages are truncated — the other order can leave the front half of a key in
  place, and half a token is still most of a token.
- **Capped at 1 MB gzipped**, about twenty times the worst case measured. Past
  that, turns are dropped from the **front**: the end of a session is what a
  summary is about; the opening of a long one is setup.
- If it cannot be packed at all it is simply **absent**, and the metrics still
  report.

## Payload

```json
{
  "externalId": "<claude session_id>",
  "title": "...", "repo": "owner/name", "branch": "main",
  "startedAt": "ISO", "endedAt": "ISO",
  "usage": [{ "model": "claude-opus-5", "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0 }],
  "filesTouched": 0, "testsAdded": 0, "retryRate": 0, "prUrl": "https://github.com/.../pull/1",
  "transcript": { "encoding": "gzip+base64", "format": 1, "turns": 847, "dropped": 0, "data": "H4sIA..." }
}
```
