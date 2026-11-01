/**
 * The 18 tasks. `bench build` writes each tasks/<id>/task.json from this list
 * (keeping the expected_total that `bench validate --update` measured), so
 * edit task metadata here, then run build.
 */

export const POLYGLOT_COMMIT = '7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f';

export type Format = 'unittest-json' | 'bun' | 'go-json' | 'cargo';

export interface HiddenRun {
  cmd: string;
  format: Format;
  env: Record<string, string>;
}

export interface CatalogEntry {
  id: string;
  title: string;
  kind: 'polyglot' | 'bug' | 'feature' | 'skill';
  lang: 'python' | 'javascript' | 'typescript' | 'go' | 'rust';
  difficulty: 'easy' | 'medium' | 'hard';
  smoke?: boolean;
  /** polyglot: track/exercise; fixture: the base codebase. */
  exercise?: string;
  base?: 'ledgerkit' | 'tasksd';
  overlay?: boolean;
  hiddenFiles: Record<string, string>;
  runs: HiddenRun[];
  naive?: boolean;
  /**
   * Polyglot only: facts the hidden tests rely on that the Exercism text does
   * not state (the student normally sees the test file). `build` puts them in
   * prompt.md under "Notes for this task"; `bench check` makes sure they are there.
   */
  notes?: string;
  /**
   * Skill tasks only: the hub skill whose content the task needs (TASKS-SKILLS.md).
   * Their repo/ is written by hand, not built from a fixture or an exercise.
   */
  skill?: string;
  /** Skill tasks only: the visible test command, or null for none. */
  visibleCmd?: string | null;
  /** Skill tasks only: protected globs (default tests/**). */
  protect?: string[];
}

const TTT_NOTES = [
  "- `gamestate(board)` gets the board as an array of three strings, one per row, top row first. Each string has three characters: `X`, `O`, or a space for an empty cell. For example: `['XOO', 'X  ', 'X  ']`.",
  "- It returns one of the strings `'ongoing'`, `'draw'` or `'win'`.",
  '- For an invalid board it throws an `Error` with one of these exact messages:',
  '  - `Wrong turn order: X went twice`',
  '  - `Wrong turn order: O started`',
  '  - `Impossible board: game should have ended after the game was won`',
].join('\n');

const REACT_NOTES = [
  '- `new InputCell(value)` holds a value. Read it with the `value` property. Change it with `setValue(newValue)`.',
  '- `new ComputeCell(inputCells, fn)` gets an array of cells and a function. Its `value` property is `fn(inputCells)`. Input cells and compute cells can both be inputs.',
  '- `new CallbackCell(fn)` is a callback. Attach it with `computeCell.addCallback(callbackCell)` and detach it with `computeCell.removeCallback(callbackCell)`.',
  '- A callback cell has a `values` array that starts empty. Each time the callback fires for a compute cell, it calls `fn(computeCell)` and pushes the result onto `values`.',
].join('\n');

const XORCISM_NOTES = 'The hidden tests run with `--all-features`, so the tests behind the `io` feature count like all the others. Implement `reader` and `writer` too.';

const LIMIT = { easy: 600, medium: 900, hard: 1200 } as const;

const py = (file: string): HiddenRun => ({ cmd: `python3 {bench}/runners/unittest_json.py ${file}`, format: 'unittest-json', env: {} });
const bun = (target: string, env: Record<string, string> = { TZ: 'UTC' }): HiddenRun => ({ cmd: `bun test ${target}`, format: 'bun', env });

export const CATALOG: CatalogEntry[] = [
  {
    id: 'pg-rs-luhn-from',
    title: 'Luhn with the From trait',
    kind: 'polyglot',
    lang: 'rust',
    difficulty: 'easy',
    smoke: true,
    exercise: 'rust/luhn-from',
    hiddenFiles: { 'hidden/tests/luhn-from.rs': 'tests/luhn-from.rs' },
    runs: [{ cmd: 'cargo test --offline --test luhn-from -- --include-ignored', format: 'cargo', env: {} }],
  },
  {
    id: 'pg-py-bowling',
    title: 'Bowling score',
    kind: 'polyglot',
    lang: 'python',
    difficulty: 'medium',
    exercise: 'python/bowling',
    hiddenFiles: { 'hidden/tests/bowling_test.py': 'bowling_test.py' },
    runs: [py('bowling_test.py')],
  },
  {
    id: 'pg-js-tic-tac-toe',
    title: 'State of tic-tac-toe',
    kind: 'polyglot',
    lang: 'javascript',
    difficulty: 'medium',
    exercise: 'javascript/state-of-tic-tac-toe',
    notes: TTT_NOTES,
    hiddenFiles: { 'hidden/tests/state-of-tic-tac-toe.spec.js': 'state-of-tic-tac-toe.spec.js' },
    runs: [bun('./state-of-tic-tac-toe.spec.js', {})],
  },
  {
    id: 'pg-go-word-search',
    title: 'Word search',
    kind: 'polyglot',
    lang: 'go',
    difficulty: 'medium',
    exercise: 'go/word-search',
    hiddenFiles: { 'hidden/tests/word_search_test.go': 'word_search_test.go' },
    runs: [{ cmd: 'go test -json ./...', format: 'go-json', env: {} }],
  },
  {
    id: 'pg-py-sgf-parsing',
    title: 'SGF parsing',
    kind: 'polyglot',
    lang: 'python',
    difficulty: 'hard',
    exercise: 'python/sgf-parsing',
    hiddenFiles: { 'hidden/tests/sgf_parsing_test.py': 'sgf_parsing_test.py' },
    runs: [py('sgf_parsing_test.py')],
  },
  {
    id: 'pg-js-react',
    title: 'Reactive cells',
    kind: 'polyglot',
    lang: 'javascript',
    difficulty: 'hard',
    exercise: 'javascript/react',
    notes: REACT_NOTES,
    hiddenFiles: { 'hidden/tests/react.spec.js': 'react.spec.js' },
    runs: [bun('./react.spec.js', {})],
  },
  {
    id: 'pg-go-forth',
    title: 'Forth evaluator',
    kind: 'polyglot',
    lang: 'go',
    difficulty: 'hard',
    exercise: 'go/forth',
    hiddenFiles: { 'hidden/tests/forth_test.go': 'forth_test.go' },
    runs: [{ cmd: 'go test -json ./...', format: 'go-json', env: {} }],
  },
  {
    id: 'pg-rs-xorcism',
    title: 'Xorcism streaming adaptors',
    kind: 'polyglot',
    lang: 'rust',
    difficulty: 'hard',
    exercise: 'rust/xorcism',
    notes: XORCISM_NOTES,
    hiddenFiles: { 'hidden/tests/xorcism.rs': 'tests/xorcism.rs' },
    runs: [{ cmd: 'cargo test --offline --all-features --test xorcism -- --include-ignored', format: 'cargo', env: {} }],
  },
  {
    id: 'bug-ts-cents',
    title: 'Report total one cent short',
    kind: 'bug',
    lang: 'typescript',
    difficulty: 'medium',
    base: 'ledgerkit',
    overlay: true,
    naive: true,
    hiddenFiles: { 'hidden/tests/cents.test.ts': 'tests/hidden/cents.test.ts' },
    runs: [bun('./tests/hidden/')],
  },
  {
    id: 'bug-ts-timezone',
    title: 'March 31 missing in Berlin',
    kind: 'bug',
    lang: 'typescript',
    difficulty: 'hard',
    base: 'ledgerkit',
    overlay: true,
    naive: true,
    hiddenFiles: { 'hidden/tests/timezone.test.ts': 'tests/hidden/timezone.test.ts' },
    runs: [bun('./tests/hidden/', { TZ: 'Europe/Berlin' }), bun('./tests/hidden/', { TZ: 'America/Los_Angeles' })],
  },
  {
    id: 'bug-ts-config',
    title: 'Currency flag ignored with a config file',
    kind: 'bug',
    lang: 'typescript',
    difficulty: 'medium',
    base: 'ledgerkit',
    overlay: true,
    naive: true,
    hiddenFiles: { 'hidden/tests/config.test.ts': 'tests/hidden/config.test.ts' },
    runs: [bun('./tests/hidden/')],
  },
  {
    id: 'bug-py-retry',
    title: 'Retry hot loop',
    kind: 'bug',
    lang: 'python',
    difficulty: 'medium',
    base: 'tasksd',
    overlay: true,
    naive: true,
    hiddenFiles: { 'hidden/tests/test_hidden_retry.py': 'tests/hidden/test_hidden_retry.py' },
    runs: [py('tests/hidden')],
  },
  {
    id: 'bug-py-utf8',
    title: 'Truncated JSON for non-ASCII titles',
    kind: 'bug',
    lang: 'python',
    difficulty: 'easy',
    base: 'tasksd',
    overlay: true,
    naive: true,
    hiddenFiles: { 'hidden/tests/test_hidden_utf8.py': 'tests/hidden/test_hidden_utf8.py' },
    runs: [py('tests/hidden')],
  },
  {
    id: 'bug-py-cursor',
    title: 'Paging repeats and skips tasks',
    kind: 'bug',
    lang: 'python',
    difficulty: 'hard',
    base: 'tasksd',
    overlay: true,
    naive: true,
    hiddenFiles: { 'hidden/tests/test_hidden_paging.py': 'tests/hidden/test_hidden_paging.py' },
    runs: [py('tests/hidden')],
  },
  {
    id: 'feat-ts-json',
    title: 'report --format json',
    kind: 'feature',
    lang: 'typescript',
    difficulty: 'easy',
    base: 'ledgerkit',
    hiddenFiles: { 'hidden/tests/json.test.ts': 'tests/hidden/json.test.ts' },
    runs: [bun('./tests/hidden/')],
  },
  {
    id: 'feat-ts-money',
    title: 'formatMoney refactor',
    kind: 'feature',
    lang: 'typescript',
    difficulty: 'medium',
    base: 'ledgerkit',
    hiddenFiles: { 'hidden/tests/money-format.test.ts': 'tests/hidden/money-format.test.ts' },
    runs: [bun('./tests/hidden/')],
  },
  {
    id: 'feat-py-attempts',
    title: 'GET /tasks/{id}/attempts',
    kind: 'feature',
    lang: 'python',
    difficulty: 'medium',
    base: 'tasksd',
    hiddenFiles: { 'hidden/tests/test_hidden_attempts.py': 'tests/hidden/test_hidden_attempts.py' },
    runs: [py('tests/hidden')],
  },
  {
    id: 'feat-py-purge',
    title: 'purge --dry-run with durations',
    kind: 'feature',
    lang: 'python',
    difficulty: 'easy',
    smoke: true,
    base: 'tasksd',
    hiddenFiles: { 'hidden/tests/test_hidden_purge.py': 'tests/hidden/test_hidden_purge.py' },
    runs: [py('tests/hidden')],
  },
];

/**
 * Tasks that need knowledge from a hub skill (TASKS-SKILLS.md). Not part of
 * the 18-task set: select them with `--tasks skills` or by id.
 */
export const SKILL_CATALOG: CatalogEntry[] = [
  {
    id: 'skill-api-haiku',
    title: 'Ticket triage onto the newest Haiku',
    kind: 'skill',
    lang: 'python',
    difficulty: 'medium',
    skill: 'claude-api',
    visibleCmd: 'python3 -m unittest discover -s tests',
    naive: true,
    hiddenFiles: { 'hidden/tests/test_hidden_haiku.py': 'tests/hidden/test_hidden_haiku.py', 'hidden/tests/fake_api.py': 'tests/hidden/fake_api.py' },
    runs: [py('tests/hidden')],
  },
  {
    id: 'skill-api-sonnet-tools',
    title: 'Invoice extractor onto Sonnet 5.5, thinking off',
    kind: 'skill',
    lang: 'typescript',
    difficulty: 'hard',
    skill: 'claude-api',
    visibleCmd: 'bun test ./tests/visible/',
    protect: ['tests/**', 'package.json', 'bunfig.toml'],
    naive: true,
    hiddenFiles: { 'hidden/tests/sonnet.test.ts': 'tests/hidden/sonnet.test.ts', 'hidden/tests/fake-api.ts': 'tests/hidden/fake-api.ts' },
    runs: [bun('./tests/hidden/')],
  },
];

export const REQUIRES: Record<CatalogEntry['lang'], string> = { python: 'python3', javascript: 'bun', typescript: 'bun', go: 'go', rust: 'cargo' };

const COMMON_ARTIFACTS = ['node_modules/', 'target/', '__pycache__/', '.pytest_cache/', '.bench-moved/', '*.pyc', 'tasksd.db', '.DS_Store'];

/** The task.json body for a catalog entry. */
export function taskJson(e: CatalogEntry, expectedTotal: number | null): Record<string, unknown> {
  const isPg = e.kind === 'polyglot';
  if (e.kind === 'skill') {
    return {
      id: e.id,
      title: e.title,
      kind: e.kind,
      lang: e.lang,
      difficulty: e.difficulty,
      time_limit_s: LIMIT[e.difficulty],
      smoke: false,
      requires: [REQUIRES[e.lang]],
      source: { type: 'standalone', skill: e.skill },
      visible_test_cmd: e.visibleCmd ?? null,
      hidden: { files: e.hiddenFiles, clear: ['tests/hidden/'], runs: e.runs, timeout_s: 120, expected_total: expectedTotal, restore: [], move_aside: [] },
      protected: e.protect ?? ['tests/**'],
      artifacts: COMMON_ARTIFACTS,
      reference: 'hidden/reference/',
      naive: e.naive ? 'hidden/naive/' : null,
      license: { name: 'written for this kit', holder: null, file: null },
    };
  }
  const protectedGlobs = isPg
    ? ({
        python: ['*_test.py'],
        javascript: ['*.spec.js', 'package.json', 'bunfig.toml'],
        typescript: [],
        go: ['*_test.go', 'go.mod'],
        rust: ['tests/**'],
      }[e.lang] as string[])
    : e.base === 'ledgerkit'
      ? ['test/**', 'tests/**', 'package.json', 'bunfig.toml']
      : ['tests/**'];
  const restore = isPg
    ? ({ python: [], javascript: ['package.json', 'bunfig.toml'], typescript: [], go: ['go.mod', 'cases_test.go'], rust: [] }[e.lang] as string[])
    : e.base === 'ledgerkit'
      ? ['package.json', 'bunfig.toml']
      : [];
  return {
    id: e.id,
    title: e.title,
    kind: e.kind,
    lang: e.lang,
    difficulty: e.difficulty,
    time_limit_s: LIMIT[e.difficulty],
    smoke: !!e.smoke,
    requires: [REQUIRES[e.lang]],
    source: isPg
      ? { type: 'polyglot', repo: 'https://github.com/Aider-AI/polyglot-benchmark', commit: POLYGLOT_COMMIT, exercise: e.exercise }
      : { type: 'fixture', base: e.base, overlay: e.overlay ? 'overlay/' : null },
    visible_test_cmd: isPg ? null : e.base === 'ledgerkit' ? 'bun test' : 'python3 -m unittest discover -s tests',
    hidden: {
      files: e.hiddenFiles,
      clear: isPg ? [] : ['tests/hidden/'],
      runs: e.runs,
      timeout_s: e.lang === 'rust' ? 600 : e.lang === 'go' ? 300 : 120,
      expected_total: expectedTotal,
      restore,
      move_aside: e.lang === 'go' ? ['*_test.go'] : [],
    },
    protected: protectedGlobs,
    artifacts: COMMON_ARTIFACTS,
    reference: 'hidden/reference/',
    naive: e.naive ? 'hidden/naive/' : null,
    license: isPg ? { name: 'MIT', holder: 'Exercism', file: 'NOTICE' } : { name: 'written for this kit', holder: null, file: null },
  };
}
