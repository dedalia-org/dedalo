/**
 * DD_TS_API (PHP core/api/v1/common/class.dd_ts_api.php) — the thesaurus-tree
 * read/write API surface. Five actions, byte-parity envelopes and VERBATIM msg
 * strings (asserted by the PHP tests): get_node_data, get_children_data,
 * add_child, update_parent_data, save_order.
 *
 * Reads gate at permission ≥1, writes at ≥2 (PHP common::get_permissions on the
 * section). Every mutation runs inside ONE tree transaction (tree_locks.ts
 * withTreeTransaction — a deadlock victim is re-run from the start) that first
 * acquires the PHP-identical advisory node lock(s), then the row locks of the
 * lock law (relations/parent.ts MUTATION HALF), does all validation BEFORE any
 * write (no orphan window), writes every key through the record-write
 * chokepoint with its Time Machine rows (parent.ts persistTreeKeys — PHP
 * component->save()), and invalidates caches only AFTER commit. Cache invalidation and
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
import { acquireNodeLock } from '../db/postgres.ts';
import { DedaloError, isDedaloError, SectionIdRefused } from '../errors/index.ts';
import {
	RELATION_TYPE_LINK,
	RELATION_TYPE_PARENT,
	YES_NO_SECTION,
} from '../ontology/ontology_tipos.ts';
import { getMatrixTableFromTipo } from '../ontology/resolver.ts';
import { getSectionMap } from '../ontology/section_map.ts';
import { getSectionIdFromTipo, requiredOntologyTld } from '../ontology/tld.ts';
import { getChildren, getParentTipo } from '../relations/children.ts';
import {
	addParent,
	isAncestor,
	moveParent,
	persistTreeKeys,
	recalculateSiblingOrders,
	sortChildren,
	type TreeKeyWrite,
} from '../relations/parent.ts';
import { createSectionRecord } from '../section/record/create_record.ts';
import type { Principal } from '../security/permissions.ts';
import { getPermissions } from '../security/permissions.ts';
import { scopeTargetsSection, type WriterChainScope } from '../security/writer_chain_scope.ts';
import { withTreeTransaction } from './tree_locks.ts';
import {
	invalidateNode,
	type ParseLocator,
	parseChildData,
	type TsNodeData,
	type TsOptions,
	trimNodeToScopeColumns,
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

/**
 * How a tree node door admits ONE section (owner decision (i), W4b review):
 * by the principal's own read grant ('granted' — PHP parity, the node is built
 * exactly as before), ONLY through a tree picker's verified scope ('scoped' —
 * the node is then trimmed to what the writer component's config shows,
 * trimNodeToScopeColumns), or not at all (null).
 */
type TreeAdmission = 'granted' | 'scoped' | null;

/**
 * One request's tree-picker scope, resolved at most ONCE however many sections
 * the door judges (the caller-chain verification is the expensive part). The
 * picker client sends the same `source.caller` declaration on every node read
 * it makes (ts_object.js get_picker_caller): `{tipo, section_tipo, section_id,
 * callers}`. An absent, malformed or invalid declaration earns no scope.
 */
interface TreePickerScope {
	readonly source: Record<string, unknown>;
	resolved?: Promise<WriterChainScope | null>;
}

function treePickerScopeOf(source: Record<string, unknown>): TreePickerScope {
	return { source };
}

/** The request's verified picker scope (area/read.ts pickerTreeScope), or null. */
async function resolveTreePickerScope(
	picker: TreePickerScope,
	principal: Principal,
): Promise<WriterChainScope | null> {
	const declared = picker.source.caller;
	if (declared === undefined || declared === null) return null;
	if (picker.resolved === undefined) {
		picker.resolved = (async () => {
			const { pickerTreeScope } = await import('../area/read.ts');
			const { currentDataLang } = await import('../resolve/request_lang.ts');
			return pickerTreeScope(declared, principal, currentDataLang());
		})();
	}
	return picker.resolved;
}

/** How `sectionTipo` is admitted (TreeAdmission). */
async function treeAdmission(
	principal: Principal,
	sectionTipo: string,
	picker: TreePickerScope,
): Promise<TreeAdmission> {
	if ((await getPermissions(principal, sectionTipo, sectionTipo)) >= 1) return 'granted';
	const scope = await resolveTreePickerScope(picker, principal);
	if (scope !== null && scopeTargetsSection(scope, sectionTipo)) return 'scoped';
	return null;
}

/**
 * The READ gate of the two tree NODE doors (get_node_data, get_children_data):
 * the section read grant (1), PHP parity — OR, for a TREE PICKER, the scope of
 * the component it opened for (owner decision (i), 2026-11-03 — a divergence
 * from PHP, WC-2026-11-04-tree-picker-read-gate-retired): the read declares the picker's `source.caller`, the
 * principal can WRITE that `view:'tree'` component through its VERIFIED caller
 * chain, and the node's section is one of the component's targets (area/read.ts
 * pickerTreeScope → security/writer_chain_scope.ts). Read-only browsing for
 * exactly that use: the node's own buttons stay at the principal's grant
 * (getPermissionsElement), so no write affordance appears, and a scoped node
 * carries only what the writer component's config shows (scopeNodes).
 */
async function requireTreeReadLevel(
	principal: Principal,
	sectionTipo: string,
	picker: TreePickerScope,
): Promise<'granted' | 'scoped'> {
	const admission = await treeAdmission(principal, sectionTipo, picker);
	if (admission !== null) return admission;
	throw new DedaloError('perm.denied', {
		coordinates: { section_tipo: sectionTipo, required_level: 1 },
	});
}

/**
 * The READ gate over EVERY section of a CLIENT-supplied node list (mode B of
 * get_children_data, owner decision (i), W4b review): the list is client
 * input, so each distinct section is judged by requireTreeReadLevel before a
 * node of it is built — once per section per request. (get_node_data's one
 * section rides it too; a null / empty section names nothing to judge.) Answers the sections
 * the scope ALONE admitted (their nodes are trimmed, scopeNodes).
 */
async function requireTreeReadLevels(
	principal: Principal,
	sectionTipos: Iterable<unknown>,
	picker: TreePickerScope,
): Promise<Set<string>> {
	const judged = new Set<string>();
	const scoped = new Set<string>();
	for (const sectionTipo of sectionTipos) {
		if (typeof sectionTipo !== 'string' || sectionTipo === '' || judged.has(sectionTipo)) continue;
		judged.add(sectionTipo);
		if ((await requireTreeReadLevel(principal, sectionTipo, picker)) === 'scoped') {
			scoped.add(sectionTipo);
		}
	}
	return scoped;
}

/**
 * Trim every node of a section the scope ALONE admitted to the writer
 * component's shown pairs (trimNodeToScopeColumns, owner decision (i)). Nodes
 * of granted sections pass untouched.
 */
async function scopeNodes(
	nodes: readonly TsNodeData[],
	scopedSections: ReadonlySet<string>,
	principal: Principal,
	picker: TreePickerScope,
): Promise<TsNodeData[]> {
	if (scopedSections.size === 0) return [...nodes];
	const scope = await resolveTreePickerScope(picker, principal);
	if (scope === null) return [...nodes];
	return nodes.map((node) =>
		scopedSections.has(node.section_tipo) ? trimNodeToScopeColumns(node, scope.columnPairs) : node,
	);
}

/**
 * Mode A's children page of a parent the scope ALONE admitted (owner decision
 * (i), W4b review): the children component may hold children of OTHER
 * sections, so each child's section is judged too — a child the principal can
 * neither read nor reach through the scope is PRUNED from the page (never a
 * refusal of its readable siblings), a scoped child is trimmed. The page's
 * `pagination` stays the children component's own (offset / limit address
 * positions of that list; a pruned child only leaves its slot empty, so the
 * next page is still fetched at offset + limit). A parent the principal READS
 * by its own grant never comes here: PHP judged only the parent section
 * (dd_ts_api::get_children_data → assert_section_permission), and so does that
 * path.
 */
async function scopedChildrenPage(
	nodes: readonly TsNodeData[],
	principal: Principal,
	picker: TreePickerScope,
): Promise<TsNodeData[]> {
	const admissions = new Map<string, TreeAdmission>();
	const kept: TsNodeData[] = [];
	const scopedSections = new Set<string>();
	for (const node of nodes) {
		let admission = admissions.get(node.section_tipo);
		if (admission === undefined) {
			admission = await treeAdmission(principal, node.section_tipo, picker);
			admissions.set(node.section_tipo, admission);
		}
		if (admission === null) continue;
		if (admission === 'scoped') scopedSections.add(node.section_tipo);
		kept.push(node);
	}
	return scopeNodes(kept, scopedSections, principal, picker);
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

	// SEC: read ≥1 on the section — or a verified tree picker's scope
	// (requireTreeReadLevel, owner decision (i)); a scoped node is trimmed.
	const picker = treePickerScopeOf(source);
	const scopedSections = await requireTreeReadLevels(principal, [sectionTipo], picker);

	const tsOptions: TsOptions = { model: thesaurusViewMode === 'model', area_model: areaModel };
	const locator: ParseLocator = {
		section_tipo: sectionTipo ?? undefined,
		section_id: sectionId,
	};
	if (childrenTipo !== null && childrenTipo !== '') locator.from_component_tipo = childrenTipo;

	const arChildrenData = await parseChildData([locator], areaModel, tsOptions, null, principal);
	const [node] = await scopeNodes(arChildrenData, scopedSections, principal, picker);
	return { data: node ?? null };
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

/** The children page size when the request names none (PHP get_children_data). */
const CHILDREN_DEFAULT_LIMIT = 300;

export async function getChildrenData(rqo: Rqo, principal: Principal): Promise<TsApiOutcome> {
	const source = requireSource(rqo, 'get_children_data');
	const request = parseChildrenDataRequest(rqo);
	const { sectionTipo, sectionId, childrenTipo, areaModel, children } = request;

	// SEC: read ≥1 on the section — or a verified tree picker's scope
	// (requireTreeReadLevel, owner decision (i)).
	const picker = treePickerScopeOf(source);
	let parentAdmission: 'granted' | 'scoped' | null = null;
	if (sectionTipo !== null && sectionTipo !== '') {
		parentAdmission = await requireTreeReadLevel(principal, sectionTipo, picker);
	}

	const tsOptions: TsOptions = {
		model: request.thesaurusViewMode === 'model',
		area_model: areaModel,
	};

	// mode A: standard children resolution (delegates to ts_object.getChildrenData).
	if ((children === null || children.length === 0) && sectionId && childrenTipo) {
		return childrenComponentPage(request, tsOptions, parentAdmission, principal, picker);
	}
	return clientChildrenList(request, tsOptions, parentAdmission, principal, picker);
}

/**
 * Mode A of get_children_data: the children component's own page. A parent
 * read by the principal's OWN grant: PHP parity — the parent section is the
 * only one judged. A parent the picker scope ALONE admitted: each child is
 * judged, unreadable ones pruned, scoped ones trimmed (scopedChildrenPage).
 */
async function childrenComponentPage(
	request: ChildrenDataRequest,
	tsOptions: TsOptions,
	parentAdmission: 'granted' | 'scoped' | null,
	principal: Principal,
	picker: TreePickerScope,
): Promise<TsApiOutcome> {
	const childrenData = await tsGetChildrenData(
		request.sectionTipo as string,
		request.sectionId as number,
		request.childrenTipo as string,
		CHILDREN_DEFAULT_LIMIT,
		request.areaModel,
		tsOptions,
		request.pagination,
		principal,
	);
	if (parentAdmission === 'scoped') {
		childrenData.ar_children_data = await scopedChildrenPage(
			childrenData.ar_children_data,
			principal,
			picker,
		);
	}
	return { data: childrenData };
}

/**
 * Mode B of get_children_data: a pre-built children list. SEC: the list is
 * CLIENT input — every locator's section is judged BEFORE a node of it is
 * built, whether or not the request also names (or omits) `source.section_tipo`.
 */
async function clientChildrenList(
	request: ChildrenDataRequest,
	tsOptions: TsOptions,
	parentAdmission: 'granted' | 'scoped' | null,
	principal: Principal,
	picker: TreePickerScope,
): Promise<TsApiOutcome> {
	const { sectionTipo, sectionId, pagination } = request;
	const children = request.children ?? [];
	const scopedSections = await requireTreeReadLevels(
		principal,
		children.map((locator) => locator.section_tipo),
		picker,
	);
	if (parentAdmission === 'scoped') scopedSections.add(sectionTipo as string);
	const parentLocator =
		sectionTipo && sectionId ? { section_tipo: sectionTipo, section_id: sectionId } : null;
	const builtChildren = await parseChildData(
		children,
		request.areaModel,
		tsOptions,
		parentLocator,
		principal,
	);
	const arChildrenData = await scopeNodes(builtChildren, scopedSections, principal, picker);
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
		newSectionId = await withTreeTransaction(async () => {
			await acquireNodeLock(sectionTipo, sectionId);

			const createdId = await createSectionRecord(sectionTipo, principal.userId);

			const table = await getMatrixTableFromTipo(sectionTipo);
			if (table === null) throw new Error('Failed to resolve matrix table for new section');

			// The new node's defaults, written through the chokepoint in ONE
			// update (PHP add_child: each default is an edit-mode component that
			// autosaves — stamped and historied; persistTreeKeys reads each key's
			// before-image itself).
			const target = { table, sectionTipo, sectionId: createdId };
			const defaults: TreeKeyWrite[] = [];
			const stage = (column: TreeKeyWrite['column'], key: string, after: unknown[] | null) => {
				defaults.push({ column, key, after });
			};
			// is_descriptor default (dd64/1) when the section_map defines it.
			if (typeof thesaurus.is_descriptor === 'string' && thesaurus.is_descriptor !== '') {
				stage('relation', thesaurus.is_descriptor, [siNoYesLocator(thesaurus.is_descriptor)]);
			}
			// is_indexable default (dd64/1) when defined.
			if (typeof thesaurus.is_indexable === 'string' && thesaurus.is_indexable !== '') {
				stage('relation', thesaurus.is_indexable, [siNoYesLocator(thesaurus.is_indexable)]);
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
				stage('string', 'ontology7', tldItems.length === 0 ? null : tldItems);
			}
			await persistTreeKeys(target, defaults, principal.userId);

			// link to the parent node.
			const added = await addParent(
				sectionTipo,
				createdId,
				parentRelationTipo,
				{
					section_tipo: sectionTipo,
					section_id: sectionId,
					from_component_tipo: parentRelationTipo,
					type: RELATION_TYPE_PARENT,
				},
				principal.userId,
			);
			if (!added) throw new Error('Failed add parent locator to new section');

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

	// PRE-mutation cycle guard — a FAST refusal only (unlocked, before the
	// transaction). The authoritative check is moveParent's locked walk inside
	// the transaction (relations/parent.ts), which also answers tree.cycle.
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
		await withTreeTransaction(async () => {
			// lock both parents in deterministic (strcmp) order.
			const lockKeys: [string, number][] = [
				[oldParentSectionTipo, oldParentSectionId],
				[newParentSectionTipo, newParentSectionId],
			];
			lockKeys.sort((a, b) => `${a[0]}_${a[1]}`.localeCompare(`${b[0]}_${b[1]}`, 'en'));
			for (const [tipo, id] of lockKeys) {
				await acquireNodeLock(tipo, id);
			}

			const moved = await moveParent(
				sectionTipo,
				sectionId,
				parentTipo,
				{
					section_tipo: oldParentSectionTipo,
					section_id: oldParentSectionId,
					from_component_tipo: parentTipo,
					type: RELATION_TYPE_PARENT,
				},
				{
					section_tipo: newParentSectionTipo,
					section_id: newParentSectionId,
					from_component_tipo: parentTipo,
					type: RELATION_TYPE_PARENT,
				},
				principal.userId,
			);
			if (moved === 'from_not_found')
				throw new Error(
					`Remove old parent locator failed: ${oldParentSectionTipo}_${oldParentSectionId}`,
				);
			if (moved === 'to_refused')
				throw new Error(
					`Add new parent locator failed: ${newParentSectionTipo}_${newParentSectionId}`,
				);

			await recalculateSiblingOrders(
				sectionTipo,
				oldParentSectionTipo,
				oldParentSectionId,
				principal.userId,
			);
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

/**
 * save_order rewrites the order 1..n FROM THE CLIENT LIST (sortChildren never
 * re-reads the sibling set), so the list must be EXACTLY the parent's current
 * children: a missing sibling would keep a stale, colliding number, a foreign
 * entry would take a slot. Read under the parent's node lock, so the set cannot
 * move between this check and the write. A parent with no children relation at
 * all is left to sortChildren (it answers `false` → the section-map refusal).
 * WC-2026-11-07-save-order-complete-list.
 */
async function assertCompleteSiblingList(
	arLocators: { section_tipo: string; section_id: number }[],
	parentSectionTipo: string,
	parentSectionId: number,
	sectionTipo: string,
): Promise<void> {
	const current = await getChildren(parentSectionId, parentSectionTipo);
	if (current.length === 0) return;
	const key = (locator: { section_tipo: string; section_id: unknown }) =>
		`${locator.section_tipo}_${Number(locator.section_id)}`;
	const expected = new Set(current.map(key));
	const sent = new Set(arLocators.map(key));
	const complete =
		arLocators.length === expected.size &&
		sent.size === expected.size &&
		[...sent].every((entry) => expected.has(entry));
	if (complete) return;
	throw new DedaloError('resource.conflict', {
		publicMessage:
			'The order was not saved: the list of terms is out of date. Reload the tree and try again',
		coordinates: {
			section_tipo: sectionTipo,
			parent_section_tipo: parentSectionTipo,
			parent_section_id: parentSectionId,
			action: 'save_order',
		},
	});
}

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
		result = await withTreeTransaction(async () => {
			await acquireNodeLock(parentSectionTipo, parentSectionId);
			await assertCompleteSiblingList(arLocators, parentSectionTipo, parentSectionId, sectionTipo);
			return sortChildren(
				sectionTipo,
				arLocators,
				parentSectionTipo,
				parentSectionId,
				principal.userId,
			);
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
