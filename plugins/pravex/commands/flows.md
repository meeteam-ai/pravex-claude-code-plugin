---
description: Let Pravex run your agent flows on this machine, with your own Claude Code
argument-hint: [install | uninstall | status]
allowed-tools: Bash(node:*)
---

Manage the Pravex flow runner on this machine.

- If `$ARGUMENTS` contains `uninstall`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-runner.js" --uninstall`.
- If `$ARGUMENTS` contains `install`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-runner.js" --install`.
- Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-runner.js" --status`.

Show the output verbatim.

What the runner does: every 15 minutes it asks Pravex which flows **you** assigned to
this machine, runs the ones whose schedule came due (and the tests or runs you
requested from the app), and reports every step back. Each live run works in its
own git worktree on a new branch, so your working copy is never touched, and it
uses your Claude Code, so it counts against your plan: each flow can be limited to
run only while the plan is below a percentage, and stops when it passes another.

Nobody else can make a flow run on this machine: only flows you assign to it run,
and nothing runs until you install the runner. `uninstall` removes the schedule.

If the status shows the plan usage as unknown, suggest `/pravex:statusline`: the
status line is where Claude Code shows the plan usage that the runner reads.
