---
description: Report Codex CLI sessions to Pravex from this machine too
argument-hint: [--install | --uninstall | --status]
allowed-tools: Bash(node:*)
---

Install, remove or check the Pravex hooks for OpenAI's Codex CLI on this machine.
Codex sessions then report to the same workspace, with the credential
`/pravex:login` already stored.

Pick the script command from the argument. Never interpolate `$ARGUMENTS`
into the shell command itself — only choose between these three:

- `--install` (or no argument): `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-install.js" install`
- `--uninstall`: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-install.js" uninstall`
- `--status`: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-install.js" status`

Run it and show the output verbatim. If it says nothing is configured,
suggest `/pravex:login`.
