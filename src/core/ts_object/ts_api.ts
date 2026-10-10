/**
 * DD_TS_API (PHP core/api/v1/common/class.dd_ts_api.php) — the thesaurus-tree
 * read/write API surface. Five actions, byte-parity envelopes and VERBATIM msg
 * strings (asserted by the PHP tests): get_node_data, get_children_data,
 * add_child, update_parent_data, save_order.
 *
 * Reads gate at permission ≥1, writes at ≥2 (PHP common::get_permissions on the
 * section). Every mutation runs inside ONE withTransaction that first acquires the
 * PHP-identical advisory node lock(s), does all validation BEFORE any write (no
 * orphan window), and invalidates caches only AFTER commit. Cache invalidation and
 * the dd_ontology order sync run post-commit, never inside the tx.
 *
 * The thin wrappers in api/handlers/dd_ts_api.ts resolve the principal, forward
 * here, and are the ONE site that turns the outcome below into an envelope.
 * ENVELOPE v2 (engineering/ERRORS_SPEC.md §4): an action ANSWERS with a
 * `TsApiOutcome` payload and REFUSES by THROWING a registered DedaloError — the
 * PHP "always HTTP 200, failures ride as result:false" parity is repealed here,
 * so a refusal now carries the registry status and a machine-readable code.
 */

import type { Rqo } from '../concepts/rqo.ts';
import { coerceSectionId } from '../concepts/section_id.ts';
import { clampClientLimit } from '../concepts/sqo.ts';
import { readMatrixRecord } from '../db/matrix.ts';
import { updateMatrixKeyData } from '../db/matrix_write.ts';
import { acquireNodeLock, withTransaction } from '../db/postgres.ts';
import { DedaloError, isDedaloError, SectionIdRefused } from '../errors/index.ts';
import {
	RELATION_TYPE_LINK,
	RELATION_TYPE_PARENT,
	YES_NO_SECTION,
} from '../ontology/ontology_tipos.ts';
import { getMatrixTableFromTipo } from '../ontology/resolver.ts';
import { getSectionMap } from '../ontology/section_map.ts';
import { getSectionIdFromTipo, requiredOntologyTld } from '../ontology/tld.ts';
import { getParentTipo } from '../relations/children.ts';
import {
	addParent,
	isAncestor,
	recalculateSiblingOrders,
	removeParent,
	sortChildren,
} from '../relations/parent.ts';
import { createSectionRecord } from '../section/record/create_record.ts';
import type { Principal } from '../security/permissions.ts';
import { getPermissions } from '../security/permissions.ts';
import {
	invalidateNode,
	type ParseLocator,
	parseChildData,
	type TsOptions,
	getChildrenData as tsGetChildrenData,
} from './ts_object.ts';

/**
 * What a dd_ts_api action ANSWERS with. Not a wire body: api/handlers/
 * dd_ts_api.ts is the one site that wraps it in `ok(...)`. A refusal is a THROW,
 * never a field here (ERRORS_SPEC §4).
 */
export interface TsApiOutcome {
	/** The envelope `data` (the client reads it as `result` through the compat block). */
	data: unknown;
	/**
	 * NON-FATAL findings the action completed in spite of (an incomplete
	 * section_map). They ride as the top-level `errors` extension key, which is
	 * where the tree client already reads them — a warning must not become a
	 * refusal: add_child still creates the node.
	 */
	warnings?: string[];
}

/**
 * THE dd_ts_api DOOR (WC-2026-08-10-section-id-int-canonical). Every section_id
 * in this API's RQO body addresses a TREE NODE, i.e. a matrix record — so it is
 * coerced here, once, counted under its own deprecable source key, instead of
 * riding a string leg into the engine's Number() casts. Non-address junk (a
 * synthetic token, a padded external id) refuses loudly as `section_id.
 * not_an_address` — the caught reason is the CAUSE (logged), never the wire.
 */
function doorSectionId(raw: unknown, door: string): number {
	try {
		return coerceSectionId(raw, `rqo.dd_ts_api.${door}`);
	} catch (error) {
		throw new SectionIdRefused('section_id.not_an_address', {
			cause: error,
			coordinates: { door: `rqo.dd_ts_api.${door}` },
		});
	}
}

/**
 * The same door for an OPTIONAL section_id: absent (or the legacy empty-string
 * spelling of absent) stays absent, present is coerced and counted. Refuses
 * exactly like `doorSectionId`.
 */
function optionalDoorSectionId(raw: unknown, door: string): number | undefined {
	if (raw === undefined || raw === null || raw === '') return undefined;
	return doorSectionId(raw, door);
}

/** The section grant every action gates on (reads 1, writes 2 — PHP parity). */
async function requireSectionLevel(
	principal: Principal,
	sectionTipo: string,
	minimum: number,
): Promise<void> {
	if ((await getPermissions(principal, sectionTipo, sectionTipo)) < minimum) {
		throw new DedaloError('perm.denied', {
			coordinates: { section_tipo: sectionTipo, required_level: minimum },
		});
	}
}

/** The RQO carries no `source` — nothing addresses a node. */
function requireSource(rqo: Rqo, action: string): Record<string, unknown> {
	if (rqo.source === undefined) {
		throw new DedaloError('request.invalid_source', { coordinates: { action } });
	}
	return rqo.source as Record<string, unknown>;
}

/**
 * A mutation whose transaction rolled back. The caught reason is the CAUSE
 * (logged, never serialized); a refusal that was ALREADY typed inside the tx
 * passes through with its own code.
 */
function refuseRolledBack(
	error: unknown,
	action: string,
	coordinates: Record<string, string | number>,
): never {
	if (isDedaloError(error)) throw error;
	throw new DedaloError('tree.node_write_failed', {
		publicMessage: `Error on ${action}. The process was rolled back`,
		cause: error,
		coordinates: { ...coordinates, action },
	});
}

// ===========================================================================
// GET_NODE_DATA (PHP :95).
// ===========================================================================
export async function getNodeData(rqo: Rqo, principal: Principal): Promise<TsApiOutcome> {
	const source = requireSource(rqo, 'get_node_data');
	const sectionTipo = (source.section_tipo as string | undefined) ?? null;
	const sectionId = optionalDoorSectionId(source.section_id, 'get_node_data.section_id');
	const childrenTipo = (source.children_tipo as string | undefined) ?? null;
	const areaModel = (source.area_model as string | undefined) ?? 'area_thesaurus';
	const options = (rqo.options ?? {}) as Record<string, unknown>;
	const thesaurusViewMode = (options.thesaurus_view_mode as string | undefined) ?? 'default';

	// SEC: read ≥1 on the section.
	if (sectionTipo !== null && sectionTipo !== '') {
		await requireSectionLevel(principal, sectionTipo, 1);
	}

	const tsOptions: TsOptions = { model: thesaurusViewMode === 'model', area_model: areaModel };
	const locator: ParseLocator = {
		section_tipo: sectionTipo ?? undefined,
		section_id: sectionId,
	};
	if (childrenTipo !== null && childrenTipo !== '') locator.from_component_tipo = childrenTipo;

	const arChildrenData = await parseChildData([locator], areaModel, tsOptions, null, principal);
	return { data: arChildrenData[0] ?? null };
}

// ===========================================================================
// GET_CHILDREN_DATA (PHP :211).
// ===========================================================================

/** The get_children_data RQO, read into its typed fields (defaults applied). */
interface ChildrenDataRequest {
	sectionTipo: string | null;
	sectionId: number | undefined;
	childrenTipo: string | null;
	areaModel: string;
	children: ParseLocator[] | null;
	pagination: Record<string, unknown> | null;
	thesaurusViewMode: string;
}

/**
 * Read the get_children_data RQO into `ChildrenDataRequest`, applying the PHP
 * defaults. Refuses only through the section_id door.
 */
function parseChildrenDataRequest(rqo: Rqo): ChildrenDataRequest {
	const source = rqo.source as Record<string, unknown>;
	const options = (rqo.options ?? {}) as Record<string, unknown>;
	return {
		sectionTipo: (source.section_tipo as string | undefined) ?? null,
		sectionId: optionalDoorSectionId(source.section_id, 'get_children_data.section_id'),
		childrenTipo: (source.children_tipo as string | undefined) ?? null,
		areaModel: (source.model as string | undefined) ?? 'area_thesaurus',
		children: (source.children as ParseLocator[] | undefined) ?? null,
		pagination: clampChildrenPagination(
			(options.pagination as Record<string, unknown> | undefined) ?? null,
			(source.section_tipo as string | undefined) ?? 'get_children_data',
		),
		thesaurusViewMode: (options.thesaurus_view_mode as string | undefined) ?? 'default',
	};
}

/**
 * The children door's pagination is CLIENT input and goes through the SAME
 * clamp as an SQO limit (DEC-07, audit P2-31 / CLI-30): a `limit` of 0, a
 * negative, a non-number or anything above CLIENT_MAX_LIMIT becomes the
 * ceiling; an ABSENT limit keeps the door's own default (300, applied by
 * ts_object.getChildrenData). Until this clamp the door took `pagination`
 * verbatim, so a client `limit: 0` was an UNPAGED read of the whole branch —
 * exactly what the post-duplicate refresh paths sent. Offset is coerced the way
 * sanitizeClientSqo coerces it; `total` is left to the delegate (it is the
 * client's cached count, trusted for the echo, never for the paging decision).
 * A null pagination stays null (the delegate's default page). Cloned: the
 * caller's object is never mutated.
 */
function clampChildrenPagination(
	pagination: Record<string, unknown> | null,
	scope: string,
): Record<string, unknown> | null {
	if (pagination === null) return null;
	const clamped: Record<string, unknown> = { ...pagination };
	if (clamped.limit !== undefined) {
		clamped.limit = clampClientLimit(clamped.limit, scope);
	}
	clamped.offset = Number.isFinite(Number(clamped.offset))
		? Math.max(0, Math.trunc(Number(clamped.offset)))
		: 0;
	return clamped;
}

export async function getChildrenData(rqo: Rqo, principal: Principal): Promise<TsApiOutcome> {
	requireSource(rqo, 'get_children_data');
	const request = parseChildrenDataRequest(rqo);
	const { sectionTipo, sectionId, childrenTipo, areaModel, children, pagination } = request;

	if (sectionTipo !== null && sectionTipo !== '') {
		await requireSectionLevel(principal, sectionTipo, 1);
	}

	const tsOptions: TsOptions = {
		model: request.thesaurusViewMode === 'model',
		area_model: areaModel,
	};
	const defaultLimit = 300;

	// mode A: standard children resolution (delegates to ts_object.getChildrenData).
	if ((children === null || children.length === 0) && sectionId && childrenTipo) {
		return {
			data: await tsGetChildrenData(
				sectionTipo as string,
				sectionId,
				childrenTipo,
				defaultLimit,
				areaModel,
				tsOptions,
				pagination,
				principal,
			),
		};
	}

	// mode B: pre-built children list.
	const parentLocator =
		sectionTipo && sectionId ? { section_tipo: sectionTipo, section_id: sectionId } : null;
	const arChildrenData = await parseChildData(
		children ?? [],
		areaModel,
		tsOptions,
		parentLocator,
		principal,
	);
	return { data: { ar_children_data: arChildrenData, pagination } };
}

/** The default si/no "yes" locator (dd64/1) an is_descriptor/is_indexable defaults to. */
function siNoYesLocator(componentTipo: string): Record<string, unknown> {
	return {
		id: 1,
		type: RELATION_TYPE_LINK,
		section_id: '1',
		section_tipo: YES_NO_SECTION,
		from_component_tipo: componentTipo,
	};
}

// ===========================================================================
// ADD_CHILD (PHP :352).
// ===========================================================================
export async function addChild(rqo: Rqo, principal: Principal): Promise<TsApiOutcome> {
	const source = (rqo.source ?? {}) as Record<string, unknown>;
	const sectionTipo = source.section_tipo as string;

	// SEC-10: write ≥2.
	await requireSectionLevel(principal, sectionTipo, 2);

	const sectionId = doorSectionId(source.section_id, 'add_child.section_id');

	// Validations BEFORE any write (no orphan window).
	const sectionMap = await getSectionMap(sectionTipo);
	const thesaurus = (sectionMap?.thesaurus ?? {}) as {
		is_descriptor?: unknown;
		is_indexable?: unknown;
	};
	// NON-FATAL (unchanged): an incomplete section_map only skips the si/no
	// default below — the child is still created, and the finding travels back
	// as a warning.
	const warnings: string[] = [];
	if (thesaurus.is_descriptor === undefined) {
		warnings.push("Invalid section_map 'is_descriptor' property from section");
	}
	if (thesaurus.is_indexable === undefined) {
		warnings.push("Invalid section_map 'is_indexable' property from section");
	}
	const parentRelationTipo = await getParentTipo(sectionTipo);
	if (parentRelationTipo === null) {
		throw new DedaloError('tree.parent_unresolved', {
			publicMessage: 'Error on get component_relation_parent from section. Model does not exists',
			coordinates: { section_tipo: sectionTipo, action: 'add_child' },
		});
	}

	let newSectionId: number;
	try {
		newSectionId = await withTransaction(async () => {
			await acquireNodeLock(sectionTipo, sectionId);

			const createdId = await createSectionRecord(sectionTipo, principal.userId);

			const table = await getMatrixTableFromTipo(sectionTipo);
			if (table === null) throw new Error('Failed to resolve matrix table for new section');

			// is_descriptor default (dd64/1) when the section_map defines it.
			if (typeof thesaurus.is_descriptor === 'string' && thesaurus.is_descriptor !== '') {
				await updateMatrixKeyData(
					table,
					sectionTipo,
					createdId,
					'relation',
					thesaurus.is_descriptor,
					[siNoYesLocator(thesaurus.is_descriptor)],
				);
			}
			// is_indexable default (dd64/1) when defined.
			if (typeof thesaurus.is_indexable === 'string' && thesaurus.is_indexable !== '') {
				await updateMatrixKeyData(
					table,
					sectionTipo,
					createdId,
					'relation',
					thesaurus.is_indexable,
					[siNoYesLocator(thesaurus.is_indexable)],
				);
			}

			// ontology7 (ONT-TLD): for a GOVERNED `<tld>0` section nothing happens
			// here — createSectionRecord's birth defaults derive the value from the
			// section itself (record_defaults.ts seed 3). This code used to COPY it
			// off the parent record instead, which inherited EMPTINESS whenever the
			// parent was itself tld-less: the mechanism that produced the tree's
			// invisible shell nodes. Deriving beats inheriting.
			//
			// EXCEPT for localontology0, which ONT-TLD exempts precisely because its
			// records declare a FOREIGN tld on purpose (they override a canonical node,
			// so they carry the OVERRIDDEN node's tld). Nothing derives that, so the
			// parent copy is still the only thing that can supply it — dropping it
			// wholesale left tree-created override records with no tld at all, which
			// is the very bug this change exists to remove.
			if (requiredOntologyTld(sectionTipo) === null && getSectionIdFromTipo(sectionTipo) === '0') {
				const parentRecord = await readMatrixRecord(table, sectionTipo, sectionId);
				const tldItems =
					((parentRecord?.columns.string as Record<string, unknown[]> | null)?.ontology7 as
						| unknown[]
						| undefined) ?? [];
				await updateMatrixKeyData(
					table,
					sectionTipo,
					createdId,
					'string',
					'ontology7',
					tldItems.length === 0 ? null : tldItems,
				);
			}

			// link to the parent node.
			const added = await addParent(sectionTipo, createdId, parentRelationTipo, {
				section_tipo: sectionTipo,
				section_id: sectionId,
				from_component_tipo: parentRelationTipo,
				type: RELATION_TYPE_PARENT,
			});
			if (!added.ok) throw new Error('Failed add parent locator to new section');

			return createdId;
		});
	} catch (error) {
		refuseRolledBack(error, 'add_child', { section_tipo: sectionTipo, section_id: sectionId });
	}

	// post-commit invalidation.
	invalidateNode(sectionTipo, sectionId);

	return {
		data: Math.trunc(Number(newSectionId)),
		...(warnings.length === 0 ? {} : { warnings }),
	};
}

// ===========================================================================
// UPDATE_PARENT_DATA (PHP :627).
// ===========================================================================
export async function updateParentData(rqo: Rqo, principal: Principal): Promise<TsApiOutcome> {
	const source = (rqo.source ?? {}) as Record<string, unknown>;
	const sectionTipo = source.section_tipo as string;
	const oldParentSectionTipo = source.old_parent_section_tipo as string;
	const newParentSectionTipo = source.new_parent_section_tipo as string;

	// SEC-11: write ≥2.
	await requireSectionLevel(principal, sectionTipo, 2);

	const sectionId = doorSectionId(source.section_id, 'update_parent_data.section_id');
	const oldParentSectionId = doorSectionId(
		source.old_parent_section_id,
		'update_parent_data.old_parent_section_id',
	);
	const newParentSectionId = doorSectionId(
		source.new_parent_section_id,
		'update_parent_data.new_parent_section_id',
	);

	const parentTipo = await getParentTipo(sectionTipo);
	if (parentTipo === null) {
		throw new DedaloError('tree.parent_unresolved', {
			publicMessage: 'Error. Unable to resolve component_relation_parent from section',
			coordinates: { section_tipo: sectionTipo, action: 'update_parent_data' },
		});
	}

	// PRE-mutation cycle guard.
	const isSelfTarget = newParentSectionTipo === sectionTipo && newParentSectionId === sectionId;
	if (
		isSelfTarget ||
		(await isAncestor(sectionTipo, sectionId, newParentSectionTipo, newParentSectionId))
	) {
		throw new DedaloError('tree.cycle', {
			coordinates: {
				section_tipo: sectionTipo,
				section_id: sectionId,
				new_parent_section_tipo: newParentSectionTipo,
				new_parent_section_id: newParentSectionId,
			},
		});
	}

	try {
		await withTransaction(async () => {
			// lock both parents in deterministic (strcmp) order.
			const lockKeys: [string, number][] = [
				[oldParentSectionTipo, oldParentSectionId],
				[newParentSectionTipo, newParentSectionId],
			];
			lockKeys.sort((a, b) => `${a[0]}_${a[1]}`.localeCompare(`${b[0]}_${b[1]}`, 'en'));
			for (const [tipo, id] of lockKeys) {
				await acquireNodeLock(tipo, id);
			}

			const removed = await removeParent(sectionTipo, sectionId, parentTipo, {
				section_tipo: oldParentSectionTipo,
				section_id: oldParentSectionId,
				from_component_tipo: parentTipo,
				type: RELATION_TYPE_PARENT,
			});
			if (!removed)
				throw new Error(
					`Remove old parent locator failed: ${oldParentSectionTipo}_${oldParentSectionId}`,
				);

			const added = await addParent(sectionTipo, sectionId, parentTipo, {
				section_tipo: newParentSectionTipo,
				section_id: newParentSectionId,
				from_component_tipo: parentTipo,
				type: RELATION_TYPE_PARENT,
			});
			if (!added.ok)
				throw new Error(
					`Add new parent locator failed: ${newParentSectionTipo}_${newParentSectionId}`,
				);

			await recalculateSiblingOrders(sectionTipo, oldParentSectionTipo, oldParentSectionId);
		});
	} catch (error) {
		refuseRolledBack(error, 'update_parent_data', {
			section_tipo: sectionTipo,
			section_id: sectionId,
		});
	}

	invalidateNode(sectionTipo, sectionId);
	invalidateNode(oldParentSectionTipo, oldParentSectionId);
	invalidateNode(newParentSectionTipo, newParentSectionId);

	return { data: true };
}

// ===========================================================================
// SAVE_ORDER (PHP :841).
// ===========================================================================
export async function saveOrder(rqo: Rqo, principal: Principal): Promise<TsApiOutcome> {
	const source = (rqo.source ?? {}) as Record<string, unknown>;
	const sectionTipo = source.section_tipo as string;
	const rawLocators =
		(source.ar_locators as { section_tipo: string; section_id: unknown }[] | undefined) ?? [];
	const parentSectionTipo = (source.parent_section_tipo as string | undefined) ?? null;
	const rawParentSectionId = source.parent_section_id;

	// SEC-12: write ≥2.
	await requireSectionLevel(principal, sectionTipo, 2);

	// Door coercion for the whole ordered list + the parent: each entry names a
	// sibling RECORD whose order row is about to be rewritten.
	const arLocators = rawLocators.map((locator) => ({
		...locator,
		section_id: doorSectionId(locator.section_id, 'save_order.ar_locators.section_id'),
	}));
	const coercedParentSectionId =
		rawParentSectionId === undefined || rawParentSectionId === null || rawParentSectionId === ''
			? undefined
			: doorSectionId(rawParentSectionId, 'save_order.parent_section_id');

	if (
		parentSectionTipo === null ||
		parentSectionTipo === '' ||
		coercedParentSectionId === undefined
	) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: 'Error. parent_section_tipo and parent_section_id are required',
			coordinates: { section_tipo: sectionTipo, action: 'save_order' },
		});
	}
	const parentSectionId = coercedParentSectionId;

	let result: Awaited<ReturnType<typeof sortChildren>>;
	try {
		result = await withTransaction(async () => {
			await acquireNodeLock(parentSectionTipo, parentSectionId);
			return sortChildren(sectionTipo, arLocators, parentSectionTipo, parentSectionId);
		});
	} catch (error) {
		refuseRolledBack(error, 'save_order', {
			section_tipo: sectionTipo,
			parent_section_tipo: parentSectionTipo,
			parent_section_id: parentSectionId,
		});
	}

	// The section_map declares no `order` key, so there is no column to write the
	// sequence into: a STATE conflict, not a transport failure. Nothing was
	// written (sortChildren answered false before touching a row), so nothing is
	// invalidated or mirrored either — exactly as before.
	if (result === false) {
		throw new DedaloError('resource.conflict', {
			publicMessage:
				'Error. The order cannot be established. Invalid section map. Please, define a valid section list map such as {"order":"hierarchy49"}',
			coordinates: { section_tipo: sectionTipo, action: 'save_order' },
		});
	}

	invalidateNode(parentSectionTipo, parentSectionId);
	// mirror the new order into dd_ontology.order_number (Track B ontology_write).
	const { syncOrderToDdOntology } = await import('../ontology/ontology_write.ts');
	await syncOrderToDdOntology(
		result.map((change) => ({
			value: change.value,
			locator: {
				section_tipo: change.locator.section_tipo,
				section_id: Math.trunc(Number(change.locator.section_id)),
			},
		})),
		parentSectionTipo,
		parentSectionId,
	);

	return { data: result };
}
