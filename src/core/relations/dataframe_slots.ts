/**
 * DATAFRAME SLOTS OF A MAIN — discovery, the frame-lane image, and the ONE
 * writer of a main's history (2026-09-28, WC …-bulk-revert-undo-log, addendum
 * "two lanes"; the lane law is relations/main_lanes.ts).
 *
 * A main component and the frames of its dataframe slots are ONE unit of
 * meaning: a frame pairs with a main ITEM (`id_key → id`), so neither half can
 * be read, restored or reverted without the other. The frames do not live in
 * the main's key — they live in `relation[<slot tipo>]` — so the history of the
 * main records them in its lg-nolan FRAME LANE: that row's image is the main's
 * lg-nolan value followed by the FULL content of every slot of the main (every
 * main's frames in a shared slot, as PHP stored it — composeTmData). A
 * LANGUAGE row holds that language's value only. A save of a SLOT writes no
 * history under the slot tipo: it writes ONE lg-nolan row of the main(s) the
 * change belongs to (`attributeSlotMains`), never a copy per language.
 *
 * A FRAME-STATE row (lg-nolan, or a PHP-era row carrying frames) is the FULL
 * frame state of the main: a slot it is silent about was EMPTY at that time
 * (`rowSlotTipos`), and a restore empties it. No marker, no epoch; TS-era beta
 * rows are unsupported. A main with NO slot composes nothing: its rows are its
 * values alone.
 *
 * THE SLOT SET of a main M (deliberately a union, see
 * WC-2026-08-09-time-machine-restore-replays-paired-dataframe-frames):
 *   - ontology children of M with model `component_dataframe`;
 *   - the ddos of M's OWN request_config (show AND hide) resolving to that model;
 *   - the model's FIXED frames (descriptor `fixedDataframeTipos` — component_iri
 *     always pairs with dd560, which is neither its child nor in its config);
 *   - every key of the record's relation bag holding a frame whose
 *     `main_component_tipo` is M (model-checked) — a slot discovery missed
 *     still carries M's frames, and leaving it out would drop them from history;
 *   - the caller's slot (a slot save always composes the slot it wrote).
 * Order: declared first, then extras in the caller's order, then discovered
 * keys sorted — stable, so two images of one main compose comparably.
 *
 * ABSENCE: the image is `undefined` only when the main region is absent AND no
 * slot holds a frame (concepts/lang_region.ts, the one absence law).
 */

import { getComponentModel, isLangSlicedModel } from '../components/registry.ts';
import { canonicalJson } from '../concepts/canonical_json.ts';
import { DATAFRAME_RELATION_TYPE } from '../concepts/subdatum.ts';
import { MATRIX_JSONB_COLUMNS, type MatrixJsonbColumn } from '../db/matrix.ts';
import { sql } from '../db/postgres.ts';
import { readFrameStateRowAt, recordBulkPair, recordTimeMachine } from '../db/time_machine.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import {
	effectiveSaveLang,
	getColumnNameByModel,
	getModelByTipo,
	getNode,
	getPropertiesByTipo,
	getTranslatableByTipo,
} from '../ontology/resolver.ts';
import { currentDataLang } from '../resolve/request_lang.ts';
import { getDataframeChildTipos } from '../section/list_definitions/section_list.ts';
import {
	type LaneLaw,
	laneHoldsValue,
	laneLaw,
	laneRegion,
	laneVisible,
	NOLAN,
	restoreLane,
	rowLaneItems,
	valueLanesOf,
} from './main_lanes.ts';

const DATAFRAME_MODEL = 'component_dataframe';

/** The record a composition reads (the matrix row of the main). */
export interface SlotTarget {
	table: string;
	sectionTipo: string;
	sectionId: number;
}

/** A main's slot tipos, in composition order, and each slot's stored image (`undefined` = absent). */
export interface SlotImages {
	slots: readonly string[];
	images: Readonly<Record<string, unknown>>;
}

/**
 * PHP `component_common::is_dataframe_entry` — the dual read: the unified dd490
 * marker OR the legacy pairing-key shape. The ONE frame predicate of every TM
 * reader (splitComposed), so a composed image partitions exactly.
 */
export function isFrameEntry(entry: unknown): entry is Record<string, unknown> {
	if (entry === null || typeof entry !== 'object') return false;
	const candidate = entry as { type?: unknown; main_component_tipo?: unknown };
	return candidate.type === DATAFRAME_RELATION_TYPE || candidate.main_component_tipo !== undefined;
}

/**
 * Whether a frame is `mainTipo`'s OWN (decision D-A): it names the main, or
 * names none (an unstamped legacy frame). A shared slot stores every main's
 * frames; a frame naming ANOTHER main is that main's history, never restored,
 * checked or dropped on this main's behalf.
 */
export function isOwnFrame(frame: Record<string, unknown>, mainTipo: string): boolean {
	const main = frame.main_component_tipo;
	return main === mainTipo || main === undefined || main === null || main === '';
}

/**
 * A slot's content with `mainTipo`'s frames REPLACED — the one restore rule of
 * every door (apply_value, the legacy and the composed bulk revert): every
 * entry that is not the main's own frame stays in place, the main's live frames
 * `keep` retains stay too (a lang-sliced restore keeps the frames of the items
 * it does not restore), and `recorded` goes where the main's first live frame
 * stood (appended when it had none).
 */
export function restoreSlot(
	live: unknown,
	mainTipo: string,
	recorded: readonly unknown[],
	keep: (frame: Record<string, unknown>) => boolean = () => false,
): unknown[] {
	const out: unknown[] = [];
	let placed = false;
	for (const entry of framesOf(live)) {
		if (!isOwnFrameEntry(entry, mainTipo)) {
			out.push(entry);
			continue;
		}
		if (!placed) out.push(...recorded);
		placed = true;
		if (keep(entry)) out.push(entry);
	}
	return placed ? out : [...out, ...recorded];
}

/** The `id` of every object item of a value, as the `id_key` pairing string. */
export function heldItemIds(value: unknown): Set<string> {
	const ids = new Set<string>();
	for (const item of framesOf(value)) {
		const id = (item as { id?: unknown } | null)?.id;
		if (typeof id === 'number' || (typeof id === 'string' && id !== '')) ids.add(String(id));
	}
	return ids;
}

/**
 * THE PAIRING LAW OF A RESTORED FRAME — one predicate for apply_value and the
 * bulk revert, so the two doors agree on the same row. A recorded frame is
 * STALE (never written back) when its `id_key` named an item of ANOTHER
 * language the history knew (`otherLangIds`, time_machine.ts
 * readOtherLangItemIds) that the restored value no longer holds (`heldIds`):
 * that item was deleted since, and its frame would be an orphan the UI can
 * neither show nor delete. A frame whose key named no known item was saved
 * before its item (frame-first — the save order is the curator's) and comes
 * back like any other.
 */
export function isStaleItemFrame(
	frame: Record<string, unknown>,
	otherLangIds: ReadonlySet<string>,
	heldIds: ReadonlySet<string>,
): boolean {
	const key = frame.id_key;
	if (key === undefined || key === null || key === '') return false;
	return otherLangIds.has(String(key)) && !heldIds.has(String(key));
}

/** A slot entry that is a frame of `mainTipo` (isFrameEntry ∧ isOwnFrame). */
function isOwnFrameEntry(entry: unknown, mainTipo: string): entry is Record<string, unknown> {
	return isFrameEntry(entry) && isOwnFrame(entry, mainTipo);
}

/** The ddo tipos of one request_config block's ddo_map. */
function blockDdoTipos(block: { ddo_map?: unknown } | null | undefined): string[] {
	const map = block?.ddo_map;
	if (!Array.isArray(map)) return [];
	return map
		.map((ddo) => (ddo as { tipo?: unknown } | null)?.tipo)
		.filter((tipo): tipo is string => typeof tipo === 'string');
}

/** Every `tipo` named by a ddo of the component's OWN request_config (show AND hide). */
function ownConfigDdoTipos(properties: unknown): string[] {
	const config = (properties as { source?: { request_config?: unknown } } | null)?.source
		?.request_config;
	if (!Array.isArray(config)) return [];
	return config.flatMap((item) => {
		const bag = item as Record<string, { ddo_map?: unknown }> | null;
		return [...blockDdoTipos(bag?.show), ...blockDdoTipos(bag?.hide)];
	});
}

/** The candidates that resolve to a dataframe slot, deduplicated, in order. */
async function dataframeTiposOf(candidates: readonly string[]): Promise<string[]> {
	const slots: string[] = [];
	for (const tipo of candidates) {
		if (slots.includes(tipo)) continue;
		if ((await getModelByTipo(tipo)) === DATAFRAME_MODEL) slots.push(tipo);
	}
	return slots;
}

/**
 * The DECLARED dataframe slot tipos of a main component (PHP
 * `get_dataframe_ddo`, broadened — see the header): ontology children with
 * model `component_dataframe` ∪ own-config ddos (show AND hide) ∪ the model's
 * fixed frames (`fixedDataframeTipos`), each kept only when it resolves to that
 * model.
 */
export async function resolveDataframeSlotTipos(mainTipo: string): Promise<string[]> {
	const mainModel = await getModelByTipo(mainTipo);
	return dataframeTiposOf([
		...(await getDataframeChildTipos(mainTipo)),
		...ownConfigDdoTipos(await getPropertiesByTipo(mainTipo)),
		...(getComponentModel(mainModel ?? '')?.fixedDataframeTipos ?? []),
	]);
}

/**
 * The slots of a main a set of history rows speaks for: the main's slots as
 * the LIVE record holds them (readMainSlots — the declared set plus every key
 * holding one of the main's frames, the set the capture composes) plus every
 * dataframe slot a row's frames name (`from_component_tipo`, any main's frame,
 * model-checked). THE ONE READING RULE (decision 2026-09-28): a row is the full
 * state of the main and all its dataframes, so a slot it is silent about was
 * EMPTY then — every slot returned here is written by a restore, an undeclared
 * live one included (the composed revert empties it too). `live` is the
 * record, read inside the caller's transaction (under its lock, for a write).
 */
export async function rowSlotTipos(
	mainTipo: string,
	rows: readonly unknown[],
	live: SlotTarget,
): Promise<string[]> {
	const named = rows.flatMap((data) =>
		splitComposed(data).frames.flatMap((frame) => {
			const from = frame.from_component_tipo;
			return typeof from === 'string' && from !== '' ? [from] : [];
		}),
	);
	return dataframeTiposOf([...(await readMainSlots(live, mainTipo)).slots, ...named]);
}

/** Whether a stored slot value holds a frame of `mainTipo`. */
function holdsFramesOf(value: unknown, mainTipo: string): boolean {
	return (
		Array.isArray(value) &&
		value.some((entry) => isFrameEntry(entry) && entry.main_component_tipo === mainTipo)
	);
}

/**
 * The slot set + images of `mainTipo` out of a relation bag that holds (at
 * least) every candidate key. Declared and `extraSlots` keys are slots whatever
 * they hold; any other key is one only when it holds a frame of the main AND its
 * tipo is a `component_dataframe`.
 */
async function selectSlots(
	mainTipo: string,
	bag: Readonly<Record<string, unknown>>,
	extraSlots: readonly string[],
): Promise<SlotImages> {
	const slots = [...(await resolveDataframeSlotTipos(mainTipo))];
	for (const tipo of extraSlots) if (!slots.includes(tipo)) slots.push(tipo);
	slots.push(...(await discoveredSlots(mainTipo, bag, slots)));
	const images: Record<string, unknown> = {};
	for (const slot of slots) images[slot] = bag[slot] ?? undefined;
	return { slots, images };
}

/** Keys of `bag` beyond `known` holding a frame of the main whose tipo is a dataframe slot, sorted. */
async function discoveredSlots(
	mainTipo: string,
	bag: Readonly<Record<string, unknown>>,
	known: readonly string[],
): Promise<string[]> {
	const candidates = Object.keys(bag)
		.filter((key) => !known.includes(key) && holdsFramesOf(bag[key], mainTipo))
		.sort();
	const slots: string[] = [];
	for (const key of candidates) {
		if ((await getModelByTipo(key)) === DATAFRAME_MODEL) slots.push(key);
	}
	return slots;
}

/**
 * The slots of `mainTipo` out of an IN-MEMORY relation bag (a delete's locked
 * snapshot, an owner bag) — no I/O beyond the ontology.
 */
export async function slotsFromBag(
	mainTipo: string,
	bag: unknown,
	extraSlots: readonly string[] = [],
): Promise<SlotImages> {
	const record = bag !== null && typeof bag === 'object' ? (bag as Record<string, unknown>) : {};
	return selectSlots(mainTipo, record, extraSlots);
}

/** The relation column (the dataframe model's column), refused loudly when unmapped. */
function slotColumn(): MatrixJsonbColumn {
	const column = getColumnNameByModel(DATAFRAME_MODEL);
	if (column === null) {
		throw new DedaloError('internal.invariant', {
			message: 'dataframe slots: no matrix column for model component_dataframe',
		});
	}
	return column as MatrixJsonbColumn;
}

/**
 * The slots of `mainTipo` as STORED now — read inside the ambient transaction,
 * so under the caller's row lock it is the locked state. Reads only the
 * candidate keys (declared ∪ extra ∪ the keys holding one of the main's
 * frames), never the whole bag into JS.
 */
export async function readMainSlots(
	target: SlotTarget,
	mainTipo: string,
	extraSlots: readonly string[] = [],
): Promise<SlotImages> {
	const column = slotColumn();
	const named = [...(await resolveDataframeSlotTipos(mainTipo)), ...extraSlots];
	const rows = (await sql.unsafe(
		`SELECT e.key, e.value
		 FROM "${target.table}" t,
		      jsonb_each(CASE WHEN jsonb_typeof(t."${column}") = 'object' THEN t."${column}" ELSE '{}'::jsonb END) e
		 WHERE t.section_tipo = $1 AND t.section_id = $2
		   AND (e.key = ANY(string_to_array($3, ','))
		        OR e.value @> jsonb_build_array(jsonb_build_object('main_component_tipo', $4::text)))`,
		[target.sectionTipo, target.sectionId, named.join(','), mainTipo],
	)) as { key: string; value: unknown }[];
	const bag: Record<string, unknown> = {};
	for (const row of rows) bag[row.key] = row.value;
	return selectSlots(mainTipo, bag, extraSlots);
}

/**
 * The same slot set on both sides of a change: `before`'s order, then the slots
 * only `after` has. A slot missing on one side composes as absent there.
 */
export function alignSlots(before: SlotImages, after: SlotImages): [SlotImages, SlotImages] {
	const slots = [...before.slots, ...after.slots.filter((slot) => !before.slots.includes(slot))];
	const pick = (side: SlotImages): SlotImages => ({
		slots,
		images: Object.fromEntries(slots.map((slot) => [slot, side.images[slot]])),
	});
	return [pick(before), pick(after)];
}

/** Replace one slot's image (a slot save's BEFORE: the rest of the bag is unchanged by it). */
export function withSlotImage(slots: SlotImages, slotTipo: string, image: unknown): SlotImages {
	const list = slots.slots.includes(slotTipo) ? slots.slots : [...slots.slots, slotTipo];
	return { slots: list, images: { ...slots.images, [slotTipo]: image } };
}

/** A slot image as its frame list (absent / null / a non-array → none). */
function framesOf(image: unknown): unknown[] {
	if (Array.isArray(image)) return image;
	return image === undefined || image === null ? [] : [image];
}

/**
 * The COMPOSED image: the main region followed by every slot's full content, in
 * slot order. No frame → the main region unchanged (the row's empty frame part
 * then MEANS the slots were empty).
 */
export function composeTmData(mainRegion: unknown, slots: SlotImages): unknown {
	const frames = slots.slots.flatMap((slot) => framesOf(slots.images[slot]));
	if (frames.length === 0) return mainRegion;
	if (mainRegion === undefined || mainRegion === null) return frames;
	return Array.isArray(mainRegion) ? [...mainRegion, ...frames] : [mainRegion, ...frames];
}

/**
 * Split a composed image into its MAIN part and its FRAMES — an exact
 * partition by isFrameEntry, for EVERY model: the main part is every entry that
 * is not a frame. The ONE split of every snapshot reader — the TM preview
 * (section/read.ts), the dd15 list (tm_record.ts), apply_value and both bulk
 * reverts. (It replaced a per-model strip that, for component_iri, kept only
 * entries with an `iri` key: a v6 title-only iri item vanished from the list,
 * the preview and the restore, and its label frame with it.)
 * A frameless row splits into itself and no frames ("no frames at that
 * time"); a non-array image is all main.
 */
export function splitComposed(data: unknown): { main: unknown; frames: Record<string, unknown>[] } {
	if (!Array.isArray(data)) return { main: data, frames: [] };
	const entries = data.map(unwrapV6LiteralFrame);
	return {
		main: entries.filter((entry) => !isFrameEntry(entry)),
		frames: entries.filter(isFrameEntry),
	};
}

/**
 * A FRAMES-ONLY image of a lang-sliced main: a history row that speaks for NO
 * language of the main, so its main part restores nothing — the main stays
 * live, and only the row's frames come back. The ONE predicate of apply_value,
 * the TM preview (section/read.ts) and the legacy bulk path (the doors that read a v6 row), two v6 shapes:
 *   - a row of a TRANSLATABLE main tagged `lg-nolan`: a v6 SLOT save (PHP
 *     component_common::Save tags it with the dataframe's language). It carries
 *     the main in EVERY language plus the frames and is read as the lg-nolan
 *     lane (its lg-nolan items + its frames, the other languages' items
 *     ignored — main_lanes.ts rowLaneItems); a translatable main has no
 *     lg-nolan value, so the row restores its frames only. Merged as a slice,
 *     it appended lg-nolan copies of other languages beside the value's real
 *     languages;
 *   - a row whose items speak languages, none of them its tag: sliced by the
 *     tag it is empty, and every live item "survives".
 * A non-translatable sliced main (`lg-nolan` IS its language) is never one.
 */
export function isFramesOnlyImage(image: {
	sliced: boolean;
	translatable: boolean;
	rowLang: string;
	mainItems: readonly unknown[];
}): boolean {
	if (!image.sliced) return false;
	if (image.translatable && image.rowLang === 'lg-nolan') return true;
	const langOf = (item: unknown) => (item as { lang?: unknown } | null)?.lang;
	return (
		!image.mainItems.some((item) => langOf(item) === image.rowLang) &&
		image.mainItems.some((item) => typeof langOf(item) === 'string' && langOf(item) !== '')
	);
}

/**
 * A v6 LITERAL main's frame as the v6→v7 TM reformat left it, back in the
 * unified dd490 shape; every other entry verbatim. That reformat
 * (close_v6_prepare_v7 `v6_to_v7::migrate_component_data`, before its 2026-09-28
 * fix) ran over the whole composed row with the MAIN's model, so for a model
 * using the `value` property (component_input_text…) it wrapped each frame as
 * `{value: {legacy frame}, id, lang}` — and `dataframe_v7_migration` rewrites
 * only top-level entries, so the frame stayed legacy inside it. Read as a main
 * item, it restored frame junk into the literal's column and emptied its frames.
 * The inner frame is taken, and a legacy one migrated exactly as
 * `transform_entries` does for a literal main: `id_key` = `section_id_key`
 * (the literal item id), `type` dd490, the legacy keys dropped. The wrapper's
 * own `id` / `lang` were minted by the reformat and mean nothing.
 */
export function unwrapV6LiteralFrame(entry: unknown): unknown {
	const inner = (entry as { value?: unknown } | null)?.value;
	return !Array.isArray(inner) && isFrameEntry(inner) ? migrateLiteralFrame(inner) : entry;
}

/** A literal main's frame in the dd490 shape (dataframe_v7_migration transform_entries). */
function migrateLiteralFrame(inner: Record<string, unknown>): Record<string, unknown> {
	const { section_id_key: legacyKey, section_tipo_key: _tipoKey, ...frame } = inner;
	const migrated: Record<string, unknown> = { ...frame, type: DATAFRAME_RELATION_TYPE };
	const numericKey =
		typeof legacyKey === 'string' || typeof legacyKey === 'number' ? Number(legacyKey) : Number.NaN;
	if (migrated.id_key === undefined && Number.isInteger(numericKey)) migrated.id_key = numericKey;
	return migrated;
}

/** The entries added or removed between two slot images (a multiset diff; `[]` ≡ absent). */
function changedEntries(before: unknown, after: unknown): unknown[] {
	return [...unmatched(before, entryCounts(after)), ...unmatched(after, entryCounts(before))];
}

/** Canonical multiset of a slot image's entries. */
function entryCounts(image: unknown): Map<string, number> {
	const counts = new Map<string, number>();
	for (const entry of framesOf(image)) {
		const key = canonicalJson(entry);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

/** The entries of `from` not matched one-for-one in `against`. */
function unmatched(from: unknown, against: Map<string, number>): unknown[] {
	const left = new Map(against);
	return framesOf(from).filter((entry) => {
		const key = canonicalJson(entry);
		const count = left.get(key) ?? 0;
		left.set(key, count - 1);
		return count <= 0;
	});
}

/**
 * The mains a slot change belongs to: the distinct `main_component_tipo` of
 * every entry added or removed between `before` and `after` (a multiset diff —
 * an edited frame is one removed + one added). Legacy entries naming no main
 * contribute nothing.
 */
export function mainsOfSlotChange(before: unknown, after: unknown): string[] {
	const mains: string[] = [];
	for (const entry of changedEntries(before, after)) {
		const main = (entry as { main_component_tipo?: unknown } | null)?.main_component_tipo;
		if (typeof main === 'string' && main !== '' && !mains.includes(main)) mains.push(main);
	}
	return mains;
}

/**
 * The slot's ontology parent, when that parent is a COMPONENT declaring it as
 * a slot — else null. A grouper (section_group, …) parenting a slot is not a
 * main: it stores nothing and owns no frame.
 */
async function declaringParent(slotTipo: string): Promise<string | null> {
	const parent = (await getNode(slotTipo))?.parent;
	if (typeof parent !== 'string' || parent === '') return null;
	if ((await getModelByTipo(parent))?.startsWith('component_') !== true) return null;
	return (await resolveDataframeSlotTipos(parent)).includes(slotTipo) ? parent : null;
}

/**
 * THE MAIN(S) A SLOT SAVE IS RECORDED UNDER (a slot writes no history of its
 * own). In order:
 *   1. the caller's pairing main (`callerDataframe.main_component_tipo`);
 *   2. every main whose frames the save added or removed (mainsOfSlotChange),
 *      minus a name the ontology no longer stores (storableMains);
 *   3. the slot's ontology parent, when it declares the slot;
 *   4. otherwise the change is an ORPHAN (no main can own it — a frame naming
 *      a removed tipo or none, in a slot only a request_config or a model's
 *      fixed set names): `orphan` decides —
 *        - 'refuse' (the default: the interactive and import slot SAVE, whose
 *          caller can act on it): a CHANGED slot throws
 *          `engine.uncovered_scope` — history nobody could read or revert;
 *        - 'skip' (the strip, wipe and delete doors: a record delete, Delete
 *          data, a portal locator removal): the frame is removed and no history
 *          is written for it — an orphan no restore can use must never block
 *          the door that removes it.
 *      An UNCHANGED slot has nothing to record and returns [] either way.
 */
export async function attributeSlotMains(
	slotTipo: string,
	before: unknown,
	after: unknown,
	callerMain: string | null,
	orphan: OrphanSlotChange = 'refuse',
): Promise<string[]> {
	const mains = callerMain ? [callerMain] : await storableMains(mainsOfSlotChange(before, after));
	if (mains.length > 0) return mains;
	const parent = await declaringParent(slotTipo);
	if (parent !== null) return [parent];
	// No entry added or removed ([] vs absent is no change): nothing to record.
	if (orphan === 'skip' || changedEntries(before, after).length === 0) return [];
	throw new DedaloError('engine.uncovered_scope', {
		message: `dataframe slot '${slotTipo}' changed, but no main component owns the change (no caller main, no frame names one, no declaring parent): its history cannot be recorded`,
		coordinates: { tipo: slotTipo },
	});
}

/** What attributeSlotMains does with a change no main owns (see step 4 there). */
export type OrphanSlotChange = 'refuse' | 'skip';

/**
 * The frame-named mains that still resolve to a storable matrix component. A
 * frame's `main_component_tipo` is DATA: it outlives an ontology edit that
 * removed or re-modelled its main, so a stale name is dropped here and the
 * change falls through to the declaring parent (step 3), then to the orphan
 * rule (step 4: skipped by the strip/wipe/delete doors, never blocking them). The
 * caller's main is not filtered: a request naming a dead main is refused loudly
 * by mainIdentity.
 */
async function storableMains(tipos: readonly string[]): Promise<string[]> {
	const kept: string[] = [];
	for (const tipo of tipos) if ((await mainStorage(tipo)) !== null) kept.push(tipo);
	return kept;
}

// ---------------------------------------------------------------------------
// THE HISTORY OF A MAIN — identity, state, and the ONE lane writer
// ---------------------------------------------------------------------------

/** How a main's history is cut into lanes, and which lane its door writes. */
export interface MainIdentity extends LaneLaw {
	tipo: string;
	model: string;
	column: MatrixJsonbColumn;
	/**
	 * The DOOR LANE: the lane the door's value write belongs to — the MAIN's own
	 * lang (mainRowLang), never the door's: a sliced save's effective lang,
	 * lg-nolan otherwise (every unsliced main, whatever its ontology flag). A
	 * slot save writes the frame lane (lg-nolan).
	 */
	lang: string;
}

/** What the lane writer needs of an identity. */
export type LaneIdentity = Pick<MainIdentity, 'tipo' | 'lang' | 'sliced' | 'translatable'>;

/**
 * THE DOOR LANE OF A MAIN for a request lang — derived from the MAIN, never
 * from the door that wrote. ONE LAW for every history row a door files
 * (WC-2026-09-27-bulk-revert-undo-log, addendum 2026-09-30):
 *
 * - An UNSLICED main (every relation) speaks `lg-nolan` whatever its ontology
 *   flag (decision 2026-09-29, main_lanes.ts laneLaw).
 * - A SPEAKING door (a request lang: the save, the duplicate's re-save row,
 *   translation) files a sliced main in `effectiveSaveLang(tipo, model,
 *   pageLang)` — the lang its own save writes (resolver.ts, the one rule): the
 *   page lang for a translatable, a `with_lang_versions` (transliterable) or an
 *   iri main; `lg-nolan` for any other.
 * - A DOORLESS door (`lg-nolan` / '': the wipe, the undelete, the observer, the
 *   slot/frame lane) files in `lg-nolan` — except a TRANSLATABLE sliced main,
 *   which files in the request's DATA lang (currentDataLang), the lang the
 *   main's own saves from the same page use.
 *
 * KNOWN ASYMMETRY (open, owner decision): a translatable save from a
 * lang-less request is filed in `lg-nolan` by the save door (effectiveSaveLang
 * keeps the request lang) but in currentDataLang by this rule.
 * Gate: test/unit/history_door_lane_agreement_native.test.ts.
 */
async function mainRowLang(tipo: string, model: string, requestLang: string): Promise<string> {
	if (!isLangSlicedModel(model)) return NOLAN;
	return slicedRowLang(tipo, model, requestLang);
}

/** mainRowLang for a LANG-SLICED main. */
async function slicedRowLang(tipo: string, model: string, requestLang: string): Promise<string> {
	const doorless = requestLang === '' || requestLang === NOLAN;
	if (await getTranslatableByTipo(tipo)) return doorless ? currentDataLang() : requestLang;
	return doorless ? NOLAN : effectiveSaveLang(tipo, model, requestLang);
}

/** A main's model and matrix column; null when the tipo has no model or no storable column. */
export async function mainStorage(
	tipo: string,
): Promise<{ model: string; column: MatrixJsonbColumn } | null> {
	const model = await getModelByTipo(tipo);
	const column = model === null ? null : getColumnNameByModel(model);
	if (model === null || !MATRIX_JSONB_COLUMNS.includes(column as MatrixJsonbColumn)) return null;
	return { model, column: column as MatrixJsonbColumn };
}

/** A main's identity for its history; a tipo the matrix cannot store is refused loudly. */
export async function mainIdentity(tipo: string, requestLang: string): Promise<MainIdentity> {
	const storage = await mainStorage(tipo);
	if (storage === null) {
		throw new DedaloError('engine.uncovered_scope', {
			message: `dataframe main '${tipo}' (model ${String(await getModelByTipo(tipo))}) has no matrix column: its history cannot be recorded`,
			coordinates: { tipo },
		});
	}
	const { model, column } = storage;
	return {
		tipo,
		model,
		column,
		...laneLaw(isLangSlicedModel(model), await getTranslatableByTipo(tipo)),
		lang: await mainRowLang(tipo, model, requestLang),
	};
}

/**
 * The mains a change of key `tipo` is recorded under: the key itself when it is
 * a main; the attributed mains when it is a dataframe slot (attributeSlotMains)
 * — each with the FRAME lane as its door lane (a slot change is the frame
 * lane's, whatever language the page spoke).
 */
export async function historyMainsOf(
	tipo: string,
	change: {
		before: unknown;
		after: unknown;
		callerMain: string | null;
		requestLang: string;
		orphan?: OrphanSlotChange;
	},
): Promise<MainIdentity[]> {
	if ((await getModelByTipo(tipo)) !== DATAFRAME_MODEL) {
		return [await mainIdentity(tipo, change.requestLang)];
	}
	const tipos = await attributeSlotMains(
		tipo,
		change.before,
		change.after,
		change.callerMain,
		change.orphan,
	);
	const identities: MainIdentity[] = [];
	for (const main of tipos) identities.push({ ...(await mainIdentity(main, NOLAN)), lang: NOLAN });
	return identities;
}

/**
 * The persisted image of one key of one row, read inside the ambient
 * transaction: `undefined` when the key (or the whole column) is absent, the
 * stored value otherwise (a stored JSON null stays `null`).
 */
export async function readKeyImage(
	target: SlotTarget,
	column: MatrixJsonbColumn,
	tipo: string,
): Promise<unknown> {
	const rows = (await sql.unsafe(
		`SELECT ("${column}" ? $3) AS present, "${column}"->$3 AS value
		 FROM "${target.table}" WHERE section_tipo = $1 AND section_id = $2`,
		[target.sectionTipo, target.sectionId, tipo],
	)) as { present: boolean | null; value: unknown }[];
	const row = rows[0];
	return row?.present === true ? row.value : undefined;
}

/** A main's state at one moment: its raw stored key and its slots. */
export interface MainState {
	/** The raw stored value of the main's key (`undefined` = absent). */
	value: unknown;
	slots: SlotImages;
}

/** The state of a main as stored NOW (inside the caller's transaction — under its lock, the locked state). */
export async function readMainState(
	target: SlotTarget,
	identity: Pick<MainIdentity, 'tipo' | 'column'>,
	extraSlots: readonly string[] = [],
): Promise<MainState> {
	return {
		value: await readKeyImage(target, identity.column, identity.tipo),
		slots: await readMainSlots(target, identity.tipo, extraSlots),
	};
}

/** Who wrote, and when. */
export interface HistoryStamp {
	userId: number;
	timestamp: string;
}

/** A stamp, and the run the write belongs to (null outside a bulk run). */
export interface RunStamp extends HistoryStamp {
	bulkId: number | null;
}

/** The FRAME lane image of a state: its lg-nolan value (`region` cut by the caller) followed by every slot's frames. */
function frameLaneImage(region: unknown, slots: SlotImages): unknown {
	return composeTmData(region, slots);
}

/** Whether the frame lane differs between two states (visible law). */
function frameLaneChanged(before: MainState, after: MainState, law: LaneIdentity): boolean {
	const [slotsBefore, slotsAfter] = alignSlots(before.slots, after.slots);
	return !sameVisible(
		frameLaneImage(visibleOf(before.value, NOLAN, law), slotsBefore),
		frameLaneImage(visibleOf(after.value, NOLAN, law), slotsAfter),
	);
}

/** One visible row of a main. */
async function writeLaneRow(
	target: SlotTarget,
	tipo: string,
	lang: string,
	data: unknown,
	stamp: HistoryStamp,
): Promise<void> {
	await recordTimeMachine(
		{
			sectionTipo: target.sectionTipo,
			sectionId: target.sectionId,
			componentTipo: tipo,
			lang,
			userId: stamp.userId,
			data,
		},
		stamp.timestamp,
	);
}

/**
 * A lane's visible value — the door's lane carrying the lang-less items
 * (laneVisible), except a TRANSLATABLE main's lg-nolan lane: that is its
 * shared frame lane, which holds frames only (and an lg-nolan-tagged PHP
 * item), never an orphan — its orphans ride its language doors' rows.
 */
function visibleOf(value: unknown, lane: string, identity: LaneIdentity): unknown {
	const frameLaneOnly = lane === NOLAN && identity.translatable;
	return laneVisible(value, lane, identity, lane === identity.lang && !frameLaneOnly);
}

/** The language lanes whose VISIBLE value differs between two states. */
function changedValueLanes(before: MainState, after: MainState, identity: LaneIdentity): string[] {
	return valueLanesOf([before.value, after.value], identity, identity.lang).filter(
		(lane) =>
			!sameVisible(visibleOf(before.value, lane, identity), visibleOf(after.value, lane, identity)),
	);
}

/** Visible-image equality: an absent key, a null and `[]` all hold nothing. */
function sameVisible(left: unknown, right: unknown): boolean {
	if (isEmptyImage(left) && isEmptyImage(right)) return true;
	return canonicalJson(left) === canonicalJson(right);
}

/**
 * THE ORDINARY (visible) ROWS of a change, outside a bulk run: — when the
 * frame lane changed (a frame, or the lg-nolan value) — ONE lg-nolan row (the
 * lg-nolan value + every slot's frames), then one row per language lane whose
 * value changed (its value only). FRAME LANE FIRST: a language row's frames
 * are the newest frame-state row at or below it (tm_record/lane_state.ts), so
 * the save's own frame change must sit BELOW its language rows — else the
 * state at the language row pairs the new value with the old frames (a frame
 * of an item the save removed would come back as an orphan on restore).
 * `forceDoorLane`: the door's own lane is written even unchanged (every save
 * leaves a row, as it always did).
 */
async function recordMainRows(
	target: SlotTarget,
	identity: LaneIdentity,
	change: { before: MainState; after: MainState },
	stamp: HistoryStamp,
	forceDoorLane: boolean,
): Promise<void> {
	const { before, after } = change;
	const lanes = rowLanes(change, identity, forceDoorLane);
	if (lanes.length > 0) await recordFrameLaneBaseline(target, identity, before, stamp);
	const forced = forceDoorLane && identity.lang === NOLAN;
	if (forced || frameLaneChanged(before, after, identity)) {
		const region = visibleOf(after.value, NOLAN, identity);
		await writeLaneRow(target, identity.tipo, NOLAN, frameLaneImage(region, after.slots), stamp);
	}
	for (const lane of lanes) {
		await writeLaneRow(target, identity.tipo, lane, visibleOf(after.value, lane, identity), stamp);
	}
}

/**
 * THE FRAME LANE IS COMPLETE BEFORE A LANGUAGE ROW. A language row carries no
 * frame: its frames are the newest frame-state row at or below it
 * (tm_record/lane_state.ts). So before a language row is written, the frame
 * lane must answer for the state the change starts from: when the newest
 * frame-state row of the main is missing or does not hold the BEFORE frame
 * state (this main's own frames + its lg-nolan value — frames written by a
 * door that records no history, a migration, an import before the undo log),
 * ONE visible lg-nolan row of the BEFORE state is written first. A main with
 * no slot and nothing in its frame lane has no frame lane to complete.
 * (A save door whose slots were not read is an UNSLICED
 * main's, which has no language lane — bulk_capture.ts UNREAD_SLOTS.)
 */
async function recordFrameLaneBaseline(
	target: SlotTarget,
	identity: LaneIdentity,
	before: MainState,
	stamp: HistoryStamp,
): Promise<void> {
	const image = frameLaneImage(visibleOf(before.value, NOLAN, identity), before.slots);
	if (before.slots.slots.length === 0 && isEmptyImage(image)) return;
	const coords = {
		sectionTipo: target.sectionTipo,
		sectionId: target.sectionId,
		componentTipo: identity.tipo,
	};
	const newest = await readFrameStateRowAt(coords, Number.MAX_SAFE_INTEGER);
	// No frame state recorded yet reads as an EMPTY one (the lane's first row is written when it first holds something).
	if (frameStateKey(newest?.data ?? [], identity) === frameStateKey(image, identity)) return;
	await writeLaneRow(target, identity.tipo, NOLAN, image, stamp);
}

/**
 * What a frame state says about THIS main: its lg-nolan value and its own
 * frames (order-free). The value is the items tagged EXACTLY lg-nolan: a
 * lang-less orphan rides whichever door lane wrote it (visibleOf), so it is
 * never part of the frame state — comparing it made every language save after
 * a frame save write a spurious baseline row.
 */
function frameStateKey(image: unknown, identity: LaneIdentity): string {
	const { main, frames } = splitComposed(image);
	const value = laneHoldsValue(NOLAN, identity) ? nolanTagged(main, identity) : null;
	return canonicalJson({
		value: isEmptyImage(value) ? null : value,
		frames: frames
			.filter((frame) => isOwnFrame(frame, identity.tipo))
			.map(canonicalJson)
			.sort(),
	});
}

/** The items of a row's main part tagged exactly lg-nolan (an unsliced main: its whole value). */
function nolanTagged(main: unknown, identity: LaneIdentity): unknown {
	const items = rowLaneItems(main, NOLAN, identity);
	if (!identity.sliced || !Array.isArray(items)) return items;
	return items.filter((item) => (item as { lang?: unknown }).lang === NOLAN);
}

/** The language lanes a visible change writes: the changed ones, the door's own first when forced. */
function rowLanes(
	change: { before: MainState; after: MainState },
	identity: LaneIdentity,
	forceDoorLane: boolean,
): string[] {
	const lanes = changedValueLanes(change.before, change.after, identity);
	const door = identity.lang;
	if (!forceDoorLane || lanes.includes(door)) return lanes;
	return door !== NOLAN && laneHoldsValue(door, identity) ? [door, ...lanes] : lanes;
}

/**
 * THE UNDO-LOG PAIRS of a change under a bulk run: ONE pair for the frame lane
 * (the lg-nolan region + every slot's frames, one slot set on both sides —
 * alignSlots) FIRST (its visible after-row must sit below the language
 * after-rows — recordMainRows), then one pair per language lane the change
 * touched (its region only). SEQUENTIAL: each pair is cut from the state the
 * previous step left (a lang-less orphan belongs to every sliced lane's
 * region, so independent pairs would all claim it, and undoing them LIFO would
 * read a moved orphan as a post-run change). A no-op pair writes nothing
 * (recordBulkPair).
 */
async function recordMainPairs(
	target: SlotTarget,
	identity: LaneIdentity,
	change: { before: MainState; after: MainState },
	stamp: HistoryStamp & { bulkId: number },
): Promise<void> {
	const { before, after } = change;
	const pair = (lang: string, images: { before: unknown; after: unknown }) =>
		recordBulkPair({
			coords: {
				sectionTipo: target.sectionTipo,
				sectionId: target.sectionId,
				componentTipo: identity.tipo,
			},
			lang,
			userId: stamp.userId,
			bulkId: stamp.bulkId,
			timestamp: stamp.timestamp,
			...images,
		});
	const lanes = valueLanesOf([before.value, after.value], identity, identity.lang);
	if (lanes.length > 0 && canonicalJson(before.value) !== canonicalJson(after.value)) {
		await recordFrameLaneBaseline(target, identity, before, stamp);
	}
	// The frame lane FIRST (see recordMainRows), then each language lane from the state it left.
	const nolanRegion = laneRegion(after.value, NOLAN, identity);
	let state = restoreLane(before.value, NOLAN, nolanRegion, identity);
	const [slotsBefore, slotsAfter] = alignSlots(before.slots, after.slots);
	await pair(NOLAN, {
		before: frameLaneImage(laneRegion(before.value, NOLAN, identity), slotsBefore),
		after: frameLaneImage(nolanRegion, slotsAfter),
	});
	for (const lane of lanes) {
		const next = restoreLane(state, lane, laneRegion(after.value, lane, identity), identity);
		await pair(lane, {
			before: laneRegion(state, lane, identity),
			after: laneRegion(next, lane, identity),
		});
		state = next;
	}
}

/**
 * THE ONE WRITER OF A MAIN'S HISTORY (two lanes — see relations/main_lanes.ts
 * and the WC addendum). Every door that changes a main or a frame of it —
 * the component save, a slot save, apply_value, a bulk revert, a delete's
 * strip or wipe, a portal locator removal, an observer recompute, a
 * translation, a duplicate — records its change HERE, under the MAIN's tipo:
 *   - outside a run (`bulkId` null): the visible rows (recordMainRows);
 *   - under a run: the undo-log pairs (recordMainPairs), whose after-rows are
 *     the visible rows (decision D1).
 * `before` / `after` are the main's raw key and its slots on both sides, read
 * inside the door's transaction (after = after every write of the door).
 */
export async function recordMainHistory(
	target: SlotTarget,
	identity: LaneIdentity,
	change: { before: MainState; after: MainState },
	stamp: RunStamp,
	options: { forceDoorLane?: boolean } = {},
): Promise<void> {
	const { bulkId } = stamp;
	const door = unslicedDoorIdentity(identity);
	if (bulkId !== null) {
		await recordMainPairs(target, door, change, { ...stamp, bulkId });
		return;
	}
	await recordMainRows(target, door, change, stamp, options.forceDoorLane ?? true);
}

/**
 * An UNSLICED main has ONE lane, lg-nolan (main_lanes.ts laneLaw, decision
 * 2026-09-29): whatever lane a door hands for it, its history is filed there,
 * with its ontology flag dropped.
 */
function unslicedDoorIdentity(identity: LaneIdentity): LaneIdentity {
	if (identity.sliced) return identity;
	return { ...identity, translatable: false, lang: NOLAN };
}

/**
 * Whether a change would leave an UNFORCED visible row (recordMainRows' own
 * law, so "no-op" and "no TM row" never disagree): a language lane or the
 * frame lane differs between the two states.
 */
export function mainStateChanged(
	before: MainState,
	after: MainState,
	identity: LaneIdentity,
): boolean {
	const door = unslicedDoorIdentity(identity);
	return (
		rowLanes({ before, after }, door, false).length > 0 || frameLaneChanged(before, after, door)
	);
}

/**
 * A backfill's history probe: whether the record already has a visible row of
 * the main in `lane`. `anyTag` — an UNSLICED main's one lane is every row of
 * it whatever its tag (a PHP save of a relation flagged translatable was
 * tagged with the data lang and held the whole value), so the probe must match
 * any lang, not the lg-nolan tag only.
 */
export type LaneHistoryProbe = (lane: string, anyTag: boolean) => Promise<boolean>;

/**
 * THE BACKFILL of a main (the delete / duplicate doors): the state as it
 * stood, one visible row per lane that holds something — each language lane
 * with its value, the frame lane when it holds a value or a frame — skipping
 * a lane `hasHistory` already answers for. FRAME LANE FIRST (recordMainRows):
 * a backfilled language row's frames are the newest frame-state row at or
 * below it, so the frame lane answers for `state` BEFORE any language row —
 * its own backfill row when the lane has no history and holds something, else
 * (language rows following) a baseline row when its newest frame state is not
 * this one (recordFrameLaneBaseline).
 */
export async function recordMainBackfill(
	target: SlotTarget,
	doorIdentity: LaneIdentity,
	state: MainState,
	stamp: HistoryStamp,
	probe: LaneHistoryProbe = async () => false,
	options: { emptyDoorLane?: boolean } = {},
): Promise<void> {
	const identity = unslicedDoorIdentity(doorIdentity);
	const hasHistory = (lane: string) => probe(lane, !identity.sliced);
	// `emptyDoorLane`: the door's own lane is backfilled even EMPTY (the observer
	// mirror's PHP baseline: "it held nothing before this write").
	const keeps = (lane: string, image: unknown) =>
		!isEmptyImage(image) || (options.emptyDoorLane === true && lane === identity.lang);
	const lanes = await backfillLanes(identity, state, keeps, hasHistory);
	await backfillFrameLane(target, identity, state, stamp, {
		keeps: keeps(NOLAN, frameLaneImage(visibleOf(state.value, NOLAN, identity), state.slots)),
		hasHistory: await hasHistory(NOLAN),
		languageRows: lanes.length > 0,
	});
	for (const { lane, value } of lanes) {
		await writeLaneRow(target, identity.tipo, lane, value, stamp);
	}
}

/** The language lanes a backfill writes: each that holds something (`keeps`) and has no history yet. */
async function backfillLanes(
	identity: LaneIdentity,
	state: MainState,
	keeps: (lane: string, image: unknown) => boolean,
	hasHistory: (lane: string) => Promise<boolean>,
): Promise<{ lane: string; value: unknown }[]> {
	const lanes: { lane: string; value: unknown }[] = [];
	for (const lane of valueLanesOf([state.value], identity, identity.lang)) {
		const value = visibleOf(state.value, lane, identity);
		if (keeps(lane, value) && !(await hasHistory(lane))) lanes.push({ lane, value });
	}
	return lanes;
}

/**
 * The backfill's frame lane, written BEFORE its language rows: its own row
 * when the lane has no history and holds something; else, when language rows
 * follow, a baseline row if the newest frame state (an lg-nolan row OR a PHP
 * language row carrying a frame) is not `state`'s.
 */
async function backfillFrameLane(
	target: SlotTarget,
	identity: LaneIdentity,
	state: MainState,
	stamp: HistoryStamp,
	lane: { keeps: boolean; hasHistory: boolean; languageRows: boolean },
): Promise<void> {
	if (!lane.hasHistory && lane.keeps) {
		const image = frameLaneImage(visibleOf(state.value, NOLAN, identity), state.slots);
		await writeLaneRow(target, identity.tipo, NOLAN, image, stamp);
		return;
	}
	// No lg-nolan row does not mean no frame state: a PHP language row carrying a
	// frame is one (FRAME_STATE_ROW_SQL) — the baseline answers for it too.
	if (lane.languageRows) await recordFrameLaneBaseline(target, identity, state, stamp);
}

/** An image that holds nothing (null, absent, `[]`). */
function isEmptyImage(image: unknown): boolean {
	return image === undefined || image === null || (Array.isArray(image) && image.length === 0);
}

/**
 * Whether a history ROW is a FRAME STATE (two lanes): a row of the shared frame
 * lane (tagged lg-nolan), or a row that carries a frame whatever its tag (a
 * PHP-era main save: PHP composed every row with the main's frames). The JS
 * twin of time_machine.ts FRAME_STATE_ROW_SQL.
 */
export function isFrameStateRow(lang: string | null, data: unknown): boolean {
	return lang === NOLAN || splitComposed(data).frames.length > 0;
}

/**
 * The history of a key change made OUTSIDE the component save and outside a
 * bulk run (a portal locator removal): the key's own main — `before` its state
 * under the door's lock, before any write — or, when the key is a dataframe
 * slot, each attributed main's frame lane; an orphan frame change (no main owns
 * it) is written without history. Read inside the door's transaction, after
 * its writes.
 */
export async function recordKeyChangeRows(
	target: SlotTarget,
	tipo: string,
	change: { before: unknown; after: unknown; requestLang: string; slotsBefore?: SlotImages },
	stamp: HistoryStamp,
): Promise<void> {
	// A strip door: an orphan frame change is removed without history (attributeSlotMains).
	const mains = await historyMainsOf(tipo, { ...change, callerMain: null, orphan: 'skip' });
	for (const identity of mains) {
		const after = await readMainState(target, identity, identity.tipo === tipo ? [] : [tipo]);
		const before =
			identity.tipo === tipo
				? { value: change.before, slots: change.slotsBefore ?? after.slots }
				: { value: after.value, slots: withSlotImage(after.slots, tipo, change.before) };
		await recordMainHistory(target, identity, { before, after }, { ...stamp, bulkId: null });
	}
}
