# @pravex/codex

Reports every [OpenAI Codex CLI](https://github.com/openai/codex) session —
model, tokens, API-equivalent cost, active duration, files touched, PR link —
to your Pravex workspace. For machines without Claude Code; with it, run
`/pravex:codex --install` instead.

```bash
npx @pravex/codex login      # OAuth device flow, nothing to paste
npx @pravex/codex install    # three hooks in ~/.codex/hooks.json
npx @pravex/codex status
npx @pravex/codex logout     # revoke this machine's access, remove the credentials
```

`login` is the OAuth 2.0 device grant (RFC 8628) as the `pravex-codex` client: it
prints a code, opens your browser, and stores a short-lived access token and a
rotating refresh token in `~/.pravex/config.json` (mode 600). The hooks renew the
access token themselves, under a lock file so overlapping hooks never spend one
refresh token twice. If the connection is revoked (from the Install page, by an
admin, or after 30 idle days) Codex shows *Pravex: this machine was disconnected…
Run /pravex:login to connect again* — here, run `npx @pravex/codex login`. Coming
from a version with `pvx_` keys, the old key is dropped on first run: log in once
more.

`install` copies the reporter to `~/.pravex/codex/` and points Codex's
`SessionStart`, `Stop` and `SessionEnd` hooks at it. `SessionEnd` is capped at
three seconds by Codex, so that hook hands the report to a detached child and
returns. Sessions whose terminal was closed are swept on the next start.

Only members holding a seat in the workspace are tracked. Without one, Codex
shows a warning at session start (*Pravex: you don't have a seat in Northwind, so
this session isn't tracked.*) and nothing is sent; nothing is blocked or slowed
down. `status` adds the seat line: `Seat: active. Every session is reported when
it ends.`, `Seat: not assigned. …` or `Seat: paused. …`.

The scripts are the ones the Claude Code plugin ships, copied at pack time —
see `sync-scripts.js`. No dependencies.
