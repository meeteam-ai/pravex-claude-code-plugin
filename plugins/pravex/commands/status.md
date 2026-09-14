---
description: Show Pravex connection status and the last report result
allowed-tools: Bash(node:*), Bash(tail:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.js" --status` and show the output.

Then run `tail -n 5 ~/.pravex/last-report.log 2>/dev/null` and show it as "Last reports" (if the file is missing, say no session has been reported yet).
