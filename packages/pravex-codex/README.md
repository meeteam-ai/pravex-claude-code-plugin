# @meeteam/pravex-codex

Reports every [OpenAI Codex CLI](https://github.com/openai/codex) session —
model, tokens, API-equivalent cost, active duration, files touched, PR link —
to your Pravex workspace. For machines without Claude Code; with it, run
`/pravex:codex --install` instead.

```bash
npx @meeteam/pravex-codex login      # device flow, nothing to paste
npx @meeteam/pravex-codex install    # three hooks in ~/.codex/hooks.json
npx @meeteam/pravex-codex status
```

`install` copies the reporter to `~/.pravex/codex/` and points Codex's
`SessionStart`, `Stop` and `SessionEnd` hooks at it. `SessionEnd` is capped at
three seconds by Codex, so that hook hands the report to a detached child and
returns. Sessions whose terminal was closed are swept on the next start.

The scripts are the ones the Claude Code plugin ships, copied at pack time —
see `sync-scripts.js`. No dependencies.
