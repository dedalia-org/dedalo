/**
 * RECORD BIRTH DEFAULTS — the ontology-declared initial state a record is born
 * with (audit 2026-08_oh1_beta B1 + §5.1).
 *
 * Three seeds, one chokepoint:
 *
 * 1. THE PROJECT LOCATOR (component_filter). The projects ACL filters every
 *    read and every per-record write gate by the record's component_filter
 *    locators. A record created WITHOUT one is outside every non-admin's
 *    scope: invisible in list and search, 403 "Record is out of the user
 *    scope" on save, un-openable, un-deletable. Every PHP-era oh1 record
 *    carries its oh22; TS-created ones did not — that is blocker B1.
 *
 * 2. `properties.dato_default` (PHP component_common::set_data_default,
 *    class.component_common.php:753-869). The ontology declares a component's
 *    initial value (oh21 Quality, oh93 Review status, oh32 publication "No",
 *    the hierarchy colour …). It was implemented NOWHERE in src/, so those
 *    seeds never landed. This is a GENERIC facility keyed off the component's
 *    ontology properties — never a per-model special case.
 *
 * 3. THE ONTOLOGY TLD (`ontology7`, the ONT-TLD invariant — see
 *    ontology/tld.ts requiredOntologyTld). A record of an ontology node section
 *    `<tld>0` MUST declare `ontology7 = <tld>`; without it the record parses to
 *    nothing and never appears in the ontology tree. Like seed 1 and unlike
 *    seed 2, it cannot ride on `dato_default` because it is not a constant —
 *    it is a function of the section.
 *
 * WHAT THIS CHOKEPOINT DOES NOT COVER. Every door that inserts through the
 * engine passes here — the section-list "+", the tree "+", the portal "+",
 * both imports, both MCP write tools, portalize. The
 * COPY-based ontology doors do NOT: ontology/data_io_import.ts and
 * ontology/ontology_update.ts stream rows straight into matrix_ontology with
 * `psql`, bypassing the engine entirely. ONT-TLD is enforced for those by
 * data_io_import's own post-COPY normalizeOntologyTld, and any residue is
 * reported by ontology_state's `tldless` drift. Do not read this module as
 * "every row in the database went through here".
 *
 * WHERE PHP DOES IT, AND WHY WE DO NOT COPY THAT (WC-2026-08-09-record-birth-defaults). PHP seeds on the
 * first EDIT-FORM BUILD: component_common's constructor calls
 * set_data_default() whenever mode='edit' and section_id > 0, so the value is
 * written as a side effect of RENDERING. (The v6 create-time twin,
 * section::set_projects_to_new_section_record, survives in the frozen tree as
 * private DEAD CODE — nothing calls it.) A render side-effect is the wrong
 * chokepoint: it misses every non-rendering door (import, ts_api, MCP, the
 * portal "+"), it writes on read, and it needs its own permission gate because
 * a read-only user can open an edit form. Seeding at the CREATE DOOR covers
 * every door once, at the moment the record's identity is established, by a
 * caller the create gate has already proven may write here.
 *
 * THE FILTER CASCADE (PHP component_filter::get_default_data_for_user,
 * class.component_filter.php:302-470), in PHP's effective order:
 *   - a NON-global-admin with dd170 projects → their FIRST project. (PHP
 *     phrases this as a backstop: "if none of the computed defaults is inside
 *     the user's projects, append the first one" — with tiers 1-2 inert, the
 *     computed set is empty, so the backstop IS the answer.)
 *   - everyone else (global admin, or a non-admin with NO projects) →
 *     DEDALO_DEFAULT_PROJECT / DEDALO_FILTER_SECTION_TIPO_DEFAULT, read
 *     through the typed config. There is no hardcoded locator in this engine.
 *
 * TWO PHP TIERS ARE DELIBERATELY ABSENT, both inert in the frozen oracle:
 *   - CONFIG_DEFAULT_FILE_PATH (a per-install JSON override file): the define
 *     is commented out in every shipped config, so the tier never ran. It has
 *     no config key here; adding one is a feature request, not parity.
 *   - component_filter's own `properties` tier: PHP guards it with
 *     `isset($properties->data_default)` but reads `$properties->dato_default`
 *     — and NO dd_ontology row in any install carries `data_default` (verified
 *     across dedalo7ts/dedalo7_mht: 0 rows vs 44/66 `dato_default` rows). The
 *     branch is unreachable in the oracle, so component_filter resolves
 *     through the cascade above rather than its declared `dato_default`.
 *     Reproducing the typo would be pointless; honouring the property instead
 *     would silently move existing installs' new records into a different
 *     project. Parity wins.
 *
 * NORMALIZATION IS GENERIC — THERE IS NO MODEL WHITELIST. PHP does not persist
 * `dato_default` verbatim: it goes through component_common::set_data
 * (:918-1010), which is model-agnostic and does exactly three things —
 *   (1) a non-object element is wrapped into `{value: …}`;
 *   (2) `lang` is stamped ONLY when the class declares supports_translation
 *       (component_string_common subclasses + component_iri), and only when the
 *       element does not already carry one;
 *   (3) an element without a usable `id` gets one from the per-component
 *       counter (`meta->{tipo}->0->count`),
 * and then hands the element to `validate_data_element`, which has exactly TWO
 * implementations in the whole oracle: the base one (:901) returns it
 * UNCHANGED, and the relation-family one (component_relation_common:1058) fills
 * `type` from the component's relation type, forces `from_component_tipo`,
 * casts section_id to STRING, and REJECTS (logs + drops, never fatal) a
 * bad-formed or duplicate locator.
 *
 * So "component_date", "component_json", "component_number" — every model
 * outside the relation family — is handled by the SAME branch as a literal,
 * minus the lang stamp. An earlier port whitelisted `relation family OR
 * translatable literal` and threw for everything else; that made `dmm1`
 * (three component_date defaults) and `nexus40` (a component_json default)
 * uncreatable through every door on two production installs. A whitelist here
 * is a silent narrowing of capability wearing a loud throw's clothes.
 *
 * The stored twins were byte-verified against real records (oh1 oh21/oh93/oh32,
 * the hierarchy101 colour default, the {id, start:{…}} component_date shape).
 */

import { buildLocatorLookupKey, type Locator } from '../../concepts/locator.ts';
import { canonicalizeStoredSectionId } from '../../concepts/section_id.ts';
import type { MatrixJsonbColumn } from '../../db/matrix.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { createOntologyCache } from '../../ontology/cache_factory.ts';
import { registerOntologyCacheClearer } from '../../ontology/cache_invalidation.ts';
import { DATA_NOLAN, ONTOLOGY_TLD } from '../../ontology/ontology_tipos.ts';

/** DEDALO_RELATION_TYPE_FILTER — the projects-filter locator type. */
export const RELATION_TYPE_FILTER = 'dd675';

/**
 * PHP component_filter::set_data_default excludes the unit-test sentinel
 * section so the fixtures are never polluted with real project assignments
 * (class.component_filter.php:230). Kept verbatim.
 */
const FILTER_EXCLUDED_SECTIONS: ReadonlySet<string> = new Set(['test3']);

/** The jsonb columns a defaults build may write, keyed by component tipo. */
export type DefaultColumns = Partial<Record<MatrixJsonbColumn, Record<string, unknown>>>;

/**
 * PHP's `!empty()` gate on the resolved default (class.component_common.php:815):
 * '', 0, '0', false, null, [] and {} are all "no default declared".
 */
function isEmptyDefault(raw: unknown): boolean {
	if (raw === null || raw === undefined || raw === false || raw === '' || raw === 0) return true;
	if (raw === '0') return true;
	if (Array.isArray(raw)) return raw.length === 0;
	if (typeof raw === 'object') return Object.keys(raw as object).length === 0;
	return false;
}

/**
 * `properties.dato_default` → the PHP `$data_default` ARRAY that set_data
 * receives (class.component_common.php:806-833: a non-array value is wrapped).
 * Returns [] when nothing is declared.
 *
 * The `{"method": …}` form (PHP resolves it through component_common::get_method
 * — e.g. today's date) is UNPORTED and THROWS: no dd_ontology row in any known
 * install uses it, and a silently-skipped default is exactly the class of
 * failure this module exists to end.
 */
export function normalizeDatoDefault(raw: unknown, tipo: string): unknown[] {
	if (isEmptyDefault(raw)) return [];
	if (!Array.isArray(raw) && typeof raw === 'object') {
		const method = (raw as { method?: unknown }).method;
		if (method !== undefined) {
			throw new DedaloError('internal.invariant', {
				message: `record_defaults: properties.dato_default.method is not ported (tipo '${tipo}', method '${String(method)}') — PHP component_common::get_method`,
				coordinates: { tipo, method: String(method) },
			});
		}
	}
	return Array.isArray(raw) ? [...raw] : [raw];
}

/**
 * The project locators a record created by `userId` is born with — the filter
 * cascade documented in the module header. `filterTipo` is the TARGET
 * section's own component_filter tipo (locators are always re-stamped onto it).
 */
export async function resolveDefaultFilterData(
	userId: number,
	filterTipo: string,
): Promise<Record<string, unknown>[]> {
	const { config } = await import('../../../config/config.ts');
	const { getUserProjects, resolvePrincipal } = await import('../../security/permissions.ts');

	const locatorFor = (projectId: number | string): Record<string, unknown> => ({
		id: 1,
		type: RELATION_TYPE_FILTER,
		// int-canonical stored address (WC-2026-08-10-section-id-int-canonical):
		// a project id IS a record address, so it is minted as an int.
		section_id: canonicalizeStoredSectionId(projectId),
		section_tipo: config.features.filterSectionTipo,
		from_component_tipo: filterTipo,
	});

	const principal = await resolvePrincipal(userId);
	if (!principal.isGlobalAdmin) {
		const projects = await getUserProjects(userId);
		const first = projects[0];
		// PHP reset($user_projects) — the user's first authorized project, so the
		// creator can always reach the record they just made.
		if (first !== undefined) return [locatorFor(first)];
	}
	return [locatorFor(config.features.defaultProject)];
}

/**
 * Re-stamp caller-supplied project locators onto `filterTipo` (PHP
 * set_projects_to_new_section_record's `$component_filter_data` branch — the
 * portal "+" inherits the HOST record's projects rather than computing a
 * default). Item ids are renumbered from 1, exactly as a fresh save would.
 */
export function stampFilterData(
	filterData: readonly Record<string, unknown>[],
	filterTipo: string,
): Record<string, unknown>[] {
	return filterData.map((locator, index) => ({
		...locator,
		from_component_tipo: filterTipo,
		id: index + 1,
	}));
}

/** One component's ontology-declared birth default, resolved once per section. */
export interface DefaultSpecItem {
	tipo: string;
	/** The RESOLVED model (alias-normalized), not the raw subtree row. */
	model: string;
	column: MatrixJsonbColumn;
	/** `properties.dato_default` already put through the PHP array wrap. */
	values: readonly unknown[];
}

/** Everything a section's birth state needs from the ONTOLOGY (request-free). */
export interface SectionDefaultsSpec {
	/** The projects-filter component, or null (no filter / the test3 sentinel). */
	filterTipo: string | null;
	filterColumn: MatrixJsonbColumn;
	items: readonly DefaultSpecItem[];
	/** ONT-TLD (`ontology7`) value, or null for a non-ontology section. */
	ontologyTld: string | null;
}

/**
 * The ontology-derived half of a section's birth state, cached.
 *
 * It USED to be recomputed per create: an UNCACHED recursive CTE
 * (getOrderedSubtree is explicitly NOT cached — resolver.ts: "the full-tree
 * consumers cache their derived structures") plus one getModelByTipo per
 * component, on every single record. CSV import, ontology and hierarchy
 * provisioning all paid it per row. This
 * cache is this module holding up its end of that contract: measured on oh1
 * (36 components), the walk alone cost 0.65 ms/record and the whole build
 * 3.8 ms; the cached build is 0.14 ms, all of it the per-actor project cascade
 * and the normalization, which are request state and must not be cached.
 *
 * Ontology-cached, so an ontology write drops it (the factory registers it; the
 * named clearer below is the module's public API and the anchor the identity
 * probe uses). NOTHING request-scoped may enter this cache — the actor's
 * projects and the request data lang are applied by buildRecordDefaultColumns
 * on every call.
 */
const sectionDefaultsSpecCache = createOntologyCache<string, SectionDefaultsSpec>();

/** Drop the per-section birth-defaults specs (dd_ontology write hook). */
export function clearRecordDefaultsCache(): void {
	sectionDefaultsSpecCache.clear();
}
registerOntologyCacheClearer(clearRecordDefaultsCache);

/**
 * The section's component children — the VIRTUAL EDIT SCOPE, which is what a
 * record of this section actually stores.
 *
 * A virtual section (`rsc170` → `rsc2`, `es1` → `hierarchy20`) borrows the REAL
 * section's components MINUS the tipos named by its FIRST `exclude_elements`
 * child; its own children are exclude_elements / section_list / buttons and are
 * never part of a record. editScopeComponents (beside resolveVirtualEditScope,
 * the canonical resolver the edit form and the elements context use) is the one
 * walk of exactly that, so the seed and the form can never disagree about which
 * components a record has.
 *
 * The earlier shape here — walk the section's own subtree, and only fall back
 * to the real section `if (own.length === 0)` — was the classic
 * `WHERE parent = sectionTipo` narrowing the virtual-section law warns about:
 * a virtual section owning ANY component child would have dropped the real
 * section's ENTIRE declared default set without a word.
 *
 * Containment: getOrderedSubtree does not cross into nested sections/areas,
 * whose components belong to their own records. An excluded tipo is skipped AND
 * its subtree pruned (dropping a grouper drops its children — PHP's rule).
 */
async function sectionComponents(
	sectionTipo: string,
): Promise<{ tipo: string; model: string; properties: Record<string, unknown> | null }[]> {
	// SANCTIONED SEAM: request_config/implicit.ts is a heavy relations module and
	// the create door is imported by it transitively — a static edge would fuse
	// the two into one import component (the SCC defect class).
	const { editScopeComponents } = await import('../../relations/request_config/implicit.ts');
	return (await editScopeComponents(sectionTipo)).map((node) => ({
		tipo: node.tipo,
		model: node.model as string,
		properties: (node.properties as Record<string, unknown> | null) ?? null,
	}));
}

/** PHP `property_exists($el,'id') && id!==null && id!==''` (set_data :994-996). */
function hasUsableId(item: Record<string, unknown>): boolean {
	return 'id' in item && item.id !== null && item.id !== '' && item.id !== undefined;
}

/**
 * Persisted-item normalization for ONE component's default value — the PHP
 * component_common::set_data pipeline (:918-1010), GENERIC over every model.
 *
 * Returns the items AND the counter PHP would have left behind: it allocates
 * one id per element that arrives without one (`set_data_item_counter` →
 * `allocate_component_ids`, which raises the persisted counter even for an
 * element `validate_data_element` later rejects) and then absorbs any explicit
 * id above it (`raise_component_counter`, :1008-1016).
 *
 * Exported for the gate: a model-shaped defect in here is invisible until a
 * curator presses "+" on the one section that declares a default on it.
 */
export async function normalizeDefaultItems(
	tipo: string,
	model: string,
	values: readonly unknown[],
): Promise<{ items: unknown[]; counter: number }> {
	const { getComponentModel } = await import('../../components/registry.ts');
	const { getTranslatableByTipo } = await import('../../ontology/resolver.ts');
	const descriptor = getComponentModel(model);

	// PHP allocates the id BEFORE validation, so a rejected element still burns
	// one; `allocated` is that count.
	let allocated = 0;
	let maxAcceptedId = 0;
	const withId = (item: Record<string, unknown>): Record<string, unknown> => {
		if (hasUsableId(item)) return item;
		allocated += 1;
		item.id = allocated;
		return item;
	};
	const accept = (item: Record<string, unknown>): void => {
		const id = Number(item.id);
		if (Number.isFinite(id) && id > maxAcceptedId) maxAcceptedId = Math.trunc(id);
	};

	if (descriptor?.defaultRelationType !== undefined) {
		// RELATION FAMILY — component_relation_common::validate_data_element
		// (:1058-1198): `type` from the component's OWN relation type, forced
		// from_component_tipo, section_id cast to STRING, lang on a translatable
		// relation, and a locator_lookup_map dedup.
		const { getRelationTypeByTipo } = await import('../../relations/save.ts');
		const { currentDataLang } = await import('../../resolve/request_lang.ts');
		const relationType = await getRelationTypeByTipo(tipo);
		const translatable = await getTranslatableByTipo(tipo);
		const keyProperties = translatable
			? ['section_id', 'section_tipo', 'type', 'tag_id', 'lang']
			: ['section_id', 'section_tipo', 'type', 'tag_id'];
		const seen = new Set<string>();
		const items: unknown[] = [];
		for (const value of values) {
			const raw = value !== null && typeof value === 'object' ? value : { value };
			const locator = withId({ ...(raw as Record<string, unknown>) });
			if (locator.section_id === undefined || locator.section_tipo === undefined) {
				// PHP :1068-1077 logs an ERROR and returns FALSE — the element is
				// DROPPED and the record is still created. Throwing here would make
				// the whole section uncreatable through every door, which is a far
				// worse failure than one unusable ontology declaration.
				console.error(
					`[record_defaults] IGNORED bad-formed dato_default locator (no section_id/section_tipo) on '${tipo}' (${model}): ${JSON.stringify(value)}`,
				);
				continue;
			}
			locator.type =
				locator.type === undefined || locator.type === '' ? relationType : locator.type;
			locator.from_component_tipo = tipo;
			if (translatable) locator.lang = currentDataLang();
			// PHP unsets the temporary marker before persisting (:1140-1143).
			// biome-ignore lint/performance/noDelete: PHP unset — paginated_key must be ABSENT in persisted data
			if ('paginated_key' in locator) delete locator.paginated_key;
			// Canonical stored address; a non-address value passes verbatim
			// (WC-2026-08-10-section-id-int-canonical).
			locator.section_id = canonicalizeStoredSectionId(locator.section_id);
			const key = buildLocatorLookupKey(locator as unknown as Locator, keyProperties);
			if (seen.has(key)) {
				// PHP :1160-1167 — "Ignored set_data of already existing locator".
				console.error(
					`[record_defaults] IGNORED duplicate dato_default locator on '${tipo}' (${model}): ${key}`,
				);
				continue;
			}
			seen.add(key);
			accept(locator);
			items.push(locator);
		}
		return { items, counter: Math.max(allocated, maxAcceptedId) };
	}

	// EVERY OTHER MODEL — the base validate_data_element returns the element
	// UNCHANGED (:901), so all that happens is the scalar wrap, the conditional
	// lang stamp and the counter id. component_date keeps its {period:…} /
	// {start:…} object, component_json keeps its whole config object, a
	// component_number scalar becomes {value: 7}.
	const lang =
		descriptor?.classSupportsTranslation === true
			? (await getTranslatableByTipo(tipo))
				? (await import('../../resolve/request_lang.ts')).currentDataLang()
				: DATA_NOLAN
			: null;
	const items: unknown[] = [];
	for (const value of values) {
		// PHP `is_object()`: a JSON array is NOT an object, so it is wrapped.
		const item: Record<string, unknown> =
			value !== null && typeof value === 'object' && !Array.isArray(value)
				? { ...(value as Record<string, unknown>) }
				: { value };
		// PHP stamps the lang only when it is missing/empty (:978-984).
		if (lang !== null && (item.lang === undefined || item.lang === null || item.lang === '')) {
			item.lang = lang;
		}
		withId(item);
		accept(item);
		items.push(item);
	}
	return { items, counter: Math.max(allocated, maxAcceptedId) };
}

/**
 * The ontology-derived birth-default spec of `sectionTipo`, cached.
 * Request-independent by construction: the actor's project cascade and the
 * request lang are applied by buildRecordDefaultColumns, never stored here.
 */
export async function getSectionDefaultsSpec(sectionTipo: string): Promise<SectionDefaultsSpec> {
	const cached = sectionDefaultsSpecCache.get(sectionTipo);
	if (cached !== undefined) return cached;

	const { getColumnNameByModel, getComponentFilterTipo, getModelByTipo } = await import(
		'../../ontology/resolver.ts'
	);
	const { requiredOntologyTld } = await import('../../ontology/tld.ts');

	// THE PROJECT FILTER, through the CANONICAL accessor. Not through the
	// component walk below: getComponentFilterTipo carries the virtual-section
	// fallback the projects ACL itself uses (rsc170 → rsc2 → rsc28), so the seed
	// and the gate can never disagree about which component holds the project.
	// A mismatch here is fail-open by construction — the record would be born
	// filter-less exactly like the bug this module closes.
	const filterTipo = FILTER_EXCLUDED_SECTIONS.has(sectionTipo)
		? null
		: await getComponentFilterTipo(sectionTipo);
	const filterColumn =
		filterTipo === null
			? 'relation'
			: (((getColumnNameByModel(
					(await getModelByTipo(filterTipo)) ?? 'component_filter',
				) as MatrixJsonbColumn | null) ?? 'relation') as MatrixJsonbColumn);

	const items: DefaultSpecItem[] = [];
	for (const component of await sectionComponents(sectionTipo)) {
		// The resolved model wins over the raw subtree row (alias normalization).
		const model = (await getModelByTipo(component.tipo)) ?? component.model;
		const column = getColumnNameByModel(model) as MatrixJsonbColumn | null;
		if (column === null) continue;
		// component_filter is handled above; component_filter_master (dd170, the
		// USER's own project grants) is NEVER seeded — PHP gates the auto-assign
		// on `get_called_class() === 'component_filter'` precisely to exclude it.
		if (model === 'component_filter' || model === 'component_filter_master') continue;
		const values = normalizeDatoDefault(component.properties?.dato_default, component.tipo);
		if (values.length === 0) continue;
		items.push({ tipo: component.tipo, model, column, values });
	}

	const spec: SectionDefaultsSpec = {
		filterTipo,
		filterColumn,
		items,
		ontologyTld: requiredOntologyTld(sectionTipo),
	};
	sectionDefaultsSpecCache.set(sectionTipo, spec);
	return spec;
}

/**
 * The jsonb columns a NEW record of `sectionTipo` is born with, beyond the
 * audit metadata: the project filter plus every ontology-declared
 * `dato_default`. Values are already in stored (persisted) shape, so the
 * caller merges them straight into its INSERT.
 *
 * `meta` carries the per-component item-id counters the seeded ids consume
 * (PHP raise_component_counter on every set_data) — without it the next
 * allocation would hand out an id already in use.
 *
 * `filterData` (the portal "+" host inheritance) REPLACES the computed
 * default for the component_filter, mirroring PHP's `$component_filter_data`
 * branch; the locators are re-stamped onto the target's own filter tipo.
 */
export async function buildRecordDefaultColumns(
	sectionTipo: string,
	userId: number,
	options: { filterData?: readonly Record<string, unknown>[] } = {},
): Promise<DefaultColumns> {
	const spec = await getSectionDefaultsSpec(sectionTipo);

	const columns: DefaultColumns = {};
	const counters: Record<string, unknown> = {};
	const put = (
		column: MatrixJsonbColumn,
		tipo: string,
		items: unknown[],
		counter?: number,
	): void => {
		if (items.length === 0) return;
		const bucket = columns[column] ?? {};
		bucket[tipo] = items;
		columns[column] = bucket;
		let maxId = counter ?? 0;
		for (const item of items) {
			const id = Number((item as { id?: unknown } | null)?.id);
			if (Number.isFinite(id) && id > maxId) maxId = Math.trunc(id);
		}
		if (maxId > 0) counters[tipo] = [{ count: maxId }];
	};

	// 1. THE PROJECT FILTER (spec.filterTipo — the canonical accessor's answer,
	// which carries the virtual-section fallback the projects ACL itself uses).
	if (spec.filterTipo !== null) {
		put(
			spec.filterColumn,
			spec.filterTipo,
			options.filterData !== undefined && options.filterData.length > 0
				? stampFilterData(options.filterData, spec.filterTipo)
				: await resolveDefaultFilterData(userId, spec.filterTipo),
		);
	}

	// 2. Every other component's declared dato_default.
	for (const item of spec.items) {
		const { items, counter } = await normalizeDefaultItems(item.tipo, item.model, item.values);
		put(item.column, item.tipo, items, counter);
	}

	// 3. THE ONTOLOGY TLD (ONT-TLD). Like seed 1, and unlike seed 2, this is a
	// value the ontology cannot express as a `dato_default` because it is not a
	// CONSTANT — it is a function of the section (`actv0` → "actv"). It is also
	// MANDATORY: parseSectionRecordToOntologyNode returns null without it, so a
	// record born tld-less writes no dd_ontology row and is invisible in the
	// ontology tree — the administrator's work is silently lost. Deriving it at
	// the create door is the whole fix; requiredOntologyTld owns the rule
	// (including the localontology0 carve-out). `lg-nolan` matches every stored
	// item in the wild and ontology_write's own seed — NOT hierarchy_provision's
	// lg-spa, which is a documented one-off for the descriptor twin.
	if (spec.ontologyTld !== null) {
		put('string', ONTOLOGY_TLD, [{ id: 1, lang: DATA_NOLAN, value: spec.ontologyTld }]);
	}

	if (Object.keys(counters).length > 0) columns.meta = counters;
	return columns;
}
