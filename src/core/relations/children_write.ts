/**
 * COMPONENT_RELATION_CHILDREN WRITE-THROUGH (RELATIONS_SPEC.md §6.3 addendum
 * 2026-10-02; PHP class.component_relation_children.php set_data :230 /
 * update_parent :392). WC-2026-10-02-relation-children-write-through.
 *
 * The component OWNS NO DATA (descriptor `derived: true`): its value is
 * computed per read from "who declares me as parent" (relations/children.ts).
 * A save on it is therefore A SET OF SAVES of each affected CHILD's
 * component_relation_parent — "make me your parent" for a child that joins the
 * list, "remove me as your parent" for one that leaves it — each one an
 * ordinary `saveComponentData` on the child, so every child gets what any edit
 * of its parent field gets: the FOR UPDATE row lock, the Time Machine row
 * carrying the caller's `bulkProcessId` (so a bulk revert restores it — PHP
 * dropped the bulk id here), the modified stamps, the observers and the write
 * chokepoint's obligations. The component's own matrix column is NEVER written.
 *
 * WHY (2026-09-26 → 2026-10-02). The generic engine stored the client's
 * changed_data under the children tipo in the HOST record's own relation
 * column — bytes no edit/list read consults — and answered ok:true while no
 * child changed; the echo (a read) then served the unchanged computed children.
 * Linking a child or clearing the field silently did nothing.
 * `scripts/relation_children_orphan_sweep.ts` deletes those orphan bytes.
 *
 * SEMANTICS (PHP set_data diff-sync, identity = the child RECORD):
 *  - the PREVIOUS list is the computed children (the read's own engine);
 *  - `set_data` replaces the list (null/[] empties it), `clear` empties it,
 *    `insert` appends a record locator, `remove` drops the child its VALUE
 *    names (computed child locators carry no item id — removal is BY LOCATOR,
 *    user decision 2026-09-27), `add_new_element` creates a record in the
 *    named section and makes it a child. Any other action — `sort_data`,
 *    `sort_by_column`, `update` — REFUSES (`request.invalid_data`): children
 *    order is each child's own order value, not a position in this list;
 *  - a child that LEAVES loses EVERY link of its parent component that targets
 *    this record, whatever its `type` — the same predicate the read uses to
 *    call it a child (target + from_component_tipo), so after a clear the read
 *    answers empty. PHP removed only `dd47` links, which left a mistyped link
 *    listed forever with no door able to drop it (the divergence of the WC);
 *  - a child that JOINS gets the canonical `dd47` link and, when the section
 *    declares an order component (section_map thesaurus.order), its initial
 *    sibling order paired by id_key to the new link (PHP add_parent +
 *    set_child_order: descriptor-children count + 1).
 *
 * REFUSALS ARE LOUD for a malformed or unsafe request (unsupported action, a
 * child outside this component's hierarchy, a cycle, a child the actor may not
 * write, a nested save that refuses). Two outcomes are deliberate SILENT
 * no-ops, PHP-verbatim and visible to the client as an unchanged list
 * (component_portal.link_record compares pagination.total → false): a link to
 * a record that does not exist, and a link to the record itself.
 *
 * PERMISSIONS: the dispatch door already required write on THIS component of
 * this record. Every child write additionally passes the human save door's own
 * question for the CHILD's parent component (`authorizeRecordAccess`, door
 * 'save': the dd128-aware pair + the write scope) — ALL children are asked
 * BEFORE any is written, and everything runs in ONE transaction under this
 * record's tree node lock, so a refusal or a failure leaves nothing half-done.
 * The order value rides its link (the paired dataframe of the link, as a frame
 * rides its main) and is not asked separately.
 */

import { compareLocators, type Locator } from '../concepts/locator.ts';
import { readMatrixRecord } from '../db/matrix.ts';
import { acquireNodeLock, deferPostTransaction, withTransaction } from '../db/postgres.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { DATA_NOLAN, RELATION_TYPE_PARENT } from '../ontology/ontology_tipos.ts';
import { getMatrixTableFromTipo } from '../ontology/resolver.ts';
import {
	type ChangedDataItem,
	type SaveRequest,
	type SaveResult,
	saveComponentData,
} from '../section/record/save_component.ts';
import type { Principal } from '../security/permissions.ts';
import { currentPrincipal } from '../security/request_context.ts';
import { authorizeRecordAccess } from '../security/write_door.ts';
import { invalidateNode } from '../ts_object/ts_object.ts';
import {
	getChildren,
	getChildrenOfType,
	getComponentOrderTipo,
	getParentTipo,
	getRelatedParentTipo,
} from './children.ts';
import { isAncestor } from './parent.ts';
import { applyAddNewElement } from './save.ts';

/** A child record address (PHP in_array_locator identity: section_tipo + section_id). */
export interface ChildRef {
	section_tipo: string;
	section_id: number;
}

/** What the write-through needs about the host record and its pair. */
interface HostContext {
	request: SaveRequest;
	componentTipo: string;
	sectionTipo: string;
	sectionId: number;
	/** The paired component_relation_parent tipo (on the children). */
	parentTipo: string;
	/** The host's matrix table — the read searches children only there. */
	table: string;
}

/** The locator properties that address a record. */
const RECORD_ADDRESS = ['section_tipo', 'section_id'] as const;

function childKey(child: ChildRef): string {
	return `${child.section_tipo}_${child.section_id}`;
}

/**
 * A client locator naming a record → its address, or null when it does not
 * name one (no section_tipo, or a section_id that is not a positive integer).
 */
export function toChildRef(value: unknown): ChildRef | null {
	if (value === null || typeof value !== 'object') return null;
	const locator = value as { section_tipo?: unknown; section_id?: unknown };
	const id = positiveId(locator.section_id);
	if (typeof locator.section_tipo !== 'string' || locator.section_tipo === '' || id === null) {
		return null;
	}
	return { section_tipo: locator.section_tipo, section_id: id };
}

/** A positive integer record id, or null. */
function positiveId(value: unknown): number | null {
	const id = Number(value);
	return Number.isInteger(id) && id > 0 ? id : null;
}

function invalidData(host: HostContext, reason: string): DedaloError {
	return new DedaloError('request.invalid_data', {
		message: `component_relation_children write: ${reason}`,
		publicMessage: reason,
		coordinates: {
			tipo: host.componentTipo,
			section_tipo: host.sectionTipo,
			section_id: host.sectionId,
		},
	});
}

/** One `set_data` value → the desired list (null/undefined empties it). */
function setDataList(host: HostContext, value: unknown): ChildRef[] {
	if (value === null || value === undefined) return [];
	if (!Array.isArray(value)) {
		throw invalidData(host, "'set_data' needs an array of record locators (or null)");
	}
	return value.map((item) => {
		const ref = toChildRef(item);
		if (ref === null) {
			throw invalidData(host, "'set_data' holds a value that is not a record locator");
		}
		return ref;
	});
}

/** The record an `insert` / `remove` names in its value — refused when it names none. */
function namedChild(host: HostContext, change: ChangedDataItem): ChildRef {
	const ref = toChildRef(change.value);
	if (ref !== null) return ref;
	throw invalidData(
		host,
		change.action === 'remove'
			? "'remove' must name the child record in its value (children are removed by locator; they carry no item ids)"
			: "'insert' needs a record locator as its value",
	);
}

/** One action applied to the working list (PHP set_data's `$data`). */
type ChangeApplier = (
	host: HostContext,
	desired: ChildRef[],
	change: ChangedDataItem,
	created: number[],
) => Promise<ChildRef[]>;

/** The actions a children save accepts — every other one refuses (see the header). */
const CHANGE_APPLIERS: Readonly<Record<string, ChangeApplier>> = {
	set_data: async (host, _desired, change) => setDataList(host, change.value),
	clear: async () => [],
	insert: async (host, desired, change) => [...desired, namedChild(host, change)],
	remove: async (host, desired, change) => {
		const target = childKey(namedChild(host, change));
		return desired.filter((child) => childKey(child) !== target);
	},
	add_new_element: async (host, desired, change, created) => {
		const child = await createChildRecord(host, String(change.value ?? ''));
		created.push(child.section_id);
		return [...desired, child];
	},
};

/** One change applied to the working list; an unsupported action refuses. */
function applyChange(
	host: HostContext,
	desired: ChildRef[],
	change: ChangedDataItem,
	created: number[],
): Promise<ChildRef[]> {
	const applier = Object.hasOwn(CHANGE_APPLIERS, change.action)
		? CHANGE_APPLIERS[change.action]
		: undefined;
	if (applier === undefined) {
		throw invalidData(
			host,
			`action '${String(change.action)}' is not supported on a children field (use set_data, clear, insert, remove by locator or add_new_element; the children order is each child's own order value)`,
		);
	}
	return applier(host, desired, change, created);
}

/** Apply every change in order; de-duplicate by record address (first wins). */
async function desiredChildren(
	host: HostContext,
	previous: ChildRef[],
	created: number[],
): Promise<ChildRef[]> {
	let desired = [...previous];
	for (const change of host.request.changedData) {
		desired = await applyChange(host, desired, change, created);
	}
	const seen = new Set<string>();
	return desired.filter((child) => {
		const key = childKey(child);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * The child must hold THIS parent component, in THIS table — the read searches
 * only there, so a link written anywhere else would be a write no read shows.
 */
async function assertChildSection(host: HostContext, sectionTipo: string): Promise<void> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === host.table && (await getParentTipo(sectionTipo)) === host.parentTipo) return;
	throw invalidData(
		host,
		`${sectionTipo} cannot hold a child of ${host.sectionTipo}: it does not carry the parent component ${host.parentTipo} in ${host.table}`,
	);
}

/** add_new_element: a fresh record of the named section (host project filter inherited). */
async function createChildRecord(host: HostContext, targetSectionTipo: string): Promise<ChildRef> {
	if (targetSectionTipo === '') {
		throw invalidData(host, "'add_new_element' needs the section to create the child in");
	}
	await assertChildSection(host, targetSectionTipo);
	// T0-2: the New-button predicate on the target runs inside, BEFORE the insert;
	// assertChildSection above IS this door's membership ('structural').
	const outcome = await applyAddNewElement(
		[],
		targetSectionTipo,
		host.componentTipo,
		host.sectionTipo,
		host.sectionId,
		{ access: { mode: 'create', principal: actorOf(host), membership: 'structural' } },
	);
	if (outcome === null) {
		throw new DedaloError('record.save_failed', {
			message: `component_relation_children write: no record could be created in ${targetSectionTipo}`,
			coordinates: { section_tipo: targetSectionTipo },
		});
	}
	return { section_tipo: targetSectionTipo, section_id: outcome.sectionId };
}

/**
 * The joining children, pre-flighted before anything is written: self and a
 * missing record are silent no-ops (PHP), a foreign section refuses, a link that
 * would close a cycle refuses with `tree.cycle`.
 */
async function joiningChildren(
	host: HostContext,
	desired: ChildRef[],
	previousKeys: ReadonlySet<string>,
): Promise<ChildRef[]> {
	const joining: ChildRef[] = [];
	for (const child of desired) {
		if (previousKeys.has(childKey(child))) continue;
		if (isHost(host, { ...child })) continue;
		await assertChildSection(host, child.section_tipo);
		if ((await readRow(host, child)) === null) {
			continue;
		}
		// The child may not be an ancestor of its new parent.
		if (await isAncestor(child.section_tipo, child.section_id, host.sectionTipo, host.sectionId)) {
			throw new DedaloError('tree.cycle', {
				coordinates: {
					section_tipo: child.section_tipo,
					section_id: child.section_id,
					new_parent_section_tipo: host.sectionTipo,
					new_parent_section_id: host.sectionId,
				},
			});
		}
		joining.push(child);
	}
	return joining;
}

/** The request principal, or the request-context backstop (leaf doors). */
function actorOf(host: HostContext): Principal {
	const principal = host.request.principal ?? currentPrincipal();
	if (principal !== undefined) return principal;
	throw new DedaloError('perm.denied', {
		message:
			'component_relation_children write: no actor — each child write is authorized per child and cannot run anonymously',
		coordinates: { section_tipo: host.sectionTipo, tipo: host.componentTipo },
	});
}

/** Every child is asked of the human save door BEFORE any is written. */
async function authorizeChildren(
	host: HostContext,
	principal: Principal,
	children: readonly ChildRef[],
): Promise<void> {
	for (const child of children) {
		await authorizeRecordAccess(
			principal,
			{
				section_tipo: child.section_tipo,
				component_tipo: host.parentTipo,
				section_id: child.section_id,
			},
			{ mode: 'write', level: 2, sectionFloor: 0, door: 'save' },
		);
	}
}

/** One nested save on a child; a refusal throws so the whole write rolls back. */
async function saveOnChild(
	host: HostContext,
	principal: Principal,
	child: ChildRef,
	componentTipo: string,
	changedData: ChangedDataItem[],
): Promise<void> {
	const outcome = await saveComponentData({
		componentTipo,
		sectionTipo: child.section_tipo,
		sectionId: child.section_id,
		// The parent link and its order value are non-translatable: whatever lang
		// the children request carried, the child keys live in the no-lang slice.
		lang: DATA_NOLAN,
		changedData,
		userId: principal.userId,
		principal,
		bulkProcessId: host.request.bulkProcessId,
		saveTm: host.request.saveTm,
	});
	if (outcome.ok) return;
	throw new DedaloError('record.save_failed', {
		message: `component_relation_children write: the save of ${componentTipo} on ${child.section_tipo}/${child.section_id} was refused: ${outcome.message}`,
		coordinates: {
			section_tipo: child.section_tipo,
			section_id: child.section_id,
			tipo: componentTipo,
		},
	});
}

/**
 * One row of the host's table, read DIRECTLY (never the read-scoped memo):
 * this runs inside the write transaction and must see what the nested saves
 * just wrote.
 */
function readRow(host: HostContext, ref: ChildRef) {
	return readMatrixRecord(host.table, ref.section_tipo, ref.section_id);
}

/** A stored relation/number key of a child, read inside the transaction. */
async function storedItems(
	host: HostContext,
	child: ChildRef,
	column: 'relation' | 'number',
	tipo: string,
): Promise<Record<string, unknown>[]> {
	const record = await readRow(host, child);
	const bag = record?.columns[column] as Record<string, unknown> | null | undefined;
	const value = bag?.[tipo];
	return Array.isArray(value)
		? value.filter(
				(item): item is Record<string, unknown> => item !== null && typeof item === 'object',
			)
		: [];
}

/** Does this stored parent link point at the host record? (the read's own predicate) */
function targetsHost(host: HostContext, link: Record<string, unknown>): boolean {
	return isHost(host, link as Locator);
}

/** Is this locator the host record? (the locator law: section_tipo + loose section_id) */
function isHost(host: HostContext, locator: Locator): boolean {
	return compareLocators(
		locator,
		{ section_tipo: host.sectionTipo, section_id: host.sectionId } as Locator,
		RECORD_ADDRESS,
	);
}

function hasItemId(item: Record<string, unknown>): boolean {
	const id = Number(item.id);
	return Number.isInteger(id) && id > 0;
}

/**
 * REMOVE ME AS YOUR PARENT — every link of the child's parent component that
 * targets this record, whatever its type, plus the order value paired to it.
 * By item id; a PHP-era link without one is dropped by a `set_data` of the
 * links that stay (the only shape that can name it).
 */
async function unlinkChild(
	host: HostContext,
	principal: Principal,
	orderTipo: string | null,
	child: ChildRef,
): Promise<void> {
	const links = await storedItems(host, child, 'relation', host.parentTipo);
	const leaving = links.filter((link) => targetsHost(host, link));
	if (leaving.length === 0) return;
	if (orderTipo !== null) {
		const orderIds = new Set(
			(await storedItems(host, child, 'number', orderTipo)).map((item) => Number(item.id)),
		);
		const paired = leaving.filter((link) => hasItemId(link) && orderIds.has(Number(link.id)));
		if (paired.length > 0) {
			await saveOnChild(
				host,
				principal,
				child,
				orderTipo,
				paired.map((link) => ({ action: 'remove', id: Number(link.id), value: null })),
			);
		}
	}
	const changes: ChangedDataItem[] = leaving.every(hasItemId)
		? leaving.map((link) => ({ action: 'remove', id: Number(link.id), value: null }))
		: [
				{
					action: 'set_data',
					id: null,
					value: links.filter((link) => !targetsHost(host, link)),
				},
			];
	await saveOnChild(host, principal, child, host.parentTipo, changes);
}

/**
 * MAKE ME YOUR PARENT — the canonical dd47 link through the child's own parent
 * component, then (when the section orders its children) the initial sibling
 * order paired to the new link's item id: descriptor-children count + 1,
 * counted BEFORE the link lands (PHP add_parent → set_child_order).
 */
async function linkChild(
	host: HostContext,
	principal: Principal,
	orderTipo: string | null,
	child: ChildRef,
): Promise<void> {
	const nextOrder =
		orderTipo === null
			? 0
			: (
					await getChildrenOfType(
						host.sectionId,
						host.sectionTipo,
						'descriptor',
						host.componentTipo,
					)
				).length + 1;
	await saveOnChild(host, principal, child, host.parentTipo, [
		{
			action: 'insert',
			id: null,
			value: {
				type: RELATION_TYPE_PARENT,
				section_tipo: host.sectionTipo,
				section_id: host.sectionId,
				from_component_tipo: host.parentTipo,
			},
		},
	]);
	if (orderTipo === null) return;
	const link = (await storedItems(host, child, 'relation', host.parentTipo)).find(
		(item) => targetsHost(host, item) && item.type === RELATION_TYPE_PARENT && hasItemId(item),
	);
	if (link === undefined) {
		throw new DedaloError('tree.node_write_failed', {
			message: `component_relation_children write: the parent link of ${child.section_tipo}/${child.section_id} to ${host.sectionTipo}/${host.sectionId} has no item id to pair its order with`,
			coordinates: { section_tipo: child.section_tipo, section_id: child.section_id },
		});
	}
	const idKey = Number(link.id);
	await saveOnChild(host, principal, child, orderTipo, [
		{ action: 'update', id: idKey, value: { id: idKey, value: nextOrder } },
	]);
}

/** The host context, or a loud refusal when the pair or the table is missing. */
async function hostContext(request: SaveRequest): Promise<HostContext> {
	const { componentTipo, sectionTipo } = request;
	const parentTipo = await getRelatedParentTipo(componentTipo, sectionTipo);
	if (parentTipo === null) {
		throw new DedaloError('tree.parent_unresolved', {
			message: `component_relation_children write: no component_relation_parent is related to ${componentTipo} in ${sectionTipo}`,
			coordinates: { section_tipo: sectionTipo, tipo: componentTipo },
		});
	}
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) {
		throw new DedaloError('request.invalid_tipo', {
			message: `component_relation_children write: no matrix table for section '${sectionTipo}'`,
			coordinates: { section_tipo: sectionTipo },
		});
	}
	return {
		request,
		componentTipo,
		sectionTipo,
		sectionId: Number(request.sectionId),
		parentTipo,
		table,
	};
}

async function computedChildren(host: HostContext): Promise<ChildRef[]> {
	return (await getChildren(host.sectionId, host.sectionTipo, host.componentTipo)).map((child) => ({
		section_tipo: child.section_tipo,
		section_id: Number(child.section_id),
	}));
}

/**
 * The write-through. Entry point from saveComponentData (after its
 * pre-transaction gates) for a save addressed to a component_relation_children.
 */
export async function saveRelationChildren(request: SaveRequest): Promise<SaveResult> {
	const host = await hostContext(request);
	if (request.callerDataframe != null) {
		throw invalidData(host, 'a children field carries no dataframe');
	}
	const touched: ChildRef[] = [];
	const created: number[] = [];
	await withTransaction(async () => {
		// One writer at a time per parent node (the tree's own lock key), so two
		// concurrent children saves cannot each diff against a stale list.
		await acquireNodeLock(host.sectionTipo, host.sectionId);
		if (
			(await readRow(host, { section_tipo: host.sectionTipo, section_id: host.sectionId })) === null
		) {
			throw invalidData(host, `${host.sectionTipo}/${host.sectionId} does not exist`);
		}
		const previous = await computedChildren(host);
		const previousKeys = new Set(previous.map(childKey));
		const desired = await desiredChildren(host, previous, created);
		const desiredKeys = new Set(desired.map(childKey));
		const leaving = previous.filter((child) => !desiredKeys.has(childKey(child)));
		const joining = await joiningChildren(host, desired, previousKeys);

		const principal = actorOf(host);
		await authorizeChildren(host, principal, [...leaving, ...joining]);

		const orderTipo = await getComponentOrderTipo(host.sectionTipo);
		for (const child of leaving) {
			await unlinkChild(host, principal, orderTipo, child);
			touched.push(child);
		}
		for (const child of joining) {
			await linkChild(host, principal, orderTipo, child);
			touched.push(child);
		}

		// Tree caches: this node's children and every touched child's own node.
		// Replayed on commit AND rollback — an idempotent clear, the house lane.
		const invalidateAll = (): void => {
			invalidateNode(host.sectionTipo, host.sectionId);
			for (const child of touched) invalidateNode(child.section_tipo, child.section_id);
		};
		if (!deferPostTransaction(invalidateAll)) invalidateAll();
	});

	const result: SaveResult = {
		ok: true,
		message: `children of ${host.sectionTipo}/${host.sectionId} written through ${host.parentTipo} (${touched.length} child record(s) changed)`,
		data: await getChildren(host.sectionId, host.sectionTipo, host.componentTipo),
	};
	if (created.length > 0) result.created_section_id = created[created.length - 1];
	return result;
}
