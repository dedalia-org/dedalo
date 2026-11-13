/**
 * get_section_elements_context (PHP dd_core_api::get_section_elements_context →
 * common::get_section_elements_context). The flattened "simple" structure-context
 * list the edit-mode search-filter panel iterates: the section's own context plus
 * one per included component/grouper.
 *
 * A "simple" context (PHP context_type:'simple' → get_structure_context_simple)
 * is a FULL structure context MINUS `tools`, `buttons`, and `request_config`. We
 * reuse buildStructureContext (with addRequestConfig:false so request_config is
 * omitted) and strip tools/buttons post-build.
 *
 * MODE: the section and its groupers are built in mode 'list'; each COMPONENT is
 * built in mode 'search' (PHP class.common.php:3811/3915-22/3928) — that is what
 * makes each component carry its search-operator tooltip
 * (search_operators_info / search_options_title).
 *
 * SECURITY: skip_permissions from the client is IGNORED — permissions are always
 * enforced server-side (PHP hard-forces skip_permissions=false in the action).
 * Per-section and per-element read gates (<1 → skipped, not denied) mirror PHP.
 */

import { logSectionSuppressesSectionInfo } from '../concepts/section.ts';
import { sql } from '../db/postgres.ts';
import { labelByTipo } from '../ontology/labels.ts';
import {
	getModelByTipo,
	getSectionRealTipo,
	getTranslatableByTipo,
	isUnimplementedComponentModel,
} from '../ontology/resolver.ts';
import { resolveVirtualEditScope } from '../ontology/virtual_scope.ts';
import { getPermissions, getSectionPermissions, type Principal } from '../security/permissions.ts';
import { currentDataLang } from './request_lang.ts';
import { buildStructureContext, type StructureContextEntry } from './structure_context.ts';

/** PHP default ar_components_exclude (class.common.php:3729) + section_tab. */
const DEFAULT_EXCLUDE: ReadonlySet<string> = new Set([
	'component_3d',
	'component_av',
	'component_image',
	'component_pdf',
	'component_password',
	'component_security_access',
	'component_geolocation',
	'component_info',
	'component_inverse',
	'section_tab',
]);

export interface SectionElementsContextOptions {
	ar_section_tipo?: string | string[];
	context_type?: string;
	ar_components_exclude?: string[];
	/**
	 * `true` (exact, PHP `=== true`): the requested sections are grouped by REAL
	 * section (getSectionRealTipo) and ONE block is built per family, on the
	 * real tipo — the thesaurus / ontology search panels (every active
	 * hierarchy is a virtual section over hierarchy20) list each field once,
	 * not once per hierarchy. See elementFamilies.
	 */
	use_real_sections?: boolean;
}

/**
 * One block of the element list: the section it is BUILT on and the requested
 * (readable) members it stands for — itself alone without `use_real_sections`,
 * every readable virtual sibling of one real section with it.
 */
interface ElementFamily {
	/** The section whose elements are listed (the real tipo under use_real_sections). */
	built: string;
	/** The readable requested sections of the family, request order. */
	members: string[];
	/** The HIGHEST section grant among the members (section::get_section_permissions). */
	sectionPerm: number;
}

/** Grouper models included alongside components (PHP ar_include_elements). */
const INCLUDE_GROUPER_MODELS: ReadonlySet<string> = new Set([
	'section_group',
	'section_group_div',
	'section_tab',
]);

/**
 * Every component/grouper tipo in a section's ontology subtree, in DEPTH-FIRST
 * ONTOLOGY ORDER (PHP section::get_ar_children_tipo_by_model_name_in_section,
 * recursive=true, resolve_virtual=true).
 *
 * Two behaviours the client depends on:
 *  - ORDER: pre-order DFS by `order_number` — a grouper is emitted immediately
 *    before the components it contains, so the client can nest each component
 *    under the PRECEDING grouper (a flat groups-then-components list breaks the
 *    grouping and the components "disappear" from their section_group).
 *  - VIRTUAL sections: a virtual section (its node's relations[0].tipo points at
 *    a real section) borrows the REAL section's elements MINUS the tipos named by
 *    its FIRST exclude_elements child. A plain `WHERE parent = sectionTipo` walk
 *    returns nothing for a virtual section — its own children are only
 *    exclude_elements/section_list/buttons.
 */
async function elementTiposInSection(
	sectionTipo: string,
): Promise<{ tipo: string; model: string }[]> {
	const { realTipo, excludeSet } = await resolveVirtualEditScope(sectionTipo);
	const collected: { tipo: string; model: string }[] = [];

	const walk = async (parentTipo: string): Promise<void> => {
		const rows = (await sql`
			SELECT tipo, model FROM dd_ontology
			WHERE parent = ${parentTipo}
			ORDER BY order_number NULLS LAST, id
		`) as { tipo: string; model: string | null }[];
		for (const row of rows) {
			// An excluded tipo (virtual exclude_elements) is skipped AND not recursed
			// into — dropping a grouper drops its whole subtree, matching PHP.
			if (excludeSet.has(row.tipo)) continue;
			// The RAW ontology model distinguishes a section_group_div (getModelByTipo
			// canonicalizes div→section_group, matching PHP get_model_by_tipo(_,true)).
			const rawModel = row.model ?? '';
			const model = (await getModelByTipo(row.tipo)) ?? rawModel;
			const isComponent = model.startsWith('component_');
			const isGrouper = INCLUDE_GROUPER_MODELS.has(model) || rawModel === 'section_group_div';
			// Only components/groupers are collected and recursed into; sections and
			// areas are neither, so the walk never crosses into a child section.
			if (!isComponent && !isGrouper) continue;
			// An unimplemented model (no descriptor: v5 dead name or unported) is
			// neither collected nor recursed into — the client has no module for it
			// (T1-27; PHP $ar_temp_exclude_models + the semantic_node subtree rule).
			if (isUnimplementedComponentModel(model)) continue;
			// A section_group_div is a layout-only wrapper: PHP recurses THROUGH it
			// (its children belong to the enclosing grouper) but never emits it as a
			// context entry (:3890-3894 skips on the section_group_div legacy model).
			// Recurse in, but do not collect it.
			if (rawModel !== 'section_group_div') collected.push({ tipo: row.tipo, model });
			await walk(row.tipo);
		}
	};
	await walk(realTipo);
	return collected;
}

/** section_info group (dd196) — appended to every non-TM section (PHP :3768). */
const SECTION_INFO_GROUP_TIPO = 'dd196';

// WC-045's set now lives in concepts/section.ts LOG_SECTION_POLICY, beside the
// sort policy that shares its cause: an append-only log has no editorial
// metadata to search on. It had already drifted as a local literal — dd542 was
// listed, dd15's identical need was an unnoticed omission for months.

/**
 * The common section-info elements PHP appends to every section's element list:
 * the dd196 section_group + its component children (in ontology order). Shown
 * only to global admins (PHP :3870-3877 forces their permission, so non-admins
 * fall through to their real — insufficient — permission and are skipped).
 */
async function sectionInfoElements(): Promise<{ tipo: string; model: string }[]> {
	const children = (await sql`
		SELECT tipo, model FROM dd_ontology
		WHERE parent = ${SECTION_INFO_GROUP_TIPO}
		ORDER BY order_number NULLS LAST, id
	`) as { tipo: string; model: string | null }[];
	const elements: { tipo: string; model: string }[] = [
		{ tipo: SECTION_INFO_GROUP_TIPO, model: 'section_group' },
	];
	for (const row of children) {
		const model = (await getModelByTipo(row.tipo)) ?? row.model ?? '';
		if (model.startsWith('component_') && !isUnimplementedComponentModel(model)) {
			elements.push({ tipo: row.tipo, model });
		}
	}
	return elements;
}

/**
 * The common section-info COMPONENTS a section carries (dd196's component
 * children, ontology order, the dd196 grouper itself NOT included), or [] for a
 * section that suppresses the group (logSectionSuppressesSectionInfo: dd542,
 * dd15). THE one source for every consumer that lists a section's columns
 * beside its own components (tool_import_dedalo_csv's mapper + preflight) —
 * the same set buildSectionElementsContext appends, so the two cannot drift.
 *
 * It does NOT apply the "only when the section has own elements" rule nor any
 * permission: both are the caller's (see buildSectionElementsContext), because
 * what "own elements" means differs per caller.
 */
export async function sectionInfoComponents(
	sectionTipo: string,
): Promise<{ tipo: string; model: string }[]> {
	if (logSectionSuppressesSectionInfo(sectionTipo)) return [];
	return (await sectionInfoElements()).filter(
		(element) => element.tipo !== SECTION_INFO_GROUP_TIPO,
	);
}

/** One family of a multi-target relation's targets (see groupTargetSections). */
export interface TargetSectionGroup {
	/** The REAL section the members share (a real target is its own group). */
	tipo: string;
	label: string | null;
	/** The readable targets of the family, in the relation's target order. */
	members: { tipo: string; label: string | null }[];
}

/**
 * Group a relation's target sections by REAL section (getSectionRealTipo):
 * virtual siblings (es1, fr1, … → hierarchy20) share their component tipos,
 * so ONE field list serves the whole family, while a real target with its own
 * components (tchi1) is a family of its own. Groups keep first-seen order.
 *
 * A member the principal may not read (section grant < 1) is OMITTED — the
 * same "skipped, not denied" reading the element list applies to a section;
 * a family left with no member is omitted whole. This is a picker hint only:
 * the export re-authorizes every target it actually crosses (resolver.ts
 * assertExportCrossing), so the list grants nothing.
 */
export async function groupTargetSections(
	principal: Principal,
	targets: readonly string[],
): Promise<TargetSectionGroup[]> {
	const groups = new Map<string, TargetSectionGroup>();
	const seen = new Set<string>();
	for (const target of targets) {
		if (!isFirstSighting(target, seen)) continue;
		if ((await getSectionPermissions(principal, target)) < 1) continue;
		const group = await familyGroup(groups, await getSectionRealTipo(target));
		group.members.push({ tipo: target, label: await labelByTipo(target) });
	}
	return [...groups.values()];
}

/**
 * Is `target` a usable target seen for the first time? (non-empty string, not
 * yet in `seen`) — records it in `seen` when so.
 */
function isFirstSighting(target: unknown, seen: Set<string>): target is string {
	if (typeof target !== 'string' || target === '' || seen.has(target)) return false;
	seen.add(target);
	return true;
}

/** The group of the real section `realTipo`, created (labelled, empty) on first use. */
async function familyGroup(
	groups: Map<string, TargetSectionGroup>,
	realTipo: string,
): Promise<TargetSectionGroup> {
	const existing = groups.get(realTipo);
	if (existing !== undefined) return existing;
	const group: TargetSectionGroup = {
		tipo: realTipo,
		label: await labelByTipo(realTipo),
		members: [],
	};
	groups.set(realTipo, group);
	return group;
}

/**
 * The relation-target stamp of one element's simple context (mutates `simple`):
 * `target_section_tipo` (portal / dataframe / filter) and, for a MULTI-target
 * relation, `target_section_groups` (see groupTargetSections).
 */
async function stampTargetSections(
	simple: Record<string, unknown>,
	element: { model: string; tipo: string; sectionTipo: string; principal: Principal },
): Promise<void> {
	const { model, tipo, sectionTipo, principal } = element;
	// PHP top-level stamp: portal/dataframe/filter carry their target section.
	// component_filter's target is the FIXED projects section (dd153), an
	// ARRAY (PHP get_ar_target_section_tipo → ['dd153']); its request_config
	// has no sqo target so the generic resolver returns [].
	// The client (render_common.js get_target_choices) drills into every
	// entry of target_section_tipo — it MUST be an ARRAY (the whole target
	// set, PHP get_ar_target_section_tipo), never a scalar string, or the
	// client would iterate its characters as bogus 1-char sections.
	if (model === 'component_filter') {
		simple.target_section_tipo = ['dd153']; // DEDALO_SECTION_PROJECTS_TIPO
	} else if (model === 'component_portal' || model === 'component_dataframe') {
		const { getElementTargetSectionTipos } = await import('../relations/request_config/build.ts');
		simple.target_section_tipo = await getElementTargetSectionTipos(tipo, sectionTipo);
	}
	// A MULTI-TARGET relation (tch199 → every toponymy + tchi1): the
	// field pickers (tool_export, search) need to offer every target,
	// not `[0]` — WC-2026-11-11-section-elements-target-groups.
	const targets = simple.target_section_tipo;
	if (Array.isArray(targets) && targets.length > 1) {
		simple.target_section_groups = await groupTargetSections(principal, targets as string[]);
	}
}

/**
 * Strip the fields PHP omits from a simple context (tools, buttons, add_label —
 * PHP builds these via get_structure_context_simple, class.common.php:3951,
 * never section_group_json.php, the only add_label emitter).
 */
function toSimple(entry: StructureContextEntry): Record<string, unknown> {
	const { tools, buttons, add_label, ...rest } = entry as StructureContextEntry & {
		tools?: unknown;
		buttons?: unknown;
	};
	return rest as Record<string, unknown>;
}

/**
 * Build the simple structure-context list for one or more sections. Returns the
 * section context first, then each permitted component/grouper, per section.
 */
export async function buildSectionElementsContext(
	principal: Principal,
	options: SectionElementsContextOptions,
): Promise<Record<string, unknown>[]> {
	const sectionTipos = Array.isArray(options.ar_section_tipo)
		? options.ar_section_tipo
		: options.ar_section_tipo
			? [options.ar_section_tipo]
			: [];
	// PHP `$options->ar_components_exclude ?? [default]` — a client-SENT list
	// REPLACES the default (even an empty [] — tool_update_cache sends [] to get
	// every component); the default applies only when the option is absent. Do
	// not merge: tool_export sends ['component_password'] and PHP-era exports
	// offered the media components (image/av/pdf/…) as columns.
	// component_password stays hard-skipped below regardless of this list.
	const exclude = new Set<string>(options.ar_components_exclude ?? DEFAULT_EXCLUDE);
	const lang = currentDataLang();
	const contexts: Record<string, unknown>[] = [];
	const families = await elementFamilies(
		principal,
		sectionTipos,
		options.use_real_sections === true,
	);
	for (const family of families) {
		contexts.push(...(await sectionBlock(principal, family, exclude, lang)));
	}
	return contexts;
}

/**
 * The blocks to build for the requested sections (PHP class.common.php
 * :3789-3808 order): the section read gate FIRST — a member the principal may
 * not read is skipped (not denied) BEFORE any grouping, so an unreadable
 * sibling never claims its family — then, under `use_real_sections`, grouping
 * by REAL section in first-seen order (PHP `section_real_tipo` + `continue` on
 * an already-resolved real). Without the flag every requested tipo is its own
 * block, repeats included (unchanged shape).
 */
async function elementFamilies(
	principal: Principal,
	sectionTipos: readonly string[],
	useRealSections: boolean,
): Promise<ElementFamily[]> {
	const families = new Map<string, ElementFamily>();
	for (const sectionTipo of sectionTipos) {
		// Section-level permission (PHP section::get_section_permissions): capped
		// at read (1) for consultation-only sections so the client renders them
		// read-only. Component-level perms stay uncapped (PHP parity).
		const sectionPerm = await getSectionPermissions(principal, sectionTipo);
		if (sectionPerm < 1) continue; // PHP skips unauthorized sections (not deny).
		if (!useRealSections) {
			families.set(`${families.size}\u0000${sectionTipo}`, {
				built: sectionTipo,
				members: [sectionTipo],
				sectionPerm,
			});
			continue;
		}
		const real = await getSectionRealTipo(sectionTipo);
		const family = families.get(real) ?? { built: real, members: [], sectionPerm: 0 };
		family.members.push(sectionTipo);
		family.sectionPerm = Math.max(family.sectionPerm, sectionPerm);
		families.set(real, family);
	}
	return [...families.values()];
}

/**
 * THE ELEMENT GRANT of a family: the HIGHEST level any readable member holds
 * on `tipo` (owner C34 2026-11-13, T1-27 D1 ruled (b), order-independent —
 * WC-2026-11-13-use-real-sections-highest-grant). PHP read the FIRST readable
 * requested member's grant (`$base_section_tipo`), so a field granted only in
 * the second hierarchy was hidden when the first came first. Matches the
 * search engine's per-row `some` verdict (conform.ts rootVerdict): nothing
 * offered here is unfilterable, and the list grants nothing — every read
 * re-keys per record. Section-info elements (dd196's children) are forced
 * readable for global admins (PHP :3870-3877) and gated normally for everyone
 * else, which for dd196's components denies them.
 */
async function familyElementGrant(
	principal: Principal,
	family: ElementFamily,
	tipo: string,
	isInfoElement: boolean,
): Promise<number> {
	if (isInfoElement && principal.isGlobalAdmin) return 1;
	let highest = 0;
	for (const member of family.members) {
		highest = Math.max(highest, await getPermissions(principal, member, tipo));
	}
	return highest;
}

/**
 * One block: the section entry, then each permitted element of the BUILT
 * section (its own elements, virtual-aware, DFS order; then the common
 * section-info elements). Under `use_real_sections` the built section is the
 * REAL one, so a virtual member's exclude_elements are NOT applied and every
 * entry carries the real tipo as `section_tipo` / `parent` (PHP: section
 * instance, children walk and element instances all on the real tipo).
 */
async function sectionBlock(
	principal: Principal,
	family: ElementFamily,
	exclude: ReadonlySet<string>,
	lang: string,
): Promise<Record<string, unknown>[]> {
	const sectionTipo = family.built;
	const contexts: Record<string, unknown>[] = [];
	const sectionEntry = await buildStructureContext({
		configFrom: { source: 'own', reason: 'search-panel-element' },
		tipo: sectionTipo,
		sectionTipo,
		mode: 'list',
		lang,
		permissions: family.sectionPerm,
		addRequestConfig: false,
		principal,
	});
	if (sectionEntry !== null) contexts.push(toSimple(sectionEntry));

	// The section's own elements (virtual-aware, DFS order), THEN the common
	// section-info elements (dd196 + children) — but only when the section has
	// elements of its own (PHP :3847 appends them only if ar_elements non-empty).
	const ownElements = await elementTiposInSection(sectionTipo);
	// WC-045: dd542 (and any SUPPRESS_SECTION_INFO section) omits the whole
	// section-info group; dd196's children live only under dd196, never in
	// ownElements, so skipping the append fully removes them.
	const suppressInfo = logSectionSuppressesSectionInfo(sectionTipo);
	const infoElements = ownElements.length > 0 && !suppressInfo ? await sectionInfoElements() : [];
	const infoTipos = new Set(infoElements.map((element) => element.tipo));
	const elements = [...ownElements, ...infoElements].filter(
		({ model }) => !exclude.has(model) && model !== 'component_password',
	);
	contexts.push(...(await blockElements(principal, family, elements, infoTipos, lang)));
	return contexts;
}

/** The permitted elements of one block, each as its simple context. */
async function blockElements(
	principal: Principal,
	family: ElementFamily,
	elements: readonly { tipo: string; model: string }[],
	infoTipos: ReadonlySet<string>,
	lang: string,
): Promise<Record<string, unknown>[]> {
	const contexts: Record<string, unknown>[] = [];
	for (const { tipo, model } of elements) {
		const perm = await familyElementGrant(principal, family, tipo, infoTipos.has(tipo));
		if (perm < 1) continue;
		const simple = await elementSimpleContext(principal, {
			tipo,
			model,
			sectionTipo: family.built,
			perm,
			lang,
		});
		if (simple !== null) contexts.push(simple);
	}
	return contexts;
}

/**
 * One element's simple context, target sections stamped. PHP builds each
 * COMPONENT in mode 'search' (class.common.php:3915-22 —
 * component_common::get_instance(…, 'search', …)) while the section and
 * groupers stay 'list' (:3811, :3928). Search mode is what stamps the operator
 * tooltip (search_operators_info / search_options_title) and, for portals,
 * resolves the search-mode source config rather than the list section_list swap.
 */
async function elementSimpleContext(
	principal: Principal,
	element: { tipo: string; model: string; sectionTipo: string; perm: number; lang: string },
): Promise<Record<string, unknown> | null> {
	const { tipo, model, sectionTipo, perm, lang } = element;
	const isComponent = model.startsWith('component_');
	const translatable = isComponent ? await getTranslatableByTipo(tipo) : false;
	const entry = await buildStructureContext({
		configFrom: { source: 'own', reason: 'search-panel-element' },
		tipo,
		sectionTipo,
		mode: isComponent ? 'search' : 'list',
		lang: translatable ? lang : 'lg-nolan',
		permissions: perm,
		addRequestConfig: false,
		principal,
	});
	if (entry === null) return null;
	const simple = toSimple(entry);
	await stampTargetSections(simple, { model, tipo, sectionTipo, principal });
	return simple;
}
