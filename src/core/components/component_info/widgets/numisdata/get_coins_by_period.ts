/**
 * get_coins_by_period widget (PHP core/widgets/numisdata/get_coins_by_period).
 *
 * Grouped coin count per chronological period. The thesaurus target_sections
 * load whole; roots come from the hierarchy1 registry records pointing at
 * them; terms flatten depth-first with parent locator stamps; each qualifying
 * coin routes its period locator to the matching term. EVERY locator match
 * (coin period → term, tree child → row, parent stamp → term) is the locator
 * law — compareLocators on section_tipo (strict) + section_id (loose: int 187
 * == "187"), so INT-canonical locators (WC-2026-08-10) and surviving legacy
 * string ones both match; the "duplicated" flag is isFlagSet. use_parent rolls
 * counts up to the ancestor whose model — the FIRST hierarchy27 locator, v6
 * semantics (resolveModelSectionId) — is the target section_id. PHP's strict
 * === over string rows and frozen v7's is_object() model check (never true
 * for the array relation bag) made the widget route everything to '?':
 * WC-2026-11-12-numisdata-widgets-locator-law.
 *
 * PHP array_filter KEY-PRESERVATION quirk: the emitted 'period' value is a
 * JSON OBJECT keyed by original index when the surviving terms are not a
 * 0-based contiguous prefix, an ARRAY otherwise. Replicated verbatim.
 *
 * Pure seams (extracted 2026-08-08, gate test/unit/coins_by_period_widget_native.test.ts):
 * routeCoinsToPeriods / buildPeriodValue / expandHierarchyChildren /
 * findParentWithModel. The two recursive ones carry CYCLE GUARDS — the only
 * behaviour change; read each function header before touching them, above all
 * why expandHierarchyChildren's guard is PATH-scoped and must never become a
 * traversal-global de-duplicator.
 */

import { compareLocators, type Locator } from '../../../../concepts/locator.ts';
import { sql } from '../../../../db/postgres.ts';
import { getMatrixTableFromTipo } from '../../../../ontology/resolver.ts';
import {
	findTyped,
	type InfoWidgetDescriptor,
	isFlagSet,
	readWidgetComponentData,
	type TypedInput,
	type WidgetContext,
	type WidgetItem,
} from '../widget_common.ts';

export interface HierarchyEntry {
	section_id: unknown;
	section_tipo: unknown;
	parent: { section_tipo?: unknown; section_id?: unknown } | null;
	label: string | null;
	count: number | null;
	model_section_id: unknown;
}

const HIERARCHY_SECTION = 'hierarchy1';
const HIERARCHY_TARGET_SECTION = 'hierarchy53';
const HIERARCHY_CHILDREN = 'hierarchy45';
const TS_CHILDREN = 'hierarchy49';
const TS_MODEL = 'hierarchy27';

async function computeGetCoinsByPeriod(
	ipo: unknown[],
	context: WidgetContext,
): Promise<WidgetItem[]> {
	const data: WidgetItem[] = [];
	for (const [key, entry] of ipo.entries()) {
		const block = entry as { input?: unknown[]; output?: { id?: string }[] };
		const input = Array.isArray(block.input) ? block.input : [];
		const output = Array.isArray(block.output) ? block.output : [];

		const source = findTyped(input, 'source');
		const period = findTyped(input, 'period') as
			| (TypedInput & {
					target_sections?: string[];
					// KEPT UNION: ontology-authored widget config (properties.widgets[].ipo),
					// where the shipped bytes are strings; compared numerically only.
					target_model_section_id?: number | string;
					use_parent?: boolean;
			  })
			| undefined;
		const duplicated = findTyped(input, 'duplicated');
		if (duplicated === undefined || source === undefined || period === undefined) continue;
		const targetSections = period.target_sections ?? [];
		const targetModelSectionId = period.target_model_section_id ?? 0;
		const useParent = period.use_parent === true;

		// thesaurus rows (all records of every target section)
		const tsRows: {
			section_id: unknown;
			section_tipo: string;
			relation: Record<string, unknown[]> | null;
			parent?: { section_tipo?: unknown; section_id?: unknown } | null;
		}[] = [];
		for (const tsSection of targetSections) {
			const table = await getMatrixTableFromTipo(tsSection);
			if (table === null) continue;
			// section_id is the INT record address (emitted as such, WC-2026-08-10);
			// the matching below is the locator law, so string locators still match.
			const rows = (await sql.unsafe(
				`SELECT section_id, section_tipo, relation FROM "${table}" WHERE section_tipo = $1 ORDER BY section_id`,
				[tsSection],
			)) as {
				section_id: unknown;
				section_tipo: string;
				relation: Record<string, unknown[]> | null;
			}[];
			tsRows.push(...rows);
		}

		// hierarchy roots: registry records whose hierarchy53 references a target section
		const orderedHierarchy: typeof tsRows = [];
		for (const tsSection of targetSections) {
			const roots = (await sql.unsafe(
				`SELECT relation->$2 AS children FROM matrix_hierarchy_main
				 WHERE section_tipo = $1
				   AND COALESCE(data->$3, string->$3)->0->>'value' = $4`,
				[HIERARCHY_SECTION, HIERARCHY_CHILDREN, HIERARCHY_TARGET_SECTION, tsSection],
			)) as { children: { section_tipo?: unknown; section_id?: unknown }[] | null }[];
			for (const root of roots) {
				for (const locator of root.children ?? []) {
					expandHierarchyChildren(tsRows, locator, null, orderedHierarchy);
				}
			}
		}

		// project to hierarchy entries with label + model
		const { buildDdInfoChain } = await import('../../../../resolve/dd_info.ts');
		void buildDdInfoChain; // (term resolution below is section_map-free: thesaurus term slice)
		const arHierarchies: HierarchyEntry[] = [];
		for (const section of orderedHierarchy) {
			arHierarchies.push({
				section_id: section.section_id,
				section_tipo: section.section_tipo,
				parent: section.parent ?? null,
				label: await resolveThesaurusTerm(section.section_tipo, section.section_id, context.lang),
				count: null,
				model_section_id: resolveModelSectionId(section.relation, targetModelSectionId),
			});
		}

		// source portal → coin id list → bulk rows
		if (source.component_tipo === undefined) continue;
		const portalData = (await readWidgetComponentData(
			source.section_tipo ?? context.sectionTipo,
			context.sectionId,
			source.component_tipo,
		)) as { section_id?: unknown }[];
		if (portalData.length === 0) return [];

		const targetComponentSectionId = findTyped(input, 'target_component_section_id');
		const coinSection = targetComponentSectionId?.section_tipo ?? '';
		const coinTable = (await getMatrixTableFromTipo(coinSection)) ?? 'matrix';
		const idList = portalData
			.map((item) => Number(item.section_id))
			.filter((id) => Number.isFinite(id));
		const coinRows = (await sql.unsafe(
			`SELECT section_id, relation FROM "${coinTable}"
			 WHERE section_tipo = $1 AND section_id = ANY($2::int[])
			 ORDER BY section_id`,
			[coinSection, `{${idList.join(',')}}`],
		)) as { section_id: unknown; relation: Record<string, unknown[]> | null }[];

		// route each coin (counts are stamped onto arHierarchies in place)
		const emptyPeriodCount = routeCoinsToPeriods(
			arHierarchies,
			coinRows,
			period.component_tipo ?? '',
			duplicated.component_tipo ?? '',
			useParent,
			targetModelSectionId,
		);

		const computed: Record<string, unknown> = {
			period: buildPeriodValue(arHierarchies, emptyPeriodCount),
		};
		for (const dataMap of output) {
			const id = dataMap.id ?? '';
			data.push({
				widget: 'get_coins_by_period',
				key,
				widget_id: id,
				value: computed[id] ?? null,
			});
		}
	}
	return data;
}

/** A thesaurus row as loaded from the target sections (pre-projection). */
export interface ThesaurusRow {
	section_id: unknown;
	section_tipo: string;
	relation: Record<string, unknown[]> | null;
	parent?: { section_tipo?: unknown; section_id?: unknown } | null;
}

/** A coin row: its relation bag is where the period + duplicated locators live. */
export interface CoinRow {
	section_id: unknown;
	relation: Record<string, unknown[]> | null;
}

/** Locator-law match on the address pair (section_tipo strict, section_id loose). */
function sameAddress(
	a: { section_tipo?: unknown; section_id?: unknown },
	b: { section_tipo?: unknown; section_id?: unknown },
): boolean {
	return compareLocators(a as Locator, b as Locator, ['section_tipo', 'section_id']);
}

/**
 * The use_parent MODEL of a thesaurus term: the section_id of its FIRST
 * hierarchy27 locator (v6 get_coins_by_period: array_find over the relations
 * by from_component_tipo hierarchy27 → that locator). The v7 relation bag
 * stores hierarchy27 as an ARRAY; frozen PHP v7 checked is_object() on it and
 * so never found a model — a regression, not a contract. A legacy non-array
 * object is still read. No model → target + 1, a value that can never match
 * (the PHP sentinel), so the term is skipped by the roll-up walk.
 */
export function resolveModelSectionId(
	relation: Record<string, unknown> | null | undefined,
	targetModelSectionId: number | string,
): unknown {
	const model = relation?.[TS_MODEL];
	const first: unknown = Array.isArray(model) ? model[0] : model;
	if (first !== null && typeof first === 'object' && 'section_id' in first) {
		return (first as { section_id?: unknown }).section_id;
	}
	return Number(targetModelSectionId) + 1;
}

/** Path key for the cycle guards — the row's OWN fields, so a locator whose
 * section_id is typed differently than the row never aliases another node. */
function pathKey(sectionTipo: unknown, sectionId: unknown): string {
	return `${String(sectionTipo)}/${String(sectionId)}`;
}

/**
 * Route every coin's period locators onto `arHierarchies`, stamping `count`
 * IN PLACE, and return the '?' catch-all total (null when nothing fell
 * through — the sentinel is only emitted when this is non-null).
 *
 * Catch-all feeders: a coin with no period locators at all, a locator with no
 * matching term (locator law), and — under use_parent — a term with no
 * matching-model ancestor. A coin whose "duplicated" flag is set is skipped
 * entirely (it feeds nothing).
 */
export function routeCoinsToPeriods(
	arHierarchies: HierarchyEntry[],
	coinRows: CoinRow[],
	periodTipo: string,
	duplicatedTipo: string,
	useParent: boolean,
	targetModelSectionId: number | string,
): number | null {
	let emptyPeriodCount: number | null = null;
	for (const row of coinRows) {
		if (isFlagSet(row.relation?.[duplicatedTipo] ?? [])) continue;

		const periodData = (row.relation?.[periodTipo] ?? []) as {
			section_tipo?: unknown;
			section_id?: unknown;
		}[];
		if (periodData.length === 0) {
			emptyPeriodCount = (emptyPeriodCount ?? 0) + 1;
			continue;
		}
		for (const currentPeriod of periodData) {
			const tsTerm = arHierarchies.find((el) => sameAddress(el, currentPeriod));
			if (tsTerm === undefined) {
				emptyPeriodCount = (emptyPeriodCount ?? 0) + 1;
				continue;
			}
			if (useParent) {
				const areaTerm = findParentWithModel(arHierarchies, tsTerm, targetModelSectionId);
				if (areaTerm === null) {
					emptyPeriodCount = (emptyPeriodCount ?? 0) + 1;
				} else {
					areaTerm.count = (areaTerm.count ?? 0) + 1;
				}
			} else {
				tsTerm.count = (tsTerm.count ?? 0) + 1;
			}
		}
	}
	return emptyPeriodCount;
}

/**
 * The emitted `period` value: the counted terms plus the '?' sentinel.
 *
 * PHP array_filter KEY PRESERVATION: the surviving terms keep their ORIGINAL
 * index. When those indices are a 0-based contiguous prefix the value is a
 * JSON ARRAY; otherwise it is an OBJECT keyed by the original index, and the
 * sentinel takes MAX(index)+1 (NOT surviving.length). Rewriting this as a
 * plain `.filter()` flips the wire shape — it is a contract, not a style.
 */
export function buildPeriodValue(
	arHierarchies: HierarchyEntry[],
	emptyPeriodCount: number | null,
): unknown {
	const surviving: [number, HierarchyEntry][] = [];
	arHierarchies.forEach((el, index) => {
		if (el.count !== null) surviving.push([index, el]);
	});
	const sentinel =
		emptyPeriodCount !== null
			? {
					section_id: null,
					section_tipo: null,
					parent: null,
					label: '?',
					count: emptyPeriodCount,
				}
			: null;
	const contiguous = surviving.every(([index], position) => index === position);
	if (contiguous) {
		return sentinel ? [...surviving.map(([, el]) => el), sentinel] : surviving.map(([, el]) => el);
	}
	const asObject: Record<string, unknown> = {};
	for (const [index, el] of surviving) asObject[String(index)] = el;
	if (sentinel) {
		const nextKey = surviving.length > 0 ? Math.max(...surviving.map(([i]) => i)) + 1 : 0;
		asObject[String(nextKey)] = sentinel;
	}
	return asObject;
}

/**
 * Depth-first flatten of one locator's subtree, stamping direct parents.
 *
 * CYCLE GUARD (behaviour change, 2026-08-08): `seen` is PATH-SCOPED — a key is
 * added before descending and DELETED on the way back up. It stops a term that
 * is its own ancestor (a curator-made loop in hierarchy49) from recursing
 * forever; it deliberately does NOT de-duplicate. A term reachable from two
 * roots, or from two disjoint branches, is LEGITIMATELY expanded twice, and a
 * traversal-global Set would silently drop those real periods.
 */
export function expandHierarchyChildren(
	tsRows: ThesaurusRow[],
	locator: { section_tipo?: unknown; section_id?: unknown },
	parent: { section_tipo?: unknown; section_id?: unknown } | null,
	out: ThesaurusRow[],
	seen: Set<string> = new Set<string>(),
): void {
	const row = tsRows.find((el) => sameAddress(el, locator));
	if (row === undefined) return;
	const key = pathKey(row.section_tipo, row.section_id);
	if (seen.has(key)) return; // already on THIS path → the edge closes a cycle
	row.parent = parent;
	out.push(row);
	const children = (row.relation?.[TS_CHILDREN] ?? []) as {
		section_tipo?: unknown;
		section_id?: unknown;
	}[];
	seen.add(key);
	for (const child of children) {
		expandHierarchyChildren(tsRows, child, locator, out, seen);
	}
	seen.delete(key);
}

/**
 * Ancestor whose model_section_id matches (int-cast compare), else null.
 *
 * CYCLE GUARD (behaviour change, 2026-08-08): `seen` is call-scoped — this is
 * a single upward WALK, so a term met twice can only mean a parent loop and
 * revisiting it can never find a new answer. Returning null is safe by
 * construction: under use_parent a null routes that coin to the '?' catch-all,
 * exactly like a term with no matching-model ancestor.
 */
export function findParentWithModel(
	arHierarchies: HierarchyEntry[],
	term: HierarchyEntry,
	targetModelSectionId: number | string,
	seen: Set<string> = new Set<string>(),
): HierarchyEntry | null {
	// a model id (vocabulary record), not a locator: plain numeric identity
	const termModel = Number(term.model_section_id);
	if (termModel === Number(targetModelSectionId)) return term;
	const key = pathKey(term.section_tipo, term.section_id);
	if (seen.has(key)) return null; // parent loop → no ancestor answer exists
	seen.add(key);
	const parent = term.parent;
	if (parent === null || parent === undefined) return null;
	const parentTerm = arHierarchies.find((el) => sameAddress(el, parent));
	if (parentTerm === undefined) return null;
	return findParentWithModel(arHierarchies, parentTerm, targetModelSectionId, seen);
}

/** Thesaurus term label (PHP ts_object::get_term_by_locator): section_map term slice. */
async function resolveThesaurusTerm(
	sectionTipo: unknown,
	sectionId: unknown,
	lang: string,
): Promise<string | null> {
	const table = await getMatrixTableFromTipo(String(sectionTipo));
	if (table === null) return null;
	// Canonical (virtual-aware, cached) section_map accessor — S2-27: a raw
	// `WHERE parent = tipo` query returns nothing for a VIRTUAL thesaurus
	// section, silently falling back to hierarchy25 (wrong/empty term).
	const { getSectionMap } = await import('../../../../ontology/section_map.ts');
	const sectionMap = (await getSectionMap(String(sectionTipo))) as {
		thesaurus?: { term?: string | string[] };
	} | null;
	const declared = sectionMap?.thesaurus?.term;
	const termComponents =
		declared === undefined || declared === null
			? ['hierarchy25']
			: Array.isArray(declared)
				? declared
				: [declared];
	const rows = (await sql.unsafe(
		`SELECT string, data FROM "${table}" WHERE section_tipo = $1 AND section_id = $2`,
		[String(sectionTipo), Number(sectionId)],
	)) as { string: Record<string, unknown[]> | null; data: Record<string, unknown[]> | null }[];
	const record = rows[0];
	if (record === undefined) return null;
	for (const component of termComponents) {
		const items = (record.string?.[component] ?? record.data?.[component] ?? []) as {
			lang?: string;
			value?: string;
		}[];
		const match = items.find((item) => item.lang === lang) ?? items[0];
		if (match?.value !== undefined && match.value !== '') return match.value;
	}
	return null;
}

export const get_coins_by_period: InfoWidgetDescriptor = {
	name: 'get_coins_by_period',
	path: '/numisdata/get_coins_by_period',
	computeData: computeGetCoinsByPeriod,
};
