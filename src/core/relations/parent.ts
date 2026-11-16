/**
 * COMPONENT_RELATION_PARENT (PHP core/component_relation_parent/…) — the upward
 * (parent) link machinery of a Dédalo hierarchy, plus its ancestor-walk and
 * sibling-order maintenance. NOT ported anywhere before this file.
 *
 * A child record holds its parent link(s) as locators in its
 * component_relation_parent (relation column). Sibling ORDER is a component_number
 * dataframe on the CHILD, paired by id_key to that parent-link locator's item id —
 * so a multi-parent node carries an independent order per parent (the unified
 * dataframe contract, shared with relations/dataframe.ts).
 *
 * This module has two halves:
 *  - READ half (no transaction): getParentsRecursive (diamond-DAG safe ancestor
 *    walk — memo BY REF, visited path-local BY VALUE), isAncestor.
 *  - MUTATION half (REQUIRES an ambient tx; locked reads — see THE LOCK LAW
 *    below): addParent, moveParent, setChildOrder, removeChildOrder,
 *    recalculateSiblingOrders, sortChildren, plus the cycle check every door
 *    shares (assertParentLinksAcyclic / assertParentLinkKeysAcyclic). No door
 *    removes a link on its own: it leaves through a move (moveParent — PHP
 *    update_parent_data's remove_parent + add_parent) or through the
 *    record-write chokepoint (the edit form's save), so there is no removeParent.
 *
 * Every mutation WRITES through the record-write chokepoint (persistRecordKeys:
 * value + modified stamps + derived index in one UPDATE, the post-write hook,
 * the observer ledger) and files its Time Machine rows (recordKeyChangeRows) —
 * PHP saved each of these keys through component->save() (see persistTreeKeys).
 * None read through or populate the record memo. PHP anchors: add_parent (:123), remove_parent (:223),
 * is_ancestor (:460), fetch_ancestors_recursive (:519), set_child_order (:829),
 * remove_child_order (:917), recalculate_sibling_orders_static (:1053),
 * component_relation_children sort_children (:1057), get_children_of_type (:664).
 */

import { compareLocators, type Locator } from '../concepts/locator.ts';
import type { MatrixJsonbColumn } from '../db/matrix.ts';
import {
	allocateComponentItemId,
	lockMatrixRowsForUpdate,
	readMatrixKeyForShare,
	readMatrixKeyForUpdate,
} from '../db/matrix_write.ts';
import { isInTransaction } from '../db/postgres.ts';
import { memoizedReadMatrixRecord } from '../db/record_memo.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { RELATION_TYPE_PARENT } from '../ontology/ontology_tipos.ts';
import { getMatrixTableFromTipo, getModelByTipo } from '../ontology/resolver.ts';
import { persistRecordKeys } from '../section_record/index.ts';
import {
	getChildrenOfType as getChildrenOfTypeLocators,
	getComponentOrderTipo,
	getParentTipo,
	resolveParentLinkIdKey,
} from './children.ts';
import {
	getInlineValueByIdKey,
	removeInlineByIdKey,
	updateInlineValueByIdKey,
} from './dataframe.ts';
import { historyStamp, recordKeyChangeRows } from './dataframe_slots.ts';
import { NOLAN } from './main_lanes.ts';

/**
 * A parent locator (as stored in the child's relation column).
 *
 * KEPT UNION: getParents returns the RAW stored jsonb items verbatim — an
 * unswept row still holds the legacy string form. Writers canonicalize
 * (canonicalizeStoredSectionId), readers stay tolerant.
 */
export interface ParentLocator {
	section_tipo: string;
	section_id: number | string;
	from_component_tipo?: string;
	type?: string;
	id?: number | string;
	[extra: string]: unknown;
}

/**
 * Accumulated recursion errors (PHP component_relation_parent::$errors).
 * KEPT UNION: `info` echoes the OFFENDING stored locator's id verbatim (the
 * walk cursor comes from ParentLocator above) — a diagnostic must report the
 * bytes that actually formed the loop, unswept string form included.
 */
export interface RecursionError {
	type: string;
	msg: string;
	info: { section_tipo: string; section_id: number | string };
}

// ===========================================================================
// READ HALF.
// ===========================================================================

/** The direct parent locators of a record (PHP get_parents). */
export async function getParents(
	sectionId: number | string,
	sectionTipo: string,
	fromComponentTipo?: string | null,
): Promise<ParentLocator[]> {
	const componentTipo = fromComponentTipo ?? (await getParentTipo(sectionTipo));
	if (componentTipo === null) return [];
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) return [];
	const record = await memoizedReadMatrixRecord(table, sectionTipo, Number(sectionId));
	const items =
		((record?.columns.relation as Record<string, ParentLocator[]> | null)?.[componentTipo] as
			| ParentLocator[]
			| undefined) ?? [];
	return items;
}

/**
 * Every unique ancestor of a record (PHP get_parents_recursive / fetch_ancestors_
 * recursive). `unique_ancestors` is the memo (by ref); `visited` is path-local (by
 * value) so a diamond DAG re-visits a shared ancestor via a different path but a
 * true cycle on one path is detected and recorded (not thrown). Returns the
 * ancestors plus the accumulated errors.
 */
export async function getParentsRecursive(
	sectionId: number | string,
	sectionTipo: string,
	componentTipo?: string | null,
): Promise<{ ancestors: ParentLocator[]; errors: RecursionError[] }> {
	const uniqueAncestors = new Map<string, ParentLocator>();
	const errors: RecursionError[] = [];

	const walk = async (
		id: number | string,
		tipo: string,
		visited: Record<string, boolean>,
	): Promise<void> => {
		const currentKey = `${tipo}_${id}`;
		if (visited[currentKey] === true) {
			errors.push({
				type: 'get_parents_recursive',
				msg: 'Loop detected',
				info: { section_tipo: tipo, section_id: id },
			});
			return;
		}
		const nextVisited = { ...visited, [currentKey]: true };

		const directParents = await getParents(id, tipo, componentTipo);
		for (const parent of directParents) {
			if (parent === null || typeof parent !== 'object') continue;
			if (parent.section_id === undefined || parent.section_tipo === undefined) continue;
			const parentKey = `${parent.section_tipo}_${parent.section_id}`;
			if (!uniqueAncestors.has(parentKey)) {
				uniqueAncestors.set(parentKey, parent);
				await walk(parent.section_id, parent.section_tipo, nextVisited);
			}
		}
	};

	await walk(sectionId, sectionTipo, {});
	return { ancestors: [...uniqueAncestors.values()], errors };
}

/**
 * True when (nodeTipo,nodeId) is an ancestor of (ofTipo,ofId) (PHP is_ancestor).
 * Same node → false (auto-reference handled elsewhere). Loose int id compare.
 */
export async function isAncestor(
	nodeTipo: string,
	nodeId: number | string,
	ofTipo: string,
	ofId: number | string,
): Promise<boolean> {
	if (nodeTipo === ofTipo && Math.trunc(Number(nodeId)) === Math.trunc(Number(ofId))) {
		return false;
	}
	const nodeKey = `${nodeTipo}_${Math.trunc(Number(nodeId))}`;
	const { ancestors } = await getParentsRecursive(ofId, ofTipo);
	for (const ancestor of ancestors) {
		if (ancestor.section_tipo === undefined || ancestor.section_id === undefined) continue;
		if (`${ancestor.section_tipo}_${Math.trunc(Number(ancestor.section_id))}` === nodeKey) {
			return true;
		}
	}
	return false;
}

// ===========================================================================
// MUTATION HALF — every call REQUIRES an ambient transaction (CORE-3 / ONT-5).
//
// THE LOCK LAW (engineering/wire_contract/WC-2026-10-11-parent-link-cycle-every-door.md):
//  1. A mutation rewrites a WHOLE key of the CHILD record (its parent links or
//     its per-parent order dataframe) from a value it read — so the read is a
//     LOCKED read (`readMatrixKeyForUpdate`), held to COMMIT. An unlocked read
//     silently reverts whatever another session committed in between. Outside
//     a transaction the lock buys nothing, so the locked primitives refuse
//     there (`internal.invariant`, matrix_write.ts) and every mutation with
//     them, at its first locked read; the write itself, `persistTreeKeys`,
//     refuses on its own, whatever it is given.
//  2. Before a parent link X→Q is ADDED, X's row is locked FOR UPDATE and Q
//     plus every ancestor of Q is read FOR SHARE (`lockedAncestorsReach`). A
//     writer changing any of those parent keys holds that row exclusively, so
//     the walk waits for it and, under READ COMMITTED, walks the version it
//     committed: two moves that TOGETHER close a cycle are serialized (or one
//     is a 40P01 victim, retried by the tree door — ts_object/tree_locks.ts)
//     and the later one meets the earlier one's link → `tree.cycle`. Shared
//     ancestors take compatible share locks: moves do not queue on the root.
//  3. Only ADDED links are checked, so a curator can still cut an existing
//     loop and add links that do not touch it (loop repair).
//  4. Order inside one transaction: advisory node locks (ts_api) → child row
//     → ancestor share locks → sibling rows in ONE sorted batch
//     (`lockMatrixRowsForUpdate`).
//  5. The WRITE goes through the record-write chokepoint, in the same
//     transaction (`persistTreeKeys`): stamps, derived index, post-write hook,
//     observer ledger and Time Machine rows — never a raw key write.
// ===========================================================================

/** One node address of the cycle walk (integer section_id). */
interface NodeRef {
	section_tipo: string;
	section_id: number;
}

/** A stored section_id as a record address, or null when it addresses no row. */
function addressOf(rawId: unknown): number | null {
	if (rawId === '' || rawId === null) return null;
	const id = Math.trunc(Number(rawId));
	return Number.isSafeInteger(id) ? id : null;
}

/** The node a stored locator addresses, or null when it addresses none. */
function nodeOf(item: unknown): NodeRef | null {
	if (item === null || typeof item !== 'object') return null;
	const { section_tipo: tipo, section_id: rawId } = item as Record<string, unknown>;
	const id = addressOf(rawId);
	if (typeof tipo !== 'string' || tipo === '' || id === null) return null;
	return { section_tipo: tipo, section_id: id };
}

/** The nodes `after` links to that `before` does not (rule 3: only these are checked). */
function addedNodes(before: readonly unknown[], after: readonly unknown[]): NodeRef[] {
	const existing = before.map(nodeOf).filter((node): node is NodeRef => node !== null);
	return after
		.map(nodeOf)
		.filter(
			(node): node is NodeRef =>
				node !== null && !existing.some((stored) => sameNode(stored, node)),
		);
}

/** Node identity: (section_tipo, section_id) through the ONE locator equality. */
function sameNode(a: NodeRef, b: NodeRef): boolean {
	return compareLocators(a as Locator, b as Locator, NODE_PROPERTIES);
}
const NODE_PROPERTIES: readonly string[] = ['section_tipo', 'section_id'];

/** Parent-link identity (PHP add_locator_to_data equality). */
const LINK_PROPERTIES: readonly string[] = [
	'section_tipo',
	'section_id',
	'type',
	'from_component_tipo',
];

/** One key of a child row under its FOR UPDATE lock; null when the ROW is missing. */
async function lockedKey(
	table: string,
	sectionTipo: string,
	sectionId: number,
	column: 'relation' | 'number',
	key: string,
): Promise<unknown[] | null> {
	return readMatrixKeyForUpdate(table, sectionTipo, Math.trunc(sectionId), column, key);
}

/** The direct parent nodes of `node`, read FOR SHARE (rule 2). */
async function sharedParents(node: NodeRef): Promise<NodeRef[]> {
	const parentTipo = await getParentTipo(node.section_tipo);
	if (parentTipo === null) return [];
	const table = await getMatrixTableFromTipo(node.section_tipo);
	if (table === null) return [];
	const items =
		(await readMatrixKeyForShare(
			table,
			node.section_tipo,
			node.section_id,
			'relation',
			parentTipo,
		)) ?? [];
	return items.map(nodeOf).filter((parent): parent is NodeRef => parent !== null);
}

/**
 * True when `target` is `start` or one of its ancestors, every parent key on
 * the way read FOR SHARE (rule 2). Breadth-first with a visited set, so a loop
 * elsewhere in the hierarchy still terminates (rule 3). No record memo: the
 * memo would answer a version the lock never saw.
 */
async function lockedAncestorsReach(start: NodeRef, target: NodeRef): Promise<boolean> {
	const visited = new Set<string>([`${start.section_tipo}_${start.section_id}`]);
	const queue: NodeRef[] = [start];
	for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
		for (const parent of await sharedParents(node)) {
			if (sameNode(parent, target)) return true;
			const key = `${parent.section_tipo}_${parent.section_id}`;
			if (visited.has(key)) continue;
			visited.add(key);
			queue.push(parent);
		}
	}
	return false;
}

/**
 * THE CYCLE CHECK of a parent-key change on `child` (rule 2 + 3): every node
 * in `after` that is not in `before` must be neither the child itself nor a
 * descendant of it. Locks the child row first (re-entrant for a caller that
 * already holds it; outside a transaction that lock refuses, `internal.invariant`).
 * Refuses with `tree.cycle`; a missing child row answers nothing here (the
 * write's own S2-02 check refuses it).
 */
export async function assertParentLinksAcyclic(
	child: { section_tipo: string; section_id: number },
	before: readonly unknown[],
	after: readonly unknown[],
): Promise<void> {
	const childNode: NodeRef = {
		section_tipo: child.section_tipo,
		section_id: Math.trunc(child.section_id),
	};
	const table = await getMatrixTableFromTipo(childNode.section_tipo);
	if (table === null) return;
	await lockMatrixRowsForUpdate([
		{ table, sectionTipo: childNode.section_tipo, sectionId: childNode.section_id },
	]);
	for (const candidate of addedNodes(before, after)) {
		if (sameNode(candidate, childNode) || (await lockedAncestorsReach(candidate, childNode))) {
			throw new DedaloError('tree.cycle', {
				coordinates: {
					section_tipo: childNode.section_tipo,
					section_id: childNode.section_id,
					new_parent_section_tipo: candidate.section_tipo,
					new_parent_section_id: candidate.section_id,
				},
			});
		}
	}
}

/** One key write as the record-write chokepoint carries it. */
export interface ParentKeyWrite {
	column: string;
	key: string;
	value: unknown;
}

/** The items a chokepoint key write carries (pre-encoded jsonb text is parsed). */
function writtenItems(value: unknown): unknown[] {
	if (typeof value === 'string') {
		try {
			return writtenItems(JSON.parse(value));
		} catch {
			return [];
		}
	}
	return Array.isArray(value) ? value : [];
}

/** The parent-link (component_relation_parent) writes among a chokepoint's key writes. */
async function parentLinkWrites(writes: readonly ParentKeyWrite[]): Promise<ParentKeyWrite[]> {
	const found: ParentKeyWrite[] = [];
	for (const write of writes) {
		if (write.column !== 'relation') continue;
		if ((await getModelByTipo(write.key)) === 'component_relation_parent') found.push(write);
	}
	return found;
}

/**
 * True when `writes` carry a component_relation_parent key — the record-write
 * chokepoint routes such a write into its transaction (never the
 * transaction-less fast path) and runs the entry below there.
 */
export async function hasParentLinkWrite(writes: readonly ParentKeyWrite[]): Promise<boolean> {
	return (await parentLinkWrites(writes)).length > 0;
}

/**
 * THE CHOKEPOINT ENTRY — the cycle check of every `component_relation_parent`
 * key among a record-write chokepoint's `writes`, in the writer's transaction,
 * AFTER its row lock and BEFORE its write. One entry per write shape:
 *  - `replace` — the value IS the whole key (writeKeys; the whole-record
 *    persistRecordColumns, its `relation` bag as one write per key);
 *  - `append` — the value is ADDED to the stored items (persistAppendedKeyItems).
 *    It checks exactly what `replace` checks — the links in the value that are
 *    not stored yet — so the two share one branch;
 *  - `birth` — the row was just INSERTED (persistRecordBirth, the undelete): call
 *    it AFTER the insert; every stored link counts as added, because a stale
 *    link that still names the reborn record can close a loop through it.
 * A write set with no parent key answers at once (no transaction needed); one
 * with a parent key refuses outside a transaction (its locked read does). A
 * missing row answers nothing (the writer's own S2-02 check refuses it).
 */
export async function assertParentLinkKeysAcyclic(
	target: { table: string; sectionTipo: string; sectionId: number },
	writes: readonly ParentKeyWrite[],
	mode: 'replace' | 'append' | 'birth',
): Promise<void> {
	const parentWrites = await parentLinkWrites(writes);
	if (parentWrites.length === 0) return;
	const coordinates = { section_tipo: target.sectionTipo, section_id: target.sectionId };
	for (const write of parentWrites) {
		const stored = await lockedKey(
			target.table,
			target.sectionTipo,
			target.sectionId,
			'relation',
			write.key,
		);
		if (stored === null) return;
		await assertParentLinksAcyclic(
			coordinates,
			mode === 'birth' ? [] : stored,
			writtenItems(write.value),
		);
	}
}

/** One key a tree mutation rewrites: the value it writes (null ⇒ remove). */
export interface TreeKeyWrite {
	column: Extract<MatrixJsonbColumn, 'relation' | 'number' | 'string'>;
	key: string;
	after: readonly unknown[] | null;
}

/**
 * THE WRITE of every tree mutation (CLOSURE_PLAN Step 5 — the tree-move
 * obligation). PHP saved each of these keys through component->save(): stamped,
 * historied, observed. So do we:
 *  - ONE chokepoint UPDATE (persistRecordKeys) carrying every key + the record's
 *    modified stamps (dd197/dd201) + the derived `relation_search`, then the
 *    post-write hook (save event, RAG event, observer ledger — drained after
 *    COMMIT);
 *  - the Time Machine rows of each key (recordKeyChangeRows, door lane
 *    lg-nolan), cut from the key's BEFORE-IMAGE, which this writer reads
 *    itself, under the row lock, right before the write — never a value a
 *    caller hands in (one door may write a key twice in a transaction —
 *    moveParent's order key — and only the writer's own read is the image
 *    right before ITS write). The before-image decides which language rows a
 *    lang-sliced key (add_child's ontology7) records (tree_obligations O5).
 * REFUSES outside a transaction (rule 1, `internal.invariant` — even for an
 * empty set, so a caller that forgot its transaction fails on its first call,
 * not on the first one that happens to carry a write; tree_parent_lost_update
 * L6): there the chokepoint's transaction-less fast path would autocommit the
 * value and the history rows would follow as a separate write, so a failure
 * between the two would leave a stamped value with no history.
 * In the caller's transaction a refused or rolled-back door leaves neither the
 * value nor its history. `actor` is who the stamps and the history name.
 */
export async function persistTreeKeys(
	target: { table: string; sectionTipo: string; sectionId: number },
	writes: readonly TreeKeyWrite[],
	actor: number,
): Promise<void> {
	const record = { ...target, sectionId: Math.trunc(target.sectionId) };
	if (!isInTransaction()) {
		throw new DedaloError('internal.invariant', {
			message:
				'persistTreeKeys: a tree write outside a transaction holds no lock — wrap it in withTransaction',
			coordinates: { section_tipo: record.sectionTipo, section_id: record.sectionId },
		});
	}
	if (writes.length === 0) return;
	const befores: unknown[][] = [];
	for (const { column, key } of writes) {
		befores.push(
			(await readMatrixKeyForUpdate(
				record.table,
				record.sectionTipo,
				record.sectionId,
				column,
				key,
			)) ?? [],
		);
	}
	await persistRecordKeys(
		record,
		writes.map(({ column, key, after }) => ({ column, key, value: after })),
		{ userId: actor },
		{ actor },
	);
	const stamp = historyStamp(actor, null);
	for (const [index, { key, after }] of writes.entries()) {
		await recordKeyChangeRows(
			record,
			key,
			{ before: befores[index] ?? [], after: after ?? [], requestLang: NOLAN },
			stamp,
		);
	}
}

/** The order component instance context (tipo + table for the child section). */
async function orderContext(
	childSectionTipo: string,
): Promise<{ orderTipo: string; table: string } | null> {
	const orderTipo = await getComponentOrderTipo(childSectionTipo);
	if (orderTipo === null) return null;
	const table = await getMatrixTableFromTipo(childSectionTipo);
	if (table === null) return null;
	return { orderTipo, table };
}

/** One item of the child's order component (a dataframe value paired by id_key). */
type OrderItem = { id?: number | string; value?: unknown };

/** The child's order component items (number column), LOCKED; null when the row is missing. */
async function readOrderItems(
	table: string,
	childSectionTipo: string,
	childSectionId: number,
	orderTipo: string,
): Promise<OrderItem[] | null> {
	return (await lockedKey(table, childSectionTipo, childSectionId, 'number', orderTipo)) as
		| OrderItem[]
		| null;
}

/**
 * Assign the initial sibling order to a child under a newly added parent (PHP
 * set_child_order :829): next = descriptor-children count + 1, written into the
 * child's own order component paired by id_key to the parent-link item id. The
 * locator MUST carry its item id. Writes nothing without an item id, an order
 * component or the child row (addParent/moveParent hold that row's lock already,
 * so no caller reaches the last case). Locks its own read: called on its own,
 * it never reverts a concurrent order save (tree_parent_lost_update L10).
 */
export async function setChildOrder(
	childSectionTipo: string,
	childSectionId: number,
	parentLocator: ParentLocator,
	actor: number,
): Promise<void> {
	const idKey = Math.trunc(Number(parentLocator.id ?? 0));
	if (idKey <= 0) return;
	const context = await orderContext(childSectionTipo);
	if (context === null) return;
	const items = await readOrderItems(
		context.table,
		childSectionTipo,
		childSectionId,
		context.orderTipo,
	);
	if (items === null) return;

	// descriptor-children count of the parent (dd64/1 filtered inverse count).
	const siblings = await getChildrenOfTypeLocators(
		parentLocator.section_id,
		parentLocator.section_tipo,
		'descriptor',
	);
	const updated = updateInlineValueByIdKey(items, siblings.length + 1, idKey);
	await persistTreeKeys(
		{ table: context.table, sectionTipo: childSectionTipo, sectionId: childSectionId },
		[{ column: 'number', key: context.orderTipo, after: updated }],
		actor,
	);
}

/**
 * Delete the child's order value for one parent context (PHP remove_child_order
 * :917). The order row is locked FIRST (before the id_key resolution reads the
 * links). Writes nothing for an unresolved id_key (PHP masking behaviour), a
 * missing order component or a missing row (moveParent holds that row's lock
 * already). Removes the paired inline value then persists.
 */
export async function removeChildOrder(
	childSectionTipo: string,
	childSectionId: number,
	parentLocator: ParentLocator,
	actor: number,
): Promise<void> {
	const context = await orderContext(childSectionTipo);
	if (context === null) return;
	const items = await readOrderItems(
		context.table,
		childSectionTipo,
		childSectionId,
		context.orderTipo,
	);
	if (items === null) return;

	let idKey = Math.max(0, addressOf(parentLocator.id ?? null) ?? 0);
	if (idKey <= 0) {
		idKey = await resolveParentLinkIdKey(
			childSectionTipo,
			childSectionId,
			parentLocator.section_tipo,
			Math.trunc(Number(parentLocator.section_id)),
		);
	}
	if (idKey <= 0) return; // nothing paired → no-op

	const removed = removeInlineByIdKey(items, idKey);
	await persistTreeKeys(
		{ table: context.table, sectionTipo: childSectionTipo, sectionId: childSectionId },
		[
			{
				column: 'number',
				key: context.orderTipo,
				after: removed.length === 0 ? null : removed,
			},
		],
		actor,
	);
}

/** The child's parent key under its row lock, with the child's table; null when the row is missing. */
async function lockedParentKey(
	childSectionTipo: string,
	childSectionId: number,
	parentRelationTipo: string,
): Promise<{ table: string; existing: ParentLocator[] } | null> {
	const table = await getMatrixTableFromTipo(childSectionTipo);
	if (table === null) return null;
	const existing = (await lockedKey(
		table,
		childSectionTipo,
		childSectionId,
		'relation',
		parentRelationTipo,
	)) as ParentLocator[] | null;
	return existing === null ? null : { table, existing };
}

/** True when a locator carries no item id yet (absent, null or empty). */
function lacksItemId(locator: ParentLocator): boolean {
	return locator.id === undefined || locator.id === null || locator.id === '';
}

/**
 * THE ADD half shared by addParent and moveParent: `base` (the links the write
 * keeps) plus `parentLocator`, or null for a duplicate. Defaults
 * from_component_tipo/type, refuses a cycle (`tree.cycle`, self-reference
 * included — checked against `stored`, the links as read under the lock: only
 * ADDED links are checked), pre-allocates the item id and WRITES the initial
 * order; the caller writes the parent key itself (one write per key).
 */
async function withAddedParent(
	table: string,
	child: { section_tipo: string; section_id: number },
	parentRelationTipo: string,
	stored: readonly ParentLocator[],
	base: readonly ParentLocator[],
	parentLocator: ParentLocator,
	actor: number,
): Promise<ParentLocator[] | null> {
	const locator: ParentLocator = { ...parentLocator };
	if (locator.from_component_tipo === undefined) locator.from_component_tipo = parentRelationTipo;
	if (locator.type === undefined) locator.type = RELATION_TYPE_PARENT;

	await assertParentLinksAcyclic(child, stored, [...base, locator]);

	// dedup (PHP add_locator_to_data equality: section_tipo/section_id/type/from_component_tipo).
	// The check runs BEFORE the id allocation and the order write (defect D15,
	// fixed 2026-08-09): a refused duplicate used to burn an item id and leave a
	// stray order-component entry keyed to a locator that never lands.
	if (base.some((link) => compareLocators(link as Locator, locator as Locator, LINK_PROPERTIES))) {
		return null;
	}

	// pre-allocate the item id (the order dataframe pairing key).
	if (lacksItemId(locator)) {
		locator.id = await allocateComponentItemId(
			table,
			child.section_tipo,
			child.section_id,
			parentRelationTipo,
		);
	}

	// initial sibling order (paired by the just-allocated id).
	await setChildOrder(child.section_tipo, child.section_id, locator, actor);
	return [...base, locator];
}

/** `existing` without the link `parentLocator` names (PHP remove_locator_from_data equality). */
function withoutParent(
	existing: readonly ParentLocator[],
	parentLocator: ParentLocator,
): ParentLocator[] {
	return existing.filter(
		(stored) => !compareLocators(stored as Locator, parentLocator as Locator, LINK_PROPERTIES),
	);
}

/** The parent-key write of a door: `after` (empty ⇒ the key is removed). */
function parentKeyWrite(parentRelationTipo: string, after: readonly ParentLocator[]): TreeKeyWrite {
	return {
		column: 'relation',
		key: parentRelationTipo,
		after: after.length === 0 ? null : after,
	};
}

/**
 * Add a parent locator to a child (PHP add_parent :123). Locks the child's
 * parent key (missing row → false — never a silent ok), refuses a cycle with
 * `tree.cycle` (self-reference included) under the lock law above, defaults
 * from_component_tipo/type, refuses a duplicate (false), pre-allocates the
 * locator item id, sets the initial order and persists.
 */
export async function addParent(
	childSectionTipo: string,
	childSectionId: number,
	parentRelationTipo: string,
	parentLocator: ParentLocator,
	actor: number,
): Promise<boolean> {
	const locked = await lockedParentKey(childSectionTipo, childSectionId, parentRelationTipo);
	if (locked === null) return false;
	const { table, existing } = locked;
	const next = await withAddedParent(
		table,
		{ section_tipo: childSectionTipo, section_id: childSectionId },
		parentRelationTipo,
		existing,
		existing,
		parentLocator,
		actor,
	);
	if (next === null) return false;
	await persistTreeKeys(
		{ table, sectionTipo: childSectionTipo, sectionId: childSectionId },
		[parentKeyWrite(parentRelationTipo, next)],
		actor,
	);
	return true;
}

/** What a move answered: done, or which half refused (PHP update_parent_data's two errors). */
export type MoveParentOutcome = 'moved' | 'from_not_found' | 'to_refused';

/**
 * MOVE a child from one parent to another (PHP update_parent_data :627 —
 * remove_parent + add_parent on ONE component instance, then ONE save()).
 * Locks the child's parent key, removes the old link's order value, then adds
 * the new link exactly as addParent does (cycle check, dedup, id, initial
 * order) — and writes the parent key ONCE, from the locked value to the moved
 * one, so the record's history holds the move as one change (never an
 * intermediate parentless state). A missing row or an absent `from` link →
 * `from_not_found`; a duplicate `to` → `to_refused` (the caller rolls back);
 * a cycle throws `tree.cycle`.
 */
export async function moveParent(
	childSectionTipo: string,
	childSectionId: number,
	parentRelationTipo: string,
	from: ParentLocator,
	to: ParentLocator,
	actor: number,
): Promise<MoveParentOutcome> {
	const locked = await lockedParentKey(childSectionTipo, childSectionId, parentRelationTipo);
	if (locked === null) return 'from_not_found';
	const { table, existing } = locked;

	await removeChildOrder(childSectionTipo, childSectionId, from, actor);
	const kept = withoutParent(existing, from);
	if (kept.length === existing.length) return 'from_not_found';

	const next = await withAddedParent(
		table,
		{ section_tipo: childSectionTipo, section_id: childSectionId },
		parentRelationTipo,
		existing,
		kept,
		to,
		actor,
	);
	if (next === null) return 'to_refused';
	await persistTreeKeys(
		{ table, sectionTipo: childSectionTipo, sectionId: childSectionId },
		[parentKeyWrite(parentRelationTipo, next)],
		actor,
	);
	return 'moved';
}

/** Descriptor/non-descriptor children of a parent (PHP get_children_of_type :664). */
export async function getChildrenOfType(
	parentSectionId: number | string,
	parentSectionTipo: string,
	type: 'descriptor' | 'non_descriptor' = 'descriptor',
): Promise<{ section_tipo: string; section_id: number }[]> {
	const locators = await getChildrenOfTypeLocators(parentSectionId, parentSectionTipo, type);
	return locators.map((locator) => ({
		section_tipo: locator.section_tipo,
		section_id: locator.section_id,
	}));
}

/**
 * A sibling's order items with `order` stored under the parent link `idKey`,
 * or null when there is nothing to write (no row, or the value is already
 * `order`). Pure: the caller writes.
 */
function reorderedItems(items: OrderItem[] | null, idKey: number, order: number): unknown[] | null {
	if (items === null) return null;
	const currentValue = getInlineValueByIdKey(items, idKey);
	if (currentValue !== null && Math.trunc(Number(currentValue)) === order) return null;
	return updateInlineValueByIdKey(items, order, idKey);
}

/**
 * The matrix tables of a sibling set, then ONE sorted lock batch over every row
 * that may be rewritten (rule 4) — the batch refuses outside a transaction even
 * when it is empty. A sibling whose section resolves no table maps to null (the
 * caller's skip branch).
 */
async function lockSiblingRows(
	siblings: readonly { section_tipo: string; section_id: unknown }[],
): Promise<(string | null)[]> {
	const tables: (string | null)[] = [];
	for (const sibling of siblings) tables.push(await getMatrixTableFromTipo(sibling.section_tipo));
	await lockMatrixRowsForUpdate(
		siblings.flatMap((sibling, index) => {
			const table = tables[index];
			const sectionId = Math.trunc(Number(sibling.section_id));
			// no table, or an id that addresses no row: nothing to lock (the caller skips it).
			return table === null || table === undefined || !Number.isSafeInteger(sectionId)
				? []
				: [{ table, sectionTipo: sibling.section_tipo, sectionId }];
		}),
	);
	return tables;
}

/**
 * Renumber the descriptor children of a parent densely 1..n (PHP
 * recalculate_sibling_orders_static :1053). Every child row is locked in ONE
 * sorted batch before the first read. Skips children whose stored order is
 * already correct and children with an unresolvable id_key or no row. Returns
 * false when no order component is configured.
 */
export async function recalculateSiblingOrders(
	childSectionTipo: string,
	parentSectionTipo: string,
	parentSectionId: number,
	actor: number,
): Promise<boolean> {
	const orderTipo = await getComponentOrderTipo(childSectionTipo);
	if (orderTipo === null) return false;

	const children = await getChildrenOfTypeLocators(
		parentSectionId,
		parentSectionTipo,
		'descriptor',
	);
	const tables = await lockSiblingRows(children);

	for (const [index, child] of children.entries()) {
		const table = tables[index] ?? null;
		if (table === null) continue;
		const idKey = await resolveParentLinkIdKey(
			child.section_tipo,
			child.section_id,
			parentSectionTipo,
			parentSectionId,
		);
		if (idKey <= 0) continue;
		const items = await readOrderItems(table, child.section_tipo, child.section_id, orderTipo);
		const updated = reorderedItems(items, idKey, index + 1);
		if (items === null || updated === null) continue;
		await persistTreeKeys(
			{ table, sectionTipo: child.section_tipo, sectionId: child.section_id },
			[{ column: 'number', key: orderTipo, after: updated }],
			actor,
		);
	}
	return true;
}

/**
 * One changed order record (PHP sort_children return shape).
 * KEPT UNION: `locator` is the CALLER's locator echoed verbatim — see the
 * sortChildren wire note below.
 */
export interface SortChange {
	value: number;
	locator: { section_tipo: string; section_id: number | string; [extra: string]: unknown };
}

/**
 * Persist a user-defined sibling ordering (PHP component_relation_children::
 * sort_children :1057). Positions are 1-based ascending. Every target row is
 * locked in ONE sorted batch before the first read (two orderings over the same
 * rows can never lock in opposite orders). Per locator: resolve the parent-link
 * id_key (skip ≤0), skip if unchanged or the row is missing, else update +
 * record. Returns false when the section_map defines no order component.
 */
export async function sortChildren(
	childSectionTipo: string,
	// KEPT UNION: `locators` is the RQO body's ar_locators list (dd_ts_api
	// save_order) — an uncoerced wire door, so the tree client's legacy string
	// ids still arrive here. Consumed numerically only (Number()); never
	// re-persisted as an address from this list.
	locators: { section_tipo: string; section_id: number | string; [extra: string]: unknown }[],
	parentSectionTipo: string,
	parentSectionId: number,
	actor: number,
): Promise<SortChange[] | false> {
	const orderTipo = await getComponentOrderTipo(childSectionTipo);
	if (orderTipo === null) return false;
	const tables = await lockSiblingRows(locators);

	const changed: SortChange[] = [];
	for (const [index, locator] of locators.entries()) {
		const table = tables[index] ?? null;
		if (table === null) continue;
		const idKey = await resolveParentLinkIdKey(
			locator.section_tipo,
			locator.section_id,
			parentSectionTipo,
			parentSectionId,
		);
		if (idKey <= 0) continue;
		const order = index + 1;
		const sectionId = Number(locator.section_id);
		const items = await readOrderItems(table, locator.section_tipo, sectionId, orderTipo);
		const updated = reorderedItems(items, idKey, order);
		if (items === null || updated === null) continue;
		await persistTreeKeys(
			{ table, sectionTipo: locator.section_tipo, sectionId },
			[{ column: 'number', key: orderTipo, after: updated }],
			actor,
		);
		changed.push({ value: order, locator });
	}
	return changed;
}
