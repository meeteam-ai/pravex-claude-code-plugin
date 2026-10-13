---
description: Check whether this machine is connected to Pravex and holds a seat
allowed-tools: Bash(node:*)
---

Report whether this machine is signed in to a Pravex workspace, and whether you
hold a seat in it. Only members with a seat are tracked.

Run and show the output verbatim:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/login.js" --status`

If it reports that nothing is configured, suggest `/pravex:login`. If the `Seat:`
line says not assigned or paused, sessions on this machine are not tracked
until a workspace admin assigns or restores the seat in Pravex. Nothing else is
affected. With no `Seat:` line, the seat could not be checked, or the server
predates seats.
