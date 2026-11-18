---
description: Test a Pravex agent flow on this machine, from start to end, without changing anything
argument-hint: <flow id or link>
allowed-tools: Bash(node:*)
---

Test a Pravex agent flow here. `$ARGUMENTS` is the flow's id or its Pravex link
(`…/flows/<id>`); take the id (a UUID) out of it. If there is no id, ask for the
flow's link from Pravex › Flows.

Run:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-runner.js" --run <id> --dry`

It can take several minutes: each agent step runs Claude Code in plan mode (it
reads, it cannot change anything) and says whether it could do its task here;
checks run their command; actions are verified (GitHub sign-in, write access to
the repository, the deploy workflow exists) instead of done. Every step is
reported to Pravex as it goes.

Show the output. Then, for every step marked ✗, explain in one line what is
missing and how to fix it on this machine (for example: sign in with `gh auth
login`, clone the repository, allow a tool in the agent, install a dependency).
Do not fix anything yourself unless the person asks.
