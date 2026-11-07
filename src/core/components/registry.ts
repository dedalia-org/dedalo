/**
 * Component model REGISTRY — the single source of truth mapping every component
 * `model` to its descriptor (see ./types.ts for the why).
 *
 * The engines' existing accessors read from here:
 *   - ontology/resolver.ts  getColumnNameByModel → descriptor.column
 *                           getModelByTipo       → descriptor.alias
 *   - resolve/component_data.ts (translation gate)→ descriptor.classSupportsTranslation
 *   - relations/registry.ts getRelationResolver  → descriptor.resolveData
 *                           search dispatcher     → descriptor.search
 *
 * COVERAGE. Every component model lives in its own folder `component_<model>/` with a
 * `descriptor.ts` (and, for most, a `samples/` reference set) and is registered
 * below. The load-time integrity check runs once at import and throws on a
 * broken registry (key/model mismatch, or an alias pointing at a non-existent
 * model) — turning what used to be scattered runtime surprises into a boot-time
 * guarantee.
 *
 * EXTENSION HONESTY (S2-26, re-stated 2026-07-07 — the old "nothing else in
 * the engines changes" claim was overstated). Descriptors route: column/alias
 * resolution, translation gating, relation read + relation-search dispatch,
 * default relation type, the non-relation SQO builder family (searchBuilder),
 * the CSV-import value-property set, the flat display-value family, and the
 * propagate/relation-data derivation (all via the accessors below —
 * enforced by test/unit/descriptor_completeness_tripwire.test.ts). STILL
 * SCATTERED in the engines (a new model may need edits there too):
 * relation_list's per-model value branches (resolve/relation_list.ts — reads
 * hardcoded sets pending the WS-B-owned rewire), the simple-context exclude
 * set (resolve/section_elements_context.ts DEFAULT_EXCLUDE), the RAG
 * embeddable-model default (ai/rag/config.ts), and any dedicated unported
 * search pipeline. Emit-time quirks NOW ROUTE through the descriptor
 * (`emitHook` → components/emit_hooks.ts, WS-C S2-24) — emitDdoData keeps
 * only the per-TIPO dd546 transform inline. The model-addition checklist
 * lives in ./README.md — follow it, do not trust this header alone.
 */

import { DedaloError } from '../errors/dedalo_error.ts';
import { registerComponentModelFieldsLookup } from '../ontology/resolver.ts';
// --- data-entry / scalar / special (non-relation) models -------------------
import { component_3d } from './component_3d/descriptor.ts';
import { component_autocomplete } from './component_autocomplete/descriptor.ts';
import { component_autocomplete_hi } from './component_autocomplete_hi/descriptor.ts';
import { component_av } from './component_av/descriptor.ts';
import { component_calculation } from './component_calculation/descriptor.ts';
import { component_check_box } from './component_check_box/descriptor.ts';
import { component_dataframe } from './component_dataframe/descriptor.ts';
import { component_date } from './component_date/descriptor.ts';
import { component_email } from './component_email/descriptor.ts';
import { component_external } from './component_external/descriptor.ts';
import { component_filter } from './component_filter/descriptor.ts';
import { component_filter_master } from './component_filter_master/descriptor.ts';
import { component_filter_records } from './component_filter_records/descriptor.ts';
import { component_geolocation } from './component_geolocation/descriptor.ts';
import { component_html_text } from './component_html_text/descriptor.ts';
import { component_image } from './component_image/descriptor.ts';
import { component_info } from './component_info/descriptor.ts';
import { component_input_text } from './component_input_text/descriptor.ts';
import { component_input_text_large } from './component_input_text_large/descriptor.ts';
import { component_inverse } from './component_inverse/descriptor.ts';
import { component_iri } from './component_iri/descriptor.ts';
import { component_json } from './component_json/descriptor.ts';
import { component_number } from './component_number/descriptor.ts';
import { component_password } from './component_password/descriptor.ts';
import { component_pdf } from './component_pdf/descriptor.ts';
// --- relation family --------------------------------------------------------
import { component_portal } from './component_portal/descriptor.ts';
import { component_publication } from './component_publication/descriptor.ts';
import { component_radio_button } from './component_radio_button/descriptor.ts';
import { component_relation_children } from './component_relation_children/descriptor.ts';
import { component_relation_index } from './component_relation_index/descriptor.ts';
import { component_relation_model } from './component_relation_model/descriptor.ts';
import { component_relation_parent } from './component_relation_parent/descriptor.ts';
import { component_relation_related } from './component_relation_related/descriptor.ts';
import { component_section_id } from './component_section_id/descriptor.ts';
import { component_security_access } from './component_security_access/descriptor.ts';
import { component_security_tools } from './component_security_tools/descriptor.ts';
import { component_select } from './component_select/descriptor.ts';
import { component_select_lang } from './component_select_lang/descriptor.ts';
import { component_state } from './component_state/descriptor.ts';
import { component_svg } from './component_svg/descriptor.ts';
import { component_text_area } from './component_text_area/descriptor.ts';
import type { ComponentModel, ImportAppendPolicy, ItemGateId, RenderClass } from './types.ts';

/** Every registered descriptor. One entry per `component_<model>/descriptor.ts`. */
const ALL_DESCRIPTORS: readonly ComponentModel[] = [
	component_3d,
	component_autocomplete,
	component_autocomplete_hi,
	component_av,
	component_calculation,
	component_check_box,
	component_dataframe,
	component_date,
	component_email,
	component_external,
	component_filter,
	component_filter_master,
	component_filter_records,
	component_geolocation,
	component_html_text,
	component_image,
	component_info,
	component_input_text,
	component_input_text_large,
	component_inverse,
	component_iri,
	component_json,
	component_number,
	component_password,
	component_pdf,
	component_portal,
	component_publication,
	component_radio_button,
	component_relation_children,
	component_relation_index,
	component_relation_model,
	component_relation_parent,
	component_relation_related,
	component_section_id,
	component_security_access,
	component_security_tools,
	component_select,
	component_select_lang,
	component_state,
	component_svg,
	component_text_area,
];

/** model name → descriptor. */
const REGISTRY: ReadonlyMap<string, ComponentModel> = buildRegistry();

function buildRegistry(): ReadonlyMap<string, ComponentModel> {
	const map = new Map<string, ComponentModel>();
	for (const descriptor of ALL_DESCRIPTORS) {
		if (map.has(descriptor.model)) {
			throw new Error(`component registry: duplicate descriptor for model '${descriptor.model}'`);
		}
		map.set(descriptor.model, descriptor);
	}
	// Integrity: every alias must resolve to a real, storable canonical model.
	for (const descriptor of map.values()) {
		if (descriptor.alias === undefined) continue;
		const target = map.get(descriptor.alias);
		if (target === undefined) {
			throw new Error(
				`component registry: '${descriptor.model}' aliases unknown model '${descriptor.alias}'`,
			);
		}
		if (target.column === undefined) {
			throw new Error(
				`component registry: '${descriptor.model}' aliases '${descriptor.alias}', which stores no data (no column)`,
			);
		}
	}
	return map;
}

/** Look up a component model's descriptor. Undefined for non-component models. */
export function getComponentModel(model: string): ComponentModel | undefined {
	return REGISTRY.get(model);
}

/** All registered descriptors (used by the coverage/equivalence test). */
export function allComponentModels(): readonly ComponentModel[] {
	return ALL_DESCRIPTORS;
}

/**
 * Canonical descriptor for a model, following one alias hop (the registry
 * integrity check guarantees alias targets are canonical + storable, so one
 * hop is total). Undefined for unregistered models.
 */
function resolveCanonical(model: string): ComponentModel | undefined {
	const descriptor = REGISTRY.get(model);
	if (descriptor?.alias === undefined) return descriptor;
	return REGISTRY.get(descriptor.alias);
}

/**
 * NON-relation SQO builder family for a model (search/conform.ts dispatch,
 * S2-26). Alias models search as their canonical target. Undefined =
 * unsearchable through conform (the caller throws loudly).
 */
export function getSearchBuilderFamily(model: string): ComponentModel['searchBuilder'] {
	return resolveCanonical(model)?.searchBuilder;
}

/** Flat display-value family (relation_list grid cells). Alias-following. */
export function getFlatValueFamily(model: string): ComponentModel['flatValue'] {
	return resolveCanonical(model)?.flatValue;
}

/**
 * PHP component_common::$components_monovalue membership — THE value law
 * (`monovalue` facet, alias-following): only element 0 of the data array is
 * ever read. Consulted by save_component.ts (insert REPLACES, id-less update
 * of the one item replaces) and tool_propagate_component_data (`add` refused).
 */
export function isMonovalueModel(model: string): boolean {
	return resolveCanonical(model)?.monovalue === true;
}

/**
 * The model's ITEM GATE (`itemGate` facet, alias-following): the id of the
 * model-specific gate saveComponentData runs over the final items of a save, or
 * undefined for a model with none. Read by section/record/item_gates.ts.
 */
export function getItemGate(model: string): ItemGateId | undefined {
	return resolveCanonical(model)?.itemGate;
}

/**
 * PHP lang-slice gate — supports_translation && !is_relation (PHP
 * update_data_value :4110-4126/:4169-4180 conditions): only the literal
 * translation-supporting CLASSES (classSupportsTranslation, PHP
 * component_string_common subclasses + iri) slice their data by language;
 * relation/locator classes never do. The ontology `translatable` flag alone
 * would mis-slice: an ontology-non-translatable input_text still slices, on the
 * lg-nolan lang PHP normalizes to at instantiation (__construct :677; read-path
 * twin: resolve/component_data.ts effective-lang rule).
 *
 * THE one definition: the save path (save_component.ts re-exports it), the
 * temporal door, the composed time-machine image of a dataframe main
 * (relations/dataframe_slots.ts `mainIdentity`) and the bulk revert all slice
 * with it — two copies would drift into two notions of "the current language".
 */
export function isLangSlicedModel(model: string): boolean {
	const descriptor = getComponentModel(model);
	return descriptor?.classSupportsTranslation === true && descriptor.resolveData === undefined;
}

/**
 * The value's RENDER CLASS at the client DOM boundary (`render` facet,
 * alias-following — see types.ts RenderClass). THE key the render-boundary
 * escaper switches on: 'html' is the ONLY class whose value is stored as
 * markup, so it is ALSO the class save_component.ts sanitizes on the way in.
 * A canonical model without the facet throws: an undeclared class would have
 * to be guessed, and a guess of 'html' is stored XSS while a guess of 'text'
 * silently defaces a rich-text model — neither is a default this engine takes.
 */
export function getRenderClass(model: string): RenderClass {
	return renderClassOfDescriptor(resolveCanonical(model), model);
}

/**
 * The pure half of getRenderClass: the class of an already-resolved CANONICAL
 * descriptor (undefined = unregistered). Exported so the class-less refusal
 * can be gated with a fabricated descriptor — every live canonical model
 * declares the facet, so no registered name exercises that branch.
 */
export function renderClassOfDescriptor(
	canonical: ComponentModel | undefined,
	model: string,
): RenderClass {
	if (canonical === undefined) {
		throw new DedaloError('internal.invariant', {
			message: `component registry: no descriptor for model '${model}' (render class)`,
			coordinates: { module: 'components/registry', model },
		});
	}
	if (canonical.render === undefined) {
		throw new DedaloError('internal.invariant', {
			message: `component registry: '${canonical.model}' declares no render class (descriptor \`render\` facet)`,
			coordinates: { module: 'components/registry', model: canonical.model },
		});
	}
	return canonical.render;
}

/**
 * The model's CSV-import APPEND policy (`importAppend` facet, alias-following
 * — see types.ts ImportAppendPolicy): 'items' / 'geo_layer' /
 * 'text_paragraphs', or `{ refuse: reason }`. Read by the
 * tool_import_dedalo_csv column resolver (refuses before any write) and by
 * saveComponentData's `appendImport` backstop. A canonical model without the
 * facet throws: guessing 'items' would append to a single-choice model, and
 * guessing a refusal would hide a capability.
 */
export function getImportAppendPolicy(model: string): ImportAppendPolicy {
	return importAppendOfDescriptor(resolveCanonical(model), model);
}

/**
 * The pure half of getImportAppendPolicy (same shape as
 * renderClassOfDescriptor): exported so the facet-less refusal can be gated
 * with a fabricated descriptor — every live canonical model declares it.
 */
export function importAppendOfDescriptor(
	canonical: ComponentModel | undefined,
	model: string,
): ImportAppendPolicy {
	if (canonical === undefined) {
		throw new DedaloError('internal.invariant', {
			message: `component registry: no descriptor for model '${model}' (import append policy)`,
			coordinates: { module: 'components/registry', model },
		});
	}
	if (canonical.importAppend === undefined) {
		throw new DedaloError('internal.invariant', {
			message: `component registry: '${canonical.model}' declares no import append policy (descriptor \`importAppend\` facet)`,
			coordinates: { module: 'components/registry', model: canonical.model },
		});
	}
	return canonical.importAppend;
}

/**
 * Whether the model is DERIVED (`derived` facet, alias-following — see
 * types.ts): it owns no stored value, so its own matrix key is never its value.
 * An unknown model is not derived (it is refused elsewhere, loudly).
 */
export function isDerivedModel(model: string): boolean {
	return resolveCanonical(model)?.derived === true;
}

/** PHP $components_using_value_property membership (CSV import). */
export function usesImportValueProperty(model: string): boolean {
	return resolveCanonical(model)?.importValueProperty === true;
}

/**
 * The model's import parser id (tools/import_conform.ts IMPORT_CONFORM), or
 * undefined when the model has no flat-value form. Alias models import as their
 * canonical target (component_autocomplete → component_portal → 'relation').
 */
export function getImportConformId(model: string): ComponentModel['importConform'] {
	return resolveCanonical(model)?.importConform;
}

/**
 * Every registered model name whose DATA ITEMS are locators — the models that
 * store in the 'relation' matrix column, including legacy alias names whose
 * canonical target does (autocomplete/autocomplete_hi → portal). This is the
 * derived form of PHP component_relation_common::get_components_with_relations
 * (S2-26: propagate matching, relation-shaped value handling).
 */
export function relationDataModels(): string[] {
	const models: string[] = [];
	for (const descriptor of ALL_DESCRIPTORS) {
		if (resolveCanonical(descriptor.model)?.column === 'relation') {
			models.push(descriptor.model);
		}
	}
	return models;
}

// ---------------------------------------------------------------------------
// S2-20 inversion: the ontology resolver consumes two descriptor fields (alias
// map, column map) but must not import this module — that static edge closed
// the 33-file import SCC. Loading THIS module registers the lookup into the
// resolver (the cache_invalidation.ts load-side-effect pattern). Import-path
// rewrites must keep this call a module-load side effect.
// ---------------------------------------------------------------------------
registerComponentModelFieldsLookup((model) => REGISTRY.get(model));
