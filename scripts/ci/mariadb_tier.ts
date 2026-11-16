/**
 * MARIADB TIER — the blocking stage that proves every MariaDB-bound gate RAN, against
 * the SUITE's own MariaDB, and that EACH gate's own writes landed there (PUB-05, audit
 * 2026-09-26).
 *
 *   bun run scripts/ci/mariadb_tier.ts          # run the set, print faults, exit 1 on any
 *
 * WHY A STAGE OF ITS OWN. Before PUB-05 the diffusion integration gates decided at
 * import time whether to run (`HAVE_DB`, `AVAILABLE`, `test.if`, a `*_difftest` schema
 * discovery). On a runner without the installation's socket they skipped GREEN; on a
 * developer machine with one they wrote into the installation's publication database
 * (`web_numisdata_mib`). Both are the same defect seen from two sides: the target was
 * borrowed from the machine instead of built by the suite. The unit baseline could not
 * see it — its per-file floors were recorded on a machine where the gates ran, against
 * the installation.
 *
 * WHAT IS MEASURED (outcomes, never spellings):
 *   1. the SET — every test/integration file, minus the shrink-only INSTALL_BOUND_EXEMPT
 *      rows, plus every test/unit AND test/parity file that IMPORTS test/helpers/suite_mariadb.ts at
 *      runtime (Bun's own transpiler resolves the imports: type-only imports are erased,
 *      dynamic ones count). Floor: MARIADB_TIER_FILE_FLOOR files.
 *   1b. THE NO-CONTACT POPULATION — every test/unit AND test/parity file OUTSIDE the set
 *      whose RUNTIME import closure reaches `src/diffusion/targets/mariadb/db.ts` (the
 *      module that opens MariaDB pools) is RUN, in one armed batch with the suite server
 *      up, and the suite
 *      user's CONTACTS with that server (connections opened + refused, USER_STATISTICS)
 *      must not move. The population is DERIVED, never listed: static and literal dynamic
 *      imports, followed transitively through test/helpers, src and tools, plus the
 *      reasoned SEAM_EDGES of the product modules that import by a COMPUTED path (a
 *      product module with such an import and no row is red). A gate that opens a pool
 *      without acquiring is thereby measured, not trusted: armed, it lands on the suite
 *      server as the suite user; a non-zero batch is re-run file by file and each file
 *      that contacted is named with its import chain. Every population file must RUN
 *      ≥1 case — reported, not all skipped, and ≥1 `expect` executed (a file whose
 *      `beforeAll` threw reports ONE failed '(unnamed)' case and 0 assertions: it never
 *      reached the code that could open a pool, so it proves nothing) — unless a
 *      reasoned, shrink-only NO_CONTACT_IDLE row says why it runs nothing by
 *      construction (a row whose file now runs, or left the population, is red);
 *      partial skips are printed, not judged; its pass/fail is the unit / parity tier's
 *      verdict, not this stage's. A population file that ACQUIRES (through a wrapper
 *      helper) is red too: the set must derive it. Floors: NO_CONTACT_POPULATION_FLOOR
 *      (test/unit) and NO_CONTACT_PARITY_FLOOR (test/parity).
 *      WHY test/parity (review 2026-09-30, measured). The preload arms EVERY `bun test`
 *      process, parity included, and 37 test/parity files reach the pool module
 *      transitively (count_differential, widgets_differential, ts_mutations_differential…).
 *      Holding only test/unit left that half of the class declared, not measured. Parity
 *      replays the frozen fixture store, credless, so it runs in the same batch — AFTER
 *      the parity tier measured its own verdict (db_tier.sh runs this stage last).
 *      NOT CLOSED HERE, said so: a contact that happens only in a situation the suite
 *      database does not hold is not made on this run; a test-side computed import is not
 *      followed; and a developer run with the lane server DOWN still falls back to the
 *      installation's TCP server — PUB-05b closes that for every caller.
 *   2. per file, from bun's own JUnit counts: it REPORTED, ran >0 cases, SKIPPED NONE,
 *      failed none, and executed >0 `expect` calls. `skipped === 0` per file is what
 *      closes the partial skip — one `test.if(false)` leg in an otherwise green file.
 *   3. per helper-importing file, an ACQUISITION row in the ledger the helper appends
 *      only after the marker read named THIS lane: the file really reached the suite
 *      server, not some other one.
 *   4. PER FILE, the ROWS THE SUITE USER CHANGED on this server while THAT file ran
 *      (`information_schema.USER_STATISTICS` for `dedalo_test_diffusion`: rows
 *      inserted, deleted, updated) match the file's declared ROW_CONTRACT — every
 *      counter it declares rises; a file declared row-less moves none. So each writer
 *      gate proves ITS OWN writes landed on the suite server.
 *
 * WHY PER FILE (review 2026-09-30). The second version diffed the counters once around
 * the whole set, and the set contains suite_mariadb_target_native — the gate that
 * exercises this very measure by inserting and deleting rows of its own. So the
 * aggregate rose whenever that one gate passed, whatever the product gates wrote: leg 4
 * could not go red while it was green. Each file now runs in its own `bun test` and is
 * judged on its own window; no file's writes can stand in for another's.
 *
 * WHY TRANSITIVE AND MEASURED (review 2026-09-30). The previous leg 1b took ONE hop on
 * each side — db.ts plus its direct src importers, against each test's direct imports —
 * and held the five files it found with reasoned NO_CONTACT rows that nothing measured.
 * Measured with the stage's own scanner: 130 test/unit files reached db.ts transitively
 * and were neither in the set nor held (e.g. reconcile_registry_native → core/reconcile/
 * catalog → a dynamic import of diffusion/api/reconcile → public_tier_reconcile →
 * getTargetPool). The rows are gone; the closure is derived and its outcome measured.
 *
 * WHY PER-USER ROWS, NOT `Com_*` (review 2026-09-30, measured). The first version diffed
 * the global `Com_insert`/`Com_create_table`/`Com_delete`. Those count statements
 * DISPATCHED, by anyone, whatever they did: the helper's own root provisioning (a no-op
 * `CREATE TABLE IF NOT EXISTS`, a 0-row `DELETE`, an `INSERT … ON DUPLICATE KEY`) and the
 * self-check's REFUSED insert (errno 1142) each raised them by one, and every child
 * `bun test` runs both once. Rows changed BY THE DIFFUSION USER exclude root and exclude
 * refused statements.
 *
 * THE MEASURE IS CALIBRATED ON EVERY RUN, live. Before the set, two planted one-file runs
 * go through the same runner: one whose gate only ACQUIRES (the whole harness: ensure,
 * provisioning, self-check, marker read) must move every counter by EXACTLY 0; one whose
 * gate also inserts, updates and deletes one row must move each by > 0. A measure that
 * counts the harness, or is blind to a write, is a RED — so leg 4 can never pass by
 * construction. Leg 1b's contact measure has its own pair: a planted file that imports
 * the pool module and opens nothing must move the contacts by EXACTLY 0; one that opens a
 * pool WITHOUT acquiring (after proving it is armed at a live suite socket, so it can
 * never take the TCP fallback) must move them by > 0 — which also proves the runner's
 * child is ARMED: an unarmed child would contact some other server, and read 0 here. A measure that cannot be READ (userstat off, the server gone) is a
 * structured fault in the same report, never an uncaught stack.
 *
 * NOTHING RUNS UNTIL THE SUITE SERVER EXISTS. The set is handed to `bun test` only after
 * `ensureSuiteMariadb()` answered; a missing helper or a server that will not start is
 * a refusal BEFORE any file runs, so this stage can never be the thing that drives the
 * gates at the installation's socket. Arming itself is the preload's job
 * (test/preload/suite_mariadb.ts); this stage deliberately does NOT export the suite
 * env to its child, so a preload that stops arming is caught here too (the files'
 * `requireSuiteMariadb` refuses, the counts go red) instead of being papered over.
 *
 * Everything is injectable (`runMariadbTier({ runner, helper, listing })`) so the whole
 * stage — not only its pure halves — is held by planted controls in
 * test/unit/suite_mariadb_target_native.test.ts.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { isAbsolute, join, posix, relative } from 'node:path';
import { type ParityRun, REPO_ROOT } from '../lib/parity_census.ts';
import { runTier } from '../lib/tier_run.ts';

/** Anti-vacuity floor on the SET. Fix the derivation, never the floor. */
export const MARIADB_TIER_FILE_FLOOR = 5;

/** The one module through which a gate acquires the suite MariaDB target. */
export const SUITE_MARIADB_HELPER = 'test/helpers/suite_mariadb.ts';

/** The module that opens MariaDB connections: leg 1b's population is its runtime import closure. */
export const MARIADB_POOL_MODULE = 'src/diffusion/targets/mariadb/db.ts';

/**
 * The gate that exercises THIS stage's measure (its legs insert and delete rows to prove
 * the counters move). Its rows are its own plant, so it never counts toward the floor of
 * product writers below.
 */
export const MEASURE_SELF_GATE = 'test/unit/suite_mariadb_target_native.test.ts';

/** Anti-vacuity floor on the product WRITER gates (row contract rises, K excluded). */
export const MARIADB_WRITER_FLOOR = 5;

/** The suite user's row counters the stage reads (USER_STATISTICS). */
export const WRITE_COUNTERS = ['rows_inserted', 'rows_deleted', 'rows_updated'] as const;
export type WriteCounter = (typeof WRITE_COUNTERS)[number];
export type WriteDeltas = Record<WriteCounter, number>;

/**
 * THE ROW CONTRACT of one set file: `rises` — each named counter must move by > 0 in the
 * file's OWN window; `none` — the file changes no row as the suite user (every counter
 * must move by exactly 0), with the reason.
 */
export type RowContract = { rises: readonly WriteCounter[] } | { none: string };

/**
 * One row per file of the set, exact in both directions (a set file without a row, or a
 * row naming no set file, is red). Declared from the per-file measurement of 2026-09-30
 * on the l3 lane, and re-checked by every run: a writer whose writes stop landing here,
 * or a declared reader that starts writing, is red.
 */
export const ROW_CONTRACT: ReadonlyMap<string, RowContract> = new Map<string, RowContract>([
	[
		'test/integration/diffusion_mariadb.test.ts',
		{ rises: ['rows_inserted', 'rows_deleted', 'rows_updated'] },
	],
	['test/integration/diffusion_publish_native.test.ts', { rises: ['rows_inserted'] }],
	['test/integration/publication_api_v2_smoke.test.ts', { rises: ['rows_inserted'] }],
	['test/unit/unpublish_debt_native.test.ts', { rises: ['rows_inserted', 'rows_deleted'] }],
	['test/unit/diffusion_runner_native.test.ts', { rises: ['rows_inserted', 'rows_deleted'] }],
	// DIFF-2 (measured 2026-10-01, l3: +93 inserted, +17 deleted, 0 updated): the sql
	// element's fenced publications and the fenced delete doors' unpublishes.
	['test/unit/diffusion_target_fence_native.test.ts', { rises: ['rows_inserted', 'rows_deleted'] }],
	// Measured 2026-10-21 (l3: +17 inserted, 0 deleted, 0 updated): each leg's table reset
	// writes its rows; every blocked DELETE/upsert fails on its lock wait, so none moves.
	['test/unit/diffusion_target_statement_lock_wait_native.test.ts', { rises: ['rows_inserted'] }],
	// T1-3 (global_table_maps): the global element's publications (source + global
	// rows), the delete-then-insert refresh, the delete door and the reconcile apply.
	[
		'test/unit/diffusion_global_table_native.test.ts',
		{ rises: ['rows_inserted', 'rows_deleted', 'rows_updated'] },
	],
	[MEASURE_SELF_GATE, { rises: ['rows_inserted', 'rows_deleted'] }],
	[
		'test/unit/diffusion_row_size_native.test.ts',
		{
			none: "Its live legs calibrate the plan compile's row-width rule against the server: CREATE TABLE at the 65535-byte boundary (one accepted, one refused 1118) and DROP of those scratch tables — DDL only, no row is written",
		},
	],
	[
		'test/unit/diffusion_native_delete.test.ts',
		{
			none: "Every real-executor leg targets a table or database that does not exist (errno 1146 / 1049 are its idempotent successes) — the gate proves the errno posture, not a row delete; the executor deleting a live row is unpublish_debt_native's ROW leg, whose contract declares rows_deleted",
		},
	],
	// Measured 2026-10-21 (ci:local --docker, l3: 0/0/0).
	[
		'test/unit/media_index_marker_durability_native.test.ts',
		{
			none: "Its executor legs delete from a table never created on a suite target (errno 1146, the idempotent branch) so the withdrawal of the record's media markers is what is measured — no MariaDB row is touched",
		},
	],
	[
		'test/unit/diffusion_connection_status.test.ts',
		{
			none: 'Its live legs run the real connection probe (the memo leg on a suite target and the granted-never-created control; the payload leg on the zzd situation’s two sql targets) — a reader by design, it changes no MariaDB row; every other probe is injected',
		},
	],
	// Measured 2026-10-01 (CI domain `test`): both reach MariaDB only through READ audits
	// of the ontology's diffusion targets, and are acquirers so those pools are proved armed.
	[
		'test/unit/restore_door_native.test.ts',
		{
			none: 'Leg 10 runs the REAL post-restore plan, whose public-tier reconcile is a DRY step (apply:false): it reads each declared target database and table to measure drift and writes nothing — measured 0/0/0',
		},
	],
	[
		'test/parity/widgets_differential.test.ts',
		{
			none: 'The maintenance-area read computes check_config’s eager value, whose published-language coherence AUDIT discovers tables and counts their langs per declared target database — read only, measured 0/0/0',
		},
	],
	[
		'test/unit/server_state.test.ts',
		{
			none: 'check_config (get_value and the eager catalog value) runs the published-language coherence AUDIT: it discovers tables and counts their langs in each declared target database, read only — measured 0/0/0',
		},
	],
]);

/**
 * Anti-vacuity floor on the NO-CONTACT POPULATION (leg 1b). Measured 2026-09-30: 136
 * test/unit files reach the pool module outside the set. A derivation that goes blind (a
 * scanner that stops following imports) collapses it; fix the derivation, never the floor.
 */
export const NO_CONTACT_POPULATION_FLOOR = 60;

/**
 * The same floor on the population's test/parity half. Measured 2026-09-30: 37 of 78
 * parity files reach the pool module. A listing that stops walking test/parity collapses
 * it to 0.
 */
export const NO_CONTACT_PARITY_FLOOR = 20;

/**
 * SHRINK-ONLY (ceiling held by suite_mariadb_target_native), EXACT BOTH WAYS. A
 * no-contact population file that runs NO case by construction, and why (> 60
 * characters). Its module load still runs inside the measured batch (a contact made at
 * import is still seen); only its case bodies are unmeasured. A row whose file is not in
 * the population, or whose file RAN a case in the batch, is red.
 */
export const NO_CONTACT_IDLE: ReadonlyMap<string, string> = new Map([
	[
		'test/parity/delete_children_guard_differential.test.ts',
		'A LIVE-PHP-oracle differential (describe.if(hasLivePhpOracle())): the oracle is decommissioned, so every case skips forever. Owner decision pending (closure plan integrator request 10): twin it or delete it.',
	],
	[
		'test/parity/get_widget_data_differential.test.ts',
		'A LIVE-PHP-oracle differential (describe.if(hasLivePhpOracle())): the oracle is decommissioned, so every case skips forever. Owner decision pending (closure plan integrator request 10): twin its uncovered legs or delete it.',
	],
	[
		'test/parity/info_observer_differential.test.ts',
		'A LIVE-PHP-oracle differential (describe.if(hasLivePhpOracle())): the oracle is decommissioned, so every case skips forever. Owner decision pending (closure plan integrator request 10): twin it or delete it.',
	],
]);

/** A product module that imports by a COMPUTED path, and the files that path can name. */
export interface SeamEdge {
	/** Repo-relative globs of every module the computed import can load (Bun.Glob). */
	loads: readonly string[];
	/** Why the import is computed. > 60 characters. */
	reason: string;
}

/**
 * EXACT BOTH WAYS (held by mariadbTierSet). Every product module (src/, tools/) in the
 * derived graph whose source holds a dynamic `import()` of a NON-literal path — which no
 * scanner can follow — has a row naming what that path can load; the listing adds those
 * modules as edges, so the closure crosses the seam instead of stopping at it. A product
 * module with such an import and no row is red (a new seam would silently cut the
 * graph); a row whose module no longer has one is red (stale).
 */
export const SEAM_EDGES: ReadonlyMap<string, SeamEdge> = new Map([
	[
		'src/core/tools/loader.ts',
		{
			loads: ['tools/*/server/**/*.ts'],
			reason:
				"The tool registry imports each tool's server entry by its resolved path on disk (tools/<tool>/server/index.ts, after canonical confinement) — the tool set is data, not source",
		},
	],
	[
		'src/server.ts',
		{
			loads: ['src/core/**/*.ts'],
			reason:
				'The boot warm-up (warmCoreModuleGraph) imports every src/core module by a globbed path so a broken module fails at boot, not on the first request that reaches it',
		},
	],
]);

/** One ledger row, appended by `requireSuiteMariadb` once the marker named this lane. */
export interface Acquisition {
	/** Repo-relative test file. */
	file: string;
	database: string;
}

export interface MariadbTierSet {
	/** Every file the stage runs (repo-relative, sorted). */
	files: string[];
	/** The subset that imports the helper and so MUST appear in the acquisition ledger. */
	mustAcquire: string[];
	/** Leg 1b: the test/unit and test/parity files outside the set whose closure reaches the pool module. */
	noContact: string[];
	/** For each noContact file, one import chain from it to the pool module (for the report). */
	chains: ReadonlyMap<string, readonly string[]>;
}

/** What the set derivation reads — a pure structure so the controls can plant one. */
export interface MariadbTierListing {
	/** test/integration/**\/*.test.ts, repo-relative. */
	integration: string[];
	/** test/unit/**\/*.test.ts, repo-relative. */
	unit: string[];
	/** test/parity/**\/*.test.ts, repo-relative — armed by the same preload (leg 1b). */
	parity: string[];
	/**
	 * The RUNTIME import graph: every module reachable from a test file (tests, helpers,
	 * src, tools…) → its relative imports resolved to repo paths (type-only erased,
	 * literal dynamic imports counted, SEAM_EDGES targets added). A module absent from
	 * the map is a leaf.
	 */
	imports: ReadonlyMap<string, readonly string[]>;
	/** The product modules (src/, tools/) in the graph that import by a computed path. */
	opaque: readonly string[];
}

/**
 * SHRINK-ONLY (ceiling held by suite_mariadb_target_native). An integration file that is
 * bound to an INSTALLATION's records and so cannot run on the suite server by
 * construction. Reason > 60 characters. A row whose file is gone, or whose file acquires
 * the suite target (so is not install-bound), is red.
 */
export const INSTALL_BOUND_EXEMPT: ReadonlyMap<string, string> = new Map([
	[
		'test/integration/diffusion_publish_e2e.test.ts',
		"Unreachable under suite arming: it compiles an INSTALLATION's real diffusion element and publishes into that element's own database, which the suite MariaDB does not and must not hold. Owner: retire (closure plan 2026-09-26, integrator request 10).",
	],
]);

const importsOf = (listing: MariadbTierListing, file: string): readonly string[] =>
	listing.imports.get(file) ?? [];

/** Every module whose runtime closure contains `target` (itself included). Pure; cycle-safe. */
export function reachersOf(
	imports: ReadonlyMap<string, readonly string[]>,
	target: string,
): Set<string> {
	const importers = new Map<string, string[]>();
	for (const [module, targets] of imports)
		for (const imported of targets) {
			const list = importers.get(imported);
			if (list === undefined) importers.set(imported, [module]);
			else list.push(module);
		}
	const reached = new Set<string>([target]);
	const queue = [target];
	for (let next = queue.pop(); next !== undefined; next = queue.pop())
		for (const importer of importers.get(next) ?? [])
			if (!reached.has(importer)) {
				reached.add(importer);
				queue.push(importer);
			}
	return reached;
}

/** One shortest import chain `from` → … → `target`, or null. Pure; cycle-safe. */
export function importChain(
	imports: ReadonlyMap<string, readonly string[]>,
	from: string,
	target: string,
): string[] | null {
	const previous = new Map<string, string | null>([[from, null]]);
	const queue = [from];
	for (let head = 0; head < queue.length; head++) {
		const module = queue[head] as string;
		if (module === target) {
			const chain: string[] = [];
			for (let at: string | null = module; at !== null; at = previous.get(at) ?? null)
				chain.unshift(at);
			return chain;
		}
		for (const imported of imports.get(module) ?? [])
			if (!previous.has(imported)) {
				previous.set(imported, module);
				queue.push(imported);
			}
	}
	return null;
}

/** Derive the stage's set. Pure. Returns faults instead of throwing, so all are seen at once. */
export function mariadbTierSet(
	listing: MariadbTierListing,
	exempt: ReadonlyMap<string, string> = INSTALL_BOUND_EXEMPT,
	contract: ReadonlyMap<string, RowContract> = ROW_CONTRACT,
	seams: ReadonlyMap<string, SeamEdge> = SEAM_EDGES,
	idle: ReadonlyMap<string, string> = NO_CONTACT_IDLE,
): { set: MariadbTierSet; faults: string[] } {
	const faults: string[] = [];
	const acquires = (file: string) => importsOf(listing, file).includes(SUITE_MARIADB_HELPER);
	for (const [file, reason] of exempt) {
		if (!listing.integration.includes(file))
			faults.push(`INSTALL_BOUND_EXEMPT names ${file}, which no longer exists — delete the row`);
		if (reason.length <= 60)
			faults.push(`INSTALL_BOUND_EXEMPT row ${file}: the reason must say why (> 60 characters)`);
		// A file that ACQUIRES the suite target is by construction not bound to an
		// installation: exempting it would drop a live MariaDB gate from the stage.
		if (acquires(file))
			faults.push(
				`INSTALL_BOUND_EXEMPT row ${file}: it acquires the suite MariaDB target (imports ${SUITE_MARIADB_HELPER}), so it is not install-bound — delete the row`,
			);
	}
	const integration = listing.integration.filter((file) => !exempt.has(file));
	// test/parity acquirers too (2026-10-01): the preload arms parity files exactly like
	// unit ones, and a parity gate whose real read opens a pool (widgets_differential —
	// check_config's eager language audit) must be able to acquire rather than hide it.
	const acquirers = [...listing.unit, ...listing.parity].filter(acquires);
	const files = [...new Set([...integration, ...acquirers])].sort();
	const mustAcquire = files.filter(acquires);
	if (files.length < MARIADB_TIER_FILE_FLOOR) {
		faults.push(
			`the MariaDB tier set has ${files.length} file(s), below the floor of ${MARIADB_TIER_FILE_FLOOR} — the gates that must acquire the suite target do not (set: ${files.join(', ') || 'empty'})`,
		);
	}

	// 1b. The no-contact population: every unit and parity file outside the set whose
	//     runtime closure reaches the pool module. Derived here; its outcome is measured by
	//     the run.
	const reaching = reachersOf(listing.imports, MARIADB_POOL_MODULE);
	if (reaching.size <= 1)
		faults.push(
			`the import graph lost ${MARIADB_POOL_MODULE} — no module in it imports the module that opens MariaDB pools, so the no-contact population cannot be derived`,
		);
	const inSet = new Set(files);
	const outside = (file: string) => !inSet.has(file) && reaching.has(file);
	const unitPopulation = listing.unit.filter(outside);
	const parityPopulation = listing.parity.filter(outside);
	const noContact = [...unitPopulation, ...parityPopulation];
	const chains = new Map<string, readonly string[]>();
	for (const file of noContact)
		chains.set(file, importChain(listing.imports, file, MARIADB_POOL_MODULE) ?? [file]);
	if (
		unitPopulation.length < NO_CONTACT_POPULATION_FLOOR ||
		parityPopulation.length < NO_CONTACT_PARITY_FLOOR
	)
		faults.push(
			`the no-contact population has ${unitPopulation.length} test/unit + ${parityPopulation.length} test/parity file(s), below the floor of ${NO_CONTACT_POPULATION_FLOOR} + ${NO_CONTACT_PARITY_FLOOR} — the import graph no longer sees the test files that reach ${MARIADB_POOL_MODULE}`,
		);
	// The idle rows, exact both ways (the "now runs" half is judged on the run).
	const inPopulation = new Set(noContact);
	for (const [file, reason] of idle) {
		if (!inPopulation.has(file))
			faults.push(
				`NO_CONTACT_IDLE names ${file}, which is not in the no-contact population — delete the row`,
			);
		if (reason.length <= 60)
			faults.push(`NO_CONTACT_IDLE row ${file}: the reason must say why (> 60 characters)`);
	}
	// The seams, exact both ways: a computed import no row explains would cut the graph.
	const opaque = new Set(listing.opaque);
	for (const module of opaque)
		if (!seams.has(module))
			faults.push(
				`${module}: imports by a computed path, which the graph cannot follow — add a SEAM_EDGES row naming what it can load (and why), or import literally`,
			);
	for (const [module, edge] of seams) {
		if (!opaque.has(module))
			faults.push(
				`SEAM_EDGES names ${module}, which no longer imports by a computed path (or left the graph) — delete the row`,
			);
		if (edge.reason.length <= 60)
			faults.push(`SEAM_EDGES row ${module}: the reason must say why (> 60 characters)`);
		if (edge.loads.length === 0)
			faults.push(`SEAM_EDGES row ${module}: 'loads' names nothing — the seam would stay cut`);
	}

	// 4 (declaration half). The row contract is exact in both directions.
	for (const file of files)
		if (!contract.has(file))
			faults.push(
				`${file}: no ROW_CONTRACT row — declare the rows it must move (rises) or that it moves none (none, with the reason)`,
			);
	let writers = 0;
	for (const [file, row] of contract) {
		if (!inSet.has(file))
			faults.push(`ROW_CONTRACT names ${file}, which is not in the tier set — delete the row`);
		if ('none' in row) {
			if (row.none.length <= 60)
				faults.push(`ROW_CONTRACT row ${file}: the 'none' reason must say why (> 60 characters)`);
		} else if (row.rises.length === 0) {
			faults.push(`ROW_CONTRACT row ${file}: 'rises' names no counter — use 'none' with a reason`);
		} else if (file !== MEASURE_SELF_GATE && inSet.has(file)) writers++;
	}
	if (writers < MARIADB_WRITER_FLOOR)
		faults.push(
			`only ${writers} product gate(s) declare writes, below the floor of ${MARIADB_WRITER_FLOOR} (${MEASURE_SELF_GATE} does not count: its rows are the measure's own plant)`,
		);
	return { set: { files, mustAcquire, noContact, chains }, faults };
}

/**
 * THE VERDICT. Pure: every fault of one run, over its JUnit counts, the acquisition
 * ledger and each file's OWN row deltas, judged against the row contract.
 */
export function mariadbTierFaults(
	run: Pick<ParityRun, 'cases' | 'perFile'>,
	ledger: readonly Acquisition[],
	deltas: ReadonlyMap<string, WriteDeltas>,
	set: MariadbTierSet,
	contract: ReadonlyMap<string, RowContract> = ROW_CONTRACT,
): string[] {
	const faults: string[] = [];
	const failed = new Map<string, number>();
	for (const c of run.cases) {
		if (c.status === 'fail') failed.set(c.file, (failed.get(c.file) ?? 0) + 1);
	}
	for (const file of set.files) {
		const counts = run.perFile[file];
		if (counts === undefined) {
			faults.push(`${file}: reported nothing (crashed at import, or not run)`);
			continue;
		}
		if (counts.tests === 0) faults.push(`${file}: ran 0 cases`);
		if (counts.skipped !== 0)
			faults.push(
				`${file}: skipped ${counts.skipped} of ${counts.tests} case(s) — a MariaDB gate may not skip on the suite server`,
			);
		const failures = failed.get(file) ?? 0;
		if (failures !== 0) faults.push(`${file}: ${failures} case(s) failed`);
		if (counts.assertions === 0) faults.push(`${file}: executed 0 assertions`);
	}
	const acquired = new Set(ledger.map((row) => row.file));
	for (const file of set.mustAcquire) {
		if (!acquired.has(file))
			faults.push(
				`${file}: never acquired the suite MariaDB target (no ledger row) — it did not reach a server marked for this lane`,
			);
	}
	const inSet = new Set(set.files);
	for (const file of acquired) {
		if (!inSet.has(file))
			faults.push(
				`${file}: acquired the suite target but is not in the tier set — the set derivation missed it`,
			);
	}
	for (const file of set.files) {
		const row = contract.get(file);
		if (row === undefined) continue; // a declaration fault, reported by mariadbTierSet
		const own = deltas.get(file);
		if (own === undefined) {
			faults.push(
				`${file}: no write measurement for its own window — its row contract cannot be judged`,
			);
			continue;
		}
		if ('none' in row) {
			const moved = WRITE_COUNTERS.filter((c) => own[c] !== 0);
			if (moved.length > 0)
				faults.push(
					`${file}: declared row-less, but its own run moved ${moved.map((c) => `${c} by ${own[c]}`).join(', ')} as the suite user — correct the ROW_CONTRACT row (or the gate)`,
				);
			continue;
		}
		for (const counter of row.rises) {
			const delta = own[counter];
			if (!(Number.isFinite(delta) && delta > 0))
				faults.push(
					`${file}: the suite user's ${counter} did not rise during ITS OWN run (delta ${delta}) — its declared writes did not reach the suite server`,
				);
		}
	}
	return faults;
}

/** One calibration run: did its single planted file run cleanly, and what did it move. */
export interface CalibrationRun {
	/** The planted file ran ≥1 case, none skipped, none failed. */
	ran: boolean;
	deltas: WriteDeltas;
}

/**
 * THE MEASURE'S OWN CONTROL. Pure. `acquireOnly` is a run whose gate does everything the
 * harness does and writes nothing: each counter must move by EXACTLY 0, or leg 4 counts
 * writes no gate made. `writeOne` inserts, updates and deletes one row as the suite user:
 * each counter must move by > 0, or leg 4 is blind. A calibration that did not run is a
 * fault of its own — never read as a pass.
 */
export function calibrationFaults(acquireOnly: CalibrationRun, writeOne: CalibrationRun): string[] {
	const faults: string[] = [];
	for (const [name, run] of [
		['acquire-only', acquireOnly],
		['write-one-row', writeOne],
	] as const) {
		if (!run.ran)
			faults.push(
				`calibration: the ${name} control did not run cleanly — the write measure is unproven, so leg 4 cannot be judged`,
			);
	}
	for (const counter of WRITE_COUNTERS) {
		const idle = acquireOnly.deltas[counter];
		if (idle !== 0)
			faults.push(
				`calibration: a gate that only ACQUIRES moved ${counter} by ${idle} — the measure counts writes no gate made (the harness's own), so a set that wrote nothing would pass`,
			);
		const moved = writeOne.deltas[counter];
		if (!(Number.isFinite(moved) && moved > 0))
			faults.push(
				`calibration: a gate that inserts, updates and deletes one row moved ${counter} by ${moved} — the measure is blind to a real write`,
			);
	}
	return faults;
}

/** The population run of leg 1b, as the stage measured it. */
export interface NoContactRun {
	/** The batch's JUnit counts (null: the runner reported nothing — a fault of its own). */
	run: Pick<ParityRun, 'perFile'> | null;
	/** The suite user's contacts during the batch (null: unmeasured — a fault of its own). */
	contacts: number | null;
	/** Per-file contacts from the attribution re-run, when the batch moved them. */
	perFile: ReadonlyMap<string, number>;
	/** Files that appended an acquisition row during the batch. */
	acquired: readonly string[];
}

/**
 * THE VERDICT OF LEG 1b. Pure. Every population file RAN ≥1 case (reported, not all
 * skipped, ≥1 assertion executed) unless a NO_CONTACT_IDLE row says why it cannot, none
 * acquired, and the batch moved the suite user's contacts by exactly 0; a non-zero batch
 * names each file whose own re-run contacted, with its import chain.
 */
export function noContactFaults(
	measure: NoContactRun,
	set: MariadbTierSet,
	idle: ReadonlyMap<string, string> = NO_CONTACT_IDLE,
): string[] {
	const faults: string[] = [];
	if (set.noContact.length === 0) return faults;
	if (measure.run !== null)
		for (const file of set.noContact) {
			const counts = measure.run.perFile[file];
			// ALL SKIPPED is "ran no case" (bun's JUnit `tests` counts skipped cases; 0/0
			// included): a file whose every case skipped executed nothing, so its zero proves
			// nothing — the skip-green class the set's `skipped === 0` closes.
			if (counts !== undefined && counts.tests === counts.skipped && idle.has(file)) continue;
			if (counts === undefined || counts.tests === counts.skipped) {
				faults.push(
					`${file}: reached ${MARIADB_POOL_MODULE} but ran no case in the no-contact batch (${counts === undefined ? 'no report' : `${counts.tests} case(s), ${counts.skipped} skipped`}) — a file that never ran proves nothing about contact`,
				);
				continue;
			}
			if (idle.has(file))
				faults.push(
					`NO_CONTACT_IDLE names ${file}, which now RUNS (${counts.tests} case(s), ${counts.skipped} skipped) — delete the row`,
				);
			// ZERO ASSERTIONS is "never reached its code" (measured, bun 1.4.2): a file whose
			// `beforeAll` throws reports tests=1, skipped=0, assertions=0 — one failed
			// '(unnamed)' case — and none of its cases execute.
			if (counts.assertions === 0)
				faults.push(
					`${file}: reached ${MARIADB_POOL_MODULE} but executed 0 assertions in the no-contact batch (${counts.tests} case(s), ${counts.skipped} skipped) — a hook failure reports one '(unnamed)' case and runs none of the file's cases; a file that never ran proves nothing about contact`,
				);
		}
	const population = new Set(set.noContact);
	for (const file of new Set(measure.acquired))
		if (population.has(file))
			faults.push(
				`${file}: acquired the suite target during the no-contact batch (through a wrapper helper) — import ${SUITE_MARIADB_HELPER} directly so the set derives it`,
			);
	if (measure.contacts === null || measure.contacts === 0) return faults;
	const offenders = set.noContact.filter((file) => (measure.perFile.get(file) ?? 0) > 0);
	for (const file of offenders)
		faults.push(
			`${file}: opened ${measure.perFile.get(file)} MariaDB connection(s) as the suite user WITHOUT acquiring the suite target (${(set.chains.get(file) ?? [file]).join(' → ')}) — call requireSuiteMariadb() before any pool (it then joins the set), or inject a fake pool. Unarmed, this contact is the installation's server.`,
		);
	if (offenders.length === 0)
		faults.push(
			`the no-contact batch opened ${measure.contacts} MariaDB connection(s) as the suite user, but no file does alone — an order-dependent contact inside ${set.noContact.length} files; bisect the batch`,
		);
	return faults;
}

/**
 * LEG 1b's OWN CONTROL. Pure. `idle` imports the pool module and opens nothing: exactly 0
 * contacts, or the measure counts what no gate did. `contact` opens one pool without
 * acquiring: > 0, or the measure is blind — or the child is not armed at this server.
 */
export function contactCalibrationFaults(
	idle: { ran: boolean; contacts: number },
	contact: { ran: boolean; contacts: number },
): string[] {
	const faults: string[] = [];
	for (const [name, run] of [
		['no-contact', idle],
		['one-contact', contact],
	] as const)
		if (!run.ran)
			faults.push(
				`calibration: the ${name} control did not run cleanly — the contact measure is unproven, so leg 1b cannot be judged`,
			);
	if (idle.contacts !== 0)
		faults.push(
			`calibration: a gate that opens NO pool moved the suite user's contacts by ${idle.contacts} — the measure counts contacts no gate made`,
		);
	if (!(Number.isFinite(contact.contacts) && contact.contacts > 0))
		faults.push(
			`calibration: a gate that opens one pool without acquiring moved the suite user's contacts by ${contact.contacts} — the measure is blind, or the runner's child is not armed at this server`,
		);
	return faults;
}

export type CalibrationVariant = 'acquire-only' | 'write-one-row' | 'no-contact' | 'one-contact';

/** The planted calibration files' source. Pure (paths in, text out). */
export function calibrationSource(
	variant: CalibrationVariant,
	absolute: { helper: string; db: string },
): string {
	if (variant === 'no-contact' || variant === 'one-contact') {
		const body =
			variant === 'one-contact'
				? `	// Never the driver's TCP fallback: refuse unless armed at a LIVE suite socket.
	if (!isArmed() || !suiteSocketPresent())
		throw new Error('one-contact calibration: not armed at a live suite socket — refusing to connect');
	const rows = (await getTargetPool(SUITE_MARIADB_DATABASES()[0] as string).unsafe('SELECT 1 AS one', [])) as { one: number }[];
	expect(Number(rows[0]?.one)).toBe(1);`
				: "	expect(typeof getTargetPool).toBe('function');";
		return `// GENERATED by scripts/ci/mariadb_tier.ts — the contact measure's ${variant} control.
import { afterAll, expect, test } from 'bun:test';
import { closeAllTargetPools, getTargetPool } from ${JSON.stringify(absolute.db)};
import { isArmed, SUITE_MARIADB_DATABASES, suiteSocketPresent } from ${JSON.stringify(absolute.helper)};

afterAll(async () => {
	await closeAllTargetPools();
});

test('${variant}', async () => {
	expect(isArmed()).toBe(true);
${body}
});
`;
	}
	const write =
		variant === 'write-one-row'
			? `
	await pool.unsafe('CREATE TABLE IF NOT EXISTS zz_tier_calibration (id INT PRIMARY KEY)', []);
	await pool.unsafe('INSERT INTO zz_tier_calibration (id) VALUES (1)', []);
	await pool.unsafe('UPDATE zz_tier_calibration SET id = 2 WHERE id = 1', []);
	await pool.unsafe('DELETE FROM zz_tier_calibration WHERE id = 2', []);
	await pool.unsafe('DROP TABLE zz_tier_calibration', []);`
			: '';
	return `// GENERATED by scripts/ci/mariadb_tier.ts — the write measure's ${variant} control.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { closeAllTargetPools, getTargetPool } from ${JSON.stringify(absolute.db)};
import { requireSuiteMariadb, SUITE_MARIADB_DATABASES } from ${JSON.stringify(absolute.helper)};

const database = SUITE_MARIADB_DATABASES()[0] as string;
beforeAll(async () => {
	await requireSuiteMariadb(import.meta.path, [database]);
}, 120_000);
afterAll(async () => {
	await closeAllTargetPools();
});

test('${variant}', async () => {
	const pool = getTargetPool(database);${write}
	const rows = (await pool.unsafe('SELECT 1 AS one', [])) as { one: number }[];
	expect(Number(rows[0]?.one)).toBe(1);
});
`;
}

// ── the real listing ─────────────────────────────────────────────────────────

function filesUnder(rel: string, suffix: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(join(REPO_ROOT, dir)).sort()) {
			const path = `${dir}/${entry}`;
			if (statSync(join(REPO_ROOT, path)).isDirectory()) walk(path);
			else if (entry.endsWith(suffix)) out.push(path);
		}
	};
	if (existsSync(join(REPO_ROOT, rel))) walk(rel);
	return out;
}

const transpiler = new Bun.Transpiler({ loader: 'ts' });

/**
 * A module's RUNTIME relative imports, resolved to repo paths — through Bun's own
 * transpiler, so comments and strings are not imports, `import type` and `typeof
 * import()` are erased, and a dynamic `import('…')` counts. Throws on a module it cannot
 * parse or a relative specifier that resolves to nothing: a derivation that silently
 * dropped a file would narrow the stage.
 */
export function runtimeImports(file: string, source: string): string[] {
	const out: string[] = [];
	let scanned: { path: string }[];
	try {
		scanned = transpiler.scanImports(source.replace(/^#!.*/, ''));
	} catch (error) {
		throw new Error(`mariadb_tier: ${file} could not be parsed for its imports (${String(error)})`);
	}
	for (const { path: specifier } of scanned) {
		if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
		const base = posix.normalize(posix.join(posix.dirname(file), specifier));
		if (base.startsWith('../')) continue; // outside the repo
		const hit = [base, `${base}.ts`, `${base}/index.ts`].find(
			(candidate) =>
				existsSync(join(REPO_ROOT, candidate)) && statSync(join(REPO_ROOT, candidate)).isFile(),
		);
		if (hit === undefined)
			throw new Error(`mariadb_tier: ${file} imports '${specifier}', which resolves to no file`);
		out.push(hit);
	}
	return out;
}

/** Modules the graph walks INTO (server-side TypeScript); anything else is a leaf. */
const FOLLOWED = /\.(?:ts|tsx|mts)$/;

/** Product modules, whose computed imports must be explained by a SEAM_EDGES row. */
const PRODUCT = /^(?:src|tools)\//;

/**
 * True when `source` holds a dynamic `import()` whose specifier is NOT a literal — read
 * from the transpiled output, so comments and type positions are gone.
 */
export function hasComputedImport(source: string): boolean {
	const code = transpiler.transformSync(source.replace(/^#!.*/, ''));
	return /\bimport\(\s*(?![`'"][^`'"$]*[`'"]\s*[,)])/.test(code);
}

/** The repo files a SEAM_EDGES row's globs can load, sorted. */
function seamTargets(edge: SeamEdge): string[] {
	const out = new Set<string>();
	for (const pattern of edge.loads)
		for (const file of new Bun.Glob(pattern).scanSync({ cwd: REPO_ROOT, onlyFiles: true }))
			out.add(file.split('\\').join('/'));
	return [...out].sort();
}

/**
 * The real listing: the test files, and the runtime import graph walked from them —
 * transitively, through every followed module, crossing each SEAM_EDGES row.
 */
export function realListing(seams: ReadonlyMap<string, SeamEdge> = SEAM_EDGES): MariadbTierListing {
	const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8');
	const integration = filesUnder('test/integration', '.test.ts');
	const unit = filesUnder('test/unit', '.test.ts');
	const parity = filesUnder('test/parity', '.test.ts');
	const imports = new Map<string, readonly string[]>();
	const opaque: string[] = [];
	const queue = [...integration, ...unit, ...parity];
	for (let module = queue.pop(); module !== undefined; module = queue.pop()) {
		if (imports.has(module)) continue;
		if (!FOLLOWED.test(module)) {
			imports.set(module, []);
			continue;
		}
		const source = read(module);
		const targets = runtimeImports(module, source);
		if (PRODUCT.test(module) && hasComputedImport(source)) {
			opaque.push(module);
			const edge = seams.get(module);
			if (edge !== undefined) targets.push(...seamTargets(edge));
		}
		imports.set(module, targets);
		for (const target of targets) if (!imports.has(target)) queue.push(target);
	}
	return { integration, unit, parity, imports, opaque: opaque.sort() };
}

/** Parse the helper's ndjson ledger, from line `from` on; paths made repo-relative. */
export function parseLedger(text: string, from = 0): Acquisition[] {
	return text
		.split('\n')
		.slice(from)
		.filter((line) => line.trim() !== '')
		.map((line) => JSON.parse(line) as Acquisition)
		.map((row) => ({
			...row,
			file: isAbsolute(row.file) ? relative(REPO_ROOT, row.file) : row.file,
		}));
}

// ── the real run ─────────────────────────────────────────────────────────────

/** The shape the stage needs from the helper — declared here so a drift is a type error. */
export interface SuiteMariadbHelper {
	suiteMariadbPaths(suiteDb?: string): { acquisitions: string; root: string };
	ensureSuiteMariadb(): Promise<unknown>;
	suiteUserWrites(): Promise<Record<WriteCounter, number>>;
	/** Connections the suite user opened + was refused (leg 1b). */
	suiteUserContacts(): Promise<number>;
}

export interface MariadbTierOptions {
	/** The tier census's `runTier` by default; a drill may hand the child `--preload`. */
	runner?: (files: string[]) => ParityRun;
	/** test/helpers/suite_mariadb.ts by default (imported lazily: a missing one is a refusal). */
	helper?: SuiteMariadbHelper;
	listing?: MariadbTierListing;
	/** Where the report goes (console by default). */
	log?: { out(line: string): void; err(line: string): void };
}

export interface MariadbTierResult {
	code: 0 | 1;
	faults: string[];
}

const NAN_DELTAS = (): WriteDeltas =>
	Object.fromEntries(WRITE_COUNTERS.map((c) => [c, Number.NaN])) as WriteDeltas;

/** A counter reader: named numbers, diffed around a run. */
type Reader<K extends string> = () => Promise<Record<K, number>>;

/**
 * Run `files` through `runner`, diffing `read`'s counters around it. Never throws: a
 * runner or a measure that fails is a FAULT in the result, so the stage always reaches
 * its structured report.
 */
async function measured<K extends string>(
	read: Reader<K>,
	runner: (files: string[]) => ParityRun,
	files: string[],
	label: string,
	what = 'the write measure',
): Promise<{ run: ParityRun | null; deltas: Record<K, number> | null; faults: string[] }> {
	let before: Record<K, number>;
	try {
		before = await read();
	} catch (error) {
		return {
			run: null,
			deltas: null,
			faults: [
				`${label}: ${what} could not be read BEFORE the run, so nothing was run (${String(error).split('\n')[0]})`,
			],
		};
	}
	let run: ParityRun;
	try {
		run = runner(files);
	} catch (error) {
		return {
			run: null,
			deltas: null,
			faults: [`${label}: the runner reported nothing (${String(error).split('\n')[0]})`],
		};
	}
	try {
		const after = await read();
		const deltas = Object.fromEntries(
			(Object.keys(before) as K[]).map((c) => [c, after[c] - before[c]]),
		) as Record<K, number>;
		return { run, deltas, faults: [] };
	} catch (error) {
		return {
			run,
			deltas: null,
			faults: [
				`${label}: ${what} could not be read AFTER the run (${String(error).split('\n')[0]})`,
			],
		};
	}
}

const writesOf =
	(helper: SuiteMariadbHelper): Reader<WriteCounter> =>
	() =>
		helper.suiteUserWrites();
const contactsOf =
	(helper: SuiteMariadbHelper): Reader<'contacts'> =>
	async () => ({ contacts: await helper.suiteUserContacts() });

/** Did a one-file run run cleanly (≥1 case, none skipped, none failed)? */
function ranCleanly(run: ParityRun | null): boolean {
	const counts = run === null ? undefined : Object.values(run.perFile)[0];
	return (
		run !== null &&
		counts !== undefined &&
		counts.tests > 0 &&
		counts.skipped === 0 &&
		run.cases.every((c) => c.status !== 'fail')
	);
}

/** Plant, run and remove one calibration file, measured by `read`. */
async function calibrate<K extends string>(
	helper: SuiteMariadbHelper,
	runner: (files: string[]) => ParityRun,
	variant: CalibrationVariant,
	read: Reader<K>,
	what: string,
	log: NonNullable<MariadbTierOptions['log']>,
): Promise<{ ran: boolean; deltas: Record<K, number> | null; faults: string[] }> {
	const dir = join(helper.suiteMariadbPaths().root, 'calibration');
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `tier_${variant.replace(/-/g, '_')}.test.ts`);
	writeFileSync(
		file,
		calibrationSource(variant, {
			helper: join(REPO_ROOT, SUITE_MARIADB_HELPER),
			db: join(REPO_ROOT, MARIADB_POOL_MODULE),
		}),
	);
	try {
		const { run, deltas, faults } = await measured(
			read,
			runner,
			[file],
			`calibration (${variant})`,
			what,
		);
		const ran = ranCleanly(run);
		if (!ran && run?.stderrTail)
			log.err(`--- ${variant} calibration stderr ---\n${run.stderrTail}`);
		return { ran, deltas, faults };
	} finally {
		rmSync(file, { force: true });
	}
}

/** Fold per-file runs into one (cases, per-file counts, totals). */
function mergeRuns(runs: readonly ParityRun[]): ParityRun {
	const merged: ParityRun = {
		cases: [],
		files: [],
		totals: { tests: 0, pass: 0, fail: 0, skip: 0 },
		perFile: {},
	};
	for (const run of runs) {
		merged.cases.push(...run.cases);
		merged.files.push(...run.files);
		Object.assign(merged.perFile, run.perFile);
		for (const key of ['tests', 'pass', 'fail', 'skip'] as const)
			merged.totals[key] += run.totals[key];
	}
	return merged;
}

/** The stage. Every input is injectable so the whole of it is held by planted controls. */
export async function runMariadbTier(options: MariadbTierOptions = {}): Promise<MariadbTierResult> {
	const runner = options.runner ?? runTier;
	const log = options.log ?? {
		out: (line: string) => console.log(line),
		err: (line: string) => console.error(line),
	};
	const red = (faults: string[]): MariadbTierResult => {
		for (const fault of faults) log.err(`== mariadb_tier: ${fault}`);
		log.err(`== mariadb_tier: RED — ${faults.length} fault(s)`);
		return { code: 1, faults };
	};

	let setFaults: string[];
	let set: MariadbTierSet;
	try {
		({ set, faults: setFaults } = mariadbTierSet(options.listing ?? realListing()));
	} catch (error) {
		return red([`the set could not be derived: ${String(error).split('\n')[0]}`]);
	}

	let helper: SuiteMariadbHelper;
	try {
		helper =
			options.helper ??
			((await import(join(REPO_ROOT, SUITE_MARIADB_HELPER))) as SuiteMariadbHelper);
		await helper.ensureSuiteMariadb();
	} catch (error) {
		return red([
			...setFaults,
			`REFUSING to run the set: the suite MariaDB target is not available (${String(error).split('\n')[0]}). No file ran, so nothing reached any other server.`,
		]);
	}

	// Calibrate both measures first (and outside the ledger slices below).
	const writes = writesOf(helper);
	const contacts = contactsOf(helper);
	const acquireOnly = await calibrate(
		helper,
		runner,
		'acquire-only',
		writes,
		'the write measure',
		log,
	);
	const writeOne = await calibrate(
		helper,
		runner,
		'write-one-row',
		writes,
		'the write measure',
		log,
	);
	const idleContact = await calibrate(
		helper,
		runner,
		'no-contact',
		contacts,
		'the contact measure',
		log,
	);
	const oneContact = await calibrate(
		helper,
		runner,
		'one-contact',
		contacts,
		'the contact measure',
		log,
	);
	const calibration = [
		...acquireOnly.faults,
		...writeOne.faults,
		...calibrationFaults(
			{ ran: acquireOnly.ran, deltas: acquireOnly.deltas ?? NAN_DELTAS() },
			{ ran: writeOne.ran, deltas: writeOne.deltas ?? NAN_DELTAS() },
		),
		...idleContact.faults,
		...oneContact.faults,
		...contactCalibrationFaults(
			{ ran: idleContact.ran, contacts: idleContact.deltas?.contacts ?? Number.NaN },
			{ ran: oneContact.ran, contacts: oneContact.deltas?.contacts ?? Number.NaN },
		),
	];
	const show = (d: WriteDeltas | null) =>
		WRITE_COUNTERS.map((c) => `${c}=${d?.[c] ?? Number.NaN}`).join(' ');
	log.out(
		`== mariadb_tier: calibration — acquire-only Δ ${show(acquireOnly.deltas)} · write-one-row Δ ${show(writeOne.deltas)} · contacts: no-contact Δ ${idleContact.deltas?.contacts ?? Number.NaN} · one-contact Δ ${oneContact.deltas?.contacts ?? Number.NaN}`,
	);

	const ledgerPath = helper.suiteMariadbPaths().acquisitions;
	const ledgerLines = (): string[] =>
		existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n') : [];
	const ledgerStart = ledgerLines().length;

	// ONE FILE PER RUN: each file's row deltas are its own (leg 4).
	const runs: ParityRun[] = [];
	const deltas = new Map<string, WriteDeltas>();
	const runFaults: string[] = [];
	for (const file of set.files) {
		const one = await measured(writes, runner, [file], file);
		runFaults.push(...one.faults);
		if (one.run !== null) {
			runs.push(one.run);
			const counts = one.run.perFile[file];
			if (
				one.run.stderrTail &&
				(counts === undefined ||
					counts.skipped > 0 ||
					one.run.cases.some((c) => c.status === 'fail'))
			)
				log.err(`--- ${file}: bun stderr tail ---\n${one.run.stderrTail}`);
		}
		if (one.deltas !== null) {
			deltas.set(file, one.deltas);
			log.out(`== mariadb_tier: ${file} · suite user Δ ${show(one.deltas)}`);
		}
	}
	const run = mergeRuns(runs);
	const ledger = parseLedger(ledgerLines().join('\n'), Math.max(0, ledgerStart - 1));

	// LEG 1b: the no-contact population, ONE armed batch (contacts are monotonic, so a
	// zero batch proves every file zero); a non-zero batch is attributed file by file.
	const populationStart = ledgerLines().length;
	const population = await measured(
		contacts,
		runner,
		set.noContact,
		'no-contact population',
		'the contact measure',
	);
	const perFileContacts = new Map<string, number>();
	const batchContacts = population.deltas?.contacts ?? null;
	if (batchContacts !== null && batchContacts !== 0)
		for (const file of set.noContact) {
			const one = await measured(contacts, runner, [file], file, 'the contact measure');
			runFaults.push(...one.faults);
			if (one.deltas !== null) perFileContacts.set(file, one.deltas.contacts);
		}
	const populationLedger = parseLedger(ledgerLines().join('\n'), Math.max(0, populationStart - 1));
	log.out(
		`== mariadb_tier: no-contact population — ${set.noContact.length} files · ${population.run?.totals.tests ?? 0} cases · suite user contacts Δ ${batchContacts ?? Number.NaN}`,
	);
	// REPORTED, not judged: a PARTIAL skip in the population (a skipped leg could be the
	// one that reaches the pool). Its skip count is the unit / parity tier's floor to hold.
	const partial = set.noContact.filter((file) => {
		const counts = population.run?.perFile[file];
		return counts !== undefined && counts.skipped > 0 && counts.skipped < counts.tests;
	});
	if (partial.length > 0)
		log.out(
			`== mariadb_tier: no-contact population files with SKIPPED cases (their contact is unmeasured for those legs): ${partial.map((file) => `${file} (${population.run?.perFile[file]?.skipped}/${population.run?.perFile[file]?.tests})`).join(', ')}`,
		);

	const faults = [
		...setFaults,
		...calibration,
		...runFaults,
		...mariadbTierFaults(run, ledger, deltas, set),
		...population.faults,
		...noContactFaults(
			{
				run: population.run,
				contacts: batchContacts,
				perFile: perFileContacts,
				acquired: populationLedger.map((row) => row.file),
			},
			set,
		),
	];

	log.out(
		`== mariadb_tier: ${set.files.length} files · ${run.totals.tests} cases · ${ledger.length} acquisitions`,
	);
	if (faults.length === 0) {
		log.out('== mariadb_tier: GREEN');
		return { code: 0, faults };
	}
	return red(faults);
}

if (import.meta.main) process.exit((await runMariadbTier()).code);
