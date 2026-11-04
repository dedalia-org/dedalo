/**
 * Area read dispatch — the ONE hook the API dispatcher calls for an area-model
 * `read` (engineering/AREA_SPEC.md §2). Replaces the inline area branches that lived in
 * api/dispatch.ts; routes by area behavior (tree / maintenance / dashboard).
 *
 * Returns an ApiResult when it handled the read, or null to let the dispatcher
 * fall through to its generic path (dashboard-behavior areas return null in
 * Phase A — the dashboard engine lands in Phase B; today they fall through
 * exactly as before, so this relocation is zero behavior change).
 */

import type { ApiResult } from '../api/response.ts';
import {
	AREA_ONTOLOGY_TIPO,
	areaBehaviorOf,
	isAreaModel,
	PICKER_CALLER_MALFORMED_MESSAGE,
	PICKER_CALLER_MIN_PERMISSIONS,
	PICKER_CALLER_SECTIONLESS_MESSAGE,
	PICKER_CALLER_UNKNOWN_MESSAGE,
	PICKER_CALLER_VIEW,
	PICKER_NO_HIERARCHY_MESSAGE,
	type PickerCaller,
	type PickerTermSelectability,
	parsePickerCaller,
	type ThesaurusMode,
} from '../concepts/area.ts';
import type { Rqo } from '../concepts/rqo.ts';
import { canonicalizeStoredSectionId, isSectionId } from '../concepts/section_id.ts';
import { DedaloError, isDedaloError, ok } from '../errors/index.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
} from '../ontology/resolver.ts';
import {
	isTermSelectable,
	type PickerConstraint,
	resolvePickerConstraint,
} from '../relations/picker_constraint.ts';
import { buildStructureContext } from '../resolve/structure_context.ts';
import {
	canAccessOntologyArea,
	getPermissionGrant,
	getPermissions,
	type Principal,
} from '../security/permissions.ts';
import { withScopedPairs } from '../security/read_floor.ts';
import { currentRequestId } from '../security/request_context.ts';
import {
	resolveWriterChainScope,
	scopeTargetsSection,
	verifiedChainLineView,
	type WriterChainScope,
} from '../security/writer_chain_scope.ts';
import type { SearchThesaurusResult } from '../ts_object/search.ts';
import type { TsNodeData } from '../ts_object/ts_object.ts';
import { readAreaHierarchyData } from './tree.ts';

/** Shape of the tree-area boot item (subset consumed by the permission filter). */
export interface HierarchyBootItem {
	tipo: string;
	value: {
		target_section_tipo: string;
		children_tipo?: string | null;
		active_in_thesaurus?: boolean;
		typology_section_id: string;
		root_terms: { section_tipo?: unknown; section_id?: unknown }[];
		/** Relation mode only — the per-node link affordance (see §5 emission). */
		root_terms_selectable?: PickerTermSelectability[];
	}[];
	typologies: { section_id: string }[];
	ts_search?: unknown;
}

/**
 * What the server DERIVED from a declared picker caller: the mode it grants and
 * the constraint the picker (and the write chokepoint) is bound by.
 *
 * `constraint` is null for a caller that is not a relation-family component: it
 * holds no locators, declares no target and has no `data_limit`, so there is
 * nothing to narrow or to cap. That is not a narrowed scope — the read simply
 * serves the ordinary browse it always served, and relation mode is not
 * granted.
 */
interface ResolvedPickerCaller {
	mode: ThesaurusMode;
	constraint: PickerConstraint | null;
	/**
	 * THE TREE SCOPE (owner decision (i), 2026-11-03 — security/
	 * writer_chain_scope.ts): granted relation mode AND the caller named its
	 * caller chain (`caller.callers`) and the chain verifies with the component
	 * at WRITE through it. Only then may the picker browse the target sections
	 * its effective config names although the principal holds no grant on them
	 * (filterHierarchiesByGrant, the tree node doors ts_object/ts_api.ts). null
	 * = no unlock: the ordinary per-hierarchy grant prune.
	 */
	treeScope: WriterChainScope | null;
}

/**
 * The `view` this component is given by its SECTION's ddo_map, or null when the
 * map does not name it (the ordinary case — the node's own `properties.view`
 * then answers).
 *
 * Derived from the section's own ontology request_config, the same door the
 * section read uses, so the server never takes a view from the request.
 */
export async function ddoMapViewFor(tipo: string, sectionTipo: string): Promise<string | null> {
	try {
		const { deriveSectionDdoMap } = await import('../section/read.ts');
		const ddoMap = await deriveSectionDdoMap(sectionTipo, sectionTipo, 'edit');
		const entry = ddoMap.find((ddo) => (ddo as { tipo?: unknown }).tipo === tipo) as
			| { view?: unknown }
			| undefined;
		return typeof entry?.view === 'string' && entry.view !== '' ? entry.view : null;
	} catch (error) {
		// A section whose ddo_map cannot be derived is not a picker failure: the
		// node's own properties still answer. Reported, never silently swallowed.
		console.error(
			`[area/read] could not derive the ddo_map of '${sectionTipo}' for picker caller '${tipo}':`,
			error,
		);
		return null;
	}
}

/**
 * Derive the picker facts from the declared caller (engineering/AREA_SPEC.md §5 — the whole
 * point of the caller-declared design).
 *
 * RELATION MODE IS GRANTED, NEVER READ FROM THE REQUEST. All three conditions
 * must hold: the caller's RESOLVED view is the picker view (resolved through
 * the ordinary structure-context seam, so a ddo_map-injected view counts too),
 * its model is relation-family, and the principal holds EDIT on it FROM ITS
 * PROFILE (or is the superuser). Any of them missing is not an error — the read
 * proceeds in `default` mode and the picker intent is simply not granted.
 *
 * A RULE-BASIS EDIT IS NOT A PICKER GRANT. The grant EXTENDS the caller's edit
 * level into a capability of another surface (relation mode, the caller's
 * resolved targets, cap and held count on a thesaurus read). The rule levels
 * are bounded where they were written — the dd655 editing-preset rule answers 2
 * for every tipo under dd655 and every principal, its only bound being the
 * preset assembler's owner predicate — and none of those bounds travels into a
 * thesaurus read. So the level is asked with its authority
 * (`getPermissionGrant`, GrantBasis) and a 'rule' basis is refused, the read
 * floor's law (security/read_floor.ts).
 *
 * Relation-family is asked STRUCTURALLY (`getColumnNameByModel(model) ===
 * 'relation'` — does this model store locators?) rather than against a second
 * hand-kept model list, and it is the SAME question
 * relations/picker_constraint.ts asks before counting: pre-checking it here is
 * what keeps that resolver's contract throw from firing on an ordinary
 * mis-wired request.
 *
 * The client-input failures (an unknown element, a section that holds no
 * records) refuse as 400 with named reasons. Everything the constraint resolver
 * still throws on — an ontology node declaring an unusable `data_limit` — is a
 * definition defect, not request input, and propagates loudly: degrading it to
 * "uncapped" would silently unbind the very cap the write path re-resolves.
 */
async function resolvePickerCaller(
	caller: PickerCaller,
	principal: Principal,
	lang: string,
	declaredCallers: unknown = undefined,
): Promise<ResolvedPickerCaller> {
	const model = await getModelByTipo(caller.tipo);
	if (model === null) {
		throw new DedaloError('area.picker_caller_invalid', {
			publicMessage: PICKER_CALLER_UNKNOWN_MESSAGE,
			coordinates: { tipo: caller.tipo },
		});
	}
	if (getColumnNameByModel(model) !== 'relation') {
		return { mode: 'default', constraint: null, treeScope: null };
	}
	if ((await getMatrixTableFromTipo(caller.section_tipo)) === null) {
		throw new DedaloError('area.picker_caller_invalid', {
			publicMessage: PICKER_CALLER_SECTIONLESS_MESSAGE,
			coordinates: { section_tipo: caller.section_tipo },
		});
	}
	// THE PAIR MUST BE REAL. `tipo` and `section_tipo` arrive as two independent
	// client strings, and nothing above ties them together: without this check a
	// request can name any component under any section it can read. That matters
	// because `getPermissions` short-circuits for some sections (the dd655 preset
	// surface answers 2 for any tipo beneath it), so a forged pair could obtain
	// relation mode — and with it the caller's resolved targets and cap — for a
	// component that never declared a picker. The grant is only as honest as the
	// pair it is derived from (the ontology's one membership law, virtual-aware).
	const { tipoBelongsToSection } = await import('../ontology/resolver.ts');
	if (!(await tipoBelongsToSection(caller.tipo, caller.section_tipo))) {
		throw new DedaloError('area.picker_caller_invalid', {
			publicMessage: PICKER_CALLER_UNKNOWN_MESSAGE,
			coordinates: { tipo: caller.tipo, section_tipo: caller.section_tipo },
		});
	}

	const grant = await getPermissionGrant(principal, caller.section_tipo, caller.tipo);
	const permissions = grant.level;
	const constraint = await resolvePickerConstraint(
		caller.tipo,
		caller.section_tipo,
		caller.section_id,
	);
	// THE DDO-INJECTED VIEW IS PART OF THE ANSWER. `structure_context` resolves
	// `options.view ?? properties.view ?? model default`, and `options.view` is
	// the ddo_map channel — the section read passes it while walking the map. A
	// build without it sees ONLY the node's own `properties.view`, so a component
	// that declares `view:'tree'` in its parent's ddo_map (a live mechanism, and
	// how several shipped portals declare it) rendered the tree view on the
	// client while the server refused the grant: an edit affordance that browses
	// and navigates away on every click. The map is derived server-side from the
	// section's own ontology, never taken from the request.
	// A NESTED component (owner decision (i)) gets its view from its CALLER's
	// ddo line, not its section's map: when the declared `callers` VERIFY, the
	// governing line of the verified chain answers first (the same line its
	// cell was resolved from — writer_chain_scope.ts verifiedChainLineView); a
	// refused or absent chain falls back to the section map, exactly as before.
	const chainView = await verifiedChainLineView(principal, {
		tipo: caller.tipo,
		sectionTipo: caller.section_tipo,
		callers: declaredCallers,
		lang,
	});
	const injectedView = chainView ?? (await ddoMapViewFor(caller.tipo, caller.section_tipo));
	// EDIT mode: the picker is an edit affordance, and `view:'tree'` is
	// registered edit-only on the client. request_config is not needed here —
	// the caller's targets come from the ONE picker resolver, so this build
	// answers exactly one question: which view did the caller resolve to.
	const callerContext = await buildStructureContext({
		configFrom: { source: 'own', reason: 'element-context-request' },
		tipo: caller.tipo,
		sectionTipo: caller.section_tipo,
		mode: 'edit',
		lang,
		permissions,
		addRequestConfig: false,
		view: injectedView,
	});
	const granted =
		callerContext?.view === PICKER_CALLER_VIEW &&
		grant.basis !== 'rule' &&
		grant.level >= PICKER_CALLER_MIN_PERMISSIONS;
	// The tree scope rides ONLY a granted picker (a writer of a view:'tree'
	// relation component) whose caller chain verifies — see ResolvedPickerCaller.
	const treeScope = granted
		? await resolveWriterChainScope(principal, {
				tipo: caller.tipo,
				sectionTipo: caller.section_tipo,
				callers: declaredCallers,
				lang,
			})
		: null;

	return { mode: granted ? 'relation' : 'default', constraint, treeScope };
}

/**
 * May a TREE NODE door (ts_object/ts_api.ts get_node_data / get_children_data)
 * read `sectionTipo` for this request although the principal holds no grant on
 * it? Only for the tree picker of a component the principal can WRITE, through
 * its verified caller chain, when `sectionTipo` is one of that component's
 * targets (owner decision (i) — ResolvedPickerCaller.treeScope). The picker
 * client sends the same `source.caller` declaration on every node read it makes
 * (ts_object.js get_picker_caller). A malformed or absent declaration answers
 * false (the door then refuses exactly as before) — and so does a well-shaped
 * but INVALID one (an unknown tipo, a sectionless section, a tipo that is not
 * a member of its section): resolvePickerCaller's `area.picker_caller_invalid`
 * is the AREA boot read's answer, but on a node door the caller is only a
 * claim of a scope, so a bogus claim earns no scope and the door's own
 * perm.denied stands (no second error code that would tell an ungranted
 * principal which tipos exist where).
 */
export async function pickerTreeReadAllowed(
	declaredCaller: unknown,
	sectionTipo: string,
	principal: Principal,
	lang: string,
): Promise<boolean> {
	const treeScope = await pickerTreeScope(declaredCaller, principal, lang);
	return treeScope !== null && scopeTargetsSection(treeScope, sectionTipo);
}

/**
 * The tree scope a node door's declared picker caller earns (owner decision
 * (i)), or null — absent, malformed or invalid declaration, or no scope
 * (pickerTreeReadAllowed; ts_object/ts_api.ts resolves it once per node read).
 */
export async function pickerTreeScope(
	declaredCaller: unknown,
	principal: Principal,
	lang: string,
): Promise<WriterChainScope | null> {
	// parsePickerCaller refuses absent / null / non-object declarations too.
	const caller = parsePickerCaller(declaredCaller);
	if (caller === null) return null;
	try {
		const resolved = await resolvePickerCaller(
			caller,
			principal,
			lang,
			(declaredCaller as { callers?: unknown }).callers,
		);
		return resolved.treeScope;
	} catch (error) {
		if (isPickerCallerInvalid(error)) return null;
		throw error;
	}
}

/** resolvePickerCaller's client-input refusal (an invalid declaration), as opposed to a real failure. */
function isPickerCallerInvalid(error: unknown): boolean {
	return isDedaloError(error) && error.code === 'area.picker_caller_invalid';
}

/**
 * The per-node link affordance for the root terms this read emits (engineering/AREA_SPEC.md §5).
 *
 * The answer is the TERM's, never the caller's: relation mode means the
 * thesaurus itself declares, term by term, what may be linked. Deeper nodes are
 * served by dd_ts_api (get_children_data), which must answer the same way from
 * the same resolver — the rule has ONE implementation
 * (relations/picker_constraint.ts isTermSelectable → ts_object isIndexable).
 *
 * A root term that addresses no record declares nothing, so it carries no link
 * affordance — it still renders, visible and navigable, exactly like a
 * structural node.
 */
async function resolveRootTermSelectability(
	rootTerms: { section_tipo?: unknown; section_id?: unknown }[],
): Promise<PickerTermSelectability[]> {
	const selectability: PickerTermSelectability[] = [];
	for (const rootTerm of rootTerms) {
		const sectionTipo = String(rootTerm.section_tipo);
		const address = canonicalizeStoredSectionId(rootTerm.section_id);
		selectability.push({
			section_tipo: sectionTipo,
			section_id: rootTerm.section_id,
			selectable: isSectionId(address) ? await isTermSelectable(sectionTipo, address) : false,
		});
	}
	return selectability;
}

/**
 * Fail-closed guard for WRITE actions (engineering/AREA_SPEC.md §9): an area is a
 * non-data definition with no matrix row, so save/create/delete/duplicate
 * addressed at an area tipo (by declared model OR by the resolved model of the
 * target section_tipo) must be refused — never routed into section write code
 * via the duck-type shims. THROWS `area.write_refused`; returns normally when
 * the target is not an area (ERRORS_SPEC §4 — a gate throws, it never builds a
 * body).
 */
export async function refuseAreaWrite(
	sectionTipo: string | undefined,
	declaredModel: string | null | undefined,
): Promise<void> {
	if (declaredModel != null && isAreaModel(declaredModel)) {
		throw new DedaloError('area.write_refused', { coordinates: { model: declaredModel } });
	}
	if (sectionTipo !== undefined) {
		const model = await getModelByTipo(sectionTipo);
		if (model !== null && isAreaModel(model)) {
			throw new DedaloError('area.write_refused', { coordinates: { section_tipo: sectionTipo } });
		}
	}
}

/**
 * The area's structure context (PHP area_*_json get_structure_context). EVERY
 * area read must return a non-empty context: the client bails and renders the
 * area BLANK when result.context is empty (area_thesaurus.js:547; area.js /
 * area_maintenance.js guard the same way). Built exactly like
 * get_element_context so it stays identical to that (already-gated) surface.
 */
async function buildAreaContext(
	areaTipo: string,
	mode: string,
	lang: string,
	permissions: number,
): Promise<Record<string, unknown>[]> {
	const entry = await buildStructureContext({
		configFrom: { source: 'own', reason: 'area-or-menu' },
		tipo: areaTipo,
		sectionTipo: areaTipo,
		mode,
		lang,
		permissions,
	});
	return entry !== null ? [entry as unknown as Record<string, unknown>] : [];
}

/**
 * Handle a read whose source.model is an area model. Returns null when the area
 * behavior has no dedicated resolver yet (dashboard — Phase B) so the caller
 * falls through unchanged.
 */
export async function dispatchAreaRead(rqo: Rqo, principal: Principal): Promise<ApiResult | null> {
	const model = rqo.source?.model ?? '';
	const behavior = areaBehaviorOf(model);

	// Model-vs-tipo validation (engineering/AREA_SPEC.md §9): PHP dispatches area reads on
	// source.model without checking the tipo actually IS that model (the dd917
	// quirk — a field_text accepted as area_ontology). TS refuses the mismatch:
	// an unvalidated client model string must not choose server code paths.
	const areaTipo = rqo.source?.tipo;
	if (areaTipo !== undefined) {
		const actualModel = await getModelByTipo(areaTipo);
		if (actualModel !== null && actualModel !== model) {
			// The declared model and the tipo's real model disagree: an invalid
			// source, and the two values are LOG-ONLY (naming them back would
			// confirm what the tipo actually is).
			throw new DedaloError('request.invalid_source', {
				message: `read: source.model '${model}' does not match tipo '${areaTipo}'`,
				coordinates: { model, tipo: areaTipo },
			});
		}
	}

	// area_ontology: superuser, or a global admin whose profile grants dd5
	// (engineering/AREA_SPEC.md §9 — canAccessOntologyArea is the one rule, shared
	// with the menu). Fail-closed: refuse before touching the ontology.
	if (model === 'area_ontology' || areaTipo === AREA_ONTOLOGY_TIPO) {
		if (!(await canAccessOntologyArea(principal))) {
			throw new DedaloError('perm.denied', { coordinates: { area_tipo: areaTipo ?? model } });
		}
	}

	if (behavior === 'tree') {
		return await readTreeArea(rqo, principal, model as 'area_thesaurus' | 'area_ontology');
	}

	if (behavior === 'maintenance') {
		// Maintenance-area read (PHP area_maintenance_json): the widget catalog
		// rides as `datalist`. Admin-only, like the PHP area.
		if (!principal.isGlobalAdmin) {
			throw new DedaloError('perm.denied', { coordinates: { area_tipo: rqo.source?.tipo ?? '' } });
		}
		const maintTipo = rqo.source?.tipo ?? '';
		const permissions = await getPermissions(principal, maintTipo, maintTipo);
		const context = await buildAreaContext(
			maintTipo,
			rqo.source?.mode ?? 'list',
			rqo.source?.lang ?? 'lg-spa',
			permissions,
		);
		const { buildMaintenanceDataItem } = await import('../area_maintenance/widgets/registry.ts');
		return {
			status: 200,
			body: ok(
				{ context, data: [await buildMaintenanceDataItem()] },
				{ requestId: currentRequestId() },
			),
		};
	}

	if (behavior === 'dashboard') {
		return await readDashboardArea(rqo, principal);
	}

	// An area model with no behavior resolver (area_graph — dead/excluded, or any
	// unmapped area model): refuse loudly rather than silently fall into the
	// section path (engineering/AREA_SPEC.md §9 — never silently narrow).
	throw new DedaloError('request.invalid_model', {
		message: `read: area model '${model}' is not supported`,
		coordinates: { model },
	});
}

/**
 * Dashboard-area read (PHP area_common_json): the area's structure context plus
 * one data item carrying the statistics dashboard of the sections inside
 * (engineering/AREA_SPEC.md §4). Context is built exactly like get_element_context so
 * the area context stays identical to that (already-gated) surface; the
 * dashboard is attached only when read permission > 0 and it is not disabled by
 * properties.dashboard.disabled.
 */
async function readDashboardArea(rqo: Rqo, principal: Principal): Promise<ApiResult> {
	const areaTipo = rqo.source?.tipo;
	if (areaTipo === undefined) {
		throw new DedaloError('request.invalid_source', {
			message: 'read: source.tipo is required',
		});
	}
	const mode = rqo.source?.mode ?? 'list';
	const lang = rqo.source?.lang ?? 'lg-spa';
	const permissions = await getPermissions(principal, areaTipo, areaTipo);

	const context = await buildAreaContext(areaTipo, mode, lang, permissions);

	const dataItem: Record<string, unknown> = {
		tipo: areaTipo,
		section_tipo: areaTipo,
		section_id: null,
	};
	// Dashboard payload (PHP: only when get_data && permissions > 0; omitted when
	// properties.dashboard.disabled).
	if (permissions > 0) {
		const { getNode } = await import('../ontology/resolver.ts');
		const props = ((await getNode(areaTipo))?.properties ?? {}) as {
			dashboard?: { disabled?: boolean; metrics?: string[] };
		};
		if (props.dashboard?.disabled !== true) {
			const metricNames = props.dashboard?.metrics ?? ['total'];
			const { getDashboardData } = await import('./dashboard.ts');
			dataItem.dashboard = await getDashboardData(principal, areaTipo, metricNames);
		}
	}

	return {
		status: 200,
		body: ok({ context, data: [dataItem] }, { requestId: currentRequestId() }),
	};
}

/**
 * THE PICKER CALLER (engineering/AREA_SPEC.md §5): a read may declare WHICH
 * component instance it is opening the tree for. It declares nothing else — no
 * mode, no target list, no term pinning: those are conclusions, and a client's
 * conclusions are not authority (the same objection dispatchAreaRead already
 * makes about source.model). A present-but-malformed caller refuses; an absent
 * one is an ordinary browse read, byte-unchanged (null).
 */
async function resolveDeclaredPickerCaller(
	rqo: Rqo,
	principal: Principal,
	lang: string,
): Promise<ResolvedPickerCaller | null> {
	const declaredCaller = (rqo.source as { caller?: unknown } | undefined)?.caller;
	if (declaredCaller === undefined || declaredCaller === null) return null;
	const caller = parsePickerCaller(declaredCaller);
	if (caller === null) {
		throw new DedaloError('area.picker_caller_invalid', {
			publicMessage: PICKER_CALLER_MALFORMED_MESSAGE,
		});
	}
	return resolvePickerCaller(
		caller,
		principal,
		lang,
		(declaredCaller as { callers?: unknown }).callers,
	);
}

/**
 * The TYPOLOGY narrowing an area declares for itself: `rqo.source.properties.hierarchy_types`
 * (the PHP dd_core_api get_data copy of `ddo_source->properties->hierarchy_types`
 * onto the area, consumed by class.area_thesaurus.php get_hierarchy_sections).
 *
 * Where it comes from. The client sends the instance's own `properties` in
 * `source` (common.js create_source). For a tool-built child instance that is
 * the ddo entry's `properties` (tool_common load_ddo_map), so a tool's
 * `tool_config.ddo_map` entry `{role:'area_thesaurus', properties:{hierarchy_types:[8]}}`
 * arrives here as `source.properties.hierarchy_types = [8]` — on the boot read
 * and on every refresh/search read, which reuse the same rqo. The ontology node
 * dd100 itself does not carry it.
 *
 * Why a request value is acceptable here when `hierarchy_sections` /
 * `hierarchy_terms` / `thesaurus_mode` are not (engineering/AREA_SPEC.md §5.5):
 * it can only NARROW. It drops hierarchies before the per-hierarchy ACL loop
 * runs, never adds one, and grants no mode — the worst a forged value can do is
 * show the caller less of what they may already read.
 *
 * Only the thesaurus area is narrowed. An ontology area's typology is pinned
 * (ontology tipos have no hierarchy13 typology of their own), so a declared
 * list there is ignored rather than compared against the wrong registry.
 *
 * Returns null when nothing is declared — absent, null, or an EMPTY list, the
 * PHP `!empty($hierarchy_types_filter)` rule: every active hierarchy is
 * projected. Otherwise the declared ids as numbers (one id or a list, the value
 * shape the portal `{source:'hierarchy_types'}` branch accepts); an entry that
 * is not an integer can match no typology and is dropped, so a non-empty
 * declaration of nothing valid admits nothing rather than everything.
 */
function readDeclaredHierarchyTypeIds(
	rqo: Rqo,
	areaModel: 'area_thesaurus' | 'area_ontology',
): number[] | null {
	if (areaModel !== 'area_thesaurus') return null;
	const declared = (rqo.source as { properties?: { hierarchy_types?: unknown } } | undefined)
		?.properties?.hierarchy_types;
	if (declared === undefined || declared === null) return null;
	const declaredList = Array.isArray(declared) ? declared : [declared];
	if (declaredList.length === 0) return null;
	return [...new Set(declaredList.map((id) => Number(id)).filter((id) => Number.isInteger(id)))];
}

/** The pruned hierarchy list plus the two drop counters (see filterHierarchiesByGrant). */
interface PrunedHierarchies {
	kept: HierarchyBootItem['value'];
	/** Candidates dropped by a PERMISSION check (a target or root-term section the principal may not read). */
	refusedByAcl: number;
	/** Candidates dropped by DATA (inactive, no children tipo, no readable root term). */
	droppedByConfig: number;
}

/**
 * Per-hierarchy read-permission filter (PHP area_thesaurus_json loop):
 * ontology area → read on each hierarchy's TLD section only (the superuser
 * holds every grant); thesaurus → read on each hierarchy's target section AND
 * on each root term's section.
 *
 * THE TWO EMPTY CASES ARE DIFFERENT FACTS (engineering/AREA_SPEC.md §5) and are
 * counted SEPARATELY as the loop drops each candidate — "nothing survived"
 * alone cannot tell them apart, and answering the wrong one tells a curator
 * their thesaurus is forbidden when it is merely unconfigured (or the reverse,
 * which leaks that it exists).
 */
export async function filterHierarchiesByGrant(
	hierarchies: HierarchyBootItem['value'],
	principal: Principal,
	isOntologyArea: boolean,
	/**
	 * The picker's TREE SCOPE (ResolvedPickerCaller.treeScope — owner decision
	 * (i)): a thesaurus hierarchy whose target section, and a root term whose
	 * section, is one of the writer component's targets is read through it
	 * whatever the principal's grant. null = the ordinary grant prune.
	 */
	treeScope: WriterChainScope | null = null,
): Promise<PrunedHierarchies> {
	const readable = async (sectionTipo: string): Promise<boolean> =>
		(treeScope !== null && scopeTargetsSection(treeScope, sectionTipo)) ||
		(await getPermissions(principal, sectionTipo, sectionTipo)) >= 1;
	const pruned: PrunedHierarchies = { kept: [], refusedByAcl: 0, droppedByConfig: 0 };
	for (const hierarchy of hierarchies) {
		if (isOntologyArea) {
			// Ontology: read on the TLD section is the only gate — no admin bypass
			// (the area gate already required superuser or admin + dd5 grant).
			// Inactive and rootless entries stay, as PHP kept them for ontology.
			if (
				(await getPermissions(
					principal,
					hierarchy.target_section_tipo,
					hierarchy.target_section_tipo,
				)) < 1
			) {
				pruned.refusedByAcl++;
				continue;
			}
			pruned.kept.push(hierarchy);
			continue;
		}
		if (!(await readable(hierarchy.target_section_tipo))) {
			pruned.refusedByAcl++;
			continue;
		}
		if (hierarchy.active_in_thesaurus === false || !isNonEmptyString(hierarchy.children_tipo)) {
			pruned.droppedByConfig++;
			continue;
		}
		const rootTerms = await filterRootTermsByGrant(hierarchy.root_terms, readable);
		if (rootTerms.kept.length === 0) {
			// Root terms the principal may not read → refused. NO root terms (or
			// only unaddressable ones) → the hierarchy declares no entry point.
			if (rootTerms.refused > 0) pruned.refusedByAcl++;
			else pruned.droppedByConfig++;
			continue;
		}
		pruned.kept.push({ ...hierarchy, root_terms: rootTerms.kept });
	}
	return pruned;
}

/** The root terms whose section the principal may read (`readable`), and how many it may not. */
async function filterRootTermsByGrant<T extends { section_tipo?: unknown }>(
	rootTerms: readonly T[],
	readable: (sectionTipo: string) => Promise<boolean>,
): Promise<{ kept: T[]; refused: number }> {
	const kept: T[] = [];
	let refused = 0;
	for (const rootTerm of rootTerms) {
		if (typeof rootTerm.section_tipo !== 'string') continue;
		if (!(await readable(rootTerm.section_tipo))) {
			refused++;
			continue;
		}
		kept.push(rootTerm);
	}
	return { kept, refused };
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value !== '';
}

/**
 * Which refusal an EMPTY picker read gets (engineering/AREA_SPEC.md §5): every
 * candidate dropped by a permission check → `perm.denied`, which carries NO
 * sentence of its own here (naming the target sections the caller cannot reach
 * would tell them those sections exist; it is also the code the client
 * dispatches its "no permission" page on — never a 403 spelled as a generic
 * caller error). Otherwise the OTHER fact — the target declares no active
 * hierarchy — as `resource.conflict`, which is public, so the sentence that
 * tells the curator what to configure survives to the wire.
 */
function emptyPickerRefusal(pruned: PrunedHierarchies, areaTipo: string): DedaloError {
	if (pruned.refusedByAcl > 0 && pruned.droppedByConfig === 0) {
		return new DedaloError('perm.denied', { coordinates: { area_tipo: areaTipo } });
	}
	return new DedaloError('resource.conflict', {
		publicMessage: PICKER_NO_HIERARCHY_MESSAGE,
		coordinates: { area_tipo: areaTipo },
	});
}

/** The picker's tree scope (owner decision (i)), or null — no picker, or none granted. */
function treeScopeOf(picker: ResolvedPickerCaller | null): WriterChainScope | null {
	return picker?.treeScope ?? null;
}

/** The sections an SQO names (`section_tipo`: one tipo or a list), non-strings dropped. */
function sqoSectionsOf(sqo: Record<string, unknown>): string[] {
	const declared = sqo.section_tipo;
	const list = Array.isArray(declared) ? declared : [declared];
	return list.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

/**
 * A tree-area SEARCH confined to what the principal may read (owner decision
 * (i), W4b review): the client's `sqo.section_tipo` is client input, so each
 * named section is judged exactly as the hierarchy prune judges a hierarchy
 * (filterHierarchiesByGrant) — the section read grant (1), or, for a picker,
 * its tree scope's TARGETS. A section neither admits is dropped from the
 * search (the tree it would land in was pruned the same way); a search that
 * keeps NONE of the sections it named is refused (perm.denied), never run
 * against an empty list. The sections the scope alone opened are floored by
 * its writer component's filterPairs, EXCLUSIVELY (withScopedPairs). The
 * caller's SQO is never mutated (a clone is narrowed).
 */
async function confineTreeSearch(
	sqo: Record<string, unknown>,
	principal: Principal,
	pickerScope: WriterChainScope | null,
	areaModel: 'area_thesaurus' | 'area_ontology',
	areaTipo: string,
): Promise<{
	sqo: Record<string, unknown>;
	readFloor: ReadonlySet<string> | undefined;
	treeScope: WriterChainScope | null;
	/** The sections ONLY the scope admitted (scopeTreeSearchNodes reads it). */
	scoped: ReadonlySet<string>;
}> {
	// A tree scope opens THESAURUS targets only (the ontology area has no picker).
	const treeScope = areaModel === 'area_ontology' ? null : pickerScope;
	const named = sqoSectionsOf(sqo);
	const { kept, scoped } = await admittedTreeSearchSections(principal, named, treeScope);
	const confined = structuredClone(sqo);
	if (named.length > 0) {
		if (kept.length === 0) {
			throw new DedaloError('perm.denied', { coordinates: { area_tipo: areaTipo } });
		}
		confined.section_tipo = kept;
	}
	return { sqo: confined, readFloor: treeSearchFloor(treeScope, scoped), treeScope, scoped };
}

/** The named sections a tree search keeps (treeSearchAdmission), and those only the scope opened. */
async function admittedTreeSearchSections(
	principal: Principal,
	named: readonly string[],
	treeScope: WriterChainScope | null,
): Promise<{ kept: string[]; scoped: Set<string> }> {
	const kept: string[] = [];
	const scoped = new Set<string>();
	for (const sectionTipo of named) {
		const admission = await treeSearchAdmission(principal, sectionTipo, treeScope);
		if (admission === null) continue;
		kept.push(sectionTipo);
		if (admission === 'scoped') scoped.add(sectionTipo);
	}
	return { kept, scoped };
}

/**
 * How a tree search admits one of its sections: by the principal's read grant
 * ('granted'), ONLY through the picker's tree scope ('scoped'), or not at all.
 */
async function treeSearchAdmission(
	principal: Principal,
	sectionTipo: string,
	treeScope: WriterChainScope | null,
): Promise<'granted' | 'scoped' | null> {
	if ((await getPermissions(principal, sectionTipo, sectionTipo)) >= 1) return 'granted';
	if (treeScope !== null && scopeTargetsSection(treeScope, sectionTipo)) return 'scoped';
	return null;
}

/**
 * The NODES a picker's tree search answers (hits and their expanded
 * ancestors), judged exactly as the tree NODE doors judge a scoped children
 * page (ts_object/ts_api.ts scopedChildrenPage — owner decision (i), W4b
 * review): a node of a granted section passes untouched; a node of a section
 * the principal reads ONLY through the picker's tree scope is trimmed to its
 * writer component's shown pairs (ts_object.ts trimNodeToScopeColumns); a node
 * of a section NEITHER admits is DROPPED. The last case is real:
 * searchThesaurus expands every hit's ancestry across sections
 * (relations/parent.ts getParentsRecursive follows parent locators into ANY
 * section) and builds each ancestor level's full sibling list, with no section
 * gate — so a scoped hit could otherwise pull whole nodes of a third, ungranted
 * and untargeted section into the answer. No scope, or a search the scope
 * opened nothing for (every named section granted): untouched — the ordinary
 * search's PHP parity (only its sections are judged) holds. Exported for its
 * gate (subdatum_permission_native).
 */
export async function scopeTreeSearchNodes(
	found: SearchThesaurusResult,
	principal: Principal,
	treeScope: WriterChainScope | null,
	scoped: ReadonlySet<string>,
): Promise<SearchThesaurusResult> {
	if (treeScope === null || scoped.size === 0) return found;
	const { trimNodeToScopeColumns } = await import('../ts_object/ts_object.ts');
	const admissionOf = memoizedTreeAdmission(principal, treeScope);
	const result: TsNodeData[] = [];
	for (const node of found.result) {
		const admission = await admissionOf(node.section_tipo);
		if (admission === null) continue;
		result.push(
			admission === 'scoped' ? trimNodeToScopeColumns(node, treeScope.columnPairs) : node,
		);
	}
	return { ...found, result };
}

/** treeSearchAdmission memoized per section for one search answer (scopeTreeSearchNodes). */
function memoizedTreeAdmission(
	principal: Principal,
	treeScope: WriterChainScope,
): (sectionTipo: string) => Promise<'granted' | 'scoped' | null> {
	const admissions = new Map<string, Promise<'granted' | 'scoped' | null>>();
	return (sectionTipo) => {
		let admission = admissions.get(sectionTipo);
		if (admission === undefined) {
			admission = treeSearchAdmission(principal, sectionTipo, treeScope);
			admissions.set(sectionTipo, admission);
		}
		return admission;
	};
}

/** The read floor of a tree search: none without a scope; the scope's pairs, EXCLUSIVE on `scoped`, with one. */
function treeSearchFloor(
	treeScope: WriterChainScope | null,
	scoped: ReadonlySet<string>,
): ReadonlySet<string> | undefined {
	if (treeScope === null) return undefined;
	return withScopedPairs(undefined, { sections: scoped, filterPairs: treeScope.filterPairs });
}

/**
 * Thesaurus / ontology tree-area boot data (PHP area_thesaurus_json): the
 * active-hierarchies projection + typologies, per-hierarchy read-permission
 * filtered, with the optional pre-executed thesaurus search (ts_search).
 * Gate: read on the area tipo (the ontology area is gated before this by
 * canAccessOntologyArea; its hierarchies by plain ACL, no admin bypass).
 *
 * PICKER READS (engineering/AREA_SPEC.md §5): a read that declares `source.caller` is opening the
 * tree FOR a component instance. It gets, derived from that caller and from
 * nothing the request asserts: the thesaurus mode, the hierarchy narrowing, the
 * selection constraint, per-node selectability — and, when the result is empty,
 * an honest answer about WHY (403 refused vs 409 unconfigured) instead of the
 * empty tree PHP returned for both.
 */
async function readTreeArea(
	rqo: Rqo,
	principal: Principal,
	areaModel: 'area_thesaurus' | 'area_ontology',
): Promise<ApiResult> {
	const areaTipo = rqo.source?.tipo;
	if (areaTipo === undefined) {
		throw new DedaloError('request.invalid_source', {
			message: 'read: source.tipo is required',
		});
	}
	const level = await getPermissions(principal, areaTipo, areaTipo);
	if (level < 1 && !principal.isGlobalAdmin) {
		throw new DedaloError('perm.denied', { coordinates: { area_tipo: areaTipo } });
	}
	const lang = rqo.source?.lang ?? 'lg-spa';

	// THE PICKER CALLER (engineering/AREA_SPEC.md §5) — resolved from the
	// declaration alone; see resolveDeclaredPickerCaller.
	const picker = await resolveDeclaredPickerCaller(rqo, principal, lang);
	const treeScope = treeScopeOf(picker);

	// terms_are_model (PHP build_options->terms_are_model): the ontology model
	// view. The client sends it in source.build_options.
	const buildOptions = (rqo.source as { build_options?: { terms_are_model?: boolean } })
		?.build_options;
	const termsAreModel = buildOptions?.terms_are_model === true;
	// Hierarchy narrowing (engineering/AREA_SPEC.md §5): the caller's OWN resolved targets, not a
	// client-sent section list. Independent of the mode grant — which thesaurus
	// belongs to this caller does not depend on whether the principal may pick
	// from it.
	// Typology narrowing declared by the area's ddo (properties.hierarchy_types,
	// e.g. the cataloguing tool's area_thesaurus entry) — see
	// readDeclaredHierarchyTypeIds. Applied inside the tree read so the other
	// typologies are never loaded at all.
	const hierarchyTypeIds = readDeclaredHierarchyTypeIds(rqo, areaModel);
	const item = (await readAreaHierarchyData(
		areaModel,
		areaTipo,
		lang,
		termsAreModel,
		picker?.constraint?.targets ?? null,
		hierarchyTypeIds,
	)) as unknown as HierarchyBootItem;

	// Per-hierarchy read-permission filter (PHP area_thesaurus_json loop) —
	// see filterHierarchiesByGrant for the rule and the two drop counters.
	const pruned = await filterHierarchiesByGrant(
		item.value,
		principal,
		areaModel === 'area_ontology',
		treeScope,
	);
	const filteredValue = pruned.kept;
	// Rebuild typologies from the surviving hierarchies (dedup, first-seen).
	const survivingTypologyIds = new Set(filteredValue.map((h) => h.typology_section_id));
	item.value = filteredValue;
	item.typologies = item.typologies.filter((t) => survivingTypologyIds.has(t.section_id));

	// THE REFUSAL SPLIT (engineering/AREA_SPEC.md §5) — for CALLER-DECLARED reads only. An
	// ordinary browse read of an empty tree area keeps answering 200 with an
	// empty projection, which is the shape the frozen parity fixtures pin; a
	// picker that opens on nothing is a broken affordance and must say why.
	if (picker !== null && filteredValue.length === 0) {
		throw emptyPickerRefusal(pruned, areaTipo);
	}

	// Per-node link affordance, relation mode only (engineering/AREA_SPEC.md §5): the picker
	// renders the server's answer per term and re-derives nothing.
	if (picker?.mode === 'relation') {
		for (const hierarchy of filteredValue) {
			hierarchy.root_terms_selectable = await resolveRootTermSelectability(hierarchy.root_terms);
		}
	}

	// ts_search injection (PHP area_thesaurus_json): a client search request
	// (source.search_action==='search' with an rqo.sqo) or the area's pinned
	// properties.hierarchy_terms both pre-execute a thesaurus search.
	const { getNode } = await import('../ontology/resolver.ts');
	const areaProps = ((await getNode(areaTipo))?.properties ?? {}) as { hierarchy_terms?: unknown };
	const searchAction = (rqo.source as { search_action?: string })?.search_action;
	if (searchAction === 'search' && rqo.sqo !== undefined) {
		const { searchThesaurus } = await import('../ts_object/search.ts');
		// THE SEARCH'S SECTIONS ARE GATED like the tree's (confineTreeSearch):
		// a section the principal cannot read is never searched, and a picker's
		// TREE SCOPE (owner decision (i)) opens only its targets — floored by its
		// writer component's filterPairs, EXCLUSIVELY on the sections it opened
		// (security/read_floor.ts withScopedPairs).
		const confined = await confineTreeSearch(
			rqo.sqo as unknown as Record<string, unknown>,
			principal,
			treeScope,
			areaModel,
			areaTipo,
		);
		item.ts_search = await scopeTreeSearchNodes(
			await searchThesaurus(confined.sqo, principal, confined.readFloor),
			principal,
			confined.treeScope,
			confined.scoped,
		);
		// hierarchy_terms IS NOT READ FROM THE REQUEST, deliberately (engineering/AREA_SPEC.md §5).
		// PHP folded a `hierarchy_terms` URL var onto the page context, but the
		// client sends a DIFFERENT shape there (fixed_filter entries
		// {source:'hierarchy_terms',…}) from the HierarchyTerm[] this pinning
		// consumes, so folding it would wire a var nothing can read. Pinned
		// terms stay the AREA node's own property below; per-caller pinning, if
		// ever wanted, is derived from the caller's own fixed_filter
		// server-side, in its own change.
	} else if (Array.isArray(areaProps.hierarchy_terms) && areaProps.hierarchy_terms.length > 0) {
		const { searchThesaurus, getHierarchyTermsSqo } = await import('../ts_object/search.ts');
		// The pinned-terms shape is OWNED by getHierarchyTermsSqo (HierarchyTerm)
		// — referenced, never re-declared here, so the stored-locator tolerance
		// it documents has ONE definition (WC-2026-08-10-section-id-int-canonical).
		const sqo = getHierarchyTermsSqo(
			areaProps.hierarchy_terms as import('../ts_object/search.ts').HierarchyTerm[],
		);
		item.ts_search = await searchThesaurus(sqo, principal);
	}

	// Structure context (PHP area_thesaurus_json: get_structure_context + the
	// thesaurus_mode stamp). The client REQUIRES a non-empty context to render
	// the tree (area_thesaurus.js:547 guards on result.context.length).
	const context = await buildAreaContext(areaTipo, rqo.source?.mode ?? 'list', lang, level);
	if (context[0] !== undefined) {
		const entry = context[0] as { thesaurus_mode?: ThesaurusMode; picker?: PickerConstraint };
		// A caller-declared read gets the DERIVED mode and only that: the area
		// node's own thesaurus_mode is the install default for ordinary browse
		// reads and must not be able to grant a picker request a mode the
		// caller did not earn.
		entry.thesaurus_mode =
			picker !== null
				? picker.mode
				: ((areaProps as { thesaurus_mode?: ThesaurusMode }).thesaurus_mode ?? 'default');
		// The ONE constraint (selection_limit / remaining / targets), resolved by
		// the same module the write chokepoint re-resolves it with, so the
		// affordance the picker offers and the persistence the save allows are
		// literally the same value.
		if (picker?.mode === 'relation' && picker.constraint !== null) {
			entry.picker = picker.constraint;
		}
	}

	return {
		status: 200,
		body: ok({ context, data: [item] }, { requestId: currentRequestId() }),
	};
}
