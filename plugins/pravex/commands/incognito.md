---
description: Keep this session's conversation out of Pravex — only usage and cost are recorded
allowed-tools: Bash(node:*)
---

Take the current session incognito in Pravex.

**Run this and show its output verbatim:**

`node "${CLAUDE_PLUGIN_ROOT}/scripts/report-session.js" --incognito "${CLAUDE_SESSION_ID}"`

What it does: the session still appears in Pravex, labelled as an incognito
session, with its token usage, cost, model and duration. The conversation, the
title, the repository and branch, files touched and any pull request are **not
sent**, and anything already sent about this session is scrubbed on the server.

It lasts until the session ends and cannot be undone for this session, so nothing
withheld can be sent later. Do not run anything else.
