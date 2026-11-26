---
description: Say what should be done, and Pravex drives Claude until it is done, checked and ready to review
argument-hint: "<what should be done>" | status | stop <id> | resume <id>
allowed-tools: Bash(node:*)
---

Build a requirement end to end on this machine.

- If `$ARGUMENTS` is empty or `status`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/build.js" --list`.
- If it starts with `stop` and an id, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/build.js" --stop <id>`.
- If it starts with `resume` and an id, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/build.js" --resume <id>`.
- Otherwise it is the requirement. Write it, exactly as given, to a new temporary file, and run in the background
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/build.js" <that file> --repo "<the current repository>"`.
  Tell the person it can take from minutes to hours, that their working copy is never touched, and that nothing is pushed.

Show the output verbatim. Do not do the work yourself, do not edit the result, and do not push or open pull requests.

What it does: checks whether it can be done before spending, decides what "done" means as tests that fail first, builds,
checks, has someone else review, corrects in a loop, and reports what proves it. It works in its own copy
(`~/.pravex-builds/<id>/repo`), with your Claude Code and your plan, up to a cost limit (US$60 at list price unless you
say `--max-usd`). Agents run in Claude Code's sandbox: no network, no keys, nothing outside that copy, no commits.
Stopping never loses work.
