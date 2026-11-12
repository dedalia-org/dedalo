/**
 * TS_NODE_REPOSITORY (PHP core/ts_object/class.ts_node_repository.php) — batched,
 * read-only access to the raw matrix rows behind thesaurus tree nodes.
 *
 * The tree hot path needs, per child node: its sibling ORDER value and its
 * IS_INDEXABLE flag; and per grandchild: its IS_DESCRIPTOR flag. Rather than one
 * component load per node (N+1), this repository issues ONE SQL query per
 * section_tipo group, reading the SAME raw JSONB values the components would:
 *   - order:        number  -> {order_tipo}       -> value paired to the parent
 *   - is_indexable: relation -> {is_indexable_tipo} -> [0].section_id === 1
 *   - is_descriptor: relation -> {is_descriptor_tipo} -> [0].section_id (1|2)
 *
 * BATCH-FIRST, NO LEGACY FALLBACK (plan decision 3): PHP's null→component-path
 * fallback is not ported (TS has no component machinery; both PHP paths yield the
 * same values). PHP's partial-data semantics ARE folded in:
 *   - missing row  → {order:null, is_indexable:false}
 *   - fetchNodeInfo: an unresolvable section (bad table/tipo grammar) THROWS
 *   - batchDescriptorFlags: an unresolvable section per-tipo → null-skip (not abort)
 *
 * PHP anchors: fetch_node_info (:70), batch_descriptor_flags (:262),
 * format_number_value (:378), pick_order_value_for_parent (:466).
 */

import {
	formatNumber,
	NUMBER_FORMAT_NONE,
	type NumberFormat,
	numberFormatOf,
} from '../components/component_number/number_format.ts';
import { sql } from '../db/postgres.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { getMatrixTableFromTipo, getModelByTipo, getNode } from '../ontology/resolver.ts';
import { getSectionMap } from '../ontology/section_map.ts';

/**
 * A node locator (section coords).
 *
 * KEPT UNION (WC-2026-08-10-section-id-int-canonical): the batch feeders hand
 * this interface RAW STORED locators — the `link_children` / portal arrays read
 * straight off unswept jsonb, plus the dd_ts_api mode-B `children` list — so a
 * pre-sweep string id legitimately arrives here. groupLocators is the tolerance
 * point: it validates and trunc-casts, throwing on anything that is not an
 * address. Never narrow this without first narrowing what feeds it.
 */
export interface NodeLocator {
	section_tipo?: string;
	section_id?: number | string;
	[extra: string]: unknown;
}

/** One resolved node's batched info. */
export interface NodeInfo {
	order: number | string | null;
	is_indexable: boolean;
}

/** PHP safe_tipo: the tipo grammar `[a-z]+[0-9]+`. */
const TIPO_GRAMMAR = /^[a-z]+[0-9]+$/;
function safeTipo(tipo: string): string | null {
	return TIPO_GRAMMAR.test(tipo) ? tipo : null;
}

/**
 * Group locators by section_tipo, validating shape. Throws on a malformed
 * locator (PHP returns null → caller falls back; TS has no fallback path, so a
 * bad shape is a hard error the caller must surface).
 */
function groupLocators(locators: NodeLocator[]): Map<string, number[]> {
	const groups = new Map<string, number[]>();
	for (const locator of locators) {
		const sectionTipo = locator.section_tipo;
		const sectionId = locator.section_id;
		if (
			typeof sectionTipo !== 'string' ||
			sectionId === undefined ||
			sectionId === null ||
			!Number.isFinite(Number(sectionId))
		) {
			throw new DedaloError('section.bad_locators', {
				message: 'ts_node_repository: invalid locator (missing section_tipo/section_id)',
			});
		}
		const list = groups.get(sectionTipo) ?? [];
		list.push(Math.trunc(Number(sectionId)));
		groups.set(sectionTipo, list);
	}
	return groups;
}

/**
 * FORMAT_NUMBER_VALUE (PHP :378): the order value as a component read carries it
 * — component_number's format law (`component_number/number_format.ts`, T1-40),
 * the ONE copy shared with the save door. v6 empty semantics: null / '' / false
 * → null, but `0` and `'0'` are the number 0 (frozen v7's `empty()` also nulled
 * `'0'` — a regression vs v6). A string is read as PHP `(float)` reads it
 * (leading number); one with no number at all is no order (null).
 */
export function formatNumberValue(value: unknown, format: NumberFormat): number | null {
	if (value === null || value === undefined || value === '' || value === false) {
		return null;
	}
	const numeric = typeof value === 'string' ? Number.parseFloat(value.trim()) : Number(value);
	return Number.isFinite(numeric) ? formatNumber(numeric, format) : null;
}

/**
 * PICK_ORDER_VALUE_FOR_PARENT (PHP :466): select a child's order value under a
 * specific parent from its order dataframe. Priority: (1) id-keyed entry paired
 * to the parent-link locator item id; (2) legacy section-coords entry
 * (section_tipo_key/section_id_key); (3) legacy unkeyed single value; else the
 * first entry. Reading index 0 blindly is the reorder-does-not-persist bug.
 *
 * The pairing key of a keyed entry is the item's `id` — the field BOTH engines'
 * write paths produce (PHP trait.dataframe_common::add_value_by_id_key writes
 * `{value, id}`; TS relations/dataframe.ts addInlineValueByIdKey likewise).
 * PHP's picker matches `$item->id_key`, a field no write path has ever written,
 * so for a multi-item dataframe (multi-parent / moved node) it falls through to
 * the unkeyed scan and returns the FIRST item's stale value — the
 * reorder-reverts-on-reload bug. Deliberate divergence: WC-015.
 *
 * THE ONE RULE, TWO CALLERS (WC-2026-09-05-children-order-one-rule). The
 * CHILDREN engine (`relations/children.ts` orderChildHits) asks the same
 * question and used to answer it with a shorter chain of its own
 * (`paired ?? items[0]`), so a record carrying a legacy section-coords entry
 * sorted one way in the tree and another in a list. It now imports THIS
 * function. Step 3 plus the first-entry fallback are what preserve the
 * POSITIONAL v6 read that engine documented (mht160/6). The rule stays in this
 * module — its historical home, and the one both ratchets already recognise —
 * rather than moving to a new file: the code is unchanged, and a move would
 * report it as new debt.
 */
export function pickOrderValueForParent(
	orderItems: readonly Record<string, unknown>[],
	parentItems: readonly Record<string, unknown>[],
	parentTipo: string,
	parentId: number,
): unknown {
	if (orderItems.length === 0) return null;

	// Resolve the parent-link locator id (the dataframe id_key) for this parent.
	let linkId = 0;
	for (const loc of parentItems) {
		if (
			loc !== null &&
			typeof loc === 'object' &&
			loc.section_tipo === parentTipo &&
			Number(loc.section_id) === parentId &&
			loc.id !== undefined
		) {
			linkId = Math.trunc(Number(loc.id));
			break;
		}
	}

	// 1. id-keyed entry (authoritative). `id` is the written pairing field;
	// `id_key` is honoured first for any row that might carry the name PHP's
	// picker expected.
	if (linkId > 0) {
		for (const item of orderItems) {
			const pairKey = item?.id_key ?? item?.id;
			if (pairKey !== undefined && Math.trunc(Number(pairKey)) === linkId) {
				return item.value ?? null;
			}
		}
	}
	// 2. section-coords entry.
	for (const item of orderItems) {
		if (
			item?.section_tipo_key === parentTipo &&
			item.section_id_key !== undefined &&
			Number(item.section_id_key) === parentId
		) {
			return item.value ?? null;
		}
	}
	// 3. legacy unkeyed entry (no pairing key of ANY generation).
	for (const item of orderItems) {
		if (
			item?.id === undefined &&
			item?.id_key === undefined &&
			item?.section_id_key === undefined
		) {
			return item.value ?? null;
		}
	}
	// fallback: first entry.
	return orderItems[0]?.value ?? null;
}

/** The component_relation_parent tipo of a child section (resolved by walk). */
async function parentRelationTipo(sectionTipo: string): Promise<string | null> {
	const { getParentTipo } = await import('../relations/children.ts');
	return getParentTipo(sectionTipo);
}

/**
 * FETCH_NODE_INFO (PHP :70): resolve order + is_indexable for a set of locators,
 * one query per section_tipo group. Order is parent-aware when `parentLocator` is
 * given (dataframe entry paired to that parent). Missing rows fill in
 * {order:null, is_indexable:false}. Throws on an unresolvable section (bad
 * table/tipo grammar) — no legacy fallback in TS.
 */
export async function fetchNodeInfo(
	locators: NodeLocator[],
	parentLocator: NodeLocator | null = null,
): Promise<Map<string, NodeInfo>> {
	const groups = groupLocators(locators);
	const info = new Map<string, NodeInfo>();

	for (const [sectionTipo, sectionIds] of groups) {
		const table = await getMatrixTableFromTipo(sectionTipo);
		if (table === null || table === '') {
			throw new DedaloError('request.invalid_tipo', {
				message: `fetch_node_info: no matrix table for section '${sectionTipo}'`,
				coordinates: { section_tipo: sectionTipo },
			});
		}

		const sectionMap = await getSectionMap(sectionTipo);
		const thesaurus = (sectionMap?.thesaurus ?? {}) as {
			order?: unknown;
			is_indexable?: unknown;
		};
		const orderTipo = typeof thesaurus.order === 'string' ? thesaurus.order : null;
		const isIndexableTipo =
			typeof thesaurus.is_indexable === 'string' ? thesaurus.is_indexable : null;
		const safeOrderTipo = orderTipo !== null ? safeTipo(orderTipo) : null;
		const safeIndexableTipo = isIndexableTipo !== null ? safeTipo(isIndexableTipo) : null;
		if (
			(orderTipo !== null && safeOrderTipo === null) ||
			(isIndexableTipo !== null && safeIndexableTipo === null)
		) {
			throw new DedaloError('ontology.invalid_node', {
				message: `fetch_node_info: invalid tipo grammar in section_map of '${sectionTipo}'`,
				coordinates: { section_tipo: sectionTipo },
			});
		}

		// Order component number format (type/precision from the order node props).
		const orderNumberFormat =
			safeOrderTipo !== null
				? numberFormatOf((await getNode(safeOrderTipo))?.properties ?? null, safeOrderTipo)
				: NUMBER_FORMAT_NONE;

		// is_indexable section-level rules (PHP: roots never indexable; unresolved model → false).
		const indexablePossible =
			safeIndexableTipo !== null &&
			!sectionTipo.startsWith('hierarchy') &&
			!sectionTipo.startsWith('ontology') &&
			(await getModelByTipo(sectionTipo)) !== null;

		// parent-aware order: read the whole order + parent-relation arrays and
		// resolve per-row via pickOrderValueForParent.
		let parentAware = parentLocator !== null && safeOrderTipo !== null;
		let safeParentRelTipo: string | null = null;
		if (parentAware) {
			const relTipo = await parentRelationTipo(sectionTipo);
			safeParentRelTipo = relTipo !== null ? safeTipo(relTipo) : null;
			if (safeParentRelTipo === null) parentAware = false;
		}

		const orderSelect =
			parentAware && safeOrderTipo !== null && safeParentRelTipo !== null
				? `"number"->'${safeOrderTipo}' AS order_arr, relation->'${safeParentRelTipo}' AS parent_arr`
				: `${safeOrderTipo !== null ? `"number"->'${safeOrderTipo}'->0->>'value'` : 'NULL'} AS order_value`;
		const indexableSelect =
			safeIndexableTipo !== null ? `relation->'${safeIndexableTipo}'->0->>'section_id'` : 'NULL';

		const rows = (await sql.unsafe(
			`SELECT section_id, ${orderSelect}, ${indexableSelect} AS indexable_value
			 FROM "${table}"
			 WHERE section_tipo = $1 AND section_id = ANY($2::int[])`,
			[sectionTipo, `{${sectionIds.join(',')}}`],
		)) as Record<string, unknown>[];

		for (const row of rows) {
			let orderValue: unknown;
			if (parentAware && parentLocator !== null) {
				const orderItems = Array.isArray(row.order_arr)
					? (row.order_arr as Record<string, unknown>[])
					: [];
				const parentItems = Array.isArray(row.parent_arr)
					? (row.parent_arr as Record<string, unknown>[])
					: [];
				orderValue = pickOrderValueForParent(
					orderItems,
					parentItems,
					String(parentLocator.section_tipo),
					Math.trunc(Number(parentLocator.section_id)),
				);
			} else {
				orderValue = row.order_value ?? null;
			}
			const formatted = formatNumberValue(orderValue, orderNumberFormat);
			const isIndexable =
				indexablePossible &&
				row.indexable_value !== null &&
				row.indexable_value !== undefined &&
				Math.trunc(Number(row.indexable_value)) === 1;
			info.set(`${sectionTipo}_${row.section_id}`, { order: formatted, is_indexable: isIndexable });
		}

		// missing rows → order null, not indexable.
		for (const sectionId of sectionIds) {
			const key = `${sectionTipo}_${sectionId}`;
			if (!info.has(key)) info.set(key, { order: null, is_indexable: false });
		}
	}

	return info;
}

/**
 * BATCH_DESCRIPTOR_FLAGS (PHP :262): resolve is_descriptor (1=descriptor,
 * 2=non-descriptor) for a set of locators, one query per section_tipo group.
 * Sections whose model or is_descriptor tipo cannot be resolved get null flags
 * (per-section null-skip, NOT a batch abort — the divergence from fetchNodeInfo).
 * A bad tipo grammar / missing table still throws.
 */
export async function batchDescriptorFlags(
	locators: NodeLocator[],
): Promise<Map<string, number | null>> {
	const groups = groupLocators(locators);
	const flags = new Map<string, number | null>();

	for (const [sectionTipo, sectionIds] of groups) {
		const model = await getModelByTipo(sectionTipo);
		if (model === null) {
			for (const sectionId of sectionIds) flags.set(`${sectionTipo}_${sectionId}`, null);
			continue;
		}
		const sectionMap = await getSectionMap(sectionTipo);
		const thesaurus = (sectionMap?.thesaurus ?? {}) as { is_descriptor?: unknown };
		const isDescriptorTipo =
			typeof thesaurus.is_descriptor === 'string' ? thesaurus.is_descriptor : null;
		if (isDescriptorTipo === null) {
			for (const sectionId of sectionIds) flags.set(`${sectionTipo}_${sectionId}`, null);
			continue;
		}
		const safeDescriptorTipo = safeTipo(isDescriptorTipo);
		if (safeDescriptorTipo === null) {
			throw new DedaloError('ontology.invalid_node', {
				message: `batch_descriptor_flags: invalid tipo '${isDescriptorTipo}'`,
				coordinates: { section_tipo: sectionTipo, is_descriptor_tipo: isDescriptorTipo },
			});
		}
		const table = await getMatrixTableFromTipo(sectionTipo);
		if (table === null || table === '') {
			throw new DedaloError('request.invalid_tipo', {
				message: `batch_descriptor_flags: no matrix table for section '${sectionTipo}'`,
				coordinates: { section_tipo: sectionTipo },
			});
		}

		const rows = (await sql.unsafe(
			`SELECT section_id, relation->'${safeDescriptorTipo}'->0->>'section_id' AS descriptor_value
			 FROM "${table}"
			 WHERE section_tipo = $1 AND section_id = ANY($2::int[])`,
			[sectionTipo, `{${sectionIds.join(',')}}`],
		)) as { section_id: number; descriptor_value: string | null }[];

		for (const row of rows) {
			flags.set(
				`${sectionTipo}_${row.section_id}`,
				row.descriptor_value !== null ? Math.trunc(Number(row.descriptor_value)) : null,
			);
		}
		for (const sectionId of sectionIds) {
			const key = `${sectionTipo}_${sectionId}`;
			if (!flags.has(key)) flags.set(key, null);
		}
	}

	return flags;
}
