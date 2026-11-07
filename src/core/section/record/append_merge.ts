/**
 * CSV-import APPEND merge — the PURE half of `SaveRequest.appendImport`.
 *
 * `saveComponentData` reads the stored items under its `FOR UPDATE` lock, runs
 * its value gates, then hands both arrays here with the model's
 * `importAppend` policy (components/types.ts ImportAppendPolicy). This module
 * decides the resulting item array and touches NO database: the one law that
 * needs the engine — the relation insert law (`validateRelationInsert`,
 * relations/save.ts: normalization, dedup key, target/read/selectability gates,
 * the selection cap) — is INJECTED as a callback, so it stays single-homed in
 * the engine and a `selection_limit` refusal still throws out of the save and
 * rolls the row back.
 *
 * Laws, per policy:
 *
 * - STORED ITEMS ARE KEPT BYTE-FOR-BYTE. Every result starts from the stored
 *   array's own object references; a stored item is never re-normalized, never
 *   re-validated, never deduplicated against its siblings (a replay through the
 *   set_data door would collapse duplicates already stored). An item with no
 *   `lang` survives (the lang-sliced set_data drops it; append does not).
 * - 'items', relations: incoming `id` + `paginated_key` stripped, each item
 *   validated with `existingItems = stored + accepted` (the insert law). A
 *   duplicate maps to the EXISTING item's id. Scope is the full array, never a
 *   lang slice (relation set_data replaces all languages).
 * - 'items', literals: dedup inside the current lang slice only, equality per
 *   family (LiteralEqualityFamily). Incoming ids are stripped, except an id the
 *   executor PRE-ALLOCATED so a row's translations share one item id.
 * - 'geo_layer': imported layers (or a flat point, wrapped as a Point layer)
 *   are added to the FIRST stored item's `lib_data` with fresh layer ids;
 *   stored layers and the stored centre stay untouched. A layer equal to a
 *   stored layer OR to a stored item's centre (as a Point) is a duplicate.
 *   The entry's SIBLING keys `sources` and `legend`
 *   (WC-2026-11-06-geolocation-map-sources-legend) are not layers, and append
 *   is LAYERS-ONLY: it never reads, merges or rewrites them. Onto a stored host
 *   they stay as stored (the host is spread, so by reference) and an incoming
 *   item's are DROPPED; onto nothing, the first incoming item is the host as it
 *   is, so ITS sources/legend are stored (the save gate validates and numbers
 *   them) and every later item's are dropped. An incoming item that carries
 *   only siblings has no layer to add and is reported as an `empty` skip.
 *   A sources merge would need new ids, a url+params identity and the entry's
 *   caps re-judged — a different operation, not an append.
 *   Gates: test/unit/geo_sources_legend_import_native.test.ts (the pure merge,
 *   mergeGeoLayers) and test/unit/geo_sources_legend_save_native.test.ts ("CSV
 *   append is layers-only": the same merge through the engine on scratch records).
 * - 'text_paragraphs': per lang, `stored + <p>imported</p>`; a value carrying
 *   any Dédalo tag is REFUSED (tags pair with relation_index `tag_id`, which an
 *   append cannot re-key); a fragment already present is skipped.
 * - { refuse }: throws — the engine backstop for a caller that bypassed the
 *   tool's per-column refusal.
 *
 * IDS. A new item of a lang-sliced literal takes, in order: the executor's
 * PRE-ALLOCATED id (a multi-lang cell's shared id), else the id its SIBLING
 * languages already give that slice position (`siblingIdAt`, the engine's
 * first-translation rule) — never an id this slice already holds. Otherwise it
 * leaves here WITHOUT an id and the engine's allocation loop stamps it in place. `idMapPlan` records, per
 * incoming file id, either the existing item's id (a skipped duplicate) or the
 * new item's object reference; `resolveAppendedIdMap` reads the final ids
 * AFTER allocation — that is the executor's `appendedIdMap` for re-pairing
 * dataframe frames (`id_key`).
 */

import { TAG_WIDTHS } from '../../components/component_text_area/tag_grammar.ts';
import type { ImportAppendPolicy } from '../../components/types.ts';
import { canonicalJson } from '../../concepts/canonical_json.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { TC_PATTERN } from '../../resolve/tr_marks.ts';

/** One stored/incoming data item (literal value item or locator). */
export type AppendItem = Record<string, unknown>;

/**
 * The injected relation insert law: `validateRelationInsertVerdict` bound to
 * the save's context, with `existingItems` supplied per call. `value` is the
 * normalized locator, or null for a PHP-era drop (duplicate / bad form /
 * autoreference) — then `code` names which, and a `duplicate` carries the
 * existing item the law matched (`duplicateOf`, by reference). Constraint
 * refusals THROW (and must: the row rolls back).
 */
export type RelationAppendValidator = (
	raw: AppendItem,
	existingItems: readonly unknown[],
) => Promise<RelationAppendVerdict>;

export interface RelationAppendVerdict {
	value: AppendItem | null;
	code?: string;
	duplicateOf?: unknown;
}

/** How two literal items are judged equal (plan §4 "Equality per family"). */
export type LiteralEqualityFamily = 'string' | 'iri' | 'number' | 'date';

/** Which merge an 'items' policy runs: the relation law or a literal family. */
export type AppendItemsFamily = 'relation' | LiteralEqualityFamily;

export interface AppendMergeInput {
	policy: ImportAppendPolicy;
	/** 'relation' for a relation-column model, else the literal equality family. */
	family: AppendItemsFamily;
	/** The component's stored items (read under the row lock). */
	stored: readonly unknown[];
	/** The conformed imported items (after the engine's value gates). */
	incoming: readonly unknown[];
	/** The effective data lang of this save. */
	lang: string;
	/** Whether the model's literal write is lang-sliced (translatable literal). */
	langSliced: boolean;
	/** Executor pre-allocated ids, by incoming position (shared across langs). */
	preallocatedIds?: readonly (number | undefined)[];
	/**
	 * Lang-sliced literals: the id the SIBLING languages already give the item
	 * at `position` of this lang's slice (the engine's getIdFromKey, PHP
	 * get_id_from_key — the first-translation rule), or null. Consulted for a
	 * new item with no pre-allocated id; an id already used in this slice (or
	 * handed out in this merge) is never taken — the allocator mints one then.
	 */
	siblingIdAt?: (position: number) => number | null;
	/** Required for family 'relation'. */
	validateRelation?: RelationAppendValidator;
	/** For messages only. */
	componentTipo: string;
}

/** Why an incoming entry did not land. */
export type AppendSkipReason = 'duplicate' | 'dropped' | 'empty';

export interface AppendSkip {
	/** Incoming position (for a geo layer: the incoming item's position). */
	index: number;
	reason: AppendSkipReason;
}

/** Where an incoming file id points after the merge. */
export type AppendIdTarget = { kind: 'existing'; id: unknown } | { kind: 'new'; item: AppendItem };

export interface AppendIdMapEntry {
	/** The incoming item's file id, String()-keyed. */
	incomingId: string;
	target: AppendIdTarget;
}

export interface AppendMergeResult {
	items: unknown[];
	skipped: AppendSkip[];
	idMapPlan: AppendIdMapEntry[];
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** The append merge. Throws on a refuse policy, a tagged text, a bad input. */
export async function mergeAppend(input: AppendMergeInput): Promise<AppendMergeResult> {
	const policy = input.policy;
	if (typeof policy === 'object') throw refusePolicyError(input, policy.refuse);
	if (policy === 'geo_layer') return mergeGeoLayers(input.stored, input.incoming);
	if (policy === 'text_paragraphs') return mergeTextParagraphs(input);
	if (input.family === 'relation') return mergeRelationItems(input);
	return mergeLiteralItems(input, input.family);
}

function refusePolicyError(input: AppendMergeInput, reason: string): DedaloError {
	return new DedaloError('request.invalid_data', {
		message: `append merge: component '${input.componentTipo}' refuses append (${reason})`,
		coordinates: { tipo: input.componentTipo },
	});
}

/** Literal equality family of a model (every non-listed literal compares `value`). */
export function literalEqualityFamilyOf(model: string): LiteralEqualityFamily {
	return LITERAL_FAMILY_BY_MODEL[model] ?? 'string';
}

const LITERAL_FAMILY_BY_MODEL: Readonly<Record<string, LiteralEqualityFamily>> = {
	component_iri: 'iri',
	component_number: 'number',
	component_date: 'date',
};

/**
 * The executor's `appendedIdMap`: incoming file id → final stored id. Call it
 * AFTER the engine's id allocation; a new item still without an id is an
 * invariant breach (the map would silently orphan its frames).
 */
export function resolveAppendedIdMap(plan: readonly AppendIdMapEntry[]): Map<string, unknown> {
	const map = new Map<string, unknown>();
	for (const entry of plan) {
		const id = entry.target.kind === 'existing' ? entry.target.id : entry.target.item.id;
		if (isAbsentId(id)) {
			throw new DedaloError('internal.invariant', {
				message: `resolveAppendedIdMap: incoming id '${entry.incomingId}' has no final id — called before id allocation?`,
			});
		}
		map.set(entry.incomingId, id);
	}
	return map;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is AppendItem {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAbsentId(id: unknown): boolean {
	return id === undefined || id === null || id === '';
}

/** The file id of an incoming item as a map key, or null when it has none. */
function fileIdKey(item: AppendItem): string | null {
	const id = item.id;
	if (typeof id === 'number' && Number.isFinite(id)) return String(id);
	if (typeof id === 'string' && id !== '') return id;
	return null;
}

function recordId(plan: AppendIdMapEntry[], raw: AppendItem, target: AppendIdTarget): void {
	const key = fileIdKey(raw);
	if (key !== null) plan.push({ incomingId: key, target });
}

/**
 * Target of a matched existing item: its id when it has one, else its object
 * REFERENCE — an item accepted in this merge, or an id-less stored item
 * (PHP-era data): the engine's allocation loop stamps that same object, so the
 * final id is readable after it. Resolving an id-less match by value would
 * freeze `undefined` into the plan.
 */
function targetOf(match: AppendItem, accepted: readonly AppendItem[]): AppendIdTarget {
	if (accepted.includes(match) || isAbsentId(match.id)) return { kind: 'new', item: match };
	return { kind: 'existing', id: match.id };
}

function withoutKeys(item: AppendItem, keys: readonly string[]): AppendItem {
	const copy: AppendItem = { ...item };
	for (const key of keys) delete copy[key];
	return copy;
}

// ---------------------------------------------------------------------------
// 'items' — relations
// ---------------------------------------------------------------------------

async function mergeRelationItems(input: AppendMergeInput): Promise<AppendMergeResult> {
	const validate = input.validateRelation;
	if (validate === undefined) {
		throw new DedaloError('internal.invariant', {
			message: `append merge: relation append on '${input.componentTipo}' without the insert-law validator`,
		});
	}
	const accepted: AppendItem[] = [];
	const result: AppendMergeResult = { items: [], skipped: [], idMapPlan: [] };
	for (const [index, raw] of input.incoming.entries()) {
		await appendOneRelation(input, validate, accepted, result, index, raw);
	}
	result.items = [...input.stored, ...accepted];
	return result;
}

async function appendOneRelation(
	input: AppendMergeInput,
	validate: RelationAppendValidator,
	accepted: AppendItem[],
	result: AppendMergeResult,
	index: number,
	raw: unknown,
): Promise<void> {
	if (!isObject(raw)) {
		result.skipped.push({ index, reason: 'dropped' });
		return;
	}
	const existing = [...input.stored, ...accepted];
	const verdict = await validate(withoutKeys(raw, ['id', 'paginated_key']), existing);
	if (verdict.value !== null) {
		accepted.push(verdict.value);
		recordId(result.idMapPlan, raw, { kind: 'new', item: verdict.value });
		return;
	}
	// The law said "ignored". Only a `duplicate` pairs with anything — and with
	// the item the LAW matched (never a re-derived key: the law compares the
	// NORMALIZED locator, type filled and section_id canonicalized). A bad-form
	// / autoreference drop pairs with nothing.
	const match = verdict.code === 'duplicate' ? verdict.duplicateOf : undefined;
	if (!isObject(match)) {
		result.skipped.push({ index, reason: 'dropped' });
		return;
	}
	result.skipped.push({ index, reason: 'duplicate' });
	recordId(result.idMapPlan, raw, targetOf(match, accepted));
}

// ---------------------------------------------------------------------------
// 'items' — literals
// ---------------------------------------------------------------------------

function mergeLiteralItems(
	input: AppendMergeInput,
	family: LiteralEqualityFamily,
): AppendMergeResult {
	const scope = input.stored.filter(
		(item): item is AppendItem => isObject(item) && inLiteralScope(item, input),
	);
	const accepted: AppendItem[] = [];
	const result: AppendMergeResult = { items: [], skipped: [], idMapPlan: [] };
	const usedIds = sliceIds(scope);
	for (const [index, raw] of input.incoming.entries()) {
		appendOneLiteral(input, family, scope, accepted, result, index, raw, usedIds);
	}
	result.items = [...input.stored, ...accepted];
	return result;
}

function inLiteralScope(item: AppendItem, input: AppendMergeInput): boolean {
	return !input.langSliced || item.lang === input.lang;
}

function appendOneLiteral(
	input: AppendMergeInput,
	family: LiteralEqualityFamily,
	scope: readonly AppendItem[],
	accepted: AppendItem[],
	result: AppendMergeResult,
	index: number,
	raw: unknown,
	usedIds: Set<string>,
): void {
	if (!isObject(raw)) {
		result.skipped.push({ index, reason: 'dropped' });
		return;
	}
	// An EMPTY entry is a no-op (plan §5): append never adds a blank item.
	if (isEmptyLiteralItem(raw, family)) {
		result.skipped.push({ index, reason: 'empty' });
		return;
	}
	const equal = LITERAL_EQUALITY[family];
	const match = [...scope, ...accepted].find((candidate) => equal(candidate, raw));
	if (match !== undefined) {
		result.skipped.push({ index, reason: 'duplicate' });
		recordId(result.idMapPlan, raw, targetOf(match, accepted));
		return;
	}
	const item = newLiteralItem(raw, input, index, scope.length + accepted.length, usedIds);
	accepted.push(item);
	recordId(result.idMapPlan, raw, { kind: 'new', item });
}

/** The ids a slice already holds, String()-keyed (the collision set). */
function sliceIds(items: readonly unknown[]): Set<string> {
	const ids = new Set<string>();
	for (const item of items) {
		if (isObject(item) && !isAbsentId(item.id)) ids.add(String(item.id));
	}
	return ids;
}

/**
 * A fresh item: file id stripped, slice lang stamped, and its id chosen (see
 * the header, IDS): pre-allocated, else the sibling languages' id at
 * `slicePosition`, else none (the engine allocates). A PRE-ALLOCATED id this
 * slice already holds is refused loudly — two items of one language under one
 * id would pair frames and translations with the wrong item.
 */
function newLiteralItem(
	raw: AppendItem,
	input: AppendMergeInput,
	index: number,
	slicePosition: number,
	usedIds: Set<string>,
): AppendItem {
	const item = withoutKeys(raw, ['id', 'paginated_key']);
	if (input.langSliced) item.lang = input.lang;
	const preallocated = input.preallocatedIds?.[index];
	const id =
		preallocated !== undefined
			? claimPreallocatedId(input, preallocated, usedIds)
			: siblingIdFor(input, slicePosition, usedIds);
	if (id !== null) {
		item.id = id;
		usedIds.add(String(id));
	}
	return item;
}

/** A pre-allocated id, refused loudly when this slice already holds it. */
function claimPreallocatedId(
	input: AppendMergeInput,
	preallocated: number,
	usedIds: ReadonlySet<string>,
): number {
	if (usedIds.has(String(preallocated))) {
		throw new DedaloError('request.invalid_data', {
			message: `append merge: '${input.componentTipo}' already holds an item ${String(preallocated)} in ${input.lang} — the imported translation cannot take that id`,
			coordinates: { tipo: input.componentTipo },
		});
	}
	return preallocated;
}

/**
 * The sibling languages' id at `slicePosition` (lang-sliced only), unless this
 * slice already holds it or another incoming position reserved it; else null.
 */
function siblingIdFor(
	input: AppendMergeInput,
	slicePosition: number,
	usedIds: ReadonlySet<string>,
): number | null {
	if (!input.langSliced) return null;
	const sibling = input.siblingIdAt?.(slicePosition) ?? null;
	if (sibling === null || usedIds.has(String(sibling)) || isPreallocated(input, sibling)) {
		return null;
	}
	return sibling;
}

/** Whether an id is reserved for another incoming position of this merge. */
function isPreallocated(input: AppendMergeInput, id: number): boolean {
	return (input.preallocatedIds ?? []).some((candidate) => candidate === id);
}

/**
 * The ids of the stored items of `lang`'s slice that an incoming literal
 * DUPLICATES — the merge's own equality, exported so the executor can resolve
 * a multi-lang cell's shared id against the stored data BEFORE the per-lang
 * saves (which then skip exactly these). Id-less stored matches are left out.
 */
export function literalDuplicateIds(
	stored: readonly unknown[],
	raw: unknown,
	family: LiteralEqualityFamily,
	lang: string,
): unknown[] {
	if (!isObject(raw)) return [];
	const equal = LITERAL_EQUALITY[family];
	return stored
		.filter((item): item is AppendItem => isObject(item) && item.lang === lang && equal(item, raw))
		.map((item) => item.id)
		.filter((id) => !isAbsentId(id));
}

const LITERAL_EQUALITY: Readonly<
	Record<LiteralEqualityFamily, (left: AppendItem, right: AppendItem) => boolean>
> = {
	string: (left, right) => canonicalJson(left.value) === canonicalJson(right.value),
	iri: (left, right) =>
		looseEqual(left.iri, right.iri) && looseEqual(left.label_id, right.label_id),
	number: (left, right) => numberValueEqual(left.value, right.value),
	date: (left, right) => dateSignature(left) === dateSignature(right),
};

/** Locator-law loose equality: absent ≡ null ≡ '', else String() compare. */
function looseEqual(left: unknown, right: unknown): boolean {
	const l = left === undefined || left === null ? '' : String(left);
	const r = right === undefined || right === null ? '' : String(right);
	return l === r;
}

function numberValueEqual(left: unknown, right: unknown): boolean {
	const l = Number(left);
	const r = Number(right);
	if (isNumeric(left) && isNumeric(right)) return l === r;
	return canonicalJson(left) === canonicalJson(right);
}

function isNumeric(value: unknown): boolean {
	if (typeof value === 'number') return Number.isFinite(value);
	return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
}

/**
 * A date item's identity: the WHOLE item minus its bookkeeping (`id`, `lang`,
 * `paginated_key`) and minus every part's engine-computed absolute `time`
 * (save recomputes it). Whole-item, never a start/end pick: a period-mode item
 * (`{period:{year}}`) has neither, and comparing only the edges judged every
 * two periods equal — the new one was dropped as "already present".
 */
/**
 * Whether a literal entry carries NO identity value — a blank the append
 * skips as `empty` (plan §5), and the executor keeps out of a multi-lang
 * cell's shared-id keys (no id is allocated for it). Per family, on the SAME
 * fields the equality reads: `value` for string/number, `iri` + `label_id`
 * for iri, the whole date signature for date.
 */
export function isEmptyLiteralItem(raw: unknown, family: LiteralEqualityFamily): boolean {
	if (!isObject(raw)) return false;
	switch (family) {
		case 'iri':
			return isBlankValue(raw.iri) && isBlankValue(raw.label_id);
		case 'date':
			return dateSignature(raw) === canonicalJson({});
		default:
			return isBlankValue(raw.value);
	}
}

function isBlankValue(value: unknown): boolean {
	return value === undefined || value === null || value === '';
}

function dateSignature(item: AppendItem): string {
	const identity: AppendItem = {};
	for (const [key, value] of Object.entries(withoutKeys(item, DATE_BOOKKEEPING_KEYS))) {
		if (value === undefined || value === null) continue;
		identity[key] = isObject(value) ? withoutKeys(value, ['time']) : value;
	}
	return canonicalJson(identity);
}

/**
 * Keys that are not the date's identity: storage bookkeeping, plus `time` —
 * always engine-computed (media/file_date.ts addTimeToDateItem), and stamped
 * at the TOP level of a flat time-mode item (`{hour, minute, …}`), so a
 * stored `{hour:10, minute:5, time:36300}` must equal an incoming
 * `{hour:10, minute:5}`. The part-level strip in dateSignature stays.
 */
const DATE_BOOKKEEPING_KEYS = ['id', 'lang', 'paginated_key', 'time'] as const;

// ---------------------------------------------------------------------------
// 'geo_layer' — geolocation
// ---------------------------------------------------------------------------

interface GeoLayer {
	layer_id: unknown;
	layer_data: unknown;
	user_layer_name?: unknown;
}

/**
 * Geolocation append. Nothing stored: the first conformed item is the value
 * and later items fold in as its layers (foldIntoFirstIncoming). Something stored: the imported layers join the
 * FIRST stored item's `lib_data` (the one the client reads) under fresh ids;
 * every other stored field — the centre included — and every other stored
 * item are kept by reference.
 */
export function mergeGeoLayers(
	stored: readonly unknown[],
	incoming: readonly unknown[],
): AppendMergeResult {
	const hostIndex = stored.findIndex(isObject);
	if (hostIndex === -1) return foldIntoFirstIncoming(incoming);
	const { added, skipped } = collectNewLayers(stored, [...incoming.entries()]);
	if (added.length === 0) return { items: [...stored], skipped, idMapPlan: [] };
	return { items: withHostLayers(stored, hostIndex, added), skipped, idMapPlan: [] };
}

/**
 * The layers of `entries` (index-tagged incoming items) that `base` does not
 * already hold, deduplicated and renumbered after base's highest layer id —
 * with a skip per duplicate / empty item, reported at its incoming index.
 */
function collectNewLayers(
	base: readonly unknown[],
	entries: readonly (readonly [number, unknown])[],
): { added: GeoLayer[]; skipped: AppendSkip[] } {
	const known = knownGeoSignatures(base);
	const counter = { next: maxLayerId(base) + 1 };
	const added: GeoLayer[] = [];
	const skipped: AppendSkip[] = [];
	for (const [index, item] of entries) {
		for (const layer of incomingLayers(item, skipped, index)) {
			addGeoLayer(layer, known, counter, added, () => skipped.push({ index, reason: 'duplicate' }));
		}
	}
	return { added, skipped };
}

/**
 * Nothing stored. The model is single-value (`monovalue: true` — only element
 * 0 is ever read), so N separate items would hide items 1..N-1 for good (and
 * knownGeoSignatures would then judge them present on every later append).
 * The FIRST incoming item is the host, stored as is; the layers of every
 * later item (a flat point as a Point layer) fold into its `lib_data` through
 * the same dedupe + renumber path an append onto a stored value takes — so
 * the outcome no longer depends on whether the record was empty.
 */
function foldIntoFirstIncoming(incoming: readonly unknown[]): AppendMergeResult {
	const hostIndex = incoming.findIndex(isObject);
	if (hostIndex === -1) return { items: [], skipped: [], idMapPlan: [] };
	const host = incoming[hostIndex] as AppendItem;
	const later = [...incoming.entries()].filter(
		([index, item]) => index > hostIndex && isObject(item),
	);
	const { added, skipped } = collectNewLayers([host], later);
	if (added.length === 0) return { items: [host], skipped, idMapPlan: [] };
	return { items: withHostLayers([host], 0, added), skipped, idMapPlan: [] };
}

/** `items` with `added` appended to the host item's `lib_data` (a new array; nothing mutated). */
function withHostLayers(
	items: readonly unknown[],
	hostIndex: number,
	added: readonly GeoLayer[],
): unknown[] {
	const host = items[hostIndex] as AppendItem;
	const hostLayers = Array.isArray(host.lib_data) ? host.lib_data : [];
	const result = [...items];
	result[hostIndex] = { ...host, lib_data: [...hostLayers, ...added] };
	return result;
}

/**
 * What the stored data already holds, as layer signatures: every drawn layer
 * AND every stored item's centre as a Point layer. The centre counts because
 * nothing-stored stores a flat `lat, lon` cell AS IS (a centre, no lib_data) —
 * without it a re-import of that same cell was not a duplicate and added a
 * Point layer on the second run (and over any centre-only item a replace
 * import wrote). A drawn map's centre is where its view is, so a point
 * imported exactly there is judged present too: the value IS stored.
 */
function knownGeoSignatures(stored: readonly unknown[]): Set<string> {
	const known = new Set(storedLayers(stored).map(layerSignature));
	for (const item of stored) {
		const centre = pointLayer(item);
		if (centre !== null) known.add(layerSignature(centre));
	}
	return known;
}

function storedLayers(stored: readonly unknown[]): GeoLayer[] {
	return stored.flatMap((item) => layersOf(item));
}

function layersOf(item: unknown): GeoLayer[] {
	if (!isObject(item) || !Array.isArray(item.lib_data)) return [];
	return item.lib_data.filter(isObject) as unknown as GeoLayer[];
}

/**
 * The highest finite numeric layer id anywhere in the stored data — layer
 * ids AND every feature's `properties.layer_id` (a text_area geo tag may name
 * either). String ids count when numeric; non-numeric ones cannot collide
 * with a fresh integer. Floor 0.
 */
function maxLayerId(stored: readonly unknown[]): number {
	let max = 0;
	for (const layer of storedLayers(stored)) {
		for (const id of [layer.layer_id, ...featureLayerIds(layer.layer_data)]) {
			max = Math.max(max, finiteOrZero(id));
		}
	}
	return max;
}

function finiteOrZero(id: unknown): number {
	const value = typeof id === 'string' && id.trim() === '' ? Number.NaN : Number(id);
	return Number.isFinite(value) ? value : 0;
}

function featuresOf(layerData: unknown): AppendItem[] {
	if (!isObject(layerData) || !Array.isArray(layerData.features)) return [];
	return layerData.features.filter(isObject);
}

function featureLayerIds(layerData: unknown): unknown[] {
	return featuresOf(layerData).map((feature) =>
		isObject(feature.properties) ? feature.properties.layer_id : undefined,
	);
}

/**
 * Layer identity for the duplicate skip: the layer's GEOMETRY content with the
 * feature `layer_id` stamps removed — the ids are renumbered on the way in, so
 * a re-import of the same file (conformed as layer 1) must still match the
 * layer it created (stored as layer N). `user_layer_name` is presentation.
 */
function layerSignature(layer: GeoLayer): string {
	const data = isObject(layer.layer_data) ? layer.layer_data : {};
	const features = featuresOf(data).map((feature) => ({
		...feature,
		properties: isObject(feature.properties) ? withoutKeys(feature.properties, ['layer_id']) : {},
	}));
	return canonicalJson({ ...data, features });
}

/** An incoming item's layers: its drawn `lib_data`, else its point as a Point layer. */
function incomingLayers(item: unknown, skipped: AppendSkip[], index: number): GeoLayer[] {
	const drawn = layersOf(item).filter((layer) => featuresOf(layer.layer_data).length > 0);
	if (drawn.length > 0) return drawn;
	const point = pointLayer(item);
	if (point === null) skipped.push({ index, reason: 'empty' });
	return point === null ? [] : [point];
}

/** A flat `lat, lon` item as a one-feature Point layer (GeoJSON is [lon, lat]). */
function pointLayer(item: unknown): GeoLayer | null {
	if (!isObject(item) || !isNumeric(item.lat) || !isNumeric(item.lon)) return null;
	const feature = {
		type: 'Feature',
		properties: { layer_id: 1 },
		geometry: { type: 'Point', coordinates: [Number(item.lon), Number(item.lat)] },
	};
	return { layer_id: 1, layer_data: { type: 'FeatureCollection', features: [feature] } };
}

function addGeoLayer(
	layer: GeoLayer,
	known: Set<string>,
	counter: { next: number },
	added: GeoLayer[],
	onDuplicate: () => void,
): void {
	const signature = layerSignature(layer);
	if (known.has(signature)) {
		onDuplicate();
		return;
	}
	known.add(signature);
	const layerId = counter.next;
	counter.next += 1;
	added.push(renumberLayer(layer, layerId));
}

/**
 * The layer under its fresh id: a deep clone (the incoming value is never
 * mutated) whose every feature `properties.layer_id` is rewritten — a feature
 * belongs to the layer that holds it, whatever stale id it carried.
 */
function renumberLayer(layer: GeoLayer, layerId: number): GeoLayer {
	const data = structuredClone(layer.layer_data) as AppendItem;
	for (const feature of featuresOf(data)) {
		feature.properties = {
			...(isObject(feature.properties) ? feature.properties : {}),
			layer_id: layerId,
		};
	}
	return { layer_id: layerId, layer_data: data, user_layer_name: `layer_${layerId}` };
}

// ---------------------------------------------------------------------------
// 'text_paragraphs' — text_area
// ---------------------------------------------------------------------------

/**
 * Every in-text Dédalo tag family, taken from the grammar's own type list
 * (tag_grammar.ts TAG_WIDTHS: tc, index, geo, page, person, note, lang) plus
 * the three it renders outside the sprite table (draw, svg, reference). The
 * bracket form is matched loosely on purpose — a near-tag refused is a loud
 * refusal the operator can fix, a tag let through is an orphaned index.
 */
const TAG_FAMILIES = [
	...Object.keys(TAG_WIDTHS).filter((type) => type !== 'tc'),
	'draw',
	'svg',
	'reference',
];

const TAG_DETECTORS: readonly RegExp[] = [
	new RegExp(TC_PATTERN.source),
	new RegExp(`\\[\\/?(?:${TAG_FAMILIES.join('|')})-[a-z]-[0-9]{0,6}(?:-[^\\]]*)?\\]`),
	// the rendered forms (tag_html.ts addTagImgOnTheFly), in case a file
	// carries editor HTML rather than stored markup
	/<img\b[^>]*\bdata-type\s*=/i,
	/<\/?reference\b/i,
];

/** Whether a text carries any Dédalo tag (bracket or rendered form). */
export function containsDedaloTag(text: string): boolean {
	return TAG_DETECTORS.some((detector) => detector.test(text));
}

function mergeTextParagraphs(input: AppendMergeInput): AppendMergeResult {
	const texts = input.incoming.map((raw) => incomingText(raw, input));
	const items = [...input.stored];
	const result: AppendMergeResult = { items, skipped: [], idMapPlan: [] };
	for (const [index, text] of texts.entries()) {
		appendParagraph(input, result, index, text);
	}
	return result;
}

/** The incoming value as text — refused loudly when tagged or not a string. */
function incomingText(raw: unknown, input: AppendMergeInput): string | null {
	const value = isObject(raw) ? raw.value : raw;
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string') throw textRefusal(input, 'the value is not text');
	if (containsDedaloTag(value)) {
		throw textRefusal(
			input,
			'the value carries Dédalo tags (index/tc/…), which an append cannot re-key',
		);
	}
	return value;
}

function textRefusal(input: AppendMergeInput, why: string): DedaloError {
	return new DedaloError('request.invalid_data', {
		message: `append merge: text for '${input.componentTipo}' refused — ${why}`,
		coordinates: { tipo: input.componentTipo },
	});
}

/** `<p>text</p>`, unless the text is already one paragraph element. */
export function paragraphFragment(text: string): string {
	const trimmed = text.trim();
	if (/^<p[\s>]/i.test(trimmed) && /<\/p>$/i.test(trimmed)) return trimmed;
	return `<p>${trimmed}</p>`;
}

function appendParagraph(
	input: AppendMergeInput,
	result: AppendMergeResult,
	index: number,
	text: string | null,
): void {
	const raw = input.incoming[index];
	if (text === null || text.trim() === '') {
		result.skipped.push({ index, reason: 'empty' });
		return;
	}
	const fragment = paragraphFragment(text);
	const hostIndex = result.items.findIndex((item) => isObject(item) && inLiteralScope(item, input));
	if (hostIndex === -1) {
		appendNewTextItem(input, result, index, fragment);
		return;
	}
	extendTextItem(input, result, hostIndex, fragment, index);
	if (isObject(raw)) recordId(result.idMapPlan, raw, textTarget(result.items[hostIndex]));
}

/** The host's id when it has one, else its reference (see targetOf). */
function textTarget(host: unknown): AppendIdTarget {
	const item = host as AppendItem;
	return isAbsentId(item.id) ? { kind: 'new', item } : { kind: 'existing', id: item.id };
}

function appendNewTextItem(
	input: AppendMergeInput,
	result: AppendMergeResult,
	index: number,
	fragment: string,
): void {
	const raw = input.incoming[index];
	const slice = result.items.filter((entry) => isObject(entry) && inLiteralScope(entry, input));
	const item = newLiteralItem(
		isObject(raw) ? raw : {},
		input,
		index,
		slice.length,
		sliceIds(slice),
	);
	item.value = fragment;
	result.items.push(item);
	if (isObject(raw)) recordId(result.idMapPlan, raw, { kind: 'new', item });
}

/** stored + fragment, as a NEW object (the stored item itself is never mutated). */
function extendTextItem(
	input: AppendMergeInput,
	result: AppendMergeResult,
	hostIndex: number,
	fragment: string,
	index: number,
): void {
	const host = result.items[hostIndex] as AppendItem;
	const current = storedText(host, input);
	if (current.includes(fragment)) {
		result.skipped.push({ index, reason: 'duplicate' });
		return;
	}
	// A host created earlier in THIS merge is extended in place: its object is
	// already referenced by idMapPlan and must be the one the engine ids.
	if (!input.stored.includes(host)) {
		host.value = current + fragment;
		return;
	}
	result.items[hostIndex] = { ...host, value: current + fragment };
}

function storedText(host: AppendItem, input: AppendMergeInput): string {
	const value = host.value;
	if (value === undefined || value === null) return '';
	if (typeof value !== 'string') throw textRefusal(input, 'the stored value is not text');
	return value;
}
