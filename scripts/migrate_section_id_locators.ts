/**
 * ============================================================================
 * SECTION_ID → INT LOCATOR MIGRATION (v7 repair driver)
 * WC-2026-08-10-section-id-int-canonical — plan P3b
 * ============================================================================
 *
 * Converts every locator-carried `section_id` / `section_id_key` /
 * `parent_section_id` stored as a CONVERTIBLE STRING inside the jsonb columns
 * into the canonical INT form. This is the repair path for installs ALREADY on
 * v7 (migrated before the v6 widget step existed — e.g. the reference dev DB
 * with ~33M string-form addresses). New v6→v7 migrations get the same rewrite
 * from `close_v6_prepare_v7`'s `intify_section_id_locators` step; the two
 * implementations share ONE conversion rule, pinned by the vector file
 * test/unit/fixtures/section_id_conversion_vectors.json on both runtimes.
 *
 * WHAT IS NEVER CAST (kernel: src/core/update/transform/section_id_intify.ts):
 *   - external-service locators (D15: the external tipo set is resolved and
 *     validated BEFORE any write; a malformed api_config aborts pre-write with
 *     the tipo named) — zenon '001338683' zero-padded, wikidata 'Q42';
 *   - leading-zero / out-of-range numeric strings (integrity findings);
 *   - junk ('', 'null', tokens) — REPORTED with identities; deletable only via
 *     the operator-adjudicated --purge-class flag (D17), dry-run first.
 *
 * SAFETY MODEL (the geolocation-repair template):
 *   - --user MANDATORY (attribution of the marker row; no default actor).
 *   - DRY-RUN IS THE DEFAULT; --apply writes. --table <name> or --all.
 *   - Per-row transaction; the row is RE-READ UNDER `FOR UPDATE` and the
 *     kernel re-applied to the locked value (the scan verdict is a plan, not
 *     an authority — TOCTOU closed). 0-affected on a claimed change = ABORT.
 *   - NO dd197/dd201 modified stamps (a mechanical sweep is not an edit) and
 *     NO per-row Time Machine rows (a semantic no-op over millions of rows
 *     would bury the real curation history — D13; recovery = the mandatory
 *     fresh backup + the matrix_updates marker + the WC entry). The backup is
 *     CHECKED before an apply (withApplyPreconditions; --waive-backup logs).
 *   - matrix_time_machine.data IS swept (D6 — a TM restore must not re-inject
 *     strings); --skip-tm exists ONLY for partial reruns and is refused
 *     together with --all.
 *   - POST-VERIFY (apply runs): the discovery re-runs — any remaining
 *     convertible value is a RED gate (exit 1); the relation-index store is
 *     re-backfilled (SEARCH_STORE_BACKFILLS twin of the sync trigger) so the
 *     derived index reflects the int form.
 *   - On green --all apply: the `section_id_int_normalize` marker row is
 *     written to matrix_updates (the contraction release's boot evidence; both
 *     version readers are guarded with `data ? 'dedalo_version'`).
 *
 * USAGE:
 *     bun scripts/migrate_section_id_locators.ts --all --user 1               # dry-run
 *     bun scripts/migrate_section_id_locators.ts --table matrix --user 1      # dry-run, one table
 *     bun scripts/migrate_section_id_locators.ts --all --user 1 --apply   # needs a fresh backup
 *     bun scripts/migrate_section_id_locators.ts --all --user 1 --apply --purge-class=empty,null-literal
 */

// Side-effect: registers the component-model lookup the ontology resolver
// requires (standalone scripts must do what the server entrypoint does).
import '../src/core/components/registry.ts';
import { backfillSearchStores } from '../src/core/db/db_assets.ts';
import { encodeForJsonb } from '../src/core/db/json_codec.ts';
import { MATRIX_JSONB_COLUMNS, MATRIX_TABLE_ALLOWLIST } from '../src/core/db/matrix.ts';
import { appendMatrixUpdateRow } from '../src/core/db/matrix_write.ts';
import { sql, withTransaction } from '../src/core/db/postgres.ts';
import {
	type IntifyFinding,
	intifySectionIdsInValue,
} from '../src/core/update/transform/section_id_intify.ts';

/** Address keys whose string form the LIKE prefilter detects. */
const PREFILTER_KEYS = ['section_id', 'section_id_key', 'parent_section_id'] as const;

/**
 * The sweep surfaces beyond the standard matrix tables. dd_ontology.relations
 * measured ZERO string addresses on the reference DB (census P0) but the
 * writer minted them until this change — swept for foreign installs.
 * dd_ontology.properties / matrix_structurations / matrix_notifications /
 * matrix_updates are NAMED EXEMPTIONS (census-measured zero or config-DSL) —
 * the WC entry carries the measured lines.
 */
const EXTRA_SURFACES: readonly { table: string; columns: readonly string[]; pk: string }[] = [
	{ table: 'matrix_time_machine', columns: ['data'], pk: 'id' },
	{ table: 'dd_ontology', columns: ['relations'], pk: 'tipo' },
];

interface Args {
	apply: boolean;
	/** --waive-backup: proceed without a fresh verified backup (logged with the user). */
	waiveBackup: boolean;
	userId: number;
	tables: string[] | 'all';
	purgeClasses: Set<string>;
	skipTm: boolean;
}

/** D17: the only classes the operator may purge — junk, never data. */
const PURGEABLE_CLASSES = new Set(['empty', 'null-literal']);

function usage(message: string): never {
	console.error(`migrate_section_id_locators: ${message}`);
	console.error(
		'usage: bun scripts/migrate_section_id_locators.ts (--all | --table <name>) --user <id> [--apply [--waive-backup]] [--purge-class=empty,null-literal] [--skip-tm]',
	);
	process.exit(1);
}

export function parseArgs(argv: string[]): Args {
	let apply = false;
	let waiveBackup = false;
	let userId: number | null = null;
	let all = false;
	const tables: string[] = [];
	const purgeClasses = new Set<string>();
	let skipTm = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] as string;
		if (arg === '--apply') apply = true;
		else if (arg === '--waive-backup') waiveBackup = true;
		else if (arg === '--all') all = true;
		else if (arg === '--skip-tm') skipTm = true;
		else if (arg === '--user') {
			const value = Number(argv[++index]);
			if (!Number.isInteger(value) || value <= 0) usage('--user must be a positive integer');
			userId = value;
		} else if (arg === '--table') {
			const value = argv[++index] ?? usage('--table needs a table name');
			const known =
				MATRIX_TABLE_ALLOWLIST.includes(value) ||
				EXTRA_SURFACES.some((surface) => surface.table === value);
			if (!known) usage(`table '${value}' is not in the sweep set`);
			tables.push(value);
		} else if (arg.startsWith('--purge-class=')) {
			for (const cls of arg.slice('--purge-class='.length).split(',')) {
				if (!PURGEABLE_CLASSES.has(cls)) {
					usage(
						`'${cls}' is not a purgeable class (only: ${[...PURGEABLE_CLASSES].join(', ')}) — ` +
							'tokens/leading-zero/out-of-range are integrity findings a human adjudicates in place',
					);
				}
				purgeClasses.add(cls);
			}
		} else usage(`unknown argument '${arg}'`);
	}
	if (userId === null) usage('--user is mandatory (the marker row is attributed, never guessed)');
	if (!all && tables.length === 0) usage('scope is mandatory: --all or --table <name>');
	if (all && skipTm) {
		usage(
			'--skip-tm with --all is refused: the TM sweep is mandatory on a full run (D6) — ' +
				'--skip-tm exists only for partial --table reruns',
		);
	}
	return { apply, waiveBackup, userId, tables: all ? 'all' : tables, purgeClasses, skipTm };
}

/**
 * D15 PREFLIGHT: resolve the COMPLETE external-service tipo set before any
 * write (the ONE externality predicate, `isExternalReferenceSection`: an
 * api_config AND an owned component_external — rsc205-style residue is LOCAL,
 * so its junk is classed and purgeable). The predicate throws on malformed
 * api_config — here that is
 * an ABORT with the tipo named (the operator fixes the ontology first; a
 * sweep must not run with an unclassifiable externality set).
 */
async function resolveExternalTipos(): Promise<Set<string>> {
	const { listExternalSectionTipos } = await import(
		'../src/core/update/transform/section_id_restore.ts'
	);
	try {
		return await listExternalSectionTipos();
	} catch (error) {
		console.error(`ABORT (pre-write): ${(error as Error).message}`);
		process.exit(1);
	}
}

export interface SurfaceStats {
	scanned: number;
	changedRows: number;
	converted: number;
	purged: number;
	findingsByClass: Map<string, { count: number; samples: string[] }>;
}

function tallyFindings(stats: SurfaceStats, findings: IntifyFinding[], identity: string): void {
	for (const finding of findings) {
		const bucket = stats.findingsByClass.get(finding.class) ?? { count: 0, samples: [] };
		bucket.count++;
		if (bucket.samples.length < 25) {
			bucket.samples.push(
				`${identity} tipo=${finding.sectionTipo ?? '?'} ${finding.key}=${JSON.stringify(finding.value)}`,
			);
		}
		stats.findingsByClass.set(finding.class, bucket);
	}
}

/**
 * Sweep ONE table.column. Discovery batches on a keyset over the pk with the
 * LIKE prefilter; each candidate row is then handled inside its own
 * transaction with a `FOR UPDATE` re-read (the batch's payload is only used to
 * DECIDE candidacy — the kernel runs on the locked value).
 */
export async function sweepSurface(
	table: string,
	column: string,
	pk: string,
	ctx: { externalTipos: Set<string>; purgeClasses?: Set<string> },
	apply: boolean,
	stats: SurfaceStats,
	/**
	 * Restrict to one section_tipo. Used by the apply gate (scratch tipo only —
	 * a whole-column sweep would rewrite sibling tests' rows) and usable for
	 * surgical per-tipo reruns. Identifier-validated, then inlined (the keyset
	 * param indexes must stay stable).
	 */
	scope?: { sectionTipo: string },
): Promise<void> {
	// (!) jsonb::text renders `"key": "value"` WITH a space after the colon, so
	// a naive LIKE '%"section_id":"%' never matches. Cheap LIKE on the bare key
	// first (bails out of locator-less rows), then a regex anchored to a
	// STRING-typed value (`":\s*"`) for exactness.
	const like = `(${PREFILTER_KEYS.map((key) => `"${column}"::text LIKE '%"${key}"%'`).join(' OR ')})
		AND "${column}"::text ~ '"(${PREFILTER_KEYS.join('|')})":\\s*"'`;
	let scopeClause = '';
	if (scope !== undefined) {
		if (!/^[a-z0-9_]+$/.test(scope.sectionTipo)) {
			throw new Error(`sweepSurface: invalid scope tipo '${scope.sectionTipo}'`);
		}
		scopeClause = ` AND "section_tipo" = '${scope.sectionTipo}'`;
	}
	let lastPk: string | number | null = null;
	for (;;) {
		const where = lastPk === null ? 'TRUE' : `"${pk}" > $1`;
		const params = lastPk === null ? [] : [lastPk];
		const rows = (await sql.unsafe(
			`SELECT "${pk}" AS pk, "${column}"::text AS payload
			 FROM "${table}"
			 WHERE "${column}" IS NOT NULL AND ${where} AND (${like})${scopeClause}
			 ORDER BY "${pk}" ASC LIMIT 500`,
			params,
		)) as unknown as { pk: string | number; payload: string }[];
		if (rows.length === 0) return;

		for (const row of rows) {
			lastPk = row.pk;
			stats.scanned++;

			// Cheap candidacy check on the batch payload (no lock yet).
			let parsed: unknown;
			try {
				parsed = JSON.parse(row.payload);
			} catch {
				console.log(`  note: ${table}.${column} ${pk}=${row.pk}: unparseable jsonb text`);
				continue;
			}
			const plan = intifySectionIdsInValue(parsed, ctx);
			tallyFindings(stats, plan.findings, `${table}.${column} ${pk}=${row.pk}`);
			if (!plan.changed) continue;

			if (!apply) {
				stats.changedRows++;
				stats.converted += plan.converted;
				stats.purged += plan.purged;
				continue;
			}

			// APPLY: re-read under FOR UPDATE, re-run the kernel on the locked
			// value, write that — never the scanned one (TOCTOU closed).
			await withTransaction(async () => {
				const locked = (await sql.unsafe(
					`SELECT "${column}"::text AS payload FROM "${table}" WHERE "${pk}" = $1 FOR UPDATE`,
					[row.pk],
				)) as unknown as { payload: string | null }[];
				const lockedPayload = locked[0]?.payload;
				if (lockedPayload === undefined || lockedPayload === null) return; // row vanished/emptied — nothing to convert
				const value = JSON.parse(lockedPayload);
				const outcome = intifySectionIdsInValue(value, ctx);
				if (!outcome.changed) return; // changed under us to a clean state
				const affected = (await sql.unsafe(
					`UPDATE "${table}" SET "${column}" = $1::text::jsonb WHERE "${pk}" = $2 RETURNING 1 AS one`,
					[encodeForJsonb(value), row.pk],
				)) as unknown as unknown[];
				if (affected.length === 0) {
					throw new Error(
						`migrate_section_id_locators: 0 rows affected on ${table}.${column} ${pk}=${row.pk} — record vanished mid-run; ABORTING`,
					);
				}
				stats.changedRows++;
				stats.converted += outcome.converted;
				stats.purged += outcome.purged;
			});
		}
	}
}

/**
 * THE APPLY PRECONDITIONS (update audit 2026-10-29, U-49): the recovery model
 * above IS the backup, so an apply proves one — the shared freshness verdict
 * (core/update/preconditions.ts), or `--waive-backup`, logged with the user —
 * and runs holding the UPDATE_RUN lock (core/update/door_class.ts), so no update
 * run or destructive maintenance door starts beside it. A dry run needs neither.
 */
export async function withApplyPreconditions<T>(
	args: Pick<Args, 'apply' | 'waiveBackup' | 'userId'>,
	body: () => Promise<T>,
	deps: {
		requireBackup?: () => Promise<void>;
		acquire?: () => Promise<{ release: () => Promise<void> } | null>;
		/** The update-run journals (default: the install's) — an in-flight run refuses (#9). */
		runsRoot?: string;
	} = {},
): Promise<T> {
	if (!args.apply) return body();
	if (args.waiveBackup) {
		console.warn(`(!) database backup WAIVED by user ${args.userId} (--waive-backup)`);
	} else {
		const { requireFreshBackup } = await import('../src/core/update/preconditions.ts');
		await (deps.requireBackup ?? (() => requireFreshBackup()))();
	}
	const { holdUpdateRunLock } = await import('../src/core/update/door_class.ts');
	return holdUpdateRunLock('migrate_section_id_locators', body, deps.acquire, deps.runsRoot);
}

/**
 * THE CLI ENTRY (review 2026-10-30 #5): parse, then route the run body THROUGH
 * withApplyPreconditions — the ONE wiring the import.meta.main path uses, so a
 * gate drives this function (not the helper) and a `return run(args)` regression
 * reds. `deps.run` replaces the body (a seam for the gate); the precondition
 * seams pass straight through.
 */
export async function cliMain(
	argv: string[],
	deps: Parameters<typeof withApplyPreconditions>[2] & {
		run?: (args: Args) => Promise<number>;
	} = {},
): Promise<number> {
	const { run: body = run, ...preconditionDeps } = deps;
	const args = parseArgs(argv);
	return withApplyPreconditions(args, () => body(args), preconditionDeps);
}

async function run(args: Args): Promise<number> {
	console.log(
		`migrate_section_id_locators — mode ${args.apply ? 'APPLY' : 'DRY-RUN'}, user ${args.userId}` +
			`${args.purgeClasses.size > 0 ? `, purge=[${[...args.purgeClasses].join(',')}]` : ''}`,
	);

	// D15 preflight — abort pre-write on malformed externality config.
	const externalTipos = await resolveExternalTipos();
	console.log(
		`external tipos (never cast): ${externalTipos.size > 0 ? [...externalTipos].join(', ') : '(none)'}`,
	);

	// Build the surface worklist.
	const surfaces: { table: string; column: string; pk: string }[] = [];
	const wantTable = (table: string): boolean =>
		args.tables === 'all' || args.tables.includes(table);
	for (const table of MATRIX_TABLE_ALLOWLIST) {
		if (!wantTable(table)) continue;
		for (const column of MATRIX_JSONB_COLUMNS) surfaces.push({ table, column, pk: 'id' });
	}
	for (const surface of EXTRA_SURFACES) {
		if (!wantTable(surface.table)) continue;
		if (surface.table === 'matrix_time_machine' && args.skipTm) {
			console.log('(!) --skip-tm: matrix_time_machine excluded from THIS partial rerun');
			continue;
		}
		for (const column of surface.columns) {
			surfaces.push({ table: surface.table, column, pk: surface.pk });
		}
	}

	const ctx = {
		externalTipos,
		purgeClasses: args.purgeClasses.size > 0 ? args.purgeClasses : undefined,
	};
	const stats: SurfaceStats = {
		scanned: 0,
		changedRows: 0,
		converted: 0,
		purged: 0,
		findingsByClass: new Map(),
	};

	for (const surface of surfaces) {
		// absent tables/columns (partial installs) are skipped silently — the
		// surface list is the closed worklist, presence is per-install.
		const exists = (await sql.unsafe(
			`SELECT 1 AS one FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
			[surface.table, surface.column],
		)) as unknown as unknown[];
		if (exists.length === 0) continue;
		const before = stats.changedRows;
		await sweepSurface(surface.table, surface.column, surface.pk, ctx, args.apply, stats);
		if (stats.changedRows > before) {
			console.log(
				`  ${surface.table}.${surface.column}: ${stats.changedRows - before} row(s) ${args.apply ? 'rewritten' : 'would change'}`,
			);
		}
	}

	console.log(
		`\n${args.apply ? 'APPLIED' : 'DRY-RUN'}: ${stats.changedRows} row(s), ${stats.converted} conversion(s), ${stats.purged} purged element(s), ${stats.scanned} candidate row(s) scanned`,
	);
	console.log('\nFINDINGS (never cast; identities sampled):');
	if (stats.findingsByClass.size === 0) console.log('  (none)');
	for (const [cls, bucket] of [...stats.findingsByClass].sort((a, b) => b[1].count - a[1].count)) {
		console.log(`  ${cls}: ${bucket.count}`);
		for (const sample of bucket.samples.slice(0, 8)) console.log(`     ${sample}`);
	}

	if (!args.apply) {
		console.log('\nDry-run complete. Re-run with --apply after reviewing the findings.');
		return 0;
	}

	// ---- POST-VERIFY (the gate) ---------------------------------------------
	// 1. An INDEPENDENT census-style count must find ZERO convertible values.
	//    Deliberately NOT the sweep's own discovery: the sweep's LIKE/regex
	//    prefilter is shared code — a prefilter bug would make the sweep a
	//    silent no-op AND its own verify green (this exact failure mode was
	//    caught in development). jsonb_path_query descends server-side with no
	//    shared text-matching at all.
	let residue = 0;
	for (const surface of surfaces) {
		const exists = (await sql.unsafe(
			`SELECT 1 AS one FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
			[surface.table, surface.column],
		)) as unknown as unknown[];
		if (exists.length === 0) continue;
		for (const key of PREFILTER_KEYS) {
			// No external exclusion here: convertible strings convert on ANY tipo
			// (true remote ids are never convertible), so EVERY remaining
			// convertible value is residue. The paired-tipo requirement mirrors
			// the kernel's LOCATOR LAW: a tipo-less section_id (user JSON inside
			// component_json) is not a locator and is neither swept nor residue.
			const tipoField = key === 'section_id_key' ? 'section_tipo_key' : 'section_tipo';
			const counted = (await sql.unsafe(
				`SELECT count(*)::bigint AS residue
				 FROM "${surface.table}" t,
				 LATERAL jsonb_path_query(t."${surface.column}", 'strict $.** ? (exists (@."${key}"))') AS obj
				 WHERE t."${surface.column}" IS NOT NULL
				   AND obj ? '${tipoField}'
				   AND jsonb_typeof(obj->'${key}') = 'string'
				   AND obj->>'${key}' ~ '^(-?[1-9][0-9]*|0)$'
				   AND length(ltrim(obj->>'${key}', '-')) <= 15`,
			)) as unknown as { residue: string | number }[];
			residue += Number(counted[0]?.residue ?? 0);
		}
	}
	const residueGreen = residue === 0;
	console.log(
		`\npost-verify (independent jsonb_path census): ${residue} convertible value(s) remaining (want 0) — ${residueGreen ? 'GREEN' : 'RED'}`,
	);

	// 2. Re-backfill the derived relation index from the (now int-form) locators.
	let indexGreen = true;
	if (args.tables === 'all') {
		const backfill = await backfillSearchStores(['matrix_relation_index']);
		indexGreen = backfill.ok;
		console.log(`relation-index re-backfill: ${backfill.ok ? 'OK' : `FAILED — ${backfill.msg}`}`);
	}

	if (!residueGreen || !indexGreen) return 1;

	// 3. Marker row — full-run green only (the contraction boot evidence).
	if (args.tables === 'all') {
		const findingsSummary = Object.fromEntries(
			[...stats.findingsByClass].map(([cls, bucket]) => [cls, bucket.count]),
		);
		await appendMatrixUpdateRow({
			section_id_int_normalize: {
				date: new Date().toISOString().slice(0, 19).replace('T', ' '),
				converted: stats.converted,
				changed_rows: stats.changedRows,
				purged: stats.purged,
				findings: findingsSummary,
				origin: 'migrate_section_id_locators',
				user_id: args.userId,
			},
		});
		console.log('marker row written to matrix_updates (section_id_int_normalize).');
	} else {
		console.log('(partial --table run: marker row NOT written — full --all run required)');
	}
	return 0;
}

if (import.meta.main) {
	process.exit(await cliMain(process.argv.slice(2)));
}
