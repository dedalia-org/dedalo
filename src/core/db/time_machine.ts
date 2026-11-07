/**
 * Time Machine access — the matrix_time_machine audit table.
 *
 * TM is Dédalo's per-component change history, surfaced in the app as the
 * VIRTUAL section 'dd15'. Its table does NOT follow the standard matrix
 * contract (matrix.ts): rows are FLAT audit columns, one row per component
 * change (verified against the live dedalo_mib_v7 schema):
 *
 *   id               int PK    TM row id — this is what dd15 uses as section_id
 *   section_id       int       SOURCE record's section_id
 *   section_tipo     text      SOURCE record's section_tipo (e.g. 'oh1' — NEVER 'dd15'!)
 *   tipo             text      component tipo that changed
 *   lang             text      language of the changed data
 *   timestamp        text      when the change happened
 *   user_id          int       who changed it
 *   bulk_process_id  int|null  bulk operation identifier
 *   bulk_process_temp         (transient bulk bookkeeping)
 *   data             jsonb     the component data snapshot
 *   tm_role          smallint|null  NULL = an ordinary, VISIBLE history row;
 *                              otherwise a HIDDEN undo-log row (TM_ROLE below,
 *                              migration 0010_tm_role.sql)
 *
 * A dataframe MAIN's history is kept in TWO LANES (relations/main_lanes.ts,
 * WC-2026-09-27-bulk-revert-undo-log addendum "two lanes"): a LANGUAGE row
 * holds that language's value only; the lg-nolan row holds the main's lg-nolan
 * value followed by the FULL frames of every slot of the main. The state at row
 * R: each language's newest row <= R, and the frames of the newest FRAME-STATE
 * row <= R (readFrameStateRowAt — lg-nolan, or a PHP-era row carrying frames);
 * a slot a frame state is silent about was EMPTY then. No column, no epoch
 * marks anything; TS-era beta rows are unsupported history.
 *
 * CONTRACT POINTS the rewrite must keep (PHP: core/tm_record/class.tm_record.php,
 * core/search/class.search_tm.php):
 *
 * - section_tipo MISMATCH: the dd15 virtual section addresses TM rows by the
 *   TM row `id` (as its section_id), while the row's own section_tipo column
 *   holds the SOURCE section. Never filter TM by section_tipo='dd15' — the
 *   PHP search_tm build_main_where() is intentionally empty for this reason.
 * - APPEND-ONLY (header re-dated 2026-07-07, S2-45 — the old "this module
 *   exposes no write functions" claim was false): this module exports
 *   recordTimeMachine, the ONE writer the save/delete/restore pipelines
 *   append through, plus the three UNDO-LOG writers of a bulk run
 *   (recordBulkPair / recordBulkBirth / recordBulkCascadeDelete — this file
 *   stays the single matrix_time_machine writer, which is what the retention
 *   registry keys on). TM rows are never UPDATEd or DELETEd — the dd15 surface
 *   is a read-only view over an append-only table.
 * - VISIBILITY: a row with a non-NULL tm_role is undo-log bookkeeping, never
 *   history. Every history reader narrows with record_generation.ts
 *   `withTmHistory` (epoch AND tm_role IS NULL); only the bulk revert reads
 *   every role.
 * - Default ordering is timestamp DESC (search_tm default).
 * - SQO mode 'tm' routes to the TM search engine (Phase 3).
 */

import { canonicalJson } from '../concepts/canonical_json.ts';
import { keyImage } from '../concepts/lang_region.ts';
import { assertNotReadOnlyRequest } from '../security/read_only_scope.ts';
import { dbTimestamp } from './db_timestamp.ts';
import { encodeForJsonb } from './json_codec.ts';
import { sql, withTransaction } from './postgres.ts';
import {
	ensureTmHistoryReady,
	ensureTmRoleColumn,
	tmVisiblePredicate,
	withTmHistory,
} from './record_generation.ts';

/** The dd15 virtual section tipo (PHP DEDALO_TIME_MACHINE_SECTION_TIPO). */
export const TIME_MACHINE_SECTION_TIPO = 'dd15';

/** One matrix_time_machine row (flat audit contract). */
export interface TimeMachineRow {
	/** TM row primary key — what dd15 components receive as their section_id. */
	id: number;
	/** SOURCE record coordinates (NOT dd15). */
	section_id: number;
	section_tipo: string;
	/** Component tipo whose data changed. */
	tipo: string;
	lang: string | null;
	timestamp: string | null;
	user_id: number | null;
	bulk_process_id: number | null;
	/** Parsed component data snapshot. */
	data: unknown;
	/** Raw data::text twin for parity diffing (byte-compat rule, spec §2.2). */
	dataText: string | null;
}

function rowFromDb(row: Record<string, unknown>): TimeMachineRow {
	return {
		id: row.id as number,
		section_id: row.section_id as number,
		section_tipo: row.section_tipo as string,
		tipo: row.tipo as string,
		lang: (row.lang as string | null) ?? null,
		timestamp: (row.timestamp as string | null) ?? null,
		user_id: (row.user_id as number | null) ?? null,
		bulk_process_id: (row.bulk_process_id as number | null) ?? null,
		data: row.data,
		dataText: (row.data__text as string | null) ?? null,
	};
}

/**
 * Read one VISIBLE TM row by its primary key (the dd15 'section_id').
 *
 * Narrowed by VISIBILITY (`tmVisiblePredicate`): an undo-log row (tm_role set)
 * is not history, so its id answers null here exactly like an id that does not
 * exist — the preview (section/read.ts) and apply_value then report
 * target_not_found for it rather than serving or restoring a hidden BEFORE
 * image as if a curator had saved it.
 *
 * NOT epoch-narrowed, deliberately: a PK read has no address to narrow by
 * until the row is read, and its CALLERS carry the identity check (address +
 * `recordEpoch`) — which refuses a dead generation's id with the specific
 * `request.invalid_options` "does not belong" (record_generation_native).
 */
export async function readTimeMachineRow(tmRowId: number): Promise<TimeMachineRow | null> {
	await ensureTmRoleColumn();
	const rows = (await sql.unsafe(
		`SELECT id, section_id, section_tipo, tipo, lang, timestamp, user_id,
		        bulk_process_id, data, data::text AS data__text
		 FROM matrix_time_machine
		 WHERE matrix_time_machine.id = $1 AND ${tmVisiblePredicate()}
		 LIMIT 1`,
		[tmRowId],
	)) as Record<string, unknown>[];
	const row = rows[0];
	return row === undefined ? null : rowFromDb(row);
}

/**
 * TIME MACHINE WRITE HOOK (Phase 2 stub — wired by the section_record save
 * pipeline in Phase 6).
 *
 * In PHP, every component data save ALSO appends an audit row to
 * matrix_time_machine (core/db/class.tm_db_manager.php, called from the
 * section_record save path). The TS save pipeline must do the same or the
 * dd15 history silently stops recording — this interface is the contract so
 * Phase 6 cannot forget it: the save pipeline takes a TimeMachineWriteHook
 * and calls it once per component data change, in the same transaction.
 */
// TM timestamps come from db_timestamp.ts dbTimestamp() — the ONE shared
// DEDALO_TIMEZONE-aware helper (S1-03). A UTC `nowDbTimestamp` used to live
// here and skewed the save-path TM rows 2h against the PHP-stamped local rows;
// never reintroduce a second clock.

export interface TimeMachineEntry {
	/** SOURCE record coordinates. */
	sectionTipo: string;
	sectionId: number;
	/** Component tipo whose data changed. */
	componentTipo: string;
	lang: string;
	userId: number;
	/**
	 * The component data snapshot to audit (encoded via json_codec at write) —
	 * for a dataframe main, its COMPOSED image (relations/dataframe_slots.ts).
	 */
	data: unknown;
}

export type TimeMachineWriteHook = (entry: TimeMachineEntry) => Promise<void>;

/**
 * Sections excluded from Time Machine (PHP tm_record::$excluded_section_tipos —
 * volatile/utility sections). dd15 itself is also refused.
 */
export const TM_EXCLUDED_SECTIONS: ReadonlySet<string> = new Set([TIME_MACHINE_SECTION_TIPO]);

/**
 * Append one audit row for a component data change (PHP tm_record::create →
 * tm_db_manager::create). Stores the NEW component data snapshot with the
 * source coordinates, a DB timestamp, and the acting user. Skipped for
 * excluded sections and non-positive section ids.
 *
 * The data value goes through the json_codec byte-compat chokepoint (bound as
 * $n::text::jsonb, per the matrix_write BUN GOTCHA).
 *
 * NO BULK ID, by type: `TimeMachineEntry` has no `bulkProcessId`, so `tsc`
 * refuses a bulk row written through this door. A bulk run's history is a
 * BEFORE/AFTER pair (recordBulkPair below) — a single row is exactly the
 * unrevertable shape the undo log retired.
 */
export async function recordTimeMachine(entry: TimeMachineEntry, timestamp: string): Promise<void> {
	assertNotReadOnlyRequest('recordTimeMachine');
	if (!isAuditedAddress(entry.sectionTipo, entry.sectionId)) return;
	await sql.unsafe(
		`INSERT INTO matrix_time_machine
		   (section_id, section_tipo, tipo, lang, timestamp, user_id, data)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb)`,
		[
			entry.sectionId,
			entry.sectionTipo,
			entry.componentTipo,
			entry.lang,
			timestamp,
			entry.userId,
			encodeForJsonb(entry.data),
		],
	);
}

/**
 * VISIBLE change history of one component on one SOURCE record, newest first
 * (the search_tm default ordering), narrowed to the record living at the
 * address now and to ordinary rows (`withTmHistory`). No production caller
 * today; the narrowing is here so that wiring one cannot serve a dead
 * generation's snapshots or a hidden undo-log image.
 */
export async function readTimeMachineHistory(
	sourceSectionTipo: string,
	sourceSectionId: number,
	componentTipo: string,
	limit = 50,
): Promise<TimeMachineRow[]> {
	await ensureTmHistoryReady();
	const rows = (await sql.unsafe(
		`SELECT id, section_id, section_tipo, tipo, lang, timestamp, user_id,
		        bulk_process_id, data, data::text AS data__text
		 FROM matrix_time_machine
		 WHERE ${withTmHistory(
				`matrix_time_machine.section_tipo = $1
				 AND matrix_time_machine.section_id = $2
				 AND matrix_time_machine.tipo = $3`,
			)}
		 ORDER BY timestamp DESC
		 LIMIT $4`,
		[sourceSectionTipo, sourceSectionId, componentTipo, limit],
	)) as Record<string, unknown>[];
	return rows.map(rowFromDb);
}

/** One other-language main item a visible history row recorded. */
interface HistoryItem {
	rowId: number;
	id: string;
	lang: string;
}

/**
 * THE ITEMS A MAIN HELD IN OTHER LANGUAGES, as its visible history recorded
 * them: the `id` of every main ITEM (a frame — dd490 or a `main_component_tipo`
 * entry — is not an item) tagged with a language outside `exceptLangs`, in any
 * visible row of `tipo` at this address (withTmHistory: the living generation,
 * no undo-log bookkeeping), UNBOUNDED: an item known only ABOVE the restored
 * row (imported with the time machine off, then edited, then deleted) is still
 * another language's item, and a frame paired to it never comes back as an
 * orphan. Lang-less items belong to every language and are never "another
 * language's". `unsliced` (an unsliced main) files EVERY item under
 * lg-nolan, its one lane — a locator's own `lang` stamp is ignored.
 *
 * `restoredRowId` (apply_value, the legacy bulk path — ONE row restored): an
 * item is left out when the history PROVES it did not exist at that row — the
 * newest row at or below it that speaks for the item's language (tagged with
 * it, or carrying items of it) does not hold it. Its frame in the restored row
 * was then saved BEFORE its item (frame-first — the save order is the
 * curator's) and comes back. No such row = nothing proves it absent: the item
 * counts (its frame is stale once the value no longer holds it).
 *
 * A frame is never an item — a v6 literal's WRAPPED frame included
 * (relations/dataframe_slots.ts unwrapV6LiteralFrame).
 *
 * The one input of the frame PAIRING LAW of a lang-sliced restore
 * (relations/dataframe_slots.ts `isStaleItemFrame`, shared by apply_value and
 * both bulk paths).
 */
export async function readOtherLangItemIds(
	coords: TmCoords,
	exceptLangs: readonly string[],
	restoredRowId: number | null = null,
	unsliced = false,
): Promise<Set<string>> {
	await ensureTmHistoryReady();
	// An item's LANE: its own `lang` — or, `unsliced` (an UNSLICED main:
	// ONE lane, relations/main_lanes.ts laneLaw), lg-nolan for every item,
	// whatever `lang` the save stamped on a locator of a portal flagged
	// translatable (decision 2026-09-29: the flag never changes the history).
	// Every visible row of the address (its tag, even with no item: a tagged
	// row speaks for its language) with its other-lane items — one statement.
	// `unsliced`: every ROW is the lg-nolan lane too, whatever its tag (a v6
	// row of a translatable-flagged portal is tagged lg-spa) — else a
	// frame-first frame on such a row would never be proven and be dropped.
	const itemLane = `CASE WHEN $5::boolean THEN 'lg-nolan' ELSE NULLIF(e.value->>'lang', '') END`;
	const rows = (await sql.unsafe(
		`SELECT matrix_time_machine.id AS row_id,
		        CASE WHEN $5::boolean THEN 'lg-nolan' ELSE matrix_time_machine.lang END AS row_lang,
		        e.value->>'id' AS id, ${itemLane} AS lang
		 FROM matrix_time_machine
		 LEFT JOIN LATERAL jsonb_array_elements(
		        CASE WHEN jsonb_typeof(matrix_time_machine.data) = 'array'
		             THEN matrix_time_machine.data ELSE '[]'::jsonb END) e
		   ON jsonb_typeof(e.value) = 'object'
		  AND NOT ${frameEntrySql('e.value')}
		  AND COALESCE(e.value->>'id', '') <> ''
		  AND COALESCE(${itemLane}, '') <> ''
		  AND NOT (${itemLane} = ANY(string_to_array($4, ',')))
		 WHERE ${withTmHistory(
				`matrix_time_machine.section_tipo = $1
				 AND matrix_time_machine.section_id = $2
				 AND matrix_time_machine.tipo = $3`,
			)}
		 ORDER BY matrix_time_machine.id DESC`,
		[coords.sectionTipo, coords.sectionId, coords.componentTipo, exceptLangs.join(','), unsliced],
	)) as { row_id: number; row_lang: string | null; id: string | null; lang: string | null }[];
	const items: HistoryItem[] = [];
	for (const row of rows) {
		if (row.id !== null && row.lang !== null)
			items.push({ rowId: Number(row.row_id), id: row.id, lang: row.lang });
	}
	if (restoredRowId === null) return new Set(items.map((item) => item.id));
	const rowsDesc = rows
		.map((row) => ({ id: Number(row.row_id), lang: row.row_lang }))
		.filter((row, n, all) => row.id <= restoredRowId && all[n - 1]?.id !== row.id);
	const absent = provenAbsentAt(items, rowsDesc);
	return new Set(items.filter((item) => !absent(item)).map((item) => item.id));
}

/**
 * A frame ENTRY of a stored history image (SQL over one jsonb element `value`):
 * the unified dd490 marker, the legacy pairing-key shape, or a v6 literal's
 * frame WRAPPED by the v6→v7 reformat as `{value: {frame}, id, lang}` — the
 * SQL twin of relations/dataframe_slots.ts isFrameEntry ∘ unwrapV6LiteralFrame.
 */
function frameEntrySql(value: string): string {
	// COALESCE: a key the element lacks reads NULL, and NOT NULL filters a row out.
	return `COALESCE(${value}->>'type' = 'dd490' OR ${value} ? 'main_component_tipo'
	         OR (jsonb_typeof(${value}->'value') = 'object'
	             AND (${value}->'value' ? 'main_component_tipo' OR ${value}->'value'->>'type' = 'dd490')), false)`;
}

/**
 * A FRAME-STATE row (SQL over an unaliased matrix_time_machine): a row of the
 * shared frame lane (tagged lg-nolan — relations/main_lanes.ts), or a row that
 * CARRIES a frame whatever its tag (a PHP-era main save: PHP composed every
 * row with the main's frames). A language row the engine writes carries no
 * frame and says nothing about them (WC-…-bulk-revert-undo-log, "two lanes").
 */
const FRAME_STATE_ROW_SQL = `(matrix_time_machine.lang = 'lg-nolan'
	OR (jsonb_typeof(matrix_time_machine.data) = 'array'
	    AND EXISTS (SELECT 1 FROM jsonb_array_elements(matrix_time_machine.data) fe
	                WHERE jsonb_typeof(fe.value) = 'object' AND ${frameEntrySql('fe.value')})))`;

/** The newest VISIBLE row of a main at or below `rowId` matching `predicate` ($4 = rowId). */
async function newestRowAt(
	coords: TmCoords,
	rowId: number,
	predicate: string,
	extra: unknown[] = [],
): Promise<TimeMachineRow | null> {
	await ensureTmHistoryReady();
	const rows = (await sql.unsafe(
		`SELECT id, section_id, section_tipo, tipo, lang, timestamp, user_id,
		        bulk_process_id, data, data::text AS data__text
		 FROM matrix_time_machine
		 WHERE ${withTmHistory(
				`matrix_time_machine.section_tipo = $1 AND matrix_time_machine.section_id = $2
				 AND matrix_time_machine.tipo = $3 AND matrix_time_machine.id <= $4 AND ${predicate}`,
			)}
		 ORDER BY matrix_time_machine.id DESC LIMIT 1`,
		[coords.sectionTipo, coords.sectionId, coords.componentTipo, rowId, ...extra],
	)) as Record<string, unknown>[];
	const row = rows[0];
	return row === undefined ? null : rowFromDb(row);
}

/**
 * THE FRAME STATE OF A MAIN AS OF ROW `rowId` (two lanes): the newest visible
 * frame-state row (FRAME_STATE_ROW_SQL) at or below it — null when none (no
 * frame state recorded yet: the frames were empty). Row ids, never timestamps:
 * every save of one record is serialised by its FOR UPDATE row lock, so the
 * ids follow the real order.
 */
export function readFrameStateRowAt(
	coords: TmCoords,
	rowId: number,
): Promise<TimeMachineRow | null> {
	return newestRowAt(coords, rowId, FRAME_STATE_ROW_SQL);
}

/** THE VALUE OF ONE LANE AS OF ROW `rowId`: the newest visible row tagged `lang` at or below it. */
export function readLaneRowAt(
	coords: TmCoords,
	lang: string,
	rowId: number,
): Promise<TimeMachineRow | null> {
	return newestRowAt(coords, rowId, 'matrix_time_machine.lang = $5', [lang]);
}

/**
 * THE NEXT VISIBLE ROW that ends one key's interval after `rowId` (any lane),
 * or null when nothing does. The TM PREVIEW's bound (tm_record/frame_as_of.ts):
 * the main held row R's state over [R, next) — another record "as of R" is its
 * state at the end of that interval. Row ids, one sequence across all records.
 *
 * Two kinds of row end it: the key's own next row, AND the record's own
 * SECTION-LEVEL row (tipo = section_tipo at the same address: the delete
 * snapshot, delete_record.ts; an archive restore's snapshot, archive/restore.ts).
 * A whole-record delete writes nothing on the main key, yet its commit-lane
 * frame policies (applyOwnFramePolicies → delete_target) wipe every frame
 * target ABOVE the delete row — without this arm the main's newest row had no
 * next row, the bound was unbounded, and the preview of a deleted record showed
 * its targets already wiped (state that never existed at R).
 */
export async function nextVisibleRowAfter(coords: TmCoords, rowId: number): Promise<number | null> {
	return (
		(await nextVisibleRow(coords.sectionTipo, coords.sectionId, coords.componentTipo, rowId))?.id ??
		null
	);
}

/**
 * THE NEXT VISIBLE ROW OF THE LIVING RECORD after `rowId`, whatever its key
 * (id + tipo), or null. The TM preview's record-lifecycle probes
 * (tm_record/frame_as_of.ts): after a whole-record row (tipo = section_tipo),
 * what the address wrote next tells a delete from an archive restore; from row
 * 0, the living generation's FIRST row (the epoch narrows the dead ones away).
 */
export function nextVisibleRecordRowAfter(
	sectionTipo: string,
	sectionId: number,
	rowId: number,
): Promise<{ id: number; tipo: string } | null> {
	return nextVisibleRow(sectionTipo, sectionId, null, rowId);
}

/**
 * THE NEWEST VISIBLE WHOLE-RECORD ROW at or below `rowId` (tipo = section_tipo:
 * a delete snapshot or an archive restore's snapshot — same shape, data = every
 * jsonb column), or null. The TM preview's sibling-bag lifecycle probe.
 */
export function readWholeRecordRowAt(
	sectionTipo: string,
	sectionId: number,
	rowId: number,
): Promise<TimeMachineRow | null> {
	return newestRowAt({ sectionTipo, sectionId, componentTipo: sectionTipo }, rowId, 'TRUE');
}

/**
 * The one statement behind nextVisibleRowAfter / nextVisibleRecordRowAfter:
 * `tipo` a key (that key OR the section-level key), or null (any key).
 */
async function nextVisibleRow(
	sectionTipo: string,
	sectionId: number,
	tipo: string | null,
	rowId: number,
): Promise<{ id: number; tipo: string } | null> {
	await ensureTmHistoryReady();
	const rows = (await sql.unsafe(
		`SELECT matrix_time_machine.id, matrix_time_machine.tipo FROM matrix_time_machine
		 WHERE ${withTmHistory(
				`matrix_time_machine.section_tipo = $1 AND matrix_time_machine.section_id = $2
				 AND ($3::text IS NULL OR matrix_time_machine.tipo = $3 OR matrix_time_machine.tipo = $1)
				 AND matrix_time_machine.id > $4`,
			)}
		 ORDER BY matrix_time_machine.id ASC LIMIT 1`,
		[sectionTipo, sectionId, tipo, rowId],
	)) as { id: number | string; tipo: string }[];
	const row = rows[0];
	return row === undefined ? null : { id: Number(row.id), tipo: row.tipo };
}

/** One tag (lane) of a key as readKeyLanesAt answers it. */
export interface KeyLaneRow {
	/** The row's tag (null: an untagged pre-migration row). */
	lang: string | null;
	row: TimeMachineRow;
	/** The row is at or below the bound (false: every row of the tag lies above it; `row` is then its newest). */
	atOrBelow: boolean;
}

/**
 * EVERY TAG OF ONE KEY, AS OF `boundId`, in ONE statement: per tag the newest
 * visible row at or below the bound, else (the tag has rows only above it) its
 * newest row, flagged `atOrBelow: false`. A tag with no visible row at all is
 * absent — history never recorded that lane. Visibility = withTmHistory (the
 * living generation, no undo-log row).
 */
export async function readKeyLanesAt(coords: TmCoords, boundId: number): Promise<KeyLaneRow[]> {
	await ensureTmHistoryReady();
	const rows = (await sql.unsafe(
		`SELECT DISTINCT ON (matrix_time_machine.lang)
		        id, section_id, section_tipo, tipo, lang, timestamp, user_id,
		        bulk_process_id, data, data::text AS data__text,
		        (matrix_time_machine.id <= $4) AS at_or_below
		 FROM matrix_time_machine
		 WHERE ${withTmHistory(
				`matrix_time_machine.section_tipo = $1 AND matrix_time_machine.section_id = $2
				 AND matrix_time_machine.tipo = $3`,
			)}
		 ORDER BY matrix_time_machine.lang, (matrix_time_machine.id <= $4) DESC,
		          matrix_time_machine.id DESC`,
		[coords.sectionTipo, coords.sectionId, coords.componentTipo, boundId],
	)) as Record<string, unknown>[];
	return rows.map((row) => {
		const parsed = rowFromDb(row);
		return { lang: parsed.lang, row: parsed, atOrBelow: row.at_or_below === true };
	});
}

/**
 * The frame-first proof of readOtherLangItemIds: an item is absent at the
 * restored row when the newest row at or below it (`rowsDesc`, id DESC) that
 * speaks for the item's language — tagged with it, or carrying items of it —
 * holds no item of that id in that language.
 */
function provenAbsentAt(
	items: readonly HistoryItem[],
	rowsDesc: readonly { id: number; lang: string | null }[],
): (item: HistoryItem) => boolean {
	const carried = new Set(items.map((item) => `${item.rowId}|${item.lang}`));
	const held = new Set(items.map((item) => `${item.rowId}|${item.lang}|${item.id}`));
	return (item) => {
		const speaking = rowsDesc.find(
			(row) => row.lang === item.lang || carried.has(`${row.id}|${item.lang}`),
		);
		return speaking !== undefined && !held.has(`${speaking.id}|${item.lang}|${item.id}`);
	};
}

// ---------------------------------------------------------------------------
// THE UNDO LOG OF A BULK RUN (2026-09-27, WC …-bulk-revert-undo-log)
// ---------------------------------------------------------------------------
//
// A bulk run (CSV import, import_execute, propagate, update_cache, a bulk
// revert itself — every door that mints a bulk_process_id) records, for every
// key it CHANGES, the exact bytes it replaced and the exact bytes it left, so
// that its revert is an exact inverse instead of an inference over history
// that may have been written with the time machine off.
//
// THE PAIR LAW (user decision D1): every save carrying a bulk id writes
//   - a hidden BEFORE row (tm_role = 1) — the region the write replaced, and
//   - its normal VISIBLE after-row (tm_role NULL, bulk_process_id set),
// whatever the caller's saveTm says; saveTm:false keeps its meaning only for
// writes OUTSIDE a bulk run. BEFORE is inserted first, so its id is lower, and
// both rows share one timestamp and the caller's transaction.
//
// TWO-LANE PAIRS (2026-09-28 addendum): a dataframe main's pairs are written
// under the MAIN's tipo only, per lane — one pair per language lane the write
// touched (its region), one lg-nolan pair (its lg-nolan region + every slot's
// full frames, relations/dataframe_slots.ts recordMainHistory) — for a main
// save AND for a slot save (which re-targets to the main it changed). A
// dataframe slot key never has a pair of its own.
//
// ABSENCE: `undefined` is "the key holds nothing" (concepts/lang_region.ts, the
// ONE absence law) and is stored as SQL NULL `data`. A stored JSON null is
// nothing too: recordBulkPair maps a `null` image to `undefined` (keyImage),
// because the write chokepoint restores `null` as a key REMOVAL — an image the
// revert cannot put back byte-exact would read as a post-run change on the next
// revert. Read absence back with `data IS NULL` (TM_IMAGE_ABSENT_COLUMN) — Bun
// maps SQL NULL and jsonb null to the same JS null.

/**
 * The closed set of hidden undo-log roles. NULL (no role) is an ordinary,
 * visible history row. Pinned in the database by the CHECK constraint
 * `matrix_time_machine_tm_role_check` (migration 0010_tm_role.sql); a new role
 * is a new migration, never a new number here alone. Role 2 (a hidden AFTER
 * image) was designed and dropped by decision D1: a bulk run's after-row is
 * always visible.
 */
export const TM_ROLE = {
	/** BEFORE image: the exact region a bulk write replaced (SQL NULL = absent). */
	before: 1,
	/** BIRTH marker: the record was created by this run (tipo = section_tipo, data = its birth image). */
	birth: 3,
	/**
	 * A record WIPED by a run's dataframe cascade (row kept) or DELETED by a
	 * revert's D2 (row gone): its whole-record snapshot under that bulk id.
	 */
	cascadeDelete: 4,
} as const;

export type TmRole = (typeof TM_ROLE)[keyof typeof TM_ROLE];

/** Select-list fragment decoding absence on an undo-log row: `data IS NULL AS data_absent`. */
export const TM_IMAGE_ABSENT_COLUMN = 'data IS NULL AS data_absent';

/**
 * Decode the image a row stores: `undefined` for an absent key (SQL NULL data),
 * the jsonb value otherwise. `dataAbsent` is the TM_IMAGE_ABSENT_COLUMN flag.
 */
export function decodeTmImage(data: unknown, dataAbsent: boolean): unknown {
	return dataAbsent ? undefined : data;
}

/** The SOURCE coordinates of one component key. */
export interface TmCoords {
	sectionTipo: string;
	sectionId: number;
	componentTipo: string;
}

export interface BulkPairEntry {
	coords: TmCoords;
	/**
	 * The row language. A lang-sliced model: the slice lang (both images are
	 * that language's REGION). An unsliced model: always `lg-nolan`, its one
	 * lane (relations/main_lanes.ts laneLaw — whatever the ontology flag or the
	 * request lang). A dataframe slot never has a pair of its own (its change
	 * is the main's lg-nolan pair).
	 */
	lang: string;
	userId: number;
	bulkId: number;
	/** The region the write replaced; `undefined` = the key was absent. */
	before: unknown;
	/** The region the write left; `undefined` = the key is now absent. */
	after: unknown;
	/** One stamp for both rows. Defaults to `dbTimestamp()`. */
	timestamp?: string;
}

export interface BulkPairIds {
	beforeId: number;
	afterId: number;
}

/**
 * Write one undo-log pair for a bulk write (THE PAIR LAW above).
 *
 * Returns null — and writes NOTHING — when the write changed nothing
 * (`canonicalJson(before) === canonicalJson(after)`, absence distinct from
 * `[]`; a JSON `null` image IS absence — keyImage): a no-op re-save of a bulk run leaves no history, visible or
 * hidden. Also null for an address the time machine never audits (excluded
 * section, non-positive id), like recordTimeMachine.
 *
 * Both INSERTs run in ONE transaction: the caller's when there is one (a nested
 * withTransaction joins it), else their own — so a pair is never half-written.
 */
export async function recordBulkPair(entry: BulkPairEntry): Promise<BulkPairIds | null> {
	const { coords } = entry;
	if (!isAuditedAddress(coords.sectionTipo, coords.sectionId)) return null;
	const before = keyImage(entry.before);
	const after = keyImage(entry.after);
	if (canonicalJson(before) === canonicalJson(after)) return null;
	const timestamp = entry.timestamp ?? dbTimestamp();
	return withTransaction(async () => {
		const row = {
			sectionTipo: coords.sectionTipo,
			sectionId: coords.sectionId,
			tipo: coords.componentTipo,
			lang: entry.lang,
			timestamp,
			userId: entry.userId,
			bulkId: entry.bulkId,
		};
		const beforeId = await insertUndoRow({ ...row, image: before, role: TM_ROLE.before });
		const afterId = await insertUndoRow({ ...row, image: after, role: null });
		return { beforeId, afterId };
	});
}

export interface BulkRecordEntry {
	sectionTipo: string;
	sectionId: number;
	userId: number;
	bulkId: number;
	/** Defaults to `dbTimestamp()`. */
	timestamp?: string;
}

export interface BulkBirthEntry extends BulkRecordEntry {
	/**
	 * The record's BIRTH IMAGE: the jsonb columns it was born with that no save
	 * wrote — for a create, the ontology-declared birth state the INSERT carried
	 * (the projects filter locator, every `properties.dato_default`; the audit
	 * stamps are record metadata and may be left out); for a revert's undelete,
	 * the restored snapshot. The revert (bulk_revert_records.ts) counts a key as
	 * someone else's write only when its live value differs from this image —
	 * without it, every birth default reads as a foreign value and no record born
	 * in a real section (they all carry a projects filter) is ever deleted.
	 * `undefined` = no image (data NULL): every non-run key then counts as foreign.
	 */
	image?: Record<string, unknown>;
}

/**
 * The BIRTH marker (role 3): the record at this address was CREATED by the run
 * `bulkId`. `tipo = section_tipo`, `lg-nolan`, data = the birth image (see
 * BulkBirthEntry; NULL when none). Write it only when a row was really inserted
 * (never for a conflict-tolerant no-op), AFTER the record's epoch was opened
 * (record_generation.ts openEpochIfReborn), so the marker sits at or above the
 * epoch and belongs to the living record.
 * Returns the row id, or null for an unaudited address.
 */
export async function recordBulkBirth(entry: BulkBirthEntry): Promise<number | null> {
	if (!isAuditedAddress(entry.sectionTipo, entry.sectionId)) return null;
	return insertUndoRow({
		sectionTipo: entry.sectionTipo,
		sectionId: entry.sectionId,
		tipo: entry.sectionTipo,
		lang: 'lg-nolan',
		timestamp: entry.timestamp ?? dbTimestamp(),
		userId: entry.userId,
		bulkId: entry.bulkId,
		image: entry.image,
		role: TM_ROLE.birth,
	});
}

export interface BulkCascadeDeleteEntry extends BulkRecordEntry {
	/** The whole-record snapshot the delete door captured (every jsonb column). */
	snapshot: Record<string, unknown>;
}

/**
 * The role-4 twin of a whole-record snapshot: a record a run's dataframe
 * cascade WIPED (`delete_target`, row kept — no policy removes a frame target
 * row, WC-2026-09-29-dataframe-hard-delete-retired) or a revert's D2 DELETED,
 * carrying the bulk id so its revert can find and restore/undelete it.
 * The ordinary delete snapshot row (tipo = section_tipo, lg-nolan, visible)
 * is still written by the delete door; pass ITS timestamp here so the two
 * rows read as one event. Returns the row id, or null for an unaudited address.
 */
export async function recordBulkCascadeDelete(
	entry: BulkCascadeDeleteEntry,
): Promise<number | null> {
	if (!isAuditedAddress(entry.sectionTipo, entry.sectionId)) return null;
	return insertUndoRow({
		sectionTipo: entry.sectionTipo,
		sectionId: entry.sectionId,
		tipo: entry.sectionTipo,
		lang: 'lg-nolan',
		timestamp: entry.timestamp ?? dbTimestamp(),
		userId: entry.userId,
		bulkId: entry.bulkId,
		image: entry.snapshot,
		role: TM_ROLE.cascadeDelete,
	});
}

/** Whether the time machine audits this address at all (the plain door's skips). */
function isAuditedAddress(sectionTipo: string, sectionId: number): boolean {
	return sectionId > 0 && !TM_EXCLUDED_SECTIONS.has(sectionTipo);
}

interface UndoRow {
	sectionTipo: string;
	sectionId: number;
	tipo: string;
	lang: string;
	timestamp: string;
	userId: number;
	bulkId: number;
	/** `undefined` = absent (SQL NULL); anything else goes through encodeForJsonb. */
	image: unknown;
	role: TmRole | null;
}

/** One bulk-run row. `$8` is SQL NULL for an absent image, else `::text::jsonb`. */
async function insertUndoRow(row: UndoRow): Promise<number> {
	assertNotReadOnlyRequest('insertUndoRow');
	await ensureTmRoleColumn();
	const rows = (await sql.unsafe(
		`INSERT INTO matrix_time_machine
		   (section_id, section_tipo, tipo, lang, timestamp, user_id, bulk_process_id, data, tm_role)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, $9)
		 RETURNING id`,
		[
			row.sectionId,
			row.sectionTipo,
			row.tipo,
			row.lang,
			row.timestamp,
			row.userId,
			row.bulkId,
			row.image === undefined ? null : encodeForJsonb(row.image),
			row.role,
		],
	)) as { id: number }[];
	return Number(rows[0]?.id);
}
