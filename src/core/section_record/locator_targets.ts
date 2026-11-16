/**
 * THE LOCATOR-TARGET LAW (T1-19 / D01 — WC-2026-11-12-locator-target-deleted-refused).
 *
 * THE RACE. A record delete strips every locator that points at the deleted
 * record (delete_record.ts removeAllInverseReferences) — but it can only strip
 * the locators its ONE inverse search finds. A save that ADDS a locator to that
 * record and commits after the search ran (or whose row the search could not yet
 * see) used to answer ok:true and leave the locator dangling forever: no lock
 * closed it (search_related.ts, the CONCURRENCY note), no gate detected it.
 *
 * THE PROTOCOL. Every write that adds a locator takes `FOR KEY SHARE` on the
 * locator's target row (db/matrix_write.ts lockMatrixRowsForKeyShare), held to
 * COMMIT; the record delete takes `FOR UPDATE` on its target first
 * (delete_record.ts lockRecordSnapshot). The two conflict, so exactly one of
 * them goes first:
 *   - the save first → the delete waits until the save COMMITS, and its inverse
 *     search (a later statement, a fresh READ COMMITTED snapshot) sees the new
 *     locator and strips it;
 *   - the delete first → the save's KEY SHARE waits until the delete COMMITS and
 *     then finds no row; the delete's Time Machine row (written in the same
 *     transaction) is visible, and the save is REFUSED, typed and loud
 *     (`relation.target_deleted`, 409) — never dropped silently (owner ruling
 *     2026-11-11: REFUSE).
 *
 * THE LOCK-MODE LAW that makes this deadlock-free between writers: every row
 * lock of a door that does not DELETE the row is `FOR NO KEY UPDATE`, which never
 * conflicts with `FOR KEY SHARE`. Two saves linking two records to each other, or
 * a save linking to a record another curator is editing, never wait on each
 * other. Census: delete_inverse_lost_update_native G5 (every `FOR UPDATE`
 * literal is a row-DELETING lock, named and reasoned).
 *
 * WHAT IS JUDGED — only an ADDED target (one the key did not reference before):
 *   - a KEPT locator is never re-judged — a record that already carries a
 *     dangling locator (pre-protocol residue) stays editable;
 *   - a target whose section_id is not a record ADDRESS (an external remote id
 *     such as '001338683') or is below 1 (deleteSectionRecord refuses those, so
 *     no delete can race them), or whose section has no matrix table (the
 *     delete throws section.no_matrix_table), has nothing to lock;
 *   - an absent target WITHOUT Time Machine history (a forward reference, an
 *     address that never held a record — an external section's remote id
 *     included) is accepted as before: OWNER DECISION A of the T1-19 plan
 *     (strict referential integrity) is not ruled.
 *
 * WHAT IS LOCKED — only an ADDED target, by every caller but the door's own
 * pre-lock of the values it was handed. A KEPT target is never locked: the
 * write cannot strand a locator its key already carried (a concurrent delete
 * strips it after this write commits — it waits on the owner row, never the
 * reverse), and a KEY SHARE on it taken after the owner's row lock is the
 * inverted order that deadlocks against that delete (T1-19 review: a portal
 * remove/reorder/update, or an observer re-save, whose full-array write keeps a
 * locator to the record being deleted).
 *
 * Callers: the record-write chokepoint (record_write.ts §3h — the `verify` key
 * entries: lockAddedLocatorTargets against an unlocked read BEFORE the owner
 * row's lock when nothing holds it yet, then the check under it) and the save
 * door's PRE-LOCK (save_component.ts applySaveComponentData — the changed
 * values, BEFORE the owner row's lock: the audit's lock order). The ONE residual
 * inversion: a door that already holds the owner row in an ambient transaction
 * (CSV row transaction, children write-through, tree doors) and ADDS a locator
 * to a record the owner ALREADY references in ANOTHER key can deadlock against
 * a concurrent delete of that record (40P01 — loud, never silent; named in the
 * WC). Gates: delete_inverse_lost_update_native R3 (added, door pre-lock), R5
 * (kept, save door), R6 (kept, owner-held ambient re-save).
 */

import { isConvertibleSectionIdString } from '../concepts/section_id.ts';
import { lockMatrixRowsForKeyShare, type MatrixRowRef } from '../db/matrix_write.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { getMatrixTableFromTipo } from '../ontology/resolver.ts';

/** The record a write targets (the owner) — RecordWriteTarget's shape, restated to stay a leaf. */
export interface LocatorOwner {
	table: string;
	sectionTipo: string;
	sectionId: number;
}

/** A locator's target as a record ADDRESS (int section_id ≥ 1). */
interface TargetAddress {
	sectionTipo: string;
	sectionId: number;
}

/** The address a stored/written section_id names, or null when it names no deletable row. */
function addressOf(value: unknown): number | null {
	const id = typeof value === 'string' ? stringAddress(value) : value;
	// deleteSectionRecord refuses section_id < 1: no delete can race such a target.
	return typeof id === 'number' && Number.isSafeInteger(id) && id >= 1 ? id : null;
}

/** A string section_id as an address — only the shared convertibility rule casts it. */
function stringAddress(value: string): number | null {
	return isConvertibleSectionIdString(value) ? Number(value) : null;
}

/** A plain (non-array) object, or null. */
function plainObject(item: unknown): Record<string, unknown> | null {
	if (item === null || typeof item !== 'object') return null;
	return Array.isArray(item) ? null : (item as Record<string, unknown>);
}

/** The address of one locator-shaped item, or null (not a locator, or no address). */
function targetOf(item: unknown): TargetAddress | null {
	const record = plainObject(item);
	const sectionTipo = record?.section_tipo;
	if (typeof sectionTipo !== 'string' || sectionTipo === '') return null;
	const sectionId = addressOf(record?.section_id);
	return sectionId === null ? null : { sectionTipo, sectionId };
}

/** One identity per address (int-normalized, so '7' and 7 are one target). */
function addressKey(target: TargetAddress): string {
	return `${target.sectionTipo}\u0000${target.sectionId}`;
}

/**
 * The distinct record addresses a relation value's items point at — a locator
 * list, a single locator, or a dataframe slot (each frame names its target the
 * same way). Anything else contributes nothing.
 */
export function locatorTargetsOf(value: unknown): TargetAddress[] {
	const items = Array.isArray(value) ? value : [value];
	const seen = new Map<string, TargetAddress>();
	for (const item of items) {
		const target = targetOf(item);
		if (target !== null) seen.set(addressKey(target), target);
	}
	return [...seen.values()];
}

/** The targets of `after` that `before` does not already reference (KEPT targets are never judged). */
export function addedLocatorTargets(before: unknown, after: unknown): TargetAddress[] {
	const kept = new Set(locatorTargetsOf(before).map(addressKey));
	return locatorTargetsOf(after).filter((target) => !kept.has(addressKey(target)));
}

/** The lockable rows of a target set: those whose section has a matrix table. */
async function lockableRows(targets: readonly TargetAddress[]): Promise<MatrixRowRef[]> {
	const rows: MatrixRowRef[] = [];
	for (const target of targets) {
		// No table ⇒ deleteSectionRecord throws section.no_matrix_table: no race to close.
		const table = await getMatrixTableFromTipo(target.sectionTipo);
		if (table !== null) rows.push({ table, ...target });
	}
	return rows;
}

/**
 * THE PRE-LOCK (save door): `FOR KEY SHARE` on every record the values point at,
 * BEFORE the owner row is locked. Never refuses — the chokepoint judges, under
 * the same (then re-entered) locks. MUST run inside the save's transaction.
 */
export async function lockLocatorTargets(values: readonly unknown[]): Promise<void> {
	const targets = values.flatMap((value) => locatorTargetsOf(value));
	if (targets.length === 0) return;
	await lockMatrixRowsForKeyShare(await lockableRows(targets));
}

/**
 * THE CHOKEPOINT'S PRE-LOCK (record_write.ts §3h): `FOR KEY SHARE` on the
 * targets each value ADDS over the key as currently stored (`before` — an
 * UNLOCKED read; the check below re-judges under the owner's lock). A KEPT
 * target is never locked: a concurrent delete of it strips the owner after this
 * write commits, and locking it here — possibly after an ambient owner lock —
 * is the inverted order that deadlocks against that delete. Never refuses.
 * MUST run inside the write's transaction.
 */
export async function lockAddedLocatorTargets(
	pairs: readonly { before: unknown; after: unknown }[],
): Promise<void> {
	const added = pairs.flatMap((pair) => addedLocatorTargets(pair.before, pair.after));
	if (added.length === 0) return;
	await lockMatrixRowsForKeyShare(await lockableRows(added));
}

/**
 * THE CHECK (record_write.ts §3h): lock every target `after` adds over `before`
 * (`FOR KEY SHARE`, to COMMIT) and REFUSE the write when one of them is a
 * DELETED record — absent from its table with Time Machine history at its
 * address. An absent address with no history is accepted (owner decision A is
 * open). MUST run inside the write's transaction, before its UPDATE.
 */
export async function assertAddedLocatorTargetsLive(
	owner: LocatorOwner,
	componentTipo: string,
	door: string,
	before: unknown,
	after: unknown,
): Promise<void> {
	const added = addedLocatorTargets(before, after);
	if (added.length === 0) return;
	const rows = await lockableRows(added);
	const present = new Set((await lockMatrixRowsForKeyShare(rows)).map((row) => addressKey(row)));
	const { addressHasTimeMachineHistory } = await import('../db/time_machine.ts');
	for (const row of rows) {
		if (present.has(addressKey(row))) continue;
		if (!(await addressHasTimeMachineHistory(row.sectionTipo, row.sectionId))) continue;
		refuseDeletedTarget(owner, componentTipo, door, row);
	}
}

/** The typed refusal of a link to a deleted record: THROWS (nothing is written). */
function refuseDeletedTarget(
	owner: LocatorOwner,
	componentTipo: string,
	door: string,
	target: TargetAddress,
): never {
	const sentence =
		`The linked record ${target.sectionTipo}/${target.sectionId} was deleted — remove the ` +
		'link (or restore the record from Time Machine) and save again';
	throw new DedaloError('relation.target_deleted', {
		message: `${door}: ${owner.sectionTipo}/${owner.sectionId} ${componentTipo} → ${sentence}`,
		publicMessage: sentence,
		details: { section_tipo: target.sectionTipo },
		coordinates: {
			section_tipo: owner.sectionTipo,
			section_id: owner.sectionId,
			tipo: componentTipo,
			target_section_tipo: target.sectionTipo,
			target_section_id: target.sectionId,
			door,
		},
	});
}
