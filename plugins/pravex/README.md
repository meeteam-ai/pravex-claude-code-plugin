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
- The script parses the session transcript (`transcript_path`), aggregates usage per model (deduped by message id), derives duration from first/last timestamps, counts `Edit`/`Write` file paths, test files, `tool_result.is_error`, and grabs any PR URL.
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
