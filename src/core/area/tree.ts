/**
 * area_thesaurus / area_ontology get_data — the tree-area boot payload (PHP
 * area_thesaurus_json via hierarchy/ontology::get_active_elements). Relocated
 * from resolve/area_hierarchy.ts into the area module (engineering/AREA_SPEC.md §5);
 * semantics unchanged (byte-parity gate: area_hierarchy_differential.test.ts).
 *
 *   data[0] = { tipo, value: hierarchy_item[], typologies: typology[] }
 *   hierarchy_item = { section_id, section_tipo, target_section_tipo,
 *     target_section_name, children_tipo, typology_section_id, order,
 *     type:'hierarchy', active_in_thesaurus, root_terms: locator[] }
 *   typology = { section_id, type:'typology', label, order }
 *
 * Sources (hierarchy1 records on matrix_hierarchy_main; ontology35 for the
 * ontology area): active = hierarchy4 dd64/1; name = hierarchy5 (lang slice);
 * target = hierarchy53; typology = hierarchy9 locator → hierarchy13 record
 * (label hierarchy16, order hierarchy106); order = hierarchy48 ?? 0;
 * active_in_thesaurus = hierarchy125 dd64/1; root_terms = hierarchy45
 * locators (sanitized; hierarchy59 in model view); children_tipo = the target
 * section's component_relation_children (recursive, virtual-resolved; ontology
 * fixed 'ontology14'). THESAURUS skips: not active_in_thesaurus, no target, no
 * typology, no root terms, no children_tipo. ONTOLOGY keeps inactive/rootless
 * entries and pins typology_section_id '14'. Typologies dedup by section_id in
 * first-seen order.
 */

import { canonicalizeStoredSectionId } from '../concepts/section_id.ts';
import { sql } from '../db/postgres.ts';
import { createOntologyCache } from '../ontology/cache_factory.ts';
import { registerOntologyCacheClearer } from '../ontology/cache_invalidation.ts';
import { findFirstDescendantTipoByModel, getMatrixTableFromTipo } from '../ontology/resolver.ts';
import { isTargetAllowed } from '../relations/picker_constraint.ts';
import { composeContains, locatorJsonVariants } from '../search/containment.ts';

// Hierarchy/ontology component tipos this resolver reads (kept local — they are
// this projection's concern, not the area taxonomy's).
const ONTOLOGY_MAIN_SECTION = 'ontology35';
const THESAURUS_MAIN_SECTION = 'hierarchy1';
const ONTOLOGY_CHILDREN_TIPO = 'ontology14';
const ONTOLOGY_TYPOLOGY_ID = '14';
const TYPOLOGY_SECTION_FALLBACK = 'hierarchy13';
const NAME_TIPO = 'hierarchy5';
const TARGET_TIPO = 'hierarchy53';
const TYPOLOGY_LOCATOR_TIPO = 'hierarchy9';
const ACTIVE_IN_THESAURUS_TIPO = 'hierarchy125';
const ORDER_TIPO = 'hierarchy48';
const ACTIVE_FILTER_TIPO = 'hierarchy4';
const ROOT_TERM_TIPO = 'hierarchy45';
const ROOT_TERM_MODEL_TIPO = 'hierarchy59';
const TYPOLOGY_LABEL_TIPO = 'hierarchy16';
const TYPOLOGY_ORDER_TIPO = 'hierarchy106';

interface HierarchyItem {
	/** Canonical INT address (WC-2026-08-10-section-id-int-canonical). */
	section_id: number;
	section_tipo: string;
	target_section_tipo: string;
	target_section_name: string | null;
	children_tipo: string;
	/**
	 * The typology record's address in canonical form (int for a real typology
	 * record; anything non-convertible passes verbatim). MUST stay type-equal
	 * to TypologyItem.section_id below — the client groups the hierarchies
	 * under their typology by comparing the two.
	 */
	typology_section_id: unknown;
	order: number;
	type: 'hierarchy';
	active_in_thesaurus: boolean;
	root_terms: Record<string, unknown>[];
}

interface TypologyItem {
	/** Canonical — see HierarchyItem.typology_section_id (identical values). */
	section_id: unknown;
	type: 'typology';
	label: string | null;
	order: number;
}

const childrenTipoCache = createOntologyCache<string, string | null>();

/** Flush the resolver's ontology-derived children_tipo cache (ontology import). */
export function clearChildrenTipoCache(): void {
	childrenTipoCache.clear();
}
registerOntologyCacheClearer(clearChildrenTipoCache);

/**
 * The target section's component_relation_children tipo (recursive, virtual).
 * Delegates to the canonical T3 accessor (audit S2-19) — which also adopts
 * the standard section-containment guard this walk used to lack; the
 * children component lives in the walked section's own subtree, so pruning
 * nested section/area nodes cannot lose it.
 */
async function getRelationChildrenTipo(sectionTipo: string): Promise<string | null> {
	const cached = childrenTipoCache.get(sectionTipo);
	if (cached !== undefined) return cached;
	const found = await findFirstDescendantTipoByModel(sectionTipo, 'component_relation_children');
	childrenTipoCache.set(sectionTipo, found);
	return found;
}

function langSliceValue(
	items: { lang?: string; value?: unknown }[] | null | undefined,
	lang: string,
): string | null {
	if (!Array.isArray(items) || items.length === 0) return null;
	const slice = items.filter((item) => item?.lang === lang);
	const chosen = slice.length > 0 ? slice : [items[0]];
	const parts = chosen
		.map((item) => (typeof item?.value === 'string' ? item.value : ''))
		.filter((part) => part !== '');
	return parts.length > 0 ? parts.join(' | ') : null;
}

/**
 * The area boot data item {tipo, value, typologies} (see module doc).
 *
 * `targetSections` is the PICKER narrowing (engineering/AREA_SPEC.md §5): when a read
 * declares its caller, only the hierarchies whose target IS one of that
 * caller's declared targets are projected — the PHP twin of
 * class.area_thesaurus.php:242's `hierarchy_sections` filter, except the list
 * is derived server-side from the caller instead of accepted from the client.
 * `null` (the default) is the ordinary browse: no narrowing, byte-identical to
 * the pre-picker projection. No ordering claim is made against the ACL loop in
 * read.ts — a pure filter cannot re-admit, so neither position changes the
 * result.
 *
 * `hierarchyTypeIds` is the TYPOLOGY narrowing declared by the area's ddo
 * (`properties.hierarchy_types` on a tool_config ddo_map entry, read by
 * read.ts) — the PHP twin of class.area_thesaurus.php:237's
 * `hierarchy_types` filter, and the same rule: a hierarchy is kept only when
 * its OWN typology (hierarchy9) is one of the declared ids. Compared on the
 * registry row itself, never through the hierarchy's target section: two
 * hierarchies may resolve to the same real section through a virtual one, and
 * a target comparison would then re-admit the other typology. `null` means no
 * typology is declared: every active hierarchy is projected. A NON-null list
 * (even one whose ids match nothing) keeps only the declared typologies, so the
 * others are never loaded and never reach the payload. Applied in addition to
 * `targetSections`; both must admit a hierarchy. Thesaurus-only: an ontology
 * row's typology is pinned (ONTOLOGY_TYPOLOGY_ID), so read.ts never passes one
 * for area_ontology.
 */
export async function readAreaHierarchyData(
	model: 'area_thesaurus' | 'area_ontology',
	areaTipo: string,
	lang: string,
	termsAreModel = false,
	targetSections: readonly string[] | null = null,
	hierarchyTypeIds: readonly number[] | null = null,
): Promise<Record<string, unknown>> {
	const isOntology = model === 'area_ontology';
	const mainSection = isOntology ? ONTOLOGY_MAIN_SECTION : THESAURUS_MAIN_SECTION;
	const table = (await getMatrixTableFromTipo(mainSection)) ?? 'matrix_hierarchy_main';

	// terms_are_model (PHP hierarchy::get_root_terms $is_model): the model view reads
	// the General-Term-MODEL portal (hierarchy59 → <tld>2 records) instead of the
	// regular General-Term portal (hierarchy45 → <tld>1). The default path
	// (termsAreModel=false) stays byte-equal to the pre-existing parity gate.
	const rootTermTipo = termsAreModel ? ROOT_TERM_MODEL_TIPO : ROOT_TERM_TIPO;
	// The dd64/1 active flag is probed in BOTH typed section_id forms
	// (WC-2026-08-10-section-id-int-canonical): jsonb `@>` is type-strict and
	// the stored locator is string-form until the int sweep, int-form after —
	// a single-form literal would empty the whole thesaurus/ontology tree on
	// the other side of the migration.
	const queryParams: string[] = [mainSection];
	const activeClause = composeContains(
		`relation->'${ACTIVE_FILTER_TIPO}'`,
		[locatorJsonVariants({ section_id: 1, section_tipo: 'dd64' }).map((json) => `[${json}]`)],
		(payload) => {
			queryParams.push(payload);
			return `$${queryParams.length}`;
		},
	);
	const rows = (await sql.unsafe(
		`SELECT section_id,
		        string->'${NAME_TIPO}' AS name_items,
		        COALESCE(string->'${TARGET_TIPO}', data->'${TARGET_TIPO}') AS target_items,
		        relation->'${TYPOLOGY_LOCATOR_TIPO}' AS typology_locators,
		        relation->'${ACTIVE_IN_THESAURUS_TIPO}' AS active_locators,
		        relation->'${rootTermTipo}' AS root_term_locators,
		        COALESCE(number->'${ORDER_TIPO}', data->'${ORDER_TIPO}') AS order_items
		 FROM "${table}"
		 WHERE section_tipo = $1
		   AND ${activeClause}
		 ORDER BY section_id ASC`,
		queryParams,
	)) as {
		section_id: number;
		name_items: { lang?: string; value?: unknown }[] | null;
		target_items: { lang?: string; value?: unknown }[] | null;
		typology_locators: { section_id?: unknown; section_tipo?: unknown }[] | null;
		active_locators: { section_id?: unknown }[] | null;
		root_term_locators: Record<string, unknown>[] | null;
		order_items: { value?: unknown }[] | null;
	}[];

	const value: HierarchyItem[] = [];
	const typologyOrder: string[] = [];
	const typologySources = new Map<string, string>(); // id → typology section tipo
	for (const row of rows) {
		const target =
			langSliceValue(row.target_items, 'lg-nolan') ?? langSliceValue(row.target_items, lang);
		if (target === null || target === '') continue;
		// Picker narrowing: BOTH sides resolve through getSectionRealTipo, so a
		// virtual target (rsc170) and the real section a hierarchy points at
		// (rsc2) name the same thing. The comparison law itself is
		// relations/picker_constraint.ts — imported, never re-written here, so
		// the tree the picker renders and the locators the write path accepts
		// cannot disagree. An EMPTY target list is a caller that declares no
		// target at all: no constraint, hence no narrowing (the same declared
		// exemption the write chokepoint carries).
		if (targetSections !== null && !(await isTargetAllowed(targetSections, target))) continue;
		const typologyId = admittedTypologyId(row.typology_locators, hierarchyTypeIds);
		if (typologyId === null) continue;
		const activeInThesaurus = String(row.active_locators?.[0]?.section_id ?? '') === '1';
		if (!isOntology && !activeInThesaurus) continue;
		const rootTerms = rootTermLocators(row.root_term_locators);
		if (!isOntology && rootTerms.length === 0) continue;
		const childrenTipo = isOntology
			? ONTOLOGY_CHILDREN_TIPO
			: await getRelationChildrenTipo(target);
		if (childrenTipo === null || childrenTipo === '') continue;

		value.push({
			// The DB column's own int, emitted uncast: the client sites that
			// consumed this were made type-tolerant in the same WC.
			section_id: row.section_id,
			section_tipo: mainSection,
			target_section_tipo: target,
			target_section_name: langSliceValue(row.name_items, lang),
			children_tipo: childrenTipo,
			typology_section_id: canonicalizeStoredSectionId(
				isOntology ? ONTOLOGY_TYPOLOGY_ID : String(typologyId),
			),
			order: Number(row.order_items?.[0]?.value ?? 0),
			type: 'hierarchy',
			active_in_thesaurus: activeInThesaurus,
			root_terms: rootTerms,
		});
		const effectiveTypologyId = isOntology ? ONTOLOGY_TYPOLOGY_ID : String(typologyId);
		if (!typologyOrder.includes(effectiveTypologyId)) {
			typologyOrder.push(effectiveTypologyId);
			typologySources.set(
				effectiveTypologyId,
				String(row.typology_locators?.[0]?.section_tipo ?? TYPOLOGY_SECTION_FALLBACK),
			);
		}
	}

	const typologies = await readTypologies(typologyOrder, typologySources, lang);

	return { tipo: areaTipo, value, typologies };
}

/**
 * The hierarchy's own typology id, or null when it has none or the typology
 * narrowing (ddo properties.hierarchy_types; see readAreaHierarchyData's doc)
 * does not admit it. Checked BEFORE the row is projected, so a hierarchy of
 * another typology is never loaded further (no children_tipo lookup, no
 * typology read). The stored locator's section_id is string- or int-form
 * (WC-2026-08-10-section-id-int-canonical): compared as a number, the loose
 * `in_array` PHP used.
 */
function admittedTypologyId(
	locators: { section_id?: unknown }[] | null,
	hierarchyTypeIds: readonly number[] | null,
): unknown {
	const typologyId = locators?.[0]?.section_id;
	if (typologyId === undefined || typologyId === null || typologyId === '') return null;
	if (hierarchyTypeIds !== null && !hierarchyTypeIds.includes(Number(typologyId))) return null;
	return typologyId;
}

/** The root-term locators that name a record (section_tipo + section_id). */
function rootTermLocators(locators: Record<string, unknown>[] | null): Record<string, unknown>[] {
	return (locators ?? []).filter(
		(term) =>
			typeof term === 'object' &&
			term !== null &&
			term.section_tipo !== undefined &&
			term.section_id !== undefined,
	);
}

/**
 * Typologies (deduplicated, first-seen order — the caller's `typologyOrder`):
 * label hierarchy16 + order hierarchy106 from each typology record.
 */
async function readTypologies(
	typologyOrder: readonly string[],
	typologySources: ReadonlyMap<string, string>,
	lang: string,
): Promise<TypologyItem[]> {
	const typologies: TypologyItem[] = [];
	for (const typologyId of typologyOrder) {
		const typologySection = typologySources.get(typologyId) ?? TYPOLOGY_SECTION_FALLBACK;
		const typologyTable = (await getMatrixTableFromTipo(typologySection)) ?? 'matrix_dd';
		const typologyRows = (await sql.unsafe(
			`SELECT string->'${TYPOLOGY_LABEL_TIPO}' AS label_items, number->'${TYPOLOGY_ORDER_TIPO}' AS order_items
			 FROM "${typologyTable}" WHERE section_tipo = $1 AND section_id = $2`,
			[typologySection, Number(typologyId)],
		)) as {
			label_items: { lang?: string; value?: unknown }[] | null;
			order_items: { value?: unknown }[] | null;
		}[];
		typologies.push({
			// The SAME canonicalization as the hierarchy item's typology_section_id
			// — the two are compared on the client and must not diverge in type.
			section_id: canonicalizeStoredSectionId(typologyId),
			type: 'typology',
			label: langSliceValue(typologyRows[0]?.label_items, lang),
			order: Number(typologyRows[0]?.order_items?.[0]?.value ?? 0),
		});
	}
	return typologies;
}
