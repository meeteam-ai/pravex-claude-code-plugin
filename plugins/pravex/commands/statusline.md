---
description: Show whether Pravex is recording, incognito or needs a login in Claude Code's status line
argument-hint: [--uninstall]
allowed-tools: Bash(node:*)
---

Add a Pravex indicator to the Claude Code status line.

If `$ARGUMENTS` contains `--uninstall`, run:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.js" --uninstall`

Otherwise run:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.js" --install`

Show the output verbatim.

What it does: it sets `statusLine` in `~/.claude/settings.json`, because a plugin
cannot add to the status line any other way. **An existing status line is kept**:
it still runs first and Pravex is appended after it (`● Pravex`, `◌ Pravex
incognito`, or `⚠ Pravex: /pravex:login`). `--uninstall` puts the previous status
line back.

If the user's organization sets `allowManagedHooksOnly`, Claude Code shows only a
status line from managed settings; say so if the indicator does not appear.
