# pravex

Claude Code plugin that reports each finished session to your [Pravex](https://github.com/meeteam-ai) workspace: model mix, tokens, cost, duration, files touched, tests added, tool-error rate and PR link.

## Install

```bash
/plugin marketplace add meeteam-ai/pravex-claude-code-plugin
/plugin install pravex@pravex
```

## Setup

1. In Pravex, open **Install** and create an API key (`pvx_...`).
2. In Claude Code:

```
/pravex:setup --host https://api.your-pravex.com --key pvx_xxx
```

Config is stored in `~/.pravex/config.json` (mode 600). Env vars `PRAVEX_API_HOST` / `PRAVEX_API_KEY` override it (useful for CI).

## How it works

- `SessionEnd` hook runs `scripts/report-session.js`.
- The script parses the session transcript (`transcript_path`), aggregates usage per model (deduped by message id, `<synthetic>` error turns excluded), and grabs any PR URL.

**Duration is active time, not wall clock.** Gaps longer than five minutes are dropped, because the first and last transcript timestamps count a laptop left open overnight as work — one real session measured 7,237 wall-clock minutes against ~110 minutes of activity.

**`filesTouched` undercounts on purpose.** An `Edit`/`Write`/`MultiEdit`/`NotebookEdit` call counts only once its `tool_result` confirms it landed, so a denied or failed edit is not a touched file. Files written through `Bash` are picked up for the shapes a command line can be read from — redirections, `tee`, `sed -i`, `cp`/`mv` — but a script that opens its own files (common under `--dangerously-skip-permissions`) is invisible from here. Undercounting is the deliberate trade: inventing a file that was never written would be worse.

**A report that cannot be delivered is spooled, not lost.** Failures from the network or a 5xx are parked under `~/.pravex/spool/` (at most 50, oldest dropped) and replayed at the start of the next session. Ingest is idempotent on `externalId`, so a replay is safe. A 4xx is our own bad request and is never retried.

**Titles are redacted.** When a session has no `ai-title`, the title falls back to the first user prompt — which is routinely a pasted credential. Key-shaped tokens are masked before the payload leaves the machine.
- It `POST`s to `/api/sessions` with the API key. Cost is computed **server-side** from list prices.
- Idempotent: re-posting the same `session_id` updates the row.
- Never blocks Claude Code — errors go to `~/.pravex/last-report.log`. Check with `/pravex:status`.

## Payload

```json
{
  "externalId": "<claude session_id>",
  "title": "...", "repo": "owner/name", "branch": "main",
  "startedAt": "ISO", "endedAt": "ISO",
  "usage": [{ "model": "claude-opus-5", "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0 }],
  "filesTouched": 0, "testsAdded": 0, "retryRate": 0, "prUrl": "https://github.com/.../pull/1"
}
```
