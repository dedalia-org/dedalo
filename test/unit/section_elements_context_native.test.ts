/**
 * get_section_elements_context — the edit-mode search-filter panel's element
 * list (the "CAMPOS" tree). TS-NATIVE twin of the retired differential
 * `test/parity/section_elements_context_differential.test.ts`.
 *
 * WHY IT REPLACED THE DIFFERENTIAL. That gate diffed the TS builder against a
 * frozen PHP harvest taken on ONE install: its whole corpus was that install's
 * sections. On any other database they do not exist, so the gate was red by
 * construction — it proved the contract only where the harvest was taken. The
 * CONTRACT is the asset; the PHP half is a fossil. This twin re-expresses the
 * same invariants as assertions over situations it BUILDS (AGENTS.md,
 * 2026-08-19), plus the generic `test` TLD for the shapes it already carries.
 *
 * THE CONTRACT, 1:1 with the differential's four assertions:
 *  1. ORDERED MEMBERSHIP — section entry first, then its elements in pre-order
 *     DFS ontology order (a grouper immediately BEFORE the components it
 *     contains: the client nests each component under the PRECEDING grouper, so
 *     a groups-then-components order silently EMPTIES the groups), then the
 *     common section_info group dd196 + its children. dd196 is appended only
 *     when the section has own elements, and never for a SUPPRESS_SECTION_INFO
 *     section (WC-045). A `section_group_div` is recursed THROUGH but never
 *     emitted. A VIRTUAL section borrows the REAL section's elements MINUS the
 *     tipos named by its FIRST exclude_elements child (dropping a grouper drops
 *     its subtree); a plain parent-walk yields nothing. The default component
 *     exclusion list is REPLACED (not merged) by a client-sent list — but
 *     component_password is hard-skipped whatever the list says.
 *  2. CLIENT-NESTING FIELDS — type ('grouper' for section_group models /
 *     'component' / 'section'), parent (= the requested section), and
 *     parent_grouper (= the ONTOLOGY parent, so a div-wrapped component still
 *     names the div).
 *  3. target_section_tipo IS ALWAYS AN ARRAY — the client drills in via
 *     target_section_tipo[0]; a SCALAR string makes [0] a single character →
 *     bogus 1-char section → empty list. Values: component_filter → ['dd153'];
 *     portal/dataframe → getElementTargetSectionTipos in SEARCH mode (a
 *     section_list child would swap the config in LIST mode), deduped WITHIN
 *     each request_config but CONCATENATED across configs (a 2-config element
 *     repeats its shared targets), {source:'self'} and the bare string 'self'
 *     → the owner section, targets in a row-less (inactive) TLD dropped by the
 *     active-TLD gate, targets whose ontology model cannot resolve pruned.
 *  4. SEARCH-MODE TOOLTIP — every COMPONENT is built in mode 'search' (the
 *     section and groupers stay 'list'), which is what stamps
 *     search_operators_info + search_options_title; without them the client
 *     renders no .hidden_tooltip under a selected search component. Both are
 *     PER-MODEL and byte-pinned here (the differential's byte-diff against
 *     PHP): the operator map is the model's ordered {operator → label-key}
 *     object, `[]` for the models PHP gives no operators, and the title is the
 *     rendered HTML of exactly those pairs.
 *
 * SITUATIONS IT BUILDS (tld `zzsec`, dropped in afterAll with residue asserted):
 *  - zzsec3  REAL section on matrix_test (relations → test24)
 *      zzsec4  section_group
 *        zzsec5  section_group_div   ← recursed through, never emitted
 *          zzsec6 / zzsec7  component_input_text
 *      zzsec8  section_group
 *        zzsec9  component_number
 *      zzsec14 section_group
 *        zzsec10 portal, TWO request_configs both targeting zzsec3 + test3
 *        zzsec11 portal, sqo section_tipo [{source:'self'}]
 *        zzsec12 portal, value ['zzabsent1','zzsec3'] (row-less TLD dropped)
 *        zzsec15 portal, value ['zzsec999','zzsec3'] (unresolvable model pruned)
 *        zzsec13 component_filter
 *      zzsec25 section_group
 *        zzsec16 portal whose SEARCH config targets zzsec3 while its
 *                section_list child zzsec21 targets test3 (mode proof)
 *        zzsec23 portal, value ['zzsecq1','zzsec3'] — zzsecq1 is a REAL node
 *                (its model resolves, so check_tipo_is_valid keeps it) whose
 *                tipo-derived TLD `zzsecq` owns no dd_ontology row: ONLY the
 *                active-TLD gate can drop it
 *        zzsec24 portal, sqo section_tipo ['self'] (bare string form)
 *        zzsec22 component_date
 *        zzsec17 component_image    (default-excluded; []-operator model)
 *        zzsec18 component_password (hard-skipped even with an empty exclude)
 *  - zzsec1  VIRTUAL section (relations[0] → zzsec3) with TWO exclude_elements
 *      children: zzsec2 (first, excludes grouper zzsec8 + component zzsec6) and
 *      zzsec20 (second, excludes zzsec7 — must be IGNORED, only [0] counts).
 *  - zzsec30 REAL section with NO elements → no dd196.
 *  - zzsec33 REAL section (T1-27): zzsec34 group → zzsec35 input_text (live
 *      control) + zzsec36 security_areas, zzsec37 score, zzsec38 semantic_node
 *      (child zzsec39 input_text), zzsec40 stats — all unimplemented, never emitted.
 * Reused generic structure: test3 (DFS grouper nesting, the default component
 * exclusions, filter → ['dd153'], portal → ['test3'], dataframe → []). NOTHING
 * here reads a record or a registry row the situation did not create: the only
 * ambient structure is core `dd` ontology (dd196's children, dd153, dd542).
 *
 * @twin-of      test/parity/section_elements_context_differential.test.ts
 * @twin-status  retired
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getComponentModel } from '../../src/core/components/registry.ts';
import { logSectionSuppressesSectionInfo } from '../../src/core/concepts/section.ts';
import {
	deleteDdOntologyNode,
	readDdOntologyRow,
	upsertDdOntologyNode,
} from '../../src/core/db/dd_ontology.ts';
import { getLabels } from '../../src/core/labels/catalog.ts';
import {
	getChildrenNodes,
	isUnimplementedComponentModel,
} from '../../src/core/ontology/resolver.ts';
import { buildImplicitSectionEditConfig } from '../../src/core/relations/request_config/implicit.ts';
import { currentApplicationLang } from '../../src/core/resolve/request_lang.ts';
import { buildSectionElementsContext } from '../../src/core/resolve/section_elements_context.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

interface ElementEntry {
	tipo?: string;
	model?: string;
	mode?: unknown;
	type?: unknown;
	parent?: unknown;
	parent_grouper?: unknown;
	section_tipo?: unknown;
	target_section_tipo?: unknown;
	search_operators_info?: unknown;
	search_options_title?: unknown;
}

/** One request_config item: an sqo target list + the ddo maps a portal needs. */
function portalConfig(sectionTipo: unknown[]): Record<string, unknown> {
	return {
		sqo: { section_tipo: sectionTipo },
		show: { ddo_map: [{ tipo: 'zzsec7', parent: 'self', section_tipo: 'self' }] },
		search: { ddo_map: [{ tipo: 'zzsec7', parent: 'self', section_tipo: 'self' }] },
	};
}

function portalProperties(configs: Record<string, unknown>[]): Record<string, unknown> {
	return { source: { request_config: configs } };
}

const S = situation({
	name: 'section elements context',
	tld: 'zzsec',
	nodes: [
		// --- the VIRTUAL section + its two exclude_elements children -------------
		{
			tipo: 'zzsec1',
			parent: 'test1',
			model: 'section',
			order_number: 90,
			term: { 'lg-eng': 'Virtual section' },
			relations: [{ tipo: 'zzsec3' }],
		},
		{
			tipo: 'zzsec2',
			parent: 'zzsec1',
			model: 'exclude_elements',
			order_number: 1,
			// A GROUPER (whole subtree goes) + a single component.
			relations: [{ tipo: 'zzsec8' }, { tipo: 'zzsec6' }],
		},
		{
			tipo: 'zzsec20',
			parent: 'zzsec1',
			model: 'exclude_elements',
			order_number: 2,
			// Second child — PHP/TS read only [0], so zzsec7 must SURVIVE.
			relations: [{ tipo: 'zzsec7' }],
		},
		// --- the REAL section -----------------------------------------------------
		{
			tipo: 'zzsec3',
			parent: 'test1',
			model: 'section',
			order_number: 91,
			term: { 'lg-eng': 'Real section' },
			relations: [{ tipo: 'test24' }],
		},
		{ tipo: 'zzsec4', parent: 'zzsec3', model: 'section_group', order_number: 1 },
		{ tipo: 'zzsec5', parent: 'zzsec4', model: 'section_group_div', order_number: 1 },
		{
			tipo: 'zzsec6',
			parent: 'zzsec5',
			model: 'component_input_text',
			order_number: 1,
			is_translatable: true,
		},
		{ tipo: 'zzsec7', parent: 'zzsec5', model: 'component_input_text', order_number: 2 },
		{ tipo: 'zzsec8', parent: 'zzsec3', model: 'section_group', order_number: 2 },
		{ tipo: 'zzsec9', parent: 'zzsec8', model: 'component_number', order_number: 1 },
		{ tipo: 'zzsec14', parent: 'zzsec3', model: 'section_group', order_number: 3 },
		{
			tipo: 'zzsec10',
			parent: 'zzsec14',
			model: 'component_portal',
			order_number: 1,
			relations: [{ tipo: 'zzsec3' }],
			// TWO configs; the first repeats zzsec3 (deduped WITHIN the config).
			properties: portalProperties([
				portalConfig([{ value: ['zzsec3', 'test3', 'zzsec3'], source: 'section' }]),
				portalConfig([{ value: ['zzsec3', 'test3'], source: 'section' }]),
			]),
		},
		{
			tipo: 'zzsec11',
			parent: 'zzsec14',
			model: 'component_portal',
			order_number: 2,
			properties: portalProperties([portalConfig([{ source: 'self' }])]),
		},
		{
			tipo: 'zzsec12',
			parent: 'zzsec14',
			model: 'component_portal',
			order_number: 3,
			// zzabsent1: its TLD has no dd_ontology rows → dropped by the active-TLD gate.
			properties: portalProperties([
				portalConfig([{ value: ['zzabsent1', 'zzsec3'], source: 'section' }]),
			]),
		},
		{
			tipo: 'zzsec15',
			parent: 'zzsec14',
			model: 'component_portal',
			order_number: 4,
			// zzsec999: the TLD IS active but no such node → pruned by check_tipo_is_valid.
			properties: portalProperties([
				portalConfig([{ value: ['zzsec999', 'zzsec3'], source: 'section' }]),
			]),
		},
		{ tipo: 'zzsec13', parent: 'zzsec14', model: 'component_filter', order_number: 5 },
		{ tipo: 'zzsec25', parent: 'zzsec3', model: 'section_group', order_number: 4 },
		{
			tipo: 'zzsec16',
			parent: 'zzsec25',
			model: 'component_portal',
			order_number: 1,
			// Its OWN config (the SEARCH-mode source) targets zzsec3; its
			// section_list child below targets test3 — LIST mode would swap them.
			properties: portalProperties([portalConfig([{ value: ['zzsec3'], source: 'section' }])]),
		},
		{
			tipo: 'zzsec21',
			parent: 'zzsec16',
			model: 'section_list',
			order_number: 1,
			properties: portalProperties([portalConfig([{ value: ['test3'], source: 'section' }])]),
		},
		{
			tipo: 'zzsec23',
			parent: 'zzsec25',
			model: 'component_portal',
			order_number: 2,
			// zzsecq1 EXISTS (so its model resolves and check_tipo_is_valid keeps
			// it) but its tipo-derived TLD `zzsecq` owns no row → active-TLD gate.
			properties: portalProperties([
				portalConfig([{ value: ['zzsecq1', 'zzsec3'], source: 'section' }]),
			]),
		},
		{
			tipo: 'zzsec24',
			parent: 'zzsec25',
			model: 'component_portal',
			order_number: 3,
			// BARE-STRING 'self' (the other spelling of the self source).
			properties: portalProperties([portalConfig(['self'])]),
		},
		{ tipo: 'zzsec22', parent: 'zzsec25', model: 'component_date', order_number: 4 },
		{ tipo: 'zzsec17', parent: 'zzsec25', model: 'component_image', order_number: 5 },
		{ tipo: 'zzsec18', parent: 'zzsec25', model: 'component_password', order_number: 6 },
		// --- a REAL section holding UNIMPLEMENTED component models (T1-27) -------
		{
			tipo: 'zzsec33',
			parent: 'test1',
			model: 'section',
			order_number: 94,
			term: { 'lg-eng': 'Unimplemented models section' },
			relations: [{ tipo: 'test24' }],
		},
		{ tipo: 'zzsec34', parent: 'zzsec33', model: 'section_group', order_number: 1 },
		{ tipo: 'zzsec35', parent: 'zzsec34', model: 'component_input_text', order_number: 1 },
		// v5-era dead models (PHP $ar_temp_exclude_models) — no descriptor, no client module.
		{ tipo: 'zzsec36', parent: 'zzsec34', model: 'component_security_areas', order_number: 2 },
		{ tipo: 'zzsec37', parent: 'zzsec34', model: 'component_score', order_number: 3 },
		// Models the hand list MISSED: semantic_node (its subtree too) and stats.
		{ tipo: 'zzsec38', parent: 'zzsec34', model: 'component_semantic_node', order_number: 4 },
		{ tipo: 'zzsec39', parent: 'zzsec38', model: 'component_input_text', order_number: 1 },
		{ tipo: 'zzsec40', parent: 'zzsec34', model: 'component_stats', order_number: 5 },
		// --- a REAL section with NO elements (dd196 must NOT be appended) ---------
		{
			tipo: 'zzsec30',
			parent: 'test1',
			model: 'section',
			order_number: 92,
			term: { 'lg-eng': 'Elementless section' },
			relations: [{ tipo: 'test24' }],
		},
	],
});

/** The zz elements of zzsec3 in the exact order the client must receive. */
const REAL_SEQUENCE = [
	'zzsec3', // the section entry itself, first
	'zzsec4', // grouper BEFORE the components it contains
	'zzsec6', // (through the section_group_div zzsec5, which is never emitted)
	'zzsec7',
	'zzsec8',
	'zzsec9',
	'zzsec14',
	'zzsec10',
	'zzsec11',
	'zzsec12',
	'zzsec15',
	'zzsec13',
	'zzsec25',
	'zzsec16',
	'zzsec23',
	'zzsec24',
	'zzsec22',
	// zzsec17 (image) and zzsec18 (password) are excluded by default.
];

/** Same list as seen through the VIRTUAL section: minus zzsec6 and the zzsec8 subtree. */
const VIRTUAL_SEQUENCE = [
	'zzsec1',
	'zzsec4',
	'zzsec7',
	'zzsec14',
	'zzsec10',
	'zzsec11',
	'zzsec12',
	'zzsec15',
	'zzsec13',
	'zzsec25',
	'zzsec16',
	'zzsec23',
	'zzsec24',
	'zzsec22',
];

const SECTION_INFO_GROUP = 'dd196';

/**
 * The common section_info tail, in ontology order: the dd196 group and the
 * component children the default exclusion list keeps (dd1596 is a
 * component_inverse, so it is excluded). Core `dd` ontology — identical on
 * every install, which is why the differential could compare it verbatim and
 * why the twin pins its IDENTITY and ORDER, not just its presence.
 */
const INFO_SEQUENCE = [
	SECTION_INFO_GROUP,
	'dd200',
	'dd199',
	'dd197',
	'dd201',
	'dd271',
	'dd1223',
	'dd1224',
	'dd1225',
];

/** component_filter's fixed target: the projects section. */
const PROJECTS_SECTION = 'dd153';

// ---------------------------------------------------------------------------
// The operator tooltip, re-expressed INDEPENDENTLY of the engine module.
// These are the PHP search traits' sets (order matters — the client renders the
// tooltip rows in map order). Written out here so the twin pins the VALUES the
// differential byte-compared, and so a per-model stamp that ignores the model
// (every component handed the same map) goes red on the first foreign model.
// ---------------------------------------------------------------------------
const STRING_OPERATORS: [string, string][] = [
	['!*', 'empty'],
	['*', 'no_empty'],
	['==', 'exactly'],
	['=', 'similar_to'],
	['!=', 'different_from'],
	['-', 'does_not_contain'],
	['!!', 'duplicated'],
	['text*', 'begins_with'],
	['*text', 'end_with'],
	["'text'", 'literal'],
];
const DATE_OPERATORS: [string, string][] = [
	['!*', 'empty'],
	['*', 'no_empty'],
	['>=', 'greater_than_or_equal'],
	['<=', 'less_than_or_equal'],
	['>', 'greater_than'],
	['<', 'less_than'],
];
const NUMBER_OPERATORS: [string, string][] = [
	['*', 'no_empty'],
	['!*', 'empty'],
	['...', 'between'],
	['>=', 'greater_than_or_equal'],
	['<=', 'less_than_or_equal'],
	['>', 'greater_than'],
	['<', 'less_than'],
];
const RELATION_OPERATORS: [string, string][] = [
	['!*', 'empty'],
	['*', 'no_empty'],
	['!=', 'different_from'],
	['!==', 'strict_different_from'],
];
const RELATION_INDEX_OPERATORS: [string, string][] = [
	['*', 'no_empty'],
	['!*', 'empty'],
];

/** model → its ordered operator pairs; `[]` = the models PHP gives no operators. */
const OPERATORS_BY_MODEL: Record<string, [string, string][]> = {
	component_input_text: STRING_OPERATORS,
	component_text_area: STRING_OPERATORS,
	component_email: STRING_OPERATORS,
	component_date: DATE_OPERATORS,
	component_number: NUMBER_OPERATORS,
	component_portal: RELATION_OPERATORS,
	component_select: RELATION_OPERATORS,
	component_check_box: RELATION_OPERATORS,
	component_radio_button: RELATION_OPERATORS,
	component_publication: RELATION_OPERATORS,
	component_filter: RELATION_OPERATORS,
	component_dataframe: RELATION_OPERATORS,
	component_relation_parent: RELATION_OPERATORS,
	component_relation_related: RELATION_OPERATORS,
	component_relation_index: RELATION_INDEX_OPERATORS,
	component_relation_children: [],
	component_image: [],
	component_av: [],
	component_pdf: [],
	component_3d: [],
	component_svg: [],
	component_info: [],
	component_inverse: [],
	component_geolocation: [],
	component_security_access: [],
	component_external: [],
};

/** The wire value: an ORDERED {operator → label-key} object, or `[]` when none. */
function expectedOperatorsWire(pairs: [string, string][]): Record<string, string> | never[] {
	if (pairs.length === 0) return [];
	const wire: Record<string, string> = {};
	for (const [operator, labelKey] of pairs) wire[operator] = labelKey;
	return wire;
}

/**
 * The rendered tooltip HTML (PHP search::search_options_title): a bold header
 * plus one row per operator, label keys resolved through the SERVED catalog and
 * an unresolved key decorated with <mark> (PHP decorate_untranslated).
 */
function expectedTitle(pairs: [string, string][], labels: Record<string, string>): string {
	if (pairs.length === 0) return '';
	const label = (key: string): string => labels[key] ?? `<mark>${key}</mark>`;
	let html = `<b>${label('search_options')}:</b>`;
	for (const [operator, labelKey] of pairs) {
		html += `<div class="search_options_title_item"><span>${operator}</span><span>${label(
			labelKey,
		)}</span></div>`;
	}
	return html;
}

// Aggregate non-vacuity floors — the differential had both, for the same reason:
// a gate that asserted nothing about targets/tooltips would be silently green
// while the bugs it guards shipped.
let targetsChecked = 0;
let nonEmptyTargetsChecked = 0;
let tooltipsChecked = 0;
/** Distinct component MODELS whose operator map was byte-compared. */
const modelsPinned = new Set<string>();

async function elementsOf(
	sectionTipo: string,
	componentsExclude?: string[],
): Promise<ElementEntry[]> {
	const principal = await resolvePrincipal(-1);
	return (await buildSectionElementsContext(principal, {
		ar_section_tipo: [sectionTipo],
		...(componentsExclude === undefined ? {} : { ar_components_exclude: componentsExclude }),
	})) as ElementEntry[];
}

const tiposOf = (entries: ElementEntry[]): (string | undefined)[] => entries.map((e) => e.tipo);

function byTipo(entries: ElementEntry[]): Map<string | undefined, ElementEntry> {
	return new Map(entries.map((entry) => [entry.tipo, entry]));
}

/**
 * A REAL node whose tipo spells `zzsecq` while no row carries the tld `zzsecq` —
 * the ONLY way to obtain a target that check_tipo_is_valid accepts and
 * check_active_tld must refuse. Never emitted (not a child). Written OUTSIDE the
 * situation with a NULL tld: the situation forces its own tld (`zzsec`) onto
 * every node, which the `dd_ontology_tipo_in_tld` grammar refuses for this tipo
 * (SURF-1); a tld-less row is the legacy shape this gate needs (the active-TLD
 * set ignores NULL). Deleted by tipo in afterAll.
 */
const INACTIVE_TLD_NODE = 'zzsecq1';

beforeAll(async () => {
	await ensureSituation(S);
	await assertTestDatabase('section_elements_context_native');
	await upsertDdOntologyNode({
		tipo: INACTIVE_TLD_NODE,
		parent: 'test1',
		model: 'section',
		tld: null,
		order_number: 93,
		term: { 'lg-eng': 'Inactive-TLD section' },
		relations: [{ tipo: 'test24' }],
	});
});

afterAll(async () => {
	// Non-vacuity floors first: if they fail, the situation still gets dropped.
	expect(targetsChecked).toBeGreaterThan(0);
	expect(nonEmptyTargetsChecked).toBeGreaterThan(0);
	expect(tooltipsChecked).toBeGreaterThan(0);
	// Every operator set the situation can reach, compared model by model.
	expect(modelsPinned.size).toBeGreaterThanOrEqual(12);
	expect(deadAbsencesChecked).toBeGreaterThan(0);
	await deleteDdOntologyNode(INACTIVE_TLD_NODE);
	expect(await readDdOntologyRow(INACTIVE_TLD_NODE)).toBeNull();
	expect(await dropSituation(S)).toBe(0);
});

describe('ordered membership — pre-order DFS, div recursed-through, dd196 appended', () => {
	test('real section: the WHOLE ordered list, section_info tail included', async () => {
		const entries = await elementsOf('zzsec3');
		// Ordered sequence identity — membership AND order, own elements first and
		// the common section_info group appended after them (never interleaved).
		expect(tiposOf(entries)).toEqual([...REAL_SEQUENCE, ...INFO_SEQUENCE]);
		// A section_group_div is layout-only: recursed THROUGH, never emitted.
		expect(tiposOf(entries)).not.toContain('zzsec5');
	});

	test('real section: each grouper immediately precedes the components it holds', async () => {
		const tipos = tiposOf(await elementsOf('zzsec3'));
		// The client nests on the PRECEDING grouper entry, so these orderings are
		// the grouping itself, not cosmetics.
		expect(tipos.indexOf('zzsec4')).toBeLessThan(tipos.indexOf('zzsec6'));
		expect(tipos.indexOf('zzsec6')).toBeLessThan(tipos.indexOf('zzsec8'));
		expect(tipos.indexOf('zzsec8')).toBeLessThan(tipos.indexOf('zzsec9'));
		expect(tipos.indexOf('zzsec9')).toBeLessThan(tipos.indexOf('zzsec14'));
		expect(tipos.indexOf('zzsec13')).toBeLessThan(tipos.indexOf('zzsec25'));
	});

	test('section_info tail: the group is a grouper, its children components under it', async () => {
		const entries = await elementsOf('zzsec3');
		const info = entries.slice(REAL_SEQUENCE.length);
		expect(info[0]?.type).toBe('grouper');
		for (const child of info.slice(1)) {
			expect(String(child.model).startsWith('component_')).toBe(true);
			expect(child.parent_grouper).toBe(SECTION_INFO_GROUP);
		}
	});

	test('a section with NO own elements gets NO section_info group', async () => {
		const entries = await elementsOf('zzsec30');
		expect(tiposOf(entries)).toEqual(['zzsec30']);
	});

	test('a SUPPRESS_SECTION_INFO section omits dd196 although it HAS elements', async () => {
		// WC-045: an append-only log has no editorial metadata to search on. The
		// suppressed set is a policy in concepts/section.ts, read here rather than
		// re-spelled, and dd542 (Activity) is core `dd` ontology, not an install TLD.
		expect(logSectionSuppressesSectionInfo('dd542')).toBe(true);
		const entries = await elementsOf('dd542');
		expect(entries.length).toBeGreaterThan(1); // it does have own elements
		expect(tiposOf(entries)).not.toContain(SECTION_INFO_GROUP);
	});

	test('generic test3: components never precede the first grouper', async () => {
		const entries = await elementsOf('test3');
		expect(entries[0]?.tipo).toBe('test3');
		const firstGrouper = entries.findIndex((entry) => entry.type === 'grouper');
		const firstComponent = entries.findIndex((entry) => entry.type === 'component');
		expect(firstGrouper).toBeGreaterThan(0);
		expect(firstGrouper).toBeLessThan(firstComponent);
		expect(tiposOf(entries).slice(-INFO_SEQUENCE.length)).toEqual(INFO_SEQUENCE);
	});
});

describe('component exclusion — the default list, its replacement, the hard skip', () => {
	test('the default component exclusions are applied (media/password/info/inverse)', async () => {
		// PHP ar_components_exclude default: the models the search panel cannot
		// filter on. test3 carries one node of each, so their ABSENCE is the proof.
		const tipos = tiposOf(await elementsOf('test3'));
		for (const excluded of [
			'test99', // component_image
			'test94', // component_av
			'test85', // component_pdf
			'test26', // component_3d
			'test100', // component_geolocation
			'test212', // component_info
			'test68', // component_inverse
			'test157', // component_security_access
			'test152', // component_password
		]) {
			expect(tipos).not.toContain(excluded);
		}
		// Same law on the situation: image and password are both gone by default.
		const own = tiposOf(await elementsOf('zzsec3'));
		expect(own).not.toContain('zzsec17');
		expect(own).not.toContain('zzsec18');
	});

	test('an EMPTY sent list replaces the default — except component_password', async () => {
		// tool_update_cache sends `ar_components_exclude: []` to get every
		// component. The sent list REPLACES the default (media components come
		// back) but component_password is hard-skipped regardless.
		const tipos = tiposOf(await elementsOf('zzsec3', []));
		expect(tipos).toContain('zzsec17'); // component_image, default-excluded
		expect(tipos).not.toContain('zzsec18'); // component_password, hard-skipped
		// dd196's component_inverse child returns too — same replacement law.
		expect(tipos).toContain('dd1596');
		const generic = tiposOf(await elementsOf('test3', []));
		expect(generic).toContain('test99'); // component_image
		expect(generic).not.toContain('test152'); // component_password
	});
});

describe('virtual section — real elements minus the FIRST exclude_elements', () => {
	test('borrows the real section elements, minus the excluded subtree', async () => {
		const entries = await elementsOf('zzsec1');
		const tipos = tiposOf(entries);
		// Whole ordered list, section_info tail included (as for a real section).
		expect(tipos).toEqual([...VIRTUAL_SEQUENCE, ...INFO_SEQUENCE]);
		// Excluding a GROUPER drops its whole subtree (zzsec8 → zzsec9).
		expect(tipos).not.toContain('zzsec8');
		expect(tipos).not.toContain('zzsec9');
		// Excluding a single component drops only it.
		expect(tipos).not.toContain('zzsec6');
		// Only the FIRST exclude_elements child counts: zzsec20 names zzsec7, which
		// is nevertheless served.
		expect(tipos).toContain('zzsec7');
	});

	test('a plain parent-walk would yield nothing: its own children are excludes', async () => {
		const own = (await getChildrenNodes('zzsec1')).map((child) => child.tipo);
		expect(own).toEqual(['zzsec2', 'zzsec20']);
		const tipos = tiposOf(await elementsOf('zzsec1'));
		for (const child of own) expect(tipos).not.toContain(child);
	});

	test('nesting fields: parent = the VIRTUAL section, parent_grouper = ontology parent', async () => {
		const entries = await elementsOf('zzsec1');
		for (const entry of entries) {
			expect(entry.parent).toBe('zzsec1');
			expect(entry.section_tipo).toBe('zzsec1');
		}
		const map = byTipo(entries);
		// The real ontology parents survive the borrow (the div still names itself).
		expect(map.get('zzsec4')?.parent_grouper).toBe('zzsec3');
		expect(map.get('zzsec7')?.parent_grouper).toBe('zzsec5');
		expect(map.get('zzsec10')?.parent_grouper).toBe('zzsec14');
	});
});

/**
 * T1-27 (O07): an UNIMPLEMENTED component model — one with no registered
 * descriptor (the component registry IS the live model set; client modules ≡
 * descriptors) — never reaches the client: neither the search panel nor the
 * implicit edit form. Its subtree goes with it (PHP get_ar_recursive_children
 * drops the semantic_node subtree). ONE predicate drives both sites
 * (isUnimplementedComponentModel) — WC-2026-11-12-unimplemented-component-models.
 */
const UNIMPLEMENTED_TIPOS = ['zzsec36', 'zzsec37', 'zzsec38', 'zzsec39', 'zzsec40'];
let deadAbsencesChecked = 0;

describe('unimplemented component models — never emitted (T1-27)', () => {
	test('search panel: dead / unregistered models and their subtree are absent', async () => {
		expect(tiposOf(await elementsOf('zzsec33'))).toEqual([
			'zzsec33',
			'zzsec34',
			'zzsec35',
			...INFO_SEQUENCE,
		]);
		// tool_update_cache shape (empty exclude list): same absence.
		const all = tiposOf(await elementsOf('zzsec33', []));
		for (const tipo of UNIMPLEMENTED_TIPOS) {
			expect(all).not.toContain(tipo);
			deadAbsencesChecked += 1;
		}
		expect(all).toContain('zzsec35');
	});

	test('core profiles section dd234: no dd249 (component_security_areas)', async () => {
		const tipos = tiposOf(await elementsOf('dd234'));
		expect(tipos.length).toBeGreaterThan(1);
		expect(tipos).not.toContain('dd249');
	});

	test('outcome law: every emitted component model has a registered descriptor', async () => {
		let modelsSeen = 0;
		for (const sectionTipo of ['zzsec3', 'zzsec33', 'test3', 'dd234']) {
			for (const entry of await elementsOf(sectionTipo, [])) {
				const model = String(entry.model);
				if (!model.startsWith('component_')) continue;
				modelsSeen += 1;
				expect([entry.tipo, getComponentModel(model) !== undefined]).toEqual([entry.tipo, true]);
			}
		}
		expect(modelsSeen).toBeGreaterThan(0);
	});

	test('implicit edit form: the SAME predicate drops them (one law, two sites)', async () => {
		const config = await buildImplicitSectionEditConfig({
			ownerTipo: 'zzsec33',
			ownerSectionTipo: 'zzsec33',
			mode: 'edit',
			ownerIsSection: true,
		});
		const tipos = config.flatMap((item) => item.show?.ddo_map ?? []).map((ddo) => ddo.tipo);
		expect(tipos).toContain('zzsec35');
		for (const tipo of UNIMPLEMENTED_TIPOS) {
			expect(tipos).not.toContain(tipo);
			deadAbsencesChecked += 1;
		}
	});

	test('the predicate: unregistered component_* only; aliases + non-components live', () => {
		expect(isUnimplementedComponentModel('component_score')).toBe(true);
		expect(isUnimplementedComponentModel('component_semantic_node')).toBe(true);
		expect(isUnimplementedComponentModel('component_stats')).toBe(true);
		expect(isUnimplementedComponentModel('component_input_text')).toBe(false);
		// a registry ALIAS is live (getModelByTipo resolves it to its target)
		expect(isUnimplementedComponentModel('component_input_text_large')).toBe(false);
		expect(isUnimplementedComponentModel('section_group')).toBe(false);
	});
});

describe('client-nesting fields — type / parent / parent_grouper', () => {
	test('type is section / grouper / component per model', async () => {
		const map = byTipo(await elementsOf('zzsec3'));
		expect(map.get('zzsec3')?.type).toBe('section');
		for (const grouper of ['zzsec4', 'zzsec8', 'zzsec14', 'zzsec25', SECTION_INFO_GROUP]) {
			expect(map.get(grouper)?.type).toBe('grouper');
		}
		for (const component of ['zzsec6', 'zzsec7', 'zzsec9', 'zzsec10', 'zzsec13', 'zzsec22']) {
			expect(map.get(component)?.type).toBe('component');
		}
	});

	test('parent is the requested section; parent_grouper is the ontology parent', async () => {
		const entries = await elementsOf('zzsec3');
		for (const entry of entries) expect(entry.parent).toBe('zzsec3');
		const map = byTipo(entries);
		expect(map.get('zzsec4')?.parent_grouper).toBe('zzsec3');
		// Div-wrapped components name the DIV, although it is never emitted — that
		// asymmetry is the contract (the client nests on the preceding ENTRY).
		expect(map.get('zzsec6')?.parent_grouper).toBe('zzsec5');
		expect(map.get('zzsec7')?.parent_grouper).toBe('zzsec5');
		expect(map.get('zzsec9')?.parent_grouper).toBe('zzsec8');
	});
});

describe('target_section_tipo — ALWAYS an array, resolved in search mode', () => {
	test('component_filter targets the fixed projects section, as an array', async () => {
		const map = byTipo(await elementsOf('zzsec3'));
		expect(map.get('zzsec13')?.target_section_tipo).toEqual([PROJECTS_SECTION]);
		const generic = byTipo(await elementsOf('test3'));
		expect(generic.get('test101')?.target_section_tipo).toEqual([PROJECTS_SECTION]);
	});

	test('portal: dedup WITHIN each config, CONCAT across configs', async () => {
		const map = byTipo(await elementsOf('zzsec3'));
		// zzsec10 declares two configs; the first repeats zzsec3.
		expect(map.get('zzsec10')?.target_section_tipo).toEqual(['zzsec3', 'test3', 'zzsec3', 'test3']);
	});

	test('portal: self resolves to the owner section, in both spellings', async () => {
		const real = byTipo(await elementsOf('zzsec3'));
		expect(real.get('zzsec11')?.target_section_tipo).toEqual(['zzsec3']); // {source:'self'}
		expect(real.get('zzsec24')?.target_section_tipo).toEqual(['zzsec3']); // bare 'self'
		// Through the virtual section the owner is the VIRTUAL tipo.
		const virtualEntries = byTipo(await elementsOf('zzsec1'));
		expect(virtualEntries.get('zzsec11')?.target_section_tipo).toEqual(['zzsec1']);
		expect(virtualEntries.get('zzsec24')?.target_section_tipo).toEqual(['zzsec1']);
	});

	test('targets in a row-less TLD are dropped; unresolvable models are pruned', async () => {
		const map = byTipo(await elementsOf('zzsec3'));
		// zzabsent1: no dd_ontology row carries that TLD → active-TLD gate drops it.
		expect(map.get('zzsec12')?.target_section_tipo).toEqual(['zzsec3']);
		// zzsec999: TLD active (the situation installed it) but no such node →
		// check_tipo_is_valid prunes it.
		expect(map.get('zzsec15')?.target_section_tipo).toEqual(['zzsec3']);
		// zzsecq1: the node EXISTS (check_tipo_is_valid keeps it — its model
		// resolves) but nothing carries the tld `zzsecq`, so ONLY the active-TLD
		// gate can drop it. This is the one target that isolates that gate.
		expect(map.get('zzsec23')?.target_section_tipo).toEqual(['zzsec3']);
	});

	test('targets resolve in SEARCH mode, not the list-mode section_list swap', async () => {
		// zzsec16's own (search) config targets zzsec3; its section_list child
		// zzsec21 targets test3. The panel builds components in mode 'search', so
		// the section_list substitution must NOT apply here.
		const map = byTipo(await elementsOf('zzsec3'));
		expect(map.get('zzsec16')?.target_section_tipo).toEqual(['zzsec3']);
	});

	test('generic test3: portal target and a dataframe with no sqo target', async () => {
		const map = byTipo(await elementsOf('test3'));
		expect(map.get('test80')?.target_section_tipo).toEqual(['test3']);
		// A dataframe declaring no request_config resolves to the EMPTY array —
		// still an array, never undefined or a scalar.
		expect(map.get('test60')?.target_section_tipo).toEqual([]);
	});

	test('every stamped target is an ARRAY of strings, never a scalar', async () => {
		// The shape law across every element the twin's own structure reaches:
		// the zz situations (section/self sources) and the generic playground.
		for (const sectionTipo of ['zzsec3', 'zzsec1', 'test3']) {
			for (const entry of await elementsOf(sectionTipo)) {
				const target = entry.target_section_tipo;
				if (target === undefined) continue;
				targetsChecked += 1;
				expect(Array.isArray(target)).toBe(true);
				const values = target as unknown[];
				if (values.length > 0) nonEmptyTargetsChecked += 1;
				for (const tipo of values) expect(typeof tipo).toBe('string');
			}
		}
	});
});

describe('search mode — the per-model operator tooltip every component carries', () => {
	test('components are mode search; groupers and the section stay list', async () => {
		for (const sectionTipo of ['zzsec3', 'zzsec1', 'test3']) {
			for (const entry of await elementsOf(sectionTipo)) {
				const isComponent = String(entry.model).startsWith('component_');
				expect(entry.mode).toBe(isComponent ? 'search' : 'list');
				if (!isComponent) {
					// The section and its groupers carry no search tooltip at all.
					expect('search_operators_info' in entry).toBe(false);
					expect('search_options_title' in entry).toBe(false);
				}
			}
		}
	});

	test('the stamped map and title are byte-exact for the entry OWN model', async () => {
		const labels = await getLabels(currentApplicationLang());
		// `[]` on an empty-operator model needs the component to REACH the panel,
		// so the media models come along on the empty-exclude call.
		for (const [sectionTipo, exclude] of [
			['zzsec3', undefined],
			['zzsec3', []],
			['zzsec1', undefined],
			['test3', undefined],
		] as [string, string[] | undefined][]) {
			for (const entry of await elementsOf(sectionTipo, exclude)) {
				const model = String(entry.model);
				const pairs = OPERATORS_BY_MODEL[model];
				if (!model.startsWith('component_')) continue;
				// Both keys are stamped on EVERY search-mode component.
				expect('search_operators_info' in entry).toBe(true);
				expect('search_options_title' in entry).toBe(true);
				if (pairs === undefined) continue; // model not classified in this twin
				modelsPinned.add(model);
				// The operator MAP: exact keys, exact label-key values, exact ORDER
				// (the client renders the tooltip rows in map order).
				expect(entry.search_operators_info).toEqual(expectedOperatorsWire(pairs));
				expect(Array.isArray(entry.search_operators_info)).toBe(pairs.length === 0);
				if (pairs.length > 0) {
					expect(Object.keys(entry.search_operators_info as Record<string, string>)).toEqual(
						pairs.map(([operator]) => operator),
					);
				}
				// The rendered tooltip HTML, byte for byte.
				expect(entry.search_options_title).toBe(expectedTitle(pairs, labels));
				if (pairs.length > 0) tooltipsChecked += 1;
			}
		}
	});

	test('the tooltip DIFFERENTIATES models: text vs number vs portal vs date vs []', async () => {
		// The single assertion a model-blind stamp (every component handed the same
		// map) cannot survive: four different components of ONE section, four
		// different maps, plus an empty-operator model.
		const map = byTipo(await elementsOf('zzsec3', []));
		const info = (tipo: string): unknown => map.get(tipo)?.search_operators_info;
		expect(info('zzsec7')).toEqual(expectedOperatorsWire(STRING_OPERATORS)); // input_text
		expect(info('zzsec9')).toEqual(expectedOperatorsWire(NUMBER_OPERATORS)); // number
		expect(info('zzsec22')).toEqual(expectedOperatorsWire(DATE_OPERATORS)); // date
		expect(info('zzsec10')).toEqual({
			'!*': 'empty',
			'*': 'no_empty',
			'!=': 'different_from',
			'!==': 'strict_different_from',
		}); // portal
		// component_image reaches the panel only with the empty exclude list: PHP
		// emits `[]` (a JSON array, not an object) and an empty title.
		expect(info('zzsec17')).toEqual([]);
		expect(Array.isArray(info('zzsec17'))).toBe(true);
		expect(map.get('zzsec17')?.search_options_title).toBe('');
		// The four maps are pairwise different — no two share a key list.
		const keyLists = ['zzsec7', 'zzsec9', 'zzsec22', 'zzsec10'].map((tipo) =>
			Object.keys(info(tipo) as Record<string, string>).join('|'),
		);
		expect(new Set(keyLists).size).toBe(4);
	});

	test('a text component renders the full tooltip HTML, operator by operator', async () => {
		const labels = await getLabels(currentApplicationLang());
		const map = byTipo(await elementsOf('zzsec3'));
		const title = map.get('zzsec7')?.search_options_title as string;
		expect(title).toBe(expectedTitle(STRING_OPERATORS, labels));
		// Non-vacuity: the HTML really carries the rows (a byte-equal '' would pass
		// the comparison above only if the twin's own expectation were empty).
		expect(title.length).toBeGreaterThan(0);
		expect(title).toContain('<div class="search_options_title_item"><span>\'text\'</span>');
		// …and a NUMBER-only operator never appears in a text tooltip.
		expect(title).not.toContain('<span>...</span>');
	});
});
