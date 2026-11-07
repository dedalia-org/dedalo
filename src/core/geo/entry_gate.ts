/**
 * The SAVE GATE of a component_geolocation value — the one door every write of
 * the component passes (section/record/save_component.ts → item_gates.ts), so
 * the client API, the MCP tools, an agent change-plan, the CSV/JSON import and
 * tool_propagate_component_data all meet it. There is no tool-only writer of
 * `sources` or `legend`: they are keys of the component's own value, saved with
 * the component.
 *
 * It runs on the FINAL item array of a save (after the change loop, under the
 * row lock, before the write) with the STORED items beside it, and does four
 * things to `sources` and `legend`:
 *
 *  0. BOUNDS THE VALUE. The per-entry caps (map_source.ts, map_legend.ts) bound
 *     one entry, and the component is monovalue — yet the value is an array, and
 *     `set_data` stores every entry it is given. So the value as a whole carries
 *     at most VALUE_LIMITS sources, legends (that say something), legend text
 *     characters and icon characters (four entries' worth each: the entry the
 *     editor works on, plus the inert extra entries a propagate "add" stores —
 *     only the first entry is ever read). That bounds the gate's own work under
 *     the row lock (every incoming source and legend is compared with the stored
 *     ones) and what a save echo can carry: a text-only legend is ~208K
 *     characters at its caps, and without the legend count and text budget a
 *     value of many such entries was bounded by nothing but the request size.
 *  1. VALIDATES what changed — shape, URL template, caps (map_source.ts,
 *     map_legend.ts). A source byte-identical to the stored one with the same id
 *     is TRUSTED and not re-judged: a record saved before a rule tightened
 *     remains editable, and the tile proxy re-validates at fetch time, which is
 *     what keeps such a source from being served. A legend equal to a stored one
 *     likewise (the legend is re-validated again where it is SERVED:
 *     map_legend.ts servedMapLegend, and the sources' attribution with it:
 *     map_source.ts servedMapSources). A refusal throws `request.invalid_data`
 *     and the whole save rolls back; nothing is stored half-validated.
 *  2. NORMALIZES to the one stored form — `sources` null or `[]` and a legend
 *     that says nothing are removed as keys, so equal values store equal bytes.
 *  3. SETTLES SOURCE IDS (the part with a contract). Ids are SERVER-ISSUED, from
 *     the component's own item counter (matrix_write.ts allocateComponentItemId —
 *     the counter that already numbers items, atomic and monotonic). That gives
 *     both laws:
 *       UNIQUE   the counter hands each number out once, and an id the caller
 *                names is honoured only when it is a source the component
 *                ALREADY stores and no earlier source of the value holds — so
 *                no caller can mint a colliding id;
 *       NEVER REUSED   the counter never goes down, and a deleted source's id
 *                is no longer a stored one — a client that sends it back (an
 *                undo, a propagated copy, a re-imported export) gets a FRESH id,
 *                never the old one. The save echo carries the final ids.
 *     Every source of the value is settled in this order:
 *       a. KEEPS its id when it names a stored one nobody holds yet (the first
 *          source to name an id holds it, across every entry of the value);
 *       b. ADOPTS a stored id by CONTENT when it keeps none: a source without
 *          an id (the only way a hand-written CSV/JSON cell can name one — ids
 *          are server-issued), with an id the component does not store, or
 *          that repeats a held id, takes the id of a stored, still-unheld
 *          source it equals (id aside, as written or once normalized). A
 *          re-import of an unchanged cell is therefore a no-op, not a new
 *          source per run. Only STORED ids are ever adopted, so a deleted
 *          source's number is still never handed out again;
 *       c. is otherwise NEW and receives the next number from the counter.
 *     What does NOT depend on how the value is ordered: an explicit id outranks
 *     a content match wherever the two sit, and a stored source is adopted once.
 *     What DOES: two sources that name the SAME stored id are resolved by
 *     position — the first holds the number, the second is a COPY and is numbered
 *     like any new source (a duplicated row, a propagated entry from another
 *     record that happens to use the same small number). So [genuine, foreign]
 *     and [foreign, genuine] both keep ONE of the two under the stored number,
 *     the one listed first. An id is a per-record number — it means "this
 *     record's source N", so a foreign entry that names a number the record holds
 *     is an EDIT of that source, content replaced (the same law as any other
 *     edit of it).
 *  4. ADOPTS THE ENTRY'S OWN ID for an entry that arrives without one and, once
 *     its sources are settled, equals the stored entry at the same position
 *     (concepts/item_value.ts — the same rule the set_data carry-over applies,
 *     run again here because that one runs BEFORE this gate and compares the
 *     id-less sources of a CSV cell with stored ones that carry ids). Together
 *     with 3b this is what makes an unchanged re-import persist a byte-equal
 *     region: the undo log's no-op law writes nothing, the counter does not
 *     move.
 *
 * REPLACE SEMANTICS. The save of an entry replaces the entry (monovalue update):
 * a value sent without `sources` stores no sources. The client always sends the
 * whole entry it loaded; a writer that builds a value from scratch deletes what
 * it did not carry — the same law that already applies to `lib_data`.
 *
 * OWNERSHIP. The gate WRITES NOTHING IT WAS GIVEN. `items` is not the save's
 * private array: the caller's value objects are shared — by `set_data` (the
 * generic carry-over returns the caller's entries unless it adopts an id), and
 * above all by tool_propagate_component_data, which hands ONE value to every
 * target record. A gate that settled ids in place would leak record 1's minted
 * numbers into the shared object, where records 2..N would read them as ids the
 * caller named — overwriting their own sources and breaking "never reused" in
 * the bulk door. So the gate settles its own copy of each entry (the sibling
 * keys deep-copied, the rest by reference and never written) and RETURNS the
 * gated array; `items` and `stored` are left exactly as they were. The caller
 * continues with the returned array.
 *
 * Gate: test/unit/geo_sources_legend_save_native.test.ts (DB) and
 * test/unit/geo_entry_gate_native.test.ts (pure).
 */

import { canonicalJson } from '../concepts/canonical_json.ts';
import { adoptStoredItemIds } from '../concepts/item_value.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { type Checked, fail, isRecord, pass } from './checked.ts';
import { GEO_SIBLING_KEYS, hasNoLegendContent } from './geo_entry_keys.ts';
import {
	isEmptyLegend,
	LEGEND_LIMITS,
	LEGEND_TEXT_CHARS_MAX,
	legendIconChars,
	legendTextChars,
	validateMapLegend,
} from './map_legend.ts';
import { checkSourceList, MAP_SOURCE_LIMITS, validateMapSource } from './map_source.ts';

/**
 * What ONE component value may carry of a map definition, all its entries
 * together (see the header, 0): four entries' worth of the per-entry caps.
 */
export const VALUE_LIMITS = {
	maxSources: MAP_SOURCE_LIMITS.maxSources * 4,
	maxIconChars: LEGEND_LIMITS.maxIconCharsTotal * 4,
	/** Legends that say something (an absent, null or empty one is not counted). */
	maxLegends: 4,
	maxLegendTextChars: LEGEND_TEXT_CHARS_MAX * 4,
} as const;

/** A stored source as the gate remembers it: its canonical text, and that text without the id. */
interface StoredSource {
	text: string;
	content: string;
}

/** What a component already stores: its sources by id (in stored order) and its legends. */
interface StoredSiblings {
	sources: Map<number, StoredSource>;
	legends: Set<string>;
}

/** Log-only identifiers of the save (never serialized to the client). */
export type GateCoordinates = Readonly<Record<string, string | number>>;

/** The id slots a gate run still has to fill from the counter, in value order. */
type PendingIds = Record<string, unknown>[];

/** The state one gate run threads through its steps. */
interface GateRun {
	known: StoredSiblings;
	/** The stored source ids some source of THIS value already holds. */
	claimed: Set<number>;
	pending: PendingIds;
}

type Entry = Record<string, unknown>;

/** Remove `key` from `entry` (the key is gone, not set to undefined: stored bytes stay minimal). */
function dropKey(entry: Entry, key: string): void {
	Reflect.deleteProperty(entry, key);
}

function isStoredId(id: unknown): id is number {
	return typeof id === 'number' && Number.isSafeInteger(id) && id >= 1;
}

/** A copy of `source` without its `id`: the part of a source that is its CONTENT. */
function withoutId(source: object): Entry {
	const { id: _id, ...content } = source as Entry;
	return content;
}

function rememberSources(known: StoredSiblings, entry: Entry): void {
	const sources = Array.isArray(entry.sources) ? entry.sources : [];
	for (const source of sources) {
		if (!isRecord(source) || !isStoredId(source.id)) continue;
		known.sources.set(source.id, {
			text: canonicalJson(source),
			content: canonicalJson(withoutId(source)),
		});
	}
}

function storedSiblings(stored: readonly unknown[]): StoredSiblings {
	const known: StoredSiblings = { sources: new Map(), legends: new Set() };
	for (const entry of stored) {
		if (!isRecord(entry)) continue;
		rememberSources(known, entry);
		if (isRecord(entry.legend)) known.legends.add(canonicalJson(entry.legend));
	}
	return known;
}

/**
 * The ids of the sources a component stores. The save path raises the item
 * counter to at least the largest of them BEFORE minting: a record born from a
 * duplicate (whose counter was copied from the item ids alone) or restored from
 * history may store source ids above its counter, and minting without this would
 * hand out one that is taken.
 */
export function storedSourceIds(stored: readonly unknown[]): number[] {
	return [...storedSiblings(stored).sources.keys()];
}

// ---------------------------------------------------------------------------
// Step a — who keeps the id it names
// ---------------------------------------------------------------------------

/** The stored id `item` keeps (and now holds), or null when it keeps none. */
function claimOne(item: unknown, run: GateRun): number | null {
	if (!isRecord(item) || !isStoredId(item.id)) return null;
	if (!run.known.sources.has(item.id) || run.claimed.has(item.id)) return null;
	run.claimed.add(item.id);
	return item.id;
}

/**
 * For one entry, per listed source, the stored id it keeps. Run over EVERY
 * entry before any source is settled, so an explicit id outranks a content match
 * wherever in the value the two appear.
 */
function claimEntry(entry: Entry, run: GateRun): (number | null)[] {
	return Array.isArray(entry.sources) ? entry.sources.map((item) => claimOne(item, run)) : [];
}

// ---------------------------------------------------------------------------
// Steps b and c — adopt by content, or number
// ---------------------------------------------------------------------------

/** The stored, still-unheld source whose content is `content`: its id, now held; else null. */
function adoptByContent(content: string, run: GateRun): number | null {
	for (const [id, source] of run.known.sources) {
		if (source.content !== content || run.claimed.has(id)) continue;
		run.claimed.add(id);
		return id;
	}
	return null;
}

/** A source that keeps its stored id: trusted when byte-identical to the stored one, else judged. */
function settleKept(source: Entry, id: number, where: string, run: GateRun): Checked<Entry> {
	if (run.known.sources.get(id)?.text === canonicalJson(source)) return pass({ ...source });
	const checked = validateMapSource(source, where);
	return checked.ok ? pass({ ...checked.value }) : checked;
}

/** A source that keeps no id: adopted by content when a stored one equals it, else new. */
function settleOther(item: unknown, where: string, run: GateRun): Checked<Entry> {
	if (isRecord(item)) {
		// As written first: a source equal to a stored one needs no judging, however
		// the rules have moved since that one was stored (the trust-unchanged law).
		const content = withoutId(item);
		const same = adoptByContent(canonicalJson(content), run);
		if (same !== null) return pass({ id: same, ...content });
	}
	const checked = validateMapSource(item, where);
	if (!checked.ok) return checked;
	const body = withoutId(checked.value);
	const adopted = adoptByContent(canonicalJson(body), run);
	if (adopted !== null) return pass({ id: adopted, ...body });
	const fresh: Entry = { id: 0, ...body };
	run.pending.push(fresh);
	return pass(fresh);
}

/** One listed source → its stored form. */
function settleSource(
	item: unknown,
	kept: number | null,
	where: string,
	run: GateRun,
): Checked<Entry> {
	return kept !== null && isRecord(item)
		? settleKept(item, kept, where, run)
		: settleOther(item, where, run);
}

/** Every listed source through `settleSource`, in order; the settled list, or the first refusal. */
function settleSources(
	list: readonly unknown[],
	kept: readonly (number | null)[],
	run: GateRun,
): Checked<Entry[]> {
	const settled: Entry[] = [];
	for (const [index, item] of list.entries()) {
		const one = settleSource(item, kept[index] ?? null, `sources[${index}]`, run);
		if (!one.ok) return one;
		settled.push(one.value);
	}
	return pass(settled);
}

/** Gate the `sources` of `entry` (the gate's own copy): settle them, or drop the key when none. */
function gateSources(entry: Entry, kept: readonly (number | null)[], run: GateRun): Checked<true> {
	if (entry.sources === undefined || entry.sources === null) {
		dropKey(entry, 'sources');
		return pass(true);
	}
	const list = checkSourceList(entry.sources, 'sources');
	if (!list.ok) return list;
	const settled = settleSources(list.value, kept, run);
	if (!settled.ok) return settled;
	if (settled.value.length === 0) dropKey(entry, 'sources');
	else entry.sources = settled.value;
	return pass(true);
}

function gateLegend(entry: Entry, known: StoredSiblings): Checked<true> {
	if (entry.legend === undefined || entry.legend === null) {
		dropKey(entry, 'legend');
		return pass(true);
	}
	if (known.legends.has(canonicalJson(entry.legend))) return pass(true);
	const checked = validateMapLegend(entry.legend, 'legend');
	if (!checked.ok) return checked;
	if (isEmptyLegend(checked.value)) dropKey(entry, 'legend');
	else entry.legend = checked.value;
	return pass(true);
}

function gateEntry(entry: Entry, kept: readonly (number | null)[], run: GateRun): Checked<true> {
	const sources = gateSources(entry, kept, run);
	return sources.ok ? gateLegend(entry, run.known) : sources;
}

// ---------------------------------------------------------------------------
// The value
// ---------------------------------------------------------------------------

/**
 * A copy of `item` the gate may settle: for an entry, a shallow copy whose sibling
 * keys are deep copies (the keys the gate rewrites), so no write of the gate can
 * reach the caller's objects. Anything that is not an entry passes through.
 */
function ownedItem(item: unknown): unknown {
	if (!isRecord(item)) return item;
	const owned: Entry = { ...item };
	for (const key of GEO_SIBLING_KEYS) {
		if (key in owned) owned[key] = structuredClone(owned[key]);
	}
	return owned;
}

/** Whether `legend` is one that says something — what the legend count counts (any shape). */
function carriesLegend(legend: unknown): boolean {
	if (legend === undefined || legend === null) return false;
	return !(isRecord(legend) && hasNoLegendContent(legend));
}

/** The sum of `count` over the entries. */
function totalOf(entries: readonly Entry[], count: (entry: Entry) => number): number {
	return entries.reduce((total, entry) => total + count(entry), 0);
}

/** The legends of the entries, by count, text and icon characters, against VALUE_LIMITS. */
function checkLegendBudget(entries: readonly Entry[]): Checked<true> {
	const iconChars = totalOf(entries, (entry) => legendIconChars(entry.legend));
	if (iconChars > VALUE_LIMITS.maxIconChars) {
		return fail(
			`legend: icons of ${iconChars} characters in one value, more than ${VALUE_LIMITS.maxIconChars}`,
		);
	}
	const textChars = totalOf(entries, (entry) => legendTextChars(entry.legend));
	if (textChars > VALUE_LIMITS.maxLegendTextChars) {
		return fail(
			`legend: text of ${textChars} characters in one value, more than ${VALUE_LIMITS.maxLegendTextChars}`,
		);
	}
	const legends = totalOf(entries, (entry) => (carriesLegend(entry.legend) ? 1 : 0));
	return legends > VALUE_LIMITS.maxLegends
		? fail(`legend: ${legends} legends in one value, more than ${VALUE_LIMITS.maxLegends}`)
		: pass(true);
}

/** What the entries LIST, together, against VALUE_LIMITS (header, 0): sources, then legends. */
function checkValueBudget(entries: readonly Entry[]): Checked<true> {
	const sources = totalOf(entries, (entry) =>
		Array.isArray(entry.sources) ? entry.sources.length : 0,
	);
	if (sources > VALUE_LIMITS.maxSources) {
		return fail(`sources: ${sources} in one value, more than ${VALUE_LIMITS.maxSources}`);
	}
	return checkLegendBudget(entries);
}

/** Every entry through the gate, in order; the first refusal wins. */
function gateEntries(entries: readonly Entry[], run: GateRun): Checked<true> {
	const kept = entries.map((entry) => claimEntry(entry, run));
	for (const [index, entry] of entries.entries()) {
		const verdict = gateEntry(entry, kept[index] ?? [], run);
		if (!verdict.ok) return verdict;
	}
	return pass(true);
}

/** The value's budget first (nothing is compared before it), then each entry. */
function judgeValue(entries: readonly Entry[], run: GateRun): Checked<true> {
	const budget = checkValueBudget(entries);
	return budget.ok ? gateEntries(entries, run) : budget;
}

/**
 * Gate the final `items` of a geolocation save against the `stored` ones: see the
 * module header. `mint` returns the next number of the component's item counter.
 * Returns the gated array — the same length and order as `items`, each entry the
 * gate's own copy, an id-less entry that equals the stored one at its position
 * carrying that entry's id (header, 4). NOTHING it was given is written (header,
 * OWNERSHIP). Throws `request.invalid_data` on the first refusal, before any id
 * is minted.
 */
export async function gateGeoEntries(
	items: readonly unknown[],
	stored: readonly unknown[],
	mint: () => Promise<number>,
	coordinates: GateCoordinates,
): Promise<unknown[]> {
	const owned = items.map(ownedItem);
	const run: GateRun = { known: storedSiblings(stored), claimed: new Set(), pending: [] };
	const verdict = judgeValue(owned.filter(isRecord), run);
	if (!verdict.ok) {
		throw new DedaloError('request.invalid_data', {
			message: `component_geolocation: ${verdict.reason}`,
			coordinates,
		});
	}
	// The pending slots are objects inside the owned entries' settled `sources` lists,
	// which the adopted copies below share: minting after the adoption fills them all.
	const gated = adoptStoredItemIds(owned, stored);
	// In value order, so the numbers a value receives read in the order it lists them.
	for (const slot of run.pending) slot.id = await mint();
	return gated;
}
