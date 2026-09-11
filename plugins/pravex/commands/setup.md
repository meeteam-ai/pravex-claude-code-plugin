---
description: Connect this machine to your Pravex workspace (stores API key in ~/.pravex/config.json)
argument-hint: [--host <url>] [--key <pvx_...>]
allowed-tools: Bash(node:*)
---

Configure the Pravex plugin so finished sessions are reported to the user's workspace.

Arguments given: `$ARGUMENTS`

Steps:

1. If `$ARGUMENTS` contains both `--host` and `--key`, run:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.js" $ARGUMENTS`
2. Otherwise, ask the user for what's missing:
   - **Host**: the Pravex API URL (e.g. `http://localhost:3001` in dev).
   - **API key**: created in Pravex → Install page (or `POST /api/me/api-keys`). Starts with `pvx_`.
   Then run the same command with both flags.
3. Show the script output verbatim. On success, tell the user every session from now on is reported automatically when it ends — nothing else to do.
4. If the script fails, show the error and suggest checking the host URL / regenerating the key.
