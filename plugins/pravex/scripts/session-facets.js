'use strict';
/**
 * Session facets: what kind of work a session was, reduced to counts.
 *
 * Both transcript parsers — `report-session.js` for Claude Code and
 * `codex-rollout.js` for Codex — feed the same accumulator from inside their own
 * single pass over the file, so the two agents cannot drift on what counts as a
 * test file, a commit or a line added. Everything that classifies lives here, once.
 *
 * ⚠️ **Counts and categories only.** A path, a file name or a command is read to
 * be classified and then dropped: the accumulator keeps a number per category and
 * never the thing it counted. The same rule the transcript extraction follows — a
 * command line is exactly the sort of thing that carries a hostname or a token.
 *
 * The wire shape is `facets` v1 on `POST /api/sessions`. Bump `FACETS_VERSION` on
 * any change the server could misread; adding a key to a map is not one.
 *
 * Standard library only, like everything else in this plugin. Not a `*.test.js`
 * and not a hook: it is required by both parsers and copied with them.
 */

/** Schema version of the `facets` object. */
const FACETS_VERSION = 1;

/** Kept here, not in the parsers, because `testsAdded` and `fileKinds.test` must agree. */
const TEST_FILE_RE = /(\.test\.|\.spec\.|_test\.|(^|\/)test_|\/tests?\/|__tests__\/)/;

/** Extension (lowercase, no dot) -> Linguist-style language name. Anything missing is `Other`. */
const LANGUAGE_BY_EXT = (() => {
  const table = {
    TypeScript: ['ts', 'tsx', 'mts', 'cts'],
    JavaScript: ['js', 'jsx', 'mjs', 'cjs'],
    Python: ['py', 'pyi', 'pyw'],
    Go: ['go'],
    Rust: ['rs'],
    Java: ['java'],
    Kotlin: ['kt', 'kts'],
    Swift: ['swift'],
    C: ['c', 'h'],
    'C++': ['cc', 'cpp', 'cxx', 'c++', 'hpp', 'hh', 'hxx'],
    'C#': ['cs', 'csx'],
    Ruby: ['rb', 'rake', 'gemspec'],
    PHP: ['php'],
    Scala: ['scala', 'sc'],
    Dart: ['dart'],
    Elixir: ['ex', 'exs'],
    Erlang: ['erl', 'hrl'],
    Haskell: ['hs', 'lhs'],
    Clojure: ['clj', 'cljs', 'cljc', 'edn'],
    Lua: ['lua'],
    R: ['r'],
    Julia: ['jl'],
    Shell: ['sh', 'bash', 'zsh', 'fish', 'ksh'],
    PowerShell: ['ps1', 'psm1', 'psd1'],
    SQL: ['sql'],
    HTML: ['html', 'htm'],
    CSS: ['css'],
    SCSS: ['scss'],
    Vue: ['vue'],
    Svelte: ['svelte'],
    Markdown: ['md', 'mdx', 'markdown'],
    JSON: ['json', 'jsonc', 'json5'],
    YAML: ['yaml', 'yml'],
    TOML: ['toml'],
    XML: ['xml', 'xsd', 'xsl'],
    Terraform: ['tf', 'tfvars', 'hcl'],
    Makefile: ['mk'],
    GraphQL: ['graphql', 'gql'],
    'Protocol Buffers': ['proto'],
    Solidity: ['sol'],
    Zig: ['zig'],
    Nim: ['nim'],
    OCaml: ['ml', 'mli'],
    'F#': ['fs', 'fsi', 'fsx'],
    'Objective-C': ['m', 'mm'],
    Perl: ['pl', 'pm'],
    Groovy: ['groovy', 'gradle'],
  };
  const out = new Map();
  for (const [name, exts] of Object.entries(table)) for (const ext of exts) out.set(ext, name);
  return out;
})();

/** Path with forward slashes, lowercased, and its last segment. Classification is case-insensitive. */
function normalise(filePath) {
  const p = String(filePath).replace(/\\/g, '/').toLowerCase();
  return { p, base: p.slice(p.lastIndexOf('/') + 1) };
}

/** The language a file is written in, by extension or by one of the few names that have none. */
function languageOf(filePath) {
  const { base } = normalise(filePath);
  // `Dockerfile.dev` is still a Dockerfile; `Makefile` has no extension to go by.
  if (base.startsWith('dockerfile')) return 'Dockerfile';
  if (base === 'makefile' || base === 'gnumakefile') return 'Makefile';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return 'Other';
  return LANGUAGE_BY_EXT.get(base.slice(dot + 1)) || 'Other';
}

const DEPS_FILES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'pyproject.toml',
  'poetry.lock',
  'cargo.toml',
  'cargo.lock',
  'go.mod',
  'go.sum',
]);

/**
 * Every kind a file counts as. A file can be several at once — `docs/adr/0001-x.md`
 * is docs and an ADR — and each kind is counted on its own.
 *
 * `config` is the catch-all for structured settings, so it steps aside when a more
 * specific kind already explains the file: `package.json` is deps, a workflow YAML
 * is CI, and counting either as config too would make config mean "any JSON".
 */
function fileKindsOf(filePath) {
  const { p, base } = normalise(filePath);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1) : '';
  const kinds = [];
  if (TEST_FILE_RE.test(p)) kinds.push('test');
  if (/^(?:md|mdx|rst|adoc)$/.test(ext) || /(?:^|\/)docs\//.test(p)) kinds.push('docs');
  if (/(?:^|\/)(?:adrs?|decisions)\//.test(p) || /^\d{4}-.*\.md$/.test(base)) kinds.push('adr');
  const ci =
    /(?:^|\/)\.github\/workflows\//.test(p) ||
    /(?:^|\/)\.circleci\//.test(p) ||
    base === '.gitlab-ci.yml' ||
    base === 'jenkinsfile' ||
    base === 'azure-pipelines.yml';
  if (ci) kinds.push('ci');
  const deps =
    DEPS_FILES.has(base) || /^requirements.*\.txt$/.test(base) || base.startsWith('gemfile') || base.startsWith('composer.');
  const config =
    /^(?:json|yaml|yml|toml|ini)$/.test(ext) || base.startsWith('.env') || /\.config\./.test(base) || /^\.[\w.-]*rc$/.test(base);
  if (config && !deps && !ci) kinds.push('config');
  if (/(?:^|\/)(?:migrations|migrate)\//.test(p) || /\d{8,}[-_]/.test(base)) kinds.push('migration');
  if (deps) kinds.push('deps');
  if (base.startsWith('dockerfile') || base.startsWith('docker-compose') || ext === 'tf' || /(?:^|\/)(?:k8s|helm|charts|terraform)\//.test(p)) {
    kinds.push('infra');
  }
  return kinds;
}

const CLAUDE_TOOLS = new Map([
  ...['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].map((n) => [n, 'edit']),
  ['Bash', 'shell'],
  ...['Read', 'NotebookRead'].map((n) => [n, 'read']),
  ...['Grep', 'Glob', 'LS'].map((n) => [n, 'search']),
  ...['WebFetch', 'WebSearch'].map((n) => [n, 'web']),
  ...['Task', 'Agent'].map((n) => [n, 'subagent']),
  ...['TodoWrite', 'ExitPlanMode'].map((n) => [n, 'plan']),
]);

/** A Claude Code tool name, in the vocabulary both agents share. */
function claudeToolCategory(name) {
  const n = String(name || '');
  if (n.startsWith('mcp__')) return 'mcp';
  return CLAUDE_TOOLS.get(n) || 'other';
}

/** The shell tool under every name a Codex CLI version has used for it. */
const CODEX_SHELL_RE = /^(?:shell|exec_command|container\.exec|local_shell)/;

/**
 * A Codex tool name, in the same vocabulary.
 *
 * Codex names an MCP tool `<server>__<tool>` (newer CLIs prefix `mcp__`), and none
 * of its built-in tools has a double underscore, so either form is MCP.
 */
function codexToolCategory(name) {
  const n = String(name || '');
  if (n === 'apply_patch') return 'edit';
  if (CODEX_SHELL_RE.test(n)) return 'shell';
  if (n === 'web_search') return 'web';
  if (n === 'update_plan') return 'plan';
  if (n.startsWith('mcp__') || n.includes('__')) return 'mcp';
  return 'other';
}

/** Lines in a piece of text. A trailing newline ends the last line rather than starting another. */
function countLines(text) {
  if (typeof text !== 'string' || text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/**
 * Lines one Claude Code edit tool call adds and removes, read off its input.
 *
 * `Edit` swaps `old_string` for `new_string`, so a one-word change is one line
 * removed and one added — the same way a diff would count it. `replace_all` can hit
 * many places, but how many is not in the transcript, so it counts once.
 */
function claudeEditLines(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (name === 'Edit') return { added: countLines(i.new_string), removed: countLines(i.old_string) };
  if (name === 'MultiEdit') {
    let added = 0;
    let removed = 0;
    for (const e of Array.isArray(i.edits) ? i.edits : []) {
      added += countLines(e && e.new_string);
      removed += countLines(e && e.old_string);
    }
    return { added, removed };
  }
  if (name === 'Write') return { added: countLines(i.content), removed: 0 };
  if (name === 'NotebookEdit') return { added: countLines(i.new_source), removed: 0 };
  return { added: 0, removed: 0 };
}

/** `+` and `-` body lines of an apply_patch, never its `***` file headers or `@@` hunk markers. */
function patchLines(patch) {
  let added = 0;
  let removed = 0;
  if (typeof patch !== 'string') return { added, removed };
  for (const line of patch.split('\n')) {
    if (line.startsWith('***')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

// Quoted text is somebody's words, not the command: `git commit -m "add jest tests"`
// is a commit, not a test run. Stripped before any of the patterns below look.
const QUOTED_RE = /"(?:[^"\\]|\\.)*"|'[^']*'/g;
const COMMIT_RE = /(?:^|[\s;&|(])git\s+(?:-[cC]\s+\S+\s+|--?[\w-]+(?:=\S+)?\s+)*commit(?=\s|$)/;
const PR_CREATE_RE = /(?:^|[\s;&|(])gh\s+pr\s+create(?=\s|$)/;
const TEST_RUN_RES = [
  // Command position only, so `cat jest.config.js` is not a test run.
  /(?:^|[\s;&|(/])(?:vitest|jest|mocha|pytest|rspec|phpunit)(?=\s|$)/,
  /(?:^|[\s;&|(])(?:go|cargo|dotnet|mvn)\s+test(?=\s|$)/,
  /(?:^|[\s;&|(/])gradlew?\s+test(?=\s|$)/,
  /(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?=\s|$)/,
  /(?:^|[\s;&|(])node\s+--test(?=\s|$)/,
];

/**
 * What a shell command did, as far as facets care: a commit, a pull request
 * opened, a test run. Booleans only — the command itself is not kept.
 */
function classifyShell(command) {
  if (typeof command !== 'string' || !command) return { commit: false, pr: false, test: false };
  const c = command.replace(QUOTED_RE, '""');
  return {
    commit: COMMIT_RE.test(c),
    pr: PR_CREATE_RE.test(c),
    test: TEST_RUN_RES.some((re) => re.test(c)),
  };
}

/**
 * One session's facets, filled in from inside a parser's single pass.
 *
 * ⚠️ **A facet can never cost the report.** Every method swallows its own error and
 * marks the accumulator broken; `result()` then returns undefined and the body
 * simply goes without `facets`. The usage numbers are what somebody is paying for;
 * a language breakdown is not worth losing them over.
 */
function createFacets() {
  const tools = {};
  let linesAdded = 0;
  let linesRemoved = 0;
  let commits = 0;
  let prsOpened = 0;
  const testRuns = { passed: 0, failed: 0 };
  let broken = false;

  const safe = (fn) => (...args) => {
    if (broken) return;
    try {
      fn(...args);
    } catch {
      broken = true;
    }
  };

  return {
    /** One tool call, already categorised by `claudeToolCategory` / `codexToolCategory`. */
    tool: safe((category) => {
      tools[category] = (tools[category] || 0) + 1;
    }),
    /** Lines of an edit whose result said it landed. A failed edit is never passed here. */
    edit: safe(({ added = 0, removed = 0 } = {}) => {
      linesAdded += added;
      linesRemoved += removed;
    }),
    /** A shell call's `classifyShell` flags, once its result is known. */
    shell: safe((flags, ok) => {
      if (!flags) return;
      if (flags.commit && ok) commits += 1;
      if (flags.pr && ok) prsOpened += 1;
      if (flags.test) testRuns[ok ? 'passed' : 'failed'] += 1;
    }),
    /**
     * The `facets` object, or undefined if anything went wrong along the way.
     *
     * @param files the same deduped set `filesTouched` counts, so the language and
     *   kind breakdowns always add up to files the dashboard already shows.
     */
    result(files, toolUses, toolErrors) {
      if (broken) return undefined;
      try {
        const languages = {};
        const fileKinds = {};
        for (const f of files) {
          const lang = languageOf(f);
          languages[lang] = (languages[lang] || 0) + 1;
          for (const kind of fileKindsOf(f)) fileKinds[kind] = (fileKinds[kind] || 0) + 1;
        }
        return {
          v: FACETS_VERSION,
          languages,
          fileKinds,
          tools: { ...tools },
          toolUses,
          toolErrors,
          linesAdded,
          linesRemoved,
          commits,
          prsOpened,
          testRuns: { ...testRuns },
        };
      } catch {
        return undefined;
      }
    },
  };
}

module.exports = {
  FACETS_VERSION,
  TEST_FILE_RE,
  claudeEditLines,
  claudeToolCategory,
  classifyShell,
  codexToolCategory,
  countLines,
  createFacets,
  fileKindsOf,
  languageOf,
  patchLines,
};
