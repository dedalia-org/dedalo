/**
 * request_config EXPLICIT parser — how a relation component declares its target
 * resolution (spec §3.6), read from ontology properties.source.request_config.
 * PHP oracle nomenclature: explicit ≡ v6, implicit ≡ v5.
 *
 * PHP references: trait.request_config_v6.php (parse_request_config_item :158,
 * resolve_sqo_section_tipo :245, show/search/choose/hide :324-607),
 * trait.request_config_ddo.php (process_single_ddo :50-155,
 * resolve_ddo_self_references :247, resolve_ddo_mode :284),
 * request_config_utils (build_sqo_section_tipo_ddo :424).
 *
 * v0 scope (per-step ledger, no silent narrowing):
 * - api_engine / type / sqo (section_tipo resolution incl. the enriched
 *   {value, source} entries and the 'self' sentinel) / show / search /
 *   choose / hide ddo_maps with self-sentinel + mode resolution and
 *   model/label enrichment + the step-11 per-ddo permission drop
 *   (section-owned configs only — 2026-07-10, ddoIsAuthorized);
 * - step 9 (fields_map hydration for external-API components) LANDED 2026-08-05
 *   — see hydrateDdoFieldsMap + WC-2026-08-05-external-api-config-publication;
 * - DEFERRED (nulls/ledger): tm dataframe view (step 10),
 *   session/rqo overlay stages. User presets
 *   (dd1244 layout maps) LANDED 2026-07-10 — the STAGE-2 override lives at the
 *   build.ts chokepoint (./presets.ts), feeding this parser the preset config.
 */

import type { PublishedApiConfig } from '../../../external/api/index.ts';
import { getActiveTlds } from '../../db/dd_ontology.ts';
import { assertMatrixTable } from '../../db/matrix.ts';
import { sql } from '../../db/postgres.ts';
import type { ApiNotice } from '../../errors/schema.ts';
import { createOntologyCache } from '../../ontology/cache_factory.ts';
import { registerOntologyCacheClearer } from '../../ontology/cache_invalidation.ts';
import { getModelSectionForSection } from '../../ontology/model_section.ts';
import { getModelByTipo, getNode, getSectionRealTipo } from '../../ontology/resolver.ts';
import { contextLabelOf } from '../../resolve/structure_context.ts';
import {
	composeContains,
	locatorJsonVariants,
	relationProbeGroups,
} from '../../search/containment.ts';
import { registerSectionDataListener } from '../../section_record/save_event.ts';
import {
	partitionDeepSelfDdos,
	SQO_SOURCES_WITHOUT_SECTION_VALUE,
	splitSelfSectionTipoEntry,
} from './self_depth.ts';

/** The parsing context: who owns the config and where it lives. */
export interface RequestConfigContext {
	/** The owning element (portal/section) tipo — 'self' parent resolves here. */
	ownerTipo: string;
	/** The owning element's section tipo(s) — 'self' section resolves here. */
	ownerSectionTipo: string;
	/** The caller's render mode (section callers propagate; others force list). */
	mode: string;
	/** True when the OWNER is a section (affects ddo mode resolution). */
	ownerIsSection: boolean;
	/**
	 * The calling RECORD id when the caller knows it (edit/get_data flows).
	 * Required by fixed_filter 'component_data' resolution (PHP passes the
	 * instance section_id); absent for record-independent builds (datalist,
	 * structure context of a whole section).
	 */
	ownerSectionId?: number | string | null;
	/** Request data lang for live expansions (filter_by_list datalists). */
	lang?: string;
	/**
	 * The owner COMPONENT model's default target sections, already resolved by
	 * its descriptor `targetSource` facet (./target_sources.ts, computed once in
	 * ./build.ts before either strategy runs). Empty/absent for every model that
	 * declares no facet — i.e. everything except component_relation_model today.
	 *
	 * WHY IT IS THREADED IN rather than applied to the finished config: it must
	 * be in hand at the moment `targetTipos` is computed, because that value is
	 * ALSO what `section_tipo: 'self'` resolves to in the show/search/choose/hide
	 * ddo maps (processSingleDdo below). A default stamped onto the finished sqo
	 * would leave every 'self' ddo pointing at the CALLER's section — hierarchy27
	 * in es1 would emit "read hierarchy25 on es1" while its options came from es2.
	 *
	 * PRECEDENCE. A DECLARED sqo target always wins; this only fills silence.
	 * "Declared" means the node's own `source.request_config` said so — the
	 * IMPLICIT builder's relations walk does NOT count (implicit.ts), because the
	 * section it finds there is the component's *belongs-to* ontology link, not a
	 * statement about where its options come from: for hierarchy27 that link is
	 * hierarchy20, the raw 69,148-row thesaurus template.
	 */
	modelDefaultTargets?: readonly string[];
	/**
	 * Where a refused level >= 2 `section_tipo: 'self'` ddo reports its typed
	 * notice (owner decision (c) — self_depth.ts partitionDeepSelfDdos, applied
	 * per block in parseBlock below). The ddo is SKIPPED whether or not a sink
	 * is given; without one the refusal is ONE log line per block, never silent.
	 * The per-element resolution (relations/element_node.ts) passes the
	 * emission's registry sink so the notice reaches the response.
	 */
	notices?: ApiNotice[];
}

/** Source names with a dedicated case below ('section_tipo' is a live alias
 * of the default section semantics — 8 production configs use it). */
const KNOWN_SQO_SOURCES: ReadonlySet<string> = new Set([
	...SQO_SOURCES_WITHOUT_SECTION_VALUE,
	'section',
	'section_tipo',
]);

/**
 * An enriched entry's `value` as a list. PHP iterates `(array)$value`, so a
 * SCALAR value is one element — not nothing (D20, fixed 2026-08-09: the four
 * branches each wrote `Array.isArray(value) ? value : []`, which SILENTLY
 * DROPPED the live `{"value":"lg1","source":"section"}` string form; the 8
 * component_select_lang nodes declaring it resolved ZERO target sections, so
 * every bare-id import into them was refused "invalid target_section_tipo"
 * and the client got empty target_sections). ONE helper on purpose: four
 * inline coercions is exactly how the branches drifted apart.
 */
function asSqoValueList(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	return value === undefined || value === null || value === '' ? [] : [value];
}

/**
 * `{source:'hierarchy_terms'}` — the values are term LOCATORS, and the sqo
 * target is each locator's own `section_tipo`. `recursive`/`section_id` matter
 * only to get_fixed_filter (./filters.ts:174), not here (PHP :2850-65). Zero
 * live sqo users — parity insurance.
 */
function hierarchyTermSectionTipos(value: unknown): string[] {
	const tipos: string[] = [];
	for (const term of asSqoValueList(value)) {
		const sectionTipo = (term as { section_tipo?: unknown } | null)?.section_tipo;
		if (typeof sectionTipo === 'string') tipos.push(sectionTipo);
	}
	return tipos;
}

/**
 * `{source:'section_model'}` — the MODEL TWIN of each named section (the
 * hierarchy registry's hierarchy53 → hierarchy58 pairing, ontology/model_section.ts).
 * No `value` (and the literal 'self') means the caller's own section, mirroring
 * the {source:'self'} branch. Same id as the descriptor facet
 * `targetSource: 'section_model'` on purpose — an ontology node can request the
 * model's own default rule explicitly.
 */
async function resolveSectionModelSource(
	value: unknown,
	ownerSectionTipo: string,
): Promise<string[]> {
	const named = asSqoValueList(value).filter((tipo): tipo is string => typeof tipo === 'string');
	const callerSections = named.length === 0 ? [ownerSectionTipo] : named;
	const resolved: string[] = [];
	for (const section of callerSections) {
		resolved.push(
			...(await getModelSectionForSection(section === 'self' ? ownerSectionTipo : section)),
		);
	}
	return resolved;
}

/**
 * Flatten an explicit sqo.section_tipo declaration to plain tipos: entries are
 * strings, or enriched {value: [tipos], source} objects; 'self' resolves to
 * the owner's section. Cases mirror PHP get_request_config_section_tipo
 * (class.component_relation_common.php:2679-2908); the tail mirrors its
 * array_unique (:2892-95) + the trait's check_tipo_is_valid prune
 * (trait.request_config_v6.php:262-270).
 */
export async function resolveSqoSectionTipos(
	raw: unknown,
	context: RequestConfigContext,
): Promise<string[]> {
	const entries = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
	const resolved: string[] = [];
	for (const entry of entries) {
		if (typeof entry === 'string') {
			resolved.push(entry === 'self' ? context.ownerSectionTipo : entry);
			continue;
		}
		if (entry !== null && typeof entry === 'object') {
			const source = (entry as { source?: unknown }).source;
			const value = (entry as { value?: unknown }).value;
			// PHP drops object entries with NO source outright (:2718-25, ERROR
			// log) — they never reach the default branch. Zero live users.
			if (source === undefined || source === null || source === '') {
				console.warn(
					'[request_config/explicit] dropped sqo section_tipo entry without source (PHP :2718-25)',
				);
				continue;
			}
			// self source: the caller's own section, value IGNORED (PHP
			// get_request_config_section_tipo case 'self',
			// class.component_relation_common.php:2729-32 — self-referencing
			// portals like numisdata73 declare {source:'self'} with no value).
			if (source === 'self') {
				resolved.push(context.ownerSectionTipo);
				continue;
			}
			// hierarchy_types source: the values are TYPOLOGY ids — resolve to
			// the ACTIVE hierarchy sections of those typologies (PHP
			// get_hierarchy_sections_from_types).
			if (source === 'hierarchy_types') {
				const typeIds = asSqoValueList(value).map((id) => Number(id));
				resolved.push(...(await resolveHierarchySectionsFromTypes(typeIds)));
				continue;
			}
			// section_model source (2026-08-14, no PHP sqo equivalent — it names
			// declaratively what PHP's component_relation_model class override
			// computed, v6 class.component_relation_model.php:115-177): each value
			// tipo is a CALLER section resolved to its MODEL section — the
			// terms→model twin the registry pairing declares (hierarchy53 = target
			// section, hierarchy58 = target MODEL section), with the tld+'2'
			// naming rule as fallback (ontology/model_section.ts). BOTH registries
			// of the family are consulted: hierarchy1 (thesaurus, on
			// matrix_hierarchy_main) and ontology35 (passive ontology — a VIRTUAL
			// section of hierarchy1 carrying the same registry components on
			// matrix_ontology_main). NO `value` means 'self' — the caller's own
			// section, mirroring the {source:'self'} branch above. Grammar:
			// {"source":"section_model"} = the model twin of the caller's own
			// section; {"source":"section_model","value":["es1","fr1"]} = the
			// model twins of those. Non-section candidates are refused LOUDLY
			// inside the resolver (it warns and yields nothing for that caller),
			// so the tail prune below needs no special case. Same id as the
			// descriptor facet `targetSource: 'section_model'` on purpose — an
			// ontology node can request the model's default rule explicitly.
			if (source === 'section_model') {
				resolved.push(...(await resolveSectionModelSource(value, context.ownerSectionTipo)));
				continue;
			}
			// ontology_sections source: EVERY registered ontology's target section
			// (PHP ontology::get_all_ontology_sections, class.ontology.php:1509-51 —
			// all matrix_ontology_main rows' hierarchy53 value; no active filter,
			// no TLD gate, `value` ignored). Live users: ontology1's tree
			// components + dd1766 (222 targets on this install).
			if (source === 'ontology_sections') {
				resolved.push(...(await resolveOntologySections()));
				continue;
			}
			// field_value source: read the CALLER section's ACTIVE records
			// (relation carries the hierarchy4/dd64/1 active flag) and take each
			// named component's data values as target tipos, keeping only those
			// that resolve to a section model (PHP :2744-2848 — hierarchy1's
			// hierarchy45/hierarchy59 resolve the active hierarchies' targets).
			if (source === 'field_value') {
				const componentTipos = asSqoValueList(value).filter(
					(tipo): tipo is string => typeof tipo === 'string',
				);
				resolved.push(
					...(await resolveFieldValueSections(componentTipos, context.ownerSectionTipo)),
				);
				continue;
			}
			// hierarchy_terms source: the values are term LOCATORS — the sqo
			// target is each locator's section_tipo; `recursive`/`section_id`
			// matter only to get_fixed_filter (./filters.ts:174), not here
			// (PHP :2850-65). Zero live sqo users — parity insurance.
			if (source === 'hierarchy_terms') {
				resolved.push(...hierarchyTermSectionTipos(value));
				continue;
			}
			// section source (and default — PHP's default serves any unknown name,
			// incl. the live 'section_tipo' alias): every value tipo is gated on
			// its TLD being INSTALLED (PHP check_active_tld, case 'section'/default
			// :2867-88 — uninstalled targets are DROPPED, not emitted).
			if (typeof source === 'string' && !KNOWN_SQO_SOURCES.has(source)) {
				console.warn(
					`[request_config/explicit] unknown sqo section_tipo source ${JSON.stringify(source.slice(0, 64))} resolved with section semantics (PHP default branch)`,
				);
			}
			for (const tipo of asSqoValueList(value)) {
				if (typeof tipo === 'string') {
					if (tipo === 'self') {
						resolved.push(context.ownerSectionTipo);
					} else if (await isActiveTldTipo(tipo)) {
						resolved.push(tipo);
					}
				}
			}
		}
	}
	// PHP tail: array_unique (:2892-95), then the v6 trait prunes EVERY resolved
	// target with ontology_utils::check_tipo_is_valid (:262-270) — a tipo whose
	// ontology MODEL cannot be resolved is dropped with a warning. This is what
	// actually removes numisdata279's category1 (its 'category' TLD is installed
	// but no category1 node exists), NOT the TLD gate.
	const valid: string[] = [];
	for (const tipo of [...new Set(resolved)]) {
		if ((await getModelByTipo(tipo)) === null) {
			console.warn(
				`[request_config/explicit] dropped sqo target ${JSON.stringify(tipo.slice(0, 64))}: no resolvable ontology model (PHP check_tipo_is_valid)`,
			);
			continue;
		}
		valid.push(tipo);
	}
	return valid;
}

/**
 * PHP ontology_utils::check_active_tld (class.ontology_utils.php:268-79):
 * 'section_id' always passes (SQO pseudo-tipo); otherwise the tipo's TLD
 * (leading letters, PHP get_tld_from_tipo /^[a-z]{2,}/) must be installed in
 * dd_ontology (getActiveTlds — hub-invalidated module cache).
 */
export async function isActiveTldTipo(tipo: string): Promise<boolean> {
	if (tipo === 'section_id') return true;
	const tld = tipo.match(/^[a-z]{2,}/)?.[0];
	if (tld === undefined) return false;
	return (await getActiveTlds()).includes(tld);
}

/**
 * A `bind` for the compose helpers over positional `sql.unsafe` params: appends
 * the payload and returns its `$N` placeholder. Positional params are
 * order-independent in the sentence, so callers may compose clauses in any
 * order as long as they share ONE collector.
 */
function bindPositional(params: string[]): (payload: string) => string {
	return (payload: string) => {
		params.push(payload);
		return `$${params.length}`;
	};
}

/**
 * Probe group for an ARRAY-shaped column reference (`relation-><tipo>`): the
 * `[<locator>]` payload of each typed section_id variant. The object-keyed
 * whole-column shape is `relationProbeGroups` in search/containment.ts.
 */
function arrayProbeGroup(locator: Record<string, unknown>): string[] {
	return locatorJsonVariants(locator).map((json) => `[${json}]`);
}

/** Cache: typology ids key → active hierarchy target section tipos. */
const hierarchySectionsCache = createOntologyCache<string, string[]>();

/** The hierarchy registry section whose records the cache derives from. */
const HIERARCHY_REGISTRY_SECTION_TIPO = 'hierarchy1';

/** Drop the hierarchy-sections cache (hub/event invalidation + tests). */
export function clearHierarchySectionsCache(): void {
	hierarchySectionsCache.clear();
}
// Ontology-derived too — hub-cleared (S1-11 stopgap).
registerOntologyCacheClearer(clearHierarchySectionsCache);
// Data-derived: a write/delete of a hierarchy1 registry record (new hierarchy,
// typology or active-flag change) rebuilds the list (the durable S1-11 channel).
registerSectionDataListener((sectionTipo) => {
	if (sectionTipo === HIERARCHY_REGISTRY_SECTION_TIPO) clearHierarchySectionsCache();
});

/**
 * PHP component_relation_common::get_hierarchy_sections_from_types — the
 * ACTIVE (hierarchy4 = dd64/1) hierarchy records (hierarchy1) whose typology
 * (hierarchy9 → hierarchy13/<type id>) matches, yielding their TARGET section
 * tipo (hierarchy53 value). Exported for the cache-invalidation gates (the
 * production entry is resolveSqoSectionTipos' hierarchy_types branch).
 */
export async function resolveHierarchySectionsFromTypes(typeIds: number[]): Promise<string[]> {
	const cacheKey = typeIds.join('_');
	const cached = hierarchySectionsCache.get(cacheKey);
	if (cached !== undefined) return cached;
	if (typeIds.length === 0) return [];

	const { sql } = await import('../../db/postgres.ts');
	// Both typed forms of every probed section_id
	// (WC-2026-08-10-section-id-int-canonical): stored locators carry
	// section_id as a string until the int sweep and as an int after, and
	// jsonb `@>` is type-strict — a single-form literal silently loses half
	// the rows during the expand window (and forever on old-backup restores).
	const probeParams: string[] = [];
	const bind = bindPositional(probeParams);
	const activeClause = composeContains(
		`relation->'hierarchy4'`,
		[arrayProbeGroup({ section_id: 1, section_tipo: 'dd64' })],
		bind,
	);
	const typologyClauses = typeIds
		.map((id) =>
			composeContains(
				`relation->'hierarchy9'`,
				[arrayProbeGroup({ section_id: Math.floor(id), section_tipo: 'hierarchy13' })],
				bind,
			),
		)
		.join(' OR ');
	const rows = (await sql.unsafe(
		`SELECT COALESCE(data->'hierarchy53', string->'hierarchy53')->0->>'value' AS target
		 FROM matrix_hierarchy_main
		 WHERE section_tipo = 'hierarchy1'
		   AND ${activeClause}
		   AND (${typologyClauses})
		 ORDER BY section_id`,
		probeParams,
	)) as { target: string | null }[];
	const sections = rows
		.map((row) => row.target)
		.filter((target): target is string => typeof target === 'string' && target !== '');
	hierarchySectionsCache.set(cacheKey, sections);
	return sections;
}

/** Cache: the single all-ontologies target-section list (one key). */
const ontologySectionsCache = createOntologyCache<string, string[]>();

/** The ontology registry section whose records the cache derives from. */
const ONTOLOGY_REGISTRY_SECTION_TIPO = 'ontology35';

/** Drop the ontology-sections cache (hub/event invalidation + tests). */
export function clearOntologySectionsCache(): void {
	ontologySectionsCache.clear();
}
registerOntologyCacheClearer(clearOntologySectionsCache);
// Data-derived: a write/delete of an ontology35 registry record (new ontology,
// target change) rebuilds the list.
registerSectionDataListener((sectionTipo) => {
	if (sectionTipo === ONTOLOGY_REGISTRY_SECTION_TIPO) clearOntologySectionsCache();
});

/**
 * PHP ontology::get_all_ontology_sections (class.ontology.php:1509-51): every
 * matrix_ontology_main registry row's target section (hierarchy53 value) —
 * NO active-flag filter, NO TLD gate; rows without a target are skipped.
 * Exported for the cache-invalidation gates (production entry is
 * resolveSqoSectionTipos' ontology_sections branch). Leaner than
 * data_io.ts::getActiveOntologies (which also resolves typology names and
 * skips tld-less rows — PHP here does neither).
 */
export async function resolveOntologySections(): Promise<string[]> {
	const cached = ontologySectionsCache.get('all');
	if (cached !== undefined) return cached;
	const rows = (await sql`
		SELECT COALESCE(data->'hierarchy53', string->'hierarchy53')->0->>'value' AS target
		FROM matrix_ontology_main
		WHERE section_tipo = ${ONTOLOGY_REGISTRY_SECTION_TIPO}
		ORDER BY section_id
	`) as { target: string | null }[];
	const sections = rows
		.map((row) => row.target)
		.filter((target): target is string => typeof target === 'string' && target !== '');
	ontologySectionsCache.set('all', sections);
	return sections;
}

/**
 * PHP get_request_config_section_tipo case 'field_value'
 * (class.component_relation_common.php:2744-2848): over the CALLER section's
 * ACTIVE records (whole-column `relation @>` on the hierarchy4/dd64/1 flag —
 * GIN-indexable, which matters on matrix_activity_diffusion's 1.8M rows),
 * read each named component's data values; keep only values that resolve to
 * a section model (:2831-33). UNCACHED on purpose — record-data-derived with
 * no invalidation signal (same posture as filter_by_list/fixed_filter).
 * Zero matching active records short-circuits to [] (PHP :2797 — dd1763).
 */
async function resolveFieldValueSections(
	componentTipos: string[],
	callerSectionTipo: string,
): Promise<string[]> {
	const { getMatrixTableFromTipo } = await import('../../ontology/resolver.ts');
	const table = await getMatrixTableFromTipo(callerSectionTipo);
	if (table === null) return [];
	// The query below assumes the STANDARD record contract (data/string/relation
	// columns) and interpolates the table name: refuse anything else loudly. A
	// log table (matrix_time_machine) reaching here means a host section (dd15)
	// was passed as the caller — see concepts/emit_row.ts.
	assertMatrixTable(table);
	const resolved: string[] = [];
	for (const componentTipo of componentTipos) {
		// Interpolated as a jsonb key — enforce the tipo grammar strictly.
		if (!/^[a-z]{2,}[0-9]+$/.test(componentTipo)) {
			console.warn(
				`[request_config/explicit] field_value skipped malformed component tipo ${JSON.stringify(componentTipo.slice(0, 64))}`,
			);
			continue;
		}
		// Whole-column active-flag containment, both typed section_id forms
		// (WC-2026-08-10-section-id-int-canonical) — see the comment in
		// resolveHierarchySectionsFromTypes.
		const queryParams: string[] = [callerSectionTipo];
		const activeClause = composeContains(
			't.relation',
			relationProbeGroups('hierarchy4', [
				{ section_tipo: 'dd64', section_id: 1, from_component_tipo: 'hierarchy4' },
			]),
			bindPositional(queryParams),
		);
		const rows = (await sql.unsafe(
			`SELECT elem->>'value' AS target
			 FROM "${table}" t,
			      jsonb_array_elements(
			        CASE WHEN jsonb_typeof(COALESCE(t.data->'${componentTipo}', t.string->'${componentTipo}')) = 'array'
			             THEN COALESCE(t.data->'${componentTipo}', t.string->'${componentTipo}')
			             ELSE '[]'::jsonb END
			      ) elem
			 WHERE t.section_tipo = $1
			   AND ${activeClause}
			 ORDER BY t.section_id`,
			queryParams,
		)) as { target: string | null }[];
		for (const row of rows) {
			const candidate = row.target;
			if (typeof candidate !== 'string' || candidate === '') continue;
			// PHP keeps a candidate only when it RESOLVES to a section (:2831-33).
			if ((await getModelByTipo(candidate)) === 'section') {
				resolved.push(candidate);
			} else {
				console.warn(
					`[request_config/explicit] field_value dropped non-section candidate '${candidate}' (PHP :2834-43)`,
				);
			}
		}
	}
	return resolved;
}

/** One processed ddo (enriched, self-resolved). */
export interface ProcessedDdo {
	tipo: string;
	model: string;
	/** Array for normal ddos; SCALAR for component_dataframe; ABSENT when the
	 * raw ddo declared none (PHP only rewrites the literal 'self'). */
	section_tipo?: string | string[];
	parent: string;
	mode: string;
	label: string | null;
	[extra: string]: unknown;
}

/**
 * True when a ddo's `section_tipo` is written in the SQO SOURCE-ARRAY grammar —
 * `[{value:[…], source:'section'|'hierarchy_types'|…}]` (or one such object) —
 * rather than as plain tipo strings.
 */
export function isSourceArraySectionTipo(raw: unknown): boolean {
	if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return true;
	return Array.isArray(raw) && raw.some((entry) => entry !== null && typeof entry === 'object');
}

/**
 * The SOURCE-ARRAY grammar a CLIENT ddo may use. resolveSqoSectionTipos was
 * written for ONTOLOGY input: `hierarchy_types` fills a cross-request cache
 * keyed by its values, `field_value` scans the owner section's records per
 * value, unknown sources log per entry. A client map (up to
 * SCALAR_BOUNDS.ddoMapEntries ddos) must never drive any of that, so a client
 * declaration may only name sections — plain strings, `{source:'self'}`,
 * `{source:'section', value:[…]}` — with at most CLIENT_SOURCE_ARRAY_MAX
 * entries and values in all. Today the wire schema (concepts/ddo.ts ddoSchema:
 * section_tipo = string | string[]) already refuses object entries; this is
 * the seam's own guard, so a future schema widening cannot reopen it.
 */
const CLIENT_SOURCE_ARRAY_SOURCES: ReadonlySet<string> = new Set(['self', 'section']);
export const CLIENT_SOURCE_ARRAY_MAX = 64;

/**
 * Why a CLIENT ddo's `section_tipo` is refused (CLIENT_SOURCE_ARRAY_SOURCES),
 * or null when the client may send it. Examples:
 *   'rsc197' / ['rsc197'] / 'self' / undefined                → null (no resolver)
 *   [{source:'self'}, {source:'section', value:['rsc197']}]    → null
 *   [{source:'hierarchy_types', value:[5]}]                    → refused
 *   [{source:'field_value', value:['rsc85']}]                  → refused
 *   [{source:'section', value:[…65 tipos]}]                    → refused (too large)
 */
export function clientSectionTipoRefusal(raw: unknown): string | null {
	if (!isSourceArraySectionTipo(raw)) return null;
	const entries = Array.isArray(raw) ? raw : [raw];
	let size = 0;
	for (const entry of entries) {
		const entrySize = clientSourceEntrySize(entry);
		if (entrySize === null) return 'section_tipo source not allowed from a client';
		size += entrySize;
	}
	return size > CLIENT_SOURCE_ARRAY_MAX ? 'section_tipo source array too large' : null;
}

/**
 * ONE entry of a client source array (clientSectionTipoRefusal): what it adds
 * to the size budget — 1 for a plain entry, 1 + its values for a source
 * object — or null when its source is outside the client grammar.
 */
function clientSourceEntrySize(entry: unknown): number | null {
	if (entry === null || typeof entry !== 'object') return 1;
	const { source, value } = entry as { source?: unknown; value?: unknown };
	if (typeof source !== 'string' || !CLIENT_SOURCE_ARRAY_SOURCES.has(source)) return null;
	return 1 + asSqoValueList(value).length;
}

/**
 * A declared `section_tipo` split into its 'self' part and the rest. `null`
 * when it is neither a source array nor a string array holding 'self' — i.e.
 * a value every seam keeps verbatim (plain string, plain string list, absent).
 * Every 'self' spelling counts (self_depth.ts splitSelfSectionTipoEntry), and a
 * mixed entry splits: `{source:'section', value:['self','rsc197']}` → namesSelf
 * + rest `[{source:'section', value:['rsc197']}]`.
 */
function splitDeclaredSectionTipo(
	raw: unknown,
): { namesSelf: boolean; rest: unknown[]; restIsSourceArray: boolean } | null {
	const entries = declaredEntriesOf(raw);
	if (entries === null) return null;
	const { namesSelf, rest } = splitSelfEntries(entries);
	if (!namesSelf && !isSourceArraySectionTipo(raw)) return null; // plain tipo list
	return { namesSelf, rest, restIsSourceArray: isSourceArraySectionTipo(rest) };
}

/** A declaration as a list of entries; `null` for a plain string or an absent value. */
function declaredEntriesOf(raw: unknown): unknown[] | null {
	if (Array.isArray(raw)) return raw;
	return isSourceArraySectionTipo(raw) ? [raw] : null;
}

/** Every entry split (self_depth.ts splitSelfSectionTipoEntry): any 'self' + what is left. */
function splitSelfEntries(entries: readonly unknown[]): { namesSelf: boolean; rest: unknown[] } {
	let namesSelf = false;
	const rest: unknown[] = [];
	for (const entry of entries) {
		const split = splitSelfSectionTipoEntry(entry);
		if (split.namesSelf) namesSelf = true;
		if (split.rest !== null) rest.push(split.rest);
	}
	return { namesSelf, rest };
}

/**
 * A declared `section_tipo` as "does it name 'self'" + the plain section tipos
 * the REST of it resolves to (a source-array rest through THE sqo resolver,
 * resolveSqoSectionTipos; plain strings verbatim). `null` for a declaration
 * every seam keeps verbatim (plain string, plain string list, absent) — the
 * caller decides what that means for it. The one split behind
 * resolveDdoSectionTipo, resolveRawDdoSectionTipo and stage 1 (from_rqo.ts).
 *
 *   [{source:'self'}, {source:'section', value:['test38']}] → {namesSelf, sections:['test38']}
 *   [{source:'section', value:['self']}]                   → {namesSelf, sections:[]}
 *   [{value:[1], source:'hierarchy_types'}]                → {!namesSelf, sections:[es1, fr1, …]}
 *   'rsc197' / ['rsc197'] / undefined                      → null
 */
export async function resolveSectionTipoDeclaration(
	raw: unknown,
	context: RequestConfigContext,
): Promise<{ readonly namesSelf: boolean; readonly sections: string[] } | null> {
	const split = splitDeclaredSectionTipo(raw);
	if (split === null) return null;
	const sections = split.restIsSourceArray
		? await resolveSqoSectionTipos(split.rest, context)
		: (split.rest.filter((entry) => typeof entry === 'string') as string[]);
	return { namesSelf: split.namesSelf, sections };
}

/**
 * A ddo's `section_tipo`, resolved (PHP resolve_ddo_self_references :250-255,
 * extended by owner decision (c) of the nested-ddo_map plan, 2026-11-03).
 *
 * ONE MEANING OF 'self' IN A DDO, whatever its spelling — the literal
 * `'self'`, a `'self'` string inside an array, a `{source:'self'}` entry, a
 * `'self'` inside a section-semantics entry's value — self_depth.ts refuses all
 * four at depth >= 2 as one sentinel, so at depth 1 all four must mean the same
 * sections:
 *  - a normal ddo → the item's TARGET sections (the child lives at the portal
 *    targets; the owner section only when the item has no targets);
 *  - a component_dataframe → the owner section (frames live on the caller's
 *    record) — SCALAR for the literal, a one-entry list inside an array.
 * Example, tch197 (a portal in tch1 → rsc1389), a direct child rsc1399:
 *   'self'                                 → ['rsc1389']
 *   ['self']                               → ['rsc1389']   (PHP kept it verbatim: it matched nothing)
 *   [{source:'self'}]                      → ['rsc1389']   (NOT tch1 — the sqo meaning would be
 *                                                           the owner's section, which holds no rsc1399)
 *   [{source:'section', value:['self']}]   → ['rsc1389']   (NOT tch1, same reason)
 *
 * The REST of a source array (`[{value:[1], source:'hierarchy_types'}]`,
 * `{source:'section', value:[…]}`, a mix with plain strings) resolves through
 * THE resolver `sqo.section_tipo` uses (resolveSqoSectionTipos), never a fork —
 * so a self-free declaration means the same sections in both places. The
 * resolved list may be empty (an inactive typology); it stays empty — the ddo
 * then matches no section, which is the honest answer.
 *
 * Anything else (plain string, plain string list, absent) → verbatim. An absent
 * section_tipo stays absent: the per-locator grouping treats undeclared as
 * match-all.
 */
export async function resolveDdoSectionTipo(
	rawSectionTipo: unknown,
	model: string,
	context: RequestConfigContext,
	targetTipos: readonly string[],
): Promise<string | string[] | undefined> {
	const isDataframe = model === 'component_dataframe';
	const selfSections = ddoSelfSections(isDataframe, context, targetTipos);
	if (rawSectionTipo === 'self') return isDataframe ? context.ownerSectionTipo : selfSections;
	const declaration = await resolveSectionTipoDeclaration(rawSectionTipo, context);
	if (declaration === null) return rawSectionTipo as string | string[] | undefined;
	return [...new Set([...(declaration.namesSelf ? selfSections : []), ...declaration.sections])];
}

/**
 * What a ddo's 'self' names at depth 1 (resolveDdoSectionTipo): the item's
 * TARGET sections — the owner section for a dataframe (frames live on the
 * caller's record) or when the item has no targets.
 */
function ddoSelfSections(
	isDataframe: boolean,
	context: RequestConfigContext,
	targetTipos: readonly string[],
): string[] {
	return isDataframe || targetTipos.length === 0 ? [context.ownerSectionTipo] : [...targetTipos];
}

/**
 * The same declaration at a RAW seam — the list-cell path that copies config
 * ddos AS DECLARED (relations/models/portal.ts, rawListDdos), where the
 * literal `'self'` deliberately stays the per-locator MATCH-ALL wildcard
 * (relation_core ddoTargetsSection) because the item targets are not in hand.
 * Without this the raw seam kept a source array as objects, which match no
 * locator: the edit context (resolved by processSingleDdo) showed the column
 * and the list data left it empty.
 *  - any 'self' spelling (all four) → `'self'` (the raw seam's own meaning of
 *    it; the rest of a declaration that also names 'self' is subsumed — every
 *    locator of the portal is at one of its targets);
 *  - a self-free source array → resolveSqoSectionTipos, exactly as above;
 *  - anything else → verbatim.
 */
export async function resolveRawDdoSectionTipo(
	rawSectionTipo: unknown,
	context: RequestConfigContext,
): Promise<string | string[] | undefined> {
	if (rawSectionTipo === 'self') return 'self';
	const split = splitDeclaredSectionTipo(rawSectionTipo);
	if (split === null) return rawSectionTipo as string | string[] | undefined;
	if (split.namesSelf) return 'self';
	return resolveSqoSectionTipos(split.rest, context);
}

/** Process one raw ddo (PHP process_single_ddo, the 11-step pipeline — v0 subset).
 * `targetTipos` = the item's RESOLVED sqo target sections: a non-dataframe
 * ddo's section_tipo 'self' resolves to THEM (PHP resolve_ddo_self_references
 * :250-255 — the ddo describes a component AT THE TARGET, not the caller);
 * dataframes get the CALLER section (scalar); undefined stays untouched. */
async function processSingleDdo(
	rawDdo: Record<string, unknown>,
	context: RequestConfigContext,
	mapType: 'show' | 'search' | 'choose' | 'hide',
	targetTipos: string[] = [],
): Promise<ProcessedDdo | null> {
	const tipo = rawDdo.tipo;
	if (typeof tipo !== 'string' || tipo === '') return null; // step 1: drop
	const node = await getNode(tipo);
	if (node === null) return null; // step 2: invalid tipo → drop
	const model = await getModelByTipo(tipo);
	if (model === null) return null;

	// step 4: groupers dropped in show+list
	if (mapType === 'show' && context.mode === 'list' && model.startsWith('section_group')) {
		return null;
	}

	// step 6: self references (PHP resolve_ddo_self_references :250-255) —
	// 'self' resolves to the item's TARGET sections for normal ddos (the
	// child lives at the portal targets) and to the SCALAR caller section for
	// dataframes (frames live on the caller's record). An UNDEFINED
	// section_tipo stays undefined (PHP only rewrites the literal 'self');
	// the per-locator grouping treats undeclared as match-all. Every 'self'
	// spelling means the same sections, and an SQO source-array section_tipo
	// resolves through resolveSqoSectionTipos (resolveDdoSectionTipo above).
	const sectionTipo = await resolveDdoSectionTipo(rawDdo.section_tipo, model, context, targetTipos);
	const parent = rawDdo.parent === 'self' ? context.ownerTipo : ((rawDdo.parent as string) ?? '');

	// step 7: mode — unset modes: non-section owners force 'list'; section owners
	// inherit the caller mode (PHP resolve_ddo_mode). The 'tm' propagation arm is
	// gone with the display mode itself (WC-2026-08-14-tm-ddo-mode-retired): a
	// Time Machine ddo now arrives as 'list' and takes the ordinary path.
	const rawMode = rawDdo.mode as string | undefined;
	const mode = rawMode ?? (context.ownerIsSection ? context.mode : 'list');

	// step 5: label enrichment when absent.
	const label = (rawDdo.label as string | undefined) ?? (await contextLabelOf(tipo));

	// step 11 (PHP process_single_ddo :146-52 → check_ddo_permissions :381-92):
	// SECTION-owned configs drop ddos the actor holds level 0 on — portals and
	// component-owned configs are NEVER gated here (PHP guards on
	// context->model==='section'). The principal comes from the request-context
	// ALS at CALL TIME (never module-hoisted); absent principal = no filter
	// (internal resolutions — the emission backstop in section/read.ts is the
	// confidentiality boundary for client-driven maps).
	if (context.ownerIsSection) {
		const { currentPrincipal } = await import('../../security/request_context.ts');
		const { ddoIsAuthorized } = await import('../../security/permissions.ts');
		const authorized = await ddoIsAuthorized(
			currentPrincipal(),
			sectionTipo ?? context.ownerSectionTipo,
			tipo,
		);
		if (!authorized) return null;
	}

	const processed: ProcessedDdo = {
		...rawDdo,
		tipo,
		model,
		section_tipo: sectionTipo,
		parent,
		mode,
		label,
		// step 8 (PHP resolve_ddo_fixed_mode): mode is resolved for every ddo by
		// this point, so every processed ddo is fixed_mode — the client keeps the
		// ddo's mode for the cell instance instead of downgrading to list.
		fixed_mode: true,
	};

	// step 9 (PHP resolve_ddo_fields_map, trait.request_config_ddo.php:350) —
	// see hydrateDdoFieldsMap. Runs LAST because it stamps model/lang/permissions
	// over the enrichment above (PHP assigns in the same order).
	if (mapType === 'show' && rawDdo.fields_map === true) {
		await hydrateDdoFieldsMap(processed, node.properties, context);
	}

	return processed;
}

/**
 * STEP 9 — external-API fields_map hydration (PHP resolve_ddo_fields_map,
 * trait.request_config_ddo.php:329-359; v6 class.common.php:3335-3348).
 *
 * A show ddo declaring the literal `fields_map: true` is saying "the real
 * mapping lives on my own ontology node". The flag is REPLACED by that node's
 * `properties.fields_map`, and the ddo is stamped with the node's properties,
 * lang, model and the actor's permissions.
 *
 * THIS IS A LIVE CLIENT CONTRACT, not a parity nicety: the zenon autocomplete
 * reads `fields[j].fields_map[0].remote` when shaping a remote answer
 * (client/dedalo/core/services/service_autocomplete/js/service_autocomplete.js:911)
 * and again when building `&field[]=` for the search request (:1060), where
 * `fields` IS `rqo_search.show.ddo_map` (:887). Dropping the hydrated
 * fields_map from the wire asks the service for no fields and renders nothing.
 *
 * The echoed `properties` go through the SAME publication shaper as everywhere
 * else (publishApiConfig): today every component_external node carries only
 * `fields_map`, so the strip is a measured no-op — but a node is editable data
 * and this is a wire-facing echo.
 */
async function hydrateDdoFieldsMap(
	ddo: ProcessedDdo,
	nodeProperties: unknown,
	context: RequestConfigContext,
): Promise<void> {
	const { sanitizeEmittedProperties } = await import('../../resolve/structure_context.ts');
	// DEEP-CLONE FIRST. `nodeProperties` is the RESOLVER CACHE's object (getNode).
	// sanitizeEmittedProperties returns it UNCHANGED when there is no api_config
	// — so the cache object and its `fields_map` array would go on the wire and
	// be mutable by any stamp-time caller — and when there IS one it assigns
	// `properties.api_config = published` IN PLACE, which would poison the cache
	// with the publication-stripped shape for every later reader (admin/tools
	// read raw ontology properties). The other caller of the shaper,
	// resolveEmittedPropertiesAndCss, clones for the same reason
	// (structure_context.ts, PHP SEC-023).
	const properties = sanitizeEmittedProperties(
		structuredClone((nodeProperties ?? {}) as Record<string, unknown>),
		ddo.tipo,
	);
	ddo.properties = properties;
	ddo.fields_map = Array.isArray(properties.fields_map) ? properties.fields_map : [];
	// PHP: DEDALO_DATA_LANG when the node is translatable, DEDALO_DATA_NOLAN
	// otherwise — an external component must know which language axis its data
	// lives on. Every component_external in this install is non-translatable.
	const { getTranslatableByTipo } = await import('../../ontology/resolver.ts');
	const { currentDataLang } = await import('../../resolve/request_lang.ts');
	ddo.lang = (await getTranslatableByTipo(ddo.tipo)) ? currentDataLang() : 'lg-nolan';
	// PHP re-reads the model here (guards against an earlier mismatched stamp).
	ddo.model = (await getModelByTipo(ddo.tipo)) ?? ddo.model;
	// PHP common::get_permissions($ddo->section_tipo, $ddo->tipo). Absent
	// principal = internal resolution → the v0 admin posture (3) this parser
	// stamps everywhere else (buildSqoSectionTipoDdos).
	const { currentPrincipal } = await import('../../security/request_context.ts');
	const { getPermissions } = await import('../../security/permissions.ts');
	const principal = currentPrincipal();
	const permissionSection = Array.isArray(ddo.section_tipo)
		? ddo.section_tipo[0]
		: (ddo.section_tipo ?? context.ownerSectionTipo);
	ddo.permissions =
		principal === undefined || permissionSection === undefined
			? 3
			: await getPermissions(principal, permissionSection, ddo.tipo);
}

/**
 * One ENRICHED sqo.section_tipo entry (PHP build_sqo_section_tipo_ddo,
 * trait.request_config_utils.php:424): the CLIENT consumes these — the
 * portal link/new buttons read target_section[0].tipo, the header chips read
 * label/color, the button visibility reads permissions/buttons. Field order
 * matches the PHP wire: typo, tipo, model, permissions, label, buttons,
 * color, matrix_table.
 */
export interface SqoSectionTipoDdo {
	typo: 'ddo';
	tipo: string;
	model: string;
	permissions: number;
	label: string | null;
	buttons: { model: string; permissions: number }[];
	color: string;
	matrix_table: string | null;
}

/** A parsed request_config item (v0 field subset). */
export interface ParsedRequestConfigItem {
	api_engine: string;
	type: string;
	sqo: {
		section_tipo: SqoSectionTipoDdo[];
		limit?: number;
		offset?: number;
		[extra: string]: unknown;
	};
	show: { ddo_map: ProcessedDdo[]; sqo_config?: unknown } | null;
	search: { ddo_map: ProcessedDdo[]; sqo_config?: unknown } | null;
	choose: { ddo_map: ProcessedDdo[]; sqo_config?: unknown } | null;
	hide: { ddo_map: ProcessedDdo[] } | null;
	/**
	 * The filter_free search paths, emitted only when they differ from the
	 * search/show map (relation columns spelled through what they display) —
	 * ./search_display_paths.ts. Read only by the client's build_rqo_search.
	 */
	search_paths?: ProcessedDdo[];
	/**
	 * The TARGET SECTION's external binding, shaped for publication
	 * (src/external/config.ts publishApiConfig). `null` on every dedalo item —
	 * PHP emits the key unconditionally and the client's portal edit handler
	 * reads it (component_portal.js:2054), so its ABSENCE would be a wire
	 * divergence. Only ./external.ts may set it to a non-null value.
	 */
	api_config: PublishedApiConfig | null;
}

/**
 * Flat tipo strings of a parsed item's (enriched) sqo.section_tipo (PHP
 * extract_section_tipos_from_sqo, trait.request_config_v6.php:666) — the
 * projection every ENGINE-side consumer works with.
 */
export function extractSqoSectionTipos(item: ParsedRequestConfigItem | undefined): string[] {
	// `sqo?.`: a caller-only config (relations/element_node.ts NO OWN CONFIG AT
	// ALL — a bare portal whose caller's children ARE its config) carries no sqo,
	// so it names no target section.
	const entries = item?.sqo?.section_tipo ?? [];
	// Deduped WITHIN this one config item (PHP array_unique at the end of
	// get_request_config_section_tipo, :2892-95). Cross-CONFIG duplicates are
	// preserved by the consumers that flatten multi-config elements — PHP
	// get_ar_target_section_ddo concatenates configs without dedup (:3070-77),
	// so a two-config element repeats its shared targets (e.g. numisdata560).
	return [
		...new Set(
			entries
				.map((entry) => (typeof entry === 'string' ? entry : entry?.tipo))
				.filter((tipo): tipo is string => typeof tipo === 'string' && tipo !== ''),
		),
	];
}

/**
 * (sectionTipo, buttonModel) → the button tipo, or null. Pure dd_ontology shape,
 * so it caches exactly like the resolver's own lookups (hub-cleared on every
 * dd_ontology write by the factory).
 *
 * WHY IT NEEDS A CACHE. `buildSqoSectionTipoDdos` enriches EVERY resolved sqo
 * target, and an sqo with a `source: 'ontology_sections'` resolves to every
 * ontology registry target on the install — 205 sections on dedalo7_mht. Each
 * one cost two probes (`button_new` + `button_delete`), and a section with no
 * such child cost FOUR: the miss, then the virtual-section fallback's own two
 * queries. `ontology10`/`ontology42` measured 42ms per resolution because of it,
 * which is 17.3s of the 20.6s an LLM-map build spent — and the same 42ms is paid
 * by the live autocomplete on those components. Nothing here is record data:
 * the answer only moves when the ontology does.
 *
 * NULL IS A CACHED ANSWER. "no button of this model" is the common case and the
 * expensive one (four queries), so it must be stored, not re-derived — hence
 * `has()` rather than a truthiness check on `get()`.
 */
const sectionButtonCache = createOntologyCache<string, string | null>();

/** button_new/button_delete direct children of a section (virtual-aware). */
async function findSectionButtonTipo(
	sectionTipo: string,
	buttonModel: string,
): Promise<string | null> {
	const cacheKey = `${sectionTipo} ${buttonModel}`;
	if (sectionButtonCache.has(cacheKey)) return sectionButtonCache.get(cacheKey) ?? null;
	const read = async (parent: string) =>
		(await sql.unsafe('SELECT tipo FROM dd_ontology WHERE parent = $1 AND model = $2 LIMIT 1', [
			parent,
			buttonModel,
		])) as { tipo: string }[];
	let rows = await read(sectionTipo);
	if (rows.length === 0) {
		// virtual section: borrow the REAL section's button (getSectionRealTipo)
		const real = await getSectionRealTipo(sectionTipo);
		if (real !== sectionTipo) rows = await read(real);
	}
	const found = rows[0]?.tipo ?? null;
	sectionButtonCache.set(cacheKey, found);
	return found;
}

/**
 * Enrich resolved target-section tipos into the client-facing ddo objects
 * (PHP build_sqo_section_tipo_ddo, trait.request_config_utils.php:424): app-lang
 * label, properties color (gray default), THE CALLER's permissions on the target
 * section, and — only above read level — the section's button_new/button_delete
 * descriptors, each carrying its OWN grant (build_section_buttons, :467).
 *
 * PERMISSIONS ARE THE CALLER's (audit 2026-08 §7, fixed 2026-08-09). This used
 * to stamp a literal 3, so a user with write on a portal but read-only on its
 * TARGET section was still offered "New", the row unlink and "Delete resource
 * and all links": the server refused the writes, but offering an action that
 * will be refused is its own defect. PHP reads `common::get_permissions($t,$t)`
 * — the SECTION-level grant, NOT get_section_permissions (no consultation-only
 * cap here).
 *
 * ABSENT PRINCIPAL = internal resolution (boot/tooling/tests outside a request
 * scope): keep the v0 admin posture 3, exactly like the sibling per-ddo stamp
 * at the end of hydrateDdoFieldsMap above. dispatchRqo seeds the principal for
 * every SESSIONED request, so an authenticated caller never lands on the
 * fallback; the sessionless actions that skip the seeding (login and the other
 * gate-2 exemptions) build no request_config. These numbers are UI affordances
 * either way — every read and write is authorized independently server-side.
 */
export async function buildSqoSectionTipoDdos(tipos: string[]): Promise<SqoSectionTipoDdo[]> {
	const { getMatrixTableFromTipo } = await import('../../ontology/resolver.ts');
	const { currentPrincipal } = await import('../../security/request_context.ts');
	const { getPermissions } = await import('../../security/permissions.ts');
	const principal = currentPrincipal();
	const enriched: SqoSectionTipoDdo[] = [];
	for (const tipo of tipos) {
		const permissions = principal === undefined ? 3 : await getPermissions(principal, tipo, tipo);
		const node = await getNode(tipo);
		const buttons: { model: string; permissions: number }[] = [];
		if (permissions > 1) {
			for (const buttonModel of ['button_new', 'button_delete']) {
				const buttonTipo = await findSectionButtonTipo(tipo, buttonModel);
				if (buttonTipo === null) continue;
				// PHP stamps the BUTTON's own grant, not the section's.
				buttons.push({
					model: buttonModel,
					permissions:
						principal === undefined ? 3 : await getPermissions(principal, tipo, buttonTipo),
				});
			}
		}
		enriched.push({
			typo: 'ddo',
			tipo,
			model: (await getModelByTipo(tipo)) ?? 'section',
			permissions,
			label: await contextLabelOf(tipo),
			buttons,
			color: (node?.properties as { color?: string } | null)?.color ?? '#b9b9b9',
			matrix_table: await getMatrixTableFromTipo(tipo),
		});
	}
	return enriched;
}

/**
 * Dynamic ddo_map from section_map columns (PHP resolve_get_ddo_map,
 * trait.request_config_ddo.php:424, model 'section_map'): for every resolved
 * target section, each column's [scope, key] path names the component
 * tipo(s) via the section's section_map (SCOPE_FALLBACK-aware). A component
 * tipo seen under several target sections merges into ONE ddo whose
 * section_tipo becomes the array of those sections. Extra column properties
 * (mode, label, …) apply to the generated ddo; 'path' is build-time only.
 */
async function resolveGetDdoMap(
	targetSections: string[],
	getDdoMap: unknown,
	context: RequestConfigContext,
): Promise<Record<string, unknown>[]> {
	if (getDdoMap === false || getDdoMap === null || getDdoMap === undefined) return [];
	const directive = getDdoMap as { model?: unknown; columns?: unknown[] };
	if (typeof directive !== 'object' || directive.model !== 'section_map') return [];
	const columns = Array.isArray(directive.columns) ? directive.columns : [];

	const { getSectionMapValue } = await import('../../ontology/section_map.ts');
	const calculated: Record<string, unknown>[] = [];
	const processedTipos = new Set<string>();
	for (const currentSection of targetSections) {
		for (const originalColumn of columns) {
			// pre-2024-08-10 compatibility: bare-array columns ARE the path.
			const column = Array.isArray(originalColumn)
				? { path: originalColumn }
				: (originalColumn as { path?: unknown[] } & Record<string, unknown>);
			const path = Array.isArray(column.path) ? column.path : [];
			if (path.length !== 2) continue;
			const value = await getSectionMapValue(currentSection, String(path[0]), String(path[1]));
			if (value === null || value === undefined || value === '') continue;
			for (const componentTipo of Array.isArray(value) ? value : [value]) {
				if (typeof componentTipo !== 'string') continue;
				if (processedTipos.has(componentTipo)) {
					// Dedup merge: extend the existing ddo's section_tipo array.
					const existing = calculated.find((ddo) => ddo.tipo === componentTipo);
					if (existing !== undefined) {
						const current = existing.section_tipo;
						existing.section_tipo = [
							...(Array.isArray(current) ? current : [current]),
							currentSection,
						];
					}
					continue;
				}
				const ddo: Record<string, unknown> = {
					tipo: componentTipo,
					section_tipo: currentSection,
					parent: context.ownerTipo,
				};
				for (const [key, extra] of Object.entries(column)) {
					if (key === 'path') continue;
					ddo[key] = extra;
				}
				processedTipos.add(componentTipo);
				calculated.push(ddo);
			}
		}
	}
	return calculated;
}

/**
 * Resolve a CALLER-sent `get_ddo_map` (section_map directive) for a single
 * owner section — the search-panel preset picker names its label column by ROLE
 * ({path:['default','term']}) so the tipo is never hardcoded. Thin wrapper over
 * resolveGetDdoMap with the section as its own single target; returns the raw
 * ddos (the section read maps them to its Ddo shape). Empty when the directive
 * is absent/non-section_map or the role resolves to nothing.
 */
export async function resolveSectionMapGetDdoMap(
	ownerTipo: string,
	ownerSectionTipo: string,
	directive: unknown,
): Promise<Record<string, unknown>[]> {
	return resolveGetDdoMap([ownerTipo], directive, {
		ownerTipo,
		ownerSectionTipo,
		mode: 'list',
		ownerIsSection: true,
	});
}

/** Parse one block (show/search/choose/hide) — ddo_map processing + passthrough. */
async function parseBlock(
	rawBlock: unknown,
	context: RequestConfigContext,
	mapType: 'show' | 'search' | 'choose' | 'hide',
	targetSections: string[] = [],
): Promise<{ ddo_map: ProcessedDdo[]; [extra: string]: unknown } | null> {
	if (rawBlock === null || rawBlock === undefined || typeof rawBlock !== 'object') return null;
	const block = rawBlock as Record<string, unknown>;
	// Resolution order (PHP parse_show_config): explicit ddo_map first, else
	// the dynamic get_ddo_map directive over the resolved target sections.
	let rawMap = Array.isArray(block.ddo_map) ? (block.ddo_map as Record<string, unknown>[]) : [];
	if (rawMap.length === 0 && block.get_ddo_map !== undefined) {
		rawMap = await resolveGetDdoMap(targetSections, block.get_ddo_map, context);
	}
	// Owner decision (c): a ddo below the first level that declares
	// `section_tipo: 'self'` (any of its four spellings) is REFUSED here, on the
	// RAW map — processing rewrites 'self' into the owner's targets and the
	// sentinel would be gone. ONE place, so the data path and the context agree.
	rawMap = skipDeepSelfDdos(rawMap, context, mapType);
	const processed: ProcessedDdo[] = [];
	for (const rawDdo of rawMap) {
		const ddo = await processSingleDdo(rawDdo, context, mapType, targetSections);
		if (ddo !== null) processed.push(ddo);
	}
	return { ...block, ddo_map: processed };
}

/**
 * The raw block map without its level >= 2 'self' ddos (self_depth.ts). The
 * refusals go to the context's notice sink when one is given (the emission
 * registry — relations/element_node.ts), else to ONE bounded log line.
 */
function skipDeepSelfDdos(
	rawMap: Record<string, unknown>[],
	context: RequestConfigContext,
	mapType: string,
): Record<string, unknown>[] {
	// A tipo-less entry takes no part in the parent-chain walk; it stays in
	// place for processSingleDdo, which reports it.
	const walkable = rawMap.filter(
		(ddo) => ddo !== null && typeof ddo === 'object' && typeof ddo.tipo === 'string',
	) as (Record<string, unknown> & { tipo: string })[];
	const { kept, notices } = partitionDeepSelfDdos(context.ownerTipo, walkable);
	if (notices.length === 0) return rawMap;
	const keptDdos = new Set<unknown>(kept);
	const walkableDdos = new Set<unknown>(walkable);
	const survivors = rawMap.filter((ddo) => !walkableDdos.has(ddo) || keptDdos.has(ddo));
	if (context.notices !== undefined) {
		context.notices.push(...notices);
	} else {
		const named = notices.map((notice) => `${notice.details?.ddo}<${notice.details?.parent}`);
		// boundedNotices puts the remainder on the LAST notice shown (0 on the
		// others): sum it, never read one position.
		const more = notices.reduce((sum, notice) => sum + Number(notice.details?.more ?? 0), 0);
		console.warn(
			`[request_config/explicit] ${context.ownerTipo} ${mapType}: skipped ddo(s) declaring section_tipo 'self' below the first level: ${named.join(', ')}${more > 0 ? ` (+${more} more)` : ''} — declare their section_tipo explicitly`,
		);
	}
	return survivors;
}

/**
 * Parse a component's properties.source.request_config. Returns [] when
 * absent (the caller decides on the implicit fallback via ./build.ts).
 *
 * Live sqo expansions (PHP parse_request_config_item steps 2 + 8): the
 * declarative `filter_by_list` / `fixed_filter` entries resolve to their
 * live values (./filters.ts — record data, never cache a config carrying
 * them), and non-dedalo engines get the target section's `api_config`
 * attached (./external.ts).
 */
/**
 * ONE config item's target sections, resolving the three-way precedence.
 *
 * @param declaredTipos what the item's own `sqo.section_tipo` resolved to, or
 *   NULL when it declared no `section_tipo` key at all.
 *
 * 1. a DECLARED target that resolved something wins outright;
 * 2. otherwise the owner MODEL's default applies when it has one — including an
 *    EMPTY one, which means "this model owns the target and has none here"
 *    (see the null-vs-[] contract on ./target_sources.ts). Falling through would
 *    hand hierarchy27 its caller's own section as its option source;
 * 3. otherwise the historical rules stand: an absent `section_tipo` targets the
 *    CALLER's own section (PHP resolve_sqo_section_tipo :256-258 — the
 *    self-targeting shape of relation_related configs like numisdata36), and a
 *    present-but-unresolvable one stays empty.
 */
function resolveItemTargetTipos(
	declaredTipos: string[] | null,
	context: RequestConfigContext,
): string[] {
	if (declaredTipos !== null && declaredTipos.length > 0) return declaredTipos;
	if (context.modelDefaultTargets !== undefined) return [...context.modelDefaultTargets];
	return declaredTipos ?? [context.ownerSectionTipo];
}

export async function buildExplicitRequestConfig(
	properties: unknown,
	context: RequestConfigContext,
): Promise<ParsedRequestConfigItem[]> {
	const rawConfig = (properties as { source?: { request_config?: unknown } } | null)?.source
		?.request_config;
	if (!Array.isArray(rawConfig)) return [];

	const parsed: ParsedRequestConfigItem[] = [];
	for (const rawItem of rawConfig) {
		if (rawItem === null || typeof rawItem !== 'object') continue; // PHP: warn+drop
		const item = rawItem as Record<string, unknown>;
		const rawSqo = (item.sqo ?? {}) as Record<string, unknown>;
		// An sqo WITHOUT section_tipo targets the CALLER's own section (PHP
		// resolve_sqo_section_tipo :256-258 — the self-targeting sqo shape of
		// relation_related configs like numisdata36/numisdata1006). The
		// resolved tipos ship ENRICHED as ddo objects (the client contract);
		// engine consumers project back via extractSqoSectionTipos.
		const declaredTipos =
			rawSqo.section_tipo === undefined
				? null
				: await resolveSqoSectionTipos(rawSqo.section_tipo, context);
		// MODEL DEFAULT fills silence, never overrides (context.modelDefaultTargets
		// above): a declared sqo that RESOLVED something is kept verbatim; a sqo
		// that is absent, or present-but-empty (hierarchy27 ships the honest
		// `section_tipo: []` precisely because its target cannot be written into a
		// node shared by 54 sections), falls to the owner model's targetSource.
		// Only when there is no default either does the historical caller-section
		// fallback apply (PHP resolve_sqo_section_tipo :256-258 — the
		// self-targeting shape of relation_related configs like numisdata36).
		const targetTipos = resolveItemTargetTipos(declaredTipos, context);
		const sqo: ParsedRequestConfigItem['sqo'] = {
			...rawSqo,
			section_tipo: await buildSqoSectionTipoDdos(targetTipos),
		};
		// Live filter expansions (PHP resolve_sqo_section_tipo :275-292).
		if (rawSqo.filter_by_list !== undefined) {
			const { expandFilterByList } = await import('./filters.ts');
			sqo.filter_by_list = await expandFilterByList(
				rawSqo.filter_by_list,
				context.lang ?? 'lg-spa',
			);
		}
		if (rawSqo.fixed_filter !== undefined) {
			const { expandFixedFilter } = await import('./filters.ts');
			sqo.fixed_filter = await expandFixedFilter(
				rawSqo.fixed_filter,
				context.ownerSectionTipo,
				context.ownerSectionId ?? null,
			);
		}
		const parsedItem: ParsedRequestConfigItem = {
			api_engine: (item.api_engine as string) ?? 'dedalo',
			type: (item.type as string) ?? 'main',
			sqo,
			show: await parseBlock(item.show, context, 'show', targetTipos),
			search: await parseBlock(item.search, context, 'search', targetTipos),
			choose: await parseBlock(item.choose, context, 'choose', targetTipos),
			hide: await parseBlock(item.hide, context, 'hide', targetTipos),
			// PHP emits `api_config` on EVERY item, null for the dedalo engine
			// (verified in the frozen harvest, request_config_differential.json).
			api_config: null,
		};
		// PHP resolve_show_sqo_config → build_sqo_config_default: when a config
		// declares a custom page size (sqo.limit) but ships no explicit
		// show.sqo_config, synthesize one so the client paginator — which reads
		// show.sqo_config.limit (section.js:827) for subsequent pages — uses that
		// page size instead of the global 10 default. Scoped to configs WITH an
		// explicit sqo.limit (e.g. dd542 Activity's dd549 → 30) so the general
		// element wire shape is untouched; matches PHP's emitted sqo_config shape.
		if (
			parsedItem.show &&
			(parsedItem.show as { sqo_config?: unknown }).sqo_config === undefined &&
			typeof rawSqo.limit === 'number' &&
			rawSqo.limit > 0
		) {
			(parsedItem.show as { sqo_config?: unknown }).sqo_config = {
				full_count: false,
				limit: rawSqo.limit,
				offset: typeof rawSqo.offset === 'number' ? rawSqo.offset : 0,
				mode: context.mode,
				operator: '$or',
			};
		}
		// PHP parse_choose_config sqo_config tail (trait.request_config_v6.php:549-563):
		// a config WITH a choose block always ships choose.sqo_config.limit — the
		// autocomplete selection size resolved SERVER-side (single source of truth),
		// falling back choose → search.sqo_config → show.sqo_config → 25. An explicit
		// 0 is VALID (disables the picker). A choose-LESS config stays choose-less
		// (PHP early-returns; the client owns that fallback chain — common.js
		// build_rqo_search).
		if (parsedItem.choose !== null) {
			const chooseBlock = parsedItem.choose as {
				sqo_config?: { limit?: unknown; [extra: string]: unknown } | null;
			};
			if (chooseBlock.sqo_config === undefined || chooseBlock.sqo_config === null) {
				chooseBlock.sqo_config = {};
			}
			if (chooseBlock.sqo_config.limit === undefined || chooseBlock.sqo_config.limit === null) {
				const fallbackLimit = (
					(parsedItem.search as { sqo_config?: { limit?: unknown } } | null)?.sqo_config ??
					(parsedItem.show as { sqo_config?: { limit?: unknown } } | null)?.sqo_config
				)?.limit;
				chooseBlock.sqo_config.limit = typeof fallbackLimit === 'number' ? fallbackLimit : 25;
			}
		}
		// External engines carry the target section's api_config (PHP step 8).
		if (parsedItem.api_engine !== 'dedalo') {
			const { resolveExternalConfig } = await import('./external.ts');
			await resolveExternalConfig(parsedItem);
		}
		parsed.push(parsedItem);
	}
	return parsed;
}
