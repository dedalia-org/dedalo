/**
 * ============================================================================
 * DETECT CSV IMPORT DAMAGE — a STRICTLY READ-ONLY scan for the DATA-04/DATA-09
 * corruption signatures (audit 2026-08-26, remediation P0-5)
 * ============================================================================
 *
 * The parser and the decoder are fixed. This answers the question the fix does
 * NOT: is the damage already in this installation's records? The audit could not
 * answer it — only the suite database was available to it — so the maintainer
 * runs this against the real database, and it is built so that running it is
 * never a risk.
 *
 * WHAT IT LOOKS FOR
 *
 *   A. REPLACEMENT CHARACTERS (DATA-09). Any stored value containing U+FFFD.
 *      Every ingest door decoded uploads as UTF-8 with `fatal:false`, so a
 *      CP1252 file (what Excel writes back over a BOM-less export of ours) had
 *      each accented byte replaced, irreversibly, with a green report.
 *
 *   B. ABSORBED FILE TAIL (DATA-04, the odd-quote case). A `"` anywhere in a
 *      field opened an enclosure that nothing closed, so the delimiter, the row
 *      terminator and the whole remainder of the file were absorbed into ONE
 *      cell. The signature is a SINGLE-LINE literal (the `string` column: input
 *      text and friends) holding an embedded newline — usually with `;` in it
 *      and hundreds of characters long.
 *
 *   C. QUOTE CHARACTERS DELETED (DATA-04, the even-quote case). `Alfonso X "el
 *      Sabio"` parsed with the right row and column count and simply lost its
 *      quotes. There is no trace of that in the value itself — the only witness
 *      is the TIME MACHINE: an import-era version whose previous value differs
 *      from the current one ONLY by its quote characters.
 *
 * WHAT IT CANNOT DETECT — read this before you conclude "we are clean":
 *
 *   - Quote deletion on a record that was CREATED by the import, or imported
 *     without time-machine history: nothing in the database ever held the
 *     quoted form, so no query can recover it. Only the source CSV can.
 *     Signature C sees the UPDATE case with history, and nothing else.
 *   - The records the odd-quote case silently NEVER IMPORTED. Absence leaves no
 *     row. Compare the source file's row count with the run's dd800 report.
 *   - Encoding damage where the replacement already round-tripped through
 *     another edit, or where the mis-decode produced a VALID character rather
 *     than U+FFFD (a Latin-1 → UTF-8 double encoding, e.g. `Ã¨` for `è`, which
 *     is legal text; this scan reports the `Ã©/Ã¨/Â` mojibake shape separately
 *     as a HINT, not as proof).
 *   - Whether a suspicious value came from a CSV import at all. Signature B
 *     flags any single-line literal holding a newline — a paste through the UI
 *     produces the same shape. Every hit is a CANDIDATE for a human to judge.
 *   - Anything outside the standard matrix record tables (MATRIX_TABLE_ALLOWLIST).
 *
 * UNBOUNDED: the scan is long work by design, so it runs in
 * `withUnboundedStatements` (the maintenance lane, no statement ceiling) — no
 * `DB_STATEMENT_TIMEOUT_MS=0` needed. Gate:
 * test/unit/statement_ceiling_operator_scans_native.test.ts.
 *
 * READ-ONLY, AND IT PROVES IT. The scan runs inside one `BEGIN READ ONLY`
 * transaction, and before scanning it VERIFIES the barrier twice: Postgres must
 * report `transaction_read_only = on`, and an attempted write must be REFUSED by
 * the server (error 25006). If either check does not come back as expected the
 * script refuses to scan and exits non-zero — it never trusts its own good
 * intentions. Every statement it runs is printed with its results.
 *
 * USAGE:
 *     bun scripts/detect_csv_import_damage.ts              # scan, summary + samples
 *     bun scripts/detect_csv_import_damage.ts --samples 5  # samples per finding (default 3)
 *     bun scripts/detect_csv_import_damage.ts --queries    # print every query, then scan
 */

// Side-effect: registers the component-model lookup the ontology resolver
// requires (standalone scripts must do what the server entrypoint does).
import '../src/core/components/registry.ts';
import { MATRIX_JSONB_COLUMNS, MATRIX_TABLE_ALLOWLIST } from '../src/core/db/matrix.ts';
import { closeDatabasePool, sql, withUnboundedStatements } from '../src/core/db/postgres.ts';
import { tmEpochPredicate, tmVisiblePredicate } from '../src/core/db/record_generation.ts';

/** A reserved connection with the raw `unsafe` runner the proof needs. */
interface Reserved {
	unsafe: (statement: string, params?: unknown[]) => Promise<unknown>;
	release: () => void;
}

interface Finding {
	signature: 'A-replacement-char' | 'B-absorbed-tail' | 'C-quotes-deleted' | 'D-mojibake-hint';
	table: string;
	section_tipo: string;
	component_tipo: string;
	count: number;
	sample_section_id: number | null;
	sample_value: string | null;
}

const SAMPLE_DEFAULT = 3;

function argValue(flag: string): string | null {
	const index = process.argv.indexOf(flag);
	return index === -1 ? null : (process.argv[index + 1] ?? null);
}

/**
 * PROVE the connection cannot write. Two independent checks, because a setting
 * that merely SAYS read-only and a server that REFUSES the write are different
 * claims, and only the second one is a guarantee.
 */
async function proveReadOnly(reserved: Reserved): Promise<void> {
	await reserved.unsafe('BEGIN READ ONLY');
	const rows = (await reserved.unsafe(
		"SELECT current_setting('transaction_read_only') AS state",
	)) as { state: string }[];
	const state = rows[0]?.state;
	if (state !== 'on') {
		throw new Error(
			`REFUSING TO SCAN: the transaction reports transaction_read_only='${state}', not 'on'. Nothing was read.`,
		);
	}
	// The positive half: the server must REFUSE a write. This statement is
	// expected to fail; it cannot succeed inside a READ ONLY transaction, and if
	// it somehow does we are not where we think we are, so we stop.
	let refused = false;
	try {
		await reserved.unsafe('CREATE TEMP TABLE dedalo_read_only_probe (probe int)');
	} catch (error) {
		refused = true;
		const message = (error as Error).message;
		if (!/read-only|read only|25006/i.test(message)) {
			throw new Error(
				`REFUSING TO SCAN: the write probe failed for an unexpected reason (${message}). Nothing was read.`,
			);
		}
	}
	if (!refused) {
		throw new Error(
			'REFUSING TO SCAN: a write SUCCEEDED on a connection that claims to be read-only. Nothing was read.',
		);
	}
	// The failed probe aborted the transaction; start the scan's own clean one.
	await reserved.unsafe('ROLLBACK');
	await reserved.unsafe('BEGIN READ ONLY');
	const confirm = (await reserved.unsafe(
		"SELECT current_setting('transaction_read_only') AS state",
	)) as { state: string }[];
	if (confirm[0]?.state !== 'on') {
		throw new Error('REFUSING TO SCAN: the scan transaction is not read-only. Nothing was read.');
	}
}

/** Which allowlisted matrix tables this installation actually has. */
async function presentTables(reserved: Reserved): Promise<string[]> {
	const rows = (await reserved.unsafe(
		`SELECT table_name FROM information_schema.tables
		  WHERE table_schema = 'public' AND table_name = ANY(string_to_array($1, ','))`,
		[MATRIX_TABLE_ALLOWLIST.join(',')],
	)) as { table_name: string }[];
	return rows.map((row) => row.table_name).sort();
}

/**
 * SIGNATURE A — U+FFFD anywhere in a record column, grouped by section and by
 * the component key that holds it.
 */
function replacementQuery(table: string, column: string): string {
	return `
		SELECT m.section_tipo,
		       e.key                    AS component_tipo,
		       count(*)                 AS count,
		       min(m.section_id)        AS sample_section_id,
		       left(min(e.value::text), 300) AS sample_value
		  FROM "${table}" m,
		       LATERAL jsonb_each(m."${column}") e(key, value)
		 WHERE m."${column}" IS NOT NULL
		   AND position(U&'\\+00FFFD' IN e.value::text) > 0
		 GROUP BY 1, 2
		 ORDER BY 3 DESC`;
}

/**
 * SIGNATURE D — the OTHER encoding shape: Latin-1 bytes read as UTF-8 and
 * re-encoded, which yields legal text (`Ã©`, `Ã¨`, `Â·`). A HINT: these
 * sequences can occur legitimately in a record about typography or encoding.
 */
function mojibakeQuery(table: string, column: string): string {
	return `
		SELECT m.section_tipo,
		       e.key                    AS component_tipo,
		       count(*)                 AS count,
		       min(m.section_id)        AS sample_section_id,
		       left(min(e.value::text), 300) AS sample_value
		  FROM "${table}" m,
		       LATERAL jsonb_each(m."${column}") e(key, value)
		 WHERE m."${column}" IS NOT NULL
		   AND e.value::text ~ '(Ã[©¨¡ ±³º]|Â[·º ª])'
		 GROUP BY 1, 2
		 ORDER BY 3 DESC`;
}

/**
 * SIGNATURE B — an absorbed file tail in a SINGLE-LINE literal. The `string`
 * column is where the single-line component models store their items
 * ({id, value, lang}), so an embedded newline there is not a value a form could
 * produce. The JSONB text rendering escapes a newline as the two characters
 * `\n`, which is what we search for.
 */
function absorbedTailQuery(table: string): string {
	return `
		SELECT m.section_tipo,
		       e.key                    AS component_tipo,
		       count(*)                 AS count,
		       min(m.section_id)        AS sample_section_id,
		       left(min(e.value::text), 300) AS sample_value
		  FROM "${table}" m,
		       LATERAL jsonb_each(m."string") e(key, value)
		 WHERE m."string" IS NOT NULL
		   AND position(chr(92) || 'n' IN e.value::text) > 0
		 GROUP BY 1, 2
		 ORDER BY 3 DESC`;
}

/**
 * SIGNATURE C — quote characters deleted, witnessed by the TIME MACHINE.
 *
 * The even-quote case leaves NOTHING in the value itself: `Alfonso X "el Sabio"`
 * simply became `Alfonso X el Sabio`. The one witness is a pair of consecutive
 * time-machine versions of the same component: the earlier one holds `"`, and
 * the next one is that same text with EVERY `"` removed. That is not a shape a
 * human edit produces. (In the JSONB rendering a quote inside a value is the two
 * characters backslash + quote, which is what the comparison strips.)
 *
 * Only the UPDATE-with-history case leaves this trace — see WHAT IT CANNOT DETECT.
 *
 * `history` narrows the walk to the VISIBLE history of the living generation
 * (tmHistoryNarrowing): a bulk run's hidden BEFORE image sits between two
 * visible versions and would otherwise be read as one of them.
 */
function quotesDeletedQuery(history: string): string {
	return `
	WITH versions AS (
		SELECT section_tipo,
		       section_id,
		       tipo,
		       lang,
		       data::text AS body,
		       lag(data::text) OVER (
		           PARTITION BY section_tipo, section_id, tipo, lang ORDER BY id
		       ) AS previous_body
		  FROM matrix_time_machine
		 WHERE ${history}
	)
	SELECT section_tipo,
	       tipo                              AS component_tipo,
	       count(*)                          AS count,
	       min(section_id)                   AS sample_section_id,
	       left(min(previous_body), 300)     AS sample_value
	  FROM versions
	 WHERE previous_body IS NOT NULL
	   AND position(chr(92) || chr(34) IN previous_body) > 0
	   AND replace(previous_body, chr(92) || chr(34), '') = body
	 GROUP BY 1, 2
	 ORDER BY 3 DESC`;
}

/**
 * The history narrowing this installation can express — the SAME predicates
 * every engine history reader splices (record_generation.ts withTmHistory),
 * each included only when its schema exists. The scan is READ ONLY, so it
 * cannot create the generation store the way ensureRecordGenerationTable does:
 * an absent store means no record was ever reborn (nothing to fence), an absent
 * `tm_role` column means the 0010 migration has not run (no undo-log row can
 * exist). Neither absence narrows anything away.
 */
async function tmHistoryNarrowing(reserved: Reserved): Promise<string> {
	const rows = (await reserved.unsafe(
		`SELECT
		   EXISTS (SELECT 1 FROM information_schema.columns
		            WHERE table_schema='public' AND table_name='matrix_time_machine'
		              AND column_name='tm_role') AS has_role,
		   EXISTS (SELECT 1 FROM information_schema.tables
		            WHERE table_schema='public'
		              AND table_name='dedalo_ts_record_generation') AS has_generation`,
	)) as { has_role: boolean; has_generation: boolean }[];
	const predicates: string[] = [];
	if (rows[0]?.has_role === true) predicates.push(tmVisiblePredicate());
	if (rows[0]?.has_generation === true) predicates.push(tmEpochPredicate());
	return predicates.length === 0 ? 'true' : predicates.join(' AND ');
}

interface GroupRow {
	section_tipo: string | null;
	component_tipo: string | null;
	count: number | string;
	sample_section_id: number | null;
	sample_value: string | null;
}

function toFindings(signature: Finding['signature'], table: string, rows: GroupRow[]): Finding[] {
	return rows.map((row) => ({
		signature,
		table,
		section_tipo: row.section_tipo ?? '(null)',
		component_tipo: row.component_tipo ?? '(null)',
		count: Number(row.count),
		sample_section_id: row.sample_section_id,
		sample_value: row.sample_value,
	}));
}

export async function main(): Promise<void> {
	const samples = Number(argValue('--samples') ?? SAMPLE_DEFAULT);
	const printQueries = process.argv.includes('--queries');

	const findings: Finding[] = [];
	const ranQueries: string[] = [];
	// Whole-table scans (`jsonb_each` over every record table, a `lag()` window
	// over all of matrix_time_machine): long work, so the scan declares the
	// unbounded scope at its source — the reserved connection then comes from the
	// maintenance pool, born without the request statement ceiling
	// (DB_STATEMENT_TIMEOUT_MS, 60 s by default), which would otherwise cancel
	// the first scan of a production-size table (T1-24 review; PRODUCTION.md §4).
	await withUnboundedStatements(() => scan(printQueries, findings, ranQueries));
	report(samples, findings, ranQueries);
}

/** The read-only scan proper, on one reserved connection inside BEGIN READ ONLY. */
async function scan(
	printQueries: boolean,
	findings: Finding[],
	ranQueries: string[],
): Promise<void> {
	const reserved = (await sql.reserve()) as unknown as Reserved;
	try {
		await proveReadOnly(reserved);
		console.log(
			'READ-ONLY PROVEN: transaction_read_only=on, and a write probe was refused (25006).',
		);

		const tables = await presentTables(reserved);
		console.log(`Scanning ${tables.length} matrix tables: ${tables.join(', ')}\n`);

		const run = async (
			signature: Finding['signature'],
			table: string,
			query: string,
		): Promise<void> => {
			ranQueries.push(query);
			if (printQueries) console.log(query);
			const rows = (await reserved.unsafe(query)) as GroupRow[];
			findings.push(...toFindings(signature, table, rows));
		};

		for (const table of tables) {
			for (const column of MATRIX_JSONB_COLUMNS) {
				await run('A-replacement-char', table, replacementQuery(table, column));
				await run('D-mojibake-hint', table, mojibakeQuery(table, column));
			}
			await run('B-absorbed-tail', table, absorbedTailQuery(table));
		}
		if (tables.length > 0) {
			// The time machine is not an allowlisted RECORD table (flat columns).
			const tmPresent = (await reserved.unsafe(
				`SELECT 1 AS present FROM information_schema.tables
				  WHERE table_schema='public' AND table_name='matrix_time_machine'`,
			)) as { present: number }[];
			if (tmPresent.length > 0) {
				await run(
					'C-quotes-deleted',
					'matrix_time_machine',
					quotesDeletedQuery(await tmHistoryNarrowing(reserved)),
				);
			}
		}
		await reserved.unsafe('ROLLBACK');
	} finally {
		reserved.release();
	}
}

/** Print the findings summary (no database access). */
function report(samples: number, findings: Finding[], ranQueries: string[]): void {
	const order: Finding['signature'][] = [
		'A-replacement-char',
		'B-absorbed-tail',
		'C-quotes-deleted',
		'D-mojibake-hint',
	];
	const titles: Record<Finding['signature'], string> = {
		'A-replacement-char': 'A. U+FFFD replacement characters (DATA-09, PROOF of a bad decode)',
		'B-absorbed-tail': 'B. single-line literals holding a newline (DATA-04 odd-quote CANDIDATES)',
		'C-quotes-deleted':
			'C. a version whose quotes vanished in the next one (DATA-04 even-quote WITNESS)',
		'D-mojibake-hint': 'D. Latin-1 mojibake shape (HINT only, legal text)',
	};

	console.log('='.repeat(78));
	for (const signature of order) {
		const rows = findings.filter((f) => f.signature === signature && f.count > 0);
		const total = rows.reduce((sum, row) => sum + row.count, 0);
		console.log(`\n${titles[signature]}\n  total: ${total}`);
		if (rows.length === 0) continue;
		const bySection = new Map<string, number>();
		for (const row of rows) {
			bySection.set(row.section_tipo, (bySection.get(row.section_tipo) ?? 0) + row.count);
		}
		for (const [section, count] of [...bySection].sort((a, b) => b[1] - a[1])) {
			console.log(`    ${section}: ${count}`);
		}
		for (const row of rows.slice(0, samples)) {
			console.log(
				`    sample — ${row.table} ${row.section_tipo}/${row.sample_section_id} ${row.component_tipo}: ${row.sample_value}`,
			);
		}
	}

	console.log(`\n${'='.repeat(78)}`);
	console.log(`Queries run: ${ranQueries.length}. Re-print them all with --queries.`);
	console.log(
		[
			'',
			'WHAT THIS SCAN CANNOT TELL YOU:',
			' - quote deletion on records the import CREATED (or imported without time-machine',
			'   history): the quoted form was never in the database. Only the source CSV shows it.',
			' - records the odd-quote case never imported at all: absence leaves no row. Compare the',
			'   source file row count against the dd800 bulk-process report of that run.',
			' - whether a signature-B value came from a CSV import or from a paste: judge each one.',
			' - anything outside the standard matrix record tables.',
			'Signature A is PROOF of a bad decode. B and C are candidates and leads. D is a hint.',
		].join('\n'),
	);
}

if (import.meta.main) {
	await main();
	await closeDatabasePool();
}
