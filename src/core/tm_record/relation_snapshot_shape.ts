/**
 * RELATION SNAPSHOT SHAPE — the gate between a per-component
 * matrix_time_machine datum and the RELATION column of the virtual dd15 record
 * (tm_record.ts buildTmSectionRecord, the single dd15 builder).
 *
 * Every relation reader downstream (select family list labels, the portal
 * family, the datalist, compareLocators) takes that column as an ARRAY OF
 * LOCATORS. The live matrix tables honour it (measured 2026-10-24: zero
 * non-locator relation values in any matrix table, and none inside a
 * whole-record snapshot's relation column), but per-component TM rows are
 * decade-scale audit history and some still hold shapes earlier engines stored
 * and no upgrade converted: a bare section_id (`2`), a pre-4.9 filter object
 * (`{"1": 2}`), label strings (`["Hispania"]`), another model's object under a
 * reused tipo, a locator with no address. Wrapped as `[2]`, a bare id reached
 * compareLocators (`'section_tipo' in 2` → TypeError) and 500'd the whole
 * history read.
 *
 * NO CONVERSION HAPPENS HERE, deliberately (owner decision 2026-10-24): those
 * values are pre-v6 data the v6→v7 UPGRADE owns converting; a v7 reader that
 * guessed their meaning would make every install depend on a read-time rule
 * nobody stores. This gate only REFUSES, with a stated reason: the dd15 builder
 * leaves the component's own column empty (the raw dd1574 copy still carries
 * the stored bytes) and the history reader emits a flagged
 * `malformed_relation_value` cell carrying the reason (read_tm.ts, the named
 * exemption beside `unresolved_component_tipo`) — never a 500, never a silent
 * drop.
 *
 * Accepted: null (no value), an array whose EVERY entry is an addressed
 * locator, and a single addressed locator object (the non-array datum
 * tm_record has always coerced to `[datum]`, as PHP get_data did).
 */

import { DedaloError } from '../errors/index.ts';

/** The error token the history reader stamps on a refused cell. */
export const MALFORMED_RELATION_VALUE_ERROR = 'malformed_relation_value';

export type RelationSnapshotShape =
	| { readonly kind: 'locators'; readonly items: unknown[] | null }
	| { readonly kind: 'refused'; readonly reason: string };

/** A stored locator: an object naming both halves of a record address. */
export function isAddressedLocator(value: unknown): boolean {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return hasValue(candidate.section_tipo) && hasValue(candidate.section_id);
}

function hasValue(value: unknown): boolean {
	return value !== undefined && value !== null && value !== '';
}

/** Classify one per-component TM datum of a RELATION-column model. */
export function classifyRelationSnapshot(data: unknown): RelationSnapshotShape {
	// `== null`: null and undefined are both "no value".
	if (data == null) return { kind: 'locators', items: null };
	if (isAddressedLocator(data)) return { kind: 'locators', items: [data] };
	if (!Array.isArray(data)) {
		return refused(`the stored value ${describe(data)} is not a locator array`);
	}
	const bad = data.find((entry) => !isAddressedLocator(entry));
	if (bad === undefined) return { kind: 'locators', items: data };
	return refused(`the stored array holds a non-locator entry ${describe(bad)}`);
}

/**
 * THE RESTORE DOORS' form of the gate (tool_time_machine apply_value, the
 * whole-record restore/undelete): the value to WRITE (a single locator coerced
 * to `[locator]`, the shape every live relation key has), or a THROWN
 * `tool.snapshot_unrestorable` — a refused value is never written into a live
 * relation column. `coordinates` name the row for the log; the offending value
 * rides them as `reason` (log-only — it is stored record data).
 */
export function restorableRelationValue(
	data: unknown,
	coordinates: Record<string, string | number>,
): unknown[] | null {
	const shape = classifyRelationSnapshot(data);
	if (shape.kind === 'locators') return shape.items;
	throw new DedaloError('tool.snapshot_unrestorable', {
		coordinates: { ...coordinates, reason: shape.reason },
	});
}

function refused(reason: string): RelationSnapshotShape {
	return { kind: 'refused', reason };
}

/** A short, bounded rendering of the offending value for the reason text. */
function describe(value: unknown): string {
	const text = JSON.stringify(value) ?? String(value);
	return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}
