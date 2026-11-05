/**
 * counters_status widget — the matrix_counter audit + repair (PHP
 * widgets/counters_status wrapping counter::check_counters/modify_counter).
 *
 * A section_id counter is a HIGH-WATER MARK of the ids ever minted for a
 * section, not a count of its live records. `counter_value > last_section_id`
 * is therefore the NORMAL state of any section that has ever had a record
 * deleted from its tail — it is not drift and there is nothing to repair. The
 * only repairable state is a counter that LAGS the data
 * (`counter_value < last_section_id`), which the allocator also self-heals on
 * collision (matrix_write.ts, S2-01).
 *
 * The repair is raise-only and the destructive 'reset' action is refused —
 * see countersStatusModifyCounter and P0-14.
 */

import { isMatrixTable } from '../../db/matrix.ts';
import { counterFloorExpression, counterTableFor } from '../../db/matrix_write.ts';
import { sql } from '../../db/postgres.ts';
import { ONTOLOGY_LABEL_FALLBACK_LANG, termByTipo } from '../../ontology/labels.ts';
import {
	getMatrixTableFromTipo,
	getModelByTipo,
	listSectionNodes,
} from '../../ontology/resolver.ts';
import { refuseAction, type WidgetModule, type WidgetResponse } from './support.ts';

/**
 * How far above the section's LIVE data a high-water mark may sit before the
 * BULK repair refuses to raise it in one click.
 *
 * This is NOT an id band and NOT a correctness rule — a heritage section may
 * legitimately reach any id, and the allocator's floor deliberately has no
 * ceiling (over-allocating is safe; re-minting is not). It is a guard on
 * IRREVERSIBILITY: raising a counter cannot be undone (no writer may lower one,
 * and `reset` is gone), so a jump of this size is a decision a person makes per
 * row, with the number in front of them, not a side effect of one bulk click.
 *
 * Measured motivation: on a real install `dd128` (23 live records, counter 39)
 * carries a `matrix_time_machine` row at section_id 999000777 left by fixtures
 * from an era when tests ran against a shared database. The floor is right —
 * that id WAS minted — but silently moving a live section's counter by 10^9 is
 * not something a maintenance panel should do without being asked twice.
 */
const BULK_REPAIR_MAX_GAP = 10_000;

/**
 * Does this row belong on the panel? A section with NO counter row and NO
 * history has simply never been used. One with history but no counter IS a
 * finding — that is the state the removed 'reset' action left behind, and an
 * audit sourced from the counter tables alone could not see it at all.
 */
function isAuditFinding(row: Record<string, unknown> | null, counterRows: CounterRow[]): boolean {
	if (row === null) return false;
	return counterRows.length > 0 || Number(row.floor_value) > 0;
}

/**
 * A floor FAR above the live data is real history — the id WAS minted — but
 * raising to it is IRREVERSIBLE (no writer may lower a counter, and 'reset' is
 * gone). Report it and return true so the bulk repair skips it; the row stays
 * flagged and stays repairable one at a time. See BULK_REPAIR_MAX_GAP.
 */
function reportIrreversibleJump(
	sectionTipo: string,
	counterValue: number,
	lastSectionId: number,
	floorValue: number,
	errors: string[],
): boolean {
	const farAboveData = floorValue > lastSectionId + BULK_REPAIR_MAX_GAP;
	if (farAboveData && counterValue < floorValue) {
		errors.push(
			`Counter row with tipo: '${sectionTipo}': its high-water mark (${floorValue}) is far above ` +
				`its live data (${lastSectionId}) — the time machine witnesses ids that no record holds. ` +
				'Raising the counter is CORRECT but irreversible, so it is excluded from "Repair all ' +
				'counters"; inspect the history and use this row\'s own Fix button deliberately.',
		);
	}
	return farAboveData;
}

/** One counter row as the audit sees it: its value and the table it lives in. */
interface CounterRow {
	tipo: string;
	value: number;
	source: string;
}

/**
 * The section's live MAX(section_id) and its HIGH-WATER MARK floor.
 *
 * THE COMPARISON VALUE (P0-14): drift is measured against the floor, not against
 * live MAX. Measuring against live MAX reports the already-damaged install as
 * healthy — where the old consolidate-down button ran, counter == live MAX
 * exactly while the ids above it are minted and dead, so the row shows no drift,
 * offers no repair, and the allocator quietly re-mints those ids.
 */
async function measureSection(
	table: string | null,
	sectionTipo: string,
	errors: string[],
): Promise<{ lastSectionId: number; floorValue: number }> {
	if (table === null) return { lastSectionId: 0, floorValue: 0 };
	// The floor query is built for a table the write layer recognizes. Checked
	// BEFORE the try, not inside it: `counterFloorExpression` asserts the table
	// and a throw swallowed by the catch below would fabricate `floor_value: 0`,
	// which reads as "healthy" — silently hiding a lagging counter on the panel
	// built to reveal it. `getMatrixTableFromTipo` admits any safe identifier, so
	// an ontology naming e.g. `matrix_structurations` really does reach here.
	if (!isMatrixTable(table)) {
		errors.push(
			`Counter row with tipo: '${sectionTipo}' maps to table '${table}', which the write ` +
				'layer does not recognize — its high-water mark cannot be measured and it is ' +
				'reported UNVERIFIED, not healthy. Fix ASAP',
		);
		return { lastSectionId: 0, floorValue: 0 };
	}
	try {
		const maxRows = (await sql.unsafe(
			`SELECT section_id FROM "${table}" WHERE section_tipo = $1 ORDER BY section_id DESC LIMIT 1`,
			[sectionTipo],
		)) as { section_id: number }[];
		const floorRows = (await sql.unsafe(`SELECT ${counterFloorExpression(table)} AS floor_value`, [
			sectionTipo,
		])) as { floor_value: number }[];
		return {
			lastSectionId: Number(maxRows[0]?.section_id ?? 0),
			floorValue: Number(floorRows[0]?.floor_value ?? 0),
		};
	} catch (error) {
		// PHP: a failed table read reports 0 (e.g. a mapped table that does not
		// exist on this install) — the audit row still lists the counter. But it is
		// NAMED now: a swallowed failure that renders as 0/0 is indistinguishable
		// from a healthy section, and this widget exists to be trusted.
		errors.push(
			`Counter row with tipo: '${sectionTipo}': could not measure its high-water mark on ` +
				`table '${table}' (${error instanceof Error ? error.message : String(error)}). ` +
				'Reported UNVERIFIED, not healthy. Fix ASAP',
		);
		return { lastSectionId: 0, floorValue: 0 };
	}
}

/**
 * Name every counter row that lives in the table the allocator does NOT read
 * for this section. Never folded into the compared value: an audit that
 * collapsed both tables would report a stale high row as healthy while the
 * governing counter went on lagging.
 */
function reportStrayCounters(
	sectionTipo: string,
	table: string | null,
	governingTable: string,
	counterRows: CounterRow[],
	errors: string[],
): void {
	for (const stray of counterRows.filter((entry) => entry.source !== governingTable)) {
		errors.push(
			`Counter row with tipo: '${sectionTipo}' sits in '${stray.source}' (value ${stray.value}), ` +
				`but the section is on '${table ?? 'unresolved'}', governed by '${governingTable}'. ` +
				'The allocator does not read it. Fix ASAP',
		);
	}
}

/**
 * One audit row, or null when the tipo may not own a counter at all (the PHP
 * model check, messages kept). Appends to `errors` for both refusals: a
 * non-section tipo, and a counter sitting in the table the allocator does NOT
 * read for this section.
 */
async function auditRowFor(
	sectionTipo: string,
	counterRows: CounterRow[],
	errors: string[],
): Promise<Record<string, unknown> | null> {
	const model = await getModelByTipo(sectionTipo);
	if (model !== 'section') {
		errors.push(
			model === null || model === ''
				? `Counter row with tipo: '${sectionTipo}' is empty model_name. Maybe deleted TLD?`
				: `Counter row with tipo: '${sectionTipo}' is a '${model}' . Only sections can use counters. Fix ASAP`,
		);
		return null;
	}

	const table = await getMatrixTableFromTipo(sectionTipo);
	const { lastSectionId, floorValue } = await measureSection(table, sectionTipo, errors);

	// THE VALUE THE ALLOCATOR READS — the row in the GOVERNING table, or 0 when
	// that table holds none (itself a lagging state, and repairable).
	const governingTable = counterTableFor(table);
	const governing = counterRows.find((entry) => entry.source === governingTable);
	reportStrayCounters(sectionTipo, table, governingTable, counterRows, errors);

	const farAboveData = reportIrreversibleJump(
		sectionTipo,
		governing?.value ?? 0,
		lastSectionId,
		floorValue,
		errors,
	);

	return {
		section_tipo: sectionTipo,
		// Operator widget: labelled in the ontology label-fallback lang (was a
		// literal 'lg-spa', the same value on a default install).
		label: await termByTipo(sectionTipo, ONTOLOGY_LABEL_FALLBACK_LANG),
		counter_value: governing?.value ?? 0,
		last_section_id: lastSectionId,
		// The value the client flags against; >= last_section_id by construction.
		floor_value: floorValue,
		// True when raising to floor_value is a large, irreversible jump: the row
		// is still flagged and still repairable ONE AT A TIME, never in bulk.
		bulk_repair_excluded: farAboveData,
	};
}

/**
 * counters_status.get_value — the matrix_counter audit (PHP
 * counter::check_counters wrapped by the widget's get_value).
 */
export async function countersStatusGetValue(): Promise<WidgetResponse> {
	const errors: string[] = [];
	const datalist: Record<string, unknown>[] = [];

	// BOTH counter tables, WITH the table each row came from. A section backed by
	// a `_dd` matrix table is governed by matrix_counter_dd, and an audit reading
	// only matrix_counter could never show — nor let the operator repair — such a
	// counter, while the repair routes to it.
	//
	// (!) They are NOT collapsed. An earlier draft took MAX(value) across both
	// tables, which reports a value the allocator does not read: a tipo with a
	// stale row in the non-governing table would show that row's (higher) value,
	// the panel would call it healthy, and the GOVERNING counter would go on
	// lagging and re-minting dead ids — on the one screen built to reveal exactly
	// that. The audit must report what the ALLOCATOR reads.
	const rows = (await sql.unsafe(
		`SELECT tipo, value, 'matrix_counter' AS source FROM "matrix_counter"
		 UNION ALL
		 SELECT tipo, value, 'matrix_counter_dd' AS source FROM "matrix_counter_dd"
		 ORDER BY tipo ASC`,
		[],
	)) as { tipo: string; value: number | string; source: string }[];

	// (!) The audit may NOT be sourced from the counter tables alone. The install
	// this panel most needs to show is the one where the removed 'reset' action
	// DELETED a counter row: that section then has records, a time-machine history
	// and NO counter — and an audit built from counter rows would not list it at
	// all, so it would be flagged by nothing and repaired by nothing, while
	// 'Repair all counters' answered that everything was fine. Every ontology
	// SECTION is therefore a candidate; those with no counter and no history are
	// dropped below, so the panel does not grow a row per empty section.
	// Through the cached ontology accessor, never a raw dd_ontology read (the
	// T3 read-consolidation ratchet, S2-19).
	const sectionRows = await listSectionNodes();

	// One audit row per TIPO, whatever table(s) hold a counter for it.
	const byTipo = new Map<string, CounterRow[]>();
	for (const row of rows) {
		const bucket = byTipo.get(row.tipo) ?? [];
		bucket.push({ tipo: row.tipo, value: Number(row.value), source: row.source });
		byTipo.set(row.tipo, bucket);
	}
	for (const section of sectionRows) {
		if (!byTipo.has(section.tipo)) byTipo.set(section.tipo, []);
	}

	for (const [sectionTipo, counterRows] of [...byTipo].sort((a, b) => a[0].localeCompare(b[0]))) {
		const row = await auditRowFor(sectionTipo, counterRows, errors);
		if (isAuditFinding(row, counterRows)) datalist.push(row as Record<string, unknown>);
	}

	return { data: { datalist, errors } };
}

/**
 * RAISE one section's counter to the allocator's own floor, materializing the
 * row if it is missing. Returns whether anything was written.
 *
 * RAISE-ONLY, in ONE statement, over `counterFloorExpression` — never over live
 * rows alone. A repair with a NARROWER floor than the allocator would set the
 * counter to MAX(live), and the next create would be born at a DELETED record's
 * id: a repair button strictly worse than pressing nothing (P0-14).
 */
async function raiseCounterToFloor(sectionTipo: string): Promise<boolean> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	// An unrecognized table returns FALSE rather than throwing: inside
	// repair_all_counters a throw would abort the loop mid-way and leave the
	// remaining counters unrepaired with no partial report.
	if (table === null || !isMatrixTable(table)) return false;
	// The counter this section's allocator actually reads — '_dd' ontology tables
	// are governed by matrix_counter_dd, and writing the other table would
	// "repair" a row that governs nothing.
	const counterTable = counterTableFor(table);
	const raised = (await sql.unsafe(
		`WITH counter_floor AS (
			SELECT ${counterFloorExpression(table)} AS floor_value
		)
		INSERT INTO "${counterTable}" (tipo, value)
		SELECT $1::varchar, floor_value FROM counter_floor WHERE floor_value > 0
		ON CONFLICT (tipo) DO UPDATE SET value = GREATEST("${counterTable}".value, EXCLUDED.value)
		RETURNING value`,
		[sectionTipo],
	)) as { value: number }[];
	return raised.length > 0;
}

/**
 * The two refusals of `modify_counter`, before anything is written.
 *
 * 'reset' (PHP `delete_counter`) is refused outright: destroying the
 * high-water mark is not a repair — the allocator then re-issues deleted
 * records' ids, which inherit their Time Machine history and media files
 * (P0-14).
 */
function assertModifiableCounter(sectionTipo: string, counterAction: string): void {
	if (sectionTipo === '') {
		refuseAction('Error: empty mandatory section_tipo');
	}
	if (counterAction === 'reset') {
		refuseAction(
			`Refused: 'reset' would DELETE the counter for '${sectionTipo}'. A section_id counter ` +
				'records the highest id ever minted, not the number of live records — deleting it makes ' +
				"the allocator re-issue deleted records' ids, which then inherit their Time Machine " +
				"history and media files. Use 'fix' to raise a counter that lags the data.",
		);
	}
}

/**
 * counters_status.modify_counter — RAISE one matrix_counter row to the
 * section's real MAX(section_id) ('fix'). The counter is a HIGH-WATER MARK of
 * ids ever minted, so the only repairable drift is a counter that LAGS the
 * data; a counter ahead of MAX(section_id) is the normal state after a tail
 * delete and needs no repair.
 *
 * (!) Deliberate divergence from the dead PHP twin
 * (WC-2026-08-30-section-id-counter-is-a-high-water-mark, P0-14):
 *  - 'fix' is now a GREATEST upsert over the ALLOCATOR'S OWN floor
 *    (`counterFloorExpression`) — it can only raise, and never to a value the
 *    allocator would consider too low. PHP's consolidate_counter did a plain
 *    `SET value = MAX(section_id)`, the single place in the tree that could
 *    move a section-id counter DOWN and re-mint the ids of deleted records.
 *  - 'reset' (PHP delete_counter) IS REFUSED. Deleting the row destroys the
 *    high-water mark, after which the allocator's bootstrap re-derives a
 *    restart point and re-issues dead records' ids. There is no repair this
 *    action performs that a raise does not.
 *  - 'fix' now CREATES a missing counter row (PHP's create branch was inert).
 *    Materializing the high-water mark is the whole point of the action.
 */
async function countersStatusModifyCounter(
	options: Record<string, unknown>,
): Promise<WidgetResponse> {
	const sectionTipo = typeof options.section_tipo === 'string' ? options.section_tipo : '';
	const counterAction = typeof options.counter_action === 'string' ? options.counter_action : '';
	assertModifiableCounter(sectionTipo, counterAction);

	const result = counterAction === 'fix' ? await raiseCounterToFloor(sectionTipo) : false;

	// refreshed audit (PHP re-runs check_counters and attaches its datalist)
	const audit = await countersStatusGetValue();
	const auditDatalist = (audit.data as { datalist?: unknown[] } | null)?.datalist ?? [];

	return {
		data: result,
		msg: result
			? `OK. ${counterAction} counter successfully ${sectionTipo}`
			: `Error on ${counterAction} counter ${sectionTipo}`,
		extend: { datalist: auditDatalist },
	};
}

/** An audit row's section tipo, as a string. */
function auditRowTipo(item: Record<string, unknown>): string {
	return String(item.section_tipo ?? '');
}

/** Does this audit row stand BELOW its section's high-water mark (i.e. need a raise)? */
function lagsBehindFloor(item: Record<string, unknown>): boolean {
	return (
		auditRowTipo(item) !== '' &&
		Number(item.counter_value) < Number(item.floor_value) &&
		item.bulk_repair_excluded !== true
	);
}

/**
 * counters_status.repair_all_counters — raise EVERY section counter to its
 * high-water mark, in one operator action (P0-14).
 *
 * WHY IT EXISTS. The other half of this change fences the future: no writer can
 * lower a counter any more. It does nothing for an install where the old
 * consolidate-down button ALREADY ran, and that state is the dangerous one —
 * the counter sits exactly at MAX(live section_id), so the panel shows no drift
 * against the data, while every id above it belongs to a deleted record. The
 * allocator's bootstrap floor is never consulted (the counter row exists) and
 * the collision self-heal never fires (the row at the next id was deleted), so
 * those ids are re-minted silently.
 *
 * WHY IT IS AN ACTION AND NOT A BOOT MIGRATION. A bulk correction of SHARED
 * rows may not ride the `install/db/migrations/` lane: that lane admits shared
 * DML only as a TAGGED, `@>`-pinned single-row seed correction
 * (`test/unit/migration_shared_row_tripwire.test.ts`), and a counter value is
 * an integer that no jsonb containment can pin. The repair therefore lives
 * where every other shared-row write lives — in the engine, behind the
 * maintenance admin gate, run deliberately and reported.
 *
 * It can only RAISE (GREATEST), so it is safe to re-run and can never point a
 * counter at an id already in use.
 */
async function countersStatusRepairAllCounters(): Promise<WidgetResponse> {
	const audit = await countersStatusGetValue();
	const datalist = (audit.data as { datalist?: Record<string, unknown>[] }).datalist ?? [];

	// Raise each lagging counter DIRECTLY. Going through modify_counter would
	// re-run the entire audit after every single repair — and this action exists
	// for the install where MANY counters lag, so that is quadratic: ~950 queries
	// per repair on a 471-section install. One audit before, one after.
	const repaired: string[] = [];
	for (const sectionTipo of datalist.filter(lagsBehindFloor).map(auditRowTipo)) {
		if (await raiseCounterToFloor(sectionTipo)) repaired.push(sectionTipo);
	}

	const refreshed = await countersStatusGetValue();
	return {
		data: true,
		msg:
			repaired.length === 0
				? 'OK. Every counter already stands at or above its high-water mark'
				: `OK. Raised ${repaired.length} counter(s) to their high-water mark: ${repaired.join(', ')}`,
		extend: {
			datalist: (refreshed.data as { datalist?: unknown[] } | null)?.datalist ?? [],
			repaired,
		},
	};
}

/**
 * counters_status.reconcile_media_counters — raise counters to the ids the
 * MEDIA TREE proves were minted (P0-14 / LIFE-01).
 *
 * The restore-day action. A `pg_restore` rolls the database back WITH its
 * counters while the disk keeps every file written up to the disaster, so the
 * media tree is the only witness left of the ids in between. Re-minting them
 * keys new records straight into dead records' files
 * (`{component_tipo}_{section_tipo}_{section_id}`), and `component_av`
 * then plays the dead object's derivatives.
 *
 * DRY BY DEFAULT: it reports what it would raise and writes nothing unless
 * `apply:true`. An operator should read that list — a surprising number usually
 * means the media root is not the one this database belongs to, and raising a
 * counter cannot be undone.
 */
async function countersStatusReconcileMediaCounters(
	options: Record<string, unknown>,
): Promise<WidgetResponse> {
	const apply = options.apply === true;
	const { reconcileCountersWithMedia } = await import('../../media/counter_reconcile.ts');
	const { raises, skipped, filesScanned, sectionsWithMedia } = await reconcileCountersWithMedia({
		apply,
	});

	const detail = raises
		.map(
			(raise) =>
				`${raise.sectionTipo}: ${raise.before ?? 'no counter'} → ${raise.after} (witness ${raise.witness})`,
		)
		.join('; ');
	const audit = await countersStatusGetValue();

	return {
		data: true,
		msg:
			raises.length === 0
				? `OK. ${filesScanned} media files across ${sectionsWithMedia} sections name no id above the counters — nothing to reconcile`
				: `${apply ? 'RAISED' : 'WOULD RAISE'} ${raises.length} counter(s) from the media tree (${filesScanned} files scanned): ${detail}${skipped.length > 0 ? ` — SKIPPED (could not judge): ${skipped.join('; ')}` : ''}`,
		extend: {
			datalist: (audit.data as { datalist?: unknown[] } | null)?.datalist ?? [],
			raises,
			skipped,
			applied: apply,
			files_scanned: filesScanned,
		},
	};
}

export const widget: WidgetModule = {
	spec: {
		id: 'counters_status',
		category: 'integrity',
		class: 'width_100',
		label: { kind: 'literal', text: 'Dédalo counters status' },
	},
	apiActions: {
		get_value: countersStatusGetValue,
		modify_counter: countersStatusModifyCounter,
		repair_all_counters: countersStatusRepairAllCounters,
		reconcile_media_counters: countersStatusReconcileMediaCounters,
	},
	getValue: countersStatusGetValue,
};
