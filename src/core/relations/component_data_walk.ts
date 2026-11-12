/**
 * THE ddo_map COMPONENT-DATA WALKER (PHP component_relation_common::
 * resolve_component_data_recursively :3171 + get_ddo_children_recursive :3238)
 * — ONE walker for every consumer that follows a declared ddo_map chain from a
 * record to the data of a component further down:
 *
 *   - request_config fixed_filter `component_data` (request_config/filters.ts);
 *   - the calculation widget's relation input (components/calculation_data.ts,
 *     PHP component_relation_common::get_calculation_data).
 *
 * The walk is depth-first: the start ddo's data is read on the address; a ddo
 * that is not the LEAF fans out into its recursive descendants (pre-order,
 * transitive — PHP duplicates kept) for every element it holds, each element
 * becoming the next level's address; the leaf's data returns directly, merged
 * in order.
 *
 * NO MUTATION. PHP marked the leaf by writing `last = true` onto the ddo — on a
 * ddo_map that is ontology config (cached node properties), so the mark leaked
 * into every later request. Here the leaf is a PARAMETER (`leaf`, compared by
 * identity, so exactly the ddo PHP would have marked is the leaf).
 *
 * HOW A DDO IS READ is injected (`read`): the consumer decides what a ddo with
 * an `fn` / `data_fn` means (fixed_filter refuses it; the calculation widget
 * dispatches get_calculation_data) — no static edge to the consumer, no second
 * walker. {@link readStoredComponentData} is the plain stored read both use for
 * a ddo without an fn.
 */

import { memoizedReadMatrixRecord } from '../db/record_memo.ts';
import { getMatrixTableFromTipo, getModelByTipo } from '../ontology/resolver.ts';
import { readComponentItems } from '../resolve/component_data.ts';

/** One ddo of a walked ddo_map (ontology-authored config — read, never written). */
export interface WalkDdo {
	readonly tipo?: string;
	readonly parent?: string;
	readonly section_tipo?: string;
	readonly fn?: string;
	/** The old name of `fn` (PHP reads `fn ?? data_fn`). */
	readonly data_fn?: string;
	readonly options?: unknown;
}

/**
 * The record a ddo is read on. KEPT UNION: the walk cursor is fed by the
 * previous level's STORED locator — unswept string ids and external remote ids
 * both reach here; the value is only ever Number()'d for the row read.
 */
export interface WalkAddress {
	section_tipo: string;
	section_id: number | string;
}

/** Read one ddo's data on one record — the consumer's policy. */
export type WalkReader = (
	ddo: WalkDdo & { tipo: string },
	address: WalkAddress,
) => Promise<unknown[]>;

/** The function a ddo names (PHP `fn ?? data_fn`), undefined for a plain read. */
export function ddoFunctionName(ddo: WalkDdo): string | undefined {
	return ddo.fn ?? ddo.data_fn;
}

/** The arguments of one walk step. */
interface WalkStep {
	ddoMap: readonly WalkDdo[];
	start: WalkDdo;
	leaf: WalkDdo | undefined;
	address: WalkAddress;
	read: WalkReader;
}

/**
 * Walk `ddoMap` from `start` on `address`; `leaf` is the ddo whose data is the
 * answer (identity, see the module header). A ddo without a tipo resolves
 * nothing.
 */
export async function walkComponentData(step: WalkStep): Promise<unknown[]> {
	const tipo = step.start.tipo;
	if (typeof tipo !== 'string') return [];
	const componentData = await step.read({ ...step.start, tipo }, step.address);
	if (componentData.length === 0 || step.start === step.leaf) return componentData;
	return fanOut(step, tipo, componentData);
}

/**
 * A non-leaf level: every element that addresses a record walks every recursive
 * descendant of the ddo there (PHP get_ddo_children_recursive), merged in order.
 */
async function fanOut(step: WalkStep, tipo: string, componentData: unknown[]): Promise<unknown[]> {
	const children = collectDdoDescendants(step.ddoMap, tipo);
	const merged: unknown[] = [];
	for (const element of componentData) {
		const address = elementAddress(element);
		if (address === null) continue;
		for (const childDdo of children) {
			merged.push(...(await walkComponentData({ ...step, start: childDdo, address })));
		}
	}
	return merged;
}

/**
 * A stored element as the next level's read cursor — a locator's target, or
 * null for anything that addresses no record (no section_tipo, no usable id).
 */
export function elementAddress(element: unknown): WalkAddress | null {
	const target = element as { section_tipo?: unknown; section_id?: unknown } | null;
	if (typeof target?.section_tipo !== 'string') return null;
	const id = target.section_id;
	if (typeof id !== 'number' && typeof id !== 'string') return null;
	return { section_tipo: target.section_tipo, section_id: id };
}

/**
 * The STORED data of `tipo` on one record (PHP component get_data()): [] when the
 * tipo has no model, the section no table, or the record does not exist.
 */
export async function readStoredComponentData(
	tipo: string,
	address: WalkAddress,
): Promise<unknown[]> {
	const model = await getModelByTipo(tipo);
	if (model === null) return [];
	const table = await getMatrixTableFromTipo(address.section_tipo);
	if (table === null) return [];
	const record = await memoizedReadMatrixRecord(
		table,
		address.section_tipo,
		Number(address.section_id),
	);
	if (record === null) return [];
	return readComponentItems(record, tipo, model) ?? [];
}

/** All recursive descendants of a ddo in the flat map, pre-order (PHP :3238). */
function collectDdoDescendants(ddoMap: readonly WalkDdo[], parentTipo: string): WalkDdo[] {
	const descendants: WalkDdo[] = [];
	for (const ddo of ddoMap) {
		if (ddo.parent === parentTipo && typeof ddo.tipo === 'string') {
			descendants.push(ddo);
			descendants.push(...collectDdoDescendants(ddoMap, ddo.tipo));
		}
	}
	return descendants;
}
