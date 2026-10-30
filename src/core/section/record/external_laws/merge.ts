/**
 * THE ONE MIRROR MERGE — how a law's desired set becomes the stored bag, for
 * every external-value law (./types.ts). One merge, so the item-id and
 * identity rules cannot differ between laws.
 *
 * IDENTITY is the record address `section_tipo|section_id` (String()-compared,
 * so a legacy string id and its canonical int are the same record). First
 * occurrence wins on both sides.
 *
 * ITEM IDS BELONG TO THE MIRROR. A kept address keeps its stored id; a new one
 * gets the next id past the stored maximum (nextObserverItemId). PHP's copy
 * laws stored the SOURCE's item ids verbatim — so a type switch A→B kept A's
 * ids on B's items and the kernel's drop-by-dropped-id frame cascade paired
 * the wrong frames. Owning the ids keeps that cascade correct (WC-ledgered).
 *
 * TWO ORDERS (the law states which — LawComputeResult.order):
 *   'stored'  — kept entries in STORED order, verbatim, then the additions
 *               appended: law (c), byte-identical to the merge it always had
 *               (observers.ts mirrorAdditions, moved here);
 *   'desired' — the LAW's order: "ordered coins" (testcoincatalog1019 copies a
 *               sorted bag), the order the tags were written in. A kept item
 *               is rebuilt from the desired item (every key but `id` and
 *               `from_component_tipo` — a tag locator's component_tipo
 *               survives, critique 2) with its stored id; when the rebuilt item
 *               EQUALS the stored one (key order aside — jsonb normalizes key
 *               order, so a re-read bag never matches a freshly built object
 *               byte for byte) the stored object is emitted VERBATIM, so a
 *               no-drift recompute stays a no-drift recompute and writes
 *               nothing.
 *
 * Every BUILT item carries `from_component_tipo` = the observer, `type` = the
 * desired item's own else the law's fallback, and a canonical int section_id
 * (a non-convertible remote id survives verbatim). `dropSelf` drops desired
 * items addressing the target record itself (the copy laws; law (c) never
 * dropped them and keeps that).
 */

import { canonicalizeStoredSectionId } from '../../../concepts/section_id.ts';
import type { DesiredLocator, MergeOrder, RecordAddress, StoredLocator } from './types.ts';

/**
 * The next append item id: max FINITE numeric id + 1. A single malformed
 * legacy id (`Number('x')` = NaN) must NOT NaN-poison the reduce — NaN ids
 * serialize as `null`, so EVERY appended entry would share id null and break
 * id-based pairing (id_key/dataframe, TM restore) downstream (review
 * 2026-08-02). Non-finite ids are treated as 0 for the max — appends still
 * get finite, monotonic ids. (Moved verbatim from observers.ts.)
 */
export function nextObserverItemId(existing: { id?: unknown }[]): number {
	let max = 0;
	for (const entry of existing) {
		const numericId = Number(entry?.id ?? 0);
		if (Number.isFinite(numericId) && numericId > max) max = numericId;
	}
	return max + 1;
}

/** The merge identity of a locator. */
export function mirrorKey(entry: { section_tipo?: unknown; section_id?: unknown }): string {
	return `${entry.section_tipo}|${String(entry.section_id)}`;
}

export interface MergeMirrorOptions {
	/** Item `type` for a desired item that carries none. */
	fallbackType: string;
	/** When set, desired items addressing this record are dropped. */
	dropSelf?: RecordAddress;
}

export interface MergeMirrorResult {
	/** The full-law bag: what an undegraded recompute stores. */
	merged: StoredLocator[];
	/** The merged items whose address was already stored. */
	kept: StoredLocator[];
	/** The merged items whose address is new (fresh item ids). */
	additions: StoredLocator[];
}

function isAddressable(item: DesiredLocator | null | undefined): item is DesiredLocator {
	return (
		item !== null &&
		typeof item === 'object' &&
		typeof item.section_tipo === 'string' &&
		item.section_tipo !== '' &&
		item.section_id !== undefined &&
		item.section_id !== null
	);
}

/** A built mirror item (key order: id, type, section_id, section_tipo, …rest, from_component_tipo). */
function buildItem(
	desired: DesiredLocator,
	id: number,
	observerTipo: string,
	fallbackType: string,
): StoredLocator {
	const {
		id: _sourceId,
		from_component_tipo: _sourceFrom,
		type,
		section_id,
		section_tipo,
		...rest
	} = desired as DesiredLocator & { id?: unknown; from_component_tipo?: unknown };
	return {
		id,
		type: typeof type === 'string' && type !== '' ? type : fallbackType,
		// Not a blind Number(): a non-convertible id (external remote ref)
		// survives verbatim (WC-2026-08-10-section-id-int-canonical).
		section_id: canonicalizeStoredSectionId(section_id) as number | string,
		section_tipo,
		...rest,
		from_component_tipo: observerTipo,
	};
}

/** Structural equality with key order ignored at every level (jsonb normalizes it). */
function sameValue(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (!isObjectLike(left) || !isObjectLike(right)) return false;
	if (Array.isArray(left) !== Array.isArray(right)) return false;
	return Array.isArray(left) ? sameArray(left, right as unknown[]) : sameRecord(left, right);
}

function isObjectLike(value: unknown): value is object {
	return value !== null && typeof value === 'object';
}

function sameArray(left: readonly unknown[], right: readonly unknown[]): boolean {
	return left.length === right.length && left.every((item, at) => sameValue(item, right[at]));
}

function sameRecord(left: object, right: object): boolean {
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord);
	if (leftKeys.length !== Object.keys(rightRecord).length) return false;
	return leftKeys.every(
		(key) => Object.hasOwn(rightRecord, key) && sameValue(leftRecord[key], rightRecord[key]),
	);
}

/** Law (c)'s merge, unchanged: kept in stored order, then the additions. */
function mergeStoredOrder(
	existing: readonly StoredLocator[],
	desired: readonly DesiredLocator[],
	observerTipo: string,
	options: MergeMirrorOptions,
): MergeMirrorResult {
	const desiredKeys = new Set<string>();
	const candidates: DesiredLocator[] = [];
	for (const item of desired) {
		if (!isAddressable(item) || isSelf(item, options.dropSelf)) continue;
		desiredKeys.add(mirrorKey(item));
		candidates.push(item);
	}
	// Every stored entry still wanted, duplicates included (the historical law).
	const kept = existing.filter((entry) => desiredKeys.has(mirrorKey(entry)));
	// Deduped against ALL stored keys — identical to deduping against the kept
	// half: a stored entry outside the desired set has, by construction, no
	// matching desired item.
	const presentKeys = new Set(existing.map(mirrorKey));
	let nextId = nextObserverItemId(existing as StoredLocator[]);
	const additions: StoredLocator[] = [];
	for (const item of candidates) {
		const key = mirrorKey(item);
		if (presentKeys.has(key)) continue;
		presentKeys.add(key);
		additions.push(buildItem(item, nextId++, observerTipo, options.fallbackType));
	}
	return { merged: [...kept, ...additions], kept, additions };
}

function isSelf(item: DesiredLocator, self: RecordAddress | undefined): boolean {
	return self !== undefined && mirrorKey(item) === mirrorKey(self);
}

/** The FIRST stored entry per address (a later stored duplicate is not a kept item). */
function firstStoredByKey(existing: readonly StoredLocator[]): Map<string, StoredLocator> {
	const storedByKey = new Map<string, StoredLocator>();
	for (const entry of existing) {
		const key = mirrorKey(entry);
		if (!storedByKey.has(key)) storedByKey.set(key, entry);
	}
	return storedByKey;
}

/**
 * The item-id allocator of one desired-order merge. A kept address keeps its
 * id — unless it is malformed, or an earlier stored duplicate already claimed
 * it (ids pair frames: never two alike); everything else takes the next id past
 * the stored max.
 */
function createItemIdAllocator(
	existing: readonly StoredLocator[],
): (stored?: StoredLocator) => number {
	let nextId = nextObserverItemId(existing as StoredLocator[]);
	const usedIds = new Set<number>();
	return (stored) => {
		const storedId = Number(stored?.id);
		const keepsId = stored !== undefined && Number.isInteger(storedId) && storedId > 0;
		const id = keepsId && !usedIds.has(storedId) ? storedId : nextId++;
		usedIds.add(id);
		return id;
	};
}

/** A kept item equal to the stored one up to key order is re-emitted verbatim (no-drift = no write). */
function keptEntry(built: StoredLocator, stored: StoredLocator): StoredLocator {
	return sameValue(built, stored) ? stored : built;
}

/** The copy laws' merge: the desired order is the value. */
function mergeDesiredOrder(
	existing: readonly StoredLocator[],
	desired: readonly DesiredLocator[],
	observerTipo: string,
	options: MergeMirrorOptions,
): MergeMirrorResult {
	const storedByKey = firstStoredByKey(existing);
	const allocateId = createItemIdAllocator(existing);
	const seen = new Set<string>();
	const merged: StoredLocator[] = [];
	const kept: StoredLocator[] = [];
	const additions: StoredLocator[] = [];
	for (const item of desired) {
		if (!isAddressable(item) || isSelf(item, options.dropSelf)) continue;
		const key = mirrorKey(item);
		if (seen.has(key)) continue;
		seen.add(key);
		const stored = storedByKey.get(key);
		const built = buildItem(item, allocateId(stored), observerTipo, options.fallbackType);
		if (stored === undefined) {
			merged.push(built);
			additions.push(built);
			continue;
		}
		const entry = keptEntry(built, stored);
		merged.push(entry);
		kept.push(entry);
	}
	return { merged, kept, additions };
}

/**
 * Merge a law's desired set onto the stored bag (see the header). Pure: the
 * inputs are never mutated; kept stored objects are re-emitted by reference.
 */
export function mergeMirror(
	existing: readonly StoredLocator[],
	desired: readonly DesiredLocator[],
	observerTipo: string,
	order: MergeOrder,
	options: MergeMirrorOptions,
): MergeMirrorResult {
	return order === 'stored'
		? mergeStoredOrder(existing, desired, observerTipo, options)
		: mergeDesiredOrder(existing, desired, observerTipo, options);
}
