/**
 * STRUCTURE-CONTEXT builder — the ontology-derived "Context" half of the
 * context/data duality (spec §3.7).
 *
 * PHP references: common::build_structure_context_core (class.common.php:1739,
 * cached core), build_structure_context (:1624, per-call stamping),
 * get_view (:4464), resolve_view (:4520).
 *
 * Architecture (the PHP core/stamp split, kept verbatim; header re-dated
 * 2026-07-07, S2-45 — the old "v0 defers tools/buttons/columns_map/
 * request_config/section_map" UNCOVERED list described a state that no
 * longer exists; coverage-state lists live in rewrite/STATUS.md, never here):
 * - the CORE holds only structural identity (same for every request):
 *   label, tipo, section_tipo, model, legacy_model, parent_grouper, mode,
 *   translatable, properties, css. Cached by (tipo, section_tipo, mode) and
 *   hub-registered for ontology invalidation. The core deliberately carries
 *   NO user-dependent values: tools, buttons, section_map, request_config and
 *   columns_map are all filled at STAMP time per call (tools via
 *   tools/registry getElementTools; section extras — buttons, section_map,
 *   matrix_table — via section/context.ts stampSectionContext; request_config
 *   + columns_map via relations/request_config/build.ts), so the cache key
 *   needs no user dimension.
 * - the STAMP is applied on a CLONE per call: permissions, parent, lang, view.
 *   The cache entry is never handed out by reference (PHP :1644 rule); the
 *   clone is deep for `properties` (callers mutate nested show_interface).
 */

import { config } from '../../config/config.ts';
import { publishApiConfig } from '../../external/api/index.ts';
import { getComponentModel, getRenderClass } from '../components/registry.ts';
import type { RenderClass } from '../components/types.ts';
import { isAreaModel } from '../concepts/area.ts';
import {
	isConsultationOnlySection,
	isGrouperModel,
	logSectionColumnIsSortable,
} from '../concepts/section.ts';
import { resolveDataTipo } from '../ontology/alias.ts';
import { createOntologyCache } from '../ontology/cache_factory.ts';
import { registerOntologyCacheClearer } from '../ontology/cache_invalidation.ts';
import { labelByTipo } from '../ontology/labels.ts';
import { ONTOLOGY_TLD } from '../ontology/ontology_tipos.ts';
import {
	getColumnNameByModel,
	getModelByTipo,
	getNode,
	getTranslatableByTipo,
} from '../ontology/resolver.ts';
import { requiredOntologyTld } from '../ontology/tld.ts';
import { type DataframeDeletePolicy, dataframeDeletePolicyOf } from '../relations/dataframe.ts';
import { stampSectionContext } from '../section/context.ts';
import type { Principal } from '../security/permissions.ts';
import { currentApplicationLang } from './request_lang.ts';

/** The cached structural CORE (request-invariant fields). */
export interface StructureContextCore {
	label: string | null;
	tipo: string;
	section_tipo: string;
	model: string;
	legacy_model: string | null;
	parent_grouper: string | null;
	mode: string;
	translatable: boolean;
	properties: unknown;
	css: unknown;
	tools: unknown[];
	buttons: unknown[];
	sortable: boolean;
	/**
	 * The value's render class at the client DOM boundary (descriptor `render`
	 * facet, WC-2026-09-04-context-render-class) — ADDITIVE wire key, present
	 * on COMPONENT entries only (sections/groupers/areas carry no value). The
	 * client's ONE escaper (render_escape.js render_value) switches on it.
	 */
	render_class?: RenderClass;
	/**
	 * The slot's resolved delete policy (dataframeDeletePolicyOf, ONE reader —
	 * WC-2026-09-06-dataframe-delete-policy-on-slot, hard value retired by
	 * WC-2026-09-29-dataframe-hard-delete-retired) — ADDITIVE wire key,
	 * `'unlink' | 'delete_target'`, present on `component_dataframe` entries
	 * only. The client never re-reads the ontology properties, so the two
	 * sides cannot disagree on what a spelling means.
	 */
	delete_policy?: DataframeDeletePolicy;
}

/**
 * Core + build-time internals that must NEVER be emitted on the wire. The stamp
 * step destructures the internal fields OUT before spreading the core into the
 * wire entry (a plain `{...core}` spread would leak them).
 */
interface StructureContextCoreInternal extends StructureContextCore {
	/**
	 * The request_config SOURCE properties (PHP trait resolve_source_properties,
	 * trait.request_config_utils.php:264-309 — "Site B"): the list/tm/
	 * list_thesaurus section_list swap that feeds ONLY the request_config /
	 * columns_map build at stamp time. DISTINCT from the EMITTED `properties`
	 * (PHP build_structure_context_core :1801-1846 — "Site A",
	 * resolveEmittedPropertiesAndCss): PHP resolves the two independently and
	 * they disagree — e.g. a tm-mode section emits its OWN properties/css while
	 * its request_config still comes from the section_list child.
	 */
	configSourceProperties: unknown;
	/**
	 * The element's OWN (alias-resolved) properties, pre-Site-B swap. PHP
	 * common::get_columns_map (class.common.php:4339-4374) reads
	 * `$this->get_properties()` and does its OWN section_list lookup for
	 * list/tm — it never sees resolve_source_properties' output. Feeding it the
	 * SWAPPED properties instead makes list_thesaurus (and any other swapped
	 * mode PHP leaves alone) inherit the section_list_thesaurus child's
	 * source.columns_map, which collapses distinct list columns into the
	 * configured ones and leaves the header row short of the rendered cells
	 * (rsc197: Nombre+Apellidos share column 'a' → no Apellidos header).
	 * INTERNAL: destructured out at stamp, never on the wire.
	 */
	ownConfigProperties: unknown;
	/**
	 * PHP common::get_view minus the per-call ddo_map injection (:4464-4506):
	 * list-mode section_list-child view preference, then the element's OWN
	 * properties.view — resolved against the ontology, NOT the Site-A swapped
	 * properties. Consumed by the stamp's `view` field; never emitted itself.
	 */
	structuralView: string | null;
}

/** A stamped context entry as the API emits it (core + per-call stamps). */
export interface StructureContextEntry extends StructureContextCore {
	/** Wire-object marker (PHP dd_object) — every context entry is a 'ddo'. */
	typo: 'ddo';
	/** Element family — the client keys wrapper classes/behavior on it. */
	type: string;
	permissions: number;
	parent: string | null;
	lang: string;
	view: string | null;
	/** View imposed on the section_record children this element builds (PHP
	 * get_children_view) — null when the element imposes none. */
	children_view: string | null;
	/** Parsed request_config items — ABSENT when addRequestConfig=false (PHP omits). */
	request_config?: unknown[] | null;
	/** component_filter only: the projects target descriptors (PHP
	 * component_filter_json :117-123 — [{tipo:'dd153', label}]; the client's
	 * filter edit buttons iterate them). */
	target_sections?: { tipo: string; label: string | null }[];
	/** Base columns_map (PHP :1679) — present only alongside a request_config. */
	columns_map?: unknown[];
	/** Section-only extras (PHP :2056-2100). */
	matrix_table?: string | null;
	/** Section-only principal-gated relation_list_tipo (PHP :2056-2100,
	 * WC-2026-10-27-relation-list-grant-stamp) and time_machine_list trigger
	 * (WC-2026-10-22-tm-scope-whole-request); search-mode
	 * parent_grouper_label on any element with a parent grouper (PHP :1700). */
	config?: {
		relation_list_tipo?: string | null;
		time_machine_list?: string | null;
		parent_grouper_label?: string | null;
	};
	/** Section-only: the section_map node's properties (PHP :2075). */
	section_map?: unknown;
	/** Section-only: the session-stored navigation SQO (PHP :1695-98, stamped
	 * per call — null when the session holds none). */
	sqo_session?: unknown;
	/** Media components only: the upload/quality descriptor (PHP context->features). */
	features?: unknown;
	/** component_text_area edit only (PHP component_text_area_json.php:36-81):
	 * the server-gated CKEditor toolbar extras (button_person/button_note/
	 * reference/button_draw/button_geo) the client appends to the base toolbar.
	 * Property-gated (tags_persons/tags_notes/…); `[]` when none apply — PHP
	 * emits the empty array in edit mode too. See WC-066 for the note-gating
	 * divergence. */
	toolbar_buttons?: string[];
	/** component_section_id only: the parent section's display colour (PHP
	 * component_section_id_json.php default branch, ontology_node::get_color →
	 * section properties.color ?? '#b9b9b9'). The client paints it as the wrapper
	 * background on both idle and .active states. */
	color?: string;
	/** Search-mode components only (PHP class.common.php:2010-2013): the operator
	 * tooltip the client renders under a selected search component. Both are
	 * stamped for EVERY component built in 'search' mode — `search_operators_info`
	 * is the ordered {operator → label-key} map (or `[]` when the model has none)
	 * and `search_options_title` is the rendered tooltip HTML (or ''). The client
	 * only reads the title (common/js/ui.js build_wrapper_search). */
	search_operators_info?: Record<string, string> | never[];
	search_options_title?: string;
	/** Sortable component ddos only (PHP build_structure_context :1683): the
	 * ORDER-BY descriptor the client turns into an sqo.order on a list-header
	 * click. Present only when `sortable === true` and the entry carries a
	 * request_config context (else PHP emits []). */
	path?: unknown[];
	/** section_tab groupers only (no PHP oracle — v7-native element): the ordered
	 * tab descriptors the client turns into the tab-label bar
	 * (render_section_tab.js:139-172 reads `context.children`, one clickable label
	 * per entry). Derived in section/read.ts from the sibling entries parented to
	 * this grouper, so the tabs exactly match the panels that will render. ABSENT
	 * for every other model; the client only reads it in the section_tab view. */
	children?: { tipo: string; label: string | null }[];
	/** dd15 only, on a ONE-COMPONENT history read (read_tm.ts tmMainLaneLaw):
	 * the scoped main's lane law — `lang_sliced` false ⇒ one lg-nolan lane
	 * (every relation model, whatever its `translatable` flag). The
	 * tool_time_machine client hides its language selector and words its
	 * restore confirm from it. ABSENT on every other read. */
	tm_main?: { tipo: string; lang_sliced: boolean };
	/** PER-RECORD context options (PHP context->options). Today one producer:
	 * component_text_area edit contexts carry `related_component_lang` — the
	 * record's original language resolved from its related component_select_lang
	 * (rsc263 "Original language") — which the transcription/indexation/lang
	 * tools use to open the component in the interview's own language. STAMPED
	 * per call in section/read.ts (buildGetDataContext / the readSection ddo
	 * loop), NEVER in the cached structural core: the value is record data, and
	 * the core is shared across records. ABSENT when the ontology declares no
	 * related select_lang or the record holds no value (the PHP wire shape). */
	options?: Record<string, unknown>;
}

/**
 * Cached structural cores, keyed `applicationLang_tipo_sectionTipo_mode` (the
 * core bakes the localized `label`, so lang is in the key — see buildCore). The
 * core is USER-INDEPENDENT: per-user data (`permissions`) is applied on the
 * per-call stamp (`StructureContextEntry`), never cached here.
 *
 * INVARIANT (spec §4 request isolation): if any field on `StructureContextCore`
 * ever becomes user/permission-dependent — notably `tools`/`buttons`, today
 * ontology-derived — this key MUST gain a user dimension, or one user's core
 * would bleed to another in the long-lived process. The concurrency interleave
 * test pins per-user permission stamping against this cached core.
 */
const coreCache = createOntologyCache<string, StructureContextCoreInternal>();

export function clearStructureContextCache(): void {
	coreCache.clear();
}
registerOntologyCacheClearer(clearStructureContextCache);

/**
 * Element family for the context `type` marker (PHP dd_object::
 * resolve_type_from_model, class.dd_object.php:2162). The CLIENT keys wrapper
 * CSS and structural behavior on this — notably groupers must be type 'grouper'
 * (the edit view nests components into a grouper only when
 * parent_instance.type === 'grouper', view_default_edit_section_record.js:218).
 */
/** PHP DEDALO_NOTES_TEXT_TIPO (dd_tipos.php:218) — the TM notes-text component;
 * the ONE per-tipo exception to component_common::get_sortable() (returns false
 * regardless of model, class.component_common.php:4716). */
const NOTES_TEXT_TIPO = 'rsc329';

/**
 * PHP get_sortable() resolved for a structure-context element (whether a list
 * column of this element may carry a sort icon). Non-component models are never
 * sortable (dd_object::get_sortable() → null → false). For components the base
 * (component_common) is TRUE; the descriptor's `sortable:false` marks the
 * canonical models that override to false (media/relation_common/geolocation/
 * info/security_access). `model` here is already the CANONICAL model
 * (getModelByTipo followed the alias), so state/calculation resolve to
 * component_info (false) and autocomplete/security_tools to their sortable
 * targets. The single per-TIPO exception is the notes-text tipo.
 */
function resolveSortable(model: string, tipo: string, sectionTipo: string): boolean {
	if (!model.startsWith('component_')) return false;
	if (tipo === NOTES_TEXT_TIPO) return false;
	// APPEND-ONLY LOGS (dd542 Activity, dd15 Time Machine): only the columns an
	// index actually serves may advertise a sort. The two have DIFFERENT causes —
	// dd542's values are jsonb (WC-044), dd15's are physical columns whose sort
	// loses to index DIRECTION (WC-053) — and both, with their measurements, are
	// declared in ONE place: concepts/section.ts LOG_SECTION_POLICY. Columns
	// outside dd15's TM_ORDER_COLUMN entirely (the section's own components in
	// the record-snapshot list) land here too; they used to THROW on click.
	if (!logSectionColumnIsSortable(sectionTipo, tipo)) return false;
	return getComponentModel(model)?.sortable ?? true;
}

function elementTypeOf(model: string): string {
	if (model.startsWith('component_') || model.startsWith('field_')) return 'component';
	if (model === 'section') return 'section';
	if (model === 'relation_list') return 'relation_list';
	if (isGrouperModel(model)) return 'grouper';
	if (model.startsWith('button')) return 'button';
	if (isAreaModel(model)) return 'area';
	if (model.startsWith('tool_')) return 'tool';
	// login / menu / installer / dd_grid resolve to the model name itself (PHP).
	return model;
}

/** PHP resolve_view legacy-model defaults (class.common.php:4520). Exported
 * for the implicit edit ddo_map builder (request_config/implicit.ts). */
export function resolveDefaultView(model: string, legacyModel: string | null): string | null {
	const effective = legacyModel ?? model;
	switch (effective) {
		case 'component_portal':
			return 'default';
		case 'component_relation_children':
		case 'component_relation_parent':
		case 'component_relation_index':
		case 'component_relation_related':
		case 'component_autocomplete':
		case 'component_autocomplete_hi':
			return 'line';
		case 'component_html_text':
			return 'html_text';
		// section_tab family (v7-native, no PHP oracle): the OUTER container renders
		// the tab-label bar ('section_tab' view), each INNER tab node renders as a
		// hidden panel toggled by its label ('tab' view). The stored ontology model
		// distinguishes them — a 'tab' node canonicalizes to section_tab but keeps
		// legacy_model 'tab'. Without these the client (render_section_tab.js) gets
		// view null → default 'section_tab' branch → an inner tab wrongly builds its
		// OWN nested tab bar from its component children instead of showing them.
		case 'section_tab':
			return 'section_tab';
		case 'tab':
			return 'tab';
		default:
			return null;
	}
}

/**
 * PHP get_children_view legacy-model defaults (class.common.php:5286-5316).
 * The view a component imposes on the section_record children it builds — the
 * relation family renders its children as a joined PHRASE (`view_text`), not as
 * the grid the child's own view would give. The client reads it in
 * `view_line_edit_portal.js:146` (`context.children_view || context.view`), so
 * a missing value silently degrades to the parent's own view.
 */
export function resolveDefaultChildrenView(
	model: string,
	legacyModel: string | null,
): string | null {
	const effective = legacyModel ?? model;
	switch (effective) {
		case 'component_relation_children':
		case 'component_relation_parent':
		case 'component_relation_index':
		case 'component_relation_related':
		case 'component_autocomplete':
		case 'component_autocomplete_hi':
			return 'text';
		default:
			return null;
	}
}

/** Build (or fetch) the cached structural core for one element. */
async function buildCore(
	tipo: string,
	sectionTipo: string,
	mode: string,
): Promise<StructureContextCoreInternal | null> {
	// The application language is part of the key: the core bakes the resolved
	// `label` (ontology term in the caller's interface language), so two users on
	// different interface languages must not share one cached core (spec §4).
	const cacheKey = `${currentApplicationLang()}_${tipo}_${sectionTipo}_${mode}`;
	const cached = coreCache.get(cacheKey);
	if (cached !== undefined) return cached;

	const node = await getNode(tipo);
	if (node === null) return null;
	const model = await getModelByTipo(tipo);
	if (model === null) return null;

	// component_alias (WC-020): the context emits from the alias-MERGED
	// effective properties (Site A/B, view), the TARGET's stored model as
	// legacy_model and the target's translatable flag — while tipo/label stay
	// the alias's own. All ontology-derived, so it lives inside the cached
	// core. Non-aliases: effectiveProperties === node.properties (pass-through).
	const { getEffectivePropertiesByTipo, getTargetStoredModel } = await import(
		'../ontology/alias.ts'
	);
	const effectiveProperties = await getEffectivePropertiesByTipo(tipo);
	const storedModel = await getTargetStoredModel(tipo);
	const translatable =
		node.model === 'component_alias' ? await getTranslatableByTipo(tipo) : node.translatable;

	// EMITTED properties/css (PHP build_structure_context_core :1801-1846,
	// "Site A"): (section|component_portal)+list swap to the section_list child
	// (plain-parent, first by order_number — this is what gives the list view
	// the correct column css, e.g. numisdata122's .column_numisdata77 width,
	// instead of the section's edit-form .list_body grid), the edit-css strip
	// for every other element in list mode, and the section-node css override
	// for components. Only the ontology lookups happen here — the decision
	// table itself is the pure resolveEmittedPropertiesAndCss.
	// The section_list child lookup serves TWO PHP consumers with different
	// model scopes: the Site-A properties/css swap (section|component_portal
	// only, :1806) and get_view's list-mode view preference (:4471-4490 — ANY
	// component_* or section). Fetch once for the union.
	let sectionListChildProperties: unknown | null = null;
	if ((model === 'section' || model.startsWith('component_')) && mode === 'list') {
		const { findSectionListChild } = await import('../relations/request_config/build.ts');
		const childTipo = await findSectionListChild(tipo);
		if (childTipo !== null) {
			// PHP get_properties() ?? new stdClass() (:1816): a config-less child
			// still counts as FOUND — css becomes the child's (null), not the
			// element's edit css.
			sectionListChildProperties = (await getNode(childTipo))?.properties ?? {};
		}
	}
	const sectionProperties = model.startsWith('component_')
		? ((await getNode(sectionTipo))?.properties ?? null)
		: null;
	const { properties, css } = resolveEmittedPropertiesAndCss({
		model,
		mode,
		tipo,
		ownProperties: effectiveProperties,
		// Site A swaps only for section|component_portal (PHP :1806).
		sectionListChildProperties:
			model === 'section' || model === 'component_portal' ? sectionListChildProperties : null,
		sectionProperties,
	});

	// STRUCTURAL VIEW (PHP common::get_view, class.common.php:4464-4506; the
	// ddo_map-injected view still wins per-call at stamp time): in list mode a
	// component_*/section prefers its section_list CHILD's properties.view, then
	// FALLS BACK to the element's OWN properties.view — NOT the Site-A swapped
	// object's (16 live mosaic portals, e.g. tch66/oh17, carry their view on the
	// portal node while their child has none). resolveDefaultView applies last,
	// at stamp.
	const childView = (sectionListChildProperties as { view?: unknown } | null)?.view;
	const ownView = (effectiveProperties as { view?: unknown } | null)?.view;
	const structuralView =
		(typeof childView === 'string' ? childView : null) ??
		(typeof ownView === 'string' ? ownView : null);

	// request_config SOURCE properties (PHP trait resolve_source_properties,
	// "Site B") — the stamp-time config/columns_map feed. INTERNAL: the stamp
	// destructures it out before the entry spread; it never reaches the wire.
	const configSource = await resolveSourceProperties(tipo, mode, model, effectiveProperties);
	const configSourceProperties =
		configSource !== null && configSource !== undefined ? structuredClone(configSource) : null;

	// legacy_model: the ontology's STORED (pre-replacement) model name, emitted
	// UNCONDITIONALLY (PHP get_legacy_model_by_tipo resolves the raw model term
	// with no replacement map and common.php:1962 stamps it even when it equals
	// the runtime model — the client keys behavior on values like
	// 'component_html_text', so equality must not null it out).
	const legacyModel = storedModel ?? node.model;

	// term/label from a fresh node read (term column not on ResolvedNode; the
	// resolver keeps nodes lean — label resolution queries dd_ontology term).
	const label = await labelByTipo(tipo);

	const core = {
		label,
		tipo,
		section_tipo: sectionTipo,
		model,
		legacy_model: legacyModel,
		parent_grouper: node.parent,
		mode,
		translatable,
		properties,
		css,
		tools: [] as unknown[], // filled at STAMP time (user-gated — never cached)
		buttons: [] as unknown[], // filled at STAMP time by stampSectionContext (sections)
		// list-column sortability (PHP build_structure_context_core :1752) — a
		// request-invariant function of model+tipo+section (the cache key carries
		// section_tipo), so it lives in the cached core.
		sortable: resolveSortable(model, tipo, sectionTipo),
		// dataframe delete policy: the slot's ONE resolved answer, stamped on
		// every component_dataframe entry (request-invariant — cached core).
		...(model === 'component_dataframe'
			? { delete_policy: dataframeDeletePolicyOf(node.properties) }
			: {}),
		// render class (P2-6 / CARRY-01): the client escapes every component
		// value by THIS key, so it is stamped from the descriptor on every
		// component entry — request-invariant, so it lives in the cached core.
		...(getComponentModel(model) !== undefined ? { render_class: getRenderClass(model) } : {}),
		configSourceProperties,
		ownConfigProperties: effectiveProperties,
		structuralView,
	};
	coreCache.set(cacheKey, core);
	return core;
}

/**
 * PHP resolve_source_properties (trait.request_config_utils.php:264-309 —
 * "Site B"): the properties the element's request_config/columns_map build
 * feeds from. For a SECTION in list / tm / list_thesaurus mode, swap to the
 * section_list(_thesaurus) child's properties — UNLESS the section declares its
 * own source.request_config (then it keeps its own). All other cases use the
 * element's own properties. NOT the emitted properties/css — that is Site A
 * (resolveEmittedPropertiesAndCss), which PHP resolves independently.
 */
async function resolveSourceProperties(
	tipo: string,
	mode: string,
	model: string,
	ownProperties: unknown,
): Promise<unknown> {
	if (mode !== 'list' && mode !== 'list_thesaurus') return ownProperties;
	if (model !== 'section') return ownProperties;
	// Sections with a direct request_config skip the section_list swap (PHP
	// :274, isset semantics: any non-null value).
	const ownConfig = (ownProperties as { source?: { request_config?: unknown } } | null)?.source
		?.request_config;
	if (ownConfig !== undefined && ownConfig !== null) return ownProperties;
	const listModel = mode === 'list_thesaurus' ? 'section_list_thesaurus' : 'section_list';
	// PLAIN direct-children lookup: the trait resolves via get_ar_children_of_this
	// (class.ontology_node.php:1586-88) — never resolve_virtual. The
	// virtual-aware findSectionChildByModel belongs to the LIST-DEFINITIONS
	// machinery (class.section.php:868 resolve_virtual=true), a different site.
	const { findSectionListChild } = await import('../relations/request_config/build.ts');
	const childTipo = await findSectionListChild(tipo, listModel);
	const child = childTipo === null ? null : await getNode(childTipo);
	// Use the child's properties when found; else the section's own (PHP fallthrough).
	return child?.properties ?? ownProperties;
}

/**
 * The EMITTED `properties`/`css` of a structure-context entry (PHP
 * build_structure_context_core, class.common.php:1801-1846 — "Site A"). PURE:
 * every ontology lookup happens in buildCore; this is the verbatim decision
 * table, unit-gated DB-free (test/unit/structure_context_css.test.ts).
 *
 * PHP decision table:
 * - (section|component_portal) + list + section_list child found → the CHILD's
 *   properties/css (:1806-1817) — list grid/column css is authored there.
 * - (section|component_portal) + list, NO child → own properties, css null
 *   (:1818-1822, remove_edit_css).
 * - every other model + list → own properties, css null (:1823-1830) — edit
 *   css add-ons NEVER leak into list mode.
 * - any other mode (edit/search/tm/list_thesaurus) → own properties, own css.
 * - `properties.css` is ALWAYS stripped from the emitted properties (:1834) —
 *   css travels only as the top-level context field.
 * - component_* override (:1840-1846): the SECTION node's own
 *   properties.css[tipo] REPLACES the css when present — any mode, even over a
 *   list-stripped null (isset semantics: a null value does not override).
 *
 * TS-only extension (engineering/wire_contract/ WC-016): the winning css object may
 * scope rules per mode via the RESERVED top-level keys `list` / `search`
 * (selector-fragment maps, resolved by resolveCssModeKeys). Bare keys keep PHP
 * semantics exactly — measured: no existing ontology css uses the reserved
 * keys, so all current data emits byte-identically to PHP.
 */
/**
 * THE SECOND PUBLICATION PATH of `api_config`.
 *
 * The emitted `properties` of a context entry are a near-verbatim ontology
 * echo, and for the external SECTIONS (zenon1, test3 — and rsc205, whose copy
 * is a stale 2024 duplicate) that echo carries `properties.api_config`. That
 * object names an endpoint the browser is invited to call and a `ui_base_url`
 * the portal concatenates into an `open_window` URL
 * (client/dedalo/core/component_portal/js/component_portal.js:2054), so it is
 * shaped by exactly the same publication rules as the request_config copy —
 * one shaper, two paths, no way to fix one and forget the other.
 *
 * A refused api_config is DROPPED from the echo (not nulled): the echo's
 * contract is "what the ontology says", and a key that could not be published
 * is better absent than present-and-false. Nothing in the client reads
 * `context.properties.api_config` (measured over client/**), so no render
 * depends on it either way.
 *
 * Returns the SAME object when there is nothing to shape (the overwhelming
 * case — one section in a hundred is external), a rebuilt one when the key has
 * to go, so the caller never has to wonder which it got.
 */
export function sanitizeEmittedProperties(
	properties: Record<string, unknown>,
	tipo: string,
): Record<string, unknown> {
	if (!('api_config' in properties)) return properties;
	const published = publishApiConfig(properties.api_config, { sectionTipo: tipo });
	if (published === null) {
		// Rebuilt without the key — an `undefined` value would still answer true
		// to `'api_config' in properties`, which is the shape the gates read.
		const { api_config: _refused, ...withoutBinding } = properties;
		return withoutBinding;
	}
	properties.api_config = published;
	return properties;
}

export function resolveEmittedPropertiesAndCss(input: {
	model: string;
	mode: string;
	tipo: string;
	ownProperties: unknown;
	/** The section_list child's properties; null = NO child (fetched only for (section|portal)+list). */
	sectionListChildProperties: unknown | null;
	/** The section node's properties (override source); fetched only for component_* models. */
	sectionProperties: unknown | null;
}): { properties: Record<string, unknown>; css: unknown } {
	const { model, mode, tipo } = input;

	// PHP :1801-1826 — source swap / remove_edit_css.
	let removeEditCss = false;
	let source: unknown = input.ownProperties;
	if ((model === 'section' || model === 'component_portal') && mode === 'list') {
		if (input.sectionListChildProperties !== null) {
			source = input.sectionListChildProperties;
		} else {
			removeEditCss = true;
		}
	} else {
		removeEditCss = true;
	}

	// Deep-clone (PHP SEC-023): the sources come from the resolver cache and the
	// emitted objects get mutated by stamp-time callers. The destructure IS the
	// css lift (PHP :1829) + the unconditional properties strip (:1834). The
	// :1830 list-mode null-out folds into resolveCssModeKeys — applied LAST so
	// the strip cannot swallow a css.list opt-in or the :1840 override.
	const { css: liftedCss, ...rawProperties } = (
		source !== null && source !== undefined ? structuredClone(source) : {}
	) as Record<string, unknown>;
	const properties = sanitizeEmittedProperties(rawProperties, tipo);
	let css: unknown = liftedCss ?? null;

	// PHP :1840-1846 — the section-node css override for components. An override
	// is intentional per-element styling in WHATEVER mode the section author
	// scoped it for: the list strip does not apply to it (PHP replaces the
	// already-nulled css).
	let overridden = false;
	if (model.startsWith('component_')) {
		const sectionCss = (input.sectionProperties as { css?: unknown } | null)?.css;
		const override =
			sectionCss !== null && typeof sectionCss === 'object' && !Array.isArray(sectionCss)
				? (sectionCss as Record<string, unknown>)[tipo]
				: undefined;
		if (override !== null && override !== undefined) {
			css = structuredClone(override);
			overridden = true;
		}
	}

	return { properties, css: resolveCssModeKeys(css, mode, removeEditCss && !overridden) };
}

/**
 * Mode-scope a winning css object (WC-016) + the PHP :1830 list strip. A BARE
 * css object (no reserved keys — every css in current installs) follows PHP
 * verbatim: emitted as-is in edit/search/tm/…, nulled in list when the element
 * is not a list-css carrier (removeEditCss). The reserved keys `list`/`search`
 * override the bare set for their mode (`css.list` opts a component into
 * list-mode css despite the strip) and are never emitted inside another mode's
 * css. An object whose bare set is emptied by the reserved-key removal emits
 * null, not `{}`.
 */
function resolveCssModeKeys(css: unknown, mode: string, removeEditCss: boolean): unknown {
	if (css === null || typeof css !== 'object' || Array.isArray(css)) {
		// Non-object css: the plain PHP rule (:1830).
		return removeEditCss && mode === 'list' ? null : css;
	}
	const cssObject = css as Record<string, unknown>;
	const hasReservedKeys = 'list' in cssObject || 'search' in cssObject;
	if (!hasReservedKeys) {
		// PHP-era bare object: byte-identical pass-through (`{}` stays `{}`).
		return removeEditCss && mode === 'list' ? null : cssObject;
	}
	const { list, search, ...base } = cssObject;
	const baseOrNull = Object.keys(base).length > 0 ? base : null;
	if (mode === 'list') return list ?? (removeEditCss ? null : baseOrNull);
	if (mode === 'search') return search ?? baseOrNull;
	return baseOrNull;
}

/** Label lookup (dd_ontology.term), re-exported for the request_config ddo
 * enrichment (PHP enrich_ddo_label). Canonical home: ontology/labels.ts. */
export const contextLabelOf = labelByTipo;

/**
 * Build one stamped context entry (PHP build_structure_context): clone the
 * cached core, deep-clone properties, stamp the per-call variant fields.
 */
/**
 * The columns_map feed for a stamped entry: the caller's properties override
 * when given, else the element's OWN (pre-Site-B) properties — see
 * ownConfigProperties for why the swapped ones must NOT be used. Extracted
 * from buildStructureContext to keep its cyclomatic count under the ratchet.
 */
async function resolveEntryColumnsMap(
	tipo: string,
	propertiesOverride: Record<string, unknown> | undefined,
	ownConfigProperties: unknown,
	mode: string,
): Promise<unknown[]> {
	const { getElementColumnsMap } = await import('../relations/request_config/build.ts');
	const feed = propertiesOverride !== undefined ? propertiesOverride : ownConfigProperties;
	return (await getElementColumnsMap(tipo, feed, mode)) ?? [];
}

/**
 * Search mode: stamp the parent grouper's term as
 * `config.parent_grouper_label`, so the search panel can say WHICH "Id" /
 * "Name" a field is when several groupers carry one (the client renders it as
 * the `[Identification]` suffix — ui.js label_info). PHP
 * class.common.php:1700-1707 stamps it on a CLONE of config (the core config
 * is shared with the cache entry); `entry` is already per-call here. Extracted
 * from buildStructureContext to keep its cyclomatic count under the ratchet.
 */
async function stampSearchParentGrouperLabel(
	entry: StructureContextEntry,
	mode: string,
): Promise<void> {
	if (mode !== 'search' || !entry.parent_grouper) return;
	entry.config = {
		...(entry.config ?? {}),
		parent_grouper_label: await labelByTipo(entry.parent_grouper),
	};
}

/** The section an element's request_config resolves against (see `configSectionTipo`). */
function requestConfigSectionTipo(options: {
	sectionTipo: string;
	configSectionTipo?: string;
}): string {
	return options.configSectionTipo ?? options.sectionTipo;
}

export async function buildStructureContext(options: {
	tipo: string;
	sectionTipo: string;
	mode: string;
	lang: string;
	permissions: number;
	/** Context parent (ddo/session resolution deferred — caller supplies). */
	parent?: string | null;
	/** View injected from the ddo_map (top precedence, PHP get_view). */
	view?: string | null;
	/**
	 * children_view injected from the ddo_map (top precedence, PHP
	 * get_children_view :5289 — the `isset($this->children_view)` branch, set
	 * when the ddo_map carries one).
	 */
	childrenView?: string | null;
	/**
	 * The element's descendants from the CLIENT rqo ddo_map (already parent-
	 * resolved). When non-empty, they NARROW the explicit show.ddo_map (the PHP
	 * get_subdatum children-injection, class.common.php :2598-2681) — the
	 * client's requested resolution wins over the ontology default.
	 */
	rqoChildrenDdos?: Record<string, unknown>[];
	/**
	 * Whether to stamp the resolved request_config onto the entry (PHP
	 * add_request_config). The `start` action builds contexts WITHOUT it —
	 * the config stays only in properties.source. Default true.
	 */
	addRequestConfig?: boolean;
	/**
	 * Stamp this lang VERBATIM, skipping the nolan-forcing rule. The PHP
	 * `start` path instantiates its page elements with DEDALO_DATA_LANG and
	 * never nolan-forces them (differentially verified: the start section and
	 * menu contexts carry lg-spa) — the client's element instances INHERIT
	 * this lang and thread it into every component read/save, so getting it
	 * wrong makes the whole edit form operate in lg-nolan.
	 */
	langOverride?: string;
	/**
	 * The requesting principal. When supplied, the section button context uses
	 * the real per-button ACL (get_permissions(sectionTipo, buttonTipo)) instead
	 * of the caller-level permission cap (SECTION_SPEC §9). Optional so the
	 * legacy admin-path callers stay behavior-identical until threaded (Phase B).
	 */
	principal?: Principal;
	/**
	 * The PARENT-PORTAL of a SUBDATUM ddo (a component surfaced inside a portal
	 * cell). When set and its section differs from this ddo's, the order `path`
	 * is prepended with the parent-portal step so a column sort join starts at
	 * the listed section (PHP get_order_path from_component/from_section). Unset
	 * for top-level section columns (their parent is the section, not a portal).
	 */
	orderPathFrom?: { componentTipo: string; sectionTipo: string };
	/**
	 * RQO source.properties override (PHP dd_core_api read :2305-2308,
	 * `$element->set_properties`): the client ships a TOOL ddo_map entry's
	 * declared properties with its component reads (create_source) and PHP
	 * REPLACES the element's ontology properties before emitting context —
	 * the properties echo, css, view and request_config ALL derive from the
	 * override (epigraphy coins portal: the override's sqo_config.limit 1
	 * beats the ontology's 9). Applied at STAMP time only; the cached core
	 * is never touched. Threaded by the get_data context build.
	 */
	propertiesOverride?: Record<string, unknown>;
	/**
	 * TEMPORAL instance (WC-059/WC-079): suppress the component TOOLBAR. Every
	 * tool on that strip acts on a RECORD — time machine history, propagate this
	 * value across a search result set, per-language editing of a stored datum —
	 * and a temporal clone addresses no record, so each one is either inert or
	 * actively wrong on it. PHP shipped the strip here too; this is a deliberate
	 * TS divergence, and a small one: the client renders from `self.tools || []`
	 * (ui.add_tools), so an empty array needs no client change.
	 */
	isTemporal?: boolean;
	/**
	 * The section the element's request_config resolves against, when it is NOT
	 * `sectionTipo`: a HOST section listing another section's component (the
	 * Time Machine dd15 lists a record's components as its columns). The entry
	 * still binds to `sectionTipo`; only 'self', `field_value` and the other
	 * owner-derived sources move. Default `sectionTipo`. Data-side twin:
	 * `concepts/emit_row.ts` (`config_owner`).
	 */
	configSectionTipo?: string;
}): Promise<StructureContextEntry | null> {
	const core = await buildCore(options.tipo, options.sectionTipo, options.mode);
	if (core === null) return null;

	// CONSULTATION-ONLY CAP (single chokepoint for client editability): every
	// element emitted for a read-only section (Activity dd542, Time Machine dd15,
	// …) is capped at read (1), so the client renders EVERY component of that
	// section non-editable (its `disabled_component` path fires at permission < 2)
	// and never surfaces admin-only affordances (perm >= 3 gate below). This is
	// what actually makes the section read-only in the UI — the coarse per-request
	// stamp in section/read.ts and read_tm.ts hands 3 to admins. Mirrors PHP
	// section::get_section_permissions:1929 (the value the PHP client receives).
	// ONT-TLD CAP, same chokepoint, same reason. `ontology7` on an ontology node
	// section (`<tld>0`) is DERIVED from the section it sits in — `actv0` can only
	// ever hold `actv` — so there is nothing for an administrator to decide, and
	// every other value they could type loses the record: a different tld files it
	// under another namespace, an empty one makes it unparseable and invisible in
	// the ontology tree. Capped at read so component_input_text renders a static
	// `div.content_value.read_only` (that model honours `permissions === 1`, and
	// NOT `properties.show_interface.read_only`).
	//
	// It has to be HERE, not in resolveComponentContextPermission: that one
	// computes only the MAIN element's level for the get_data door, while a
	// section's component elements are stamped in section/read.ts's subdatum loop
	// via getPermissions + inheritSubdatumPermission, which never consults it. The
	// edit form is built from the latter, so a rule stated only there would leave
	// the field editable in the one place it is actually shown.
	//
	// DISPLAY only: the save door computes its own level, so the write half lives
	// in section/record/save_component.ts (ontologyTldRefusal) and covers the
	// import/API/MCP doors that never render a form.
	// The ALIAS hop matters here: `core.tipo` stays the alias's own by design
	// (WC-020) while saveComponentData resolves it to the DATA tipo before the
	// ONT-TLD refusal runs. Comparing the raw tipo made the two disagree — an
	// alias onto ontology7 rendered an editable input whose every save was
	// refused. The cap must ask the same question the writer asks.
	const dataTipo = await resolveDataTipo(options.tipo);
	const ontologyTldCapped =
		options.permissions > 1 &&
		dataTipo === ONTOLOGY_TLD &&
		requiredOntologyTld(options.sectionTipo) !== null;
	const permissions =
		options.permissions > 1 && isConsultationOnlySection(options.sectionTipo)
			? 1
			: ontologyTldCapped
				? 1
				: options.permissions;

	// Clone-before-stamp: shallow clone + deep-cloned properties (PHP :1644/:1653).
	// The Site-B config feed + structural view are INTERNAL — destructured out
	// so the spread cannot leak them onto the wire entry.
	const { configSourceProperties, ownConfigProperties, structuralView, ...coreFields } = core;
	const entry: StructureContextEntry = {
		...coreFields,
		// Wire markers (PHP dd_object): the client keys its wrapper CSS classes
		// and behavior on `type` (wrapper_component/wrapper_section/…).
		typo: 'ddo',
		type: elementTypeOf(core.model),
		properties: structuredClone(core.properties),
		permissions,
		parent: options.parent ?? options.sectionTipo, // PHP structure fallback (:2186)
		// PHP get_lang(): non-translatable elements resolve to lg-nolan, not the
		// request lang (sections, relation components, …). AREAS are the
		// exception — their instances are constructed with the request lang and
		// no nolan forcing applies (that forcing lives in component
		// instantiation), verified differentially across every area model.
		lang:
			options.langOverride ??
			(core.translatable || isAreaModel(core.model) ? options.lang : 'lg-nolan'),
		// PHP get_view (:4464): ddo_map-injected view → structural view (list-mode
		// section_list child preference, then the element's OWN properties.view —
		// NOT the Site-A swapped object's) → model default.
		view: options.view ?? structuralView ?? resolveDefaultView(core.model, core.legacy_model),
		// PHP get_children_view (:5286): ddo_map-injected → the element's OWN
		// properties.children_view → the relation-family legacy default. Without
		// it the client falls back to the parent's own view and a relation cell
		// renders as a column grid instead of a `fields_separator`-joined phrase.
		children_view:
			options.childrenView ??
			(typeof (core.properties as { children_view?: unknown }).children_view === 'string'
				? (core.properties as { children_view: string }).children_view
				: null) ??
			resolveDefaultChildrenView(core.model, core.legacy_model),
	};

	// RQO properties override (PHP $element->set_properties, dd_core_api read
	// :2305-2308): re-run the Site-A emission table with the OVERRIDE as the
	// element's own properties — the emitted properties echo (css stripped),
	// the top-level css and the view all follow the override, exactly as PHP's
	// context build runs on the replaced properties.
	if (options.propertiesOverride !== undefined) {
		const override = structuredClone(options.propertiesOverride);
		let overrideListChildProperties: unknown | null = null;
		if (
			(core.model === 'section' || core.model.startsWith('component_')) &&
			options.mode === 'list'
		) {
			const { findSectionListChild } = await import('../relations/request_config/build.ts');
			const childTipo = await findSectionListChild(options.tipo);
			if (childTipo !== null) {
				overrideListChildProperties = (await getNode(childTipo))?.properties ?? {};
			}
		}
		const overrideSectionProperties = core.model.startsWith('component_')
			? ((await getNode(options.sectionTipo))?.properties ?? null)
			: null;
		const emitted = resolveEmittedPropertiesAndCss({
			model: core.model,
			mode: options.mode,
			tipo: options.tipo,
			ownProperties: override,
			sectionListChildProperties:
				core.model === 'section' || core.model === 'component_portal'
					? overrideListChildProperties
					: null,
			sectionProperties: overrideSectionProperties,
		});
		entry.properties = emitted.properties;
		entry.css = emitted.css;
		// PHP get_view on the REPLACED properties: the ddo-injected view still
		// wins, then the override's own view, then the model default.
		const overrideView = (override as { view?: unknown }).view;
		entry.view =
			options.view ??
			(typeof overrideView === 'string' ? overrideView : null) ??
			resolveDefaultView(core.model, core.legacy_model);
	}

	// component_relation_related: the json controller forces
	// properties.show_interface.button_add = false, creating show_interface if the
	// ontology omits it (component_relation_related_json.php:76-77). The client
	// suite asserts context.properties.show_interface exists with button_add:false.
	if (core.model === 'component_relation_related') {
		const props = (entry.properties ?? {}) as Record<string, unknown>;
		props.show_interface = {
			...((props.show_interface as Record<string, unknown> | undefined) ?? {}),
			button_add: false,
		};
		entry.properties = props;
	}

	// component_section_id: the FULL json-controller context appends the parent
	// section's display colour (PHP component_section_id_json.php default branch:
	// `$this->context->color = ontology_node::get_color($this->section_tipo)`).
	// ontology_node::get_color reads the SECTION node's properties.color, falling
	// back to '#b9b9b9' grey. view_default_edit_section_id.js injects it as the
	// wrapper background on BOTH idle and .active states (so activation never
	// changes the colour) — without it the client falls to the LESS default grey
	// and the .active state visibly shifts. The 'simple' context
	// (addRequestConfig:false, list/portal callers) omits it, matching PHP.
	if (core.model === 'component_section_id' && options.addRequestConfig !== false) {
		const sectionNode = await getNode(core.section_tipo);
		entry.color = (sectionNode?.properties as { color?: string } | null)?.color ?? '#b9b9b9';
	}

	await stampSearchParentGrouperLabel(entry, options.mode);

	// Section-only context extras (PHP class.common.php :2056-2100) — the
	// section module owns this stamping (matrix_table, relation_list_tipo,
	// buttons, tools, section_map, sqo_session).
	if (core.model === 'section') {
		await stampSectionContext(entry, {
			tipo: options.tipo,
			permissions,
			properties: core.properties,
			principal: options.principal,
			// PHP's $simple flag (get_structure_context_simple): the start action
			// and the search-filter panel build sections WITHOUT tools/buttons.
			// addRequestConfig:false is this codebase's established marker for it.
			simple: options.addRequestConfig === false,
		});
	}

	// Component/area/menu tools (PHP common::get_tools): components get the
	// 'all_components' catch-all + affected_models/tipos + requirement_translatable
	// (gated by the component's translatable flag); areas match via
	// affected_models('area') or an affected_tipos entry (e.g.
	// tool_ontology_parser → dd5). getElementTools applies the per-user
	// user_tools membership filter itself (PHP get_tools iterates
	// get_user_tools), so a tool the actor's profile denies never gets here.
	//
	// THE GATE IS **MODE**, NEVER PERMISSIONS (PHP build_structure_context
	// :1865): a component gets its toolbar in every mode EXCEPT list; a
	// section/area gets one in list too. `common::get_tools()` (:4023) holds no
	// permission check whatsoever — authorization is the per-user user_tools
	// list it iterates, not the element's level. A `permissions >= 3` gate here
	// would mean SUPERUSER-ONLY, because only userId -1 reaches 3 (the profile
	// matrix tops out at 2, global admins included), and it would silently
	// empty every toolbar for every real user — the tool_user_admin avatar
	// (dd522, uploaded FROM its toolbar) is the visible casualty. The frozen
	// oracle refutes such a gate outright: PHP shipped tools at permissions 2
	// (sqo_differential dd560 dataframe/edit) and at 1 (tm_component_history
	// dd452/tm), and never for a component in list mode.
	//
	// The MENU is the third stamping site and takes NO gate at all: PHP
	// overrides the builder in class.menu.php (menu::get_structure_context :461)
	// and always populates tools, so the list-mode exclusion above must not
	// reach it (readMenu renders at mode 'list'). Its one ontology-bound tool is
	// tool_user_admin (dd1324 affected_tipos = ['dd85'], always_active), which
	// the client opens from context.tools when the user clicks their name in the
	// header (menu.js open_tool_user_admin_handler) — an empty array makes that
	// link inert.
	//
	// The other half of PHP's condition is `$simple===false`: the start action
	// and the search-filter panel build their elements through
	// get_structure_context_simple, which skips tools entirely (the frozen start
	// fixture ships `tools: []` on its section context). addRequestConfig:false
	// is this codebase's marker for that simple build — but it does NOT apply to
	// the menu, which PHP start builds with the FULL override
	// (dd_core_api.php:379 `$menu->get_structure_context()`).
	//
	// Gated by test/unit/component_tools_stamp.test.ts + test/unit/menu_tools.test.ts.
	const isComponentModel = core.model.startsWith('component_');
	const isAreaElement = isAreaModel(core.model);
	const isMenuModel = core.model === 'menu';
	const simple = options.addRequestConfig === false;
	// A TEMPORAL clone gets NO toolbar (WC-079): every tool on the strip acts on a
	// record and this element addresses none. Same shape as the list-mode
	// exclusion above — a MODE-like gate, never a permissions one.
	const isTemporalElement = options.isTemporal === true;
	if (
		isMenuModel ||
		(!simple &&
			!isTemporalElement &&
			(isAreaElement || (isComponentModel && options.mode !== 'list')))
	) {
		const { getElementTools } = await import('../tools/registry.ts');
		// The tool APPLIES gate reads the EFFECTIVE properties (an rqo override
		// replaces the ontology's, PHP set_properties before get_tools).
		const toolConfigBag =
			(
				(options.propertiesOverride ?? core.properties) as {
					tool_config?: Record<string, unknown>;
				} | null
			)?.tool_config ?? {};
		const toolConfigKeys = Object.keys(toolConfigBag);
		const elementTools = await getElementTools({
			model: core.model,
			tipo: options.tipo,
			isComponent: isComponentModel,
			translatable: isComponentModel ? core.translatable : false,
			toolConfigKeys,
		});
		// PHP get_tools stamping (class.common.php:1868-1916): a tool declaring
		// properties.mode shows only in that mode; when the element's properties
		// carry a tool_config for the tool, resolve the ddo_map 'self' sentinels
		// to this element and enrich every entry (model/translatable/label) —
		// PHP mutates the SHARED properties object, so the enriched map reaches
		// the wire BOTH on the tool context and on the emitted
		// properties.tool_config (the client builds the tool's components from
		// it; unenriched, tool_common.js falls back to a synthetic single-entry
		// ddo_map and the configured components never render). The per-
		// (tipo,section_tipo) register-record override branch
		// (tool_common::get_tool_configuration) is NOT ported: no register
		// record in the corpus defines one (the 4 textual matches are
		// description prose), so the ontology branch is the oracle-exercised
		// path — a future register override needs that branch first.
		const { enrichToolConfig } = await import('../tools/section_tool_context.ts');
		const stampedTools: unknown[] = [];
		for (const tool of elementTools.tools) {
			const toolMode = (tool.properties as { mode?: unknown } | null | undefined)?.mode;
			if (toolMode !== undefined && toolMode !== options.mode) continue;
			const rawToolConfig = toolConfigBag[tool.name];
			if (rawToolConfig === undefined || rawToolConfig === null) {
				stampedTools.push(tool);
				continue;
			}
			const enriched = await enrichToolConfig(rawToolConfig, options.tipo, options.sectionTipo);
			const entryProperties = (entry.properties ?? {}) as Record<string, unknown>;
			const entryToolConfig = (entryProperties.tool_config ?? {}) as Record<string, unknown>;
			entryToolConfig[tool.name] = structuredClone(enriched);
			entryProperties.tool_config = entryToolConfig;
			entry.properties = entryProperties;
			stampedTools.push({ ...tool, tool_config: enriched });
		}
		entry.tools = stampedTools;
	}

	// request_config (spec §3.6): explicit from the Site-B SOURCE properties (with
	// the LIST-mode section_list substitution) or the implicit relation_nodes
	// fallback — only for elements that declare/inherit a config (relation
	// components, sections). NOT the emitted properties: PHP feeds the config
	// build from resolve_source_properties output, independent of the css block.
	// An rqo properties override replaces the feed (PHP set_properties runs
	// BEFORE the context build, so Site B resolves over the override).
	const effectiveConfigSource =
		options.propertiesOverride !== undefined
			? structuredClone(
					await resolveSourceProperties(
						options.tipo,
						options.mode,
						core.model,
						options.propertiesOverride,
					),
				)
			: configSourceProperties;
	const hasOwnExplicitConfig = Array.isArray(
		(effectiveConfigSource as { source?: { request_config?: unknown } } | null)?.source
			?.request_config,
	);
	if (options.addRequestConfig === false) {
		// PHP omits the key entirely when add_request_config=false (start) — the
		// entry simply never gets a request_config property.
	} else if (
		hasOwnExplicitConfig ||
		core.model === 'section' ||
		// The WHOLE relation family declares/inherits a config: implicit no-source
		// components (select/radio graph walks) included — PHP stamps
		// request_config for them all (corpus gate: numisdata967/1562/55).
		getColumnNameByModel(core.model ?? '') === 'relation'
	) {
		// Sections without their own explicit config STILL get a request_config: the
		// LIST-mode section_list child substitution / implicit relation_nodes fallback
		// (PHP resolve_source_properties). The client derives its list-table
		// COLUMNS from this show.ddo_map (common.js get_columns_map), so a
		// section entry without it renders an Id-only table.
		const { buildRequestConfigForElement } = await import('../relations/request_config/build.ts');
		const { processRqoChildren } = await import('../relations/request_config/explicit.ts');
		const requestConfigContext = {
			ownerTipo: options.tipo,
			ownerSectionTipo: requestConfigSectionTipo(options),
			mode: options.mode,
			ownerIsSection: core.model === 'section',
			lang: options.lang,
		};
		const parsedConfig = await buildRequestConfigForElement(
			effectiveConfigSource,
			requestConfigContext,
		);
		// Caller-children narrowing (PHP get_subdatum children-injection,
		// class.common.php:2598-2681): the caller's ddo_map descendants of this
		// element REPLACE its own show map. PHP overrides the FIRST config object
		// per api_engine (rc_by_api_engine ??=, :2604-2608); the children here
		// come from the caller's dedalo map, so only the first dedalo item
		// narrows — non-dedalo engine configs keep their own maps. Empty
		// children ⇒ untouched config (the element's ontology map stands).
		if (options.rqoChildrenDdos !== undefined && options.rqoChildrenDdos.length > 0) {
			const { extractSqoSectionTipos } = await import('../relations/request_config/explicit.ts');
			// Capability-negotiated (relations/request_config/engine_select.ts):
			// the caller's children describe COLUMNS to render at the target, so
			// an external-only element must have an adapter that can back them.
			const { selectConfigItemForConcern } = await import(
				'../relations/request_config/engine_select.ts'
			);
			const item = await selectConfigItemForConcern(
				parsedConfig,
				'listColumns',
				'resolve/structure_context.rqoChildrenNarrowing',
			);
			if (item !== null && item.show !== null) {
				item.show.ddo_map = await processRqoChildren(
					options.rqoChildrenDdos,
					requestConfigContext,
					extractSqoSectionTipos(item),
				);
			}
		}
		// A relation column in a picker's search map is searched through what it
		// DISPLAYS: its display ddos are written under it in the item's own
		// `search_paths` key, so the client mints explicit deep filter paths
		// instead of sending a word to a locator column; show/search/choose stay
		// untouched (WC-2026-10-01-relation-search-display-paths).
		const { withSearchDisplayPaths } = await import(
			'../relations/request_config/search_display_paths.ts'
		);
		entry.request_config = await withSearchDisplayPaths(parsedConfig, options.tipo, core.model);

		// columns_map exposure (PHP :1679): the base ontology value (section_list
		// child in list mode) when a request_config exists, [] fallback. The
		// client completes the final grid columns in JS (common.js get_columns_map).
		// (!) The feed is the element's OWN properties, NOT the Site-B swap:
		// PHP get_columns_map (:4339) reads $this->get_properties() and resolves
		// the section_list child itself for list/tm. Handing it the swapped
		// properties leaked a section_list_thesaurus columns_map into
		// list_thesaurus mode — see ownConfigProperties.
		if (parsedConfig.length > 0) {
			entry.columns_map = await resolveEntryColumnsMap(
				options.tipo,
				options.propertiesOverride,
				ownConfigProperties,
				options.mode,
			);
		}
	}

	// component_iri: PHP class.component_iri::get_properties (:252) ALWAYS injects a
	// label-dataframe slot into source.request_config (dd560 =
	// DEDALO_COMPONENT_IRI_LABEL_DATAFRAME). The human-readable title is stored in the
	// paired dataframe, and the client list/text view (view_text_list_iri.js:114-121)
	// resolves it through get_dataframe, which reads
	// self.context.request_config[0].show.ddo_map for a component_dataframe ddo. The iri
	// ontology carries no request_config of its own, so synthesize the slot here (a
	// verbatim mirror of the PHP injection) — without it get_dataframe returns null and
	// the render crashes on component_dataframe.render() of null.
	if (options.addRequestConfig !== false && core.model === 'component_iri') {
		entry.request_config = [
			{
				sqo: {
					section_tipo: [{ value: [options.sectionTipo], source: 'section' }],
				},
				show: {
					ddo_map: [
						{
							tipo: 'dd560', // DEDALO_COMPONENT_IRI_LABEL_DATAFRAME
							model: 'component_dataframe',
							section_tipo: options.sectionTipo,
							parent: 'self',
							mode: 'edit',
							view: 'line',
							label: 'Title dataframe',
						},
					],
					fields_separator: ' | ',
				},
			},
		];
	}

	// AREA request_config skeleton (PHP get_ar_request_config for an area model):
	// a single 'main' dedalo entry whose sqo.section_tipo carries the area's own
	// ddo, an empty show.ddo_map, and a list sqo_config. The client REQUIRES
	// request_config to be an ARRAY — area.js / area_thesaurus.js /
	// area_maintenance.js call `context.request_config.find(el => el.type==='main')`
	// guarded only on context, so a MISSING request_config throws
	// (undefined.find) and the whole area renders blank. Only when add_rqo is on
	// (read / get_element_context; NOT the `start` path, which omits it).
	if (
		options.addRequestConfig !== false &&
		isAreaModel(core.model) &&
		entry.request_config === undefined
	) {
		const { buildSqoSectionTipoDdos } = await import('../relations/request_config/explicit.ts');
		const areaSectionTipoDdos = await buildSqoSectionTipoDdos([options.tipo]);
		// PHP omits matrix_table on the area ddo (areas have no table);
		// buildSqoSectionTipoDdos always includes it — drop the null to match.
		for (const ddo of areaSectionTipoDdos) {
			if ((ddo as { matrix_table?: unknown }).matrix_table === null) {
				(ddo as { matrix_table?: unknown }).matrix_table = undefined;
			}
		}
		entry.request_config = [
			{
				api_engine: 'dedalo',
				type: 'main',
				sqo: {
					id: null,
					section_tipo: areaSectionTipoDdos,
					mode: null,
					filter: null,
					limit: null,
					offset: null,
					total: null,
					full_count: null,
					group_by: null,
					order: null,
					filter_by_locators: null,
					filter_by_locators_op: null,
					allow_sub_select_by_id: null,
					children_recursive: null,
					remove_distinct: null,
					skip_projects_filter: null,
					parsed: null,
					breakdown: null,
					tables: null,
					select: null,
					generated_time: null,
				},
				show: {
					ddo_map: [],
					sqo_config: { full_count: false, limit: 1, offset: 0, mode: 'list', operator: '$or' },
				},
				search: null,
				choose: null,
				hide: null,
				api_config: null,
			},
		];
		entry.columns_map = [];
	}

	// Media components: the `features` upload/quality descriptor (PHP
	// component_<media>_json default branch). The client reads
	// context.features.quality/allowed_extensions to render the edit view — a
	// missing features object crashes any media section's edit form.
	const { hasMediaFeatures, buildMediaFeatures } = await import('../section/media_features.ts');
	if (hasMediaFeatures(core.model)) {
		entry.features = buildMediaFeatures(core.model, options.tipo, options.sectionTipo);
	}
	// component_json: tool_upload replaces the value with an uploaded .json file and
	// reads features.allowed_extensions to build its picker (PHP component_json_json.php
	// :90-98) — without it the tool crashed on open.
	if (core.model === 'component_json') {
		entry.features = { allowed_extensions: ['json'], default_target_quality: null };
	}

	// component_geolocation: the FULL context carries features.geo_provider so the
	// client map widget knows which Leaflet tile backend to initialise (PHP
	// component_geolocation_json.php:106-115). Without it the map cannot pick a
	// tile layer and renders as an empty (blank) map. An instance
	// properties.geo_provider overrides the DEDALO_GEO_PROVIDER default; the
	// 'simple' context (addRequestConfig:false) omits features (list/portal views
	// render no interactive map).
	// features.default_view is the map's opening CAMERA when the record stores no
	// coordinate (DEDALO_GEO_DEFAULT_LAT/LON/ZOOM, world view 20/0/2). A view,
	// never data: the client never seeds current_value from it, so an untouched
	// record saves nothing. Instance properties.default_view ({lat,lon,zoom})
	// overrides it, all-or-nothing — same precedence idiom as geo_provider.
	// Numbers AND numeric strings are accepted: dd_ontology property JSON quotes
	// numbers routinely, and the client's own predicate (fn_finite_number,
	// component_geolocation.js) coerces — a server that took only unquoted
	// numbers would call invalid what the client calls valid. Range-checked, so
	// a typo cannot open the map off-planet; anything non-finite or out of range
	// resolves to null and the whole override falls back to the config camera.
	// Cache-safe: per-tipo, record-independent → stamped on the FRESH entry, never
	// on the cached core (a leak there bleeds across requests).
	if (core.model === 'component_geolocation' && options.addRequestConfig !== false) {
		const props = entry.properties as
			| { geo_provider?: unknown; default_view?: unknown }
			| undefined;
		const geoProvider = props?.geo_provider;
		const propView = props?.default_view as
			| { lat?: unknown; lon?: unknown; zoom?: unknown }
			| undefined;
		const num = (v: unknown, min: number, max: number): number | null => {
			const n =
				typeof v === 'number'
					? v
					: typeof v === 'string' && v.trim() !== ''
						? Number(v)
						: Number.NaN;
			return Number.isFinite(n) && n >= min && n <= max ? n : null;
		};
		const lat = num(propView?.lat, -90, 90);
		const lon = num(propView?.lon, -180, 180);
		const zoom = num(propView?.zoom, 0, 22);
		entry.features = {
			geo_provider: typeof geoProvider === 'string' ? geoProvider : config.geoProvider,
			default_view:
				lat !== null && lon !== null && zoom !== null
					? { lat, lon, zoom }
					: { ...config.geoDefaultView },
		};
	}

	// component_text_area: the EDIT-mode context carries the notes/references/
	// av_player feature bag (PHP component_text_area_json.php:145-171, inside
	// `case 'edit'`). The client edit view binds features.av_player.av_insert_tc_code
	// ('F2') to build_tag; without features F2 is inert and the draw/geo
	// layer_selector never opens. Only the FULL context (addRequestConfig!==false)
	// and edit mode build it — the simple/list contexts omit it.
	if (
		core.model === 'component_text_area' &&
		options.mode === 'edit' &&
		options.addRequestConfig !== false
	) {
		const { buildTextAreaFeatures } = await import('../section/text_area_features.ts');
		entry.features = await buildTextAreaFeatures();

		// toolbar_buttons (PHP component_text_area_json.php:36-81): the client
		// edit view appends context.toolbar_buttons to the CKEditor toolbar
		// (view_default_edit_text_area.js:446-455; button_lang is client-always).
		// Property-gated, PHP order (person, note, reference, draw, geo).
		// DELIBERATE divergence (WC-066): button_note gates on
		// properties.tags_notes — the config create_note_tag actually needs —
		// not on tags_persons (the v6 gating quirk), and the list is deduped
		// (PHP could push button_note twice). Identical output on the shipped
		// ontology (rsc36 → ['button_person','button_note']).
		// Per-(tipo,mode), record-independent → cache-safe: stamped on the
		// fresh entry like `features`, never on the cached core.
		const tagProps = entry.properties as {
			tags_persons?: unknown;
			tags_notes?: unknown;
			tags_reference?: unknown;
			tags_draw?: unknown;
		} | null;
		const toolbarButtons: string[] = [];
		if (tagProps?.tags_persons !== undefined && tagProps.tags_persons !== null) {
			toolbarButtons.push('button_person');
		}
		if (tagProps?.tags_notes !== undefined && tagProps.tags_notes !== null) {
			toolbarButtons.push('button_note');
		}
		if (tagProps?.tags_reference !== undefined && tagProps.tags_reference !== null) {
			toolbarButtons.push('reference');
		}
		if (tagProps?.tags_draw !== undefined && tagProps.tags_draw !== null) {
			toolbarButtons.push('button_draw');
		}
		// A related component_geolocation adds the geo tag button (PHP :72-81)
		// and note-taking with it (deduped here).
		const { relatedTipoByModel } = await import('../ontology/resolver.ts');
		if ((await relatedTipoByModel(options.tipo, 'component_geolocation')) !== null) {
			toolbarButtons.push('button_geo');
			if (!toolbarButtons.includes('button_note')) toolbarButtons.push('button_note');
		}
		entry.toolbar_buttons = toolbarButtons;
	}

	// target_sections (PHP component_<relation>_json set_target_sections, e.g.
	// component_check_box_json.php:96-109): the sections this relation links to,
	// [{tipo, label}]. The client's relation edit view iterates
	// context.target_sections for its "go to target section" buttons
	// (show_interface.button_list) — a missing array crashes the edit render.
	if (
		(core.model === 'component_filter' || core.model === 'component_filter_master') &&
		options.addRequestConfig !== false
	) {
		// component_filter's fixed projects target (PHP component_filter_json :100-124).
		// Only the FULL json-controller context carries it — get_structure_context_simple
		// (the search-filter panel, addRequestConfig:false) omits it. The label uses the
		// install DATA lang (PHP DEDALO_DATA_LANG at :120), not the request lang.
		const { termByTipo } = await import('../ontology/labels.ts');
		const { currentDataLang } = await import('./request_lang.ts');
		const projectsTipo = 'dd153'; // DEDALO_SECTION_PROJECTS_TIPO
		entry.target_sections = [
			{ tipo: projectsTipo, label: await termByTipo(projectsTipo, currentDataLang()) },
		];
	} else if (
		getColumnNameByModel(core.model ?? '') === 'relation' &&
		Array.isArray(entry.request_config)
	) {
		// Other relation components: the target sections from the resolved
		// request_config (PHP get_ar_target_section_tipo → the config sqo
		// targets). Per-config dedup lives in extractSqoSectionTipos; across
		// configs PHP CONCATENATES without dedup (get_ar_target_section_ddo,
		// class.component_common.php:3070-77) — mirror it.
		const { extractSqoSectionTipos } = await import('../relations/request_config/explicit.ts');
		const targetTipos: string[] = [];
		for (const item of entry.request_config as Parameters<typeof extractSqoSectionTipos>[0][]) {
			targetTipos.push(...extractSqoSectionTipos(item));
		}
		entry.target_sections = await Promise.all(
			targetTipos.map(async (targetTipo) => ({
				tipo: targetTipo,
				label: await labelByTipo(targetTipo),
			})),
		);
	}

	// SEARCH TOOLTIP (PHP build_structure_context :2010-2013): a component built
	// in 'search' mode carries the available-operators tooltip the client shows
	// under it (common/js/ui.js build_wrapper_search adds the .hidden_tooltip div
	// ONLY when context.search_options_title is set). Both fields are stamped for
	// EVERY search-mode component — empty-operator models (media/info/inverse/…)
	// emit `[]` and '' so the wire shape matches PHP exactly. The operator LABELS
	// resolve through the UI label dictionary in the APPLICATION lang (PHP
	// label::get_label default), independent of the entry's data lang.
	if (core.model.startsWith('component_') && options.mode === 'search') {
		const { searchOperatorsInfoWire, buildSearchOptionsTitle } = await import(
			'../search/search_operators.ts'
		);
		const { getLabels } = await import('../labels/catalog.ts');
		const labels = await getLabels(currentApplicationLang());
		entry.search_operators_info = searchOperatorsInfoWire(core.model);
		entry.search_options_title = buildSearchOptionsTitle(core.model, labels);
	}

	// ORDER PATH (PHP build_structure_context :1683-1688): a sortable component
	// ddo carries the ORDER-BY descriptor the client's list header turns into an
	// sqo.order. PHP emits get_order_path when the element has a request_config
	// context, else [] (the simple/start contexts, addRequestConfig:false). The
	// client force-disables the sort icon on an empty path, so the [] fallback
	// keeps non-search contexts non-sortable, matching PHP. The STAMPED config is
	// handed down so the portal sort leaf reads the caller-children-NARROWED show
	// map (PHP portal get_order_path consumes the get_subdatum-injected
	// $this->request_config, class.component_portal.php:404), not a rebuild from
	// the element's own ontology properties.
	if (core.model.startsWith('component_') && entry.sortable === true) {
		if (options.addRequestConfig === false) {
			entry.path = [];
		} else {
			const { buildOrderPath } = await import('../search/order_path.ts');
			const stampedConfig = Array.isArray(entry.request_config)
				? (entry.request_config as import('../search/order_path.ts').OrderPathResolvedConfig)
				: undefined;
			entry.path = await buildOrderPath(
				options.tipo,
				options.sectionTipo,
				options.orderPathFrom,
				stampedConfig,
			);
		}
	}
	return entry;
}

/** PHP common::context_key — dedup identity for merged context arrays. */
export function contextKey(entry: { tipo: string; section_tipo: string; mode: string }): string {
	return `${entry.tipo}_${entry.section_tipo}_${entry.mode}`;
}
