/**
 * CENSUS-DERIVATION TRIPWIRE (P2-20 / S-3) — a gate that censuses the tree
 * DERIVES its corpus, FLOORS the walk's own result, and takes its ROOTS from a
 * registered shared lister.
 *
 * THE DEFECT CLASS. The 2026-08-26 audit found five gates (GATE-30, -31, -34,
 * -35, -37) whose index row promised a total census while the gate iterated a
 * hand array (GATE-37) or walked a HARD-CODED SUBSET ROOT (the other four:
 * `client/dedalo` without `tools/*\/js`, `tools/` without `src/`, `src/`
 * without `tools/`, `test/unit` non-recursively). A new file, widget or key was
 * outside the census the moment it was written and the gate stayed green. The
 * per-gate fixes landed (dab019eb30); this file is the META-RULE those fixes
 * were instances of, so the class cannot be re-introduced one gate at a time.
 *
 * THE CENSUS IS THE INDEX, TOTAL. Every line of `engineering/TRIPWIRES.md`
 * that names a `test/...` gate is a row — with or without a closing `|` (the
 * first version required one and silently dropped three rows, two of them
 * offenders: the parsed count is asserted EQUAL to the count of gate-naming
 * lines). Each row is classified from its gate's SOURCE (comments stripped) —
 * never from the row's wording, so a gate cannot opt out by not shouting a
 * word. Three shapes:
 *
 *  1. WALKING GATE — a tree/registry derivation in CODE (`readdirSync`,
 *     `Glob`, `scanSync` — matched with every string, template and regex
 *     literal BLANKED, so a control template or a hand-array member that SAYS
 *     `readdirSync` is text), or one that lives in a string judged on the
 *     literal itself (`'ls-files'` as a process argument, `from
 *     '../fixtures/….json'`), in the gate or in a module it imports from the
 *     shared test infrastructure (`test/helpers/`, `scripts/`, `publication/`
 *     — never the engine under test). It must carry a BOUND FLOOR: a
 *     `toBeGreaterThan(<n ≥ 0>)` / `toBeGreaterThanOrEqual(<n ≥ 1>)` — an int
 *     or a SCREAMING const resolved to its value, so `>= 0` (or `>= ZERO`
 *     with `const ZERO = 0`), which an EMPTY walk satisfies, is no floor — (or
 *     an exact literal set) whose `expect(...)` argument names something BOUND
 *     TO THE WALK, and that EXECUTES: an unconditional statement of a live
 *     `test`/`describe` body (not `test.skip`/`.todo`, not behind
 *     `if (n > 0)`, not per-element inside a loop over the walk, not in a
 *     helper that may never be called, not inside a string). Binding is
 *     resolved BY POSITION over DECLARATIONS — `const`/`let`, `function`,
 *     every parameter (which shadows), every loop variable (bound to what it
 *     iterates): a declaration is bound when its body holds a derivation or
 *     uses a bound name outside a literal and not as an object key, where a
 *     call of a bound function counts only if no argument is a SYNTHETIC
 *     INPUT (an unbound object/Map/Set/string literal, or an array of FILE
 *     paths — a hand-written corpus a control feeds to the real helper); a
 *     name a bound block mutates is bound. A floor on an unrelated value, on
 *     a control's result, or a parked floor is no floor. Walking gates that
 *     still lack one are the `FLOORLESS_WALK_BASELINE` (shrink-only, each
 *     entry self-tested to still be floorless — the debt cannot be paid
 *     silently, nor grow). The bracket tracker under all of this is
 *     self-tested to close EVERY registered gate at depth 0 (a regex it read
 *     as division once desynced seven gates' verdicts).
 *
 *  2. HAND-CORPUS GATE — no derivation anywhere, but an array literal of three
 *     or more repo paths: the GATE-37 shape. Allowed only as an ENUMERATED
 *     entry with its reason (a reasoned policy list is not a corpus).
 *
 *  3. Everything else makes no census and is left alone.
 *
 * A row that says TOTAL/TOTALITY in the index (the machine-read claim) is held
 * to shape 1 with the bound floor, or is one of at most five ENUMERATED
 * closed-set exemptions (a registry constant, one builder's emitted SQL, a type
 * union pinned by `Exclude<…>` to `never`, a scenario axis the gate builds) — a claim over a closed in-code set
 * has no tree to walk. Each exemption carries a `corpusToken` whose presence,
 * and whose row's claim, are self-tested.
 *
 * ROOTS ARE DECLARED, NOT CHOSEN IN-FILE — AND THE DECLARATION IS CHECKED
 * AGAINST THE ARGUMENT OF THE WALK. The subset-root defect is a root list that
 * lives inside one gate. The rule: a gate that CHOOSES a walk root — by its own
 * `readdirSync`/`Glob`/`git ls-files` call, or by the argument it hands a
 * parameterized shared lister — is in `PRIVATE_ROOT_WALKERS`, a shrink-only,
 * capped baseline whose every entry WRITES THE ROOTS ITS WALKS ARE FED, ONE
 * GROUP PER WALK SITE (`ROOTS: \`src\` \`tools\` ×3; \`test\``) plus the count of
 * sites this rule cannot read (`[opaque: n]`) — and the entry is held EQUAL to
 * what the evaluator below finds: not "is the root spelled somewhere in the
 * file" (an allowlist string or a fixture path spells `tools/` while the walk
 * no longer visits it) but what each derivation call is FED. The evaluator
 * reads the call's argument symbolically: string, template and brace literals;
 * `join`/`resolve`/`dirname`; `import.meta.dir`; a variable's initializer (by
 * position); a loop variable's iterated elements (array, object keys/entries,
 * destructured by index or key); a PARAMETER's arguments at every call site of
 * its function — in the gate or in a shared module, through the import that
 * names it — or the receiver a callback is mapped over; a function call's
 * returns; a `.scanSync` cwd combined with its Glob's pattern; `git ls-files`
 * pathspecs under `-C`/`cwd:`. A path is a root only when it normalizes to a
 * TRACKED repo directory (from the git index; a scratch tree resolves to
 * nothing); the repo root itself narrows nothing, so a gate that hands
 * `REPO_ROOT` to a lister chose no root, while one that hands `src/core` did.
 * A site whose argument is beyond the evaluator is OPAQUE — counted, never a
 * silent root — and so is a site fed through a NARROWING it cannot decide:
 * a predicate method over the root candidates (`.filter`/`.find`/`.slice(1)`;
 * `.sort()`/`.slice()` reorder or copy and narrow nothing), a conditional
 * expression (`flag ? SRC_ONLY : ALL`), or a root loop whose body leaves an
 * iteration before the walk (`if (prefix === 'tools/') continue`) or tests a
 * root-bound name — before the walk or in the loop over its results
 * (`if (prefix) continue` discards every tools file by its root). GATE-34's
 * outcome spelled as control flow instead of a dropped literal reads as
 * `[opaque: 1]`, a reviewer's eye, never as the over-approximated feed. The
 * sift a recursive walker applies to LISTING RESULTS (`continue` on
 * node_modules, then `walk(child)`) narrows names under the root, not the
 * root, and is not opaque; nor is a per-file exclusion whose condition also
 * names the result variable. A NEW walking gate imports a registered shared lister instead.
 * Every shared module a gate reaches under `test/helpers/` or `scripts/` that
 * walks or chooses is in `SHARED_LISTERS`, the ONE place the repo's corpus
 * root sets are written down: membership is DERIVED (reached-but-unregistered
 * or registered-but-gone is red), and each entry's root groups are held equal
 * to what the lister's sites are fed across every gate that reaches it (a
 * parameterized lister's group is the union of what its callers hand it; a
 * known subset is written next to the roots — `env_key_scan` walks `src/`
 * while `scripts/` reads keys too — so the gap lives where the roots are).
 * The write-path class (`sql_confinement`, `ws_a`, `matrix_counter_monotonic`,
 * the `section_record` chokepoint grep) shares `write_path_corpus.ts`, rooted
 * at `src/`+`tools/`+`scripts/` (positive control: a script that mass-rewrites
 * matrix jsonb), and owns no private walk.
 *
 * HONEST LIMIT. Binding (for floors) and evaluation (for roots) are lexical
 * and scope-approximate: a name resolves to the last declaration of that
 * spelling before its use, a function body may resolve a module constant
 * forward, a call's arguments are joined as a cartesian product over every
 * call site. The evaluator cannot read a root computed by string surgery, a
 * method result or a runtime value — those sites are opaque and the entry must
 * say how many. Narrowing is detected by SHAPE, not evaluated: a predicate
 * whose result is a constant reads as opaque all the same; a short-circuit
 * guard (`prefix === '' && walk(root)`), or a sift of the walk's results whose
 * condition also names the result variable (`if (prefix && rel) continue`) or
 * goes through a boolean computed a statement earlier, read as the whole
 * feed. It cannot judge whether a subtree root (`src/external`) IS the
 * whole corpus of what a gate claims, nor whether a hand array beside a walk
 * is the corpus or a ratchet over it — those stay a reviewer's call, and the
 * written per-site groups make the choice reviewable in one place. Every
 * decision is a pure function over (row, gate source, module sources),
 * exercised below on synthetic positive and negative controls — the five
 * audit defects re-planted verbatim among them — so each leg is
 * mutation-verifiable.
 *
 * Hermetic: fs-only (plus one `git ls-files` for the tracked-directory set),
 * imports no src/ module.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { stripComments } from '../helpers/strip_comments.ts';
import {
	REPO_ROOT,
	WRITE_PATH_CORPUS_FLOOR,
	WRITE_PATH_ROOTS,
	writePathSourceFiles,
} from '../helpers/write_path_corpus.ts';

const TRIPWIRE_INDEX = join(REPO_ROOT, 'engineering', 'TRIPWIRES.md');

// ---------------------------------------------------------------------------
// Grammar and evidence tokens — ONE definition each, used by the classifier
// and by the controls.
// ---------------------------------------------------------------------------

/** Whole-word, UPPERCASE TOTAL / TOTALITY in a row's invariant cell. */
const CLAIM_PATTERN = /\bTOTAL(?:ITY)?\b/;

/**
 * A tree or registry derivation IN CODE: a directory walk. Matched over the
 * gate with every string, template and regex literal BLANKED — a token spelled
 * inside a literal (a control template, a reason string, a hand array member
 * that says `readdirSync`) is text, not a walk.
 */
const CODE_DERIVATION_TOKENS: readonly RegExp[] = [
	/\breaddirSync\s*\(/,
	/\breaddir\s*\(/,
	/\bnew\s+Glob\s*\(/,
	/\bBun\.Glob\b/,
	/(?<!\.)\.scanSync\s*\(/,
	/(?<!\.)\.scan\s*\(/,
];

/**
 * The two derivations that LIVE IN A STRING: the git index (`'ls-files'` as a
 * process argument, or `'git ls-files …'` as a command) and a frozen census
 * fixture (`from '../fixtures/….json'`). Each is judged on a TOP-LEVEL literal
 * — its own content and the code that precedes it — so a literal that merely
 * quotes such a call (`"execSync('git ls-files')"`) is prose about a walk.
 */
const GIT_INDEX_LITERAL = /^(?:git\s+(?:-C\s+\S+\s+)?)?ls-files\b/;
const FIXTURE_IMPORT_LITERAL = /^\.\.\/fixtures\/[^']+\.json$/;
const IMPORT_FROM_TAIL = /\bfrom\s*$/;

/** Every recognised derivation shape, for the messages. */
const DERIVATION_SHAPES = CODE_DERIVATION_TOKENS.length + 2;

/** What follows an `expect(...)` for it to be a numeric floor: `.toBeGreaterThan[OrEqual](<int | SCREAMING_CONST>)`. */
const FLOOR_MATCHER = /^\s*\.toBeGreaterThan(OrEqual)?\s*\(\s*(\d+|[A-Z][A-Z0-9_]+)\s*\)/;

/**
 * The other honest floor: an EXACT expected set with at least one literal
 * member — `.toEqual(['src/x.ts', …])`. An emptied walk cannot equal it.
 */
const EXACT_SET_MATCHER = /^\s*\.toEqual\s*\(\s*\[\s*'[^']+'/;

/** Where a corpus may legitimately be derived OUTSIDE the gate: shared test infrastructure. */
const SHARED_MODULE_PREFIXES = ['test/helpers/', 'scripts/', 'publication/'] as const;

/** The registry domain: shared listers whose root sets this file writes down. */
const REGISTERED_LISTER_PREFIXES = ['test/helpers/', 'scripts/'] as const;

/** A repo-path string literal: `'src/…'`, `'client/…'`, `'test/…'`, … */
const REPO_PATH_LITERAL =
	"'(?:src|tools|scripts|client|test|docs|engineering|deploy|publication|mcp|install|\\.github)\\/[^'\\s]+'";

/**
 * An array or object literal holding three or more repo paths (as members, or
 * as keys with a value each) — the hand-corpus shape, GATE-37's `owners`
 * object included.
 */
const HAND_PATH_LITERAL = new RegExp(
	`[[{]\\s*(?:${REPO_PATH_LITERAL}\\s*(?::\\s*[^,]*)?,\\s*){2,}${REPO_PATH_LITERAL}`,
);

// ---------------------------------------------------------------------------
// Enumerated lists — every one shrink-only and self-tested against the tree.
// ---------------------------------------------------------------------------

interface ClosedSetExemption {
	file: string;
	/** A token that must still appear in the file — the closed set the claim is over. */
	corpusToken: string;
	reason: string;
}

/**
 * TOTAL claims over a CLOSED IN-CODE SET — no tree to walk. Capped; a new entry
 * is a design review, not a reflex for a red gate.
 */
const ENUMERATED_CLOSED_SET_CENSUSES: readonly ClosedSetExemption[] = [
	{
		file: 'test/unit/media_thumb_census_tripwire.test.ts',
		corpusToken: 'THUMB_SOURCE_BY_MODEL',
		reason:
			'The census is the five `component_*` media models keyed in `THUMB_SOURCE_BY_MODEL` / `POSTERFRAME_WRITER_BY_MODEL` (src/core/concepts/media.ts), asserted by EXACT key equality against the model list — a closed registry constant, not a tree.',
	},
	{
		file: 'test/unit/duplicate_record_dataframe_native.test.ts',
		corpusToken: 'MATRIX_JSONB_COLUMNS',
		reason:
			'The TOTAL claim is over the matrix jsonb COLUMNS (`MATRIX_JSONB_COLUMNS`, src/core/db/matrix.ts), a closed engine constant; the frame-target sweep reads every column of it, and a column added to the engine is in the sweep by construction.',
	},
	{
		file: 'test/unit/search_path_acl_native.test.ts',
		corpusToken: 'function joinAliases(',
		reason:
			'The census is over the join aliases PARSED FROM THE EMITTED SQL of one builder (`joinAliases`), not from the tree — the corpus is whatever the builder produced for the scenario, and the alias count is asserted per scenario.',
	},
	{
		file: 'test/unit/backup_restorability_native.test.ts',
		corpusToken: 'const STATES: ArtifactState[]',
		reason:
			'The TOTAL claim is over the ARTIFACT-STATE axis (absent, empty, in-progress, truncated, header-cut, foreign-format, clean) — a scenario matrix the gate BUILDS from real pg_dump bytes; no registry or tree lists artifact states, so there is nothing to derive it from. The src/ caller walk in the same file is a separate, floorless check.',
	},
	{
		file: 'test/unit/external_degradation_tripwire.test.ts',
		corpusToken: 'Exclude<ExternalSourceState',
		reason:
			'The TOTALITY claim is over the closed `ExternalSourceState` union: `ALL_STATES` is `as const satisfies` the union and `Exclude<ExternalSourceState, …>` is pinned to `never`, so a state added to the union without a mapping fails `tsc` — totality at the type level, which no directory walk expresses.',
	},
];

/** Hard cap on the closed-set list — the class is meant to stay this small. */
const CLOSED_SET_EXEMPTION_CAP = 5;

/**
 * Gates that hold an array of repo paths and derive nothing — each a reasoned
 * POLICY list, not a corpus. Shrink-only; every entry must still match the
 * hand-corpus shape or it is stale.
 */
const ENUMERATED_HAND_PATH_LISTS: Readonly<Record<string, string>> = {
	// (2026-10-21) lint_scope_tripwire left this list: it now reads the daemon
	// package census from test/helpers/daemon_package_corpus.ts, a registered lister.
};

/**
 * WALKING GATES WITHOUT A BOUND FLOOR — the vacuity debt, per file. An entry
 * is either DEBT (the walk's result is never floored: an emptied walk passes)
 * or NOT-A-CENSUS (the walk lists runtime state, not a corpus). Shrink-only:
 * an entry that gains a bound floor, or stops walking, must be deleted.
 */
const FLOORLESS_WALK_BASELINE: Readonly<Record<string, string>> = {
	'test/parity/oracle_canary.test.ts': 'DEBT: the parity-file glob is never floored by the canary.',
	'test/unit/agent_alias_tripwire.test.ts':
		'NOT-A-CENSUS: `git ls-files -s -- <path>` queries the index mode of ONE named symlink.',
	'test/unit/config_declaration_tripwire.test.ts':
		'DEBT: `envKeysReadInSrc()` is consumed without a floor (the 264 floor is on the catalog, not the scan).',
	'test/unit/bulk_process_id_tripwire.test.ts':
		'DEBT: `censusBulkDoors()` is never floored (floors are on the rows the doors write).',
	'test/unit/client_relation_move_native.test.ts':
		'NOT-A-CENSUS: `readdirSync` lists a scratch media directory the test itself created.',
	'test/unit/config_census_tripwire.test.ts':
		'DEBT: `envKeysReadInSrc()` is consumed without a floor (the 150 floor is on the catalog, not the scan).',
	'test/unit/config_env_tripwire.test.ts': 'DEBT: the {src,tools,scripts} glob is never floored.',
	'test/unit/crap_complexity_ratchet.test.ts':
		'DEBT: the CRAP scan (`scripts/crap_baseline.ts` over `scripts/lib/complexity.ts`) is never floored — the 200 floor is on the committed baseline JSON, not on the files the scan visited.',
	'test/unit/docs_current_engine_tripwire.test.ts':
		'DEBT: `docsTextFiles()` is never floored (the only floor is on allowlist reasons).',
	'test/unit/date_flat_value_single_source_tripwire.test.ts':
		'DEBT: the recursive `readdirSync` walk is never floored.',
	'test/unit/diffusion_boundaries.test.ts': 'DEBT: the src/ boundary glob is never floored.',
	'test/unit/hierarchy_single_writer_tripwire.test.ts':
		'DEBT: the recursive `readdirSync` walk is never floored.',
	'test/unit/import_scc_tripwire.test.ts': 'DEBT: the src/ + tools/ import walk is never floored.',
	'test/unit/info_widget_registry_tripwire.test.ts':
		'DEBT: the two widget-directory walks are never floored (the 11 floor is on the registry).',
	'test/unit/labels_tripwire.test.ts':
		'DEBT: the catalog-directory listing is never floored (floors are on master.json keys and exemptions).',
	'test/unit/local_db_stores_tripwire.test.ts':
		'DEBT: the `readdirSync` store walk is never floored.',
	'test/unit/log_section_policy_tripwire.test.ts':
		'DEBT: the recursive `readdirSync` walk is never floored.',
	'test/unit/media_job_target_tripwire.test.ts':
		'DEBT: the recursive `readdirSync` walk is never floored.',
	'test/unit/ontology_single_writer_tripwire.test.ts':
		'DEBT: the recursive `readdirSync` walk is never floored.',
	'test/unit/proxy_trust_tripwire.test.ts': 'DEBT: the src/ proxy-trust glob is never floored.',
	'test/unit/remove_sentinel_native.test.ts':
		'DEBT: `scanFiles()` over src/ is never floored (floors are on call sites and reasons).',
	'test/unit/runtime_paths_census_tripwire.test.ts':
		'DEBT: `sourceFiles()` is never floored (floors are on census entries and reasons).',
	'test/unit/seed_definitions_equality_tripwire.test.ts':
		'DEBT: the migrations glob is never floored (floors are on the seed file and the declarations).',
	'test/unit/tm_mode_retired_tripwire.test.ts':
		'DEBT: the recursive `readdirSync` walk is never floored (floors are on exemptions).',
};

/**
 * GATES THAT CHOOSE A WALK ROOT — by a derivation call of their own, or by the
 * argument they hand a parameterized shared lister. The subset-root defect
 * class is a root list nobody else can see, so every entry WRITES THE ROOTS
 * ITS WALKS ARE FED here, where they are reviewable in one place, and the
 * entry is held EQUAL to what the evaluator reads off each walk's argument:
 *
 *  - `ROOTS: \`a\` \`b\`; \`c\` ×2 …` — ONE GROUP PER WALK SITE, `;`-separated,
 *    `×N` for N sites over the same set; each root a tracked repo directory
 *    (`.` is the whole repo). The list ends at the first token that is not a
 *    backticked root; what follows is prose.
 *  - `[opaque: n]` — n sites whose argument the evaluator cannot read (a
 *    scratch tree, a runtime value, a root list passed through a predicate, a
 *    conditional, or a guarded root loop): acknowledged, never a silent root.
 *  - `NO-ROOT: …` — every site resolves to no repo directory: a frozen fixture,
 *    named files in the git index, a scratch tree the test itself built.
 *
 * A NEW walking gate imports a registered shared lister instead. Shrink-only,
 * capped, self-tested: an entry whose gate stops choosing must be deleted.
 */
const PRIVATE_ROOT_WALKERS: Readonly<Record<string, string>> = {
	'test/parity/oracle_canary.test.ts':
		'ROOTS: `test/parity` — the parity gates beside it, `*.test.ts` under import.meta.dir.',
	'test/unit/agent_alias_tripwire.test.ts':
		'NO-ROOT: `git ls-files -s` on the two named alias symlinks.',
	'test/unit/backup_restorability_native.test.ts':
		'ROOTS: `src` — the src/ caller walk; the artifact-state readdirSync reads scratch directories the gate builds, which resolve to no repo directory.',
	'test/unit/batch_scope_tripwire.test.ts': 'ROOTS: `tools` — the tool servers, `*/server/**`.',
	'test/unit/boundary_seam_tripwire.test.ts':
		'ROOTS: `src`; `tools` — the engine tree, and the tool servers that reach it by relative path.',
	'test/unit/build_context_secret_tripwire.test.ts':
		'ROOTS: `.` ×3; `deploy` — `git ls-files` over the whole index, the deploy/ tree, and a scratch build-context tree that resolves to no repo directory.',
	'test/unit/bulk_process_id_tripwire.test.ts': 'ROOTS: `src` `tools`.',
	'test/unit/catalog_behaviour_tripwire.test.ts':
		'ROOTS: `client` `src` `tools` — PRODUCTION_ROOTS.',
	'test/unit/census_derivation_tripwire.test.ts':
		'ROOTS: `.` ×2 — this gate: `git ls-files` for the tracked-directory set every written root is checked against.',
	'test/unit/ci_workflow_tripwire.test.ts':
		'ROOTS: `.github/workflows`; `.github/workflows-selfhosted`; `scripts` `test`.',
	'test/unit/client_caller_chain_tripwire.test.ts': 'ROOTS: `client/dedalo/core` `tools`.',
	'test/unit/client_error_contract_tripwire.test.ts':
		"ROOTS: `client/dedalo` `tools` ×3; `src` — browser JS: the corpus scan and the `git ls-files` totality check are both fed the census SCAN_ROOTS (whole trees, `**/*.js` — the retired `*/js/**` sub-path left nine tracked tool files outside, GATE-31); the third site is the shared lister's own scan reached through them; `src` is the stray-browser-JS detector.",
	'test/unit/client_idempotency_tripwire.test.ts':
		'ROOTS: `.`; `src` `tools` — src/ and tools/ plus `git ls-files` over the tracked browser JS.',
	'test/unit/client_libs_tripwire.test.ts':
		'ROOTS: `client/dedalo/core` `client/dedalo/test` `tools`.',
	'test/unit/client_relation_move_native.test.ts':
		'NO-ROOT: [opaque: 1] readdirSync lists a scratch media directory the test itself created.',
	'test/unit/coex_tag_tripwire.test.ts': 'ROOTS: `src` `tools` — one brace glob.',
	'test/unit/comment_doc_path_tripwire.test.ts':
		'ROOTS: `client` `scripts` `tools` — the three trees whose comments are scanned; the ROOTS constant there is where a cited path may EXIST, not what is walked.',
	'test/unit/component_teardown_tripwire.test.ts':
		'ROOTS: `client` `tools` — through `git ls-files`, tracked browser JS only.',
	'test/unit/compose_invocation_tripwire.test.ts': 'ROOTS: `deploy`; `docs/install`.',
	'test/unit/config_dead_field_tripwire.test.ts': 'ROOTS: `scripts` `src` `tools`.',
	'test/unit/config_env_tripwire.test.ts': 'ROOTS: `src` `tools`.',
	'test/unit/css_build_tripwire.test.ts':
		'ROOTS: `.` — `*.less` anywhere in the repo, with client/ and tools/ as the expected homes.',
	'test/unit/css_source_tripwire.test.ts':
		'ROOTS: `tools` — `git ls-files` by pattern under tools/.',
	'test/unit/date_flat_value_single_source_tripwire.test.ts': 'ROOTS: `src`.',
	'test/unit/dd128_write_census_tripwire.test.ts': 'ROOTS: `src` `tools` — servers.',
	'test/unit/dependency_integrity_tripwire.test.ts':
		'ROOTS: `.` — `git ls-files` for every tracked package.json; the committed third-party census is the shared lister scripts/lib/third_party_census.ts (registered below), and the scratch trees the positive controls build resolve to no repo directory.',
	'test/unit/deploy_env_contract_tripwire.test.ts':
		'ROOTS: `.`; `deploy` ×2 — the compose stacks at the repo root (leg G, by pattern), the deploy/ units and scripts (legs A-F), and the recursive deploy/** walk leg G reads for mirrors.',
	'test/unit/diffusion_boundaries.test.ts': 'ROOTS: `src`.',
	'test/unit/diffusion_queue_stream_tripwire.test.ts':
		'ROOTS: `client/dedalo/core/area_maintenance`; `client/dedalo/core/area_maintenance/widgets` — the area JS, and the widget LESS one level down.',
	'test/unit/docs_current_engine_tripwire.test.ts': 'ROOTS: `docs`.',
	'test/unit/docs_locator_shape_tripwire.test.ts': 'ROOTS: `docs`.',
	'test/unit/engine_install_tld_tripwire.test.ts': 'ROOTS: `src`.',
	'test/unit/engineering_currency_tripwire.test.ts': 'ROOTS: `engineering`.',
	'test/unit/error_taxonomy_tripwire.test.ts': 'ROOTS: `client/dedalo` `tools`; `src` `tools`.',
	'test/unit/external_client_render_tripwire.test.ts':
		'ROOTS: `client`; `client/dedalo/core/component_external/js`; `client/dedalo/core/services/service_autocomplete/js`.',
	'test/unit/external_config_narrowing_census.test.ts':
		'ROOTS: `src` — plus the frozen fixture test/fixtures/external/ontology_census.json.',
	'test/unit/external_degradation_tripwire.test.ts': 'ROOTS: `src` `tools`.',
	'test/unit/external_isolation_tripwire.test.ts':
		'ROOTS: `src`; `src/external` — src/ and its external/ subtree, joined from SRC_DIR.',
	'test/unit/external_outbound_tripwire.test.ts': 'ROOTS: `src/external`.',
	'test/unit/external_registry_totality_tripwire.test.ts':
		'NO-ROOT: the frozen fixture test/fixtures/external/ontology_census.json.',
	'test/unit/external_secret_confinement_tripwire.test.ts': 'ROOTS: `src`; `src/external`.',
	'test/unit/external_write_refusal_tripwire.test.ts':
		'ROOTS: `src/external` — the root it hands the parameterized `no_write_scan` lister — a private choice, so it is written here.',
	'test/unit/generic_tld_tripwire.test.ts':
		'ROOTS: `client/dedalo/test/client/js` `src/core/test_data` `test` — the registered tld_census roots re-walked one by one to prove each contributes files.',
	'test/unit/hierarchy_single_writer_tripwire.test.ts': 'ROOTS: `scripts` `src` `tools`.',
	'test/unit/html_text_tripwire.test.ts':
		'ROOTS: `src` `tools` `publication` — SCAN_GLOBS: src/**, tools/*/server/**, publication/*/src/** (non-test .ts).',
	'test/unit/import_scc_tripwire.test.ts': 'ROOTS: `src` `tools` — servers.',
	'test/unit/info_widget_registry_tripwire.test.ts':
		'ROOTS: `client/dedalo` `client/dedalo/core/widgets` ×2; `src` `test/parity` `test/unit`.',
	'test/unit/ingest_encoding_tripwire.test.ts':
		'ROOTS: `client` `src` `src/core/tools` `tools` — src/core/tools is walked on its own beside src/.',
	'test/unit/install_restart_supervisor_tripwire.test.ts':
		'ROOTS: `deploy`; `src`; `tools` — tool HTTP routes are engine routes too.',
	'test/unit/install_seed_drift_tripwire.test.ts':
		'ROOTS: `client`; `install/import/hierarchy` — the whole client tree is scanned for a re-introduced copy.',
	'test/unit/install_table_write_tripwire.test.ts':
		'ROOTS: `test` — every `*.test.ts` under test/, join(import.meta.dir, "..") — not test/unit alone.',
	'test/unit/labels_tripwire.test.ts':
		'ROOTS: `client/dedalo` `src` `tools`; `src/core/labels/catalog` — the catalog directory, and the three browser/engine trees.',
	'test/unit/local_db_stores_tripwire.test.ts': 'ROOTS: `client` `tools`.',
	'test/unit/log_section_policy_tripwire.test.ts': 'ROOTS: `src/core/resolve` `src/core/section`.',
	'test/unit/maintenance_widget_get_value_tripwire.test.ts':
		'ROOTS: `client/dedalo/core/area_maintenance/widgets` [opaque: 1].',
	'test/unit/marc_identity_native.test.ts': 'ROOTS: `tools`.',
	'test/unit/media_alternate_versions_tripwire.test.ts': 'ROOTS: `src/core/media`.',
	'test/unit/media_job_target_tripwire.test.ts': 'ROOTS: `src` `tools`.',
	'test/unit/media_writer_discipline_tripwire.test.ts': 'ROOTS: `src/core/media`.',
	'test/unit/migration_shared_row_tripwire.test.ts': 'ROOTS: `install/db/migrations`.',
	'test/unit/mock_isolation_tripwire.test.ts':
		'ROOTS: `test` — every `*.test.ts` under test/, join(import.meta.dir, "..").',
	'test/unit/module_state_tripwire.test.ts': 'ROOTS: `src` `tools` ×3.',
	'test/unit/no_remote_code_tripwire.test.ts':
		'ROOTS: `client/dedalo` `publication` `src` `tools` `vendor` — the five trees whose code may load code (GATE-54 added vendor/ and publication/).',
	'test/unit/ontology_single_writer_tripwire.test.ts': 'ROOTS: `scripts` `src` `tools`.',
	'test/unit/operator_commands_tripwire.test.ts':
		'NO-ROOT: [opaque: 5] readdirSync lists the scratch backup trees the gate builds under mkdtemp(tmpdir()) (moved out of test/ 2026-10-21: in-tree scratch raced the parallel hermetic workers).',
	'test/unit/outbound_fetch_tripwire.test.ts': 'ROOTS: `src` `tools`.',
	'test/unit/password_cost_tripwire.test.ts': 'ROOTS: `scripts` `src` `tools`.',
	'test/unit/production_entrypoint_coverage_tripwire.test.ts':
		'ROOTS: `deploy` `scripts` `src` `test` `tools` — servers.',
	'test/unit/proxy_trust_tripwire.test.ts': 'ROOTS: `src`.',
	'test/unit/ratchet_integrity_tripwire.test.ts':
		'ROOTS: `scripts` `scripts/ci`; `scripts` `test` — scripts/ (top-level and ci/) and the test tree.',
	'test/unit/release_archive_tripwire.test.ts':
		'NO-ROOT: `git ls-files -s` (tracked symlinks) and `git archive HEAD` (what a release emits).',
	'test/unit/relogin_identity_tripwire.test.ts': 'ROOTS: `client` `tools`.',
	'test/unit/remove_sentinel_native.test.ts': 'ROOTS: `client` `src` `tools`.',
	'test/unit/runtime_paths_census_tripwire.test.ts': 'ROOTS: `src`.',
	'test/unit/section_id_int_tripwire.test.ts': 'ROOTS: `src` `tools`.',
	'test/unit/seed_definitions_equality_tripwire.test.ts': 'ROOTS: `install/db/migrations` ×2.',
	'test/unit/ssrf_one_guard_tripwire.test.ts': 'ROOTS: `src` `tools`.',
	'test/unit/suite_assertion_floor_tripwire.test.ts': 'ROOTS: `test`.',
	'test/unit/temporal_instance_tripwire.test.ts': 'ROOTS: `client` `src` `tools`.',
	'test/unit/test_db_marker_tripwire.test.ts':
		'ROOTS: `install/db/migrations`; `scripts` `src` `tools`; `src`; `src/core/test_data` `test/helpers`.',
	'test/unit/test_media_root_tripwire.test.ts':
		'ROOTS: `scripts` ×2; `src` `tools` ×2; `test/preload` [opaque: 1] — the opaque site is `readdirSync` over a scratch root the gate creates.',
	'test/unit/test_rag_db_tripwire.test.ts':
		'ROOTS: `install/db`; `scripts` `src` `tools`; `test/helpers`; `test/preload`.',
	'test/unit/test_timeout_tripwire.test.ts':
		'ROOTS: `.github/workflows` `.github/workflows-selfhosted` `scripts` — the scripts and both workflow trees; test/ is NOT walked here.',
	'test/unit/thesaurus_picker_tripwire.test.ts':
		'ROOTS: `client` `client/dedalo/core/area_thesaurus/js` `client/dedalo/core/component_portal/js` `client/dedalo/core/ts_object/js` `src` `tools` — three client js/ directories on their own, plus the three trees.',
	'test/unit/tier_assignment_tripwire.test.ts': 'ROOTS: `scripts`; `scripts/ci` ×2; `test`.',
	'test/unit/tier_execution_tripwire.test.ts': 'ROOTS: `scripts/ci`.',
	'test/unit/tier_wiring_tripwire.test.ts':
		'ROOTS: `.github/workflows`; `.github/workflows-selfhosted`; `scripts/ci` ×2; `test` ×3.',
	'test/unit/tm_epoch_tripwire.test.ts': 'ROOTS: `src` `tools` — CENSUS_ROOTS.',
	'test/unit/tm_lang_slice_restore_native.test.ts': 'ROOTS: `tools/tool_time_machine/server`.',
	'test/unit/tm_mode_retired_tripwire.test.ts': 'ROOTS: `client/dedalo` `src` `tools`.',
	'test/unit/tool_header_contract_tripwire.test.ts': 'ROOTS: `tools` — `*/css/*.less`.',
	'test/unit/tool_permission_census_tripwire.test.ts':
		'ROOTS: `src/core/security` `src/core/tools` `tools`; `tools` — the tool trees plus the security layer they import their primitives from (gate roots derived, review r1).',
	'test/unit/tool_picker_wiring_tripwire.test.ts': 'ROOTS: `tools` ×2.',
	'test/unit/tools_cache_invalidation.test.ts': 'ROOTS: `src/core/tools` ×2.',
	'test/unit/update_ownership_tripwire.test.ts':
		'ROOTS: `scripts` `src` `tools`; `src` `tools` — brace globs.',
	'test/unit/vendor_advisory_tripwire.test.ts': 'ROOTS: `client/dedalo/core/component_pdf/js`.',
	'test/unit/wire_contract_tripwire.test.ts':
		'ROOTS: `.agents` `changes` `client` `deploy` `docs` `engineering` `scripts` `src` `test` `tools`; `engineering/wire_contract` — the ledger directory, and every tree that may cite an entry.',
	'test/unit/wire_field_agreement_tripwire.test.ts': 'ROOTS: `client`; `src`.',
	'test/unit/write_lang_provenance_native.test.ts': 'ROOTS: `src` `tools` ×2.',
};

/** Hard cap on the private-walker baseline — it only shrinks. */
const PRIVATE_ROOT_WALKER_CAP = 100;

/**
 * Hard cap on the walk sites this rule cannot evaluate across the baseline — each written as `[opaque: n]`.
 * 3 → 8 on 2026-10-21: operator_commands_tripwire's five scratch-tree walks moved from
 * fixed `test/.tmp-*` dirs (in-tree, racing the parallel hermetic workers) to
 * mkdtemp(tmpdir()) — a runtime root this rule cannot read, over a scratch tree, never a
 * repo root. Lower it when one goes.
 */
const OPAQUE_SITE_CAP = 8;

interface SharedLister {
	/**
	 * Repo-relative directories the lister's walks are fed, ONE GROUP PER WALK
	 * SITE (a parameterized site: the union of what every reaching gate hands
	 * it); empty when nothing it walks is a repo directory.
	 */
	roots: readonly (readonly string[])[];
	scope: string;
}

/**
 * THE REGISTRY OF SHARED CORPUS ROOT SETS — derived membership (every walking
 * module a gate reaches under the registered prefixes, no more, no fewer);
 * every root exists on disk and is spelled in the lister's source. A subset the
 * repo knows about is written next to the roots it is a subset of.
 */
const SHARED_LISTERS: Readonly<Record<string, SharedLister>> = {
	'scripts/ci/mariadb_tier.ts': {
		roots: [['test/integration', 'test/unit', 'test/parity']],
		scope:
			"the MariaDB tier's test corpus — every test file under test/integration, test/unit and test/parity (the preload arms all three), from which it walks the RUNTIME import graph (Bun's transpiler) to derive the set that acquires the suite MariaDB and the no-contact population that reaches the pool module; its SEAM_EDGES rows add each computed-import seam's glob (tools/*/server/**, src/core/**). Read by the stage itself, by suite_mariadb_target_native and by tier_wiring leg J (the starter classification).",
	},
	'test/helpers/write_path_corpus.ts': {
		roots: [['scripts', 'src', 'tools']],
		scope: 'the code that runs in the engine process — the write-path class corpus',
	},
	'test/helpers/env_key_scan.ts': {
		roots: [['src']],
		scope:
			'config keys read by call literal. KNOWN SUBSET: scripts/ and tools/ read keys through readEnv too (PUPPETEER_EXECUTABLE_PATH is read only under scripts/) — widening to the write-path roots is the open item, recorded here so the gap lives where the roots do',
	},
	'scripts/lib/change_log.ts': {
		roots: [['changes'], ['changes'], ['engineering/wire_contract']],
		scope:
			'the change log sources — changes/ and each release directory under it (two sites: the top level, then every fragment and release.json per directory), and the wire-contract ledger ids read from engineering/wire_contract/ (the release snapshot and the floor check). Read by scripts/changelog.ts and change_log_tripwire.',
	},
	'scripts/lib/docs_paths.ts': {
		roots: [['docs']],
		scope:
			'the doc pages the SITE serves — every `**/*.md` under docs/ minus the mkdocs.yml `exclude_docs` globs. The ONE implementation of that rule, imported by scripts/docs_publish.ts and by docs_versioning_tripwire (a second scan is how the two once disagreed).',
	},
	'test/helpers/css_reference_corpus.ts': {
		roots: [['.']],
		scope:
			"the tracked text that could NAME a served stylesheet — `git ls-files` over the whole index (ROOT narrows nothing), narrowed by CSS_REFERENCE_TREES — the build's own SEARCH_DIRS (client/, tools/) plus the three server-side trees that emit or install markup (src/, install/, deploy/).",
	},
	'test/helpers/shipped_text_corpus.ts': {
		roots: [['client', 'deploy', 'publication', 'scripts', 'src', 'tools']],
		scope:
			'the shipped first-party TEXT trees — every .ts/.js/.mjs/.json/.md a user or operator can be shown, installed dependencies excluded. docs/ is deliberately out: the manual may quote as example data a spelling a gate forbids elsewhere.',
	},
	'test/helpers/browser_corpus.ts': {
		roots: [
			['client', 'tools'],
			['client/dedalo', 'tools'],
		],
		scope:
			"browserSources: git's view minus vendored lib/vendor/min; browserSourcesUnfiltered: the same git view UNFILTERED (tool_lossless_writeback's client census — a tool's own lib/ helper is its code)",
	},
	'test/helpers/deploy_conf_corpus.ts': {
		roots: [
			[
				'publication/site_builder/deploy/examples/rendered-apache/etc/apache2/sites-available',
				'publication/site_builder/deploy/examples/rendered/etc/nginx/sites-available',
			],
		],
		scope:
			'the site-builder committed rendered host configurations (nginx + apache sites-available)',
	},
	'test/helpers/daemon_package_corpus.ts': {
		roots: [['.'], ['publication'], ['publication']],
		scope:
			'the DAEMON PACKAGES under publication/ (every directory, depth 1-2, with its own package.json + tsconfig.json) and the TypeScript each ships (git ls-files over publication/, partitioned by package; the `.` group is the cwd of that git call, the repo root, which narrows nothing) — read by daemon_typecheck_scope_tripwire (every shipped file in its tsc program) and lint_scope_tripwire (every package linted or budgeted)',
	},
	'test/helpers/publication_corpus.ts': {
		roots: [
			[
				'publication/server_api/v2/src',
				'publication/server_api/v2/src/mcp',
				'publication/server_api/v2/src/routes',
				'publication/site_builder/src',
				'tools/tool_sitebuilder/js',
			],
		],
		scope:
			'the standalone publication packages the engine ships beside itself — the read-only API v2 source tree (whole, and its mcp/ + routes/ entry layers), the site-builder daemon source tree, and the site-builder tool client',
	},
	'test/helpers/engine_source_corpus.ts': {
		roots: [
			[
				'src',
				'src/core/api/handlers',
				'src/core/media',
				'src/core/relations',
				'src/core/resolve',
				'src/core/search/builders',
				'src/core/section',
			],
		],
		scope:
			"the engine's own source roots for gates that census src/ — the whole tree, the API handler layer (every door a request reaches), the media subsystem (every converter spawn), the three read-path trees (relations/resolve/section) and the search fragment builders",
	},
	'test/helpers/test_tree_corpus.ts': {
		roots: [['test']],
		scope:
			"the suite's own TypeScript sources — every .ts under test/ (gates, helpers, preloads), for gates that census what test code may do (diffusion_scratch_tables_tripwire); JSON fixtures are data and out",
	},
	'test/helpers/tool_directory_corpus.ts': {
		roots: [['tools']],
		scope:
			'the tool NAMES of this checkout — every `tools/tool_<name>/` directory, for gates that census where src/ names a specific tool (core_tool_edge_tripwire)',
	},
	'scripts/tool_colors.ts': {
		roots: [['tools']],
		scope:
			"every tool's identity hue — the `--<tool>` declaration in each `tools/tool_<name>/css/tool_<name>.less`, the input of the GENERATED tool_colors.less; read by tool_color_contrast_tripwire to prove the generated file is fresh",
	},
	'test/helpers/migrations_corpus.ts': {
		roots: [['install/db/migrations']],
		scope:
			'the numbered boot migrations — what an EXISTING installation actually applies, for gates proving a schema or SQL-function change reaches one',
	},
	'test/helpers/install_host_scratch.ts': {
		roots: [['deploy/systemd']],
		scope:
			"the installer's systemd unit templates the host-step gates' fake source tree plants (deploy/systemd/, systemdTemplateNames); scratchFilePaths lists the CALLER's own mkdtemp scratch host, never a repo directory",
	},
	'test/helpers/deploy_artifact_corpus.ts': {
		roots: [['.'], ['.', 'deploy'], ['deploy'], ['deploy']],
		scope:
			'what the engine SHIPS to an operator — the reverse-proxy configurations and systemd units under deploy/, the compose stacks git tracks at the repo root, and (trackedComposeFiles) those plus the deploy/ compose variants',
	},
	'test/helpers/prose_markdown_corpus.ts': {
		roots: [['docs', 'engineering']],
		scope:
			'the prose a reader is told to act on — every *.md under docs/ (the manual, exclude_docs included: a page can still be read) and engineering/ (the definitions), for gates that census the fenced blocks those pages hand an operator (supervision_declaration_tripwire: every documented systemd unit that runs the server)',
	},
	'test/helpers/client_suite_census.ts': {
		roots: [['client/dedalo/test/client/js']],
		scope: 'the browser client suite files (test_*.js) and their registry',
	},
	'test/helpers/no_write_scan.ts': {
		roots: [['src/external']],
		scope:
			"a parameterized recursive lister — the CALLER names the root it scans for write seams; the roots here are what its callers feed it, each written in that caller's own entry too",
	},
	'scripts/lib/authz_substring_census.ts': {
		roots: [['src', 'tools'], ['test/unit']],
		scope:
			'authorization symbol reads across the engine and the tool servers (deriveAuthzSymbols), and the unit gates that assert on them (authzSubstringCensus)',
	},
	'scripts/lib/vacuity_census.ts': {
		roots: [['test'], ['test'], ['test']],
		scope:
			'every *.test.ts gate — the silent-return census, the unfloored-emptiness census, and the corpus size both are witnessed by',
	},
	'scripts/lib/complexity.ts': {
		roots: [['src/core']],
		scope:
			'a parameterized glob lister — the CALLER (scripts/crap_baseline.ts, SCAN_ROOT) names its root and patterns; what it is fed today is written here too',
	},
	'scripts/crap_baseline.ts': {
		roots: [['src/core']],
		scope: 'the CRAP ratchet driver: SCAN_ROOT, the one root it hands scripts/lib/complexity.ts',
	},
	'scripts/lib/throw_census.ts': {
		roots: [['src', 'tools']],
		scope: 'untyped-throw sites in the engine (SCAN_ROOTS)',
	},
	'scripts/lib/third_party_census.ts': {
		roots: [['client', 'deploy', 'install', 'publication', 'tools', 'vendor']],
		scope:
			'every git-tracked js/mjs/cjs/css/less file under the trees that ship to a browser or an installation — the committed third-party byte census behind dependency_integrity_tripwire (SCAN_ROOTS)',
	},
	'scripts/lib/production_corpus.ts': {
		roots: [['.'], ['.'], ['tools']],
		scope:
			"the production and non-production source corpora behind production_import_tripwire: every package root derived from the tree (a git-tracked bun.lock beside a package.json, listed by `git ls-files` run at the repo root — the first `.` site: the whole repo, no subtree chosen, and no gitignored local tree such as rewrite/); every SHIPPED file (shippableFiles: `git ls-files -co --exclude-standard` at the repo root — the second `.` site, again no subtree chosen), from which nonProductionFilesOf derives LEG 4's corpus per package root minus production, nested roots and the reasoned NON_BUN_TREES; then per package the trees sourceRootsOf returns — the engine's src/ plus every tools/<tool>/server/ (the readdirSync over `tools`), and each other package's src/ — handed to walkFiles through a return value the evaluator does not read as a root",
	},
	'scripts/lib/client_compat_census.ts': {
		roots: [
			['client/dedalo', 'tools'],
			['client/dedalo', 'tools'],
			['client/dedalo', 'tools'],
		],
		scope:
			'browser JS, core client and tool client alike (SCAN_ROOTS — WHOLE trees; the tools glob is `**/*.js`, not the `*/js/**` sub-path of GATE-31): its own discoverFiles scan, plus the two sites client_error_contract_tripwire feeds from the same exported SCAN_ROOTS (its corpus scan and its `git ls-files` ⊆ scan totality check)',
	},
	'scripts/lib/predictable_tmp_census.ts': {
		roots: [['client/dedalo/test', 'publication', 'scripts', 'test']],
		scope:
			'the gate/script/probe trees whose temp-path construction predictable_tmp_tripwire measures — PREDICTABLE_TMP_SCAN_GLOBS: test/**, scripts/**, publication/**/tests/** and publication/**/deploy/probes/**, client/dedalo/test/** (deploy/probes/** is globbed too and is absent today), node_modules and fixtures/ excluded',
	},
	'scripts/lib/tld_census.ts': {
		roots: [
			['client/dedalo/test/client/js', 'src/core/test_data', 'test'],
			['client/dedalo/test/client/js', 'src/core/test_data', 'test'],
			['client/dedalo/test/client/js', 'src/core/test_data', 'test'],
		],
		scope: 'every file that may name an ontology TLD in a test (SCAN_ROOTS)',
	},
	'scripts/lib/hierarchy_allowlist.ts': {
		roots: [['install/import/hierarchy'], ['src/core/test_data', 'test']],
		scope:
			'hierarchy TLD carriers in tests and the repo-owned situations (SCAN_ROOTS), and the shipped hierarchy archives the allowlist is derived from',
	},

	'scripts/lib/test_order.ts': {
		roots: [['test/parity']],
		scope:
			"a parameterized tier lister — the CALLER names the tier's paths and this expands them into the sorted file list bun runs (one walk for runTier, the shard runner, verify and the drift report). Known subset: only the parity tier's `test/parity` reaches it from an indexed gate (parity_baseline_tripwire → runParityTier); the unit tier's `test/unit` + `test/integration`, the shard runner's `test` and the MariaDB set are fed by scripts no indexed gate reaches — tier_file_order_tripwire holds those lists complete against an independent walk",
	},
	'scripts/lib/parity_census.ts': {
		roots: [['test/parity']],
		scope: 'the parity TierSpec: the one path the parity baseline covers',
	},

	'scripts/lib/twin_census.ts': {
		roots: [['test/parity'], ['test/unit']],
		scope: 'the retired-differential twin map: parity gates and their native twins',
	},
	'scripts/lib/test_components.ts': {
		roots: [['test'], ['test/helpers']],
		scope: 'every test file and helper — the corpus-scope and shard census',
	},

	'scripts/lib/test_shard_db.ts': {
		roots: [],
		scope: 'NOT a corpus: `readdirSync` lists the suite media base for marked shard twins to sweep',
	},
	'scripts/lib/release_clone.ts': {
		roots: [['.']],
		scope:
			"the checkout's UNCOMMITTED paths — `overlayWorkingTree` lists `git diff --name-only HEAD` + `git ls-files --others --exclude-standard` of the root it is handed (scripts/update_drill.ts: this checkout, `.`; update_drill_config_tripwire: a scratch repo) to lay them over the drill's release clone and consumer export. It decides no gate's corpus.",
	},
	'test/helpers/suite_mariadb_lanes.ts': {
		roots: [],
		scope:
			"NOT a corpus: `suiteMariadbLaneEntries` lists the suite MariaDB lane base (`../private/test_mariadb/`, outside the repo — the module's own root, never a caller's) for the lanes and killed-sweep/claim leftovers a sweep visits; the second site lists one swept lane's trash to delete it marker-last. Kept out of test/helpers/suite_mariadb.ts so the gates that only ACQUIRE the target are not walkers.",
	},
	'test/helpers/agent_skills_corpus.ts': {
		roots: [['.agents/skills'], ['.']],
		scope:
			'the project skills — every `.agents/skills/*/SKILL.md` (the real path, never the `.claude` alias), and the git index a skill may point at (`git ls-files` at the repo root: a clone is what a skill is read on)',
	},
	'test/helpers/agent_workflows_corpus.ts': {
		roots: [['.agents/workflows']],
		scope:
			'the multi-agent workflow scripts — every `.agents/workflows/*.js` (the real path, never the `.claude` alias), the corpus agent_workflows_parse_tripwire compiles',
	},
	'test/helpers/docs_corpus.ts': {
		roots: [['docs'], ['docs']],
		scope: 'the manual — every docs/**/*.md page, the one lister a docs-censusing gate imports',
	},
	'test/helpers/scratch_run_entries.ts': {
		roots: [],
		scope:
			"NOT a corpus: `scratchRunEntries` lists the scratch directory a diffusion gate's OWN publication run wrote (a run directory, a files target); the CALLER hands its own scratch root",
	},
	'test/helpers/power_loss_model.ts': {
		roots: [],
		scope:
			"NOT a corpus: `startPowerLossModel` snapshots the entries already under the CALLER's scratch root (a gate's marked files root) when the model starts — what predates the test is durable by assumption; never a repo directory",
	},
	'test/helpers/zzarc_media_digests.ts': {
		roots: [],
		scope:
			'NOT a corpus: `zzarcMediaDigests` fingerprints the scratch media tree the zzarc situation plants; the CALLER hands its own scratch root',
	},
	'test/helpers/media_seed_sweep.ts': {
		roots: [],
		scope:
			"NOT a corpus: `sweepSeededMediaEntries` deletes, by name, the media files a gate seeded under the CALLER's marked test media root (the lane's suite root or a scratch root — refused without `.dedalo_test_media`); never a repo directory",
	},
	'scripts/seed_diffusion_type_rewrite.ts': {
		roots: [['install/import/ontology/7.0']],
		scope:
			'the importable ontology packages (`<tld>.copy.gz`) the diffusion-type rewrite judges or rewrites (ontologyPackageFiles, ONTOLOGY_PACKAGE_DIR)',
	},
	'scripts/lib/site_builder_census.ts': {
		roots: [
			[
				'publication/site_builder/src',
				'src/core/area_maintenance/widgets',
				'src/core/site_builder',
				'tools/tool_sitebuilder/server',
			],
		],
		scope: 'both site-builder deployables and the engine-side proxy (SCAN_ROOTS)',
	},
	'scripts/build_css.ts': {
		roots: [['client', 'tools']],
		scope: 'every .less the CSS build compiles — entrypoints derived from the two browser trees',
	},
	'scripts/ci/audit.ts': {
		roots: [['.']],
		scope: 'every tracked package.json in the repo — the dependency-advisory ratchet',
	},
	'scripts/vendor_verify.ts': {
		roots: [['vendor']],
		scope: 'the vendored third-party tree, verified against its manifest',
	},
	'scripts/lib/baseline_artifacts.ts': {
		roots: [
			['.'],
			['.github', 'scripts', 'src', 'test', 'tools'],
			['engineering'],
			['engineering'],
		],
		scope:
			'the baseline-artifact registry: the repo root (git), the trees that may read a baseline (READER_ROOTS), and the engineering/ JSON artifacts — on disk and tracked',
	},
	'scripts/ci_local.ts': {
		roots: [['.']],
		scope:
			'the working-tree overlay: what differs between HEAD and the disk, asked of git at the repo root',
	},
};

/**
 * The four gates that census the write path; each must use the shared corpus.
 * (write_obligations_tripwire replaced section_record's grep gate with CLOSURE_PLAN
 * Step 2 — that gate's regex never matched a single-key writer, so it held nothing.)
 */
const WRITE_PATH_GATES: readonly string[] = [
	'test/unit/sql_confinement_tripwire.test.ts',
	'test/unit/ws_a_tripwires.test.ts',
	'test/unit/matrix_counter_monotonic_tripwire.test.ts',
	'test/unit/write_obligations_tripwire.test.ts',
];

/** Positive control: a script that mass-rewrites matrix jsonb, outside src/ and tools/. */
const SCRIPTS_POSITIVE_CONTROL = 'scripts/migrate_section_id_locators.ts';

// ---------------------------------------------------------------------------
// The classifier — pure over its inputs.
// ---------------------------------------------------------------------------

interface IndexRow {
	file: string;
	invariant: string;
}

/** A module the gate imports from the shared infrastructure, comments stripped. */
interface ImportedModule {
	path: string;
	code: string;
}

type Shape = 'walk' | 'hand' | 'none';

interface Verdict {
	claims: boolean;
	shape: Shape;
	/** The gate itself holds a derivation token (as opposed to only importing one). */
	ownWalk: boolean;
	/** A numeric floor whose expect() argument is bound to the walk. */
	boundFloor: boolean;
	exempt: boolean;
	/** True iff the gate honours the rule. */
	ok: boolean;
}

/** A line of the index that names a gate: `| test/... | …` — the trailing pipe is NOT required. */
const INDEX_ROW_LINE = /^\|\s*`?test\//;

/**
 * Every `| test/... | invariant` row of the index, in order. A row whose cell
 * ends without a closing `|` is a row all the same — the census is every line
 * that names a gate, and `indexRowLines` counts those lines independently so
 * the two cannot drift.
 */
function parseIndexRows(markdown: string): IndexRow[] {
	const rows: IndexRow[] = [];
	for (const line of markdown.split('\n')) {
		if (!INDEX_ROW_LINE.test(line)) continue;
		const match = /^\|\s*`?(test\/[^|`\s]+)`?\s*\|(.*?)\|?\s*$/.exec(line);
		if (match === null) throw new Error(`index line names a gate but does not parse: ${line}`);
		rows.push({ file: match[1] as string, invariant: match[2] as string });
	}
	return rows;
}

/** The lines of the index that name a gate — the census the parser must equal. */
function indexRowLines(markdown: string): number {
	return markdown.split('\n').filter((line) => INDEX_ROW_LINE.test(line)).length;
}

function claimsTotality(invariant: string): boolean {
	return CLAIM_PATTERN.test(invariant);
}

/** One string/template/regex literal at CODE level (a literal nested in another is part of it). */
interface TopLevelLiteral {
	/** The text between the delimiters. */
	content: string;
	/** The code (literals blanked) immediately before the opening delimiter. */
	preceding: string;
	/** Offset of the opening delimiter in the code. */
	index: number;
}

/**
 * ONE pass with `skipLiteral`: the code with every literal's content replaced
 * by spaces (delimiters kept, length preserved — `readdirSync('src')` becomes
 * `readdirSync('   ')`, so an offset in the blanked text is the same offset in
 * the code), and the list of the literals it blanked, each with the code that
 * preceded it.
 */
function blankLiterals(code: string): { blanked: string; literals: TopLevelLiteral[] } {
	const literals: TopLevelLiteral[] = [];
	let blanked = '';
	let i = 0;
	const n = code.length;
	while (i < n) {
		const past = skipLiteral(code, i);
		if (past !== i) {
			const open = code[i] as string;
			const close = code[past - 1] === open ? open : '';
			const content = code.slice(i + 1, past - (close === '' ? 0 : 1));
			literals.push({ content, preceding: blanked.slice(-40), index: i });
			// Same length as the literal, so positions in the blanked text are positions in the code.
			blanked += `${open}${' '.repeat(content.length)}${close}`;
			i = past;
			continue;
		}
		blanked += code[i];
		i++;
	}
	return { blanked, literals };
}

/**
 * A tree/registry derivation: a walk token in CODE (literals blanked), a git
 * index listing as a process argument, or a frozen census fixture import.
 */
function hasDerivation(code: string): boolean {
	const { blanked, literals } = blankLiterals(code);
	if (CODE_DERIVATION_TOKENS.some((token) => token.test(blanked))) return true;
	return literals.some(
		({ content, preceding }) =>
			GIT_INDEX_LITERAL.test(content) ||
			(FIXTURE_IMPORT_LITERAL.test(content) && IMPORT_FROM_TAIL.test(preceding)),
	);
}

/**
 * If a string or regex literal starts at `i`, the index just past it; else `i`.
 * Brackets inside literals must not count as code brackets.
 */
function skipLiteral(code: string, i: number): number {
	const ch = code[i] as string;
	const n = code.length;
	if (ch === "'" || ch === '"' || ch === '`') {
		let j = i + 1;
		while (j < n && code[j] !== ch) {
			if (code[j] === '\\') j++;
			j++;
		}
		return j + 1;
	}
	if (ch === '/') {
		const before = code.slice(0, i).trimEnd();
		if (before === '' || /(?:[=(,:[!&|?{};]|=>|\breturn)$/.test(before)) {
			let j = i + 1;
			let inClass = false;
			while (j < n) {
				const c = code[j];
				if (c === '\\') {
					j += 2;
					continue;
				}
				if (c === '[') inClass = true;
				else if (c === ']') inClass = false;
				else if ((c === '/' && !inClass) || c === '\n') break;
				j++;
			}
			return j + 1;
		}
	}
	return i;
}

/**
 * The text of one statement (from `start` to the `;` that closes it) or one
 * function body (from the parameter list to the brace that closes it).
 */
function statementExtent(code: string, start: number, functionBody: boolean): string {
	let depth = 0;
	let i = start;
	const n = code.length;
	while (i < n) {
		const past = skipLiteral(code, i);
		if (past !== i) {
			i = past;
			continue;
		}
		const ch = code[i] as string;
		if (ch === '(' || ch === '[' || ch === '{') {
			depth++;
			i++;
			continue;
		}
		if (ch === ')' || ch === ']' || ch === '}') {
			depth--;
			i++;
			if (functionBody && ch === '}' && depth === 0) {
				// A `}` that closes a return-type annotation is followed by `[`, `|`,
				// `&`, `{`, `=>`, `,` or `)`; the body's `}` is followed by none of them.
				const after = code.slice(i).trimStart();
				if (!/^(?:\[|\||&|\{|=>|,|\))/.test(after)) return code.slice(start, i);
			}
			if (depth < 0) return code.slice(start, i);
			continue;
		}
		if (ch === ';' && depth === 0 && !functionBody) return code.slice(start, i);
		i++;
	}
	return code.slice(start);
}

/** The argument text of the call whose `(` is at `open`, and the index past its `)`. */
function callArgument(code: string, open: number): { argument: string; end: number } {
	let depth = 0;
	let i = open;
	const n = code.length;
	while (i < n) {
		const past = skipLiteral(code, i);
		if (past !== i) {
			i = past;
			continue;
		}
		const ch = code[i] as string;
		if (ch === '(' || ch === '[' || ch === '{') depth++;
		else if (ch === ')' || ch === ']' || ch === '}') {
			depth--;
			if (depth === 0) return { argument: code.slice(open + 1, i), end: i + 1 };
		}
		i++;
	}
	return { argument: code.slice(open + 1), end: n };
}

/** One bracket a site sits inside, with the statement text that preceded it. */
interface Opener {
	ch: '(' | '[' | '{';
	header: string;
}

/** An `expect(` outside any string/regex literal, with its bracket ancestry. */
interface ExpectSite {
	index: number;
	ancestors: Opener[];
	/** The text of the site's own statement before `expect` (e.g. `if (n > 0) `). */
	statementPrefix: string;
}

/** The isolated-gate guard statement (test/helpers/isolated_gate.ts), as it ends the code before its `else {`. */
const ISOLATED_GATE_GUARD =
	/if\s*\(\s*!\s*isIsolatedGateChild\(\s*import\.meta\.path\s*\)\s*\)\s*mirrorIsolatedGate\(\s*import\.meta\.path\s*\)\s*;\s*$/;

/**
 * ONE forward pass over the code: every `expect(` outside a literal, with the
 * stack of brackets open around it and, for each, the statement text that
 * preceded the bracket (`if (x) `, `'name', () => `, `test`). Statement
 * boundaries are `;`, `{` and `}` at the same depth — a `;` inside a `for (…)`
 * header is deeper and does not cut the statement it heads.
 */
function expectSites(code: string): ExpectSite[] {
	const out: ExpectSite[] = [];
	const stack: Opener[] = [];
	const boundary: number[] = [0];
	let i = 0;
	const n = code.length;
	while (i < n) {
		const past = skipLiteral(code, i);
		if (past !== i) {
			i = past;
			continue;
		}
		const ch = code[i] as string;
		if (ch === '(' || ch === '[' || ch === '{') {
			const depth = stack.length;
			let header = code.slice(boundary[depth] ?? 0, i);
			// THE ISOLATED GATE'S BODY IS THE FILE (test/helpers/isolated_gate.ts): the
			// top-level `else {` after the guard is what the gate's own child process
			// runs, every time — the tier process mirrors that run. Read it as the
			// top-level body it is, not as a branch.
			if (
				ch === '{' &&
				depth === 0 &&
				/^\s*else\s*$/.test(header) &&
				ISOLATED_GATE_GUARD.test(code.slice(0, boundary[depth] ?? 0))
			) {
				header = '';
			}
			stack.push({ ch, header });
			boundary[depth + 1] = i + 1;
		} else if (ch === ')' || ch === ']' || ch === '}') {
			stack.pop();
			if (ch === '}') boundary[stack.length] = i + 1;
		} else if (ch === ';') {
			boundary[stack.length] = i + 1;
		} else if (
			code.startsWith('expect', i) &&
			/^expect\s*\(/.test(code.slice(i, i + 12)) &&
			!/\w/.test(code[i - 1] ?? '')
		) {
			out.push({
				index: i,
				ancestors: [...stack],
				statementPrefix: code.slice(boundary[stack.length] ?? 0, i),
			});
		}
		i++;
	}
	return out;
}

/**
 * The bracket depth the tracker is left at after the whole file — 0 for any
 * file it read correctly. A literal it failed to skip (a regex holding a
 * paren, read as division) desyncs every ancestry after it, so the live
 * census asserts this over every registered gate.
 */
function bracketDepthAtEnd(code: string): number {
	let depth = 0;
	let i = 0;
	const n = code.length;
	while (i < n) {
		const past = skipLiteral(code, i);
		if (past !== i) {
			i = past;
			continue;
		}
		const ch = code[i] as string;
		if (ch === '(' || ch === '[' || ch === '{') depth++;
		else if (ch === ')' || ch === ']' || ch === '}') depth--;
		i++;
	}
	return depth;
}

/** Control flow that makes a statement conditional on something — a loop, a branch, a short-circuit. */
const CONTROL_FLOW = /\b(?:if|else|for|while|do|switch|case|catch)\b|&&|\|\||\?/;

/**
 * The callee expression that ends a call's header — `test`, `describe.if(hasDb)`,
 * `it.each([…])`, `xit` — or nothing when the call is not a test call at all.
 */
const CALLEE_TAIL = /(\b(?:x?it|x?test|x?describe)\b(?:\s*\.\s*\w+(?:\s*\([^()]*\))?)*)\s*$/;

/** A callee whose body never runs: `test.skip`, `describe.todo`, `xit`, `test.skipIf(true)`, `describe.if(false)`. */
const SKIPPED_CALLEE =
	/^x(?:it|test|describe)\b|\.(?:skip|todo|failing)\b|\.(?:skipIf|todoIf)\s*\(\s*true\s*\)|\.if\s*\(\s*false\s*\)/;

/**
 * A floor counts only where it EXECUTES: the statement is not itself
 * conditional, every block around it up to the test callback is a plain block
 * (not `if`/`for`/`catch`/…), and that callback belongs to a live `test`,
 * `it` or `describe` call — not `.skip`/`.todo`, not a helper function that
 * may never be called, not a `forEach` over the very list whose emptiness the
 * floor exists to detect. An `if (n > 0) expect(n).toBeGreaterThan(600)` is
 * guarded by the emptiness it detects; a floor in a skipped test is parked.
 */
function isUnconditional(site: ExpectSite): boolean {
	if (CONTROL_FLOW.test(site.statementPrefix)) return false;
	for (let k = site.ancestors.length - 1; k >= 0; k--) {
		const { ch, header } = site.ancestors[k] as Opener;
		if (ch === '{' && /=>|\bfunction\b/.test(header)) {
			// A function body: only a live test/describe callback runs unconditionally —
			// and so must every callback around it (`describe.skip` parks its tests).
			const call = site.ancestors[k - 1];
			if (call === undefined || call.ch !== '(') return false;
			// `describe.if(cond)('x', () => {` — the callee is what ends the call's header.
			const callee = CALLEE_TAIL.exec(call.header)?.[1];
			if (callee === undefined || SKIPPED_CALLEE.test(callee)) return false;
			k--; // the call's own paren is accounted for
			continue;
		}
		if (CONTROL_FLOW.test(header)) return false;
	}
	return true;
}

interface FloorSite {
	/** Where the `expect(` sits — names in the argument resolve by position. */
	index: number;
	/** The text inside `expect(...)`. */
	argument: string;
	/** The literal or SCREAMING constant the value must exceed; `EXACT_SET` for a literal expected set. */
	floor: string;
	/** `toBeGreaterThanOrEqual`: the floor itself passes — so a floor of 0 admits an EMPTY walk. */
	orEqual: boolean;
	/** The site executes whenever the file runs (see `isUnconditional`). */
	unconditional: boolean;
}

/**
 * Every `expect(<arg>).toBeGreaterThan[OrEqual](<int | SCREAMING_CONST>)` or
 * `expect(<arg>).toEqual([<literal>, …])` outside a literal, argument
 * delimited by its own parens, with whether it executes unconditionally.
 */
function floorSites(code: string): FloorSite[] {
	const out: FloorSite[] = [];
	for (const site of expectSites(code)) {
		const open = code.indexOf('(', site.index);
		const { argument, end } = callArgument(code, open);
		const rest = code.slice(end);
		const matcher = FLOOR_MATCHER.exec(rest);
		const unconditional = isUnconditional(site);
		const index = site.index;
		if (matcher !== null) {
			out.push({
				index,
				argument,
				floor: matcher[2] as string,
				orEqual: matcher[1] !== undefined,
				unconditional,
			});
		} else if (EXACT_SET_MATCHER.test(rest)) {
			out.push({ index, argument, floor: 'EXACT_SET', orEqual: false, unconditional });
		}
	}
	return out;
}

type DeclarationKind = 'var' | 'function' | 'param' | 'loop';

interface Declaration {
	name: string;
	body: string;
	/** Where the declaration starts in the code. */
	index: number;
	/** A `function` declaration is hoisted; a variable resolves by position. */
	hoisted: boolean;
	kind: DeclarationKind;
	/** param: the named function (or const-assigned arrow) whose parameter list declares it. */
	owner?: string;
	/** param of an ANONYMOUS callback: the receiver of the `.map(`/`.forEach(`… it is passed to, and where it starts. */
	receiver?: string;
	receiverAt?: number;
	/** param: its index in the parameter list. */
	position?: number;
	/** A name destructured from an ARRAY pattern (`[root, prefix]`): its element index. */
	element?: number;
	/** A name destructured from an OBJECT pattern (`{ root, glob: pattern }`): its key. */
	key?: string;
}

/** The names an object pattern binds, each with the key it takes: `{ root, glob: pattern }`. */
function objectPatternNames(pattern: string): { name: string; key: string }[] {
	const out: { name: string; key: string }[] = [];
	for (const member of splitTopLevel(
		pattern.slice(pattern.indexOf('{') + 1, pattern.lastIndexOf('}')),
		',',
	)) {
		const bare = (member.split('=')[0] ?? '').trim();
		const renamed = /^([\w$]+)\s*:\s*([\w$]+)$/.exec(bare);
		if (renamed !== null) out.push({ key: renamed[1] as string, name: renamed[2] as string });
		else if (/^[\w$]+$/.test(bare)) out.push({ key: bare, name: bare });
	}
	return out;
}

/** The methods whose callback parameter is fed the receiver's elements. */
const ELEMENT_CALLBACK_TAIL = /\.(?:map|flatMap|forEach|filter|some|every|find|reduce|sort)\s*\($/;

/** `const NAME = ` (or `= async `) right before an arrow: the arrow is NAME. */
const ARROW_OWNER_TAIL = /\b(?:const|let|var)\s+(\w+)\s*(?::[^=;]+)?=\s*(?:async\s*)?$/;

/**
 * The maximal PRIMARY EXPRESSION ending at `end` in blanked code — identifiers,
 * property chains, calls and index brackets, with a leading `new` — e.g. the
 * `new Glob('   ')` before `.scanSync(` or the `ROOTS` before `.map(`.
 */
function primaryExpressionBefore(blanked: string, end: number): { text: string; at: number } {
	let i = end - 1;
	let depth = 0;
	while (i >= 0) {
		const ch = blanked[i] as string;
		if (ch === ')' || ch === ']') depth++;
		else if (ch === '(' || ch === '[') {
			if (depth === 0) break;
			depth--;
		} else if (depth === 0 && /\s/.test(ch)) {
			// A chain may break lines before its `.`: `readdirSync(x)\n\t.filter(…)`.
			let k = i;
			while (k >= 0 && /\s/.test(blanked[k] as string)) k--;
			if (blanked[i + 1] !== '.' || k < 0 || !/[\w$)\]]/.test(blanked[k] as string)) break;
			i = k;
			continue;
		} else if (depth === 0 && !/[\w$.]/.test(ch)) break;
		i--;
	}
	let at = i + 1;
	// A spread (`...x.scanSync(`) is not part of the expression it spreads.
	while (blanked.startsWith('.', at)) at++;
	const lead = /\bnew\s+$/.exec(blanked.slice(0, at));
	if (lead !== null) at -= lead[0].length;
	return { text: blanked.slice(at, end).trim(), at };
}

/**
 * Every `const|let|var NAME = …` statement, `function NAME(…) {…}` body, every
 * PARAMETER (of a named function, a const-assigned arrow, or an anonymous
 * callback — with what owns or feeds it) and every loop variable (bound to
 * what it iterates), with positions.
 */
function declarations(code: string): Declaration[] {
	const out: Declaration[] = [];
	// Declarations are FOUND in blanked code (a `function x(` spelled inside a
	// string is text) and their bodies TAKEN from the code at the same offsets.
	const blanked = blankLiterals(code).blanked;
	for (const match of blanked.matchAll(/\b(?:const|let|var)\s+(\w+)\s*(?::[^=;]+)?=(?!=)/g)) {
		out.push({
			name: match[1] as string,
			body: statementExtent(code, match.index + match[0].length, false),
			index: match.index,
			hoisted: false,
			kind: 'var',
		});
	}
	for (const match of blanked.matchAll(/\b(?:const|let|var)\s*(\{[^}]*\})\s*=(?!=)/g)) {
		const body = statementExtent(code, match.index + match[0].length, false);
		for (const { name, key } of objectPatternNames(match[1] as string)) {
			out.push({ name, key, body, index: match.index, hoisted: false, kind: 'var' });
		}
	}
	for (const match of blanked.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]\s*=(?!=)/g)) {
		const body = statementExtent(code, match.index + match[0].length, false);
		(match[1] as string).split(',').forEach((name, element) => {
			const bare = (name.split('=')[0] ?? '').trim();
			if (/^\w+$/.test(bare))
				out.push({ name: bare, body, index: match.index, hoisted: false, kind: 'var', element });
		});
	}
	for (const match of blanked.matchAll(/\b(?:async\s+)?function\s*\*?\s*(\w+)\s*\(/g)) {
		const open = match.index + match[0].length - 1;
		const name = match[1] as string;
		out.push({
			name,
			body: statementExtent(code, open, true),
			index: match.index,
			hoisted: true,
			kind: 'function',
		});
		out.push(...parameterDeclarations(callArgument(code, open).argument, open, { owner: name }));
	}
	// Arrow parameters shadow too: `(text) => …`, `(dir: string): boolean => …`, `l => …`.
	const arrowContext = (index: number): Pick<Declaration, 'owner' | 'receiver' | 'receiverAt'> => {
		const before = blanked.slice(0, index);
		const owner = ARROW_OWNER_TAIL.exec(before.slice(-300))?.[1];
		if (owner !== undefined) return { owner };
		const tail = ELEMENT_CALLBACK_TAIL.exec(before.trimEnd());
		if (tail === null) return {};
		const receiverEnd = before.trimEnd().length - tail[0].length;
		const { text, at } = primaryExpressionBefore(blanked, receiverEnd);
		return text === '' ? {} : { receiver: code.slice(at, receiverEnd), receiverAt: at };
	};
	for (const match of blanked.matchAll(/\(([^()]*)\)\s*(?::[^=;{]*)?=>/g)) {
		out.push(...parameterDeclarations(match[1] as string, match.index, arrowContext(match.index)));
	}
	for (const match of blanked.matchAll(/(?<![\w$.])(?<!:\s*)(\w+)\s*=>/g)) {
		out.push({
			name: match[1] as string,
			body: '',
			index: match.index,
			hoisted: false,
			kind: 'param',
			position: 0,
			...arrowContext(match.index),
		});
	}
	// A loop variable is bound to what it iterates: `for (const text of corpus.values())`.
	for (const match of blanked.matchAll(
		/\bfor\s*\(\s*(?:const|let|var)\s+([^;]*?)\s+(?:of|in)\s+/g,
	)) {
		const open = match.index + match[0].indexOf('(');
		const header = callArgument(code, open).argument;
		const body = header.slice(match[0].length - (open + 1 - match.index));
		const pattern = match[1] as string;
		if (pattern.trim().startsWith('{')) {
			for (const { name, key } of objectPatternNames(pattern)) {
				out.push({ name, key, body, index: match.index, hoisted: false, kind: 'loop' });
			}
		} else if (pattern.trim().startsWith('[')) {
			pattern
				.trim()
				.slice(1, -1)
				.split(',')
				.forEach((name, element) => {
					const bare = (name.split('=')[0] ?? '').trim();
					if (/^\w+$/.test(bare))
						out.push({
							name: bare,
							body,
							index: match.index,
							hoisted: false,
							kind: 'loop',
							element,
						});
				});
		} else {
			for (const name of pattern.match(/\w+/g) ?? []) {
				out.push({ name, body, index: match.index, hoisted: false, kind: 'loop' });
			}
		}
	}
	return out.sort((a, b) => a.index - b.index);
}

/**
 * The names a parameter list declares — each a declaration at the function's
 * position whose body is its default value (`files = corpus()`) or nothing,
 * carrying its position in the list, its owner or the receiver feeding it, and
 * its element index when destructured from an array pattern. A parameter
 * SHADOWS: `text` inside `codeLines(text)` is not the `text` a test read from
 * the tree two hundred lines above.
 */
function parameterDeclarations(
	params: string,
	index: number,
	context: Pick<Declaration, 'owner' | 'receiver' | 'receiverAt'>,
): Declaration[] {
	const out: Declaration[] = [];
	let depth = 0;
	let current = '';
	let position = 0;
	const flush = (): void => {
		const param = current.trim();
		current = '';
		if (param === '') return;
		const [pattern, ...rest] = param.split('=');
		const body = rest.join('=');
		// The type annotation starts at the first depth-0 `:` — not at a key's colon
		// inside `{ root, glob: pattern }`.
		const shape = splitTopLevel(pattern ?? '', ':')[0]?.trim() ?? '';
		const base = { body, index, hoisted: false, kind: 'param' as const, position, ...context };
		if (shape.startsWith('{')) {
			for (const { name, key } of objectPatternNames(shape)) out.push({ ...base, name, key });
		} else if (shape.startsWith('[')) {
			shape
				.slice(1, shape.lastIndexOf(']'))
				.split(',')
				.forEach((name, element) => {
					const bare = (name.split('=')[0] ?? '').trim();
					if (/^\w+$/.test(bare)) out.push({ ...base, name: bare, element });
				});
		} else {
			for (const name of shape.match(/\w+/g) ?? []) out.push({ ...base, name });
		}
		position++;
	};
	for (const ch of params) {
		if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
		else if (ch === ')' || ch === ']' || ch === '}' || ch === '>') depth--;
		if (ch === ',' && depth === 0) flush();
		else current += ch;
	}
	flush();
	return out;
}

/** Names of a module's exported functions and constants. */
function exportedNames(code: string): string[] {
	return [
		...blankLiterals(code).blanked.matchAll(
			/\bexport\s+(?:async\s+)?(?:function|const|let)\s+(\w+)/g,
		),
	].map((match) => match[1] as string);
}

/**
 * A declaration whose value is WRITTEN IN THE GATE — an object, Map, Set or
 * string literal, or an array naming FILES: a synthetic control input, not
 * something read from the tree. (An array of directories or glob patterns is
 * a lister's root list, and a call taking it is the real walk.)
 */
function isSyntheticInput(body: string): boolean {
	if (/^\s*(?:\{|new\s+(?:Map|Set)\s*\(|'|"|`)/.test(body)) return true;
	// An array of FILE paths is a hand corpus; an array of directories or glob
	// patterns (`['src', 'tools']`, `['**/*.ts']`) is the root list a lister takes.
	return (
		/^\s*\[/.test(body) &&
		blankLiterals(body).literals.some(
			({ content }) => /\.\w+$/.test(content) && !content.includes('*'),
		)
	);
}

/** Every `for (…) …` statement — braced or single-statement — with its position. */
interface Loop {
	index: number;
	text: string;
}

function loops(code: string): Loop[] {
	return [...code.matchAll(/\bfor\s*\(/g)].map((match) => {
		const header = callArgument(code, match.index + match[0].length - 1);
		const after = code.slice(header.end).trimStart();
		const bodyStart = header.end + (code.slice(header.end).length - after.length);
		const body = after.startsWith('{')
			? statementExtent(code, bodyStart, true)
			: statementExtent(code, bodyStart, false);
		return { index: match.index, text: `${header.argument}\n${body}` };
	});
}

/**
 * OUTER names a block MUTATES (`n++`, `n += …`, `n[k] = …`, `n.push/add/set(…)`)
 * — a name the block declares itself is its own local, not a binding that
 * escapes it. Literals are blanked first: a string that says `out.push` is text.
 */
function mutatedNames(body: string): string[] {
	const code = blankLiterals(body).blanked;
	const local = new Set(
		[...code.matchAll(/\b(?:const|let|var)\s+(\w+)/g)].map((match) => match[1] as string),
	);
	return [
		...code.matchAll(/\b(\w+)(?:\+\+|\s*\+=|\s*\[[^\]]+\]\s*=(?!=)|\.(?:push|add|set)\s*\()/g),
	]
		.map((match) => match[1] as string)
		.filter((name) => !local.has(name));
}

/**
 * THE BINDING PASS — which declarations carry the walk. Resolution is BY
 * POSITION: a name used at offset `at` means the last variable of that name
 * declared before it (a function is hoisted; a module constant used above its
 * declaration, inside a function body, resolves forward). Two names spelled
 * alike in different scopes are two declarations, judged apart — the `names`
 * one helper fills from a Glob is not the `names` another fills from a seed
 * file, and the `roots` a control destructures from a helper applied to a
 * hand-written corpus is not the `roots` the helper builds over the tree.
 *
 * A declaration is BOUND when its statement/body holds a derivation token,
 * or mentions a bound name outside a string/template/regex literal and not as
 * an object key — where a CALL of a bound function counts only if no argument
 * is a SYNTHETIC INPUT (an unbound declaration whose value is an array,
 * object, Map, Set or string literal). A name a bound block MUTATES (the
 * block of a bound declaration, or a loop over the walk) joins too. Iterated
 * to a fixed point. Seeds are names bound from outside: the exports of a
 * walking module, the binding of a frozen census fixture.
 */
interface WalkBinding {
	/** `text`, used at position `at`, carries the walk. */
	isBoundAt(text: string, at: number): boolean;
	/** The names of every bound declaration (for the controls). */
	boundNames(): string[];
}

function bindWalk(code: string, seeds: readonly string[]): WalkBinding {
	const decls = declarations(code);
	const seedNames = new Set(seeds);
	const bound = new Set<Declaration>();

	/**
	 * The declaration a name at `at` means: a function of that name (hoisted),
	 * else the last variable of that name declared before `at`, else — a
	 * function body using a module constant declared below it — the first after.
	 */
	const resolve = (name: string, at: number): Declaration | undefined => {
		let before: Declaration | undefined;
		let after: Declaration | undefined;
		for (const decl of decls) {
			if (decl.name !== name) continue;
			if (decl.hoisted) return decl;
			if (decl.index < at) before = decl;
			else if (after === undefined) after = decl;
		}
		return before ?? after;
	};
	const isBoundName = (name: string, at: number): boolean => {
		const decl = resolve(name, at);
		return decl === undefined ? seedNames.has(name) : bound.has(decl);
	};
	const isSyntheticName = (name: string, at: number): boolean => {
		const decl = resolve(name, at);
		return decl !== undefined && !decl.hoisted && !bound.has(decl) && isSyntheticInput(decl.body);
	};
	/**
	 * Every identifier in `code` (literals blanked) that is neither a property
	 * (`x.roots` — but `...roots` is a spread of a variable) nor an object key.
	 */
	const identifiers = (blanked: string): { name: string; index: number; call: boolean }[] =>
		[...blanked.matchAll(/(?<![\w$])(?<!(?<!\.)\.)([A-Za-z_$][\w$]*)(?![\w$]|\s*:)\s*(\()?/g)].map(
			(match) => ({
				name: match[1] as string,
				index: match.index,
				call: match[2] !== undefined,
			}),
		);
	/** `text` starts at code offset `at`; each name in it resolves at its own position. */
	const isBoundAt = (text: string, at: number): boolean => {
		if (hasDerivation(text)) return true;
		const blanked = blankLiterals(text).blanked;
		for (const { name, index, call } of identifiers(blanked)) {
			const here = at + index;
			if (!isBoundName(name, here)) continue;
			if (!call) return true;
			const { argument } = callArgument(blanked, blanked.indexOf('(', index));
			const synthetic = identifiers(argument).some((arg) => isSyntheticName(arg.name, here));
			if (!synthetic) return true;
		}
		return false;
	};
	const bindMutated = (block: string, at: number): boolean => {
		let changed = false;
		for (const name of mutatedNames(block)) {
			// A mutated name that resolves to no declaration (a property, a keyword
			// the regex caught) binds nothing — a binding is always a declaration.
			const decl = resolve(name, at + block.length);
			if (decl !== undefined && !bound.has(decl)) {
				bound.add(decl);
				changed = true;
			}
		}
		return changed;
	};

	const blocks = loops(code);
	let changed = true;
	while (changed) {
		changed = false;
		for (const decl of decls) {
			const at = code.indexOf(decl.body, decl.index);
			if (!bound.has(decl) && isBoundAt(decl.body, at)) {
				bound.add(decl);
				changed = true;
			}
			if (bound.has(decl) && bindMutated(decl.body, at)) changed = true;
		}
		for (const block of blocks) {
			if (isBoundAt(block.text, block.index) && bindMutated(block.text, block.index)) {
				changed = true;
			}
		}
	}
	return {
		isBoundAt,
		boundNames: () => [...new Set([...bound].map((decl) => decl.name))],
	};
}

// ---------------------------------------------------------------------------
// ROOT EVALUATION — the directories each walk is FED. A written root is
// verified against the ARGUMENT of the derivation call (the literal, join or
// cwd fed to readdirSync / scanSync / git ls-files), resolved through
// declarations, loop variables and parameters to their call sites — across
// the shared modules a gate imports — never against a substring of the file.
// ---------------------------------------------------------------------------

/** A source file the evaluator reasons over: a gate or a shared module. */
interface Unit {
	path: string;
	/** Repo-relative directory — what `import.meta.dir` means here. */
	dir: string;
	/** Comments stripped. */
	code: string;
	/** Local name → the unit and export it was imported from. */
	imports: Map<string, { unit: string; name: string }>;
}

/** A path a walk is fed, with the units whose literals NARROWED it (a repo-root base narrows nothing). */
interface FedPath {
	path: string;
	origins: Set<string>;
}

/** An expression to evaluate, in the unit and at the offset it was written, under a parameter environment. */
interface Element {
	text: string;
	unit: Unit;
	at: number;
	env: Env;
	/** The declarations this element was reached THROUGH — a declaration reached again binds nothing (recursion). */
	via: readonly Declaration[];
	/**
	 * Reached through a NARROWING the evaluator cannot decide: a predicate
	 * method (`.filter`, `.find`, `.slice(1)`), a conditional expression, or a
	 * loop whose body may skip the iteration before the walk (`continue`,
	 * `break`, `return`, an `if` on a loop-bound name). The elements listed are
	 * an OVER-approximation — some may never reach the walk — so a site fed
	 * through one is opaque, never a silent root.
	 */
	narrowed?: boolean;
}

type Env = ReadonlyMap<Declaration, readonly Element[]>;

/** The joins the evaluator understands; everything else is UNKNOWN. */
const PATH_JOIN_CALLEE = /(?:^|\.)(?:join|resolve)$/;
/** An undeclared, un-imported name spelled like the repo root (`REPO_ROOT`, `ROOT`, `REPO_DIR`). */
const REPO_ROOT_NAME = /^[A-Z_]*(?:ROOT|REPO)[A-Z_]*$/;
/** Sites: the walk calls whose first argument is a directory. */
const DIRECTORY_WALK_CALL = /\b(?:readdirSync|readdir)\s*\(/g;
const GLOB_SCAN_CALL = /(?<!\.)\.scan(?:Sync)?\s*\(/g;
const GLOB_CONSTRUCTION = /\bnew\s+(?:Bun\.)?Glob\s*\(/;

/** Split `text` at every depth-0 occurrence of `separator`, literals skipped. */
function splitTopLevel(text: string, separator: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	let i = 0;
	const n = text.length;
	while (i < n) {
		const past = skipLiteral(text, i);
		if (past !== i) {
			i = past;
			continue;
		}
		const ch = text[i] as string;
		if (ch === '(' || ch === '[' || ch === '{') depth++;
		else if (ch === ')' || ch === ']' || ch === '}') depth--;
		else if (depth === 0 && text.startsWith(separator, i)) {
			parts.push(text.slice(start, i));
			i += separator.length;
			start = i;
			continue;
		}
		i++;
	}
	parts.push(text.slice(start));
	return parts;
}

/**
 * `text` minus a trailing `as const`/`as X`/`satisfies X`, a leading `await`,
 * outer parens and a `!` — with the offset of what remains inside `text`, so a
 * position computed on the stripped expression is a position in the code.
 */
function stripExpressionAt(text: string): { text: string; offset: number } {
	let start = 0;
	let end = text.length;
	for (;;) {
		const before = text.slice(start, end);
		while (start < end && /\s/.test(text[start] as string)) start++;
		while (end > start && /\s/.test(text[end - 1] as string)) end--;
		const cast = /\s+(?:as|satisfies)\s+[\w<>[\]|,.\s]+$/.exec(text.slice(start, end));
		if (cast !== null) end -= cast[0].length;
		const awaited = /^await\s+/.exec(text.slice(start, end));
		if (awaited !== null) start += awaited[0].length;
		if (text[end - 1] === '!' && end > start) end--;
		const inner = text.slice(start, end);
		if (inner.startsWith('(') && callArgument(inner, 0).end === inner.length) {
			start++;
			end--;
		}
		if (text.slice(start, end) === before) return { text: before, offset: start };
	}
}

function stripExpression(text: string): string {
	return stripExpressionAt(text).text;
}

/** `{a,b}c` → `ac`, `bc` — one brace group, as Bun.Glob reads it. */
function expandBraces(text: string): string[] {
	const match = /\{([^{}]*)\}/.exec(text);
	if (match === null) return [text];
	return (match[1] as string)
		.split(',')
		.flatMap((member) =>
			expandBraces(
				`${text.slice(0, match.index)}${member}${text.slice(match.index + match[0].length)}`,
			),
		);
}

/**
 * A fed path as a repo-relative DIRECTORY: repo-absolute prefixes stripped,
 * the glob tail cut (`src/**\/*.ts` walks `src`), normalized; `.` is the repo
 * root. Nothing for a path outside the repo or an absolute one.
 */
function normalizeFedPath(raw: string): string | undefined {
	let path = raw.replace(/\\/g, '/');
	if (path === REPO_ROOT) path = '.';
	else if (path.startsWith(`${REPO_ROOT}/`)) path = path.slice(REPO_ROOT.length + 1);
	if (path.startsWith('/')) return undefined;
	const segments = path.split('/');
	const globAt = segments.findIndex((segment) => /[*?]/.test(segment));
	if (globAt >= 0) segments.length = globAt;
	path = posix.normalize(segments.join('/') || '.').replace(/\/$/, '');
	if (path === '' || path === './') path = '.';
	if (path.startsWith('..')) return undefined;
	return path;
}

/** Every `return <expr>;` of a function body, with its offset in the body. */
function returnExpressions(body: string): { text: string; at: number }[] {
	const out: { text: string; at: number }[] = [];
	const blanked = blankLiterals(body).blanked;
	for (const match of blanked.matchAll(/\breturn\b/g)) {
		const at = match.index + match[0].length;
		out.push({ text: statementExtent(body, at, false), at });
	}
	return out;
}

/** The expression or block after a depth-0 `=>` in an arrow function's text. */
function arrowBody(text: string): { text: string; at: number } | undefined {
	let depth = 0;
	let i = 0;
	const n = text.length;
	while (i < n) {
		const past = skipLiteral(text, i);
		if (past !== i) {
			i = past;
			continue;
		}
		const ch = text[i] as string;
		if (ch === '(' || ch === '[' || ch === '{') depth++;
		else if (ch === ')' || ch === ']' || ch === '}') depth--;
		else if (depth === 0 && text.startsWith('=>', i)) return { text: text.slice(i + 2), at: i + 2 };
		i++;
	}
	return undefined;
}

/** The parameter declarations of the function named `owner` in `decls`, in list order. */
function parametersOf(decls: readonly Declaration[], owner: string): Declaration[] {
	return decls.filter((decl) => decl.kind === 'param' && decl.owner === owner);
}

/** Bracket the innermost unclosed `(` before `index` in blanked code, or -1. */
function enclosingCallOpen(blanked: string, index: number): number {
	const stack: number[] = [];
	for (let i = 0; i < index; i++) {
		const ch = blanked[i] as string;
		if (ch === '(' || ch === '[' || ch === '{') stack.push(i);
		else if (ch === ')' || ch === ']' || ch === '}') stack.pop();
	}
	for (let k = stack.length - 1; k >= 0; k--) {
		const open = stack[k] as number;
		if (blanked[open] === '(') return open;
	}
	return -1;
}

/** `<receiver>.<name>(<argument>)` when the expression ENDS with a depth-0 method call. */
function lastMethodCall(
	expr: string,
): { receiver: string; name: string; argument: string; argumentAt: number } | undefined {
	let depth = 0;
	let i = 0;
	let found: { receiver: string; name: string; argument: string; argumentAt: number } | undefined;
	while (i < expr.length) {
		const past = skipLiteral(expr, i);
		if (past !== i) {
			i = past;
			continue;
		}
		const ch = expr[i] as string;
		if (ch === '(' || ch === '[' || ch === '{') depth++;
		else if (ch === ')' || ch === ']' || ch === '}') depth--;
		else if (ch === '.' && depth === 0 && i > 0) {
			const call = /^\.([\w$]+)\s*\(/.exec(expr.slice(i));
			if (call !== null) {
				const open = i + call[0].length - 1;
				const { argument, end } = callArgument(expr, open);
				if (end === expr.length) {
					found = {
						receiver: expr.slice(0, i),
						name: call[1] as string,
						argument,
						argumentAt: open + 1,
					};
				}
			}
		}
		i++;
	}
	return found;
}

/** The walk sites of one unit: each a derivation call with the paths it is fed. */
interface WalkSite {
	unit: string;
	/** Position among the unit's sites, in source order — a site's identity across evaluations. */
	index: number;
	kind: 'directory' | 'glob' | 'git' | 'glob-construction' | 'fixture';
	paths: FedPath[];
	/** No path of the site's argument could be evaluated (a scratch dir, a runtime value). */
	unknown: boolean;
	/** Some part of the argument was out of the evaluator's reach (a recursive call, a method result). */
	partial: boolean;
	/** The argument passed through a narrowing this rule cannot decide (see `Element.narrowed`): the site is opaque. */
	narrowed: boolean;
}

/** Methods that yield the receiver's elements in another order — never fewer of them. */
const ORDER_ONLY_METHOD = /^(?:sort|toSorted|reverse|toReversed)$/;
/** Methods that may yield FEWER of the receiver's elements (or one of them) — a predicate this rule cannot evaluate. */
const NARROWING_METHOD = /^(?:filter|find|findLast|some|every|slice|splice|at)$/;

/** Any keyword that leaves an iteration early, or an `if (` — the body may skip the walk for some elements. */
const EARLY_EXIT = /\b(?:continue|break|return|throw)\b/;

/**
 * THE EVALUATOR. Over a set of units (a gate and the shared modules it reaches,
 * or one shared module and its own imports) it finds every walk site and
 * evaluates, symbolically, the directory each is fed: string, template and
 * brace literals; `join`/`resolve`/`dirname`; `import.meta.dir`; a declared
 * variable (its initializer, by position); a loop variable (each element of
 * what it iterates, destructuring by index); a PARAMETER (each argument at
 * each call site of its function — in any unit of the set, through the import
 * that names it — or each element of the receiver a callback is mapped over);
 * a declared function call (its `return`s under the arguments); an imported
 * name (in its exporting unit). Anything else is UNKNOWN and said so — and so
 * is a site whose root candidates pass through a NARROWING (`Element.narrowed`).
 */
class RootEvaluator {
	private readonly units = new Map<string, Unit>();
	private readonly declCache = new Map<string, Declaration[]>();
	private readonly blankedCache = new Map<string, string>();
	private readonly siteCache = new Map<string, WalkSite[]>();
	/** Owners of parameters resolved with NO call site in the set — the open inputs of a parameterized lister. */
	readonly openParameters = new Set<string>();
	/** Units in which a call site fed a parameter — units that CHOSE a root through a function. */
	readonly callingUnits = new Set<string>();

	constructor(units: readonly Unit[]) {
		for (const unit of units) this.units.set(unit.path, unit);
	}

	private declsOf(unit: Unit): Declaration[] {
		let decls = this.declCache.get(unit.path);
		if (decls === undefined) {
			decls = declarations(unit.code);
			this.declCache.set(unit.path, decls);
		}
		return decls;
	}

	private blankedOf(unit: Unit): string {
		let blanked = this.blankedCache.get(unit.path);
		if (blanked === undefined) {
			blanked = blankLiterals(unit.code).blanked;
			this.blankedCache.set(unit.path, blanked);
		}
		return blanked;
	}

	/** The declaration `name` means at `at` in `unit` — the same positional rule as the binding pass. */
	private resolve(unit: Unit, name: string, at: number): Declaration | undefined {
		let before: Declaration | undefined;
		let after: Declaration | undefined;
		for (const decl of this.declsOf(unit)) {
			if (decl.name !== name) continue;
			if (decl.hoisted) return decl;
			if (decl.index < at) before = decl;
			else if (after === undefined) after = decl;
		}
		return before ?? after;
	}

	/** Every `NAME(` call in the set that names function `owner` of `unit` (through imports too), with its argument list. */
	private callSites(unit: Unit, owner: string, via: readonly Declaration[]): Element[] {
		const out: Element[] = [];
		const collect = (site: Unit, local: string): void => {
			const blanked = this.blankedOf(site);
			// Not a property (`x.walk(`) — but a spread (`...walk(`) is a call.
			for (const match of blanked.matchAll(
				new RegExp(`(?<![\\w$])(?<!(?<!\\.)\\.)${local}\\s*\\(`, 'g'),
			)) {
				if (/\bfunction\s*\*?\s*$/.test(blanked.slice(0, match.index))) continue; // the declaration itself
				const open = match.index + match[0].length - 1;
				const { argument } = callArgument(site.code, open);
				out.push({ text: argument, unit: site, at: open + 1, env: new Map(), via });
			}
		};
		collect(unit, owner);
		for (const other of this.units.values()) {
			if (other === unit) continue;
			for (const [local, target] of other.imports) {
				if (target.unit === unit.path && target.name === owner) collect(other, local);
			}
		}
		return out;
	}

	/** The `position`-th argument of a call, as an element (or nothing for a spread or a missing one). */
	private argumentAt(site: Element, decl: Declaration): Element | undefined {
		const args = splitTopLevel(site.text, ',');
		let offset = 0;
		for (let k = 0; k < args.length; k++) {
			const arg = args[k] as string;
			if (k === decl.position) {
				if (arg.trim().startsWith('...') || arg.trim() === '') return undefined;
				return this.projectElement(
					{ ...site, text: arg, at: site.at + offset },
					decl.element,
					decl.key,
				);
			}
			offset += arg.length + 1;
		}
		return undefined;
	}

	/** A destructured name's element of an array literal (`[root, prefix]` ← `[SRC_DIR, '']`), else the element itself. */
	private projectElement(element: Element, index: number | undefined, key?: string): Element {
		if (key !== undefined) {
			const { text: expr } = stripExpressionAt(element.text);
			if (!expr.startsWith('{')) return element;
			const value = this.elementsOf(element).find(
				(entry) => /^\[\s*'([^']*)'\s*,/.exec(stripExpression(entry.text))?.[1] === key,
			);
			return value === undefined ? element : this.projectElement(value, 1);
		}
		if (index === undefined) return element;
		const { text: expr, offset } = stripExpressionAt(element.text);
		if (!expr.startsWith('[')) return element;
		const members = splitTopLevel(expr.slice(1, -1), ',');
		const member = members[index];
		if (member === undefined) return element;
		const at =
			element.at +
			offset +
			1 +
			members.slice(0, index).reduce((sum, part) => sum + part.length + 1, 0);
		return { ...element, text: member, at };
	}

	/**
	 * What an expression ENUMERATES — the elements of an array literal (spreads
	 * expanded), the keys/entries/values of an object literal, and through a
	 * name: its declaration's elements, a parameter's arguments, a loop
	 * variable's iterated elements. A scalar enumerates itself.
	 */
	private elementsOf(element: Element): Element[] {
		const { text: expr, offset } = stripExpressionAt(element.text);
		const here = { ...element, text: expr, at: element.at + offset };
		if (expr === '') return [];
		if (expr.startsWith('...'))
			return this.elementsOf({ ...here, text: expr.slice(3), at: here.at + 3 });
		if (expr.startsWith('[')) {
			let offset = here.at + 1;
			return splitTopLevel(expr.slice(1, -1), ',').flatMap((member) => {
				const at = offset;
				offset += member.length + 1;
				const { text, offset: inner } = stripExpressionAt(member);
				if (text === '') return [];
				// A spread is expanded; a nested literal (a tuple) stays ONE element.
				if (text.startsWith('...')) return this.elementsOf({ ...here, text, at: at + inner });
				return [{ ...here, text, at: at + inner }];
			});
		}
		if (expr.startsWith('{')) {
			let offset = here.at + 1;
			return splitTopLevel(expr.slice(1, -1), ',').flatMap((member) => {
				const at = offset;
				offset += member.length + 1;
				const pair = /^(\s*)('[^']*'|"[^"]*"|[\w$]+)(\s*:\s*)([\s\S]*)$/.exec(member);
				if (pair === null) return [];
				const key = (pair[2] as string).replace(/^['"]|['"]$/g, '');
				// The value keeps its own position: `['key', <value>]` is one element, the
				// value text sitting where it sits in the code minus the synthetic prefix.
				const prefix = `['${key}', `;
				const valueAt =
					at + (pair[1] as string).length + (pair[2] as string).length + (pair[3] as string).length;
				return [
					{ ...here, text: `${prefix}${(pair[4] as string).trim()}]`, at: valueAt - prefix.length },
				];
			});
		}
		const objectMethod = /^Object\.(keys|entries|values)\s*\(/.exec(expr);
		if (objectMethod !== null) {
			const { argument } = callArgument(expr, objectMethod[0].length - 1);
			const entries = this.elementsOf({ ...here, text: argument });
			const project = objectMethod[1] === 'keys' ? 0 : objectMethod[1] === 'values' ? 1 : undefined;
			return entries.map((entry) => this.projectElement(entry, project));
		}
		const construction = /^new\s+(?:Map|Set)\s*\(/.exec(expr);
		if (construction !== null) {
			const { argument } = callArgument(expr, construction[0].length - 1);
			return this.elementsOf({ ...here, text: argument });
		}
		const method = lastMethodCall(expr);
		if (method !== undefined) {
			const receiver = { ...here, text: method.receiver };
			if (/^(?:keys|entries|values)$/.test(method.name)) {
				const project = method.name === 'keys' ? 0 : method.name === 'values' ? 1 : undefined;
				return this.elementsOf(receiver).map((entry) => this.projectElement(entry, project));
			}
			// The elements pass through unchanged, in some order.
			if (ORDER_ONLY_METHOD.test(method.name)) return this.elementsOf(receiver);
			// FEWER of them, by a predicate this rule cannot evaluate (`.slice()` alone copies).
			if (NARROWING_METHOD.test(method.name)) {
				const narrowed = method.name !== 'slice' || method.argument.trim() !== '';
				return this.elementsOf(receiver).map((each) => ({
					...each,
					narrowed: each.narrowed === true || narrowed,
				}));
			}
			// `X.map((x) => expr)`: every element of X through the callback's body.
			if (/^(?:map|flatMap)$/.test(method.name)) {
				const arrowAt =
					element.at +
					method.argumentAt +
					(method.argument.length - method.argument.trimStart().length);
				const param = this.declsOf(element.unit).find(
					(decl) => decl.kind === 'param' && decl.index === arrowAt && decl.position === 0,
				);
				const body = arrowBody(method.argument);
				if (param === undefined || body === undefined) return [here];
				return this.elementsOf(receiver).map((each) => ({
					...here,
					text: body.text,
					at: element.at + method.argumentAt + body.at,
					env: new Map([...element.env, [param, [each]]]),
				}));
			}
			return [here];
		}
		// `X.prop` — the value under that key of an object literal X.
		const property = /^([\s\S]+?)\.([\w$]+)$/.exec(expr);
		if (property !== null && !/[()[\]]/.test(property[2] as string)) {
			const entries = this.elementsOf({ ...here, text: property[1] as string });
			const values = entries.flatMap((entry) => {
				const pair = stripExpression(entry.text);
				const key = /^\[\s*'([^']*)'\s*,/.exec(pair)?.[1];
				return key === property[2] ? [this.projectElement(entry, 1)] : [];
			});
			return values.length > 0 ? values : [here];
		}
		if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
			const decl = this.resolve(element.unit, expr, element.at);
			if (decl === undefined) {
				const imported = element.unit.imports.get(expr);
				const target = imported === undefined ? undefined : this.units.get(imported.unit);
				if (target === undefined) return [here];
				const exported = this.resolve(target, imported?.name ?? expr, target.code.length);
				return exported === undefined ? [here] : this.elementsOfDeclaration(target, exported, here);
			}
			const bound = element.env.get(decl);
			if (bound !== undefined) return bound.flatMap((value) => this.elementsOf(value));
			return this.elementsOfDeclaration(element.unit, decl, here);
		}
		return [here];
	}

	private elementsOfDeclaration(unit: Unit, decl: Declaration, fallback: Element): Element[] {
		if (fallback.via.includes(decl)) return [];
		const via = [...fallback.via, decl];
		const at = unit.code.indexOf(decl.body, decl.index);
		const body: Element = { text: decl.body, unit, at, env: fallback.env, via };
		switch (decl.kind) {
			case 'var':
				return this.elementsOf(body).map((element) =>
					this.projectElement(element, decl.element, decl.key),
				);
			case 'loop': {
				const narrowed = this.loopGuarded(unit, decl, fallback.at);
				return this.elementsOf(body).map((element) => ({
					...this.projectElement(element, decl.element, decl.key),
					narrowed: element.narrowed === true || narrowed,
				}));
			}
			case 'param': {
				const fed: Element[] = [];
				if (decl.body.trim() !== '') fed.push(...this.elementsOf(body));
				if (decl.receiver !== undefined) {
					const receiver: Element = {
						text: decl.receiver,
						unit,
						at: decl.receiverAt ?? decl.index,
						env: new Map(),
						via,
					};
					fed.push(
						...this.elementsOf(receiver).map((element) =>
							this.projectElement(element, decl.element, decl.key),
						),
					);
				} else if (decl.owner !== undefined) {
					const sites = this.callSites(unit, decl.owner, via);
					if (sites.length === 0 && fed.length === 0)
						this.openParameters.add(`${unit.path}:${decl.owner}`);
					for (const site of sites) {
						const argument = this.argumentAt(site, decl);
						if (argument === undefined) continue;
						this.callingUnits.add(site.unit.path);
						fed.push(...this.elementsOf(argument));
					}
				}
				return fed;
			}
			case 'function':
				return [fallback];
		}
	}

	/**
	 * Between a loop's head and a use of its variable at `useAt` (inside the
	 * body), does the body leave an iteration early (`continue`/`break`/
	 * `return`/`throw`) or test a loop-bound name (`if (prefix === 'tools/')`)?
	 * Then the elements the head iterates are not all fed to the use: GATE-34's
	 * outcome (the tools tree skipped) spelled as a guard instead of a dropped
	 * literal.
	 */
	private loopGuarded(unit: Unit, decl: Declaration, useAt: number): boolean {
		const blanked = this.blankedOf(unit);
		const open = unit.code.indexOf('(', decl.index);
		if (open < 0) return false;
		const headEnd = callArgument(unit.code, open).end;
		let bodyStart = headEnd;
		while (bodyStart < unit.code.length && /\s/.test(unit.code[bodyStart] as string)) bodyStart++;
		const bodyEnd =
			unit.code[bodyStart] === '{'
				? callArgument(unit.code, bodyStart).end
				: bodyStart + statementExtent(unit.code, bodyStart, false).length;
		// Before the use: any early exit skips the walk for some elements.
		const before = blanked.slice(headEnd, Math.min(Math.max(useAt, headEnd), bodyEnd));
		if (EARLY_EXIT.test(before)) return true;
		// Anywhere in the body: an `if` on a loop-bound name and on NOTHING an inner
		// loop binds — before the walk it guards it; after it, in the loop over the
		// walk's results, it sifts what the walk yielded BY THE ROOT it came from
		// (`if (prefix) continue`). A condition that also names an inner loop's
		// variable (`if (\`${prefix}${rel}\` === 'src/core/db/postgres.ts')`) is a
		// per-element exclusion, not a root guard.
		const loops = this.declsOf(unit).filter((each) => each.kind === 'loop');
		const names = loops.filter((each) => each.index === decl.index).map((each) => each.name);
		const inner = loops
			.filter((each) => each.index > decl.index && each.index < bodyEnd)
			.map((each) => each.name)
			.filter((name) => !names.includes(name));
		const bound = new RegExp(`(?<![\\w$.])(?:${names.join('|')})(?![\\w$])`);
		const sifted =
			inner.length === 0 ? undefined : new RegExp(`(?<![\\w$.])(?:${inner.join('|')})(?![\\w$])`);
		const body = blanked.slice(headEnd, bodyEnd);
		for (const guard of body.matchAll(/\bif\s*\(/g)) {
			const { argument } = callArgument(body, guard.index + guard[0].length - 1);
			if (bound.test(argument) && !sifted?.test(argument)) return true;
		}
		return false;
	}

	/** The paths a SCALAR expression evaluates to (an enumerating one: every element's). */
	private pathsOf(element: Element, sink: WalkSite): FedPath[] {
		const elements = this.elementsOf(element);
		if (elements.length !== 1 || elements[0]?.text !== stripExpression(element.text)) {
			return elements.flatMap((each) => this.pathsOf(each, sink));
		}
		return this.scalarPaths(elements[0] as Element, sink);
	}

	/**
	 * A narrowing matters when it selects among ROOT candidates. The names a
	 * listing yields (`*`) are narrowed by every recursive walker (`continue` on
	 * node_modules, then `walk(child)`) and root nothing: the root was chosen
	 * where the listing was fed, not where its results were sifted.
	 */
	private scalarPaths(element: Element, sink: WalkSite): FedPath[] {
		const paths = this.scalarPathsOf(element, sink);
		if (element.narrowed === true && paths.some((fed) => fed.path !== '*')) sink.narrowed = true;
		return paths;
	}

	private scalarPathsOf(element: Element, sink: WalkSite): FedPath[] {
		const { unit } = element;
		const stripped = stripExpressionAt(element.text);
		const expr = stripped.text.replace(/\.(?:pathname|href)$/, '');
		const at = element.at + stripped.offset;
		const own = (path: string): FedPath => ({ path, origins: new Set([unit.path]) });
		if (expr === '') return [];
		const quote = expr[0] as string;
		if (quote === "'" || quote === '"') {
			return expandBraces(expr.slice(1, -1)).map(own);
		}
		if (quote === '`') {
			return this.templatePaths(expr.slice(1, -1), element, sink);
		}
		if (expr === 'import.meta.dir') return [own(unit.dir)];
		if (/^import\.meta\.(?:path|url|file|filename)$/.test(expr)) return [own(unit.path)];
		if (/^process\.cwd\(\s*\)$/.test(expr)) return [own('.')];
		const call = /^(?:new\s+)?([\w$.]+)\s*\(/.exec(expr);
		if (call !== null && callArgument(expr, call[0].length - 1).end === expr.length) {
			const callee = call[1] as string;
			const { argument } = callArgument(expr, call[0].length - 1);
			const argsAt = at + expr.indexOf('(') + 1;
			const args = splitTopLevel(argument, ',');
			const arg = (k: number): Element | undefined => {
				const text = args[k];
				if (text === undefined || text.trim() === '') return undefined;
				const offset = args.slice(0, k).reduce((sum, part) => sum + part.length + 1, 0);
				return { ...element, text, at: argsAt + offset };
			};
			if (PATH_JOIN_CALLEE.test(callee)) {
				return this.joinPaths(
					args.map((_, k) => arg(k)).filter((each): each is Element => each !== undefined),
					sink,
				);
			}
			// What a listing yields: NAMES under the listed directory — any of them.
			if (/^(?:readdirSync|readdir)$/.test(callee)) return [own('*')];
			if (/(?:^|\.)dirname$/.test(callee)) {
				const first = arg(0);
				return first === undefined
					? []
					: this.pathsOf(first, sink).map((fed) => ({ ...fed, path: posix.dirname(fed.path) }));
			}
			if (/(?:^|\.)(?:fileURLToPath|String|normalize)$/.test(callee)) {
				const first = arg(0);
				return first === undefined ? [] : this.pathsOf(first, sink);
			}
			if (callee === 'URL') {
				const [relativeArg, baseArg] = [arg(0), arg(1)];
				if (relativeArg === undefined || baseArg === undefined) return [];
				const bases = this.pathsOf(baseArg, sink).map((fed) => ({
					...fed,
					path: posix.dirname(fed.path),
				}));
				return this.joinFed([bases, this.pathsOf(relativeArg, sink)]);
			}
			// A declared (or imported) function: its returns under the arguments.
			const target = this.functionTarget(unit, callee, at);
			if (target !== undefined) {
				const env = new Map<Declaration, readonly Element[]>(element.env);
				for (const param of parametersOf(this.declsOf(target.unit), target.decl.name)) {
					const value = param.position === undefined ? undefined : arg(param.position);
					if (value !== undefined)
						env.set(param, [this.projectElement(value, param.element, param.key)]);
				}
				return this.returnPaths(target.unit, target.decl, env, element.via, sink);
			}
			sink.partial = true;
			return [];
		}
		const concatenation = splitTopLevel(expr, '+');
		if (concatenation.length > 1) {
			let offset = 0;
			const parts: Element[] = concatenation.map((part) => {
				const each = { ...element, text: part, at: at + offset };
				offset += part.length + 1;
				return each;
			});
			return this.joinFed(
				parts.map((part) => this.pathsOf(part, sink)),
				'',
			);
		}
		for (const separator of ['??', '||']) {
			const alternatives = splitTopLevel(expr, separator);
			if (alternatives.length > 1) {
				let offset = 0;
				return alternatives.flatMap((alternative) => {
					const each = { ...element, text: alternative, at: at + offset };
					offset += alternative.length + separator.length;
					return this.pathsOf(each, sink);
				});
			}
		}
		if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
			const decl = this.resolve(unit, expr, at);
			if (decl === undefined && !unit.imports.has(expr)) {
				if (REPO_ROOT_NAME.test(expr)) return [own('.')];
				sink.partial = true;
				return [];
			}
			if (decl?.kind === 'function') {
				sink.partial = true;
				return [];
			}
			// A name that resolves to something the element pass could not enumerate further.
			sink.partial = true;
			return [];
		}
		// A conditional (`flag ? SRC_ONLY : ALL`), string surgery, a method result: unreadable, said so.
		sink.partial = true;
		return [];
	}

	/** `${expr}` parts evaluated, the text between them kept, joined WITHOUT separators. */
	private templatePaths(content: string, element: Element, sink: WalkSite): FedPath[] {
		const parts: FedPath[][] = [];
		const own = (path: string): FedPath => ({ path, origins: new Set([element.unit.path]) });
		let i = 0;
		let text = '';
		while (i < content.length) {
			if (!content.startsWith('${', i)) {
				text += content[i];
				i++;
				continue;
			}
			if (text !== '') parts.push(expandBraces(text).map(own));
			text = '';
			// The matching `}` of this `${`, literals inside skipped.
			let depth = 0;
			let j = i + 2;
			while (j < content.length) {
				const past = skipLiteral(content, j);
				if (past !== j) {
					j = past;
					continue;
				}
				const ch = content[j] as string;
				if (ch === '{' || ch === '(' || ch === '[') depth++;
				else if (ch === ')' || ch === ']') depth--;
				else if (ch === '}') {
					if (depth === 0) break;
					depth--;
				}
				j++;
			}
			// The literal's content starts one past its opening backtick.
			parts.push(
				this.pathsOf(
					{ ...element, text: content.slice(i + 2, j), at: element.at + 1 + i + 2 },
					sink,
				),
			);
			i = j + 1;
		}
		if (text !== '') parts.push(expandBraces(text).map(own));
		return this.joinFed(parts, '');
	}

	/** The function `callee` names at `at` in `unit`: declared there, or imported from another unit of the set. */
	private functionTarget(
		unit: Unit,
		callee: string,
		at: number,
	): { unit: Unit; decl: Declaration } | undefined {
		if (!/^[A-Za-z_$][\w$]*$/.test(callee)) return undefined;
		const decl = this.resolve(unit, callee, at);
		if (decl !== undefined) {
			if (decl.kind === 'function' || (decl.kind === 'var' && arrowBody(decl.body) !== undefined))
				return { unit, decl };
			return undefined;
		}
		const imported = unit.imports.get(callee);
		const target = imported === undefined ? undefined : this.units.get(imported.unit);
		if (target === undefined) return undefined;
		const exported = this.resolve(target, imported?.name ?? callee, target.code.length);
		if (exported === undefined) return undefined;
		if (
			exported.kind === 'function' ||
			(exported.kind === 'var' && arrowBody(exported.body) !== undefined)
		) {
			return { unit: target, decl: exported };
		}
		return undefined;
	}

	/** The paths a function's `return`s (or an arrow's expression) evaluate to under `env`. */
	private returnPaths(
		unit: Unit,
		decl: Declaration,
		env: Env,
		via: readonly Declaration[],
		sink: WalkSite,
	): FedPath[] {
		if (via.includes(decl)) return [];
		const through = [...via, decl];
		const bodyAt = unit.code.indexOf(decl.body, decl.index);
		let body = { text: decl.body, at: bodyAt };
		if (decl.kind === 'var') {
			const arrow = arrowBody(decl.body);
			if (arrow === undefined) return [];
			body = { text: arrow.text, at: bodyAt + arrow.at };
			if (!stripExpression(arrow.text).startsWith('{')) {
				return this.pathsOf({ text: arrow.text, unit, at: body.at, env, via: through }, sink);
			}
		}
		return returnExpressions(body.text).flatMap(({ text, at }) =>
			this.pathsOf({ text, unit, at: body.at + at, env, via: through }, sink),
		);
	}

	private joinPaths(parts: readonly Element[], sink: WalkSite): FedPath[] {
		return this.joinFed(parts.map((part) => this.pathsOf(part, sink)));
	}

	/** The cartesian join of path sets; a part that is the repo root narrows nothing and lends no origin. */
	private joinFed(parts: readonly FedPath[][], separator = '/'): FedPath[] {
		let acc: FedPath[] = [{ path: '', origins: new Set() }];
		for (const part of parts) {
			if (part.length === 0) return [];
			const next: FedPath[] = [];
			for (const left of acc) {
				for (const right of part) {
					const path = left.path === '' ? right.path : `${left.path}${separator}${right.path}`;
					const origins = new Set(left.origins);
					// A part that IS the repo root (however spelled) narrows nothing.
					if (right.path !== '' && normalizeFedPath(right.path) !== '.') {
						for (const origin of right.origins) origins.add(origin);
					}
					next.push({ path, origins });
				}
			}
			acc = next;
		}
		return acc;
	}

	/** The glob patterns a `.scanSync(` receiver was constructed with. */
	private patternsOf(element: Element, sink: WalkSite): FedPath[] {
		const { text: expr, offset } = stripExpressionAt(element.text);
		const construction = GLOB_CONSTRUCTION.exec(expr);
		if (construction !== null && construction.index === 0) {
			const { argument } = callArgument(expr, construction[0].length - 1);
			return this.pathsOf(
				{ ...element, text: argument, at: element.at + offset + construction[0].length },
				sink,
			);
		}
		if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
			return this.elementsOf(element).flatMap((each) =>
				each.text === expr ? [] : this.patternsOf(each, sink),
			);
		}
		return [];
	}

	/** The `cwd:` of a scan options object, the string itself, or the repo root when absent. */
	private scanCwd(element: Element, sink: WalkSite): FedPath[] {
		const { text: expr, offset: start } = stripExpressionAt(element.text);
		if (expr === '') return [{ path: '.', origins: new Set() }];
		if (expr.startsWith('{')) {
			const members = splitTopLevel(expr.slice(1, -1), ',');
			let offset = start + 1;
			for (const member of members) {
				const cwd = /^\s*cwd\s*:/.exec(member);
				if (cwd !== null) {
					return this.pathsOf(
						{
							...element,
							text: member.slice(cwd[0].length),
							at: element.at + offset + cwd[0].length,
						},
						sink,
					);
				}
				if (/^\s*cwd\s*$/.test(member))
					return this.pathsOf({ ...element, text: 'cwd', at: element.at + offset }, sink);
				offset += member.length + 1;
			}
			return [{ path: '.', origins: new Set() }];
		}
		return this.pathsOf(
			{ ...element, text: splitTopLevel(expr, ',')[0] ?? '', at: element.at + start },
			sink,
		);
	}

	/** A `git ls-files …` call: `-C <dir>`/`cwd:` as the base, the pathspecs joined onto it. */
	private gitPaths(args: Element, literalOnly: boolean, sink: WalkSite): FedPath[] {
		const tokens: (Element | string)[] = [];
		let offset = 0;
		let base: FedPath[] = [{ path: '.', origins: new Set() }];
		const pushExpr = (text: string, rawAt: number): void => {
			const { text: expr, offset } = stripExpressionAt(text);
			const at = rawAt + offset;
			if (expr === '') return;
			const quote = expr[0] as string;
			if (quote === "'" || quote === '"') {
				for (const token of expr.slice(1, -1).split(/\s+/)) if (token !== '') tokens.push(token);
			} else if (quote === '`') {
				sink.partial = true;
			} else if (expr.startsWith('[')) {
				let inner = 1;
				for (const member of splitTopLevel(expr.slice(1, -1), ',')) {
					pushExpr(member, at + inner);
					inner += member.length + 1;
				}
			} else if (expr.startsWith('{')) {
				base = this.scanCwd({ ...args, text: expr, at }, sink);
			} else {
				tokens.push({ ...args, text: expr, at });
			}
		};
		if (literalOnly) pushExpr(args.text, args.at);
		else {
			for (const part of splitTopLevel(args.text, ',')) {
				pushExpr(part, args.at + offset);
				offset += part.length + 1;
			}
		}
		const specs: FedPath[][] = [];
		for (let k = 0; k < tokens.length; k++) {
			const token = tokens[k] as Element | string;
			if (typeof token === 'string') {
				if (token === 'git' || token === 'ls-files') continue;
				if (token === '-C') {
					const next = tokens[++k];
					if (next === undefined) continue;
					base =
						typeof next === 'string'
							? [{ path: next, origins: new Set() }]
							: this.pathsOf(next, sink);
					continue;
				}
				if (token.startsWith('-')) continue;
				specs.push(
					expandBraces(token).map((path) => ({ path, origins: new Set([args.unit.path]) })),
				);
			} else specs.push(this.pathsOf(token, sink));
		}
		if (specs.length === 0) return base;
		return specs.flatMap((spec) => this.joinFed([base, spec]));
	}

	/** Every walk site of a unit, evaluated. */
	sitesOf(path: string): WalkSite[] {
		const cached = this.siteCache.get(path);
		if (cached !== undefined) return cached;
		const unit = this.units.get(path);
		if (unit === undefined) return [];
		const sites: WalkSite[] = [];
		this.siteCache.set(path, sites);
		const site_ = (kind: WalkSite['kind']): WalkSite => ({
			unit: path,
			index: sites.length,
			kind,
			paths: [],
			unknown: false,
			partial: false,
			narrowed: false,
		});
		// A site fed through a narrowing is OPAQUE: its over-approximated paths are not roots.
		const push = (site: WalkSite): void => {
			if (site.narrowed) {
				site.paths = [];
				site.unknown = true;
			}
			sites.push(site);
		};
		const blanked = this.blankedOf(unit);
		const element = (text: string, at: number): Element => ({
			text,
			unit,
			at,
			env: new Map(),
			via: [],
		});
		for (const match of blanked.matchAll(DIRECTORY_WALK_CALL)) {
			const open = match.index + match[0].length - 1;
			const { argument } = callArgument(unit.code, open);
			const site = site_('directory');
			const first = splitTopLevel(argument, ',')[0] ?? '';
			site.paths = this.pathsOf(element(first, open + 1), site);
			if (site.paths.length === 0) site.unknown = true;
			push(site);
		}
		for (const match of blanked.matchAll(GLOB_SCAN_CALL)) {
			const open = match.index + match[0].length - 1;
			const receiver = primaryExpressionBefore(blanked, match.index);
			const site = site_('glob');
			const patterns = this.patternsOf(
				element(unit.code.slice(receiver.at, match.index), receiver.at),
				site,
			);
			if (patterns.length === 0) {
				// Not a Glob (or one whose pattern is out of reach): no path, said so.
				site.unknown = true;
				push(site);
				continue;
			}
			const { argument } = callArgument(unit.code, open);
			const cwds = this.scanCwd(element(argument, open + 1), site);
			site.paths = this.joinFed([cwds, patterns]);
			if (site.paths.length === 0) site.unknown = true;
			push(site);
		}
		if (GLOB_CONSTRUCTION.test(blanked) && !GLOB_SCAN_CALL.test(blanked)) {
			sites.push({ ...site_('glob-construction'), unknown: true });
		}
		GLOB_SCAN_CALL.lastIndex = 0;
		const { literals } = blankLiterals(unit.code);
		for (const literal of literals) {
			if (GIT_INDEX_LITERAL.test(literal.content)) {
				const site = site_('git');
				const open = enclosingCallOpen(blanked, literal.index);
				if (open < 0) {
					site.paths = this.gitPaths(
						element(
							unit.code.slice(literal.index, literal.index + literal.content.length + 2),
							literal.index,
						),
						true,
						site,
					);
				} else {
					const { argument } = callArgument(unit.code, open);
					site.paths = this.gitPaths(element(argument, open + 1), false, site);
				}
				push(site);
			} else if (
				FIXTURE_IMPORT_LITERAL.test(literal.content) &&
				IMPORT_FROM_TAIL.test(literal.preceding)
			) {
				sites.push(site_('fixture'));
			}
		}
		return sites;
	}

	/** Every unit's sites — the whole set, so a gate's choice through a lister's parameter is found. */
	allSites(): WalkSite[] {
		return [...this.units.keys()].flatMap((path) => this.sitesOf(path));
	}
}

/** What one unit is fed, over the whole set: its own sites' paths, plus every path its literals narrowed. */
interface Feed {
	/** Repo-relative directories, normalized, deduplicated, sorted; only tracked directories (and `.`). */
	roots: string[];
	/**
	 * The same, PER WALK SITE: one sorted group per site that is fed at least
	 * one repo directory (the unit's own sites, and any site elsewhere the
	 * unit's literal narrowed) — so a gate with two walks cannot hide the
	 * narrowing of one behind the other's roots. Keyed by the site's identity.
	 */
	groups: Map<string, string[]>;
	/** The unit has walk sites of its own, or NARROWED a path some unit walks (its literal chose the root). */
	chooses: boolean;
	/** Sites of the unit no path of whose argument could be evaluated — opaque to this rule. */
	opaqueSites: number;
	/** The unit's own sites. */
	ownSites: number;
}

/** A fed path that is a tracked repo directory, normalized — else nothing. */
function repoDirectoryOf(
	fed: FedPath,
	isRepoDirectory: (path: string) => boolean,
): string | undefined {
	const path = normalizeFedPath(fed.path);
	return path !== undefined && isRepoDirectory(path) ? path : undefined;
}

function feedOf(
	evaluator: RootEvaluator,
	unit: string,
	isRepoDirectory: (path: string) => boolean,
): Feed {
	const all = evaluator.allSites();
	const own = all.filter((site) => site.unit === unit);
	const roots = new Set<string>();
	const groups = new Map<string, string[]>();
	let narrowed = false;
	for (const site of all) {
		const group = new Set<string>();
		for (const fed of site.paths) {
			const path = repoDirectoryOf(fed, isRepoDirectory);
			if (path === undefined) continue;
			// Nobody NARROWS to the whole repo: `.` is a root only of the unit whose own site walks it.
			const chosen = fed.origins.has(unit) && path !== '.';
			if (site.unit !== unit && !chosen) continue;
			if (chosen) narrowed = true;
			roots.add(path);
			group.add(path);
		}
		if (group.size > 0) groups.set(`${site.unit}#${site.index}`, [...group].sort());
	}
	return {
		roots: [...roots].sort(),
		groups,
		chooses: own.length > 0 || narrowed,
		opaqueSites: own.filter((site) => site.unknown).length,
		ownSites: own.length,
	};
}

/** Groups as a canonical multiset string: each group's roots joined, the groups sorted — `a b; a b; c`. */
function canonicalGroups(groups: Iterable<readonly string[]>): string {
	return [...groups]
		.map((group) => [...group].sort().join(' '))
		.sort()
		.join('; ');
}

/** `import { a, b as c } from '<rel>.ts'` — the local names a unit imports from each relative target. */
function parseImports(
	code: string,
): { target: string; names: { local: string; name: string }[] }[] {
	const out: { target: string; names: { local: string; name: string }[] }[] = [];
	// `import type` runs nothing of the module: not an edge. A side-effect or
	// namespace import runs it and names nothing.
	for (const match of code.matchAll(
		/\bimport\s+(?:(\{[^}]*\}|[\w$]+|\*\s+as\s+[\w$]+)\s+from\s+)?'(\.\.?\/[^']+\.ts)'/g,
	)) {
		const clause = match[1] ?? '*';
		const names: { local: string; name: string }[] = [];
		if (clause.startsWith('*')) {
			// nothing nameable
		} else if (clause.startsWith('{')) {
			for (const part of clause.slice(1, -1).split(',')) {
				const spec = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
				if (spec !== null)
					names.push({ name: spec[1] as string, local: spec[2] ?? (spec[1] as string) });
			}
		} else names.push({ name: 'default', local: clause });
		out.push({ target: match[2] as string, names });
	}
	return out;
}

/** Read one repo file, or nothing when it is absent — the tree, or a synthetic one in the controls. */
type SourceReader = (path: string) => string | undefined;

const repoReader: SourceReader = (path) =>
	existsSync(join(REPO_ROOT, path)) ? readRepo(path) : undefined;

/**
 * The unit set of a file: itself and every shared-infrastructure module it
 * reaches through relative imports, transitively (the engine under test —
 * src/, tools/ — is never a corpus lister for its own gate). Import maps are
 * resolved so a name used in one unit is found in the unit that exports it.
 */
function unitsOf(file: string, read: SourceReader): Unit[] {
	const units = new Map<string, Unit>();
	const visit = (path: string): void => {
		if (units.has(path)) return;
		const source = read(path);
		if (source === undefined) return;
		const code = stripComments(source);
		const unit: Unit = { path, dir: posix.dirname(path), code, imports: new Map() };
		units.set(path, unit);
		for (const { target, names } of parseImports(code)) {
			const resolved = posix.normalize(posix.join(posix.dirname(path), target));
			if (!SHARED_MODULE_PREFIXES.some((prefix) => resolved.startsWith(prefix))) continue;
			if (read(resolved) === undefined) continue;
			for (const { local, name } of names) unit.imports.set(local, { unit: resolved, name });
			visit(resolved);
		}
	};
	visit(file);
	return [...units.values()];
}

/** Every tracked directory of the repo (and `.`), from the git index — the set a fed root must be in. */
function trackedDirectories(): Set<string> {
	const listing = Bun.spawnSync(['git', '-C', REPO_ROOT, 'ls-files', '-z']);
	if (listing.exitCode !== 0) throw new Error(`git ls-files failed: ${listing.stderr.toString()}`);
	const dirs = new Set<string>(['.']);
	for (const file of listing.stdout.toString().split('\0')) {
		let dir = posix.dirname(file);
		while (dir !== '.' && dir !== '' && !dirs.has(dir)) {
			dirs.add(dir);
			dir = posix.dirname(dir);
		}
	}
	return dirs;
}

/** The value of `const NAME = <int>` in the gate or any imported module — a named floor — else nothing. */
function numericConstantValue(name: string, sources: readonly string[]): number | undefined {
	const declared = new RegExp(`\\bconst\\s+${name}\\s*(?::[^=]+)?=\\s*(\\d+)\\s*;`);
	for (const source of sources) {
		const match = declared.exec(source);
		if (match !== null) return Number(match[1]);
	}
	return undefined;
}

/**
 * A floor REJECTS AN EMPTY WALK, or it is not one: `toBeGreaterThan(n)` with
 * n ≥ 0, `toBeGreaterThanOrEqual(n)` with n ≥ 1 — a SCREAMING constant
 * resolved to its value. `toBeGreaterThanOrEqual(0)` (or `>= ZERO_FLOOR` with
 * `const ZERO_FLOOR = 0`) is satisfied by a walk that found nothing: the
 * vacuity a floor exists to catch, spelled as a floor.
 */
function rejectsEmptyWalk(site: FloorSite, sources: readonly string[]): boolean {
	if (site.floor === 'EXACT_SET') return true;
	const value = /^\d+$/.test(site.floor)
		? Number(site.floor)
		: numericConstantValue(site.floor, sources);
	if (value === undefined) return false;
	return site.orEqual ? value >= 1 : value >= 0;
}

/**
 * The exports of the imported modules that are themselves BOUND to a walk —
 * a function whose body walks, a constant filled from one — resolved to a
 * fixed point across the modules (a helper's export bound through another
 * helper's walk counts). A module's other exports (a policy array beside the
 * walk, a floor constant, the repo root) seed nothing: `expect([...ZERO_TIER])
 * .toEqual([…])` on a hand-written list exported by a walking module is not a
 * floor on that module's walk.
 */
function boundExports(modules: readonly ImportedModule[]): string[] {
	const bound = new Map<string, string[]>(modules.map((module) => [module.path, []]));
	let changed = true;
	while (changed) {
		changed = false;
		for (const module of modules) {
			const seeds = modules
				.filter((other) => other.path !== module.path)
				.flatMap((other) => bound.get(other.path) ?? []);
			const exported = new Set(exportedNames(module.code));
			const names = bindWalk(module.code, seeds)
				.boundNames()
				.filter((name) => exported.has(name))
				.sort();
			if (names.join(' ') !== (bound.get(module.path) ?? []).join(' ')) {
				bound.set(module.path, names);
				changed = true;
			}
		}
	}
	return [...new Set(modules.flatMap((module) => bound.get(module.path) ?? []))];
}

/** True iff some numeric floor's expect() argument is bound to the walk. */
function hasBoundFloor(code: string, modules: readonly ImportedModule[]): boolean {
	const seeds = [
		...boundExports(modules),
		// A frozen census fixture binds the name it is imported under.
		...[...code.matchAll(/import\s+(\w+)\s+from\s+'\.\.\/fixtures\/[^']+\.json'/g)].map(
			(match) => match[1] as string,
		),
	];
	const binding = bindWalk(code, seeds);
	const sources = [code, ...modules.map((module) => module.code)];
	for (const site of floorSites(code)) {
		if (!site.unconditional) continue;
		if (!rejectsEmptyWalk(site, sources)) continue;
		if (binding.isBoundAt(site.argument, site.index)) return true;
	}
	return false;
}

interface Lists {
	closedSet?: ClosedSetExemption;
	handList: boolean;
	floorless: boolean;
}

function classify(
	invariant: string,
	source: string,
	modules: readonly ImportedModule[],
	lists: Lists,
): Verdict {
	const claims = claimsTotality(invariant);
	const code = stripComments(source);
	const ownWalk = hasDerivation(code);
	const walks = ownWalk || modules.some((module) => hasDerivation(module.code));
	const shape: Shape = walks ? 'walk' : HAND_PATH_LITERAL.test(code) ? 'hand' : 'none';
	const boundFloor = walks && hasBoundFloor(code, modules);
	const exempt = lists.closedSet !== undefined && source.includes(lists.closedSet.corpusToken);
	let ok: boolean;
	if (claims) ok = exempt || (walks && boundFloor);
	else if (shape === 'walk') ok = boundFloor || lists.floorless;
	else if (shape === 'hand') ok = lists.handList;
	else ok = true;
	return { claims, shape, ownWalk, boundFloor, exempt, ok };
}

// ---------------------------------------------------------------------------
// The live census.
// ---------------------------------------------------------------------------

function readRepo(file: string): string {
	return readFileSync(join(REPO_ROOT, file), 'utf8');
}

/**
 * The shared-infrastructure modules a gate reaches through relative imports,
 * transitively, comments stripped — the unit set minus the gate itself. The
 * engine under test (src/, tools/) is never a corpus lister for its own gate.
 */
function importedSharedModules(file: string): ImportedModule[] {
	return unitsOf(file, repoReader)
		.filter((unit) => unit.path !== file)
		.map((unit) => ({ path: unit.path, code: unit.code }));
}

interface LiveVerdict {
	file: string;
	verdict: Verdict;
	modules: ImportedModule[];
}

function liveIndexRows(): IndexRow[] {
	return parseIndexRows(readFileSync(TRIPWIRE_INDEX, 'utf8'));
}

const CLOSED_SETS = new Map(ENUMERATED_CLOSED_SET_CENSUSES.map((entry) => [entry.file, entry]));

/** The verdict on one gate file under its (possibly empty) index row. */
function verdictOf(file: string, invariant: string): LiveVerdict {
	const modules = importedSharedModules(file);
	return {
		file,
		modules,
		verdict: classify(invariant, readRepo(file), modules, {
			closedSet: CLOSED_SETS.get(file),
			handList: file in ENUMERATED_HAND_PATH_LISTS,
			floorless: file in FLOORLESS_WALK_BASELINE,
		}),
	};
}

function liveVerdicts(): LiveVerdict[] {
	return liveIndexRows().map((row) => verdictOf(row.file, row.invariant));
}

/**
 * An enumerated entry is anchored to a FILE, not to an index row: it must exist
 * on disk and still be the shape it describes — so a gate written beside this
 * one can be listed before its row lands, and a deleted gate's entry is stale.
 */
function entryVerdict(file: string): Verdict | undefined {
	if (!existsSync(join(REPO_ROOT, file))) return undefined;
	return verdictOf(file, '').verdict;
}

function describeVerdict(verdict: Verdict): string {
	return `shape: ${verdict.shape}, bound floor: ${verdict.boundFloor ? 'yes' : 'NO'}, TOTAL row: ${verdict.claims ? 'yes' : 'no'}`;
}

/**
 * The two whole-index tests classify EVERY registered gate's source (~5 s on a
 * loaded developer machine, 2026-10-12, measured at 5.2 s against Bun's 5 s
 * default — the index grows with every gate): an explicit bound, the one the
 * hermetic tier passes anyway (`bun test --timeout=30000`), so a bare `bun test`
 * judges the census, not the machine's load.
 */
const CLASSIFY_TIMEOUT_MS = 30_000;

describe('the census is the index — every registered gate is classified from its source', () => {
	test(
		'the index parses, every named gate exists, and the claim set is populated (anti-vacuity)',
		() => {
			const markdown = readFileSync(TRIPWIRE_INDEX, 'utf8');
			const rows = parseIndexRows(markdown);
			expect(rows.length).toBeGreaterThan(100);
			// TOTAL over the index: every line that names a gate is a row — a parser
			// that requires a closing `|` dropped three rows and nobody could see it.
			expect(rows.length).toBe(indexRowLines(markdown));
			expect(new Set(rows.map((row) => row.file)).size).toBe(rows.length);
			for (const row of rows) {
				expect(
					existsSync(join(REPO_ROOT, row.file)),
					`${row.file} is named by the index but absent`,
				).toBe(true);
			}
			// 25 TOTAL rows on 2026-09-02: the claim grammar still matches the index.
			expect(rows.filter((row) => claimsTotality(row.invariant)).length).toBeGreaterThan(20);
			// And the shapes are populated: a classifier that saw no walks would pass every rule vacuously.
			const verdicts = liveVerdicts();
			expect(verdicts.filter(({ verdict }) => verdict.shape === 'walk').length).toBeGreaterThan(80);
			expect(verdicts.filter(({ verdict }) => verdict.ownWalk).length).toBeGreaterThan(70);
			expect(verdicts.filter(({ verdict }) => verdict.boundFloor).length).toBeGreaterThan(60);
		},
		CLASSIFY_TIMEOUT_MS,
	);

	test('the bracket tracker closes every registered gate at depth 0 — its verdicts rest on real ancestry', () => {
		const rows = liveIndexRows();
		const desynced = rows
			.map((row) => ({
				file: row.file,
				depth: bracketDepthAtEnd(stripComments(readRepo(row.file))),
			}))
			.filter(({ depth }) => depth !== 0)
			.map(({ file, depth }) => `${file} (end depth ${depth})`);
		expect(rows.length).toBeGreaterThan(100);
		expect(
			desynced,
			'gates whose brackets the tracker cannot balance — a literal it does not skip makes every floor verdict after it arbitrary:',
		).toEqual([]);
	});

	test('a row parses with or without its closing pipe, with or without backticks', () => {
		const parsed = parseIndexRows(
			[
				'| Gate | Invariant |',
				'|---|---|',
				'| test/unit/a_tripwire.test.ts | closed row |',
				'| `test/unit/b_tripwire.test.ts` | backticked, TOTAL (see above)',
				'| test/unit/c_tripwire.test.ts | open row (a trailing paren)',
				'| src/not_a_gate.ts | not a gate row |',
			].join('\n'),
		);
		expect(parsed).toEqual([
			{ file: 'test/unit/a_tripwire.test.ts', invariant: ' closed row ' },
			{ file: 'test/unit/b_tripwire.test.ts', invariant: ' backticked, TOTAL (see above)' },
			{ file: 'test/unit/c_tripwire.test.ts', invariant: ' open row (a trailing paren)' },
		]);
	});

	test('only whole-word UPPERCASE TOTAL/TOTALITY claims — prose "total" and "totally" do not', () => {
		expect(claimsTotality('The census is TOTAL over src/')).toBe(true);
		expect(claimsTotality('TOTALITY — every state maps')).toBe(true);
		expect(claimsTotality('a total of 12 keys')).toBe(false);
		expect(claimsTotality('Totally rebuilt')).toBe(false);
		expect(claimsTotality('SUBTOTALS are printed')).toBe(false);
		expect(claimsTotality('TOTALLY')).toBe(false);
	});

	test(
		'no gate walks without a floor bound to its walk, holds a hand corpus, or claims TOTAL over either',
		() => {
			const offenders = liveVerdicts()
				.filter(({ verdict }) => !verdict.ok)
				.map(({ file, verdict }) => `${file} (${describeVerdict(verdict)})`);
			expect(
				offenders,
				`Rows of engineering/TRIPWIRES.md whose gate breaks the census rule. A WALKING gate floors ITS WALK: expect(<a name bound to the walk>.length).toBeGreaterThan(<int>) — a floor on an unrelated value is not one. A gate iterating a hand array of repo paths derives it instead (a registered shared lister, ${DERIVATION_SHAPES} recognised walk shapes). A TOTAL row needs the walk + bound floor, or a closed-set exemption (cap ${CLOSED_SET_EXEMPTION_CAP}, with reason and corpusToken):`,
			).toEqual([]);
		},
		CLASSIFY_TIMEOUT_MS,
	);

	test('the closed-set exemptions are capped, current, and every entry still describes its file', () => {
		expect(ENUMERATED_CLOSED_SET_CENSUSES.length).toBeLessThanOrEqual(CLOSED_SET_EXEMPTION_CAP);
		const claiming = new Set(
			liveIndexRows()
				.filter((row) => claimsTotality(row.invariant))
				.map((row) => row.file),
		);
		const stale: string[] = [];
		for (const entry of ENUMERATED_CLOSED_SET_CENSUSES) {
			expect(
				entry.reason.length,
				`${entry.file}: an exemption carries a real reason`,
			).toBeGreaterThan(80);
			if (!claiming.has(entry.file)) {
				stale.push(`${entry.file}: its index row no longer claims TOTAL — delete the exemption`);
				continue;
			}
			if (!readRepo(entry.file).includes(entry.corpusToken)) {
				stale.push(
					`${entry.file}: corpusToken '${entry.corpusToken}' is gone — the closed set the exemption described no longer exists in that shape`,
				);
			}
		}
		expect(stale, 'stale closed-set exemptions (shrink-only, self-tested):').toEqual([]);
	});

	test('the hand-path lists and the floorless baseline are shrink-only and still true of their files', () => {
		const stale: string[] = [];
		for (const [file, reason] of Object.entries(ENUMERATED_HAND_PATH_LISTS)) {
			expect(reason.length, `${file}: a hand-list entry carries a real reason`).toBeGreaterThan(80);
			const verdict = entryVerdict(file);
			if (verdict === undefined) stale.push(`${file}: not on disk — delete the entry`);
			else if (verdict.shape !== 'hand') {
				stale.push(
					`${file}: no longer the hand-corpus shape (${verdict.shape}) — delete the entry`,
				);
			}
		}
		for (const [file, reason] of Object.entries(FLOORLESS_WALK_BASELINE)) {
			expect(reason.startsWith('DEBT:') || reason.startsWith('NOT-A-CENSUS:'), file).toBe(true);
			expect(reason.length, `${file}: a baseline entry says what is floorless`).toBeGreaterThan(40);
			const verdict = entryVerdict(file);
			if (verdict === undefined) stale.push(`${file}: not on disk — delete the entry`);
			else if (verdict.shape !== 'walk') stale.push(`${file}: no longer walks — delete the entry`);
			else if (verdict.boundFloor) {
				stale.push(`${file}: now floors its walk — delete the entry (the debt is paid)`);
			}
		}
		expect(stale, 'stale enumerated entries (shrink-only, self-tested):').toEqual([]);
		// The debt is real and bounded: the count is the ratchet.
		expect(Object.keys(FLOORLESS_WALK_BASELINE).length).toBeLessThanOrEqual(28);
	});
});

// ---------------------------------------------------------------------------
// The live root evaluation — one evaluator per registered gate, memoized.
// ---------------------------------------------------------------------------

const TRACKED_DIRECTORIES = trackedDirectories();
const isTrackedDirectory = (path: string): boolean => TRACKED_DIRECTORIES.has(path);

interface LiveFeed {
	file: string;
	evaluator: RootEvaluator;
	feed: Feed;
	modules: string[];
}

const liveFeedCache = new Map<string, LiveFeed>();

/** The feed of one gate over its own unit set. */
function liveFeedOf(file: string): LiveFeed {
	let cached = liveFeedCache.get(file);
	if (cached === undefined) {
		const units = unitsOf(file, repoReader);
		const evaluator = new RootEvaluator(units);
		cached = {
			file,
			evaluator,
			feed: feedOf(evaluator, file, isTrackedDirectory),
			modules: units.map((unit) => unit.path).filter((path) => path !== file),
		};
		liveFeedCache.set(file, cached);
	}
	return cached;
}

/**
 * A private-walker entry parsed: its kind, the root GROUPS it writes (one per
 * walk site — `\`src\` \`tools\` ×3; \`test\``: three sites over both trees and one
 * over test/), and the opaque-site count it declares.
 */
function parseWalkerEntry(reason: string): {
	kind: 'ROOTS' | 'NO-ROOT' | undefined;
	groups: string[][];
	opaque: number;
} {
	const kind = /^(ROOTS|NO-ROOT):/.exec(reason)?.[1] as 'ROOTS' | 'NO-ROOT' | undefined;
	// The list ends at the first token that is neither a backticked root, a separator nor a `×N`.
	const list = /^ROOTS:\s*((?:`[^`]+`|×\d+|[\s,;])+)/.exec(reason)?.[1] ?? '';
	const groups: string[][] = [];
	for (const part of list.split(';')) {
		const roots = [...part.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string).sort();
		if (roots.length === 0) continue;
		const times = Number(/×(\d+)/.exec(part)?.[1] ?? '1');
		for (let k = 0; k < times; k++) groups.push(roots);
	}
	const opaque = Number(/\[opaque:\s*(\d+)\]/.exec(reason)?.[1] ?? '0');
	return { kind, groups, opaque };
}

/** Where a registry entry and the groups its lister's walk sites are fed disagree — nothing when they agree. */
function listerProblems(
	path: string,
	lister: SharedLister,
	fedGroups: Iterable<Set<string>>,
): string[] {
	const problems: string[] = [];
	if (lister.scope.length <= 30) problems.push(`${path}: a lister states its scope`);
	const fed = canonicalGroups([...fedGroups].map((group) => [...group]));
	const written = canonicalGroups(lister.roots);
	if (fed !== written) {
		problems.push(
			`${path}: registered [${written}] but its walk sites are fed [${fed}] (one group per site)`,
		);
	}
	if (lister.roots.length === 0 && !/caller|CALLER|NOT a corpus/.test(lister.scope)) {
		problems.push(`${path}: an empty root set must say the caller supplies the root`);
	}
	return problems;
}

/** Where a private-walker entry and the feed of its gate disagree — nothing when they agree. */
function walkerEntryProblems(file: string, reason: string, feed: Feed): string[] {
	const entry = parseWalkerEntry(reason);
	if (entry.kind === undefined) return [`${file}: a reason starts with ROOTS: or NO-ROOT:`];
	const problems: string[] = [];
	if (entry.kind === 'ROOTS' && entry.groups.length === 0)
		problems.push(`${file}: ROOTS: names no root`);
	const written = canonicalGroups(entry.groups);
	const fed = canonicalGroups(feed.groups.values());
	if (written !== fed) {
		problems.push(
			`${file}: written [${written}] but its walk sites are fed [${fed}] — the argument of each derivation call is the root, not the prose (one group per site, \`;\`-separated, \`×N\` for repeats)`,
		);
	}
	if (entry.opaque !== feed.opaqueSites) {
		problems.push(
			`${file}: ${feed.opaqueSites} walk site(s) this rule cannot evaluate (a scratch tree, a runtime value, or a root list NARROWED by a predicate, a conditional or a guarded loop) but the entry declares ${entry.opaque} — write [opaque: ${feed.opaqueSites}] so the blind spot is acknowledged, not silent`,
		);
	}
	return problems;
}

describe('roots are declared — private walkers are a shrinking baseline, shared listers a registry', () => {
	test('the tracked-directory set is real (the git index answers, and the repo has its trees)', () => {
		expect(TRACKED_DIRECTORIES.size).toBeGreaterThan(200);
		for (const dir of [
			'.',
			'src',
			'tools',
			'scripts',
			'test/unit',
			'client/dedalo',
			'.github/workflows',
		]) {
			expect(TRACKED_DIRECTORIES.has(dir), dir).toBe(true);
		}
		expect(TRACKED_DIRECTORIES.has('node_modules')).toBe(false);
	});

	test('every gate that chooses a walk root is in PRIVATE_ROOT_WALKERS, and every entry still does', () => {
		const rows = liveIndexRows();
		const choosing = rows.filter((row) => liveFeedOf(row.file).feed.chooses).map((row) => row.file);
		expect(choosing.length).toBeGreaterThan(90);
		const listed = new Set(Object.keys(PRIVATE_ROOT_WALKERS));
		expect(
			choosing.filter((file) => !listed.has(file)),
			'NEW gates do not choose a walk root in-file — neither by their own readdirSync/Glob/git call nor by the argument they hand a parameterized shared lister: import a registered lister that owns its roots, or write the roots here (the baseline only shrinks):',
		).toEqual([]);
		expect(
			[...listed].filter(
				(file) => !existsSync(join(REPO_ROOT, file)) || !liveFeedOf(file).feed.chooses,
			),
			'baseline entries that are gone or no longer choose a root — delete them (shrink-only):',
		).toEqual([]);
		expect(listed.size).toBeLessThanOrEqual(PRIVATE_ROOT_WALKER_CAP);
	});

	test('every private walker writes its roots, and the written roots ARE the roots its walks are fed', () => {
		const problems: string[] = [];
		let rootsChecked = 0;
		let opaqueTotal = 0;
		for (const [file, reason] of Object.entries(PRIVATE_ROOT_WALKERS)) {
			if (!existsSync(join(REPO_ROOT, file))) continue; // reported by the shrink-only test
			const { feed } = liveFeedOf(file);
			const entry = parseWalkerEntry(reason);
			rootsChecked += entry.groups.reduce((sum, group) => sum + group.length, 0);
			opaqueTotal += feed.opaqueSites;
			problems.push(...walkerEntryProblems(file, reason, feed));
		}
		expect(rootsChecked).toBeGreaterThan(150);
		expect(problems, 'private walkers vs the roots their walks are fed:').toEqual([]);
		// The blind spots are few and each is written down; the count is the ratchet.
		expect(opaqueTotal).toBeLessThanOrEqual(OPAQUE_SITE_CAP);
	});

	/**
	 * The registry's DERIVED membership and root sets: every module under the
	 * registered prefixes that some gate reaches and that walks (a derivation of
	 * its own) or chooses (its literal narrows a walk, its own or a callee's),
	 * with the union of what it is fed across every gate that reaches it.
	 */
	function liveListers(): { reached: Set<string>; groups: Map<string, Map<string, Set<string>>> } {
		const reached = new Set<string>();
		const groups = new Map<string, Map<string, Set<string>>>();
		for (const row of liveIndexRows()) {
			const { evaluator, modules } = liveFeedOf(row.file);
			for (const path of modules) {
				if (!REGISTERED_LISTER_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
				const feed = feedOf(evaluator, path, isTrackedDirectory);
				if (!feed.chooses) continue;
				reached.add(path);
				let sites = groups.get(path);
				if (sites === undefined) {
					sites = new Map();
					groups.set(path, sites);
				}
				// The same site (by identity) fed from several gates: the union of what they hand it.
				for (const [site, roots] of feed.groups) {
					let set = sites.get(site);
					if (set === undefined) {
						set = new Set();
						sites.set(site, set);
					}
					for (const root of roots) set.add(root);
				}
			}
		}
		return { reached, groups };
	}

	test('SHARED_LISTERS covers every module a gate reaches that walks or chooses a root, with the roots it chooses', () => {
		const { reached, groups } = liveListers();
		expect(reached.size).toBeGreaterThan(10);
		const registered = new Set(Object.keys(SHARED_LISTERS));
		expect(
			[...reached].filter((path) => !registered.has(path)),
			'shared modules a gate reaches that walk or choose a root, unnamed by this registry — write their roots down:',
		).toEqual([]);
		expect(
			[...registered].filter((path) => !reached.has(path)),
			'registered listers that are gone, unreached, or no longer walk — delete the entry:',
		).toEqual([]);
		const problems: string[] = [];
		let rootsChecked = 0;
		for (const [path, lister] of Object.entries(SHARED_LISTERS)) {
			rootsChecked += lister.roots.reduce((sum, group) => sum + group.length, 0);
			problems.push(...listerProblems(path, lister, [...(groups.get(path) ?? new Map()).values()]));
		}
		expect(rootsChecked).toBeGreaterThan(15);
		expect(problems, 'registry vs the roots the listers are fed:').toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Controls — the classifier on synthetic inputs, so each leg is falsifiable.
// ---------------------------------------------------------------------------

const CLAIMING_ROW = 'The census is TOTAL over every widget (P2-20)';
const SILENT_ROW = 'Every widget renders its label';
const NO_LISTS: Lists = { handList: false, floorless: false };

const HAND_ARRAY_GATE = `
import { describe, expect, test } from 'bun:test';
const CORPUS = ['src/a.ts', 'src/b.ts', 'tools/c.ts'];
describe('x', () => { test('y', () => { for (const f of CORPUS) expect(f).toBeDefined(); }); });
`;

const WALK_AND_FLOOR_GATE = `
import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
const files = [...new Glob('**/*.ts').scanSync({ cwd: ROOT })];
describe('x', () => { test('y', () => { expect(files.length).toBeGreaterThan(10); }); });
`;

const WALK_NO_FLOOR_GATE = `
import { Glob } from 'bun';
const files = [...new Glob('**/*.ts').scanSync({ cwd: ROOT })];
test('y', () => { for (const f of files) expect(f).toBeDefined(); });
`;

/** The refutation's variant: a walk, and a floor on something ELSE. */
const WALK_UNBOUND_FLOOR_GATE = `
import { Glob } from 'bun';
const files = [...new Glob('**/*.ts').scanSync({ cwd: ROOT })];
const REASONS = { a: 'because' };
test('y', () => { for (const f of files) expect(f).toBeDefined(); expect(Object.keys(REASONS).length).toBeGreaterThan(0); });
`;

/** The walk lives in a helper function; the floor is on what it returns, through a derived name. */
const FUNCTION_WALK_GATE = `
import { readdirSync } from 'node:fs';
function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) out.push(entry);
	return out;
}
function sourceFiles(): { file: string }[] {
	return walk(ROOT).map((file) => ({ file }));
}
const RE = /\\(x\\)/;
test('y', () => { const writers = sourceFiles().filter((s) => RE.test(s.file)); expect(writers.length).toBeGreaterThanOrEqual(3); });
`;

/**
 * A walking function (its default input IS the walk), and a floor on its
 * result over a SYNTHETIC input — a hand-written corpus — plus a pure helper
 * whose parameter shadows a walk-bound name of the same spelling.
 */
const SYNTHETIC_INPUT_GATE = `
import { readdirSync } from 'node:fs';
function corpus(): string[] { return readdirSync(ROOT); }
function reached(files: string[] = corpus()): string[] { return files.filter((f) => f.endsWith('.ts')); }
function trim(text: string): string[] { return text.split('\\n').map((line) => line.trim()); }
const REAL = reached();
test('controls', () => {
	const synthetic: string[] = ['src/a.ts', 'src/b.ts'];
	expect(reached(synthetic).length).toBeGreaterThan(1);
	expect(reached(synthetic)).toEqual(['src/a.ts', 'src/b.ts']);
	const text = corpus().join('\\n');
	expect(trim('a\\n b')).toEqual(['a', 'b']);
});
test('the gate', () => { for (const f of REAL) expect(f).toBeDefined(); });
`;

const FLOOR_NO_WALK_GATE = `
const CORPUS = ['src/a.ts', 'src/b.ts', 'tools/c.ts'];
test('y', () => { expect(CORPUS.length).toBeGreaterThanOrEqual(2); });
`;

const WALK_ONLY_IN_COMMENT_GATE = `
// the corpus comes from new Glob('**/*.ts').scanSync(...) — see the helper
/* readdirSync(dir) would also do */
const CORPUS = ['src/a.ts', 'src/b.ts', 'tools/c.ts'];
test('y', () => { expect(CORPUS.length).toBeGreaterThan(0); });
`;

/** The refutation's evasion: no walk in code, a walk token in a hand-array member. */
const WALK_ONLY_IN_LITERALS_GATE = `
const CORPUS = ['src/a.ts', 'src/b.ts', 'tools/c.ts', 'see readdirSync(dir) in the helper'];
const RE = /new Glob\\(/;
test('y', () => { expect(CORPUS.length).toBeGreaterThan(2); });
`;

/** This gate's own shape: control templates and reason strings that spell walks, deriving nothing. */
const TEMPLATE_QUOTING_A_WALK_GATE = `
const CONTROL = \`const files = [...new Glob('**/*.ts').scanSync({ cwd: ROOT })];\`;
const WHY = { 'test/unit/a.test.ts': 'NO-ROOT: \`git ls-files -s\` on one symlink' };
const SAMPLE = "execSync('git ls-files')";
const FIXTURE = "import census from '../fixtures/external/ontology_census.json';";
test('y', () => { expect(CONTROL.length + SAMPLE.length + FIXTURE.length).toBeGreaterThan(0); });
`;

const HELPER_WALK_GATE = `
import { corpus, CORPUS_FLOOR } from '../helpers/some_census.ts';
test('y', () => { expect(corpus().length).toBeGreaterThan(CORPUS_FLOOR); });
`;
const HELPER_SOURCE = `
import { readdirSync } from 'node:fs';
export const CORPUS_FLOOR = 50;
export function corpus() { return readdirSync('src'); }
`;
const helper = (code: string): ImportedModule => ({ path: 'test/helpers/some_census.ts', code });

describe('controls — the classifier flags the defect shapes and passes the rule shape', () => {
	test('positive control: a hand array of repo paths with no walk is the hand-corpus shape, flagged', () => {
		const verdict = classify(SILENT_ROW, HAND_ARRAY_GATE, [], NO_LISTS);
		expect(verdict).toMatchObject({ claims: false, shape: 'hand', boundFloor: false, ok: false });
		expect(classify(CLAIMING_ROW, HAND_ARRAY_GATE, [], NO_LISTS).ok).toBe(false);
		// A reasoned policy list passes only through the enumerated list — and never under a TOTAL row.
		expect(classify(SILENT_ROW, HAND_ARRAY_GATE, [], { ...NO_LISTS, handList: true }).ok).toBe(
			true,
		);
		expect(classify(CLAIMING_ROW, HAND_ARRAY_GATE, [], { ...NO_LISTS, handList: true }).ok).toBe(
			false,
		);
	});

	test('negative control: walk + floor bound to it honours the rule, TOTAL row or not', () => {
		expect(classify(CLAIMING_ROW, WALK_AND_FLOOR_GATE, [], NO_LISTS)).toMatchObject({
			shape: 'walk',
			ownWalk: true,
			boundFloor: true,
			ok: true,
		});
		expect(classify(SILENT_ROW, WALK_AND_FLOOR_GATE, [], NO_LISTS).ok).toBe(true);
	});

	test('a walk without a floor is flagged whatever the row says (an emptied walk passes vacuously)', () => {
		expect(classify(CLAIMING_ROW, WALK_NO_FLOOR_GATE, [], NO_LISTS)).toMatchObject({
			shape: 'walk',
			boundFloor: false,
			ok: false,
		});
		expect(classify(SILENT_ROW, WALK_NO_FLOOR_GATE, [], NO_LISTS).ok).toBe(false);
		// The baseline carries the debt for a non-claiming row only.
		expect(classify(SILENT_ROW, WALK_NO_FLOOR_GATE, [], { ...NO_LISTS, floorless: true }).ok).toBe(
			true,
		);
		expect(
			classify(CLAIMING_ROW, WALK_NO_FLOOR_GATE, [], { ...NO_LISTS, floorless: true }).ok,
		).toBe(false);
	});

	test('a floor on a value unrelated to the walk is not a floor on the walk', () => {
		const verdict = classify(CLAIMING_ROW, WALK_UNBOUND_FLOOR_GATE, [], NO_LISTS);
		expect(verdict).toMatchObject({ shape: 'walk', boundFloor: false, ok: false });
	});

	test('binding follows declarations: a walk in a helper function reaches the floor on its filtered result', () => {
		expect(classify(CLAIMING_ROW, FUNCTION_WALK_GATE, [], NO_LISTS)).toMatchObject({
			boundFloor: true,
			ok: true,
		});
		// Cut the chain — the floor is on a name no longer derived from the walk.
		const cut = FUNCTION_WALK_GATE.replace('return walk(ROOT).map', 'return OTHER.map');
		expect(classify(CLAIMING_ROW, cut, [], NO_LISTS).boundFloor).toBe(false);
	});

	test('a floor on a bound function applied to a SYNTHETIC input is a control, not a floor on the walk', () => {
		expect(classify(CLAIMING_ROW, SYNTHETIC_INPUT_GATE, [], NO_LISTS)).toMatchObject({
			shape: 'walk',
			boundFloor: false,
			ok: false,
		});
		// The same floor on the real result is bound.
		const real = SYNTHETIC_INPUT_GATE.replace(
			'for (const f of REAL) expect(f).toBeDefined();',
			'expect(REAL.length).toBeGreaterThan(1);',
		);
		expect(classify(CLAIMING_ROW, real, [], NO_LISTS).boundFloor).toBe(true);
		// And so is a call whose argument is itself bound to the walk.
		const derived = SYNTHETIC_INPUT_GATE.replace(
			'for (const f of REAL) expect(f).toBeDefined();',
			'const again = reached(corpus()); expect(again.length).toBeGreaterThan(1);',
		);
		expect(classify(CLAIMING_ROW, derived, [], NO_LISTS).boundFloor).toBe(true);
		// A parameter shadows: `text` inside trim() is not the walk-bound `text` of the test.
		const shadowed = SYNTHETIC_INPUT_GATE.replace(
			"expect(trim('a\\n b')).toEqual(['a', 'b']);",
			"expect(trim('a\\n b').length).toBeGreaterThan(1);",
		);
		expect(classify(CLAIMING_ROW, shadowed, [], NO_LISTS).boundFloor).toBe(false);
		// Scope by position: a `names` filled from the walk does not bind a later `names` filled from a string.
		const twoNames = `
import { readdirSync } from 'node:fs';
function walked(): Set<string> { const names = new Set<string>(); for (const f of readdirSync(ROOT)) names.add(f); return names; }
function parsed(text: string): Set<string> { const names = new Set<string>(); for (const m of text.matchAll(/x/g)) names.add(m[0]); return names; }
test('y', () => { expect(parsed('xx').size).toBeGreaterThan(1); });
`;
		expect(classify(CLAIMING_ROW, twoNames, [], NO_LISTS).boundFloor).toBe(false);
		expect(
			classify(CLAIMING_ROW, twoNames.replace("parsed('xx').size", 'walked().size'), [], NO_LISTS)
				.boundFloor,
		).toBe(true);
	});

	test('identifiers are whole words and bindings are declarations — no prefix match, no undeclared seed', () => {
		// `scripts:` (an object key) must not read as the bound `script` declared above it.
		const prefixed = `
import { readdirSync } from 'node:fs';
function corpus(): string[] { return readdirSync(ROOT); }
function reachedScripts(c = { scripts: corpus() }): string[] { return c.scripts; }
test('y', () => {
	const script = corpus()[0];
	const synthetic = { scripts: ['src/a.ts'] };
	expect(reachedScripts(synthetic).length).toBeGreaterThan(0);
	expect(script).toBeDefined();
});
`;
		expect(classify(CLAIMING_ROW, prefixed, [], NO_LISTS).boundFloor).toBe(false);
		// A name a walking loop mutates but nothing declares (a global, a property) binds nothing.
		const undeclared = `
import { readdirSync } from 'node:fs';
for (const f of readdirSync(ROOT)) globalAcc.push(f);
test('y', () => { expect(globalAcc.length).toBeGreaterThan(0); });
`;
		expect(classify(CLAIMING_ROW, undeclared, [], NO_LISTS).boundFloor).toBe(false);
		expect(
			classify(CLAIMING_ROW, `const globalAcc: string[] = [];${undeclared}`, [], NO_LISTS)
				.boundFloor,
		).toBe(true);
	});

	test('a floor without a walk is the hand-corpus shape (a floored hand array is still a hand array)', () => {
		const verdict = classify(CLAIMING_ROW, FLOOR_NO_WALK_GATE, [], NO_LISTS);
		expect(verdict).toMatchObject({ shape: 'hand', boundFloor: false, ok: false });
	});

	test('a walk that exists only in comments is not a walk', () => {
		expect(classify(CLAIMING_ROW, WALK_ONLY_IN_COMMENT_GATE, [], NO_LISTS).shape).toBe('hand');
	});

	test('a walk that exists only inside a string, template or regex literal is not a walk', () => {
		// The refutation's evasion: a hand array whose member SAYS readdirSync.
		expect(classify(CLAIMING_ROW, WALK_ONLY_IN_LITERALS_GATE, [], NO_LISTS)).toMatchObject({
			shape: 'hand',
			ownWalk: false,
			boundFloor: false,
			ok: false,
		});
		// And the self-flag: a gate holding control templates that spell a walk derives nothing.
		expect(classify(SILENT_ROW, TEMPLATE_QUOTING_A_WALK_GATE, [], NO_LISTS)).toMatchObject({
			shape: 'none',
			ownWalk: false,
			ok: true,
		});
		expect(hasDerivation(WALK_ONLY_IN_LITERALS_GATE)).toBe(false);
		expect(hasDerivation(TEMPLATE_QUOTING_A_WALK_GATE)).toBe(false);
	});

	test('literal blanking keeps delimiters and code, drops content, and reads a regex after `=>`', () => {
		const { blanked, literals } = blankLiterals(
			"const a = readdirSync('src');\nconst b = lines.some((l) => /\\(cd/.test(l));\nconst c = `x ${y}`;",
		);
		expect(blanked).toBe(
			"const a = readdirSync('   ');\nconst b = lines.some((l) => /    /.test(l));\nconst c = `      `;",
		);
		expect(literals.map((literal) => literal.content)).toEqual(['src', '\\(cd', 'x ${y}']);
		expect(literals[0]?.preceding.endsWith('readdirSync(')).toBe(true);
		// The tracker closes at depth 0 through an arrow-headed regex holding a paren.
		expect(bracketDepthAtEnd('lines.some((l) => /\\(cd/.test(l));\nexpect(1)')).toBe(0);
		expect(expectSites('lines.some((l) => /\\(cd/.test(l));\nexpect(1)')[0]?.ancestors).toEqual([]);
		// A division is not a regex: the tracker does not swallow code after `a / b`.
		expect(bracketDepthAtEnd('const r = (a / b) + (c / d);\nexpect(r)')).toBe(0);
		// And the depth is measured, not assumed: an unbalanced file is reported either way.
		expect(bracketDepthAtEnd('test(() => { expect(1);')).toBe(2);
		expect(bracketDepthAtEnd('});')).toBe(-2);
		// Without the arrow rule the paren inside the regex would be read as code.
		expect(bracketDepthAtEnd('const a = 1 / 2 / 3;')).toBe(0);
	});

	test('a walk in an imported shared module counts, seeds its exports, and may name the floor constant', () => {
		const verdict = classify(CLAIMING_ROW, HELPER_WALK_GATE, [helper(HELPER_SOURCE)], NO_LISTS);
		expect(verdict).toMatchObject({ shape: 'walk', ownWalk: false, boundFloor: true, ok: true });
		// Without the module the gate derives nothing.
		expect(classify(CLAIMING_ROW, HELPER_WALK_GATE, [], NO_LISTS).shape).toBe('none');
		// A floor constant the module does not define is a variable, not a floor.
		const noConstant = HELPER_SOURCE.replace('export const CORPUS_FLOOR = 50;', '');
		expect(
			classify(CLAIMING_ROW, HELPER_WALK_GATE, [helper(noConstant)], NO_LISTS).boundFloor,
		).toBe(false);
		// A floor inside the helper does not floor the gate.
		const floorOnlyInHelper = HELPER_WALK_GATE.replace(
			'.toBeGreaterThan(CORPUS_FLOOR)',
			'.toBeDefined()',
		);
		const helperWithFloor = `${HELPER_SOURCE}\nexpect(corpus().length).toBeGreaterThan(1);`;
		expect(
			classify(CLAIMING_ROW, floorOnlyInHelper, [helper(helperWithFloor)], NO_LISTS).boundFloor,
		).toBe(false);
	});

	test('a floor counts only where it executes: not in a skipped test, not behind a guard, not in a loop over the walk', () => {
		const floored = (code: string): boolean =>
			classify(CLAIMING_ROW, code, [], NO_LISTS).boundFloor;
		expect(floored(WALK_AND_FLOOR_GATE)).toBe(true);
		// The reviewer's two neuterings: park the floor in a skipped test…
		expect(floored(WALK_AND_FLOOR_GATE.replace("test('y'", "test.skip('y'"))).toBe(false);
		expect(floored(WALK_AND_FLOOR_GATE.replace("describe('x'", "describe.skip('x'"))).toBe(false);
		expect(floored(WALK_AND_FLOOR_GATE.replace("test('y'", "test.todo('y'"))).toBe(false);
		expect(floored(WALK_AND_FLOOR_GATE.replace("test('y'", "xit('y'"))).toBe(false);
		expect(floored(WALK_AND_FLOOR_GATE.replace("test('y'", "test.skipIf(true)('y'"))).toBe(false);
		expect(floored(WALK_AND_FLOOR_GATE.replace("describe('x'", "describe.if(false)('x'"))).toBe(
			false,
		);
		// …or guard it with the emptiness it detects.
		expect(
			floored(
				WALK_AND_FLOOR_GATE.replace(
					'expect(files.length).toBeGreaterThan(10);',
					'if (files.length > 0) expect(files.length).toBeGreaterThan(10);',
				),
			),
		).toBe(false);
		expect(
			floored(
				WALK_AND_FLOOR_GATE.replace(
					'expect(files.length).toBeGreaterThan(10);',
					'if (files.length > 0) { expect(files.length).toBeGreaterThan(10); }',
				),
			),
		).toBe(false);
		expect(
			floored(
				WALK_AND_FLOOR_GATE.replace(
					'expect(files.length).toBeGreaterThan(10);',
					'files.length > 0 && expect(files.length).toBeGreaterThan(10);',
				),
			),
		).toBe(false);
		// A floor per element is no floor on the element count.
		expect(
			floored(
				WALK_AND_FLOOR_GATE.replace(
					'expect(files.length).toBeGreaterThan(10);',
					'for (const f of files) expect(f.length).toBeGreaterThan(0);',
				),
			),
		).toBe(false);
		expect(
			floored(
				WALK_AND_FLOOR_GATE.replace(
					'expect(files.length).toBeGreaterThan(10);',
					'files.forEach((f) => { expect(f.length).toBeGreaterThan(0); });',
				),
			),
		).toBe(false);
		// A helper that may never be called is not the test body.
		expect(
			floored(
				WALK_AND_FLOOR_GATE.replace(
					"test('y', () => { expect(files.length).toBeGreaterThan(10); });",
					"function check() { expect(files.length).toBeGreaterThan(10); }\ntest('y', () => { check(); });",
				),
			),
		).toBe(false);
		// A floor spelled inside a string literal is text, not a floor.
		expect(
			floored(
				WALK_AND_FLOOR_GATE.replace(
					'expect(files.length).toBeGreaterThan(10);',
					"const note = 'expect(files.length).toBeGreaterThan(10)'; expect(note).toBeDefined();",
				),
			),
		).toBe(false);
		// The previous test closed without a semicolon: the callee is still read off the header's tail.
		expect(
			floored(
				WALK_AND_FLOOR_GATE.replace(
					"test('y', () => { expect(files.length).toBeGreaterThan(10); });",
					"test('w', () => {})\ntest('y', () => { expect(files.length).toBeGreaterThan(10); });",
				),
			),
		).toBe(true);
		// Still a floor: a tier-conditioned live test, a plain or try block, a describe body.
		expect(floored(WALK_AND_FLOOR_GATE.replace("describe('x'", "describe.if(hasDb)('x'"))).toBe(
			true,
		);
		expect(floored(WALK_AND_FLOOR_GATE.replace("test('y'", "test.skipIf(!hasDb)('y'"))).toBe(true);
		expect(
			floored(
				WALK_AND_FLOOR_GATE.replace(
					'expect(files.length).toBeGreaterThan(10);',
					'{ expect(files.length).toBeGreaterThan(10); }',
				),
			),
		).toBe(true);
		expect(
			floored(
				WALK_AND_FLOOR_GATE.replace(
					'expect(files.length).toBeGreaterThan(10);',
					'try { expect(files.length).toBeGreaterThan(10); } finally { cleanup(); }',
				),
			),
		).toBe(true);
		expect(
			floored(
				WALK_AND_FLOOR_GATE.replace(
					"test('y', () => { expect(files.length).toBeGreaterThan(10); });",
					'expect(files.length).toBeGreaterThan(10);',
				),
			),
		).toBe(true);
	});

	test('a closed-set exemption applies to a TOTAL row only while its token is present', () => {
		const closedSet: ClosedSetExemption = {
			file: 'x',
			corpusToken: 'CORPUS',
			reason: 'closed set',
		};
		expect(classify(CLAIMING_ROW, HAND_ARRAY_GATE, [], { ...NO_LISTS, closedSet }).ok).toBe(true);
		const renamed = HAND_ARRAY_GATE.replaceAll('CORPUS', 'LIST');
		expect(classify(CLAIMING_ROW, renamed, [], { ...NO_LISTS, closedSet }).ok).toBe(false);
	});

	test('every derivation token recognises its shape; the floor grammar reads literals and constants', () => {
		const samples = [
			"readdirSync('src')",
			"await readdir('src')",
			"new Glob('**/*.ts')",
			'Bun.Glob',
			'glob.scanSync({ cwd })',
			'glob.scan(root)',
			"Bun.spawnSync(['git', '-C', ROOT, 'ls-files', '-s'])",
			"execFileSync('git', ['ls-files', '--', '*.js'])",
			"execSync('git ls-files -z')",
			"import census from '../fixtures/external/ontology_census.json';",
		];
		for (const sample of samples) expect(hasDerivation(sample), sample).toBe(true);
		expect(hasDerivation("const x = ['a', 'b']")).toBe(false);
		// The string-borne shapes are judged on the literal ITSELF, not on text quoting it.
		expect(hasDerivation('const note = "execSync(\'git ls-files\')";')).toBe(false);
		expect(hasDerivation("const why = 'NO-ROOT: `git ls-files -s` on two symlinks';")).toBe(false);
		expect(hasDerivation("const path = '../fixtures/external/ontology_census.json';")).toBe(false);
		expect(hasDerivation('const note = "import c from \'../fixtures/x.json\'";')).toBe(false);
		const floors = (code: string): string[] => floorSites(code).map((site) => site.floor);
		expect(floors('expect(n).toBeGreaterThan(0)')).toEqual(['0']);
		expect(floors('expect(n).toBeGreaterThanOrEqual(12)')).toEqual(['12']);
		expect(floors('expect(n).toBeGreaterThan(SOME_FLOOR)')).toEqual(['SOME_FLOOR']);
		expect(floors('expect(n).toBeGreaterThan(floor)')).toEqual([]); // a lowercase variable is not a stated floor
		expect(floors('expect(n).toBeGreaterThan(-1)')).toEqual([]); // an index check is not a floor
		expect(floors("expect(readers).toEqual(['src/core/concepts/rqo.ts'])")).toEqual(['EXACT_SET']);
		expect(floors('expect(readers).toEqual([])')).toEqual([]); // an empty expected set floors nothing
		expect(floors('expect(readers).toEqual(Object.keys(PRODUCERS))')).toEqual([]); // nor a computed one
		// Each site is delimited by its own parens — an earlier expect() cannot lend its argument.
		expect(
			floorSites(
				"expect(files).toBeDefined(); expect(other.length, 'a (msg').toBeGreaterThan(2);",
			).map((site) => site.argument),
		).toEqual(["other.length, 'a (msg'"]);
		// The isolated gate's `else {` body is the file's top level (its child runs it);
		// any OTHER else-branch is still a branch.
		const unconditional = (code: string): boolean[] =>
			floorSites(code).map((site) => site.unconditional);
		expect(
			unconditional(
				"if (!isIsolatedGateChild(import.meta.path)) mirrorIsolatedGate(import.meta.path);\nelse {\n\ttest('t', () => { expect(n).toBeGreaterThan(0); });\n}",
			),
		).toEqual([true]);
		expect(
			unconditional(
				"if (ready) setup();\nelse {\n\ttest('t', () => { expect(n).toBeGreaterThan(0); });\n}",
			),
		).toEqual([false]);
		expect(numericConstantValue('SOME_FLOOR', ['const SOME_FLOOR = 700;'])).toBe(700);
		expect(numericConstantValue('SOME_FLOOR', ['const SOME_FLOOR = other;'])).toBeUndefined();
		// A floor REJECTS AN EMPTY WALK: `>= 0` (literal or through a zero constant) admits one.
		const rejects = (code: string, sources: string[] = []): boolean[] =>
			floorSites(code).map((site) => rejectsEmptyWalk(site, sources));
		expect(rejects('expect(n).toBeGreaterThan(0)')).toEqual([true]);
		expect(rejects('expect(n).toBeGreaterThanOrEqual(1)')).toEqual([true]);
		expect(rejects('expect(n).toBeGreaterThanOrEqual(0)')).toEqual([false]);
		expect(rejects('expect(n).toBeGreaterThan(FLOOR)', ['const FLOOR = 0;'])).toEqual([true]);
		expect(rejects('expect(n).toBeGreaterThanOrEqual(FLOOR)', ['const FLOOR = 0;'])).toEqual([
			false,
		]);
		expect(rejects('expect(n).toBeGreaterThanOrEqual(FLOOR)', ['const FLOOR = 1;'])).toEqual([
			true,
		]);
		expect(rejects('expect(n).toBeGreaterThanOrEqual(FLOOR)', ['const FLOOR = x;'])).toEqual([
			false,
		]);
		expect(rejects("expect(r).toEqual(['src/a.ts'])")).toEqual([true]);
	});

	test('statement extents skip strings and regex literals so their brackets do not count', () => {
		const code = "const RE = /\\(x\\)/;\nconst s = ')';\nconst files = readdirSync('src');\n";
		const decls = declarations(code);
		expect(decls.map((decl) => decl.name)).toEqual(['RE', 's', 'files']);
		expect(bindWalk(code, []).boundNames()).toEqual(['files']);
	});
});

// ---------------------------------------------------------------------------
// Controls — the root evaluator reads what each walk is FED, never what the
// file spells; each defect the audit found is re-planted here and must read
// as the narrowed root it is.
// ---------------------------------------------------------------------------

const GATE = 'test/unit/x_tripwire.test.ts';
const HELPER = 'test/helpers/x_census.ts';
const SYNTHETIC_DIRECTORIES = new Set([
	'.',
	'src',
	'src/core',
	'src/external',
	'tools',
	'client',
	'client/dedalo',
	'test',
	'test/unit',
	'test/parity',
	'scripts',
	'deploy',
]);
const isSyntheticDirectory = (path: string): boolean => SYNTHETIC_DIRECTORIES.has(path);

/** The feed of `file` over a synthetic tree of sources. */
function feedOver(
	sources: Record<string, string>,
	file = GATE,
): { feed: Feed; evaluator: RootEvaluator } {
	const evaluator = new RootEvaluator(unitsOf(file, (path) => sources[path]));
	return { feed: feedOf(evaluator, file, isSyntheticDirectory), evaluator };
}

const PRELUDE = `
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Glob } from 'bun';
const REPO_ROOT = join(import.meta.dir, '..', '..');
const SRC_DIR = join(import.meta.dir, '..', '..', 'src');
`;

describe('controls — the root evaluator: written roots are checked against the ARGUMENT of the walk', () => {
	test('GATE-35: a walk rooted at import.meta.dir is fed test/unit; joined with ".." it is fed test — the prose "under test/" is not evidence', () => {
		const ownDir = `${PRELUDE}
const files = [...new Glob('**/*.test.ts').scanSync({ cwd: import.meta.dir })];
test('y', () => { expect(files.length).toBeGreaterThan(10); });`;
		expect(feedOver({ [GATE]: ownDir }).feed).toMatchObject({
			roots: ['test/unit'],
			chooses: true,
			opaqueSites: 0,
		});
		const parent = ownDir.replace('cwd: import.meta.dir', "cwd: join(import.meta.dir, '..')");
		expect(feedOver({ [GATE]: parent }).feed.roots).toEqual(['test']);
		// The written entry must EQUAL the fed set: "test" written over a test/unit walk is drift.
		expect(
			parseWalkerEntry('ROOTS: `test` (every *.test.ts under test/, join(import.meta.dir, ".."))')
				.groups,
		).toEqual([['test']]);
		expect(feedOver({ [GATE]: ownDir }).feed.roots).not.toEqual(['test']);
	});

	test('GATE-34: dropping tools/ from a tuple root list is read as [src] though an allowlist still spells "core/tools/loader.ts"', () => {
		const both = `${PRELUDE}
const ALLOWED = new Set(['core/tools/loader.ts:cache', 'core/db/pool.ts:pool']);
function scanSrc(): number {
	const glob = new Glob('**/*.ts');
	let n = 0;
	const roots: [string, string][] = [
		[SRC_DIR, ''],
		[join(SRC_DIR, '..', 'tools'), 'tools/'],
	];
	for (const [root, prefix] of roots)
		for (const rel of glob.scanSync(root)) { if (ALLOWED.has(\`\${prefix}\${rel}\`)) n++; }
	return n;
}
test('y', () => { expect(scanSrc()).toBeGreaterThan(1); });`;
		expect(feedOver({ [GATE]: both }).feed.roots).toEqual(['src', 'tools']);
		const narrowed = both.replace("\n\t\t[join(SRC_DIR, '..', 'tools'), 'tools/'],", '');
		expect(narrowed).not.toBe(both);
		expect(feedOver({ [GATE]: narrowed }).feed.roots).toEqual(['src']);
		// PER SITE: a second walk over both trees does not cover for the narrowed one —
		// the union would still read [src, tools]; the groups read the narrowing.
		const second = `
function scanBoth(): number {
	let n = 0;
	for (const root of [SRC_DIR, join(SRC_DIR, '..', 'tools')]) n += [...new Glob('**/*.ts').scanSync(root)].length;
	return n;
}`;
		const twoSites = feedOver({ [GATE]: `${narrowed}${second}` }).feed;
		expect(twoSites.roots).toEqual(['src', 'tools']);
		expect(canonicalGroups(twoSites.groups.values())).toBe('src; src tools');
		expect(canonicalGroups(feedOver({ [GATE]: `${both}${second}` }).feed.groups.values())).toBe(
			'src tools; src tools',
		);
		expect(canonicalGroups(parseWalkerEntry('ROOTS: `src` `tools` ×2').groups)).toBe(
			'src tools; src tools',
		);
	});

	test('GATE-34 by CONTROL FLOW: a guard that skips a root before the walk, a sift of the results by their root, a predicate over the root list — each an OPAQUE site, never the over-approximated feed', () => {
		const both = `${PRELUDE}
function scanSrc(): number {
	const glob = new Glob('**/*.ts');
	let n = 0;
	const roots: [string, string][] = [
		[SRC_DIR, ''],
		[join(SRC_DIR, '..', 'tools'), 'tools/'],
	];
	for (const [root, prefix] of roots) {
		for (const rel of glob.scanSync(root)) {
			if (\`\${prefix}\${rel}\` === 'src/core/db/postgres.ts') continue; // a per-file exclusion sifts nothing by root
			n++;
		}
	}
	return n;
}
test('y', () => { expect(scanSrc()).toBeGreaterThan(1); });`;
		expect(feedOver({ [GATE]: both }).feed).toMatchObject({
			roots: ['src', 'tools'],
			ownSites: 1,
			opaqueSites: 0,
		});
		const opaque = (gate: string): void => {
			expect(gate).not.toBe(both);
			expect(feedOver({ [GATE]: gate }).feed).toMatchObject({
				roots: [],
				ownSites: 1,
				opaqueSites: 1,
			});
		};
		// V1: the tools iteration leaves before the walk — the site is fed src only, and the evaluator says it cannot tell.
		opaque(
			both.replace(
				'for (const [root, prefix] of roots) {',
				"for (const [root, prefix] of roots) {\n\t\tif (prefix === 'tools/') continue;",
			),
		);
		// V4: the walk runs over tools/, every tools file is discarded by its root.
		opaque(
			both.replace(
				'for (const rel of glob.scanSync(root)) {',
				'for (const rel of glob.scanSync(root)) {\n\t\t\tif (prefix) continue;',
			),
		);
		// An `if` on the root that encloses the walk, and a `break`/`return` before it.
		opaque(
			both.replace(
				'for (const [root, prefix] of roots) {',
				"for (const [root, prefix] of roots) {\n\t\tif (prefix !== '') break;",
			),
		);
		opaque(
			both.replace(
				'for (const rel of glob.scanSync(root)) {',
				"if (prefix === '') for (const rel of glob.scanSync(root)) {",
			),
		);
		// A guard through a boolean computed a statement earlier: before the walk, any early exit is one.
		opaque(
			both.replace(
				'for (const [root, prefix] of roots) {',
				"for (const [root, prefix] of roots) {\n\t\tconst skip = prefix === 'tools/';\n\t\tif (skip) continue;",
			),
		);
		// V5: a predicate over the root list; `.find`, `.slice(1)` likewise — `.sort()`/`.slice()` narrow nothing.
		opaque(both.replace('of roots)', "of roots.filter(([, prefix]) => prefix === ''))"));
		opaque(both.replace('of roots)', "of [roots.find(([, prefix]) => prefix === '')!])"));
		opaque(both.replace('of roots)', 'of roots.slice(1))'));
		for (const kept of ['of roots.sort())', 'of roots.slice())', 'of roots.toReversed())']) {
			expect(feedOver({ [GATE]: both.replace('of roots)', kept) }).feed).toMatchObject({
				roots: ['src', 'tools'],
				opaqueSites: 0,
			});
		}
		// A conditional picking the root list: unreadable, the site opaque.
		opaque(both.replace('of roots)', 'of (process.env.FAST ? roots.slice(0, 1) : roots))'));
		opaque(
			both.replace(
				'const roots: [string, string][] = [',
				"const roots: [string, string][] = 1 > 0 ? [[SRC_DIR, '']] : [",
			),
		);
		// The recursive walker's sift of LISTING RESULTS (`continue` on node_modules, then
		// `walk(child)`) narrows names under the root, not the root: not opaque.
		const recursive = `${PRELUDE}
function collect(): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			if (name === 'node_modules' || name.startsWith('.')) continue;
			const child = join(dir, name);
			if (name.endsWith('.ts')) found.push(child);
			else walk(child);
		}
	};
	walk(join(REPO_ROOT, 'src'));
	return found;
}
test('y', () => { expect(collect().length).toBeGreaterThan(1); });`;
		expect(feedOver({ [GATE]: recursive }).feed).toMatchObject({
			roots: ['src'],
			ownSites: 1,
			opaqueSites: 0,
		});
		// Two sites: a narrowed one cannot hide behind a whole one — the groups read one site, the count reads the other.
		const second = `
function scanBoth(): number {
	let n = 0;
	for (const root of [SRC_DIR, join(SRC_DIR, '..', 'tools')]) n += [...new Glob('**/*.ts').scanSync(root)].length;
	return n;
}`;
		const twoSites = feedOver({
			[GATE]: `${both.replace('of roots)', 'of roots.slice(1))')}${second}`,
		}).feed;
		expect(canonicalGroups(twoSites.groups.values())).toBe('src tools');
		expect(twoSites.opaqueSites).toBe(1);
		expect(walkerEntryProblems(GATE, 'ROOTS: `src` `tools` ×2.', twoSites).length).toBeGreaterThan(
			0,
		);
		expect(walkerEntryProblems(GATE, 'ROOTS: `src` `tools` [opaque: 1].', twoSites)).toEqual([]);
	});

	test('a declaration spelled inside a string is text: it neither shadows the real one nor becomes a phantom function', () => {
		const gate = `${PRELUDE}
const walk = (dir: string): string[] => readdirSync(dir);
test('y', () => {
	expect(readFileSync('x.ts', 'utf8')).toContain('async function walk(');
	expect([...walk(join(REPO_ROOT, 'src'))].length).toBeGreaterThan(1);
});`;
		// (a spread call `...walk(` is a call site too)
		expect(feedOver({ [GATE]: gate }).feed).toMatchObject({ roots: ['src'], opaqueSites: 0 });
		expect(declarations(stripComments(gate)).filter((decl) => decl.name === 'walk')).toHaveLength(
			1,
		);
	});

	test('a fed path that is not a tracked repo directory is no root: node_modules, a file, an absolute or outside path', () => {
		const gate = `${PRELUDE}
const a = readdirSync(join(REPO_ROOT, 'node_modules'));
const b = readdirSync(join(REPO_ROOT, 'src', 'index.ts'));
const c = readdirSync('/tmp');
const d = readdirSync(join(REPO_ROOT, '..', 'private'));
const e = readdirSync(join(REPO_ROOT, 'src'));
test('y', () => { expect(a.length + b.length + c.length + d.length + e.length).toBeGreaterThan(0); });`;
		expect(feedOver({ [GATE]: gate }).feed).toMatchObject({
			roots: ['src'],
			ownSites: 5,
			opaqueSites: 0,
		});
	});

	test('GATE-31: dropping the tools glob pair is read as [client/dedalo] though a fixture path still spells "tools/…"', () => {
		const both = `${PRELUDE}
const FIXTURE = 'tools/tool_diffusion/js/report_model.js';
function clientJsFiles(): string[] {
	const files: string[] = [];
	const roots: Array<[string, string]> = [
		['client/dedalo', '**/*.js'],
		['tools', '*/js/**/*.js'],
	];
	for (const [root, glob] of roots) {
		for (const match of new Glob(glob).scanSync({ cwd: join(REPO_ROOT, root), dot: true })) files.push(\`\${root}/\${match}\`);
	}
	return files;
}
test('y', () => { expect(clientJsFiles()).toContain(FIXTURE); expect(clientJsFiles().length).toBeGreaterThan(10); });`;
		expect(feedOver({ [GATE]: both }).feed.roots).toEqual(['client/dedalo', 'tools']);
		const narrowed = both.replace("\n\t\t['tools', '*/js/**/*.js'],", '');
		expect(narrowed).not.toBe(both);
		expect(feedOver({ [GATE]: narrowed }).feed.roots).toEqual(['client/dedalo']);
	});

	test('a gate that hands a root to a PARAMETERIZED shared lister chooses that root — it is a private walker with no derivation token of its own', () => {
		const lister = `
import { readdirSync } from 'node:fs';
export function scanForWrites(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => { for (const entry of readdirSync(dir)) { out.push(join(dir, entry)); walk(join(dir, entry)); } };
	walk(root);
	return out;
}`;
		const gate = `${PRELUDE}
import { scanForWrites } from '../helpers/x_census.ts';
test('y', () => { expect(scanForWrites(join(REPO_ROOT, 'src/core')).length).toBeGreaterThan(10); });`;
		const { feed, evaluator } = feedOver({ [GATE]: gate, [HELPER]: lister });
		expect(feed).toMatchObject({ roots: ['src/core'], chooses: true, ownSites: 0, opaqueSites: 0 });
		expect(hasDerivation(stripComments(gate))).toBe(false);
		// The lister, in its OWN closure, is fed nothing: its parameter is open.
		const own = feedOver({ [HELPER]: lister }, HELPER);
		expect(own.feed).toMatchObject({ roots: [], chooses: true, ownSites: 1, opaqueSites: 1 });
		expect([...own.evaluator.openParameters]).toEqual([`${HELPER}:scanForWrites`]);
		// Through a gate-side wrapper the choice is still the gate's.
		const wrapped = gate.replace(
			"test('y', () => { expect(scanForWrites(join(REPO_ROOT, 'src/core')).length)",
			"function mine(rel: string): string[] { return scanForWrites(join(REPO_ROOT, rel)); }\ntest('y', () => { expect(mine('src/core').length)",
		);
		expect(feedOver({ [GATE]: wrapped, [HELPER]: lister }).feed.roots).toEqual(['src/core']);
		expect(evaluator.callingUnits.has(GATE)).toBe(true);
	});

	test('a lister with its own root list owns its roots; the gate that imports it chooses nothing, and the repo root it passes narrows nothing', () => {
		const lister = `
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
export const REPO_ROOT = join(import.meta.dir, '..', '..');
export const ROOTS = ['src', 'tools'] as const;
export function corpus(repoRoot = REPO_ROOT): string[] {
	return ROOTS.flatMap((dir) => readdirSync(join(repoRoot, dir)));
}
export function suiteFiles(repoRoot: string): string[] {
	return readdirSync(join(repoRoot, 'test'));
}`;
		const gate = `${PRELUDE}
import { corpus, suiteFiles } from '../helpers/x_census.ts';
test('y', () => { expect(corpus().length).toBeGreaterThan(10); expect(suiteFiles(REPO_ROOT).length).toBeGreaterThan(5); });`;
		const { feed, evaluator } = feedOver({ [GATE]: gate, [HELPER]: lister });
		expect(feed).toMatchObject({ roots: [], chooses: false, ownSites: 0 });
		expect(feedOf(evaluator, HELPER, isSyntheticDirectory)).toMatchObject({
			roots: ['src', 'test', 'tools'],
			chooses: true,
			ownSites: 2,
		});
		// A scratch base handed in resolves to no repo directory — and is not the gate's root either.
		const scratch = gate.replace('suiteFiles(REPO_ROOT)', "suiteFiles(mkdtempSync('x'))");
		expect(feedOver({ [GATE]: scratch, [HELPER]: lister }).feed.roots).toEqual([]);
		// The registry entry is held to the SAME per-site groups.
		const fedGroups = [...feedOf(evaluator, HELPER, isSyntheticDirectory).groups.values()].map(
			(group) => new Set(group),
		);
		const scope = 'the two engine trees and the suite, for a control that says enough';
		expect(
			listerProblems(HELPER, { roots: [['src', 'tools'], ['test']], scope }, fedGroups),
		).toEqual([]);
		expect(
			listerProblems(HELPER, { roots: [['src', 'tools', 'test']], scope }, fedGroups),
		).toHaveLength(1);
		expect(listerProblems(HELPER, { roots: [['src'], ['test']], scope }, fedGroups)).toHaveLength(
			1,
		);
		expect(listerProblems(HELPER, { roots: [], scope }, [])).toHaveLength(1);
		expect(
			listerProblems(HELPER, { roots: [], scope: `${scope} — the CALLER names it` }, []),
		).toEqual([]);
		expect(
			listerProblems(HELPER, { roots: [['src', 'tools'], ['test']], scope: 'short' }, fedGroups),
		).toHaveLength(1);
	});

	test('the git index is a walk too: pathspecs, `-C`, `cwd:` and a mapped root list are read; no pathspec means the whole index', () => {
		const gate = `${PRELUDE}
import { execFileSync, execSync } from 'node:child_process';
const CLIENT_JS_ROOTS = ['client', 'tools'];
const a = execFileSync('git', ['ls-files', '--', ...CLIENT_JS_ROOTS.map((r) => \`\${r}/**/*.js\`)], { cwd: REPO_ROOT });
const b = Bun.spawnSync(['git', '-C', REPO_ROOT, 'ls-files', '-s']);
const c = execSync('git ls-files -z -- src deploy', { cwd: REPO_ROOT });
const d = Bun.spawnSync(['git', '-C', join(REPO_ROOT, 'client'), 'ls-files', '--', 'dedalo']);
test('y', () => { expect(a.length + b.stdout.length + c.length + d.stdout.length).toBeGreaterThan(10); });`;
		expect(feedOver({ [GATE]: gate }).feed.roots).toEqual([
			'.',
			'client',
			'client/dedalo',
			'deploy',
			'src',
			'tools',
		]);
		expect(feedOver({ [GATE]: gate.replace('-- src deploy', '-- src') }).feed.roots).toEqual([
			'.',
			'client',
			'client/dedalo',
			'src',
			'tools',
		]);
	});

	test('destructuring, callbacks and properties resolve: `{ root, glob: pattern }`, `[root, prefix]`, `.map((r) => …)`, `spec.paths`', () => {
		const gate = `${PRELUDE}
const SCAN_ROOTS = [
	{ root: 'test', glob: '**/*.test.ts' },
	{ root: 'client/dedalo', glob: '**/*.js' },
] as const;
const SPEC = { name: 'unit', paths: ['test/unit', 'test/parity'] };
function onDisk(spec: { paths: string[] }): string[] {
	const found: string[] = [];
	for (const path of spec.paths) for (const m of new Glob('**/*.test.ts').scanSync({ cwd: join(REPO_ROOT, path) })) found.push(m);
	return found;
}
const seen = SCAN_ROOTS.map(({ root, glob: pattern }) => [...new Glob(pattern).scanSync({ cwd: join(REPO_ROOT, root) })].length);
const sizes = ['src', 'tools'].map((r) => readdirSync(join(REPO_ROOT, r)).length);
test('y', () => { expect(seen.length + sizes.length + onDisk(SPEC).length).toBeGreaterThan(3); });`;
		expect(feedOver({ [GATE]: gate }).feed.roots).toEqual([
			'client/dedalo',
			'src',
			'test',
			'test/parity',
			'test/unit',
			'tools',
		]);
	});

	test('an argument the evaluator cannot read is an OPAQUE site — counted, never silently a root', () => {
		const gate = `${PRELUDE}
import { mkdtempSync } from 'node:fs';
const scratch = mkdtempSync(join(tmpdir(), 'x-'));
const listed = readdirSync(scratch);
const real = readdirSync(join(REPO_ROOT, 'deploy'));
test('y', () => { expect(listed.length + real.length).toBeGreaterThan(0); });`;
		const { feed } = feedOver({ [GATE]: gate });
		expect(feed).toMatchObject({ roots: ['deploy'], chooses: true, ownSites: 2, opaqueSites: 1 });
		// The entry must declare it: a bare ROOTS: entry over this feed is a mismatch, and so
		// is a wrong root, a missing kind, or an empty ROOTS: list.
		expect(walkerEntryProblems(GATE, 'ROOTS: `deploy`.', feed)).toHaveLength(1);
		expect(
			walkerEntryProblems(GATE, 'ROOTS: `deploy` [opaque: 1] — a scratch tree.', feed),
		).toEqual([]);
		expect(walkerEntryProblems(GATE, 'ROOTS: `src` [opaque: 1].', feed)).toHaveLength(1);
		expect(walkerEntryProblems(GATE, 'OWN-DIR: whatever', feed)).toHaveLength(1);
		expect(walkerEntryProblems(GATE, 'ROOTS: nothing backticked [opaque: 1]', feed)).toHaveLength(
			2,
		);
		expect(walkerEntryProblems(GATE, 'NO-ROOT: [opaque: 1] scratch', feed)).toHaveLength(1);
	});

	test('text is not a root: a directory named in a string, a comment or a hand array feeds no walk', () => {
		const gate = `${PRELUDE}
// the corpus is src/core — see readdirSync('src/core') in the helper
const NOTE = "readdirSync('src/core')";
const CORPUS = ['src/a.ts', 'tools/b.ts'];
const files = readdirSync(join(REPO_ROOT, 'deploy'));
test('y', () => { expect(files.length + NOTE.length + CORPUS.length).toBeGreaterThan(0); });`;
		expect(feedOver({ [GATE]: gate }).feed.roots).toEqual(['deploy']);
	});

	test('an entry parses its root list, its opaque count and nothing from the prose; a path normalizes to a tracked directory or to nothing', () => {
		expect(
			parseWalkerEntry(
				'ROOTS: `src` `tools` ×2; `test` [opaque: 1] — plus `git ls-files -s` and `*.less` anywhere (`scripts` is not walked).',
			),
		).toEqual({
			kind: 'ROOTS',
			groups: [['src', 'tools'], ['src', 'tools'], ['test']],
			opaque: 1,
		});
		expect(parseWalkerEntry('ROOTS: `.` — the whole index.')).toEqual({
			kind: 'ROOTS',
			groups: [['.']],
			opaque: 0,
		});
		expect(parseWalkerEntry('NO-ROOT: `git ls-files -s` on two symlinks.')).toEqual({
			kind: 'NO-ROOT',
			groups: [],
			opaque: 0,
		});
		// Groups are a multiset: order among sites and within a group is not identity.
		expect(canonicalGroups([['tools', 'src'], ['test'], ['src', 'tools']])).toBe(
			'src tools; src tools; test',
		);
		expect(canonicalGroups(parseWalkerEntry('ROOTS: `test`; `src` `tools` ×2').groups)).toBe(
			'src tools; src tools; test',
		);
		expect(parseWalkerEntry('OWN-DIR: every gate under import.meta.dir').kind).toBeUndefined();
		expect(normalizeFedPath('test/unit/../../src/**/*.ts')).toBe('src');
		expect(normalizeFedPath('test/unit/../..')).toBe('.');
		expect(normalizeFedPath('tools//**/*.js')).toBe('tools');
		expect(normalizeFedPath(`${REPO_ROOT}/src/core`)).toBe('src/core');
		expect(normalizeFedPath('/tmp/x')).toBeUndefined();
		expect(normalizeFedPath('test/unit/../../../private')).toBeUndefined();
		expect(expandBraces('{src,tools}/**/*.{ts,js}')).toEqual([
			'src/**/*.ts',
			'src/**/*.js',
			'tools/**/*.ts',
			'tools/**/*.js',
		]);
		expect(splitTopLevel("a, join(b, 'c,d'), [e, f]", ',')).toEqual([
			'a',
			" join(b, 'c,d')",
			' [e, f]',
		]);
		expect(lastMethodCall("ROOTS.map((r) => 'x')")).toMatchObject({
			receiver: 'ROOTS',
			name: 'map',
		});
		expect(lastMethodCall('ROOTS.map((r) => x).length')).toBeUndefined();
	});

	test('only an export BOUND to the walk seeds a floor: a policy array exported beside the walk is not the walk', () => {
		const lister = `
import { readdirSync } from 'node:fs';
export const SCAN_ROOTS = ['src', 'tools'];
export const ZERO_TIER = ['src/core/api/', 'src/core/db/'] as const;
export const CORPUS_FLOOR = 50;
export function throwSites(): string[] { return SCAN_ROOTS.flatMap((r) => readdirSync(r)); }`;
		const gateOnPolicy = `
import { SCAN_ROOTS, ZERO_TIER, throwSites } from '../helpers/x_census.ts';
test('y', () => {
	for (const s of throwSites()) expect(s).toBeDefined();
	expect([...ZERO_TIER]).toEqual(['src/core/api/', 'src/core/db/']);
	expect(SCAN_ROOTS.length).toBeGreaterThan(1);
});`;
		const module: ImportedModule = { path: HELPER, code: lister };
		expect(classify(CLAIMING_ROW, gateOnPolicy, [module], NO_LISTS)).toMatchObject({
			shape: 'walk',
			boundFloor: false,
			ok: false,
		});
		expect(boundExports([module])).toEqual(['throwSites']);
		const gateOnWalk = gateOnPolicy.replace(
			'for (const s of throwSites()) expect(s).toBeDefined();',
			'expect(throwSites().length).toBeGreaterThan(CORPUS_FLOOR);',
		);
		expect(classify(CLAIMING_ROW, gateOnWalk, [module], NO_LISTS).boundFloor).toBe(true);
		// Transitively: an export bound through ANOTHER helper's walk seeds too.
		const inner: ImportedModule = {
			path: 'test/helpers/inner.ts',
			code: "import { readdirSync } from 'node:fs';\nexport function walk() { return readdirSync('src'); }",
		};
		const outer: ImportedModule = {
			path: HELPER,
			code: "import { walk } from './inner.ts';\nexport function corpus() { return walk().filter((f) => f.endsWith('.ts')); }\nexport const POLICY = ['src/a.ts'];",
		};
		expect(boundExports([outer, inner]).sort()).toEqual(['corpus', 'walk']);
		const twoHops =
			"import { corpus, POLICY } from '../helpers/x_census.ts';\ntest('y', () => { expect(corpus().length).toBeGreaterThan(3); });";
		expect(classify(CLAIMING_ROW, twoHops, [outer, inner], NO_LISTS).boundFloor).toBe(true);
		expect(
			classify(
				CLAIMING_ROW,
				twoHops.replace('corpus().length', 'POLICY.length'),
				[outer, inner],
				NO_LISTS,
			).boundFloor,
		).toBe(false);
	});

	test('the unit set follows relative imports transitively into the shared infrastructure, never into src/, never through `import type`', () => {
		const sources = {
			[GATE]:
				"import { a } from '../helpers/a.ts';\nimport type { T } from '../helpers/typed.ts';\nimport { e } from '../../src/core/x.ts';",
			'test/helpers/a.ts': "import { b } from '../../scripts/lib/b.ts';\nexport const a = b;",
			'scripts/lib/b.ts':
				"import { readdirSync } from 'node:fs';\nexport const b = readdirSync('src');",
			'test/helpers/typed.ts':
				"import { readdirSync } from 'node:fs';\nexport type T = string;\nexport const files = readdirSync('tools');",
			'src/core/x.ts':
				"import { readdirSync } from 'node:fs';\nexport const e = readdirSync('src');",
		};
		const units = unitsOf(GATE, (path) => sources[path as keyof typeof sources]);
		expect(units.map((unit) => unit.path)).toEqual([GATE, 'test/helpers/a.ts', 'scripts/lib/b.ts']);
		expect(units[1]?.imports.get('b')).toEqual({ unit: 'scripts/lib/b.ts', name: 'b' });
	});
});

// ---------------------------------------------------------------------------
// The write-path class shares ONE corpus, rooted at src/ + tools/ + scripts/.
// ---------------------------------------------------------------------------

describe('write-path census — one corpus, scripts/ included', () => {
	test('the shared corpus is rooted at src/, tools/ and scripts/ and is populated', () => {
		expect([...WRITE_PATH_ROOTS]).toEqual(['src', 'tools', 'scripts']);
		// ONE walk site over the three roots — the registry says so, per site.
		expect(canonicalGroups(SHARED_LISTERS['test/helpers/write_path_corpus.ts']?.roots ?? [])).toBe(
			canonicalGroups([[...WRITE_PATH_ROOTS]]),
		);
		const files = writePathSourceFiles();
		expect(files.length).toBeGreaterThan(WRITE_PATH_CORPUS_FLOOR);
		expect(WRITE_PATH_CORPUS_FLOOR).toBeGreaterThan(500);
		expect(files).toContain(SCRIPTS_POSITIVE_CONTROL);
		expect(files.some((file) => file.startsWith('src/core/db/'))).toBe(true);
		expect(files.some((file) => file.startsWith('tools/'))).toBe(true);
		expect(files.some((file) => file.endsWith('.test.ts'))).toBe(false);
		expect(files.some((file) => file.startsWith('test/'))).toBe(false);
	});

	test('the positive control really is a matrix writer outside src/ and tools/', () => {
		const code = stripComments(readRepo(SCRIPTS_POSITIVE_CONTROL));
		expect(code).toMatch(/\bmatrix_\w+/);
		expect(code).toMatch(/\b(?:UPDATE|updateMatrix\w*)\b/);
	});

	test('each write-path gate imports the shared corpus and owns no private walk', () => {
		const offenders: string[] = [];
		for (const gate of WRITE_PATH_GATES) {
			const source = readRepo(gate);
			if (!source.includes("from '../helpers/write_path_corpus.ts'")) {
				offenders.push(`${gate}: does not import test/helpers/write_path_corpus.ts`);
			}
			if (hasDerivation(stripComments(source))) {
				offenders.push(`${gate}: carries a private directory walk beside the shared corpus`);
			}
		}
		expect(
			offenders,
			'the write-path gates census ONE corpus (test/helpers/write_path_corpus.ts) so their roots cannot drift:',
		).toEqual([]);
	});
});
