# Graph Report - pravex-claude-code-plugin  (2026-09-22)

## Corpus Check
- 33 files · ~33,853 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 4 file(s) not represented in the graph (top: (none) 4)

## Summary
- 430 nodes · 721 edges · 21 communities (16 shown, 5 thin omitted)
- Extraction: 87% EXTRACTED · 13% INFERRED · 0% AMBIGUOUS · INFERRED: 91 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ce061e2a`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- report-session.js
- Plugin Validation CI Jobs
- Plugin Login & Device Flow
- report-session.test.js
- cli.test.js
- incognito-statusline.test.js
- Plugin Statusline Script
- codex-install.js
- Codex npm Package Manifest
- codex-install.test.js
- Sweep Repo Attribution Tests
- update.js
- codex-report.test.js
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
7. `@meeteam/pravex-codex npm package` - 10 edges
8. `pravex Claude Code plugin` - 10 edges
9. `goIncognito()` - 9 edges
10. `aggregateFor()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `Report spool (~/.pravex/spool, max 50)` --semantically_similar_to--> `Offline report spool (~/.pravex/spool)`  [INFERRED] [semantically similar]
  plugins/pravex/README.md → README.md
- `pravex Claude Code plugin` --semantically_similar_to--> `Pravex plugin for Claude Code`  [INFERRED] [semantically similar]
  plugins/pravex/README.md → README.md
- `filesTouched undercounts on purpose` --semantically_similar_to--> `filesTouched counts only confirmed edits`  [INFERRED] [semantically similar]
  plugins/pravex/README.md → README.md
- `validate-plugins job` --references--> `/pravex:codex command`  [INFERRED]
  .github/workflows/validate-plugins.yml → plugins/pravex/commands/codex.md
- `/pravex:codex command` --shares_data_with--> `Codex hooks (~/.codex/hooks.json: SessionStart, Stop, SessionEnd)`  [INFERRED]
  plugins/pravex/commands/codex.md → packages/pravex-codex/README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Two paths to install Codex reporting hooks** — plugins_pravex_commands_codex_codexcommand, packages_pravex_codex_readme_pravex_codex_package, packages_pravex_codex_readme_codex_hooks_json, plugins_pravex_scripts_codex_install [EXTRACTED 1.00]
- **Session report delivery reliability** — plugins_pravex_readme_sessionstart_sweep, plugins_pravex_readme_spool, plugins_pravex_readme_idempotent_ingest, plugins_pravex_readme_session_lifecycle_hooks [EXTRACTED 1.00]

## Communities (21 total, 5 thin omitted)

### Community 0 - "report-session.js"
Cohesion: 0.06
Nodes (61): aggregate(), agentFrom(), AGENTS, aggregateFor(), apiUrl(), BASH_WRITE_RES, buildBody(), codex (+53 more)

### Community 1 - "Plugin Validation CI Jobs"
Cohesion: 0.08
Nodes (38): check-duplicates job, marketplace.json (.claude-plugin), plugin.json, pravex-scripts job (parse, lint, test), publish-codex-package job, Stdlib-only require() assertion, validate-marketplace-plugins job, validate-plugins job (+30 more)

### Community 2 - "Plugin Login & Device Flow"
Cohesion: 0.08
Nodes (32): RFC-8628, CONFIG_DIR, CONFIG_FILE, deviceFlow(), fs, http, https, main() (+24 more)

### Community 3 - "report-session.test.js"
Cohesion: 0.07
Nodes (30): activeMinutes(), addUsage(), aggregate(), bashWrites(), clampText(), collectPrUrls(), extractTurn(), packTranscript() (+22 more)

### Community 4 - "cli.test.js"
Cohesion: 0.13
Nodes (15): assert, CLI, fs, os, path, { spawnSync }, { sync }, test (+7 more)

### Community 5 - "incognito-statusline.test.js"
Cohesion: 0.08
Nodes (23): assert, fs, http, os, path, REPORT, { spawn, spawnSync }, STATUSLINE (+15 more)

### Community 6 - "Plugin Statusline Script"
Cohesion: 0.11
Nodes (28): /pravex:statusline command, basics(), CHAIN_FILE, COLOR, commandFor(), compose(), CONFIG_DIR, CONFIG_FILE (+20 more)

### Community 7 - "codex-install.js"
Cohesion: 0.13
Nodes (24): commandFor(), CONFIG_DIR, COPY_DIR, COPY_FILES, COPY_MANIFEST, COPY_SCRIPTS, copyScripts(), fs (+16 more)

### Community 8 - "Codex npm Package Manifest"
Cohesion: 0.10
Nodes (19): author, bin, pravex-codex, description, engines, node, files, homepage (+11 more)

### Community 9 - "codex-install.test.js"
Cohesion: 0.18
Nodes (10): assert, fs, hooksFile(), INSTALLER, { isOurs }, path, readHooks(), { spawnSync } (+2 more)

### Community 10 - "Sweep Repo Attribution Tests"
Cohesion: 0.15
Nodes (8): assert, fs, http, os, path, REPORT, { spawn, execFileSync }, test

### Community 11 - "update.js"
Cohesion: 0.22
Nodes (9): /pravex:update command, CACHE_FILE, fs, installedVersion(), main(), os, path, run() (+1 more)

### Community 13 - "codex-report.test.js"
Cohesion: 0.12
Nodes (17): assert, { captureServer, envFor, runHook, tempHome }, fs, os, path, test, captureServer(), envFor() (+9 more)

### Community 14 - "Plugin Test Support"
Cohesion: 0.09
Nodes (22): classifyShell(), CLAUDE_TOOLS, claudeEditLines(), claudeToolCategory(), codexToolCategory(), countLines(), createFacets(), DEPS_FILES (+14 more)

### Community 15 - "ref_node_path"
Cohesion: 0.25
Nodes (8): main(), path, SCRIPT_FOR, SCRIPTS, { spawnSync }, usage(), ref_node_child_process, ref_node_path

### Community 19 - "codex-rollout.test.js"
Cohesion: 0.09
Nodes (18): Codex token semantics, aggregate(), fs, outputFailed(), patchPaths(), readline, shellCommand(), { aggregateFor } (+10 more)

## Knowledge Gaps
- **180 isolated node(s):** `path`, `{ spawnSync }`, `SCRIPTS`, `SCRIPT_FOR`, `test` (+175 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 233 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `pravex-scripts job (parse, lint, test)` connect `Plugin Validation CI Jobs` to `report-session.js`, `Plugin Login & Device Flow`, `cli.test.js`, `incognito-statusline.test.js`, `Plugin Statusline Script`, `codex-install.js`, `update.js`, `ref_node_path`, `codex-rollout.test.js`?**
  _High betweenness centrality (0.126) - this node is a cross-community bridge._
- **Why does `Pravex plugin for Claude Code` connect `Plugin Validation CI Jobs` to `report-session.js`, `Plugin Login & Device Flow`?**
  _High betweenness centrality (0.066) - this node is a cross-community bridge._
- **What connects `path`, `{ spawnSync }`, `SCRIPTS` to the rest of the system?**
  _180 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `report-session.js` be split into smaller, more focused modules?**
  _Cohesion score 0.06398730830248546 - nodes in this community are weakly interconnected._
- **Should `Plugin Validation CI Jobs` be split into smaller, more focused modules?**
  _Cohesion score 0.07692307692307693 - nodes in this community are weakly interconnected._
- **Should `Plugin Login & Device Flow` be split into smaller, more focused modules?**
  _Cohesion score 0.07936507936507936 - nodes in this community are weakly interconnected._
- **Should `report-session.test.js` be split into smaller, more focused modules?**
  _Cohesion score 0.07301587301587302 - nodes in this community are weakly interconnected._