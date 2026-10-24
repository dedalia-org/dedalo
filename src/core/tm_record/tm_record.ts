/**
 * tm_record — materialize a virtual dd15 section record from one
 * matrix_time_machine row (PHP core/tm_record/class.tm_record.php
 * ::get_section_record, :569).
 *
 * A TM row is a FLAT audit snapshot (who / when / which component / which lang /
 * the jsonb datum). dd15 is a VIRTUAL section: it has no matrix table of its
 * own. To display TM history through the ordinary component pipeline with no
 * special-cased UI, PHP reconstructs a section_record keyed under dd15 and
 * injects each flat field as component data via the model→column map. TS does
 * the same over the passive MatrixRecord struct using the substitution API
 * (section_record/virtual_record.ts) — this module is the SINGLE place that
 * knows the dd15 field mapping (it used to be duplicated in read_tm.ts and
 * tool_time_machine.ts).
 *
 * Field mapping (PHP get_section_record):
 *   section_id      → dd1212 (number)      numeric id of the source record
 *   timestamp       → dd559  (date)        when the change was recorded
 *   tipo            → dd577  (input_text)  label of the changed component tipo
 *   section_tipo    → dd1772 (input_text)  label of the owning section tipo
 *   user_id         → dd578  (relation)    locator to the user record in dd128,
 *                                          ALSO written to dd200 (text_area compat)
 *   bulk_process_id → dd1371 (number)      enclosing bulk operation id (null→null)
 *   annotation      → rsc329 (text_area)   the TM note: looked up in the notes
 *                     section (rsc832) by its Code (rsc835) = the TM row id;
 *                     the note record's section_id rides on the FIRST item as
 *                     parent_section_id (PHP class.tm_record.php:690-755). The
 *                     inspector component_history note view consumes it.
 *   data            → source model 'section': adopt the snapshot's own component
 *                     columns wholesale (skip structural 'data'/'id'); other
 *                     models: inject under dd1574 (generic, RAW) + the component's
 *                     own tipo so component get_data() finds it — SPLIT: the
 *                     main's items under its tipo, each dataframe slot's frames
 *                     under the slot (a composed row, injectComponentSnapshot) —
 *                     EXCEPT models with
 *                     no storable jsonb column (component_section_id, whose
 *                     "column" is the section_id PK): the own-tipo inject is
 *                     skipped (it would throw), matching PHP set_component_data
 *                     which logs + continues. The dd1574 copy still carries it.
 *                     A RELATION-column model's datum passes the shape gate
 *                     (relation_snapshot_shape.ts) before it lands under its
 *                     own tipo: a non-locator shape (a pre-v6 bare id, label
 *                     strings…) is NOT converted — it is refused and reported
 *                     (buildTmSectionRecordWithRefusal) for a flagged cell.
 */

import { getComponentModel } from '../components/registry.ts';
import type { MatrixJsonbColumn, MatrixRecord } from '../db/matrix.ts';
import { assertMatrixTable, MATRIX_JSONB_COLUMNS, readMatrixRecord } from '../db/matrix.ts';
import { sql } from '../db/postgres.ts';
import type { TimeMachineRow } from '../db/time_machine.ts';
import { TIME_MACHINE_SECTION_TIPO } from '../db/time_machine.ts';
import { ontologyTermLabel } from '../ontology/labels.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
} from '../ontology/resolver.ts';
import { isOwnFrame, splitComposed } from '../relations/dataframe_slots.ts';
import { maskSecretItems } from '../resolve/component_data.ts';
import {
	injectColumnData,
	injectComponentData,
	makeVirtualRecord,
} from '../section_record/virtual_record.ts';
import { classifyRelationSnapshot, type RelationSnapshotShape } from './relation_snapshot_shape.ts';

/** dd15 virtual-section column-component tipos (PHP dd_tipos.php:208-220). */
/** The TM ROW's own PK — the `id` column, surfaced as `matrix_id`. NOT dd1212:
 * that is the CALLER record's section_id. Both are labelled id-ish ("Id" vs
 * "Section id", and dd1212's lg-spa term is literally "section_id"), which is
 * exactly why the two were conflated — a sort on the Id column ordered by
 * section_id. Filtering already resolved it to `id` (tm_filter TM_FILTER_COLUMNS);
 * ordering now does too (read_tm TM_ORDER_COLUMN). */
export const TM_COLUMN_MATRIX_ID = 'dd1573'; // component_number
export const TM_COLUMN_SECTION_ID = 'dd1212'; // component_number
export const TM_COLUMN_TIMESTAMP = 'dd559'; // component_date
export const TM_COLUMN_TIPO = 'dd577'; // component_input_text
export const TM_COLUMN_SECTION_TIPO = 'dd1772'; // component_input_text
export const TM_COLUMN_USER_ID = 'dd578'; // component_autocomplete_hi (relation)
export const TM_COLUMN_BULK_PROCESS_ID = 'dd1371'; // component_number
export const TM_COLUMN_DATA = 'dd1574'; // generic data column
export const TM_NOTES_TEXT = 'rsc329'; // component_text_area (annotation)
export const TM_NOTES_SECTION_TIPO = 'rsc832'; // DEDALO_TIME_MACHINE_NOTES_SECTION_TIPO (dd_tipos.php:220)
const TM_NOTES_CODE_TIPO = 'rsc835'; // the notes section's Code (component_number): the annotated TM row id
const CREATED_BY_USER = 'dd200'; // DEDALO_SECTION_INFO_CREATED_BY_USER
const USERS_SECTION_TIPO = 'dd128'; // DEDALO_SECTION_USERS_TIPO
const RELATION_TYPE_LINK = 'dd151'; // DEDALO_RELATION_TYPE_LINK

/** The model a frame's `from_component_tipo` must resolve to for it to name a slot. */
const DATAFRAME_MODEL = 'component_dataframe';

/**
 * THE FRAME HALF OF A MAIN'S TM SNAPSHOT, per slot — the READ split of a
 * COMPOSED row (relations/dataframe_slots.ts composeTmData; PHP get_data
 * data_source='tm' on a component_dataframe, which reads the MAIN's row and
 * keeps the frames of its own slot). The complement of `splitComposed().main`
 * (relations/dataframe_slots.ts — the ONE partition by isFrameEntry): every
 * reader that renders a snapshot shows the main from the one and the slots
 * from the other, so a frame never renders as a main item and a main item
 * never as a frame.
 *
 * - SCOPED TO THE MAIN: a shared slot stores every main's frames; a frame
 *   naming ANOTHER `main_component_tipo` is not this main's history and is left
 *   out (an unstamped legacy frame is kept);
 * - a frame naming `from_component_tipo` belongs to that slot when the tipo IS a
 *   `component_dataframe` (else it names no slot and is inert — the restore's
 *   planDataframeRestore reads it the same way);
 * - a legacy frame naming no slot belongs to the main's ONLY slot in play; with
 *   several it cannot be attributed and is not shown (a read never guesses).
 *
 * `declaredSlots` seed the map with EMPTY lists: a snapshot's silence about a
 * slot means "empty then" (the row is the full state — relations/dataframe_slots.ts
 * rowSlotTipos), as apply_value restores it.
 */
export async function snapshotSlotFrames(
	mainTipo: string,
	data: unknown,
	declaredSlots: readonly string[],
): Promise<Map<string, Record<string, unknown>[]>> {
	const bySlot = new Map<string, Record<string, unknown>[]>(
		declaredSlots.map((slot) => [slot, []]),
	);
	const unplaced: Record<string, unknown>[] = [];
	for (const frame of mainFrames(mainTipo, data)) {
		const slot = namedSlot(frame);
		if (slot === null) unplaced.push(frame);
		else if (await claimSlot(bySlot, slot)) bySlot.get(slot)?.push(frame);
	}
	attributeUnplaced(bySlot, unplaced);
	return bySlot;
}

/** The slot a frame names in `from_component_tipo`, or null (a legacy frame). */
function namedSlot(frame: Record<string, unknown>): string | null {
	const from = frame.from_component_tipo;
	return typeof from === 'string' && from !== '' ? from : null;
}

/** Legacy frames naming no slot go to the ONLY slot in play; with several, nowhere. */
function attributeUnplaced(
	bySlot: Map<string, Record<string, unknown>[]>,
	unplaced: readonly Record<string, unknown>[],
): void {
	if (unplaced.length === 0 || bySlot.size !== 1) return;
	for (const frames of bySlot.values()) frames.push(...unplaced);
}

/** The snapshot's frame entries that belong to `mainTipo` (its own, or unstamped legacy ones). */
function mainFrames(mainTipo: string, data: unknown): Record<string, unknown>[] {
	return splitComposed(data).frames.filter((frame) => isOwnFrame(frame, mainTipo));
}

/** Whether `slot` is (or, once model-checked, becomes) a slot of the partition. */
async function claimSlot(
	bySlot: Map<string, Record<string, unknown>[]>,
	slot: string,
): Promise<boolean> {
	if (bySlot.has(slot)) return true;
	if ((await getModelByTipo(slot)) !== DATAFRAME_MODEL) return false;
	bySlot.set(slot, []);
	return true;
}

/** '2026-07-01 10:13:08' → the dd_date object PHP emits for dd559. */
export function ddDateFromTimestamp(timestamp: string | null): Record<string, number> {
	if (timestamp === null) return {};
	const match = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
	if (match === null) return {};
	return {
		day: Number(match[3]),
		month: Number(match[2]),
		year: Number(match[1]),
		hour: Number(match[4]),
		minute: Number(match[5]),
		second: Number(match[6]),
	};
}

/**
 * Inject one dd15 field into the virtual record via its ontology model
 * (PHP set_section_record_factory: resolve model → column, then set). Skips the
 * field (returns) when the ontology cannot resolve a model — PHP logs and
 * continues so the remaining fields still build.
 */
async function injectTmField(
	record: MatrixRecord,
	tipo: string,
	items: unknown[] | null,
): Promise<void> {
	const model = await getModelByTipo(tipo);
	if (model === null) return;
	const column = getColumnNameByModel(model);
	if (column === null || !MATRIX_JSONB_COLUMNS.includes(column as MatrixJsonbColumn)) return;
	injectComponentData(record, tipo, model, items);
}

/**
 * The rsc329 annotation value for one TM row (PHP class.tm_record.php:690-755):
 * search the notes section (rsc832) for the record whose Code (rsc835) equals
 * the TM row id, adopt its rsc329 data verbatim (all langs — the emit side
 * lang-filters like PHP get_data_lang), and pin the note record's section_id on
 * the FIRST item as parent_section_id — component_text_area's 'tm' branch lifts
 * it onto the data item so the client note view can open/create the note record.
 * No note (or a note with no stored text) → PHP's single empty placeholder item
 * carrying only parent_section_id.
 */
async function tmNoteValue(tmRowId: number): Promise<unknown[]> {
	const table = await getMatrixTableFromTipo(TM_NOTES_SECTION_TIPO);
	const model = await getModelByTipo(TM_NOTES_TEXT);
	const column = model !== null ? getColumnNameByModel(model) : null;

	// The note record's own address, MINTED here from an int PK column (PHP
	// carried the DB driver's string; WC-2026-08-10-section-id-int-canonical
	// repeals that shape). The client only tests it for presence and echoes it
	// into the note open/create RQO, which reads addresses as ints.
	let noteSectionId: number | null = null;
	let noteItems: unknown[] | null = null;
	if (table !== null && column !== null) {
		assertMatrixTable(table);
		// PHP searches rsc835 as component_number with q = the TM row id; the
		// jsonb text projection matches both number and numeric-string storage.
		// Table identifier is allowlist-gated above; values are bound params.
		const rows = (await sql.unsafe(
			`SELECT section_id
			 FROM "${table}"
			 WHERE section_tipo = $1
			   AND EXISTS (
			     SELECT 1 FROM jsonb_array_elements(COALESCE(number->$2, '[]'::jsonb)) AS code
			     WHERE code->>'value' = $3
			   )
			 ORDER BY section_id ASC
			 LIMIT 1`,
			[TM_NOTES_SECTION_TIPO, TM_NOTES_CODE_TIPO, String(tmRowId)],
		)) as { section_id: number }[];
		const found = rows[0]?.section_id ?? null;
		if (found !== null) {
			noteSectionId = Number(found);
			const noteRecord = await readMatrixRecord(table, TM_NOTES_SECTION_TIPO, noteSectionId);
			const columnValue = noteRecord?.columns[column as MatrixJsonbColumn];
			const items = (columnValue as Record<string, unknown> | null | undefined)?.[TM_NOTES_TEXT];
			// PHP get_data coerces non-array data to [$data]; null keeps the placeholder.
			noteItems = items == null ? null : Array.isArray(items) ? items : [items];
		}
	}

	const value = noteItems !== null && noteItems.length > 0 ? [...noteItems] : [{}];
	const first = value[0];
	value[0] =
		first !== null && typeof first === 'object'
			? { ...(first as Record<string, unknown>), parent_section_id: noteSectionId }
			: { parent_section_id: noteSectionId };
	return value;
}

/**
 * A NULL bulk_process_id is the number 0, not null: the client renders the
 * Process cell straight from this value. The coercion used to live in the TM
 * emitter's own dd1371 case; with every cell resolving from the virtual record
 * it has to live here (caught by tm_emit_row_context_native).
 */
function bulkProcessValue(stored: number | null | undefined): number {
	return stored ?? 0;
}

/**
 * A per-component history snapshot into the virtual dd15 record: the RAW
 * snapshot under dd1574 (PHP's generic data column, byte-verbatim), and the
 * SPLIT one under the component tipos the list cells resolve — the main's own
 * items under its tipo (splitComposed: every entry that is not a frame, so a
 * v6 title-only component_iri item stays) and each slot's frames
 * under the slot (snapshotSlotFrames). A COMPOSED row (the main + every slot's
 * frames, dataframe_slots.ts) injected whole under the main made a relation
 * main page its frames as portal rows and a literal main render frame objects
 * as its values, while the dataframe cells stayed empty. A row under a slot's
 * OWN tipo is no supported history (TS-era beta; PHP never wrote one): only its
 * raw dd1574 copy is shown.
 *
 * Models with no storable column (e.g. component_section_id, whose "column"
 * is the section_id PK) have nowhere to land — injecting would throw. PHP
 * set_component_data logs + continues past them; the dd1574 copy still
 * carries the data.
 *
 * A CREDENTIAL row (the model's `secretValue`, e.g. component_password) is
 * masked HERE, before either copy lands: the raw dd1574 cell is a component_json
 * the display mask never sees, so it would serve the stored hash verbatim to
 * every reader of the row, admin included (WC-2026-09-30-password-hash-never-served
 * names the Time Machine history). Restore reads matrix_time_machine itself,
 * never this display record.
 */
async function injectComponentSnapshot(
	record: MatrixRecord,
	row: TimeMachineRow,
	sourceModel: string | null,
	declaredSlots: readonly string[],
): Promise<TmRecordRefusal | null> {
	const stored = snapshotItems(row.data);
	const dataParsed = isSecretModel(sourceModel) ? maskSecretItems(stored) : stored;
	await injectTmField(record, TM_COLUMN_DATA, dataParsed);
	if (!hasStorableColumn(sourceModel) || sourceModel === DATAFRAME_MODEL) return null;
	const componentItems = componentSnapshotItems(row, sourceModel, dataParsed);
	if (componentItems.kind === 'refused') {
		return { tipo: row.tipo, reason: componentItems.reason };
	}
	injectComponentData(record, row.tipo, sourceModel, splitComposed(componentItems.items).main);
	await injectSnapshotSlots(record, row.tipo, componentItems.items, declaredSlots);
	return null;
}

/**
 * The items a per-component snapshot lands under its own tipo. A RELATION-column
 * model's datum passes the shape gate first (relation_snapshot_shape.ts): a
 * non-locator shape is REFUSED, never converted — the own column stays empty
 * (the dd1574 copy keeps the raw bytes) and the caller flags the cell. Wrapping
 * a bare `2` as `[2]` is how a pre-v6 id used to reach compareLocators and 500
 * the whole history read.
 */
function componentSnapshotItems(
	row: TimeMachineRow,
	sourceModel: string,
	dataParsed: unknown[] | null,
): RelationSnapshotShape {
	if (getColumnNameByModel(sourceModel) !== 'relation') {
		return { kind: 'locators', items: dataParsed };
	}
	return classifyRelationSnapshot(row.data);
}

/** Whether the row's component is a credential (descriptor `secretValue`). */
function isSecretModel(model: string | null): boolean {
	return model !== null && getComponentModel(model)?.secretValue === true;
}

/** A per-component snapshot as items (PHP coerces a non-array datum to [datum]). */
function snapshotItems(data: unknown): unknown[] | null {
	if (Array.isArray(data)) return data;
	return data === null ? null : [data];
}

/** Whether a model maps to a real jsonb column (component_section_id does not). */
function hasStorableColumn(model: string | null): model is string {
	if (model === null) return false;
	const column = getColumnNameByModel(model);
	return column !== null && MATRIX_JSONB_COLUMNS.includes(column as MatrixJsonbColumn);
}

/** Each slot's frames of the snapshot's main, under the slot (a slot with none stays absent). */
async function injectSnapshotSlots(
	record: MatrixRecord,
	mainTipo: string,
	data: unknown,
	declaredSlots: readonly string[],
): Promise<void> {
	for (const [slot, frames] of await snapshotSlotFrames(mainTipo, data, declaredSlots)) {
		if (frames.length > 0) injectComponentData(record, slot, DATAFRAME_MODEL, frames);
	}
}

/**
 * Reconstruct the virtual dd15 section record for one TM row. `lang` selects
 * the term-label language for the dd577/dd1772 fields (PHP uses the fixed data
 * lang; the caller passes the request lang for list rendering parity).
 * `declaredSlots` are the row main's dataframe slots
 * (relations/dataframe_slots.ts resolveDataframeSlotTipos — passed in, since
 * that module builds on this one): they attribute a legacy frame that names no
 * slot (snapshotSlotFrames).
 */
export async function buildTmSectionRecord(
	row: TimeMachineRow,
	lang: string,
	declaredSlots: readonly string[] = [],
): Promise<MatrixRecord> {
	return (await buildTmSectionRecordWithRefusal(row, lang, declaredSlots)).record;
}

/**
 * A component cell the builder could NOT project: the row's own tipo held a
 * relation value that is not a locator array (relation_snapshot_shape.ts). The history reader renders it as a flagged
 * cell carrying `reason` (read_tm.ts) — never a silent empty, never a 500.
 */
export interface TmRecordRefusal {
	readonly tipo: string;
	readonly reason: string;
}

/** buildTmSectionRecord + the refused own-tipo cell, when there is one. */
export async function buildTmSectionRecordWithRefusal(
	row: TimeMachineRow,
	lang: string,
	declaredSlots: readonly string[] = [],
): Promise<{ record: MatrixRecord; refusal: TmRecordRefusal | null }> {
	const record = makeVirtualRecord(TIME_MACHINE_SECTION_TIPO, row.id);
	let refusal: TmRecordRefusal | null = null;

	// --- data (the snapshot) — done first so the meta overlay merges cleanly ---
	const sourceModel = await getModelByTipo(row.tipo);
	if (sourceModel === 'section' && row.data !== null && typeof row.data === 'object') {
		// The snapshot IS a full matrix-record columns object; adopt each of its
		// component columns wholesale (structural 'data'/'id' are not components).
		for (const [column, components] of Object.entries(row.data as Record<string, unknown>)) {
			if (column === 'data' || column === 'id') continue;
			if (MATRIX_JSONB_COLUMNS.includes(column as MatrixJsonbColumn) && components != null) {
				injectColumnData(record, column as MatrixJsonbColumn, components);
			}
		}
	} else {
		refusal = await injectComponentSnapshot(record, row, sourceModel, declaredSlots);
	}

	// --- id / who / when / where / what ---
	// dd1573 "Id" is the TM ROW's own PK — distinct from dd1212 "Section id", the
	// CALLER record's id. It was never injected, so the column could be filtered
	// and sorted but never rendered; now that every cell resolves from this record
	// (WC-2026-08-14-tm-cells-obey-list-emit-policy) it has to be here to exist.
	await injectTmField(record, TM_COLUMN_MATRIX_ID, [{ id: 1, value: Number(row.id) }]);
	await injectTmField(record, TM_COLUMN_SECTION_ID, [{ id: 1, value: Number(row.section_id) }]);
	await injectTmField(record, TM_COLUMN_TIMESTAMP, [
		{ id: 1, start: ddDateFromTimestamp(row.timestamp) },
	]);
	// What (dd577) and Where (dd1772) are both ONTOLOGY TIPOS stored as values, so
	// both render «term» [tipo] — the tipo is what makes the label unambiguous when
	// two nodes share a term. Only dd577 used to get the suffix, and only because
	// the emitter special-cased it; dd1772 rendered a bare term. One helper now
	// serves both (and the dd542 activity twin, dd546, which does the same thing).
	await injectTmField(record, TM_COLUMN_TIPO, [
		{ id: 1, lang: 'lg-nolan', value: await ontologyTermLabel(row.tipo, lang) },
	]);
	await injectTmField(record, TM_COLUMN_SECTION_TIPO, [
		{ id: 1, lang: 'lg-nolan', value: await ontologyTermLabel(row.section_tipo, lang) },
	]);

	// user locator (PHP reuses the SAME object for dd578 and dd200 — from_component_tipo stays dd578).
	const userLocator = {
		id: 1,
		type: RELATION_TYPE_LINK,
		// `row.user_id` is an int column — the locator carries the address itself
		// (WC-2026-08-10-section-id-int-canonical repeals the String() minting).
		section_id: row.user_id,
		section_tipo: USERS_SECTION_TIPO,
		from_component_tipo: TM_COLUMN_USER_ID,
	};
	await injectTmField(record, TM_COLUMN_USER_ID, [userLocator]);
	await injectTmField(record, CREATED_BY_USER, [userLocator]);

	await injectTmField(record, TM_COLUMN_BULK_PROCESS_ID, [
		{ id: 1, value: bulkProcessValue(row.bulk_process_id) },
	]);

	// annotation (rsc329): the rsc832/rsc835 notes lookup (PHP tm_record :690-755).
	await injectTmField(record, TM_NOTES_TEXT, await tmNoteValue(row.id));

	return { record, refusal };
}
