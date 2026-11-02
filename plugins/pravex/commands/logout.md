---
description: Disconnect this machine from Pravex — revokes its access and removes the stored credentials
allowed-tools: Bash(node:*)
---

Disconnect this machine from the user's Pravex workspace. Sessions stop being
reported until `/pravex:login` is run again.

Run and show the output verbatim:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/login.js" --logout`

It asks the server to revoke this machine's connection and removes the tokens
from `~/.pravex/config.json`. If the server could not be reached it says so: the
credentials are gone locally, and the machine can also be removed from the
**Install** page in Pravex. Other machines are unaffected, since each login is its
own connection.
