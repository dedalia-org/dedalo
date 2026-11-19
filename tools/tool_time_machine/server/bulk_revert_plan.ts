/**
 * BULK REVERT — the PLAN: what a run's undo log says, grouped into the keys and
 * units the revert works on (2026-09-27, WC-…-bulk-revert-undo-log §2.5 steps
 * 2-5). Pure over the rows it is handed plus ontology lookups; no matrix read,
 * no write.
 *
 * THE ROWS. Every `matrix_time_machine` row carrying the run's bulk id, every
 * role (time_machine.ts TM_ROLE), id ASC:
 *   - role 1 (BEFORE) and role NULL (the visible after-row, or a legacy run's
 *     only row) on a COMPONENT tipo → one KEY per component region;
 *   - role 3 → a record the run CREATED (decision D2, bulk_revert_records.ts);
 *   - role 4 → a record the run's dataframe cascade WIPED, or a revert's D2
 *     DELETED (decision D3).
 * A row on a non-component tipo that is neither (a section snapshot, a model
 * the ontology no longer resolves) is not the revert's to replay — the section
 * restore is apply_value's — and is ignored, as it always was.
 *
 * THE KEY. (section_tipo, section_id, tipo, lang) for a lang-sliced model —
 * one language's region — and (section_tipo, section_id, tipo) for every other
 * model: an unsliced key (every relation, whatever its ontology `translatable`
 * flag) has ONE lane, lg-nolan (relations/main_lanes.ts laneLaw, decision
 * 2026-09-29), whatever tag a row carries. The
 * model is read at REVERT time (the predicate the region is cut with must be
 * the one the live key is written with). Each key is reverted once, however
 * many rows it has — the defect of the row-per-row loop this replaces.
 *
 * THE UNIT. A dataframe main is ONE unit with its frames (two lanes,
 * 2026-09-28): its language pairs hold a language's region, its lg-nolan pairs
 * the lg-nolan region followed by every slot's full frames
 * (relations/dataframe_slots.ts recordMainHistory). An EXACT key (it has BEFORE
 * rows) of a main that HAS slots — declared, or named by a frame ANY row of the
 * main carries (decided per main ADDRESS, never per key: a language key's rows
 * carry no frame) — is the main's ADDRESS unit, every lane of it together
 * (bulk_revert_composed.ts restores it lane by lane, in one transaction). A
 * unit of a main with slots — composed or legacy — carries the slot tipos it
 * may write (`slotTipos`), which the scope gate checks like the main's own
 * tipo (a slot has no key of its own to be gated by). No column marks a
 * composed row (decision 2026-09-28): the ontology and the rows decide. A
 * LEGACY (PHP-era) key of a main with slots is the main's LEGACY unit, every
 * language tag of it together (`address|legacy`, lg-nolan slot saves
 * included): its frames are language-blind state, so the legacy path restores
 * and conflict-checks them ONCE per main (bulk_revert_legacy.ts, its last key
 * carries the frame half) — split per tag, one tag's unit rewound frames a
 * sibling tag's unit then read as a post-run edit. Every other key is a unit of
 * its own: `address|lang` for a lang-sliced model, `address` otherwise. A row on a dataframe SLOT tipo, BEFORE
 * or not, is TS-era beta history (PHP never wrote one; a slot save records under
 * its main): refused `failed`, logged, never replayed.
 *
 * THE ORDER. Units are listed NEWEST FIRST (by their newest row id), and a
 * composed unit's lanes are undone newest first too: an undo log is undone
 * in reverse.
 */

import { AUDIT_TIPOS } from '../../../src/core/concepts/section.ts';
import type { MatrixJsonbColumn } from '../../../src/core/db/matrix.ts';
import { TM_ROLE } from '../../../src/core/db/time_machine.ts';
import { getModelByTipo } from '../../../src/core/ontology/resolver.ts';
import {
	resolveDataframeSlotTipos,
	splitComposed,
} from '../../../src/core/relations/dataframe_slots.ts';
import { NOLAN } from '../../../src/core/relations/main_lanes.ts';
import { isLangSlicedModel } from '../../../src/core/section/record/save_component.ts';
import type { BulkRevertInexactBasis, BulkRevertSkipReason } from './bulk_revert.ts';
import type { DataframeSlotRestore, FrameSlice } from './dataframe_restore.ts';

const DATAFRAME_MODEL = 'component_dataframe';

/** One row of the run, as the loader selects it (every role). */
export interface RunRow {
	id: number;
	section_id: number;
	section_tipo: string;
	tipo: string;
	/** NULLABLE — pre-migration rows carry no language. */
	lang: string | null;
	data: unknown;
	/** `data IS NULL` — tells an ABSENT image from a stored JSON null (TM_IMAGE_ABSENT_COLUMN). */
	data_absent: boolean;
	tm_role: number | null;
}

/** One component region the run wrote. */
export interface RevertKey {
	sectionTipo: string;
	sectionId: number;
	tipo: string;
	model: string;
	sliced: boolean;
	/**
	 * The region's language for a sliced key; lg-nolan for an unsliced one (its
	 * one lane — the tag the revert's own pair is written under). '' when a
	 * legacy sliced key's rows name no language (refused as `no_lang`).
	 */
	lang: string;
	/** The run's rows of this key, id ASC — roles 1 and NULL only. */
	rows: RunRow[];
	/** True when the key has a BEFORE row: the exact path. Else the legacy path. */
	exact: boolean;
	/** True for an EXACT key of a main with slots: the composed unit (see the header). */
	composed: boolean;
	/** True for a LEGACY key of a main with slots: the main's legacy unit (see the header). */
	framed: boolean;
}

/** A composed unit's main. */
export interface ComposedUnit {
	mainTipo: string;
}

/** Keys reverted together in one transaction. */
export interface RevertUnit {
	sectionTipo: string;
	sectionId: number;
	/**
	 * One key — or, for a composed or legacy main, one key per language of it
	 * (a legacy unit's keys newest first: its LAST key carries the frame half).
	 */
	keys: RevertKey[];
	/** Set for a dataframe main's composed unit (bulk_revert_composed.ts). */
	composed: ComposedUnit | null;
	/**
	 * The slots a composed or legacy (framed) unit may write: declared slots ∪
	 * every slot a run row's frame names (model-checked) — scope-gated (level 2
	 * on each). A write to any other slot: composed unit → refused `failed`;
	 * legacy frame half → written only on the caller's level-2 grant on that
	 * slot, else `out_of_scope` (bulk_revert_legacy.ts assertSlotGrants).
	 * [] for a unit of a main without slots.
	 */
	slotTipos: string[];
}

/** A record-level marker of the run (a birth, or a cascade wipe / D2 delete). */
export interface RecordMarker {
	sectionTipo: string;
	sectionId: number;
	row: RunRow;
}

export interface RunPlan {
	units: RevertUnit[];
	births: RecordMarker[];
	cascadeDeletes: RecordMarker[];
	/** `section_tipo|section_id|tipo` of every component key the run wrote. */
	keyAddresses: ReadonlySet<string>;
	/** Rows or keys the plan could not place — reported `failed`, never reverted. */
	unplanned: Unplanned[];
}

/** The address of one component key of one record, language aside. */
export function keyAddress(sectionTipo: string, sectionId: number, tipo: string): string {
	return `${sectionTipo}|${sectionId}|${tipo}`;
}

/** The record's MODIFIED stamps (dd197 user, dd201 date). */
export const MODIFIED_STAMPS: readonly string[] = [
	AUDIT_TIPOS.modifiedByUser,
	AUDIT_TIPOS.modifiedDate,
];

/**
 * Whether the run wrote a MODIFIED stamp of this record itself (a CSV import
 * that carries dd197/dd201 as columns saves with the stamp suppressed, so those
 * keys have their own undo pairs). Then no write of the revert to that record
 * may stamp it: the stamp would overwrite the value a stamp unit restores, or
 * move a stamp another run pair still expects at its after-image — refused
 * `changed_since_run`. The stamp keys are restored by their own units.
 */
export function runOwnsRecordStamps(
	keyAddresses: ReadonlySet<string>,
	sectionTipo: string,
	sectionId: number,
): boolean {
	return MODIFIED_STAMPS.some((stamp) =>
		keyAddresses.has(keyAddress(sectionTipo, sectionId, stamp)),
	);
}

/** The address of one record. */
export function recordAddress(sectionTipo: string, sectionId: number): string {
	return `${sectionTipo}|${sectionId}`;
}

/**
 * The one language a legacy row speaks for when its `lang` column is empty:
 * the language its items name, when they name exactly one. '' otherwise.
 */
function legacyRowLang(row: RunRow): string {
	if (row.lang !== null && row.lang !== '') return row.lang;
	const langs = new Set<string>();
	for (const item of Array.isArray(row.data) ? row.data : []) {
		const itemLang = (item as { lang?: unknown } | null)?.lang;
		if (typeof itemLang === 'string' && itemLang !== '') langs.add(itemLang);
	}
	return langs.size === 1 ? ([...langs][0] as string) : '';
}

/**
 * A row, or a key, the plan could not place (its model or its dataframe slots
 * failed to resolve). Reported `failed` with the reason ALONE — no coordinates
 * and no error code: the plan runs before any scope gate, so no verdict over
 * its record has passed (owner ruling 2026-11-18, TM Q3) — and the text goes
 * to the log only. It therefore keeps nothing of the error but that text.
 */
export interface Unplanned {
	sectionTipo: string;
	sectionId: number;
	detail: string;
}

/** A model lookup that THREW, kept per tipo: its text, for the log. */
interface FailedModel {
	failed: string;
}

/** The text of a thrown value, for the LOG. */
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The model of a tipo, memoized per plan; a throw is kept as its text. */
async function modelOf(
	models: Map<string, string | null | FailedModel>,
	tipo: string,
): Promise<string | null | FailedModel> {
	if (!models.has(tipo)) {
		try {
			models.set(tipo, await getModelByTipo(tipo));
		} catch (error) {
			models.set(tipo, { failed: errorText(error) });
		}
	}
	return models.get(tipo) ?? null;
}

/** Group the component rows into keys (see the header). */
async function groupKeys(rows: readonly RunRow[], unplanned: Unplanned[]): Promise<RevertKey[]> {
	const models = new Map<string, string | null | FailedModel>();
	const keys = new Map<string, RevertKey>();
	const failed = new Set<string>();
	for (const row of rows) {
		const address = keyAddress(row.section_tipo, row.section_id, row.tipo);
		const model = await modelOf(models, row.tipo);
		if (model !== null && typeof model === 'object') {
			if (!failed.has(address)) {
				failed.add(address);
				unplanned.push({
					sectionTipo: row.section_tipo,
					sectionId: row.section_id,
					detail: model.failed,
				});
			}
			continue;
		}
		if (model === null || !model.startsWith('component_')) continue;
		const sliced = isLangSlicedModel(model);
		const lang = sliced ? legacyRowLang(row) : NOLAN;
		const id = sliced ? `${address}|${lang}` : address;
		const key = keys.get(id) ?? {
			sectionTipo: row.section_tipo,
			sectionId: row.section_id,
			tipo: row.tipo,
			model,
			sliced,
			lang,
			rows: [],
			exact: false,
			composed: false,
			framed: false,
		};
		key.rows.push(row);
		if (row.tm_role === TM_ROLE.before) key.exact = true;
		keys.set(id, key);
	}
	const grouped = [...keys.values()];
	const slotted = await slottedAddresses(grouped);
	for (const key of grouped) {
		const inSlottedMain = slotted.has(keyAddress(key.sectionTipo, key.sectionId, key.tipo));
		key.composed = key.exact && inSlottedMain;
		key.framed = !key.exact && inSlottedMain;
	}
	return grouped;
}

/**
 * The MAIN addresses with slots — decided per ADDRESS, never per key: under
 * the two lanes a language key's rows never carry a frame, so a main whose slot
 * is undeclared (a dataframe only a parent's request_config names) is slotted
 * only through its lg-nolan key. Decided per key, its language keys fell out of
 * the unit and were reverted alone — no LIFO lanes, no orphan check: an item
 * removed while its frame (edited after the run) stayed, half a main reverted.
 */
async function slottedAddresses(keys: readonly RevertKey[]): Promise<Set<string>> {
	const slotted = new Set<string>();
	for (const key of keys) {
		const address = keyAddress(key.sectionTipo, key.sectionId, key.tipo);
		if (!slotted.has(address) && (await isSlottedMainKey(key))) slotted.add(address);
	}
	return slotted;
}

/**
 * Whether a key is a MAIN with slots: its main declares a slot, or a row of it
 * carries a frame. Resolved here, from the ontology and the rows — no column
 * marks a composed row. A slot key is never one.
 */
async function isSlottedMainKey(key: RevertKey): Promise<boolean> {
	if (key.model === DATAFRAME_MODEL) return false;
	if (key.rows.some((row) => splitComposed(row.data).frames.length > 0)) return true;
	try {
		return (await resolveDataframeSlotTipos(key.tipo)).length > 0;
	} catch {
		// Unresolvable slots: attachSlots reports an exact key `failed`; a
		// legacy key stays a unit of its own and fails in its own plan.
		return key.exact;
	}
}

/** The slot tipos a row's frames name (`from_component_tipo`), in first-seen order. */
function namedSlots(rows: readonly RunRow[]): string[] {
	const named: string[] = [];
	for (const row of rows) {
		for (const entry of splitComposed(row.data).frames) {
			const from = entry.from_component_tipo;
			if (typeof from === 'string' && from !== '' && !named.includes(from)) named.push(from);
		}
	}
	return named;
}

/**
 * The slots a unit may write: the main's declared slots ∪ every slot its rows'
 * frames name, when that tipo is a dataframe (a frame naming anything else
 * names no slot — dataframe_restore.ts's rule).
 */
async function unitSlotTipos(mainTipo: string, rows: readonly RunRow[]): Promise<string[]> {
	const slots = [...(await resolveDataframeSlotTipos(mainTipo))];
	for (const tipo of namedSlots(rows)) {
		if (!slots.includes(tipo) && (await getModelByTipo(tipo)) === DATAFRAME_MODEL) slots.push(tipo);
	}
	return slots;
}

/** The unit id of a key (see the header). */
function unitIdOf(key: RevertKey): string {
	const address = keyAddress(key.sectionTipo, key.sectionId, key.tipo);
	if (key.composed) return address;
	if (key.framed) return `${address}|legacy`;
	return key.sliced ? `${address}|${key.lang}` : address;
}

/** A key the plan refuses outright, or null. */
function unplaceable(key: RevertKey): string | null {
	if (key.model === DATAFRAME_MODEL) {
		return `run rows of dataframe slot ${describeKey(key)}: a slot never has history of its own (TS-era beta shape, unsupported)`;
	}
	return null;
}

/**
 * Attach a slotted unit's gated slot set (and, composed, its main); a main
 * whose slots cannot be resolved leaves the plan.
 */
async function attachSlots(unit: RevertUnit, unplanned: Unplanned[]): Promise<boolean> {
	const key = unit.keys[0] as RevertKey;
	try {
		const rows = unit.keys.flatMap((member) => member.rows);
		unit.slotTipos = await unitSlotTipos(key.tipo, rows);
		if (key.composed) unit.composed = { mainTipo: key.tipo };
		return true;
	} catch (error) {
		unplanned.push({
			sectionTipo: key.sectionTipo,
			sectionId: key.sectionId,
			detail: errorText(error),
		});
		return false;
	}
}

/** Group the keys into units (see the header), newest first. */
async function groupUnits(keys: RevertKey[], unplanned: Unplanned[]): Promise<RevertUnit[]> {
	const units = new Map<string, RevertUnit>();
	for (const key of keys) {
		const refusal = unplaceable(key);
		if (refusal !== null) {
			unplanned.push({ sectionTipo: key.sectionTipo, sectionId: key.sectionId, detail: refusal });
			continue;
		}
		const unitId = unitIdOf(key);
		const unit = units.get(unitId) ?? {
			sectionTipo: key.sectionTipo,
			sectionId: key.sectionId,
			keys: [],
			composed: null,
			slotTipos: [],
		};
		unit.keys.push(key);
		units.set(unitId, unit);
	}
	const planned: RevertUnit[] = [];
	for (const unit of units.values()) {
		const main = unit.keys[0] as RevertKey;
		// A legacy unit's languages newest first (an undo log is undone in
		// reverse); its LAST key carries the frame half, after every main region.
		if (main.framed) unit.keys.sort((a, b) => keyNewestRow(b) - keyNewestRow(a));
		const slotted = main.composed || main.framed;
		if (!slotted || (await attachSlots(unit, unplanned))) planned.push(unit);
	}
	// LIFO: the unit whose newest row is newest is undone first (a lang-less
	// orphan belongs to every language's region, so the languages of one key
	// are not independent — undo them in reverse).
	return planned.sort((a, b) => unitNewestRow(b) - unitNewestRow(a));
}

/** The id of a key's newest row. */
function keyNewestRow(key: RevertKey): number {
	return key.rows.at(-1)?.id ?? 0;
}

/** The id of a unit's newest row — its place in the run's write order. */
export function unitNewestRow(unit: RevertUnit): number {
	return Math.max(...unit.keys.map(keyNewestRow));
}

/**
 * The key a unit's report entry is located at: its key — for a composed unit
 * (every language of the main at once), its main WITHOUT a language.
 */
export function unitReportKey(unit: RevertUnit): RevertKey {
	const key = unit.keys[0] as RevertKey;
	return unit.composed === null ? key : { ...key, sliced: false, lang: '' };
}

/** Build the plan of a run from its rows (id ASC, every role). */
export async function planRun(rows: readonly RunRow[]): Promise<RunPlan> {
	const births: RecordMarker[] = [];
	const cascadeDeletes: RecordMarker[] = [];
	const componentRows: RunRow[] = [];
	for (const row of rows) {
		const marker = { sectionTipo: row.section_tipo, sectionId: row.section_id, row };
		if (row.tm_role === TM_ROLE.birth) births.push(marker);
		else if (row.tm_role === TM_ROLE.cascadeDelete) cascadeDeletes.push(marker);
		else componentRows.push(row);
	}
	const unplanned: Unplanned[] = [];
	const keys = await groupKeys(componentRows, unplanned);
	const keyAddresses = new Set(
		keys.map((key) => keyAddress(key.sectionTipo, key.sectionId, key.tipo)),
	);
	const units = await groupUnits(keys, unplanned);
	return { units, births, cascadeDeletes, keyAddresses, unplanned };
}

/** What one key's revert will do. */
export type KeyPlan =
	| { kind: 'unchanged' }
	| {
			kind: 'write';
			/** The key value to write; `undefined` removes the key. */
			value: unknown;
			/** Slot frame sets to write first (legacy composed snapshots only). */
			framePlan: DataframeSlotRestore[];
			/** A lang-sliced key's item scope for its frames (dataframe_restore.ts), null = whole. */
			frameSlice?: FrameSlice | null;
			/** Why this write is not an exact inverse, or null when it is. */
			inexact: BulkRevertInexactBasis | null;
	  };

/**
 * A key the revert refuses — raised INSIDE the unit's transaction so the whole
 * unit rolls back, then mapped onto the closed skip vocabulary. The message is
 * LOG-only (it may name tipos and slots); the wire carries the reason alone.
 */
export class RevertRefusal extends Error {
	constructor(
		readonly reason: BulkRevertSkipReason,
		readonly key: RevertKey,
		detail: string,
		/** The cascade target whose undelete refused the unit, when that is the cause. */
		readonly marker?: RecordMarker,
	) {
		super(detail);
	}
}

/** Where a key is stored. */
export interface KeyTarget {
	table: string;
	column: MatrixJsonbColumn;
}

/** The coordinates of a key for the LOG (never the wire). */
export function describeKey(key: RevertKey): string {
	return `${key.sectionTipo}/${key.tipo}#${key.sectionId}${key.sliced ? `@${key.lang}` : ''}`;
}
