---
description: Sign this machine in to your Pravex workspace — no key to copy or paste
argument-hint: [--api-url <url>]
allowed-tools: Bash(node:*)
---

Sign the user in to Pravex so finished sessions are reported to their workspace.

Arguments given: `$ARGUMENTS`

**Run this and show its output verbatim:**

`node "${CLAUDE_PLUGIN_ROOT}/scripts/login.js"`

If `$ARGUMENTS` contains `--api-url` (or the older `--host`), read the value out
of it and append `--api-url "<value>"` — quote it yourself, never interpolate
`$ARGUMENTS` into the command, it is unescaped user input and the shell would
re-parse it. Do not ask for one otherwise: it defaults to
`https://pravex.tenox.ai`, and the flag exists for pointing at a local API
(`--api-url http://localhost:3000`).

What happens: the script prints a short code and opens the browser. The user
approves it on a page they are already signed in to, and the script collects the
credential itself. **Nothing is copied and nothing is pasted** — never ask the
user for an API key, and never print one.

The script waits, polling, for up to ten minutes. That is expected; do not
interrupt it or re-run it while it is waiting.

On success, tell the user every session from now on is reported automatically
when it ends. On failure, show the error — "expired" and "refused" both just mean
running `/pravex:login` again.
