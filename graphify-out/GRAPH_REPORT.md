# Graph Report - pravex-claude-code-plugin  (2026-09-21)

## Corpus Check
- Corpus is ~21,834 words - fits in a single context window. You may not need a graph.

## Summary
- 246 nodes · 421 edges · 9 communities (8 shown, 1 thin omitted)
- Extraction: 87% EXTRACTED · 13% INFERRED · 0% AMBIGUOUS · INFERRED: 53 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Plugin Session Reporter
- Plugin Login Tests
- Transcript Parsing Helpers
- Plugin Incognito & Statusline Tests
- Plugin Login & Status Commands
- Plugin Statusline Script
- Plugin Incognito/Statusline/Update
- Plugin Validation CI
- Plugin Dependabot

## God Nodes (most connected - your core abstractions)
1. `main()` - 20 edges
2. `aggregate()` - 13 edges
3. `sweepUnreported()` - 11 edges
4. `goIncognito()` - 9 edges
5. `log()` - 8 edges
6. `render()` - 8 edges
7. `deviceFlow()` - 7 edges
8. `buildBody()` - 7 edges
9. `main()` - 6 edges
10. `post()` - 6 edges

## Surprising Connections (you probably didn't know these)
- `/pravex:login command` --implements--> `OAuth 2.0 Device Authorization Grant (RFC 8628)`  [INFERRED]
  plugins/pravex/commands/login.md → README.md
- `/pravex:incognito command` --implements--> `Incognito sessions`  [INFERRED]
  plugins/pravex/commands/incognito.md → README.md
- `/pravex:statusline command` --implements--> `Pravex status line indicator`  [INFERRED]
  plugins/pravex/commands/statusline.md → README.md
- `Background update check` --conceptually_related_to--> `/pravex:update command`  [INFERRED]
  README.md → plugins/pravex/commands/update.md
- `writes()` --calls--> `bashWrites()`  [EXTRACTED]
  plugins/pravex/scripts/report-session.test.js → plugins/pravex/scripts/report-session.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Session report privacy measures** — plugins_pravex_readme_transcript_extraction, plugins_pravex_readme_title_redaction, readme_incognito_sessions, readme_session_report_payload [INFERRED 0.85]

## Communities (9 total, 1 thin omitted)

### Community 0 - "Plugin Session Reporter"
Cohesion: 0.08
Nodes (48): apiUrl(), BASH_WRITE_RES, buildBody(), CONFIG_DIR, CONFIG_FILE, EDIT_TOOLS, { execFileSync, spawn }, findTranscript() (+40 more)

### Community 1 - "Plugin Login Tests"
Cohesion: 0.06
Nodes (29): assert, { deviceFlow, parseArgs, unwrap, writeConfig }, fs, http, os, path, { spawn }, test (+21 more)

### Community 2 - "Transcript Parsing Helpers"
Cohesion: 0.08
Nodes (29): activeMinutes(), aggregate(), bashWrites(), clampText(), collectPrUrls(), extractTurn(), packTranscript(), prUrlMatchesRepo() (+21 more)

### Community 3 - "Plugin Incognito & Statusline Tests"
Cohesion: 0.08
Nodes (24): assert, fs, http, os, path, REPORT, { spawn, spawnSync }, STATUSLINE (+16 more)

### Community 4 - "Plugin Login & Status Commands"
Cohesion: 0.10
Nodes (26): RFC-8628, /pravex:status command, CONFIG_DIR, CONFIG_FILE, deviceFlow(), fs, http, https (+18 more)

### Community 5 - "Plugin Statusline Script"
Cohesion: 0.12
Nodes (27): basics(), CHAIN_FILE, COLOR, commandFor(), compose(), CONFIG_DIR, CONFIG_FILE, fs (+19 more)

### Community 6 - "Plugin Incognito/Statusline/Update"
Cohesion: 0.10
Nodes (21): /pravex:incognito command, /pravex:login command, /pravex:statusline command, /pravex:update command, Idempotent ingest on externalId, POST /api/sessions (cost computed server-side), SessionStart / Stop / SessionEnd hooks, SessionStart sweep for unreported sessions (+13 more)

### Community 7 - "Plugin Validation CI"
Cohesion: 0.33
Nodes (5): Check duplicate plugin names job, Pravex scripts parse/lint/test job, Validate individual plugins job, Validate marketplace.json job, Zero-dependency (stdlib-only) assertion

## Knowledge Gaps
- **92 isolated node(s):** `test`, `assert`, `fs`, `http`, `os` (+87 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 125 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `refreshStatusline()` connect `Plugin Session Reporter` to `Plugin Statusline Script`?**
  _High betweenness centrality (0.065) - this node is a cross-community bridge._
- **Why does `Pravex scripts parse/lint/test job` connect `Plugin Validation CI` to `Plugin Session Reporter`, `Plugin Login & Status Commands`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **What connects `test`, `assert`, `fs` to the rest of the system?**
  _92 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Plugin Session Reporter` be split into smaller, more focused modules?**
  _Cohesion score 0.07738095238095238 - nodes in this community are weakly interconnected._
- **Should `Plugin Login Tests` be split into smaller, more focused modules?**
  _Cohesion score 0.06258890469416785 - nodes in this community are weakly interconnected._
- **Should `Transcript Parsing Helpers` be split into smaller, more focused modules?**
  _Cohesion score 0.07563025210084033 - nodes in this community are weakly interconnected._
- **Should `Plugin Incognito & Statusline Tests` be split into smaller, more focused modules?**
  _Cohesion score 0.08143939393939394 - nodes in this community are weakly interconnected._