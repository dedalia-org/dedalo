/**
 * DESCRIPTOR-COMPLETENESS tripwire (S2-26 / DEC-12 — every documented
 * invariant gets a mechanical gate or is deleted from the text).
 *
 * The component registry is the extension story: "add a model = write a
 * descriptor". That story is only as honest as the facets a descriptor is
 * FORCED to declare. This gate makes the requirements mechanical:
 *
 *  1. every registered descriptor names a storage route (column or alias);
 *  2. every canonical relation-column model declares its full relation face
 *     (resolveData + search + defaultRelationType, minus the ledgered
 *     PHP-component_common exception);
 *  3. facet placement is coherent (searchBuilder families match their matrix
 *     column; relation-only facets never appear on non-relation models; every
 *     declared `targetSource` id is bound to a real implementation, and the one
 *     model whose target CANNOT be written into its node declares one);
 *  4. the derived engine sets (CSV import value-property, propagate's
 *     relation set) still equal the PHP oracle lists — a descriptor edit
 *     that silently changes an engine set fails HERE, with the diff visible;
 *  5. every canonical non-relation model has made an EXPLICIT search
 *     decision: declare a searchBuilder family or appear in the ledgered
 *     unsearchable list below. Adding a model without deciding fails;
 *  6. every canonical model declares its CSV-import APPEND policy
 *     (`importAppend`), and the placement laws hold (media / derived /
 *     no-import models refuse with a reason, no monovalue model appends
 *     items, 'geo_layer' / 'text_paragraphs' stay on their one model family);
 *  7. the ontology-node model rule `ontologyTranslatable` (OPTIONAL — omitted =
 *     no rule; see its doc in components/types.ts) is stated by EXACTLY the
 *     owner-approved set (component_iri, 2026-11-11), on canonical descriptors
 *     only, and the ontology layer reads it alias-following through the
 *     resolver seam (getComponentModelNodeRules) — dropping it silently would
 *     disarm the health check's model rule.
 *
 * ALLOWLIST LIFECYCLE (DEC-12 refinement — who clears these and when):
 * entries here are cleared by whoever ports the missing behavior, in the
 * same commit that adds the facet/builder; the list may only shrink.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	allComponentModels,
	getComponentModel,
	getFlatValueFamily,
	getImportAppendPolicy,
	getRenderClass,
	getSearchBuilderFamily,
	importAppendOfDescriptor,
	isDerivedModel,
	isMonovalueModel,
	relationDataModels,
	renderClassOfDescriptor,
} from '../../src/core/components/registry.ts';
import type { ComponentModel, ImportAppendPolicy } from '../../src/core/components/types.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { getComponentModelNodeRules } from '../../src/core/ontology/resolver.ts';
import { DATALIST_SOURCE_IMPLEMENTATIONS } from '../../src/core/relations/datalist.ts';
import { TARGET_SOURCE_IMPLEMENTATIONS } from '../../src/core/relations/request_config/target_sources.ts';
import { IMPORT_CONFORM } from '../../src/core/tools/import_conform.ts';
import { VALUE_PROPERTY_MODELS } from '../../src/core/tools/import_data.ts';
import { COMPONENTS_WITH_RELATIONS } from '../../tools/tool_propagate_component_data/server/propagate.ts';

/** searchBuilder family → the matrix column it is allowed to build over. */
const FAMILY_COLUMN: Record<string, string> = {
	string: 'string',
	number: 'number',
	date: 'date',
	iri: 'iri',
	section_id: 'section_id',
	json: 'misc', // component_json stores in the shared `misc` column
};

/**
 * Canonical NON-relation models with NO SQO builder — each is a deliberate,
 * ledgered decision (PHP has no search trait for them either, or the trait is
 * a dedicated unported pipeline). Cleared per entry by the commit that ports
 * its builder and declares `searchBuilder` on the descriptor.
 */
const LEDGERED_UNSEARCHABLE: ReadonlySet<string> = new Set([
	'component_3d', // media — unsearchable in PHP too
	'component_av', // media
	'component_image', // media
	'component_pdf', // media
	'component_svg', // media
	'component_geolocation', // dedicated geo search unported (rewrite/STATUS.md)
	'component_info', // computed display, no stored searchable value
	'component_password', // never searchable (PHP posture)
	'component_filter_records', // row-ACL editor, dedicated semantics
	'component_security_access', // ontology-permission editor
	'component_inverse', // computed backlinks, searched via search_related
]);

/**
 * Canonical relation-column models WITHOUT a class-level default relation
 * type: PHP bases them on component_common (no $default_relation_type), so
 * requiring the facet would fabricate an oracle value. Cleared only if PHP
 * ever grows a default for them.
 */
const NO_DEFAULT_RELATION_TYPE: ReadonlySet<string> = new Set(['component_external']);

/**
 * Relation-COLUMN models whose emission is NOT a relation resolution, so
 * `resolveData` would be a lie (2026-08-05).
 *
 * `component_external`'s value is DERIVED from a third-party API at read time —
 * PHP's component_external extends component_common and its get_dato() never
 * reads a column; there is no matrix row anywhere for an external section
 * (zenon1: zero rows, no `matrix_zenon`). It carried `resolveData: 'portal'`
 * until this entry landed, which routed it into expandPortal — a function that
 * reads `record.columns.relation[<tipo>]` and returns early on an empty bag, so
 * the model emitted ZERO items always. Emission now belongs to
 * `emitHook: 'external'`, which section/read.ts consults BEFORE the relation
 * branch. The `column: 'relation'` declaration stays as inert column-map parity
 * (see the descriptor header); dropping it would also drop the model's search
 * face, which the search dispatcher depends on.
 *
 * Cleared only if a model here ever gains a real relation resolution — never by
 * re-adding a resolver that resolves nothing.
 */
const NO_RESOLVE_DATA: ReadonlySet<string> = new Set(['component_external']);

/**
 * Relation-COLUMN models that must NEVER be written from an import
 * (2026-08-05). A DERIVED field has no importable form: the value lives in a
 * remote service and the local record has no slot for it, so EVERY cell shape
 * must be REFUSED — which is exactly what omitting the facet does. A flat cell
 * hits conformImportData's no-facet tail ("IGNORED: '<model>' has no
 * flat-value import form"); a JSON or empty cell hits the derived-field check
 * ahead of it (a RELATION-column model with no facet — the shape this set and
 * the test below make exact). Nothing is written, and the record's existing
 * value is left untouched. Behaviour gated in external_degradation_tripwire.
 *
 * This list may only SHRINK if a model stops being derived, which is a change
 * of model, not of import support.
 */
const NO_IMPORT_CONFORM: ReadonlySet<string> = new Set(['component_external']);

/**
 * PHP get_sortable() → false, resolved per CANONICAL model (component_media_common
 * / component_relation_common / geolocation / info / security_access). The alias
 * models inherit their canonical target's value via getModelByTipo
 * (calculation/state → info → false; autocomplete → portal → true; security_tools
 * → check_box → true), so ONLY canonical models declare the facet. Every model
 * NOT listed here is sortable by omission (component_common base = true). Cleared
 * only if PHP flips a model's get_sortable. Pins buildCore's resolveSortable.
 */
const PHP_NON_SORTABLE_CANONICAL = [
	'component_3d',
	'component_av',
	'component_geolocation',
	'component_image',
	'component_info',
	'component_pdf',
	'component_relation_children',
	'component_relation_index',
	'component_security_access',
	'component_svg',
].sort();

/** PHP component_common::$components_using_value_property — the oracle pin. */
const PHP_VALUE_PROPERTY_MODELS = [
	'component_email',
	'component_filter_records',
	'component_info',
	'component_input_text',
	'component_json',
	'component_number',
	'component_password',
	'component_text_area',
].sort();

/** PHP component_relation_common::get_components_with_relations() — oracle pin. */
const PHP_COMPONENTS_WITH_RELATIONS = [
	'component_autocomplete',
	'component_autocomplete_hi',
	'component_check_box',
	'component_dataframe',
	'component_filter',
	'component_filter_master',
	'component_inverse',
	'component_portal',
	'component_publication',
	'component_radio_button',
	'component_relation_children',
	'component_relation_index',
	'component_relation_model',
	'component_relation_parent',
	'component_relation_related',
	'component_relation_struct',
	'component_select',
	'component_select_lang',
].sort();

/**
 * DERIVED-value canonical models the descriptor facts below do NOT name: no
 * stored value of their own (computed at read time, computed backlinks, or a
 * remote service). An EXTRA list only — the derived set is computed from the
 * descriptors (derivedValueModels), so a new computed model is caught by its
 * facts, not by someone remembering to list it here.
 */
const DERIVED_VALUE_MODELS: ReadonlySet<string> = new Set([
	'component_external',
	'component_info',
	'component_inverse',
]);

/** Emit hooks that OWN the value (it is produced at emit time, never read from a column). */
const DERIVED_EMIT_HOOKS: ReadonlySet<string> = new Set(['external', 'info']);

/**
 * Relation resolvers that COMPUTE the component's data as an inverse question
 * (who declares me as parent / who points at me) — edit + list never read the
 * component's own column, so a stored locator there is never served.
 */
const COMPUTED_INVERSE_RESOLVERS: ReadonlySet<string> = new Set([
	'relation_children',
	'relation_index',
]);

/**
 * THE append-policy map of record (canonical models only): 'refuse' stands for
 * any `{ refuse }`. A descriptor edit that changes a model's policy fails here
 * with the diff visible — widening append to a model is a deliberate decision
 * (tool_import_dedalo_csv + saveComponentData must support it), never a
 * side effect.
 */
const IMPORT_APPEND_POLICY_MAP: Record<
	string,
	'items' | 'geo_layer' | 'text_paragraphs' | 'refuse'
> = {
	component_3d: 'refuse',
	component_av: 'refuse',
	component_check_box: 'items',
	component_dataframe: 'items',
	component_date: 'items',
	component_email: 'items',
	component_external: 'refuse',
	component_filter: 'items',
	component_filter_master: 'items',
	component_filter_records: 'refuse',
	component_geolocation: 'geo_layer',
	component_image: 'refuse',
	component_info: 'refuse',
	component_input_text: 'items',
	component_inverse: 'refuse',
	component_iri: 'items',
	component_json: 'refuse',
	component_number: 'items',
	component_password: 'refuse',
	component_pdf: 'refuse',
	component_portal: 'items',
	component_publication: 'refuse',
	component_radio_button: 'refuse',
	component_relation_children: 'refuse',
	component_relation_index: 'refuse',
	component_relation_model: 'refuse',
	component_relation_parent: 'items',
	component_relation_related: 'items',
	component_section_id: 'refuse',
	component_security_access: 'refuse',
	component_select: 'refuse',
	component_select_lang: 'refuse',
	component_svg: 'refuse',
	component_text_area: 'text_paragraphs',
};

function appendKind(
	policy: ImportAppendPolicy,
): 'items' | 'geo_layer' | 'text_paragraphs' | 'refuse' {
	return typeof policy === 'string' ? policy : 'refuse';
}

/** A descriptor is CANONICAL when it is not an alias-only/alias-carrying stub. */
/**
 * Computed-value models that do NOT carry the `derived` facet, each with the
 * reason it was audited out. The facet means "the stored key is never the
 * value" (types.ts) — consumers SKIP or REFUSE the key — so a model whose
 * stored bytes ARE read must stay out of it. SHRINK-ONLY.
 */
const NOT_DERIVED_BY_FACET: Readonly<Record<string, string>> = {
	component_info:
		'owner decision T1-2 D3 open: its stored misc is never served (WC-2026-09-03 — no observer writes it, the read and export compute live) but the facet also flips update_cache / CSV-import refusal; the export/D4/diffusion consumers key on its `info` flatValue family meanwhile',
};

/** The derived-value models, read from the descriptor FACTS (+ the extra hand list). */
function computedDerivedModels(descriptors: readonly ComponentModel[]): Set<string> {
	const derived = new Set(DERIVED_VALUE_MODELS);
	for (const descriptor of descriptors) {
		if (!isCanonical(descriptor)) continue;
		if (descriptor.emitHook !== undefined && DERIVED_EMIT_HOOKS.has(descriptor.emitHook)) {
			derived.add(descriptor.model);
		}
		if (
			descriptor.resolveData !== undefined &&
			COMPUTED_INVERSE_RESOLVERS.has(descriptor.resolveData)
		) {
			derived.add(descriptor.model);
		}
	}
	return derived;
}

function isCanonical(descriptor: { alias?: string }): boolean {
	return descriptor.alias === undefined;
}

describe('descriptor completeness (S2-26 tripwire)', () => {
	const descriptors = allComponentModels();

	test('every descriptor names a storage route (column or alias)', () => {
		for (const descriptor of descriptors) {
			expect(
				descriptor.column !== undefined || descriptor.alias !== undefined,
				`${descriptor.model}: declares neither column nor alias`,
			).toBe(true);
		}
	});

	test('canonical relation models declare the full relation face', () => {
		for (const descriptor of descriptors) {
			if (!isCanonical(descriptor) || descriptor.column !== 'relation') continue;
			if (NO_RESOLVE_DATA.has(descriptor.model)) {
				// Derived-value models: a resolver here resolved nothing (see the set).
				expect(
					descriptor.resolveData,
					`${descriptor.model}: NO_RESOLVE_DATA model declares a resolver again`,
				).toBeUndefined();
				expect(
					descriptor.emitHook,
					`${descriptor.model}: a model with no resolver MUST own its emission (emitHook)`,
				).toBeDefined();
			} else {
				expect(
					descriptor.resolveData,
					`${descriptor.model}: relation model without resolveData`,
				).toBeDefined();
			}
			expect(
				descriptor.search,
				`${descriptor.model}: relation model without search face`,
			).toBeDefined();
			if (descriptor.search?.status === 'unported') {
				expect(
					typeof descriptor.search.reason === 'string' && descriptor.search.reason.length > 0,
					`${descriptor.model}: unported search without a ledgered reason`,
				).toBe(true);
			}
			if (!NO_DEFAULT_RELATION_TYPE.has(descriptor.model)) {
				expect(
					descriptor.defaultRelationType,
					`${descriptor.model}: relation model without defaultRelationType (PHP class default)`,
				).toMatch(/^dd\d+$/);
			}
		}
	});

	/**
	 * T0-9 (G7): a relation-column model WITHOUT a flat-value family has no
	 * export 'value' / panel / Referencias text at all — resolveCellValue never
	 * reaches the datalist branch and the column ships blank (filter,
	 * publication, select_lang, relation_parent/children/related/index were all
	 * blank on 2026-11-11). Exempt: the external family (its value is derived
	 * from a remote row, flatValue 'external') and component_dataframe (a frame
	 * is folded INTO its main's cell, never a column of its own). Aliases are
	 * resolved through the registry (getFlatValueFamily follows one hop).
	 */
	test('every relation-column model declares a flat-value family (T0-9)', () => {
		const NO_FLAT_VALUE_EXEMPT: ReadonlySet<string> = new Set([
			'component_external',
			'component_dataframe',
		]);
		const checked: string[] = [];
		const missing: string[] = [];
		for (const descriptor of descriptors) {
			if (descriptor.column !== 'relation') continue;
			if (NO_FLAT_VALUE_EXEMPT.has(descriptor.model)) continue;
			if (getFlatValueFamily(descriptor.model) === 'external') continue;
			checked.push(descriptor.model);
			if (getFlatValueFamily(descriptor.model) === undefined) missing.push(descriptor.model);
		}
		// floor: the census really walked the relation family
		expect(checked.length).toBeGreaterThanOrEqual(10);
		expect(missing.sort(), 'relation-column models without flatValue').toEqual([]);
	});

	/**
	 * T0-9 (G7) widened 2026-11-11 (WC-2026-11-11-export-inverse-callers): ANY
	 * canonical model can be an export LEAF (a ddo path ends on whatever
	 * component the user picks), and a leaf whose model declares no flat-value
	 * family resolves to a ledgered null in every value cell. component_inverse
	 * (column `misc`, DERIVED) sat outside the relation-column census above, so
	 * its column shipped blank. The census is now EVERY canonical model; the
	 * models that still declare no family are named below WITH the reason, and
	 * the list may only shrink (an entry that gained a family is stale → red).
	 * Relation-column and DERIVED models may never be exempted for "unported":
	 * their exemptions are structural (a frame is folded into its main; the
	 * external family is checked by its own 'external' family).
	 */
	const NO_FLAT_VALUE_LEAF_EXEMPT: ReadonlyMap<string, string> = new Map([
		[
			'component_dataframe',
			'a frame is folded INTO its main’s cell, never a value column of its own (dedalo_raw mints its slot column from the stored slice)',
		],
		[
			'component_geolocation',
			'no flat text value: geo exports through its own geo / geojson diffusion functions; the value cell is ledgered unresolved',
		],
		[
			'component_json',
			'an opaque config blob: no flat text value; the value cell is ledgered unresolved (dedalo_raw exports the stored slice)',
		],
		[
			'component_password',
			'a secret: never exported as a value (the tool_export client excludes it from the pickable elements)',
		],
		[
			'component_security_access',
			'an ACL matrix blob (misc column): no flat text value; ledgered unresolved',
		],
		[
			'component_filter_records',
			'a saved record-filter blob (misc column): no flat text value; ledgered unresolved',
		],
	]);

	/** The canonical models with no flat-value family, minus the named exemptions. */
	function leafModelsWithoutFlatValue(
		models: readonly ComponentModel[],
		familyOf: (model: string) => string | undefined,
	): { checked: string[]; missing: string[] } {
		const checked: string[] = [];
		const missing: string[] = [];
		for (const descriptor of models) {
			if (!isCanonical(descriptor)) continue; // an alias resolves through its target
			if (NO_FLAT_VALUE_LEAF_EXEMPT.has(descriptor.model)) continue;
			checked.push(descriptor.model);
			if (familyOf(descriptor.model) === undefined) missing.push(descriptor.model);
		}
		return { checked, missing: missing.sort() };
	}

	test('every canonical model the export reaches as a LEAF declares a flat-value family (T0-9, derived included)', () => {
		const { checked, missing } = leafModelsWithoutFlatValue(descriptors, getFlatValueFamily);
		expect(missing, 'canonical leaf models without flatValue (and not exempted)').toEqual([]);
		// floor: the census walked every relation-column AND every derived model
		const mustCover = descriptors
			.filter(
				(d) =>
					isCanonical(d) &&
					(d.column === 'relation' || isDerivedModel(d.model)) &&
					d.model !== 'component_dataframe',
			)
			.map((d) => d.model)
			.sort();
		expect(mustCover).toContain('component_inverse');
		expect(mustCover.filter((model) => !checked.includes(model))).toEqual([]);
		expect(checked.length).toBeGreaterThanOrEqual(25);
	});

	test('the leaf exemptions are live, reasoned, and never cover a derived or relation model by "unported"', () => {
		for (const [model, reason] of NO_FLAT_VALUE_LEAF_EXEMPT) {
			const descriptor = getComponentModel(model);
			expect(descriptor, `${model}: exempted but not registered`).toBeDefined();
			expect(isCanonical(descriptor as ComponentModel), `${model}: exempt alias`).toBe(true);
			// shrink-only: a model that gained a family must leave the list
			expect(getFlatValueFamily(model), `${model}: exempt but declares a family — stale`).toBe(
				undefined,
			);
			expect(reason.length, `${model}: exemption without a reason`).toBeGreaterThan(20);
			expect(isDerivedModel(model), `${model}: a DERIVED model may not be exempted`).toBe(false);
			// the ONE structural relation-column exemption: a frame folds into its main
			if (model !== 'component_dataframe') {
				expect(
					(descriptor as ComponentModel).column,
					`${model}: a RELATION-column model may not be exempted`,
				).not.toBe('relation');
			}
		}
	});

	test('positive control: component_inverse WITHOUT its flatValue reddens the leaf census', () => {
		const real = leafModelsWithoutFlatValue(descriptors, getFlatValueFamily).missing;
		const { missing } = leafModelsWithoutFlatValue(descriptors, (model) =>
			model === 'component_inverse' ? undefined : getFlatValueFamily(model),
		);
		// exactly one more model missing than the real census: component_inverse
		expect(missing.filter((model) => !real.includes(model))).toEqual(['component_inverse']);
	});

	test('relation-only facets never appear on non-relation models', () => {
		for (const descriptor of descriptors) {
			if (descriptor.column === 'relation') continue;
			if (!isCanonical(descriptor)) continue; // alias stubs carry nothing
			expect(
				descriptor.resolveData,
				`${descriptor.model}: resolveData on non-relation model`,
			).toBeUndefined();
			expect(
				descriptor.search,
				`${descriptor.model}: search face on non-relation model`,
			).toBeUndefined();
			expect(
				descriptor.defaultRelationType,
				`${descriptor.model}: defaultRelationType on non-relation model`,
			).toBeUndefined();
			expect(
				descriptor.flatValue === 'datalist' ? descriptor.model : undefined,
				`${descriptor.model}: flatValue 'datalist' needs a datalist (relation) model`,
			).toBeUndefined();
		}
	});

	test('searchBuilder families match their matrix column, never relation', () => {
		for (const descriptor of descriptors) {
			if (descriptor.searchBuilder === undefined) continue;
			expect(
				descriptor.column,
				`${descriptor.model}: searchBuilder '${descriptor.searchBuilder}' on column '${descriptor.column}'`,
			).toBe(FAMILY_COLUMN[descriptor.searchBuilder]);
		}
	});

	test('calculationData is never declared on a relation-column model (derived) nor an alias', () => {
		// components/registry.ts getCalculationDataId DERIVES `relation` from
		// column === 'relation'; a declared facet there would shadow the walk.
		// Aliases inherit their canonical model's facet.
		const declared = descriptors.filter((descriptor) => descriptor.calculationData !== undefined);
		expect(declared.map((descriptor) => descriptor.model).sort()).toEqual([
			'component_date',
			'component_info',
			'component_number',
		]);
		for (const descriptor of declared) {
			expect(
				descriptor.column,
				`${descriptor.model}: calculationData on a relation column`,
			).not.toBe('relation');
			expect(descriptor.alias, `${descriptor.model}: calculationData on an alias`).toBeUndefined();
		}
	});

	test('every canonical non-relation model made an explicit search decision', () => {
		for (const descriptor of descriptors) {
			if (!isCanonical(descriptor) || descriptor.column === 'relation') continue;
			const decided =
				descriptor.searchBuilder !== undefined || LEDGERED_UNSEARCHABLE.has(descriptor.model);
			expect(
				decided,
				`${descriptor.model}: no searchBuilder and not in the LEDGERED_UNSEARCHABLE list — decide and declare`,
			).toBe(true);
		}
	});

	test('the ledgered-unsearchable list carries no dead entries', () => {
		for (const model of LEDGERED_UNSEARCHABLE) {
			const descriptor = getComponentModel(model);
			expect(
				descriptor,
				`LEDGERED_UNSEARCHABLE: '${model}' is not a registered model`,
			).toBeDefined();
			expect(
				descriptor?.searchBuilder,
				`LEDGERED_UNSEARCHABLE: '${model}' now declares a searchBuilder — remove the ledger entry`,
			).toBeUndefined();
		}
	});

	test('alias models search as their canonical target', () => {
		expect(getSearchBuilderFamily('component_html_text')).toBe('string');
		expect(getSearchBuilderFamily('component_input_text_large')).toBe('string');
		// autocomplete aliases resolve to portal — a relation model, no family.
		expect(getSearchBuilderFamily('component_autocomplete')).toBeUndefined();
	});

	test('derived CSV value-property set equals the PHP oracle list', () => {
		expect([...VALUE_PROPERTY_MODELS].sort()).toEqual(PHP_VALUE_PROPERTY_MODELS);
	});

	test('every importConform facet names a real parser', () => {
		// The facet is DATA (an id), so a typo would otherwise fail at import time on
		// one unlucky cell — in the middle of a 10k-row run — rather than at boot.
		for (const descriptor of descriptors) {
			if (descriptor.importConform === undefined) continue;
			expect(
				Object.hasOwn(IMPORT_CONFORM, descriptor.importConform),
				`${descriptor.model} names an import parser that does not exist: '${descriptor.importConform}'`,
			).toBe(true);
		}
	});

	test('every targetSource facet names a real implementation', () => {
		// Same idiom as importConform above, and the same failure mode it heads
		// off: the facet is DATA (an id), so a typo would not surface at boot but
		// inside a request — `TARGET_SOURCE_IMPLEMENTATIONS[<bad id>]` is
		// `undefined` and calling it throws in the middle of a config build, i.e.
		// one dead widget on one section, reported as an engine crash.
		//
		// There is deliberately NO dead-implementation twin of this test (the
		// `no parser in IMPORT_CONFORM is dead` shape): a target-source id is also
		// an sqo source name an ontology node may request explicitly
		// (`{"source":"section_model"}`, request_config/explicit.ts
		// KNOWN_SQO_SOURCES), so an implementation no DESCRIPTOR claims is a
		// legitimate ontology-only rule, not dead code.
		for (const descriptor of descriptors) {
			if (descriptor.targetSource === undefined) continue;
			expect(
				Object.hasOwn(TARGET_SOURCE_IMPLEMENTATIONS, descriptor.targetSource),
				`${descriptor.model} names a target source that has no implementation: '${descriptor.targetSource}'`,
			).toBe(true);
		}
	});

	test('every datalistSource facet names a real implementation', () => {
		// Same idiom as targetSource: the facet is DATA, so a typo would surface
		// only inside a request — as the GENERIC enumeration silently answering
		// for a model whose options are something else (component_select_lang
		// once served all ~21.7k lg1 records on every save echo that way).
		for (const descriptor of descriptors) {
			if (descriptor.datalistSource === undefined) continue;
			expect(
				Object.hasOwn(DATALIST_SOURCE_IMPLEMENTATIONS, descriptor.datalistSource),
				`${descriptor.model} names a datalist source that has no implementation: '${descriptor.datalistSource}'`,
			).toBe(true);
		}
	});

	test('component_select_lang declares the option source its node cannot state', () => {
		// Its node's sqo names lg1 — every language record there is. Its options
		// are the PROJECT languages (PHP component_select_lang::get_list_of_values),
		// which only the descriptor can say. The outcome gate is
		// select_family_echo_datalist_native.test.ts.
		expect(
			descriptors.find((descriptor) => descriptor.model === 'component_select_lang')
				?.datalistSource,
		).toBe('project_langs');
	});

	test('component_relation_model declares the target source its node cannot state', () => {
		// This model exists BECAUSE its target is caller-dependent: ONE node
		// (hierarchy27 "Tipología") is reused by every hierarchy's virtual section
		// and must point at that caller's MODEL section — testgeoa1 → testgeoa2, testgeob1 → testgeob2,
		// mht72 → ww2 — which no per-node sqo can express. Its shipped ontology
		// admits as much: `sqo.section_tipo: []` plus an `_info` note saying the
		// value "is calculated in class" (PHP computed it in a class override, v6
		// class.component_relation_model.php:115-177).
		//
		// Drop this one line and every consumer silently resolves NO target —
		// empty select in edit, blank list column, `target_sections: []` on the
		// wire, CSV import refusing the column — and nothing else in the suite
		// goes red, which is precisely why the declaration is pinned here.
		expect(
			getComponentModel('component_relation_model')?.targetSource,
			'component_relation_model without its targetSource: the options of every hierarchy Tipología resolve nowhere',
		).toBe('section_model');
	});

	test('every relation-column model declares an import parser', () => {
		// PHP gives EVERY relation component conform_import_data by class inheritance
		// (component_relation_common). A relation model without the facet would refuse
		// every flat section_id list ('273,418') — a silent capability hole, which is
		// exactly the class of bug this tripwire family exists to prevent.
		// EXCEPT the derived-value models (NO_IMPORT_CONFORM), for which the
		// refusal is the CORRECT behavior, not a hole.
		const missing = descriptors
			.filter((d) => d.alias === undefined && d.column === 'relation')
			.filter((d) => d.importConform === undefined && !NO_IMPORT_CONFORM.has(d.model))
			.map((d) => d.model);
		expect(missing).toEqual([]);
	});

	test('the derived-value exemption sets carry no dead entries', () => {
		for (const model of [...NO_RESOLVE_DATA, ...NO_IMPORT_CONFORM, ...NO_DEFAULT_RELATION_TYPE]) {
			expect(
				getComponentModel(model),
				`exemption names an unregistered model: '${model}'`,
			).toBeDefined();
		}
		for (const model of NO_IMPORT_CONFORM) {
			expect(
				getComponentModel(model)?.importConform,
				`NO_IMPORT_CONFORM: '${model}' declares an import parser again — a derived field must never be written from an import`,
			).toBeUndefined();
		}
	});

	test('no parser in IMPORT_CONFORM is dead (every id is claimed by a descriptor)', () => {
		const claimed = new Set(
			descriptors.map((d) => d.importConform).filter((id) => id !== undefined),
		);
		const dead = Object.keys(IMPORT_CONFORM).filter((id) => !claimed.has(id as never));
		expect(dead).toEqual([]);
	});

	test('derived propagate relation set equals the PHP oracle list', () => {
		expect([...COMPONENTS_WITH_RELATIONS].sort()).toEqual(PHP_COMPONENTS_WITH_RELATIONS);
	});

	test('descriptor sortable:false set equals the PHP get_sortable() oracle', () => {
		const declaredFalse = descriptors
			.filter((d) => d.sortable === false)
			.map((d) => d.model)
			.sort();
		expect(declaredFalse).toEqual(PHP_NON_SORTABLE_CANONICAL);
	});

	test('no descriptor declares sortable:true (omitted = true is the base)', () => {
		for (const descriptor of descriptors) {
			expect(
				descriptor.sortable,
				`${descriptor.model}: sortable:true is redundant — omit it (component_common base is true)`,
			).not.toBe(true);
		}
	});

	// ------------------------------------------------------------------
	// RENDER CLASS (P2-6 / CARRY-01): the render-boundary escaper's key.
	// ------------------------------------------------------------------

	test('every column-bearing descriptor declares a render class, and alias stubs never do', () => {
		// canonical = column-bearing AND not an alias (component_autocomplete_hi
		// keeps a defensive column entry but resolves through its alias)
		const withColumn = descriptors.filter((d) => d.column !== undefined && d.alias === undefined);
		expect(withColumn.length).toBeGreaterThan(30); // anti-vacuity: the canonical models
		for (const descriptor of withColumn) {
			expect(
				descriptor.render,
				`${descriptor.model}: a model that stores a value must say how the client may render it (\`render\` facet)`,
			).toBeDefined();
			expect(['text', 'html', 'url', 'number']).toContain(descriptor.render as string);
		}
		for (const descriptor of descriptors.filter((d) => d.alias !== undefined)) {
			expect(
				descriptor.render,
				`${descriptor.model}: an alias inherits its canonical target's render class — declaring one here would let the two disagree`,
			).toBeUndefined();
			// and the alias hop resolves to a class
			expect(getRenderClass(descriptor.model)).toBe(getRenderClass(descriptor.alias as string));
		}
	});

	test("'html' is declared by the rich-text model ONLY — it is the one class the sanitizer runs on", () => {
		// Adding a model here is the decision to store markup: save_component.ts
		// sanitizes by this facet, and the client passes the class through unescaped.
		const html = descriptors.filter((d) => d.render === 'html').map((d) => d.model);
		expect(html).toEqual(['component_text_area']);
		expect(getRenderClass('component_html_text')).toBe('html'); // legacy alias, via the hop
		expect(getRenderClass('component_input_text_large')).toBe('html');
	});

	test("'url' is component_iri, 'number' is component_number; everything else is text", () => {
		expect(descriptors.filter((d) => d.render === 'url').map((d) => d.model)).toEqual([
			'component_iri',
		]);
		expect(descriptors.filter((d) => d.render === 'number').map((d) => d.model)).toEqual([
			'component_number',
		]);
		const text = descriptors.filter((d) => d.render === 'text').length;
		expect(text).toBe(
			descriptors.filter((d) => d.column !== undefined && d.alias === undefined).length - 3,
		);
	});

	test('ontologyTranslatable is stated by EXACTLY the owner-approved models, canonical only', () => {
		const stating = descriptors.filter((d) => d.ontologyTranslatable !== undefined);
		expect(stating.map((d) => d.model)).toEqual(['component_iri']);
		for (const descriptor of stating) {
			expect(isCanonical(descriptor), `${descriptor.model}: an alias stub states no rule`).toBe(
				true,
			);
			expect(descriptor.ontologyTranslatable).toBe(false);
		}
	});

	test('the ontology layer reads the node rule through the resolver seam, alias-following', () => {
		expect(getComponentModelNodeRules('component_iri')?.ontologyTranslatable).toBe(false);
		expect(getComponentModelNodeRules('component_input_text')?.ontologyTranslatable).toBe(
			undefined,
		);
		// An alias stub is ruled by its canonical model: no alias may dodge a rule.
		for (const alias of descriptors.filter((d) => d.alias !== undefined)) {
			expect(getComponentModelNodeRules(alias.model)?.ontologyTranslatable).toBe(
				getComponentModel(alias.alias as string)?.ontologyTranslatable,
			);
		}
		expect(getComponentModelNodeRules('section')).toBe(undefined);
	});

	test('getRenderClass throws on an unregistered model (no silent default)', () => {
		expect(() => getRenderClass('component_no_such_model')).toThrow(/no descriptor/);
	});

	test('a class-less canonical descriptor is REFUSED, never defaulted to text', () => {
		// no live canonical model lacks the facet (asserted above), so the branch
		// is exercised with a fabricated column-bearing descriptor
		const classless = { model: 'component_zz_classless', column: 'string' } as ComponentModel;
		expect(() => renderClassOfDescriptor(classless, 'component_zz_classless')).toThrow(
			/declares no render class/,
		);
		// and a declared one resolves to exactly its declaration
		expect(renderClassOfDescriptor({ ...classless, render: 'url' }, classless.model)).toBe('url');
	});

	// ------------------------------------------------------------------
	// CSV-IMPORT APPEND POLICY (`importAppend` facet, tool_import_dedalo_csv
	// per-column append mode). Every check reads the RESOLVED policy through
	// the accessor, so it measures what the import will do, not a spelling.
	// ------------------------------------------------------------------

	test('every canonical model declares an append policy, and alias stubs never do', () => {
		const canonical = descriptors.filter(isCanonical);
		expect(canonical.length).toBeGreaterThan(30); // anti-vacuity
		for (const descriptor of canonical) {
			expect(
				descriptor.importAppend,
				`${descriptor.model}: a canonical model must decide what an append-mode import column does (\`importAppend\` facet)`,
			).toBeDefined();
		}
		const aliases = descriptors.filter((d) => !isCanonical(d));
		expect(aliases.length).toBeGreaterThan(0);
		for (const descriptor of aliases) {
			expect(
				descriptor.importAppend,
				`${descriptor.model}: an alias inherits its canonical target's append policy — declaring one here would let the two disagree`,
			).toBeUndefined();
			// and the hop resolves to exactly the target's policy
			expect(getImportAppendPolicy(descriptor.model)).toEqual(
				getImportAppendPolicy(descriptor.alias as string),
			);
		}
	});

	test('the append policy of every canonical model equals the map of record', () => {
		const actual: Record<string, string> = {};
		for (const descriptor of descriptors.filter(isCanonical)) {
			actual[descriptor.model] = appendKind(getImportAppendPolicy(descriptor.model));
		}
		expect(actual).toEqual(IMPORT_APPEND_POLICY_MAP);
	});

	test('every append refusal carries a reason', () => {
		for (const descriptor of descriptors.filter(isCanonical)) {
			const policy = getImportAppendPolicy(descriptor.model);
			if (typeof policy === 'string') continue;
			expect(
				typeof policy.refuse === 'string' && policy.refuse.trim().length > 0,
				`${descriptor.model}: an append refusal without a reason — the user sees it verbatim`,
			).toBe(true);
		}
	});

	test('every media model refuses append', () => {
		const media = descriptors.filter((d) => isCanonical(d) && d.column === 'media');
		expect(media.length).toBeGreaterThanOrEqual(5); // 3d, av, image, pdf, svg
		for (const descriptor of media) {
			expect(
				appendKind(getImportAppendPolicy(descriptor.model)),
				`${descriptor.model}: a media model must refuse append`,
			).toBe('refuse');
		}
	});

	test("no monovalue model appends 'items' (only element 0 is ever read)", () => {
		for (const descriptor of descriptors) {
			if (!isMonovalueModel(descriptor.model)) continue;
			expect(
				getImportAppendPolicy(descriptor.model),
				`${descriptor.model}: monovalue — an appended item would be stored and never read`,
			).not.toBe('items');
		}
	});

	test("no model whose CLIENT class is a monovalue model's appends 'items' (the UI reads only entries[0])", () => {
		// A client module that re-exports another component's class verbatim
		// (`export const component_x = component_y`) renders with y's widget. When
		// y is monovalue (a single-choice widget), x is single-choice in the UI
		// whatever its descriptor says — an appended item would be stored, never
		// shown, never editable (component_relation_model → component_select).
		const clientCore = resolve(import.meta.dir, '../../client/dedalo/core');
		let checked = 0;
		for (const descriptor of descriptors) {
			const file = resolve(clientCore, descriptor.model, 'js', `${descriptor.model}.js`);
			if (!existsSync(file)) continue;
			const match = new RegExp(
				`^export\\s+const\\s+${descriptor.model}\\s*=\\s*(component_\\w+)\\s*;?\\s*$`,
				'm',
			).exec(readFileSync(file, 'utf8'));
			const clientClass = match?.[1];
			if (clientClass === undefined || getComponentModel(clientClass) === undefined) continue;
			checked += 1;
			if (!isMonovalueModel(clientClass)) continue;
			expect(
				getImportAppendPolicy(descriptor.model),
				`${descriptor.model}: its client is ${clientClass}'s single-choice widget — an appended item is never shown`,
			).not.toBe('items');
		}
		// anti-vacuity: the relation aliases (model, parent, children, …) are found
		expect(checked).toBeGreaterThanOrEqual(3);
		expect(isMonovalueModel('component_select')).toBe(true);
	});

	test("'geo_layer' is geolocation's alone, 'text_paragraphs' is the html render class's alone", () => {
		for (const descriptor of descriptors) {
			const policy = getImportAppendPolicy(descriptor.model);
			if (policy === 'geo_layer') {
				const canonical = descriptor.alias ?? descriptor.model;
				expect(canonical, `${descriptor.model}: 'geo_layer' outside geolocation`).toBe(
					'component_geolocation',
				);
			}
			if (policy === 'text_paragraphs') {
				expect(
					getRenderClass(descriptor.model),
					`${descriptor.model}: 'text_paragraphs' on a non-html model`,
				).toBe('html');
			}
		}
		// anti-vacuity: both policies are live
		expect(getImportAppendPolicy('component_geolocation')).toBe('geo_layer');
		expect(getImportAppendPolicy('component_text_area')).toBe('text_paragraphs');
		expect(getImportAppendPolicy('component_html_text')).toBe('text_paragraphs'); // via the hop
	});

	test('derived-value and no-import-conform models refuse append', () => {
		// The derived set is READ FROM THE DESCRIPTORS (the facts that make a
		// model derived), the hand list only adds to it.
		const derived = computedDerivedModels(descriptors);
		// Vacuity guard: the derivation must actually find the computed models.
		for (const model of [
			'component_external',
			'component_info',
			'component_inverse',
			'component_relation_children',
			'component_relation_index',
		]) {
			expect(derived.has(model), `derived set lost '${model}'`).toBe(true);
		}
		// Every computed-inverse resolver is bound by at least one canonical model
		// (a renamed resolver id would otherwise silently empty the derivation).
		for (const resolver of COMPUTED_INVERSE_RESOLVERS) {
			expect(
				descriptors.some((d) => isCanonical(d) && d.resolveData === resolver),
				`no canonical model resolves through '${resolver}'`,
			).toBe(true);
		}
		for (const model of [...derived, ...NO_IMPORT_CONFORM]) {
			expect(getComponentModel(model), `'${model}' is not a registered model`).toBeDefined();
			expect(
				appendKind(getImportAppendPolicy(model)),
				`${model}: a model with no stored/importable value must refuse append`,
			).toBe('refuse');
		}
	});

	test('the `derived` facet marks exactly the computed-value models (minus the audited-out), canonical only', () => {
		// The facet's consumers (update_cache skip, the CSV column refusal) treat
		// the model's own stored key as NOT its value — so the facet set is held
		// to the models the descriptor FACTS call computed, never a hand list.
		const computed = computedDerivedModels(descriptors);
		const facet = descriptors
			.filter((d) => isCanonical(d) && d.derived === true)
			.map((d) => d.model)
			.sort();
		expect(facet).toEqual([...computed].filter((m) => !(m in NOT_DERIVED_BY_FACET)).sort());
		// anti-vacuity + no dead audit entries
		expect(facet).toContain('component_relation_children');
		for (const model of Object.keys(NOT_DERIVED_BY_FACET)) {
			expect(computed.has(model), `NOT_DERIVED_BY_FACET: '${model}' is not computed any more`).toBe(
				true,
			);
		}
		// alias stubs inherit through the canonical hop and never declare it
		for (const descriptor of descriptors) {
			if (!isCanonical(descriptor)) expect(descriptor.derived, descriptor.model).toBeUndefined();
		}
		expect(isDerivedModel('component_relation_children')).toBe(true);
		expect(isDerivedModel('component_info')).toBe(false);
		expect(isDerivedModel('component_portal')).toBe(false);
	});

	test('a canonical descriptor without the facet makes the accessor THROW, never default', () => {
		// no live canonical model lacks the facet (asserted above), so the branch
		// is exercised with a fabricated descriptor
		const policyless = {
			model: 'component_zz_policyless',
			column: 'string',
			render: 'text',
		} as ComponentModel;
		let caught: unknown;
		try {
			importAppendOfDescriptor(policyless, policyless.model);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(DedaloError);
		expect((caught as DedaloError).code).toBe('internal.invariant');
		// an unregistered model throws the same invariant
		expect(() => getImportAppendPolicy('component_no_such_model')).toThrow(DedaloError);
		// and a declared one resolves to exactly its declaration
		expect(
			importAppendOfDescriptor({ ...policyless, importAppend: 'items' }, policyless.model),
		).toBe('items');
	});

	test('relationDataModels derivation covers the legacy autocomplete aliases', () => {
		const derived = relationDataModels();
		expect(derived).toContain('component_autocomplete');
		expect(derived).toContain('component_autocomplete_hi');
		expect(derived).toContain('component_portal');
		expect(derived).not.toContain('component_input_text');
	});
});
