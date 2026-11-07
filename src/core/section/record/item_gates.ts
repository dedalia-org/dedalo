/**
 * ITEM GATES — the model-specific checks saveComponentData runs over the FINAL
 * items of a save (`itemGate` descriptor facet, components/types.ts ItemGateId).
 *
 * The generic write engine judges an item's SHAPE (object-ness, relation
 * locators, html markup, password hashing); some models also carry keys whose
 * validity depends on what the component STORES — which ids already exist, which
 * must be issued. Those need the stored items and the item counter, both of
 * which the save holds under its row lock. The gate is keyed on the DESCRIPTOR
 * facet, never on the model string, so a model opts in on its own line.
 *
 * A gate THROWS `request.invalid_data` to refuse (the save rolls back) and
 * otherwise RETURNS the normalized items — it never writes into the array or the
 * entries it was given. They are not the save's private data: `set_data` carries
 * the caller's own value objects through, and a bulk door (propagate) hands ONE
 * value to every target record, so an in-place gate would leak one record's
 * settled ids into the next record's save. The caller continues with the returned
 * array. For a model with no gate this is one lookup and `items` back as it is.
 *
 * Because the caller continues with the RETURNED array, a gated model must write
 * its full array, not the atomic-insert concatenation (which appends the
 * caller's own insert values, never the gate's): a model that declares an
 * `itemGate` is monovalue, whose inserts replace and so always take the full
 * write — pinned by test/unit/geo_entry_gate_native.test.ts.
 */

import { getItemGate } from '../../components/registry.ts';
import { absorbComponentItemIds, allocateComponentItemId } from '../../db/matrix_write.ts';
import { gateGeoEntries, storedSourceIds } from '../../geo/entry_gate.ts';

/** Where the save is writing: the counter's address and the log coordinates. */
export interface ItemGateTarget {
	table: string;
	sectionTipo: string;
	sectionId: number;
	componentTipo: string;
}

/**
 * component_geolocation: raise the counter past every source id already stored,
 * then gate. The raise comes first because a duplicated or restored record can
 * store source ids its counter has never counted (see geo/entry_gate.ts).
 */
async function gateGeoItems(
	items: readonly unknown[],
	stored: readonly unknown[],
	target: ItemGateTarget,
): Promise<unknown[]> {
	const { table, sectionTipo, sectionId, componentTipo } = target;
	const taken = storedSourceIds(stored);
	if (taken.length > 0) {
		await absorbComponentItemIds(
			table,
			sectionTipo,
			sectionId,
			componentTipo,
			taken.map((id) => ({ id })),
		);
	}
	return gateGeoEntries(
		items,
		stored,
		() => allocateComponentItemId(table, sectionTipo, sectionId, componentTipo),
		{ tipo: componentTipo, section_tipo: sectionTipo, section_id: sectionId },
	);
}

/**
 * Run `model`'s item gate, if it declares one, over `items` (the save's final
 * array) against `stored` (the array read under the lock, before the change
 * loop). Returns the items the save continues with: the gate's output, or `items`
 * itself when the model has no gate. Neither `items` nor `stored` is written.
 */
export async function applyItemGate(
	model: string,
	items: unknown[],
	stored: readonly unknown[],
	target: ItemGateTarget,
): Promise<unknown[]> {
	return getItemGate(model) === 'geo_entry' ? gateGeoItems(items, stored, target) : items;
}
