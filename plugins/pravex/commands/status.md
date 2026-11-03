---
description: Check whether this machine is connected to Pravex and holds a seat
allowed-tools: Bash(node:*)
---

Report whether this machine is signed in to a Pravex workspace, and whether you
hold a seat in it. Only members with a seat are tracked.

Run and show the output verbatim:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/login.js" --status`

If it reports that nothing is configured, or that the machine was disconnected
(revoked from the Install page, by an admin, or after 30 unused days) or still
held an old `pvx_` key, suggest `/pravex:login`. The login renews itself in the
background, so this is never about an expired token. If the `Seat:`
line says not assigned or paused, coding sessions on this machine are not tracked
until a workspace admin assigns or restores the seat in Pravex. Nothing else is
affected: chatting in Pravex never depends on this plugin, and the plugin never
reports chats. With no `Seat:` line, the seat could not be checked, or the server
predates seats.
