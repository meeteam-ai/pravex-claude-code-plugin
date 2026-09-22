# Graph Report - pravex-claude-code-plugin  (2026-09-22)

## Corpus Check
- 35 files · ~38,270 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 5 file(s) not represented in the graph (top: (none) 5)

## Summary
- 433 nodes · 729 edges · 22 communities (17 shown, 5 thin omitted)
- Extraction: 87% EXTRACTED · 13% INFERRED · 0% AMBIGUOUS · INFERRED: 92 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `a231781d`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Plugin Session Reporter
- Plugin Validation CI Jobs
- Plugin Login & Device Flow
- Transcript Parsing Helpers
- cli.test.js
- Plugin Incognito & Statusline Tests
- Plugin Statusline Script
- Codex Installer
- Codex npm Package Manifest
- Codex Installer Tests
- Sweep Repo Attribution Tests
- Plugin Update Command
- codex-rollout.js
- Codex Report Tests
- Plugin Test Support
- ref_node_path
- Plugin Dependabot
- Plugin Incognito/Statusline/Update
- Plugin Status Command
- codex-rollout.test.js
- post-checkout
- post-commit

## God Nodes (most connected - your core abstractions)
1. `main()` - 24 edges
2. `aggregate()` - 13 edges
3. `Pravex plugin for Claude Code` - 13 edges
4. `pravex-scripts job (parse, lint, test)` - 12 edges
5. `sweepUnreported()` - 11 edges
6. `log()` - 10 edges
7. `buildBody()` - 10 edges
8. `@meeteam/pravex-codex npm package` - 10 edges
9. `pravex Claude Code plugin` - 10 edges
10. `goIncognito()` - 9 edges

## Surprising Connections (you probably didn't know these)
- `Report spool (~/.pravex/spool, max 50)` --semantically_similar_to--> `Offline report spool (~/.pravex/spool)`  [INFERRED] [semantically similar]
  plugins/pravex/README.md → README.md
- `pravex Claude Code plugin` --semantically_similar_to--> `Pravex plugin for Claude Code`  [INFERRED] [semantically similar]
  plugins/pravex/README.md → README.md
- `filesTouched undercounts on purpose` --semantically_similar_to--> `filesTouched counts only confirmed edits`  [INFERRED] [semantically similar]
  plugins/pravex/README.md → README.md
- `ourEntries()` --indirect_call--> `isOurs()`  [INFERRED]
  plugins/pravex/scripts/codex-install.test.js → plugins/pravex/scripts/codex-install.js
- `validate-plugins job` --references--> `/pravex:codex command`  [INFERRED]
  .github/workflows/validate-plugins.yml → plugins/pravex/commands/codex.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Two paths to install Codex reporting hooks** — plugins_pravex_commands_codex_codexcommand, packages_pravex_codex_readme_pravex_codex_package, packages_pravex_codex_readme_codex_hooks_json, plugins_pravex_scripts_codex_install [EXTRACTED 1.00]
- **Session report delivery reliability** — plugins_pravex_readme_sessionstart_sweep, plugins_pravex_readme_spool, plugins_pravex_readme_idempotent_ingest, plugins_pravex_readme_session_lifecycle_hooks [EXTRACTED 1.00]

## Communities (22 total, 5 thin omitted)

### Community 0 - "Plugin Session Reporter"
Cohesion: 0.06
Nodes (72): aggregate(), activeMinutes(), addUsage(), agentFrom(), AGENTS, aggregate(), aggregateFor(), apiUrl() (+64 more)

### Community 1 - "Plugin Validation CI Jobs"
Cohesion: 0.08
Nodes (38): check-duplicates job, marketplace.json (.claude-plugin), plugin.json, pravex-scripts job (parse, lint, test), publish-codex-package job, Stdlib-only require() assertion, validate-marketplace-plugins job, validate-plugins job (+30 more)

### Community 2 - "Plugin Login & Device Flow"
Cohesion: 0.08
Nodes (32): RFC-8628, CONFIG_DIR, CONFIG_FILE, deviceFlow(), fs, http, https, main() (+24 more)

### Community 3 - "Transcript Parsing Helpers"
Cohesion: 0.08
Nodes (21): bashWrites(), prUrlMatchesRepo(), prUrlSlug(), plugins_pravex_scripts_report_session_secret_re, assert, { buildBody, findUnreported, modeFrom, readReported, rememberReported }, fs, http (+13 more)

### Community 4 - "cli.test.js"
Cohesion: 0.14
Nodes (14): assert, CLI, fs, os, path, { spawnSync }, { sync }, test (+6 more)

### Community 5 - "Plugin Incognito & Statusline Tests"
Cohesion: 0.08
Nodes (22): assert, fs, http, os, path, REPORT, { spawn, spawnSync }, STATUSLINE (+14 more)

### Community 6 - "Plugin Statusline Script"
Cohesion: 0.11
Nodes (28): /pravex:statusline command, basics(), CHAIN_FILE, COLOR, commandFor(), compose(), CONFIG_DIR, CONFIG_FILE (+20 more)

### Community 7 - "Codex Installer"
Cohesion: 0.14
Nodes (23): commandFor(), CONFIG_DIR, COPY_DIR, COPY_FILES, COPY_MANIFEST, COPY_SCRIPTS, copyScripts(), fs (+15 more)

### Community 8 - "Codex npm Package Manifest"
Cohesion: 0.10
Nodes (19): author, bin, pravex-codex, description, engines, node, files, homepage (+11 more)

### Community 9 - "Codex Installer Tests"
Cohesion: 0.17
Nodes (11): assert, fs, hooksFile(), INSTALLER, { isOurs }, ourEntries(), path, readHooks() (+3 more)

### Community 10 - "Sweep Repo Attribution Tests"
Cohesion: 0.15
Nodes (8): assert, fs, http, os, path, REPORT, { spawn, execFileSync }, test

### Community 11 - "Plugin Update Command"
Cohesion: 0.20
Nodes (10): /pravex:update command, CACHE_FILE, fs, installedVersion(), main(), os, path, run() (+2 more)

### Community 12 - "codex-rollout.js"
Cohesion: 0.21
Nodes (11): Codex token semantics, aggregate(), facetsLib, fs, outputFailed(), patchPaths(), readline, shellCommand() (+3 more)

### Community 13 - "Codex Report Tests"
Cohesion: 0.11
Nodes (18): assert, { captureServer, envFor, runHook, tempHome }, fs, os, path, test, captureServer(), envFor() (+10 more)

### Community 14 - "Plugin Test Support"
Cohesion: 0.09
Nodes (22): classifyShell(), CLAUDE_TOOLS, claudeEditLines(), claudeToolCategory(), codexToolCategory(), countLines(), createFacets(), DEPS_FILES (+14 more)

### Community 15 - "ref_node_path"
Cohesion: 0.25
Nodes (8): main(), path, SCRIPT_FOR, SCRIPTS, { spawnSync }, usage(), ref_node_child_process, ref_node_path

### Community 19 - "codex-rollout.test.js"
Cohesion: 0.13
Nodes (8): { aggregateFor }, assert, codex, fs, os, path, test, turn()

## Knowledge Gaps
- **181 isolated node(s):** `path`, `{ spawnSync }`, `SCRIPTS`, `SCRIPT_FOR`, `test` (+176 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 234 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `pravex-scripts job (parse, lint, test)` connect `Plugin Validation CI Jobs` to `Plugin Session Reporter`, `Plugin Login & Device Flow`, `cli.test.js`, `Plugin Incognito & Statusline Tests`, `Plugin Statusline Script`, `Codex Installer`, `Plugin Update Command`, `codex-rollout.js`, `ref_node_path`?**
  _High betweenness centrality (0.129) - this node is a cross-community bridge._
- **Why does `Pravex plugin for Claude Code` connect `Plugin Validation CI Jobs` to `Plugin Session Reporter`, `Plugin Login & Device Flow`?**
  _High betweenness centrality (0.066) - this node is a cross-community bridge._
- **What connects `path`, `{ spawnSync }`, `SCRIPTS` to the rest of the system?**
  _181 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Plugin Session Reporter` be split into smaller, more focused modules?**
  _Cohesion score 0.05517503805175038 - nodes in this community are weakly interconnected._
- **Should `Plugin Validation CI Jobs` be split into smaller, more focused modules?**
  _Cohesion score 0.07692307692307693 - nodes in this community are weakly interconnected._
- **Should `Plugin Login & Device Flow` be split into smaller, more focused modules?**
  _Cohesion score 0.07936507936507936 - nodes in this community are weakly interconnected._
- **Should `Transcript Parsing Helpers` be split into smaller, more focused modules?**
  _Cohesion score 0.07977207977207977 - nodes in this community are weakly interconnected._