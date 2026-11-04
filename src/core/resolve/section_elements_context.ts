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
import { getModelByTipo, getTranslatableByTipo } from '../ontology/resolver.ts';
import { resolveVirtualEditScope } from '../relations/request_config/implicit.ts';
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
	use_real_sections?: boolean;
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
		if (model.startsWith('component_')) elements.push({ tipo: row.tipo, model });
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

/** Strip the fields PHP omits from a simple context (tools, buttons). */
function toSimple(entry: StructureContextEntry): Record<string, unknown> {
	const { tools, buttons, ...rest } = entry as StructureContextEntry & {
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

	for (const sectionTipo of sectionTipos) {
		// Section-level permission (PHP section::get_section_permissions): capped
		// at read (1) for consultation-only sections so the client renders them
		// read-only. Component-level perms below stay uncapped (PHP parity).
		const sectionPerm = await getSectionPermissions(principal, sectionTipo);
		if (sectionPerm < 1) continue; // PHP skips unauthorized sections (not deny).

		const sectionEntry = await buildStructureContext({
			configFrom: { source: 'own', reason: 'search-panel-element' },
			tipo: sectionTipo,
			sectionTipo,
			mode: 'list',
			lang,
			permissions: sectionPerm,
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

		for (const { tipo, model } of [...ownElements, ...infoElements]) {
			if (exclude.has(model) || model === 'component_password') continue;
			// section-info elements are shown to global admins regardless of the
			// per-element ACL (PHP forces their permission to 1); everyone else gets
			// the normal gate, which for dd196's components denies them.
			const perm =
				infoTipos.has(tipo) && principal.isGlobalAdmin
					? 1
					: await getPermissions(principal, sectionTipo, tipo);
			if (perm < 1) continue;

			const isComponent = model.startsWith('component_');
			const translatable = isComponent ? await getTranslatableByTipo(tipo) : false;
			// PHP builds each COMPONENT in mode 'search' (class.common.php:3915-22 —
			// component_common::get_instance(…, 'search', …)) while the section and
			// groupers stay 'list' (:3811, :3928). Search mode is what stamps the
			// operator tooltip (search_operators_info / search_options_title) and, for
			// portals, resolves the search-mode source config rather than the list
			// section_list swap.
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
			if (entry === null) continue;
			const simple = toSimple(entry);

			// PHP top-level stamp: portal/dataframe/filter carry their target section.
			// component_filter's target is the FIXED projects section (dd153), an
			// ARRAY (PHP get_ar_target_section_tipo → ['dd153']); its request_config
			// has no sqo target so the generic resolver returns [].
			// The client (render_common.js:246) reads target_section_tipo[0] to drill
			// into the related section — it MUST be an ARRAY (the whole target set,
			// PHP get_ar_target_section_tipo), never a scalar string, or [0] indexes a
			// single character and requests a bogus 1-char section → empty list.
			if (model === 'component_filter') {
				simple.target_section_tipo = ['dd153']; // DEDALO_SECTION_PROJECTS_TIPO
			} else if (model === 'component_portal' || model === 'component_dataframe') {
				const { getElementTargetSectionTipos } = await import(
					'../relations/request_config/build.ts'
				);
				simple.target_section_tipo = await getElementTargetSectionTipos(tipo, sectionTipo);
			}
			contexts.push(simple);
		}
	}
	return contexts;
}
