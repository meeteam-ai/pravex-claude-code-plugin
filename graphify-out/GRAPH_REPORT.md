# Graph Report - pravex-claude-code-plugin  (2026-09-21)

## Corpus Check
- Corpus is ~30,584 words - fits in a single context window. You may not need a graph.

## Summary
- 395 nodes · 667 edges · 19 communities (16 shown, 3 thin omitted)
- Extraction: 88% EXTRACTED · 12% INFERRED · 0% AMBIGUOUS · INFERRED: 82 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Plugin Session Reporter
- Plugin Validation CI Jobs
- Plugin Login & Device Flow
- Transcript Parsing Helpers
- Codex CLI Tests
- Plugin Incognito & Statusline Tests
- Plugin Statusline Script
- Codex Installer
- Codex npm Package Manifest
- Codex Installer Tests
- Sweep Repo Attribution Tests
- Plugin Update Command
- Codex Rollout Parser
- Codex Report Tests
- Plugin Test Support
- Codex CLI Entry
- Plugin Dependabot
- Plugin Incognito/Statusline/Update
- Plugin Status Command

## God Nodes (most connected - your core abstractions)
1. `main()` - 24 edges
2. `Pravex plugin for Claude Code` - 13 edges
3. `aggregate()` - 12 edges
4. `pravex-scripts job (parse, lint, test)` - 12 edges
5. `sweepUnreported()` - 11 edges
6. `log()` - 10 edges
7. `goIncognito()` - 9 edges
8. `@meeteam/pravex-codex npm package` - 9 edges
9. `pravex Claude Code plugin` - 9 edges
10. `render()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `pravex Claude Code plugin` --semantically_similar_to--> `Pravex plugin for Claude Code`  [INFERRED] [semantically similar]
  plugins/pravex/README.md → README.md
- `filesTouched undercounts on purpose` --semantically_similar_to--> `filesTouched counts only confirmed edits`  [INFERRED] [semantically similar]
  plugins/pravex/README.md → README.md
- `Report spool (~/.pravex/spool, max 50)` --semantically_similar_to--> `Offline report spool (~/.pravex/spool)`  [INFERRED] [semantically similar]
  plugins/pravex/README.md → README.md
- `validate-plugins job` --references--> `/pravex:codex command`  [INFERRED]
  .github/workflows/validate-plugins.yml → plugins/pravex/commands/codex.md
- `/pravex:codex command` --references--> `OAuth 2.0 Device Authorization Grant (RFC 8628)`  [INFERRED]
  plugins/pravex/commands/codex.md → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Two paths to install Codex reporting hooks** — plugins_pravex_commands_codex_codexcommand, packages_pravex_codex_readme_pravex_codex_package, packages_pravex_codex_readme_codex_hooks_json, plugins_pravex_scripts_codex_install [EXTRACTED 1.00]
- **Session report delivery reliability** — plugins_pravex_readme_sessionstart_sweep, plugins_pravex_readme_spool, plugins_pravex_readme_idempotent_ingest, plugins_pravex_readme_session_lifecycle_hooks [EXTRACTED 1.00]

## Communities (19 total, 3 thin omitted)

### Community 0 - "Plugin Session Reporter"
Cohesion: 0.06
Nodes (61): aggregate(), agentFrom(), AGENTS, aggregateFor(), apiUrl(), BASH_WRITE_RES, buildBody(), codex (+53 more)

### Community 1 - "Plugin Validation CI Jobs"
Cohesion: 0.08
Nodes (38): check-duplicates job, marketplace.json (.claude-plugin), plugin.json, pravex-scripts job (parse, lint, test), publish-codex-package job, Stdlib-only require() assertion, validate-marketplace-plugins job, validate-plugins job (+30 more)

### Community 2 - "Plugin Login & Device Flow"
Cohesion: 0.08
Nodes (32): RFC-8628, CONFIG_DIR, CONFIG_FILE, deviceFlow(), fs, http, https, main() (+24 more)

### Community 3 - "Transcript Parsing Helpers"
Cohesion: 0.07
Nodes (30): activeMinutes(), addUsage(), aggregate(), bashWrites(), clampText(), collectPrUrls(), extractTurn(), packTranscript() (+22 more)

### Community 4 - "Codex CLI Tests"
Cohesion: 0.07
Nodes (22): assert, CLI, fs, os, path, { spawnSync }, { sync }, test (+14 more)

### Community 5 - "Plugin Incognito & Statusline Tests"
Cohesion: 0.08
Nodes (22): assert, fs, http, os, path, REPORT, { spawn, spawnSync }, STATUSLINE (+14 more)

### Community 6 - "Plugin Statusline Script"
Cohesion: 0.11
Nodes (28): /pravex:statusline command, basics(), CHAIN_FILE, COLOR, commandFor(), compose(), CONFIG_DIR, CONFIG_FILE (+20 more)

### Community 7 - "Codex Installer"
Cohesion: 0.13
Nodes (24): commandFor(), CONFIG_DIR, COPY_DIR, COPY_FILES, COPY_MANIFEST, COPY_SCRIPTS, copyScripts(), fs (+16 more)

### Community 8 - "Codex npm Package Manifest"
Cohesion: 0.10
Nodes (19): author, bin, pravex-codex, description, engines, node, files, homepage (+11 more)

### Community 9 - "Codex Installer Tests"
Cohesion: 0.17
Nodes (11): assert, fs, hooksFile(), INSTALLER, { isOurs }, path, readHooks(), { spawnSync } (+3 more)

### Community 10 - "Sweep Repo Attribution Tests"
Cohesion: 0.15
Nodes (8): assert, fs, http, os, path, REPORT, { spawn, execFileSync }, test

### Community 11 - "Plugin Update Command"
Cohesion: 0.20
Nodes (10): /pravex:update command, CACHE_FILE, fs, installedVersion(), main(), os, path, run() (+2 more)

### Community 12 - "Codex Rollout Parser"
Cohesion: 0.23
Nodes (10): Codex token semantics, aggregate(), fs, outputFailed(), patchPaths(), readline, shellCommand(), tokenUsageToModelUsage() (+2 more)

### Community 13 - "Codex Report Tests"
Cohesion: 0.20
Nodes (8): assert, { captureServer, envFor, runHook, tempHome }, fs, os, path, test, envFor(), tempHome()

### Community 14 - "Plugin Test Support"
Cohesion: 0.20
Nodes (9): captureServer(), fs, http, os, path, REPORT, runHook(), { spawn } (+1 more)

### Community 15 - "Codex CLI Entry"
Cohesion: 0.25
Nodes (8): main(), path, SCRIPT_FOR, SCRIPTS, { spawnSync }, usage(), ref_node_child_process, ref_node_path

## Knowledge Gaps
- **168 isolated node(s):** `path`, `{ spawnSync }`, `SCRIPTS`, `SCRIPT_FOR`, `test` (+163 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 210 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `pravex-scripts job (parse, lint, test)` connect `Plugin Validation CI Jobs` to `Plugin Session Reporter`, `Plugin Login & Device Flow`, `Codex CLI Tests`, `Plugin Incognito & Statusline Tests`, `Plugin Statusline Script`, `Codex Installer`, `Plugin Update Command`, `Codex Rollout Parser`, `Codex CLI Entry`?**
  _High betweenness centrality (0.147) - this node is a cross-community bridge._
- **Why does `Pravex plugin for Claude Code` connect `Plugin Validation CI Jobs` to `Plugin Session Reporter`, `Plugin Login & Device Flow`?**
  _High betweenness centrality (0.075) - this node is a cross-community bridge._
- **Why does `/pravex:codex command` connect `Plugin Validation CI Jobs` to `Codex Installer`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **What connects `path`, `{ spawnSync }`, `SCRIPTS` to the rest of the system?**
  _168 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Plugin Session Reporter` be split into smaller, more focused modules?**
  _Cohesion score 0.06398730830248546 - nodes in this community are weakly interconnected._
- **Should `Plugin Validation CI Jobs` be split into smaller, more focused modules?**
  _Cohesion score 0.07557354925775979 - nodes in this community are weakly interconnected._
- **Should `Plugin Login & Device Flow` be split into smaller, more focused modules?**
  _Cohesion score 0.07936507936507936 - nodes in this community are weakly interconnected._