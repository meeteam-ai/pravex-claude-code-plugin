---
description: Check whether this machine is connected to Pravex
allowed-tools: Bash(node:*)
---

Report whether this machine is signed in to a Pravex workspace.

Run and show the output verbatim:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/login.js" --status`

If it reports that nothing is configured, suggest `/pravex:login`.
