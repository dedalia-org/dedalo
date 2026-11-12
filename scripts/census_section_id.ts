/**
 * ============================================================================
 * SECTION_ID CENSUS — read-only measurement pass of the int-unification plan
 * ============================================================================
 *
 * Counts, per table × JSONB column × key, every `section_id`-shaped value
 * stored inside JSONB (any nesting depth), classified into the D17 finding
 * classes of the section_id → int program:
 *
 *   int             jsonb number, integral                    → already canonical
 *   float           jsonb number, non-integral                → integrity finding
 *   str-numeric     string, strict numeric, no leading zero,
 *                   safe-int range                            → CONVERTIBLE (the sweep's target)
 *   str-leading-zero string like "001338683"                  → external-shaped, NEVER cast
 *   str-out-of-range numeric string beyond 2^53               → integrity finding, never cast
 *   str-empty       ""                                        → junk class (operator adjudicates)
 *   str-null        "null"                                    → junk class
 *   str-token       any other non-numeric string ("tmp", "Q42",
 *                   "search_1", diffusion markers…)           → reported verbatim, never cast
 *   other           jsonb null / bool / object / array        → integrity finding
 *
 * The keys censused are the record-address fields of the locator shape:
 * `section_id`, plus the legacy dataframe pairing key `section_id_key` and the
 * tree field `parent_section_id`.
 *
 * SCOPE — nothing silent (plan P0):
 *   - all 24 MATRIX_TABLE_ALLOWLIST tables × 11 MATRIX_JSONB_COLUMNS
 *   - matrix_time_machine.data   (the TM snapshots the sweep MUST cover, D6)
 *   - dd_ontology.relations      (record-address locators; swept per plan)
 *   - dd_ontology.properties     (named exemption candidate — measured anyway)
 *   - matrix_notifications.data, matrix_updates.data (census decides sweep/exempt)
 *   - matrix_structurations.datos (legacy v6 archival payload — measured, exempt)
 *
 * The leading-zero population is cross-checked against section_tipo: the plan's
 * conversion rule is only sound if leading-zero ids live exclusively on
 * external-service tipos (zenon…). Any leading-zero id on a NON-external tipo
 * is printed loudly as an integrity finding.
 *
 * UNBOUNDED: the run is long work by design (whole tables, every JSONB column),
 * so it runs in `withUnboundedStatements` (the maintenance lane, no statement
 * ceiling) — no `DB_STATEMENT_TIMEOUT_MS=0` needed. Gate:
 * test/unit/statement_ceiling_operator_scans_native.test.ts.
 *
 * READ-ONLY BY CONSTRUCTION: every statement is a SELECT. The recursive
 * descent runs server-side (jsonb_path_query, lax `$.**`), aggregated per
 * class before transfer, so millions of locators never cross the wire.
 *
 * USAGE:
 *     bun scripts/census_section_id.ts             # full census, summary + findings
 *     bun scripts/census_section_id.ts --json out.json   # also dump the raw rows
 */

// Side-effect: registers the component-model lookup the ontology resolver
// requires (standalone scripts must do what the server entrypoint does).
import '../src/core/components/registry.ts';
import { MATRIX_JSONB_COLUMNS, MATRIX_TABLE_ALLOWLIST } from '../src/core/db/matrix.ts';
import { sql, withUnboundedStatements } from '../src/core/db/postgres.ts';

/** The locator record-address keys under census. */
const ADDRESS_KEYS = ['section_id', 'section_id_key', 'parent_section_id'] as const;

/**
 * Non-allowlist surfaces the plan requires measured lines for. Each entry is
 * (table, column); absence of the table on an install is reported, not fatal.
 */
const EXTRA_SURFACES: readonly { table: string; column: string }[] = [
	{ table: 'matrix_time_machine', column: 'data' },
	{ table: 'dd_ontology', column: 'relations' },
	{ table: 'dd_ontology', column: 'properties' },
	{ table: 'matrix_notifications', column: 'data' },
	{ table: 'matrix_updates', column: 'data' },
	{ table: 'matrix_structurations', column: 'datos' },
];

/** D17 class ids, in report order. */
const CLASSES = [
	'int',
	'float',
	'str-numeric',
	'str-leading-zero',
	'str-out-of-range',
	'str-empty',
	'str-null',
	'str-token',
	'other',
] as const;
type ClassId = (typeof CLASSES)[number];

interface CensusRow {
	table: string;
	column: string;
	key: string;
	class: ClassId;
	section_tipo: string | null;
	count: number;
	sample: string | null;
}

/**
 * One census query for one (table, column, key): server-side recursive descent
 * over every JSONB value in the column, classifying each object that carries
 * the key. Aggregated by (class, section_tipo) with one sample value each.
 *
 * The class expression mirrors the sweep's conversion rule EXACTLY:
 * convertible = strict numeric, no leading zero (0 itself is fine, -0 is not),
 * |value| within Number.MAX_SAFE_INTEGER (2^53-1 = 9007199254740991).
 */
function censusQuery(table: string, column: string, key: string): string {
	// Identifiers are interpolated only after allowlist/identity validation in
	// main() — this helper never sees an unvetted name.
	return `
		WITH hits AS (
			SELECT
				jsonb_typeof(obj -> '${key}')  AS jtype,
				obj ->> '${key}'               AS sid,
				obj ->> 'section_tipo'         AS stipo
			FROM "${table}" t,
			LATERAL jsonb_path_query(t."${column}", 'strict $.** ? (exists (@."${key}"))') AS obj
			WHERE t."${column}" IS NOT NULL
			  AND t."${column}"::text LIKE '%"${key}"%'
		),
		classed AS (
			SELECT
				CASE
					WHEN jtype = 'number' AND sid ~ '^-?[0-9]+$' THEN 'int'
					WHEN jtype = 'number' THEN 'float'
					WHEN jtype <> 'string' THEN 'other'
					WHEN sid = '' THEN 'str-empty'
					WHEN sid = 'null' THEN 'str-null'
					WHEN sid ~ '^-?0[0-9]+$' OR sid = '-0' THEN 'str-leading-zero'
					WHEN sid ~ '^-?[0-9]+$' AND (length(ltrim(sid, '-')) > 16
						OR abs(sid::numeric) > 9007199254740991) THEN 'str-out-of-range'
					WHEN sid ~ '^(-?[1-9][0-9]*|0)$' THEN 'str-numeric'
					ELSE 'str-token'
				END AS class,
				sid,
				stipo
			FROM hits
		)
		SELECT class, stipo, count(*)::bigint AS count, min(sid) AS sample
		FROM classed
		GROUP BY class, stipo
	`;
}

/** True when the table exists on this install (extra surfaces may be absent). */
async function tableExists(table: string): Promise<boolean> {
	const rows = (await sql.unsafe(
		`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '${table.replace(/'/g, '')}'`,
	)) as unknown as unknown[];
	return rows.length > 0;
}

/** Columns actually present on a table (structurations has 'datos', not 'data'). */
async function tableColumns(table: string): Promise<Set<string>> {
	const rows = (await sql.unsafe(
		`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table.replace(/'/g, '')}'`,
	)) as unknown as { column_name: string }[];
	return new Set(rows.map((row) => row.column_name));
}

export async function main(): Promise<number> {
	// Whole-table `$.**` descents: long work, so the run declares the unbounded
	// scope at its source — on the request lane the statement ceiling
	// (DB_STATEMENT_TIMEOUT_MS, 60 s by default) cancels the first scan of a
	// production-size table (T1-24 review; engineering/PRODUCTION.md §4 census).
	return withUnboundedStatements(runCensus);
}

async function runCensus(): Promise<number> {
	const jsonOut = ((): string | null => {
		const index = process.argv.indexOf('--json');
		return index === -1 ? null : (process.argv[index + 1] ?? null);
	})();

	// Build the (table, column) worklist: allowlist × jsonb columns + extras.
	const surfaces: { table: string; column: string }[] = [];
	for (const table of MATRIX_TABLE_ALLOWLIST) {
		for (const column of MATRIX_JSONB_COLUMNS) {
			surfaces.push({ table, column });
		}
	}
	surfaces.push(...EXTRA_SURFACES);

	const rows: CensusRow[] = [];
	const missingSurfaces: string[] = [];
	const startedAt = Date.now();

	for (const { table, column } of surfaces) {
		if (!(await tableExists(table))) {
			missingSurfaces.push(`${table} (table absent)`);
			continue;
		}
		const columns = await tableColumns(table);
		if (!columns.has(column)) {
			missingSurfaces.push(`${table}.${column} (column absent)`);
			continue;
		}
		for (const key of ADDRESS_KEYS) {
			const result = (await sql.unsafe(censusQuery(table, column, key))) as unknown as {
				class: ClassId;
				stipo: string | null;
				count: string | number;
				sample: string | null;
			}[];
			for (const entry of result) {
				rows.push({
					table,
					column,
					key,
					class: entry.class,
					section_tipo: entry.stipo,
					count: Number(entry.count),
					sample: entry.sample,
				});
			}
		}
		const done = rows.filter((row) => row.table === table && row.column === column);
		if (done.length > 0) {
			const total = done.reduce((sum, row) => sum + row.count, 0);
			console.log(`scanned ${table}.${column}: ${total} address value(s)`);
		}
	}

	// ------------------------------------------------------------------
	// REPORT 1 — per table×column class totals (the sweep's scope table)
	// ------------------------------------------------------------------
	console.log('\n===== CENSUS BY TABLE × COLUMN (all keys) =====');
	console.log(['table.column', ...CLASSES].join('\t'));
	const bySurface = new Map<string, Map<ClassId, number>>();
	for (const row of rows) {
		const key = `${row.table}.${row.column}`;
		const bucket = bySurface.get(key) ?? new Map<ClassId, number>();
		bucket.set(row.class, (bucket.get(row.class) ?? 0) + row.count);
		bySurface.set(key, bucket);
	}
	for (const [surface, bucket] of [...bySurface].sort()) {
		const line = CLASSES.map((cls) => bucket.get(cls) ?? 0);
		if (line.every((count) => count === 0)) continue;
		console.log([surface, ...line].join('\t'));
	}

	// ------------------------------------------------------------------
	// REPORT 2 — grand totals per class and per key
	// ------------------------------------------------------------------
	console.log('\n===== GRAND TOTALS =====');
	for (const cls of CLASSES) {
		const total = rows.filter((row) => row.class === cls).reduce((sum, row) => sum + row.count, 0);
		if (total > 0) console.log(`${cls}: ${total}`);
	}
	for (const key of ADDRESS_KEYS) {
		const total = rows.filter((row) => row.key === key).reduce((sum, row) => sum + row.count, 0);
		console.log(`key ${key}: ${total}`);
	}

	// ------------------------------------------------------------------
	// REPORT 3 — leading-zero ids by section_tipo (external verification)
	// ------------------------------------------------------------------
	console.log('\n===== LEADING-ZERO IDS BY SECTION_TIPO (must be external tipos only) =====');
	const leadingZero = rows.filter((row) => row.class === 'str-leading-zero');
	if (leadingZero.length === 0) console.log('(none)');
	for (const row of leadingZero) {
		console.log(
			`${row.table}.${row.column} ${row.key} tipo=${row.section_tipo ?? '(no section_tipo on object)'}: ${row.count} (sample ${row.sample})`,
		);
	}

	// ------------------------------------------------------------------
	// REPORT 4 — junk + token classes, verbatim (the D17 adjudication input)
	// ------------------------------------------------------------------
	console.log('\n===== NON-CONVERTIBLE FINDINGS (never cast; operator adjudicates) =====');
	const findings = rows.filter((row) =>
		['str-empty', 'str-null', 'str-token', 'str-out-of-range', 'float', 'other'].includes(
			row.class,
		),
	);
	if (findings.length === 0) console.log('(none)');
	for (const row of findings.sort((a, b) => b.count - a.count)) {
		console.log(
			`${row.class} ${row.table}.${row.column} ${row.key} tipo=${row.section_tipo ?? '?'}: ${row.count} (sample ${JSON.stringify(row.sample)})`,
		);
	}

	// ------------------------------------------------------------------
	// REPORT 5 — the sweep's convertible workload
	// ------------------------------------------------------------------
	console.log('\n===== CONVERTIBLE (str-numeric) BY SURFACE =====');
	const convertible = rows.filter((row) => row.class === 'str-numeric');
	const convertibleBySurface = new Map<string, number>();
	for (const row of convertible) {
		const key = `${row.table}.${row.column}`;
		convertibleBySurface.set(key, (convertibleBySurface.get(key) ?? 0) + row.count);
	}
	for (const [surface, count] of [...convertibleBySurface].sort((a, b) => b[1] - a[1])) {
		console.log(`${surface}: ${count}`);
	}
	const convertibleTotal = convertible.reduce((sum, row) => sum + row.count, 0);
	console.log(`TOTAL convertible: ${convertibleTotal}`);

	if (missingSurfaces.length > 0) {
		console.log('\n===== ABSENT SURFACES (reported, not fatal) =====');
		for (const surface of missingSurfaces) console.log(`  ${surface}`);
	}

	if (jsonOut !== null) {
		await Bun.write(jsonOut, JSON.stringify(rows, null, '\t'));
		console.log(`\nraw census rows written to ${jsonOut}`);
	}

	console.log(`\ncensus complete in ${Math.round((Date.now() - startedAt) / 1000)}s`);
	return 0;
}

if (import.meta.main) {
	process.exit(await main());
}
