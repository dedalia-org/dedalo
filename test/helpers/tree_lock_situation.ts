/**
 * TREE SITUATIONS for the tree-integrity gates (CORE-3 lost updates, ONT-5
 * cycle races) — a hierarchy built on a reserved `zz*` TLD, never borrowed
 * from `test3`.
 *
 * Two sections per TLD:
 *  - `<tld>1` — a thesaurus WITH a sibling-order component (term, parent,
 *    children, number order, section_map thesaurus block, button_new). The order is a
 *    per-parent dataframe on the CHILD, paired by id_key to the parent-link
 *    locator's item id.
 *  - `<tld>10` — the same WITHOUT an order component, so a move writes ONLY the
 *    parent key (the lost update is then exactly one key, nothing else).
 *
 * No `is_descriptor` is declared: the descriptor filter is then skipped
 * (children.ts getChildrenOfType), so sibling counts are plain children counts
 * and no si/no locator has to be seeded on every node.
 *
 * Records are created at RUNTIME through the engine's own create door
 * (`createSectionRecord`); their parent links and orders are then SEEDED raw —
 * the starting state of a gate is data, not the code under test. Teardown is
 * `dropTreeSituation` (rows, TM, counters, generation rows, activity rows,
 * nodes), asserted 0.
 */

import { sql } from '../../src/core/db/postgres.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import {
	dropSituation,
	ensureSituation,
	type Situation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { countActivityRows, sweepActivityRows } from './activity_rows.ts';

/** The parent-link relation type (dd47). */
export const PARENT_LINK_TYPE = 'dd47';
/** The superuser every tree write here runs as. */
export const ROOT_USER_ID = -1;

/** One section of a tree situation: its tipos. */
export interface TreeSection {
	section: string;
	term: string;
	parent: string;
	children: string;
	/** null on the order-less section. */
	order: string | null;
	table: string;
}

/** The two sections of one TLD. */
export interface TreeSituation {
	tld: string;
	situation: Situation;
	ordered: TreeSection;
	plain: TreeSection;
}

/**
 * The explicit request_config a parent/children component must declare (the
 * implicit v5 walk is refused for these models): targets its own section,
 * shows the term — the shape the test TLD's own tree carries.
 */
function selfRequestConfig(termTipo: string): Record<string, unknown> {
	return {
		source: {
			records_mode: 'list',
			request_config: [
				{
					sqo: { section_tipo: [{ source: 'self' }] },
					show: {
						ddo_map: [
							{ tipo: termTipo, parent: 'self', section_tipo: 'self', value_with_parents: true },
						],
					},
				},
			],
		},
	};
}

/** The situation for `tld` (`zz…`). The matrix table is resolved by the engine. */
export function treeSituation(tld: string, table = 'matrix_test'): TreeSituation {
	const ordered: TreeSection = {
		section: `${tld}1`,
		term: `${tld}2`,
		parent: `${tld}3`,
		children: `${tld}4`,
		order: `${tld}5`,
		table,
	};
	const plain: TreeSection = {
		section: `${tld}10`,
		term: `${tld}11`,
		parent: `${tld}12`,
		children: `${tld}13`,
		order: null,
		table,
	};
	const sectionNodes = (s: TreeSection, mapTipo: string, buttonNewTipo: string, label: string) => [
		{ tipo: s.section, parent: 'test1', model: 'section', term: { 'lg-eng': label } },
		{
			tipo: s.term,
			parent: s.section,
			model: 'component_input_text',
			is_translatable: true,
			order_number: 1,
		},
		{
			tipo: s.parent,
			parent: s.section,
			model: 'component_relation_parent',
			relations: [{ tipo: s.children }],
			properties: selfRequestConfig(s.term),
			order_number: 2,
		},
		{
			tipo: s.children,
			parent: s.section,
			model: 'component_relation_children',
			relations: [{ tipo: s.parent }],
			properties: selfRequestConfig(s.term),
			order_number: 3,
		},
		...(s.order === null
			? []
			: [{ tipo: s.order, parent: s.section, model: 'component_number', order_number: 4 }]),
		{
			tipo: mapTipo,
			parent: s.section,
			model: 'section_map',
			properties: {
				thesaurus: {
					term: s.term,
					parent: s.parent,
					children: s.children,
					...(s.order === null ? {} : { order: s.order }),
				},
			},
			order_number: 5,
		},
		// The section's button_new: a tree door that BIRTHS a node (add_child, a
		// children add_new_element) asks the New-button predicate (T0-2,
		// write_door.ts authorizeRecordCreate) — no button_new, no create, the
		// superuser included.
		{ tipo: buttonNewTipo, parent: s.section, model: 'button_new', order_number: 6 },
	];
	return {
		tld,
		ordered,
		plain,
		situation: situation({
			tld,
			name: `${tld} tree integrity`,
			nodes: [
				...sectionNodes(ordered, `${tld}6`, `${tld}7`, `${tld} ordered tree`),
				...sectionNodes(plain, `${tld}14`, `${tld}15`, `${tld} plain tree`),
			],
		}),
	};
}

export async function ensureTreeSituation(tree: TreeSituation): Promise<void> {
	await assertTestDatabase(`tree situation ${tree.tld}`);
	await ensureSituation(tree.situation);
}

/**
 * Teardown: every row the gate created (the records' activity rows included —
 * the situation teardown does not sweep them, test/helpers/activity_rows.ts),
 * then the nodes. Returns the residue.
 */
export async function dropTreeSituation(tree: TreeSituation): Promise<number> {
	await assertTestDatabase(`tree situation ${tree.tld}`);
	let activity = 0;
	for (const s of [tree.ordered, tree.plain]) {
		await sql.unsafe('DELETE FROM dedalo_ts_record_generation WHERE section_tipo = $1', [
			s.section,
		]);
		await sweepActivityRows(s.section);
		activity += await countActivityRows(s.section);
	}
	return activity + (await dropSituation(tree.situation));
}

/** A fresh record of `s`, through the engine's create door. */
export async function newNode(s: TreeSection): Promise<number> {
	return createSectionRecord(s.section, ROOT_USER_ID);
}

/** A fixed-length tuple of ids (so destructuring a literal count is typed exactly). */
export type NodeIds<N extends number, A extends number[] = []> = A['length'] extends N
	? A
	: NodeIds<N, [...A, number]>;

/** `count` fresh records of `s`, created in order (ascending ids). */
export async function newNodes<N extends number>(s: TreeSection, count: N): Promise<NodeIds<N>> {
	const ids: number[] = [];
	for (let index = 0; index < count; index++) ids.push(await newNode(s));
	return ids as NodeIds<N>;
}

/** One seeded parent link: the parent record, the link's item id, its order value. */
export interface SeedLink {
	parent: number;
	itemId: number;
	order?: number;
}

/** The stored parent-link locator for (`s`, parent, itemId). */
export function parentLink(
	s: TreeSection,
	parent: number,
	itemId?: number,
): Record<string, unknown> {
	return {
		...(itemId === undefined ? {} : { id: itemId }),
		type: PARENT_LINK_TYPE,
		section_id: parent,
		section_tipo: s.section,
		from_component_tipo: s.parent,
	};
}

/**
 * SEED (raw) a node's parent links, its per-parent orders and the parent key's
 * item-id counter — the gate's starting state, written without the code under
 * test. The relation index follows through the table's own trigger.
 */
export async function seedLinks(
	s: TreeSection,
	id: number,
	links: readonly SeedLink[],
): Promise<void> {
	await assertTestDatabase('seedLinks');
	const relation = links.map((link) => parentLink(s, link.parent, link.itemId));
	const counter = links.reduce((max, link) => Math.max(max, link.itemId), 0);
	await sql.unsafe(
		`UPDATE "${s.table}"
		    SET relation = jsonb_set(COALESCE(relation, '{}'::jsonb), ARRAY[$3::text], $4::text::jsonb),
		        meta = jsonb_set(COALESCE(meta, '{}'::jsonb), ARRAY[$3::text], $5::text::jsonb)
		  WHERE section_tipo = $1 AND section_id = $2`,
		[s.section, id, s.parent, JSON.stringify(relation), JSON.stringify([{ count: counter }])],
	);
	if (s.order === null) return;
	const orders = links
		.filter((link) => link.order !== undefined)
		.map((link) => ({ id: link.itemId, value: link.order }));
	await sql.unsafe(
		`UPDATE "${s.table}"
		    SET number = jsonb_set(COALESCE(number, '{}'::jsonb), ARRAY[$3::text], $4::text::jsonb)
		  WHERE section_tipo = $1 AND section_id = $2`,
		[s.section, id, s.order, JSON.stringify(orders)],
	);
}

/** The stored parent-link locators of a node (`[]` when the key is absent). */
export async function storedLinks(s: TreeSection, id: number): Promise<Record<string, unknown>[]> {
	const rows = (await sql.unsafe(
		`SELECT relation->$3 AS items FROM "${s.table}" WHERE section_tipo = $1 AND section_id = $2`,
		[s.section, id, s.parent],
	)) as { items: unknown }[];
	const items = rows[0]?.items;
	return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
}

/** The parent ids a node links to, sorted. */
export async function parentIds(s: TreeSection, id: number): Promise<number[]> {
	return (await storedLinks(s, id)).map((link) => Number(link.section_id)).sort((a, b) => a - b);
}

/** The node's order value under `parent` (paired by the link's item id), or null. */
export async function orderUnder(
	s: TreeSection,
	id: number,
	parent: number,
): Promise<number | null> {
	if (s.order === null) return null;
	const link = (await storedLinks(s, id)).find((item) => Number(item.section_id) === parent);
	if (link === undefined) return null;
	const rows = (await sql.unsafe(
		`SELECT number->$3 AS items FROM "${s.table}" WHERE section_tipo = $1 AND section_id = $2`,
		[s.section, id, s.order],
	)) as { items: unknown }[];
	const items = Array.isArray(rows[0]?.items) ? (rows[0]?.items as Record<string, unknown>[]) : [];
	const paired = items.find((item) => Number(item.id) === Number(link.id));
	return paired === undefined ? null : Number(paired.value);
}

/** The whole stored row's jsonb columns, as text (a write-nothing witness). */
export async function rowFingerprint(s: TreeSection, id: number): Promise<string | null> {
	const rows = (await sql.unsafe(
		`SELECT concat_ws('|', relation::text, number::text, meta::text) AS f
		   FROM "${s.table}" WHERE section_tipo = $1 AND section_id = $2`,
		[s.section, id],
	)) as { f: string }[];
	return rows[0]?.f ?? null;
}

/**
 * Normalize a mutator's success answer across return shapes (the boolean of the
 * locked design, the `{ok}` object of the old one): the gate asserts the
 * OUTCOME, not the spelling of the return.
 */
export function succeeded(result: unknown): boolean {
	if (typeof result === 'boolean') return result;
	if (result !== null && typeof result === 'object' && 'ok' in result) {
		return (result as { ok: unknown }).ok === true;
	}
	return false;
}
