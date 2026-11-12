/**
 * T0-9 — the export 'value' format follows the CALLER ddo_map, the PHP
 * separator precedence, and resolves EVERY relation model (OX1).
 *
 * PHP oracle (frozen, historical reference): the value format is NOT a second
 * resolver — it is `export_value::join` (class.export_value.php join_atoms
 * :193-364) over the SAME atoms the grid_value format emits
 * (component_relation_common::get_export_value :742-1010, which takes the
 * CALLER's ddo_map when one is injected). component_relation_index
 * ::resolve_export_ddo_children builds per locator [pointing section's
 * component_section_id, ...its relation_list map] but keeps only the ddos
 * parented to the index as children — PHP exported the id ALONE; TS exports
 * the id + the relation_list columns, what the edit form shows (owner D10, a
 * DELIBERATE divergence — WC-2026-11-11-export-value-single-walker).
 * Owner decisions encoded (rewrite plan T0-9 §7):
 *   D1 value == join(grid_value atoms) — one walker (G5);
 *   D2 component_filter → children dd156 (project name); component_filter_master
 *      → its OWN ontology `relations` children (here dd1631, NOT dd156);
 *   D3 an empty relation item KEEPS its slot in the records join (PHP :356-358),
 *      with PHP empty() — '0' is empty — bug-for-bug;
 *   D4 component_relation_related's main cell = its STORED links only (PHP
 *      get_export_value → get_data()); the CALCULATED relations (PHP
 *      get_data_with_references() minus the stored, dd467/dd621) are an OPT-IN
 *      sibling column `<column>#references` (per-ddo `value_with_references`);
 *   D5 the interactive flat reader (relation_list.ts resolveCellValue) resolves
 *      the same eight models (panel / Referencias / related labels).
 *
 * join_atoms in one breath: separators come from the PARENT segment of a level
 * (depth 0: defaults ' | ' records, ', ' fields). The FIRST indexed level joins
 * its items with records_separator; every deeper indexed level joins its items
 * with the parent's FIELDS separator. Fields inside one item join with the
 * parent's fields_separator. Separator precedence per segment: caller ddo →
 * own request_config show → properties → default.
 *
 * Legs:
 *   G1 caller map — a nested ddo map injects test211 under test80; G1b multi-item
 *      literals keep one atom per item (number joins ', ', input_text ' | ');
 *   G2 ddo-level fields_separator + own rc.show records_separator; G2b the D3
 *      empty slot;
 *   G3 per model, non-empty value AND `unresolved` free of the model;
 *   G4 grid_value: filter / filter_master / relation_index / derived leaves emit atoms;
 *   G5 value == join(grid_value atoms), every case above;
 *   D5 the interactive reader resolves the eight models;
 *   G6 a scoped persona, a hidden record reached ONLY through the caller map:
 *      the value export equals the admin's (the read DISPLAYS it — T0-1 D4) and
 *      the strict media walk throws perm.export_column_out_of_scope.
 *   D4 media: value-format media is credited to the column whose cell read it
 *      (`#references` walk → the `#references` column);
 *   D6 every reader gets EVERY relation_index pointer (the edit form's set); a
 *      pointer in a section the requester may not read shows name + id only,
 *      its columns blank — the edit form's predicate at the shared seam
 *      (locator_source.ts pointingSectionReadable, config_children.ts);
 *   D7 grid_value multi-atom cells join as PHP join_cell (leaf separator), and the
 *      iri value+title glue = caller ddo → properties → ', '.
 * (G7 — the flatValue completeness rule — lives in descriptor_completeness_tripwire.)
 *
 * SITUATION (built, torn down, residue 0): scratch TLD `zzxv` (sections +
 * host components) over the generic `test` TLD's test3 playground components;
 * test3 rows at explicit ids this file owns (952300…), swept before/after;
 * the suite projects fixture (dd153/930031) for the filter legs.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import {
	deleteMatrixRecord,
	insertMatrixRecordWithExplicitId,
} from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { exportConfigChildren } from '../../src/core/relations/config_children.ts';
import { calculatedLocators, componentLocators } from '../../src/core/relations/locator_source.ts';
import { getCalculatedReferences } from '../../src/core/relations/related.ts';
import {
	clearFieldsSeparatorCache,
	resolveCellValue,
} from '../../src/core/resolve/relation_list.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { fireSaveEvent } from '../../src/core/section_record/save_event.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import {
	ensureSuiteProjectsFixture,
	removeSuiteProjectsFixture,
	SUITE_SECOND_PROJECT_ID,
} from '../../src/core/test_data/projects_fixture.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import type { ToolActionContext, ToolResponse } from '../../src/core/tools/module.ts';
import {
	collectGridAtoms,
	collectValueAtoms,
	createExportRun,
	type ExportSegment,
	type GridAtom,
	resolveValueCell,
} from '../../src/diffusion/export/atoms.ts';
import { compileExportPlan } from '../../src/diffusion/export/compile_columns.ts';
import { openExportGrid } from '../../src/diffusion/export/index.ts';
import { EXPORT_ROW_MEDIA } from '../../src/diffusion/export/row_media.ts';
import {
	toolExportComponentsWithReferences,
	toolExportGetExportGrid,
} from '../../tools/tool_export/server/tool_export.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { exportFrontierIdentity } from '../helpers/export_frontier_identity.ts';
import {
	hostColumnDisplayedValues,
	hostSectionRead,
	hostSectionReadItems,
} from '../helpers/host_section_read.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const LANG = 'lg-eng';
const PLAYGROUND = 'test3';
const TABLE = 'matrix_test';

// --- playground components (generic `test` TLD) -------------------------------
const PORTAL = 'test80'; // component_portal → test3, OWN show [test52]
const NUMBER = 'test211'; // component_number (the injected caller-map column)
const TEXT = 'test52'; // component_input_text (translatable)
const FILTER = 'test101'; // component_filter (projects)
const PUBLICATION = 'test92'; // component_publication → dd64 / dd62
const SELECT_LANG = 'test89'; // component_select_lang → lg1 / hierarchy25
const PARENT = 'test71'; // component_relation_parent (show test52)
const CHILDREN = 'test201'; // component_relation_children (derived, show test52)
const RELATED = 'test54'; // component_relation_related (dd620 unidirectional, show test52)
const INDEX = 'test25'; // component_relation_index (derived, config-less)
const SECTION_ID = 'test102'; // component_section_id

// --- scratch situation `zzxv` --------------------------------------------------
const TLD = 'zzxv';
const HOST = 'zzxv1'; // section (matrix_test)
const NEST_PORTAL = 'zzxv2'; // G1: caller map test80 → [test211, test52]
const SEP_PORTAL = 'zzxv3'; // G2: + ddo fields ' / ', own show records ' ; '
const FILTER_MASTER = 'zzxv4'; // relations [dd153, dd1631] (D2)
const BIDI = 'zzxv5'; // relation_related dd467 (bidirectional) → HOST
const BIDI_LABEL = 'zzxv6'; // its show child
const BARE = 'zzxv7'; // config-less portal whose `relations` name ONLY a section (test3)
const IRI_SEP = 'zzxv8'; // D7: component_iri, properties.fields_separator ' — '
const IRI_PLAIN = 'zzxv9'; // D7: component_iri, nothing declared (default ', ')
// media attribution: a dd467 related whose targets show a label AND an image
const RELM = 'zzxv17';
const RELM_IMAGE = 'zzxv18';
const RELM_IMAGE_PATH = '/image/1.5MB/0/zzxv_relm.jpg';
// D3 empty slots: portals into HOST showing ONE leaf (image / label)
const SLOT_MEDIA = 'zzxv50'; // → [RELM_IMAGE]
const SLOT_TEXT = 'zzxv51'; // → [BIDI_LABEL]
// D11: a caller map whose second entry has NO parent (not a child of anything)
const NO_PARENT = 'zzxv52'; // → test3, [test52 (self), test211 (parent-less)]
// cycle: a portal into HOST whose own map shows [label, ITSELF]
const CYCLE = 'zzxv53';
const DEFAULT_IMAGE_QUALITY = mediaTypeOf('component_image')?.defaultQuality as string;
const SLOT_PATH_A = `/image/${DEFAULT_IMAGE_QUALITY}/0/zzxv_slot_a.jpg`;
const SLOT_PATH_C = `/image/${DEFAULT_IMAGE_QUALITY}/0/zzxv_slot_c.jpg`;
const IRI_FRAME = 'dd560'; // the iri label dataframe (core; target dd1706, shows dd1715)
const IRI_FRAME_LABEL = 'dd1715';
// G6 chain: A6 —P6→ B6 —R6→ C6 —S6→ E6 (every section project-gated)
const A6 = 'zzxv10';
const A6_FILTER = 'zzxv11';
const P6 = 'zzxv12';
const B6 = 'zzxv20';
const B6_FILTER = 'zzxv21';
const B6_LABEL = 'zzxv22';
const R6 = 'zzxv23';
const C6 = 'zzxv30';
const C6_FILTER = 'zzxv31';
const C6_LABEL = 'zzxv32';
const S6 = 'zzxv33';
const E6 = 'zzxv40';
const E6_FILTER = 'zzxv41';
const E6_LABEL = 'zzxv42';
const E6_IMAGE = 'zzxv43';
const E6_IMAGE_PATH = '/image/1.5MB/0/zzxv_hidden.jpg';
// D4 frontier: A6 —R7 (relation_related dd467)→ A6; label A7_LABEL
const R7 = 'zzxv13';
const A7_LABEL = 'zzxv14';
// D6: a CONFIG-LESS relation_index on A6 (the hierarchy40 shape: its columns per
// pointer = the pointing section's [component_section_id, ...relation_list]),
// the components its pointers store dd96 in (A6's, B6's), and the pointing
// sections' relation_list + component_section_id nodes
const INDEX6 = 'zzxv15';
const INDEX6C = 'zzxv28'; // D9: the CONFIGURED twin (explicit map: targets A6 + B6)
const POINTER6 = 'zzxv16';
const POINTER6B = 'zzxv24';
const A6_RELATION_LIST = 'zzxv19'; // → [A7_LABEL]
const B6_RELATION_LIST = 'zzxv25'; // → [B6_LABEL]
const A6_SECTION_ID = 'zzxv26';
const B6_SECTION_ID = 'zzxv27';

const PROJECTS_SECTION = 'dd153';
const PROJECTS_ORDER = 'dd1631'; // component_number; the fixture stores 2
const YES_NO_SECTION = 'dd64'; // record 1 dd62 lg-eng = 'Yes' (install seed)
const LANGS_SECTION = 'lg1'; // record 5101 hierarchy25 lg-eng = 'English' (install seed)
const ENGLISH_ID = 5101;

const term = (value: string) => ({ [LANG]: value });
const text = (value: string) => [{ id: 1, lang: LANG, value }];
const locator = (from: string, sectionTipo: string, sectionId: number, id = 1, type = 'dd151') => ({
	id,
	type,
	section_tipo: sectionTipo,
	section_id: sectionId,
	from_component_tipo: from,
});
const explicitConfig = (
	target: string,
	ddoMap: Record<string, unknown>[],
	show: Record<string, unknown> = {},
) => ({
	source: {
		request_config: [
			{
				sqo: { section_tipo: [{ value: [target], source: 'section' }] },
				show: { ...show, ddo_map: ddoMap },
			},
		],
	},
});
const selfDdo = (tipo: string, extra: Record<string, unknown> = {}) => ({
	tipo,
	parent: 'self',
	section_tipo: 'self',
	...extra,
});
const gatedSection = (tipo: string, label: string) => ({
	tipo,
	parent: 'test1',
	model: 'section',
	term: term(label),
	relations: [{ tipo: 'test24' }],
});
const filterNode = (tipo: string, parent: string) => ({
	tipo,
	parent,
	model: 'component_filter',
	term: term(`${tipo} projects`),
});
const labelNode = (tipo: string, parent: string) => ({
	tipo,
	parent,
	model: 'component_input_text',
	term: term(`${tipo} label`),
	is_translatable: true,
});

const S = situation({
	name: 'T0-9 export value relation',
	tld: TLD,
	nodes: [
		gatedSection(HOST, 'zz t09 host'),
		{
			tipo: NEST_PORTAL,
			parent: HOST,
			model: 'component_portal',
			term: term('zz t09 nested'),
			// the nested_portal_fixture.ts shape: test80's children declared by the CALLER
			properties: explicitConfig(PLAYGROUND, [
				selfDdo(PORTAL),
				{ tipo: NUMBER, parent: PORTAL, section_tipo: PLAYGROUND },
				{ tipo: TEXT, parent: PORTAL, section_tipo: PLAYGROUND },
			]),
		},
		{
			tipo: SEP_PORTAL,
			parent: HOST,
			model: 'component_portal',
			term: term('zz t09 separators'),
			properties: explicitConfig(
				PLAYGROUND,
				[
					// ddo-level separator (the caller-ddo rung of the precedence)
					selfDdo(PORTAL, { fields_separator: ' / ' }),
					{ tipo: NUMBER, parent: PORTAL, section_tipo: PLAYGROUND },
					{ tipo: TEXT, parent: PORTAL, section_tipo: PLAYGROUND },
				],
				// own rc.show rung
				{ records_separator: ' ; ' },
			),
		},
		{
			tipo: FILTER_MASTER,
			parent: HOST,
			model: 'component_filter_master',
			term: term('zz t09 filter master'),
			// D2: its OWN relations decide the children (dd1631, deliberately NOT dd156)
			relations: [{ tipo: PROJECTS_SECTION }, { tipo: PROJECTS_ORDER }],
		},
		{
			tipo: BIDI,
			parent: HOST,
			model: 'component_relation_related',
			term: term('zz t09 related bidirectional'),
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ source: 'self' }] },
							show: { ddo_map: [selfDdo(BIDI_LABEL)] },
						},
					],
				},
				config_relation: { relation_type: 'dd89', relation_type_rel: 'dd467' },
			},
		},
		labelNode(BIDI_LABEL, HOST),
		{
			tipo: BARE,
			parent: HOST,
			model: 'component_portal',
			term: term('zz t09 bare relation'),
			// no request_config, no component in `relations`: PHP v5 edit derivation
			// (trait.request_config_v5.php resolve_ar_related_edit :267 →
			// clean_and_extract_related strips the section :526) = EMPTY ddo_map
			relations: [{ tipo: PLAYGROUND }],
		},
		{
			tipo: IRI_SEP,
			parent: HOST,
			model: 'component_iri',
			term: term('zz t09 iri declared'),
			properties: { fields_separator: ' — ' },
		},
		{ tipo: IRI_PLAIN, parent: HOST, model: 'component_iri', term: term('zz t09 iri plain') },
		{
			tipo: RELM,
			parent: HOST,
			model: 'component_relation_related',
			term: term('zz t09 related media'),
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ source: 'self' }] },
							show: { ddo_map: [selfDdo(BIDI_LABEL), selfDdo(RELM_IMAGE)] },
						},
					],
				},
				config_relation: { relation_type: 'dd89', relation_type_rel: 'dd467' },
			},
		},
		{ tipo: RELM_IMAGE, parent: HOST, model: 'component_image', term: term('zz t09 image') },
		{
			tipo: SLOT_MEDIA,
			parent: HOST,
			model: 'component_portal',
			term: term('zz t09 slot media'),
			properties: explicitConfig(HOST, [selfDdo(RELM_IMAGE)]),
		},
		{
			tipo: SLOT_TEXT,
			parent: HOST,
			model: 'component_portal',
			term: term('zz t09 slot text'),
			properties: explicitConfig(HOST, [selfDdo(BIDI_LABEL)]),
		},
		{
			tipo: NO_PARENT,
			parent: HOST,
			model: 'component_portal',
			term: term('zz t09 parent-less ddo'),
			properties: explicitConfig(PLAYGROUND, [
				selfDdo(TEXT),
				{ tipo: NUMBER, section_tipo: PLAYGROUND },
			]),
		},
		{
			tipo: CYCLE,
			parent: HOST,
			model: 'component_portal',
			term: term('zz t09 cycle'),
			properties: explicitConfig(HOST, [selfDdo(BIDI_LABEL), selfDdo(CYCLE)]),
		},
		// --- G6 chain ---
		gatedSection(A6, 'zz t09 frontier root'),
		filterNode(A6_FILTER, A6),
		{
			tipo: P6,
			parent: A6,
			model: 'component_portal',
			term: term('zz t09 frontier column'),
			// CALLER map: B6 → R6 → S6 → E6_LABEL. R6's OWN map shows C6_LABEL only,
			// so E6 is reached ONLY through the caller map.
			properties: explicitConfig(B6, [
				selfDdo(B6_LABEL),
				selfDdo(R6),
				{ tipo: S6, parent: R6, section_tipo: C6 },
				{ tipo: E6_LABEL, parent: S6, section_tipo: E6 },
				{ tipo: E6_IMAGE, parent: S6, section_tipo: E6 },
			]),
		},
		{
			tipo: R7,
			parent: A6,
			model: 'component_relation_related',
			term: term('zz t09 frontier related'),
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ source: 'self' }] },
							show: { ddo_map: [selfDdo(A7_LABEL)] },
						},
					],
				},
				config_relation: { relation_type: 'dd89', relation_type_rel: 'dd467' },
			},
		},
		labelNode(A7_LABEL, A6),
		{
			tipo: INDEX6,
			parent: A6,
			model: 'component_relation_index',
			term: term('zz t09 frontier index'),
			// config-less: every pointing section, its related_list as columns
		},
		{
			tipo: INDEX6C,
			parent: A6,
			model: 'component_relation_index',
			term: term('zz t09 frontier index configured'),
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [A6, B6], source: 'section' }] },
							show: { ddo_map: [selfDdo(A7_LABEL), selfDdo(B6_LABEL)] },
						},
					],
				},
			},
		},
		{
			tipo: A6_RELATION_LIST,
			parent: A6,
			model: 'relation_list',
			term: term('zz t09 a6 rl'),
			relations: [{ tipo: A7_LABEL }],
		},
		{ tipo: A6_SECTION_ID, parent: A6, model: 'component_section_id', term: term('zz t09 a6 id') },
		{
			tipo: POINTER6,
			parent: A6,
			model: 'component_portal',
			term: term('zz t09 frontier index pointer'),
			properties: explicitConfig(A6, [selfDdo(A7_LABEL)]),
		},
		gatedSection(B6, 'zz t09 frontier b'),
		filterNode(B6_FILTER, B6),
		labelNode(B6_LABEL, B6),
		{
			tipo: B6_RELATION_LIST,
			parent: B6,
			model: 'relation_list',
			term: term('zz t09 b6 rl'),
			relations: [{ tipo: B6_LABEL }],
		},
		{ tipo: B6_SECTION_ID, parent: B6, model: 'component_section_id', term: term('zz t09 b6 id') },
		{
			tipo: POINTER6B,
			parent: B6,
			model: 'component_portal',
			term: term('zz t09 frontier index pointer b'),
			properties: explicitConfig(A6, [selfDdo(A7_LABEL)]),
		},
		{
			tipo: R6,
			parent: B6,
			model: 'component_portal',
			term: term('zz t09 frontier r'),
			properties: explicitConfig(C6, [selfDdo(C6_LABEL)]),
		},
		gatedSection(C6, 'zz t09 frontier c'),
		filterNode(C6_FILTER, C6),
		labelNode(C6_LABEL, C6),
		{
			tipo: S6,
			parent: C6,
			model: 'component_portal',
			term: term('zz t09 frontier s'),
			properties: explicitConfig(E6, [selfDdo(E6_LABEL)]),
		},
		gatedSection(E6, 'zz t09 frontier e'),
		filterNode(E6_FILTER, E6),
		labelNode(E6_LABEL, E6),
		{ tipo: E6_IMAGE, parent: E6, model: 'component_image', term: term('zz t09 frontier image') },
	],
});

// --- test3 rows this file owns (explicit ids; isolation is the suite DB) ------
const ID = {
	b1: 952301, // test211 7, test52 'bee'
	b2: 952302, // test211 8, test52 'wasp'
	b3: 952303, // test211 9, test52 'ant'
	a1: 952311, // test80 → [b1, b2]
	a2: 952312, // test80 → [b3]
	x1: 952321, // test52 'x'
	x0: 952322, // test52 '0' (PHP empty())
	x2: 952323, // test52 'y'
	slots: 952324, // test80 → [x1, x0, x2]
	f: 952340, // filter / publication / select_lang host
	parent: 952341, // test52 'zz parent term'
	child: 952342, // test71 → parent; test52 'zz child term'
	r1: 952343, // test54 → [r2]
	r2: 952344, // test52 'zz related two'
	target: 952345, // relation_index target
	pointer: 952346, // test54 dd96 → target; test52 'zz index pointer'
	multi: 952350, // test211 [3, 4], test52 ['p', 'q'] (multi-item literals)
	multiHop: 952351, // test80 → [multi]
	iriTitle: 952352, // dd1715 'zz iri title' (the D7 iri label frame's target)
	zero: 952353, // test211 [0] (PHP empty() — a lone '0' grid cell is empty)
} as const;
const OWNED_TEST3 = Object.values(ID);

// zz HOST rows (matrix_test, section zzxv1 — swept by dropSituation too)
const HID = {
	nest: 1,
	sep: 2,
	master: 4,
	multi: 5,
	bare: 6,
	z1: 11,
	z2: 12,
	z3: 13,
	z5: 15,
	iri: 16, // D7: IRI_SEP + IRI_PLAIN, each [titled item, bare item]
	// media attribution (RELM): m1 stores → m3; m2 stores → m1 (calculated for
	// m1); m5 stores nothing; m6 stores → m5 (m5's only relation is calculated).
	// m2, m3, m6 each hold an image.
	m1: 21,
	m2: 22,
	m3: 23,
	m5: 25,
	m6: 26,
	// D3 slots: e0 → [e1, e2, e3] through SLOT_MEDIA and SLOT_TEXT; e2 holds an
	// EMPTY label item and no image
	e0: 30,
	e1: 31,
	e2: 32,
	e3: 33,
	// cycle: c1 —CYCLE→ c2 —CYCLE→ c1
	c1: 34,
	c2: 35,
	np: 36, // NO_PARENT → test3 b1
} as const;

const t3 = (
	string: Record<string, unknown> = {},
	relation: Record<string, unknown> = {},
	number: Record<string, unknown> = {},
	iri: Record<string, unknown> | null = null,
	media: Record<string, unknown> | null = null,
) => ({
	string,
	relation,
	number,
	...(iri === null ? {} : { iri }),
	...(media === null ? {} : { media }),
});

const TEST3_ROWS: Record<number, ReturnType<typeof t3>> = {
	[ID.b1]: t3({ [TEXT]: text('bee') }, {}, { [NUMBER]: [{ id: 1, value: 7 }] }),
	[ID.b2]: t3({ [TEXT]: text('wasp') }, {}, { [NUMBER]: [{ id: 1, value: 8 }] }),
	[ID.b3]: t3({ [TEXT]: text('ant') }, {}, { [NUMBER]: [{ id: 1, value: 9 }] }),
	[ID.a1]: t3(
		{},
		{ [PORTAL]: [locator(PORTAL, PLAYGROUND, ID.b1, 1), locator(PORTAL, PLAYGROUND, ID.b2, 2)] },
	),
	[ID.a2]: t3({}, { [PORTAL]: [locator(PORTAL, PLAYGROUND, ID.b3, 1)] }),
	[ID.x1]: t3({ [TEXT]: text('x') }),
	[ID.x0]: t3({ [TEXT]: text('0') }),
	[ID.x2]: t3({ [TEXT]: text('y') }),
	[ID.slots]: t3(
		{},
		{
			[PORTAL]: [
				locator(PORTAL, PLAYGROUND, ID.x1, 1),
				locator(PORTAL, PLAYGROUND, ID.x0, 2),
				locator(PORTAL, PLAYGROUND, ID.x2, 3),
			],
		},
	),
	[ID.f]: t3(
		{},
		{
			[FILTER]: [locator(FILTER, PROJECTS_SECTION, SUITE_SECOND_PROJECT_ID, 1, 'dd675')],
			[PUBLICATION]: [locator(PUBLICATION, YES_NO_SECTION, 1, 1, 'dd88')],
			[SELECT_LANG]: [locator(SELECT_LANG, LANGS_SECTION, ENGLISH_ID, 1, 'dd151')],
		},
	),
	[ID.parent]: t3({ [TEXT]: text('zz parent term') }),
	[ID.child]: t3(
		{ [TEXT]: text('zz child term') },
		{ [PARENT]: [locator(PARENT, PLAYGROUND, ID.parent, 1, 'dd47')] },
	),
	[ID.r1]: t3({}, { [RELATED]: [locator(RELATED, PLAYGROUND, ID.r2, 1, 'dd89')] }),
	[ID.r2]: t3({ [TEXT]: text('zz related two') }),
	[ID.target]: t3({ [TEXT]: text('zz index target') }),
	[ID.multi]: t3(
		{
			[TEXT]: [
				{ id: 1, lang: LANG, value: 'p' },
				{ id: 2, lang: LANG, value: 'q' },
			],
		},
		{},
		{
			[NUMBER]: [
				{ id: 1, value: 3 },
				{ id: 2, value: 4 },
			],
		},
	),
	[ID.multiHop]: t3({}, { [PORTAL]: [locator(PORTAL, PLAYGROUND, ID.multi, 1)] }),
	[ID.iriTitle]: t3({ [IRI_FRAME_LABEL]: text('zz iri title') }),
	[ID.zero]: t3({}, {}, { [NUMBER]: [{ id: 1, value: 0 }] }),
	// the relation_index_pointer_fixture.ts shape: a dd96 locator under test54
	[ID.pointer]: t3(
		{ [TEXT]: text('zz index pointer') },
		{ [RELATED]: [locator(RELATED, PLAYGROUND, ID.target, 1, 'dd96')] },
	),
};

function relmImage(): Record<string, unknown> {
	return {
		[RELM_IMAGE]: [{ id: 1, files_info: [{ quality: 'original', file_path: RELM_IMAGE_PATH }] }],
	};
}

const slotImage = (path: string) => ({
	[RELM_IMAGE]: [{ id: 1, files_info: [{ quality: DEFAULT_IMAGE_QUALITY, file_path: path }] }],
});

const IRI_ITEMS = [
	{ id: 1, iri: 'https://example.org/zzxv/one' },
	{ id: 2, iri: 'https://example.org/zzxv/two' },
];

const HOST_ROWS: Record<number, ReturnType<typeof t3>> = {
	[HID.nest]: t3({}, { [NEST_PORTAL]: [locator(NEST_PORTAL, PLAYGROUND, ID.a2)] }),
	[HID.multi]: t3({}, { [NEST_PORTAL]: [locator(NEST_PORTAL, PLAYGROUND, ID.multiHop)] }),
	// BARE stores a live locator; NEST_PORTAL on the same row proves the row reads
	[HID.bare]: t3(
		{},
		{
			[BARE]: [locator(BARE, PLAYGROUND, ID.b1)],
			[NEST_PORTAL]: [locator(NEST_PORTAL, PLAYGROUND, ID.a2)],
		},
	),
	[HID.sep]: t3(
		{},
		{
			[SEP_PORTAL]: [
				locator(SEP_PORTAL, PLAYGROUND, ID.a1, 1),
				locator(SEP_PORTAL, PLAYGROUND, ID.a2, 2),
			],
		},
	),
	[HID.master]: t3(
		{},
		{
			[FILTER_MASTER]: [
				locator(FILTER_MASTER, PROJECTS_SECTION, SUITE_SECOND_PROJECT_ID, 1, 'dd675'),
			],
		},
	),
	// D4: z1 stores → z2; z2 stores → z1 (both ways: z2 is stored AND inverse
	// for z1 — the '#references' column must subtract it); z3 stores → z1
	// (inverse-only for z1) AND → z5 (z5 stores NOTHING: its only relation is
	// calculated — the '#references' column without a main cell)
	[HID.z1]: t3(
		{ [BIDI_LABEL]: text('z one') },
		{ [BIDI]: [locator(BIDI, HOST, HID.z2, 1, 'dd89')] },
	),
	[HID.z2]: t3(
		{ [BIDI_LABEL]: text('z two') },
		{ [BIDI]: [locator(BIDI, HOST, HID.z1, 1, 'dd89')] },
	),
	[HID.z3]: t3(
		{ [BIDI_LABEL]: text('z three') },
		{
			[BIDI]: [locator(BIDI, HOST, HID.z1, 1, 'dd89'), locator(BIDI, HOST, HID.z5, 2, 'dd89')],
		},
	),
	[HID.z5]: t3({ [BIDI_LABEL]: text('z five') }),
	// D7: item 1 of each iri pairs (id_key 1) with a dd560 frame → test3 iriTitle
	[HID.iri]: t3(
		{},
		{
			[IRI_FRAME]: [IRI_SEP, IRI_PLAIN].map((main, index) => ({
				id: index + 1,
				type: 'dd490',
				id_key: 1,
				section_tipo: PLAYGROUND,
				section_id: ID.iriTitle,
				from_component_tipo: IRI_FRAME,
				main_component_tipo: main,
			})),
		},
		{},
		{ [IRI_SEP]: IRI_ITEMS, [IRI_PLAIN]: IRI_ITEMS },
	),
	[HID.m1]: t3(
		{ [BIDI_LABEL]: text('m one') },
		{ [RELM]: [locator(RELM, HOST, HID.m3, 1, 'dd89')] },
	),
	[HID.m2]: t3(
		{ [BIDI_LABEL]: text('m two') },
		{ [RELM]: [locator(RELM, HOST, HID.m1, 1, 'dd89')] },
		{},
		null,
		relmImage(),
	),
	[HID.m3]: t3({ [BIDI_LABEL]: text('m three') }, {}, {}, null, relmImage()),
	[HID.m5]: t3({ [BIDI_LABEL]: text('m five') }),
	[HID.m6]: t3(
		{ [BIDI_LABEL]: text('m six') },
		{ [RELM]: [locator(RELM, HOST, HID.m5, 1, 'dd89')] },
		{},
		null,
		relmImage(),
	),
	[HID.e0]: t3(
		{},
		{
			[SLOT_MEDIA]: [HID.e1, HID.e2, HID.e3].map((id, k) => locator(SLOT_MEDIA, HOST, id, k + 1)),
			[SLOT_TEXT]: [HID.e1, HID.e2, HID.e3].map((id, k) => locator(SLOT_TEXT, HOST, id, k + 1)),
		},
	),
	[HID.e1]: t3({ [BIDI_LABEL]: text('slot a') }, {}, {}, null, slotImage(SLOT_PATH_A)),
	[HID.e2]: t3({ [BIDI_LABEL]: text('') }),
	[HID.e3]: t3({ [BIDI_LABEL]: text('slot c') }, {}, {}, null, slotImage(SLOT_PATH_C)),
	[HID.c1]: t3({ [BIDI_LABEL]: text('c one') }, { [CYCLE]: [locator(CYCLE, HOST, HID.c2)] }),
	[HID.c2]: t3({ [BIDI_LABEL]: text('c two') }, { [CYCLE]: [locator(CYCLE, HOST, HID.c1)] }),
	[HID.np]: t3({}, { [NO_PARENT]: [locator(NO_PARENT, PLAYGROUND, ID.b1)] }),
};

async function sweepTest3(): Promise<void> {
	for (const id of OWNED_TEST3) await deleteMatrixRecord(TABLE, PLAYGROUND, id);
}

async function insertRows(
	sectionTipo: string,
	rows: Record<number, ReturnType<typeof t3>>,
): Promise<void> {
	for (const [id, columns] of Object.entries(rows)) {
		await insertMatrixRecordWithExplicitId(TABLE, sectionTipo, Number(id), {
			data: { section_tipo: sectionTipo, section_id: Number(id) },
			...columns,
		});
	}
	await fireSaveEvent(sectionTipo);
}

// --- the PHP join_atoms oracle (class.export_value.php :252-364, byte port) ---
type SeparatorSegment = ExportSegment & {
	fields_separator?: string | null;
	records_separator?: string | null;
};

/** PHP empty() on an export atom value: '', '0', null. */
const phpEmpty = (value: unknown): boolean =>
	value === null || value === undefined || value === '' || value === '0' || value === 0;

function joinAtomsOracle(
	atoms: GridAtom[],
	depth = 0,
	parent: SeparatorSegment | null = null,
	recordsLevelDone = false,
): string {
	const recordsSeparator = parent?.records_separator ?? ' | ';
	const fieldsSeparator = parent?.fields_separator ?? ', ';
	const recordGroups = new Map<number, GridAtom[]>();
	let hasIndex = false;
	for (const atom of atoms) {
		const segment = atom.segments[depth];
		const key = segment !== undefined && segment.item_index !== null ? segment.item_index : -1;
		if (key !== -1) hasIndex = true;
		const group = recordGroups.get(key) ?? [];
		group.push(atom);
		recordGroups.set(key, group);
	}
	const groupSeparator = hasIndex && recordsLevelDone ? fieldsSeparator : recordsSeparator;
	const nextDone = recordsLevelDone || hasIndex;
	const records: string[] = [];
	for (const key of [...recordGroups.keys()].sort((a, b) => a - b)) {
		const fieldGroups = new Map<string, GridAtom[]>();
		for (const atom of recordGroups.get(key) ?? []) {
			const segment = atom.segments[depth];
			const fieldKey =
				segment === undefined
					? ''
					: `${segment.section_tipo}_${segment.component_tipo}${segment.sub_id !== undefined ? `#${segment.sub_id}` : ''}`;
			const group = fieldGroups.get(fieldKey) ?? [];
			group.push(atom);
			fieldGroups.set(fieldKey, group);
		}
		const fields: string[] = [];
		for (const fieldAtoms of fieldGroups.values()) {
			const leafValues: string[] = [];
			const deeper: GridAtom[] = [];
			let leafSegment: SeparatorSegment | null = null;
			for (const atom of fieldAtoms) {
				if (atom.segments.length === depth + 1) {
					leafSegment = atom.segments[depth] as SeparatorSegment;
					leafValues.push(atom.value);
				} else deeper.push(atom);
			}
			if (leafValues.length > 0) {
				const leaf = leafValues
					.filter((value) => !phpEmpty(value))
					.join(leafSegment?.fields_separator ?? ', ');
				if (!phpEmpty(leaf)) fields.push(leaf);
			}
			if (deeper.length > 0) {
				const joined = joinAtomsOracle(
					deeper,
					depth + 1,
					deeper[0]?.segments[depth] as SeparatorSegment,
					nextDone,
				);
				if (!phpEmpty(joined)) fields.push(joined);
			}
		}
		// D3: the record keeps its slot even when empty
		records.push(fields.join(fieldsSeparator));
	}
	return records.join(groupSeparator);
}

// --- harness --------------------------------------------------------------------
let root!: Principal;

interface Cell {
	value: string | null;
	/** grid_value atoms (a single-step real portal: WC-008 COMPACT, one per reference) */
	atoms: GridAtom[];
	/** the NON-compact walk's atoms — PHP's grid atoms, what the value join reads */
	valueAtoms: GridAtom[];
	unresolved: string[];
}

/** value + grid_value atoms of ONE column on ONE record, through the real walk. */
async function exportCell(
	sectionTipo: string,
	sectionId: number,
	columnTipo: string,
): Promise<Cell> {
	clearFieldsSeparatorCache();
	return runWithRequestContext(
		{ principal: root, session: null, requestId: 't09', clientIp: '' },
		() =>
			runWithRequestLangs({ applicationLang: LANG, dataLang: LANG }, async () => {
				const plan = await compileExportPlan(
					[
						{ path: [{ section_tipo: sectionTipo, component_tipo: columnTipo, name: columnTipo }] },
					] as never,
					sectionTipo,
				);
				const field = plan.sections[0]?.fields[0];
				if (field === undefined) throw new Error(`no field compiled for ${columnTipo}`);
				const unresolved: string[] = [];
				const value = await resolveValueCell(
					createExportRun(),
					field,
					sectionTipo,
					sectionId,
					LANG,
					unresolved,
				);
				const atoms = await collectGridAtoms(
					createExportRun(),
					field,
					sectionTipo,
					sectionId,
					LANG,
					unresolved,
				);
				const valueAtoms = await collectValueAtoms(
					createExportRun(),
					field,
					sectionTipo,
					sectionId,
					LANG,
					unresolved,
				);
				return { value, atoms, valueAtoms, unresolved };
			}),
	);
}

/** The interactive flat reader (no caller, no frontier). */
async function interactiveCell(sectionTipo: string, sectionId: number, tipo: string) {
	clearFieldsSeparatorCache();
	return runWithRequestContext(
		{ principal: root, session: null, requestId: 't09-ui', clientIp: '' },
		() =>
			runWithRequestLangs({ applicationLang: LANG, dataLang: LANG }, async () => {
				const unresolved: string[] = [];
				const value = await resolveCellValue(sectionTipo, sectionId, tipo, LANG, unresolved);
				return { value, unresolved };
			}),
	);
}

/** Every case G5 re-checks: [name, section, id, column, expected value]. */
const CASES: {
	name: string;
	section: string;
	id: number;
	column: string;
	model: string;
	expected: string;
}[] = [
	// G1 — zzxv2 → a2 → test80 → b3; caller map [test211, test52] under test80;
	// depth-2 fields joined by test80's default ', ' → '9, ant'
	{
		name: 'G1 caller map',
		section: HOST,
		id: HID.nest,
		column: NEST_PORTAL,
		model: 'component_portal',
		expected: '9, ant',
	},
	// G1b — multi-item LITERALS under relation hops (PHP get_export_value: ONE
	// atom per data item; join_atoms joins a leaf's items with the LEAF segment's
	// fields_separator). component_number = component_common base (:1901-1928,
	// build_export_path_segment → null → ', '); component_input_text overrides it
	// with records_separator ?? ' | ' (component_input_text :58-74). Fields of the
	// test80 item join with test80's default ', '. (A pre-joined ' | ' literal
	// atom — the phase-3 shape — gives '3 | 4, p | q'.)
	{
		name: 'G1b multi-item literals',
		section: HOST,
		id: HID.multi,
		column: NEST_PORTAL,
		model: 'component_portal',
		expected: '3, 4, p | q',
	},
	// G2 — zzxv3 → [a1, a2]: level 1 = first indexed level → own show records ' ; ';
	// level 2 (b1,b2 under a1) is a DEEPER indexed level → parent test80's FIELDS
	// separator ' / ' (caller-ddo rung) joins both its items and their fields
	{
		name: 'G2 separators',
		section: HOST,
		id: HID.sep,
		column: SEP_PORTAL,
		model: 'component_portal',
		expected: '7 / bee / 8 / wasp ; 9 / ant',
	},
	// G2b (D3) — test80 → [x, '0', y]; '0' is PHP-empty, its record keeps the slot
	{
		name: 'G2b empty slot kept',
		section: PLAYGROUND,
		id: ID.slots,
		column: PORTAL,
		model: 'component_portal',
		expected: 'x |  | y',
	},
	// G3 — per model
	{
		name: 'filter → dd156',
		section: PLAYGROUND,
		id: ID.f,
		column: FILTER,
		model: 'component_filter',
		expected: 'zz suite second project',
	},
	// filter_master → its relations child dd1631 (fixture order 2), NOT the project name
	{
		name: 'filter_master → own relations',
		section: HOST,
		id: HID.master,
		column: FILTER_MASTER,
		model: 'component_filter_master',
		expected: '2',
	},
	{
		name: 'publication → dd62',
		section: PLAYGROUND,
		id: ID.f,
		column: PUBLICATION,
		model: 'component_publication',
		expected: 'Yes',
	},
	{
		name: 'select_lang → hierarchy25',
		section: PLAYGROUND,
		id: ID.f,
		column: SELECT_LANG,
		model: 'component_select_lang',
		expected: 'English',
	},
	{
		name: 'relation_parent',
		section: PLAYGROUND,
		id: ID.child,
		column: PARENT,
		model: 'component_relation_parent',
		expected: 'zz parent term',
	},
	{
		name: 'relation_children (derived)',
		section: PLAYGROUND,
		id: ID.parent,
		column: CHILDREN,
		model: 'component_relation_children',
		expected: 'zz child term',
	},
	{
		name: 'relation_related (stored, dd620)',
		section: PLAYGROUND,
		id: ID.r1,
		column: RELATED,
		model: 'component_relation_related',
		expected: 'zz related two',
	},
	// D4 (owner, 2026-11-11) — the main cell is the STORED link only (z2); the
	// inverse z3 is a calculated relation: the opt-in '#references' column
	{
		name: 'relation_related (stored only, dd467)',
		section: HOST,
		id: HID.z1,
		column: BIDI,
		model: 'component_relation_related',
		expected: 'z two',
	},
	// per-locator children [test102 section_id, ...test3 relation_list (test138 → test52)]
	{
		name: 'relation_index (derived)',
		section: PLAYGROUND,
		id: ID.target,
		column: INDEX,
		model: 'component_relation_index',
		expected: `${ID.pointer}, zz index pointer`,
	},
];
const caseOf = (name: string) => CASES.find((c) => c.name === name) as (typeof CASES)[number];

describe.if(DB_READY)('T0-9 export value: caller map + per-model families', () => {
	beforeAll(async () => {
		await assertTestDatabase('tool_export_value_relation_native');
		root = await resolvePrincipal(-1);
		await sweepTest3();
		await ensureSituation(S);
		await ensureSuiteProjectsFixture();
		await insertRows(PLAYGROUND, TEST3_ROWS);
		await insertRows(HOST, HOST_ROWS);
	}, 120_000);

	afterAll(async () => {
		await assertTestDatabase('tool_export_value_relation_native');
		await sweepTest3();
		await fireSaveEvent(PLAYGROUND);
		const residue = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM ${TABLE} WHERE section_tipo = $1 AND section_id = ANY($2::int[])`,
			[PLAYGROUND, OWNED_TEST3],
		)) as { n: number }[];
		expect(residue[0]?.n).toBe(0);
		await removeSuiteProjectsFixture();
		expect(await dropSituation(S)).toBe(0);
	});

	describe('G1/G2 — the value cell follows the caller map and its separators', () => {
		for (const name of [
			'G1 caller map',
			'G1b multi-item literals',
			'G2 separators',
			'G2b empty slot kept',
		]) {
			test(name, async () => {
				const c = caseOf(name);
				const cell = await exportCell(c.section, c.id, c.column);
				expect(cell.value).toBe(c.expected);
			});
		}
	});

	describe('G3 — every relation model exports a non-empty value', () => {
		for (const c of CASES.filter((x) => !x.name.startsWith('G'))) {
			test(`${c.name}: ${c.model}`, async () => {
				const cell = await exportCell(c.section, c.id, c.column);
				expect(cell.unresolved.filter((note) => note.includes(c.model))).toEqual([]);
				expect(cell.value).toBe(c.expected);
			});
		}
	});

	describe('G4 — grid_value atoms exist for the derived / implicit-children models', () => {
		// (the models the pre-T0-9 fan-out could not reach: filter → dd156,
		// relation_index per-locator columns, derived relation_children, the
		// dd467 related. filter_master is NOT here: the old model-blind
		// own-config read already followed its ontology relations — D2's shape;
		// G5 pins its value cell.)
		for (const name of [
			'filter → dd156',
			'relation_index (derived)',
			'relation_children (derived)',
			'relation_related (stored only, dd467)',
		]) {
			test(name, async () => {
				const c = caseOf(name);
				const cell = await exportCell(c.section, c.id, c.column);
				expect(cell.atoms.length).toBeGreaterThan(0);
				expect(joinAtomsOracle(cell.atoms)).toBe(c.expected);
			});
		}
	});

	describe('G5 — value == join(PHP grid atoms) (one walker)', () => {
		// The oracle (joinAtomsOracle) is a port of the SAME PHP join the
		// implementation ports, so `value == oracle(atoms)` mirrors the
		// implementation by construction: it proves the value is a fold of the
		// atoms (one walker), not that the fold is right. The INDEPENDENCE is
		// carried by the literal `c.expected` bytes asserted below (and in G1-G3).
		// The oracle joins the NON-compact walk's atoms (PHP's grid atoms). A
		// single-step stored component_portal's grid_value is WC-008 COMPACT — one
		// pre-joined atom per reference, a deliberate divergence — so joining
		// those would compare against a shape PHP never joined (G2: '7 / bee /
		// 8 / wasp ; 9 / ant' is PHP's value; the compact atoms join otherwise).
		for (const c of CASES) {
			test(c.name, async () => {
				const cell = await exportCell(c.section, c.id, c.column);
				// floors: a join over zero atoms equals a null-ish value by accident
				expect(cell.atoms.length).toBeGreaterThan(0);
				expect(cell.valueAtoms.length).toBeGreaterThan(0);
				expect(cell.value).toBe(joinAtomsOracle(cell.valueAtoms));
				// non-vacuity: two equally wrong walkers agree too
				expect(joinAtomsOracle(cell.valueAtoms)).toBe(c.expected);
			});
		}
	});

	// A config-less relation whose `relations` name no component (29 such nodes in
	// the dev ontology, all autocomplete/portal/select/related/radio). PHP export
	// instantiates the column in 'edit' (tool_export :751) → build_request_config
	// v5 → resolve_ar_related_edit = the component's own relation nodes →
	// clean_and_extract_related strips the section → EMPTY ddo_map →
	// get_export_value (relation_common :792-831) `continue`s every locator: NO
	// atoms (just a WARNING log). No section_list fallback in edit mode (that
	// rung, resolve_ar_related_list_component :441, is list/tm/search only).
	describe('bare relation — no component children ⇒ no atoms (PHP v5 edit)', () => {
		test('value null, zero grid / value atoms, the stored locator is live', async () => {
			// non-vacuity: the same row's explicit-config column exports
			expect((await exportCell(HOST, HID.bare, NEST_PORTAL)).value).toBe('9, ant');
			expect(await exportConfigChildren(BARE)).toEqual([]);
			const cell = await exportCell(HOST, HID.bare, BARE);
			expect(cell.value).toBeNull();
			expect(cell.atoms).toEqual([]);
			expect(cell.valueAtoms).toEqual([]);
		});
	});

	describe('D5 — the interactive flat reader resolves the eight models', () => {
		const EIGHT = [
			'publication → dd62',
			'filter → dd156',
			'filter_master → own relations',
			'select_lang → hierarchy25',
			'relation_parent',
			'relation_children (derived)',
			'relation_related (stored, dd620)',
			'relation_index (derived)',
		];
		for (const name of EIGHT) {
			const c = caseOf(name);
			test(`${c.model}`, async () => {
				const cell = await interactiveCell(c.section, c.id, c.column);
				expect(cell.unresolved.filter((note) => note.includes(c.model))).toEqual([]);
				// EXACT bytes: the reader has no caller map, and on these one-target
				// cases its text equals the export's (the same children seam, the
				// same ', ' fields separator) — a substring check would pass on a
				// wrong field set
				expect(cell.value).toBe(c.expected);
			});
		}
	});
});

// --- D4 — calculated relations: the opt-in `#references` sibling column ------
type Line = { t: string; i?: number; key?: string; ar_labels?: string[] } & Record<string, unknown>;

/** One full export (root) of ONE column on ONE record: col lines + row lines. */
async function exportColumn(
	dataFormat: string,
	sectionTipo: string,
	sectionId: number,
	columnTipo: string,
	extra: Record<string, unknown> = {},
	/** keys on the declared path STEP (the caller-ddo separator rung) */
	step: Record<string, unknown> = {},
): Promise<{ columns: Line[]; rows: Line[] }> {
	clearFieldsSeparatorCache();
	const response: ToolResponse = await toolExportGetExportGrid({
		principal: root,
		userId: -1,
		options: {
			section_tipo: sectionTipo,
			lang: LANG,
			data_format: dataFormat,
			breakdown: 'default',
			ar_ddo_to_export: [
				{ path: [{ section_tipo: sectionTipo, component_tipo: columnTipo, ...step }], ...extra },
			],
			sqo: {
				section_tipo: [sectionTipo],
				filter_by_locators: [{ section_tipo: sectionTipo, section_id: sectionId }],
				limit: 10,
				offset: 0,
			},
		},
		background: false,
	} as unknown as ToolActionContext);
	const result = response.data as { columns: Line[]; rows: Line[] };
	expect(Array.isArray(result?.columns)).toBe(true);
	return result;
}

/** The cell of the column keyed `key` ('' when the column exists without a cell). */
function cellByKey(result: { columns: Line[]; rows: Line[] }, key: string): string | undefined {
	const column = result.columns.find((c) => c.key === key);
	if (column === undefined) return undefined;
	const cells: string[] = [];
	for (const row of result.rows) {
		const value = (row.c as Record<string, string> | undefined)?.[String(column.i)];
		if (value !== undefined) cells.push(value);
	}
	return cells.join(' | ');
}

const referencesKeys = (columns: Line[]) =>
	columns.map((c) => String(c.key ?? '')).filter((key) => key.includes('#references'));

/** The record's own relation column (what the locator source reads). */
async function relationColumns(sectionTipo: string, sectionId: number) {
	const rows = (await sql.unsafe(
		`SELECT relation FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId],
	)) as { relation: Record<string, unknown> | null }[];
	return { relation: rows[0]?.relation ?? null };
}

const idsOf = (locators: readonly { section_id?: unknown }[]) =>
	locators.map((l) => Number(l.section_id)).sort((a, b) => a - b);

describe.if(DB_READY)('D4 — calculated relations: the opt-in `#references` column', () => {
	const ON = { value_with_references: true };
	const MAIN_VALUE = `${HOST}_${BIDI}`;
	const REF_VALUE = `${HOST}_${BIDI}#references`;
	const MAIN_GRID = `${HOST}_${BIDI}.${HOST}_${BIDI_LABEL}`;
	const REF_GRID = `${HOST}_${BIDI}.${HOST}_${BIDI}#references.${HOST}_${BIDI_LABEL}`;
	const labelOf = async (id: number) =>
		(await interactiveCell(HOST, id, BIDI_LABEL)).value as string;

	beforeAll(async () => {
		await assertTestDatabase('tool_export_value_relation_native');
		root = await resolvePrincipal(-1);
		await sweepTest3();
		await ensureSituation(S);
		await insertRows(PLAYGROUND, TEST3_ROWS);
		await insertRows(HOST, HOST_ROWS);
		// z1's calculated-only labels, DERIVED once from the situation through the
		// core seam — so every leg below is independent of test order
		const calculated = await calculatedLocators(
			{ sectionTipo: HOST, sectionId: HID.z1, columns: await relationColumns(HOST, HID.z1) },
			BIDI,
			'component_relation_related',
		);
		expectedReferences = (
			await Promise.all(calculated.map((l) => labelOf(Number(l.section_id))))
		).join(' | ');
	}, 120_000);

	afterAll(async () => {
		await assertTestDatabase('tool_export_value_relation_native');
		await sweepTest3();
		await fireSaveEvent(PLAYGROUND);
		expect(await dropSituation(S)).toBe(0);
	});

	/** z1's calculated-only set (beforeAll — the core seam, never a literal). */
	let expectedReferences = '';

	test('the core seam: calculated = the dd467 closure MINUS the stored links', async () => {
		// the RAW closure (PHP get_calculated_references) of z1 holds z2 (z2 → z1)
		// AND z3 (z3 → z1); z2 is also STORED on z1 → only z3 is calculated-only
		const closure = (await getCalculatedReferences(BIDI, HOST, HID.z1, LANG, {
			onlyData: true,
		})) as { section_id: unknown }[];
		expect(idsOf(closure)).toEqual([HID.z2, HID.z3]);
		const record = {
			sectionTipo: HOST,
			sectionId: HID.z1,
			columns: await relationColumns(HOST, HID.z1),
		};
		const stored = await componentLocators(record, BIDI, 'component_relation_related');
		expect(idsOf(stored)).toEqual([HID.z2]);
		const calculated = await calculatedLocators(record, BIDI, 'component_relation_related');
		expect(idsOf(calculated)).toEqual([HID.z3]);
		// the beforeAll derivation is the one the legs below compare against
		expect(expectedReferences).toBe('z three');
		// a unidirectional related (dd620) has no calculated relations at all
		const unidirectional = {
			sectionTipo: PLAYGROUND,
			sectionId: ID.r1,
			columns: await relationColumns(PLAYGROUND, ID.r1),
		};
		expect(await calculatedLocators(unidirectional, RELATED, 'component_relation_related')).toEqual(
			[],
		);
	});

	test('value, flag ON: main cell = stored only, `#references` = calculated only', async () => {
		const result = await exportColumn('value', HOST, HID.z1, BIDI, ON);
		expect(cellByKey(result, MAIN_VALUE)).toBe('z two');
		expect(referencesKeys(result.columns)).toEqual([REF_VALUE]);
		expect(cellByKey(result, REF_VALUE)).toBe(expectedReferences);
		const column = result.columns.find((c) => c.key === REF_VALUE) as Line;
		expect(column.ar_labels?.at(-1)).toBe('references');
		// minted after its main column
		const main = result.columns.find((c) => c.key === MAIN_VALUE) as Line;
		expect((column.i as number) > (main.i as number)).toBe(true);
	});

	test('value, flag OFF: no `#references` column, the main cell unchanged', async () => {
		const result = await exportColumn('value', HOST, HID.z1, BIDI);
		expect(cellByKey(result, MAIN_VALUE)).toBe('z two');
		expect(referencesKeys(result.columns)).toEqual([]);
	});

	test('grid_value, flag ON: a `#references` segment column = calculated only', async () => {
		const result = await exportColumn('grid_value', HOST, HID.z1, BIDI, ON);
		expect(cellByKey(result, MAIN_GRID)).toBe('z two');
		expect(referencesKeys(result.columns)).toEqual([REF_GRID]);
		expect(cellByKey(result, REF_GRID)).toBe(expectedReferences);
		const column = result.columns.find((c) => c.key === REF_GRID) as Line;
		expect(column.ar_labels).toContain('references');
	});

	test('grid_value, flag OFF: no `#references` column', async () => {
		const result = await exportColumn('grid_value', HOST, HID.z1, BIDI);
		expect(cellByKey(result, MAIN_GRID)).toBe('z two');
		expect(referencesKeys(result.columns)).toEqual([]);
	});

	test('a record that STORES nothing: no main cell, `#references` still exports', async () => {
		const record = {
			sectionTipo: HOST,
			sectionId: HID.z5,
			columns: await relationColumns(HOST, HID.z5),
		};
		expect(await componentLocators(record, BIDI, 'component_relation_related')).toEqual([]);
		expect(idsOf(await calculatedLocators(record, BIDI, 'component_relation_related'))).toEqual([
			HID.z3,
		]);
		const value = await exportColumn('value', HOST, HID.z5, BIDI, ON);
		expect(cellByKey(value, MAIN_VALUE)).toBe('');
		expect(cellByKey(value, REF_VALUE)).toBe(await labelOf(HID.z3));
		const grid = await exportColumn('grid_value', HOST, HID.z5, BIDI, ON);
		expect(cellByKey(grid, REF_GRID)).toBe(await labelOf(HID.z3));
	});

	test('dedalo_raw ignores the flag (byte-identical to flag off)', async () => {
		const on = await exportColumn('dedalo_raw', HOST, HID.z1, BIDI, ON);
		const off = await exportColumn('dedalo_raw', HOST, HID.z1, BIDI);
		// non-vacuity: two EMPTY exports are byte-identical too
		expect(on.columns.length).toBeGreaterThan(0);
		expect(on.rows.length).toBeGreaterThan(0);
		expect(JSON.stringify(on.rows)).toContain(String(HID.z2)); // the stored link, raw
		expect(JSON.stringify(on)).toBe(JSON.stringify(off));
		expect(referencesKeys(on.columns)).toEqual([]);
	});

	/**
	 * MEDIA ATTRIBUTION (phase-3b): in the value format each media address is
	 * credited to the column whose cell READ it — media read through the
	 * `#references` walk lands on the `#references` column, never on the main
	 * column (nor nowhere when the main cell is empty), as grid_value credits
	 * every atom's media to its own placed column.
	 */
	async function valueMedia(
		sectionId: number,
	): Promise<{ keyOf: Map<number, string>; media: string[] }> {
		const opened = await openExportGrid(
			{
				principal: root,
				options: {
					section_tipo: HOST,
					lang: LANG,
					data_format: 'value',
					breakdown: 'default',
					ar_ddo_to_export: [
						{
							path: [{ section_tipo: HOST, component_tipo: RELM }],
							value_with_references: true,
						},
					],
					sqo: {
						section_tipo: [HOST],
						filter_by_locators: [{ section_tipo: HOST, section_id: sectionId }],
						limit: 10,
						offset: 0,
					},
				} as unknown as ToolActionContext['options'],
				applicationLang: LANG,
			},
			{ captureMedia: true },
		);
		const keyOf = new Map<number, string>();
		const media: string[] = [];
		for await (const line of opened.lines) {
			const row = line as Line;
			if (row.t === 'col') keyOf.set(row.i as number, String(row.key));
			const rowMedia = (line as { [EXPORT_ROW_MEDIA]?: unknown[][] })[EXPORT_ROW_MEDIA];
			for (const [ordinal, sectionTipo, id, componentTipo] of rowMedia ?? []) {
				const column = ordinal === null ? 'none' : (keyOf.get(ordinal as number) ?? '?');
				media.push(`${column}@${String(sectionTipo)}#${String(id)}#${String(componentTipo)}`);
			}
		}
		return { keyOf, media: media.sort() };
	}
	const MAIN_M = `${HOST}_${RELM}`;
	const REF_M = `${HOST}_${RELM}#references`;

	test('value + capture: each media address is credited to the column that read it', async () => {
		const { media } = await valueMedia(HID.m1);
		expect(media).toEqual(
			[
				`${MAIN_M}@${HOST}#${HID.m3}#${RELM_IMAGE}`,
				`${REF_M}@${HOST}#${HID.m2}#${RELM_IMAGE}`,
			].sort(),
		);
	});

	test('value + capture: an EMPTY main cell does not swallow the `#references` media', async () => {
		const { media } = await valueMedia(HID.m5);
		expect(media).toEqual([`${REF_M}@${HOST}#${HID.m6}#${RELM_IMAGE}`]);
	});

	/**
	 * The flag is valid ONLY where calculated relations exist (dd467 / dd621
	 * related): anywhere else compileExportPlan REFUSES it
	 * (request.invalid_options) — never a silently narrowed export. The client
	 * never offers it there (tool_export.components_with_references, the same
	 * predicate).
	 */
	const refusalOf = async (run: () => Promise<unknown>): Promise<string | null> => {
		try {
			await run();
			return null;
		} catch (error) {
			return String((error as { code?: unknown }).code);
		}
	};
	for (const format of ['value', 'grid_value', 'dedalo_raw']) {
		test(`${format}: a forged flag on a dd620 related / a portal is REFUSED (request.invalid_options)`, async () => {
			expect(await refusalOf(() => exportColumn(format, PLAYGROUND, ID.r1, RELATED, ON))).toBe(
				'request.invalid_options',
			);
			expect(await refusalOf(() => exportColumn(format, HOST, HID.nest, NEST_PORTAL, ON))).toBe(
				'request.invalid_options',
			);
			// non-vacuity: the same columns WITHOUT the flag export, and an
			// eligible (dd467) column WITH it is accepted
			expect(
				JSON.stringify((await exportColumn(format, PLAYGROUND, ID.r1, RELATED)).rows),
			).toContain(format === 'dedalo_raw' ? String(ID.r2) : 'zz related two');
			expect(await refusalOf(() => exportColumn(format, HOST, HID.z1, BIDI, ON))).toBeNull();
		});
	}

	test('compileExportPlan refuses the forged flag itself (the plan, before any walk)', async () => {
		const compile = (tipo: string, section: string) =>
			compileExportPlan(
				[
					{
						path: [{ section_tipo: section, component_tipo: tipo }],
						value_with_references: true,
					},
				] as never,
				section,
			);
		expect(await refusalOf(() => compile(RELATED, PLAYGROUND))).toBe('request.invalid_options');
		expect(await refusalOf(() => compile(PORTAL, PLAYGROUND))).toBe('request.invalid_options');
		const plan = await compile(BIDI, HOST);
		expect(plan.sections[0]?.fields[0]?.exportColumn?.valueWithReferences).toBe(true);
	});

	test('components_with_references: the client checkbox gate is the refusal predicate', async () => {
		const response = await toolExportComponentsWithReferences({
			principal: root,
			userId: -1,
			options: {
				section_tipo: PLAYGROUND,
				components: [
					{ tipo: BIDI, section_tipo: HOST }, // dd467
					{ tipo: 'test56', section_tipo: PLAYGROUND }, // dd621 (generic test TLD)
					{ tipo: RELATED, section_tipo: PLAYGROUND }, // dd620
					{ tipo: PORTAL, section_tipo: PLAYGROUND },
				],
			},
			background: false,
		} as unknown as ToolActionContext);
		expect(response.data).toEqual({
			[BIDI]: true,
			test56: true,
			[RELATED]: false,
			[PORTAL]: false,
		});
		expect(
			await refusalOf(() =>
				toolExportComponentsWithReferences({
					principal: root,
					userId: -1,
					options: { section_tipo: PLAYGROUND, components: [] },
					background: false,
				} as unknown as ToolActionContext),
			),
		).toBe('request.invalid_options');
	});
});

// --- D7 — grid_value multi-item cells join as PHP; iri value+title glue -------
describe.if(DB_READY)('D7 — grid_value cell join = PHP join_cell; iri glue precedence', () => {
	beforeAll(async () => {
		await assertTestDatabase('tool_export_value_relation_native');
		root = await resolvePrincipal(-1);
		await sweepTest3();
		await ensureSituation(S);
		await insertRows(PLAYGROUND, TEST3_ROWS);
		await insertRows(HOST, HOST_ROWS);
	}, 120_000);

	afterAll(async () => {
		await assertTestDatabase('tool_export_value_relation_native');
		await sweepTest3();
		await fireSaveEvent(PLAYGROUND);
		expect(await dropSituation(S)).toBe(0);
	});

	/**
	 * PHP export_tabulator.php join_cell :940-956 → export_value::join
	 * (class.export_value.php :193-364): the atoms of one grid cell join with the
	 * LEAF segment's fields_separator. component_number has no override
	 * (component_common get_export_value :1901-1928 → build_export_path_segment
	 * → fields_separator ddo ?? properties ?? null → join_atoms default ', ');
	 * before D7 the TS cell joined every multi-atom cell with a hard ' | '.
	 */
	test('grid_value: a multi-item number cell joins ", " (was " | ")', async () => {
		const result = await exportColumn('grid_value', PLAYGROUND, ID.multi, NUMBER);
		expect(cellByKey(result, `${PLAYGROUND}_${NUMBER}`)).toBe('3, 4');
	});

	/** component_input_text :58-74: leaf fields_separator = records_separator ?? ' | '. */
	test('grid_value: a multi-item input_text cell joins " | "', async () => {
		const result = await exportColumn('grid_value', PLAYGROUND, ID.multi, TEXT);
		expect(cellByKey(result, `${PLAYGROUND}_${TEXT}`)).toBe('p | q');
	});

	/**
	 * PHP join_cell :940-956 bypasses export_value::join ONLY for a single int
	 * section_id atom; every other cell — a SINGLE atom included — goes through
	 * the join and its empty() rule: a lone number 0 is an EMPTY cell (the
	 * column is still minted: the atom exists).
	 */
	test('grid_value: a lone "0" atom is an EMPTY cell; a lone section_id keeps its value', async () => {
		const key = `${PLAYGROUND}_${NUMBER}`;
		const zero = await exportColumn('grid_value', PLAYGROUND, ID.zero, NUMBER);
		expect(zero.columns.map((c) => c.key)).toContain(key);
		expect(cellByKey(zero, key)).toBe('');
		const id = await exportColumn('grid_value', PLAYGROUND, ID.zero, SECTION_ID);
		expect(cellByKey(id, `${PLAYGROUND}_${SECTION_ID}`)).toBe(String(ID.zero));
		// non-vacuity: a non-zero lone number still shows
		const seven = await exportColumn('grid_value', PLAYGROUND, ID.b1, NUMBER);
		expect(cellByKey(seven, key)).toBe('7');
	});

	/**
	 * D3 (PHP): an item the walk REACHES is an atom even when empty — a media
	 * component always one (component_media_common :340-372, '' without a
	 * URL), a literal one per stored item (component_input_text :96-107) — so
	 * the records join keeps the target's slot.
	 */
	test.if(Boolean(config.media.exportBase))(
		'D3: an image-less target keeps its media slot (value)',
		async () => {
			const base = config.media.exportBase as string;
			const cell = await exportCell(HOST, HID.e0, SLOT_MEDIA);
			expect(cell.value).toBe(`${base}${SLOT_PATH_A} |  | ${base}${SLOT_PATH_C}`);
			expect(cell.value).toBe(joinAtomsOracle(cell.valueAtoms));
		},
	);

	test('D3: an empty input_text item keeps its slot (value); the interactive reader still drops it', async () => {
		const cell = await exportCell(HOST, HID.e0, SLOT_TEXT);
		expect(cell.value).toBe('slot a |  | slot c');
		expect(cell.value).toBe(joinAtomsOracle(cell.valueAtoms));
		expect((await interactiveCell(HOST, HID.e0, SLOT_TEXT)).value).toBe('slot a | slot c');
	});

	test('D3 grid_value: the empty slot is a row without a cell (PHP place_atom mints it)', async () => {
		const result = await exportColumn('grid_value', HOST, HID.e0, SLOT_TEXT);
		expect(result.rows.length).toBe(3);
		expect(cellByKey(result, `${HOST}_${SLOT_TEXT}`)).toBe('slot a | slot c');
		const empty = result.rows[1]?.c as Record<string, string>;
		expect(Object.keys(empty)).toEqual([]);
	});

	/** D11: a ddo_map entry WITHOUT `parent` hangs from nothing — never a child. */
	test('D11: a parent-less ddo is not exported (value, grid_value, interactive)', async () => {
		const cell = await exportCell(HOST, HID.np, NO_PARENT);
		expect(cell.value).toBe('bee');
		expect(cell.atoms.length).toBeGreaterThan(0);
		expect(cell.atoms.some((atom) => atom.model === 'component_number')).toBe(false);
		expect(cell.valueAtoms.some((atom) => atom.model === 'component_number')).toBe(false);
		expect((await interactiveCell(HOST, HID.np, NO_PARENT)).value).toBe('bee');
	});

	/**
	 * A REAL A→B→A cycle (CYCLE shows [label, itself]): the walk follows c1 →
	 * c2 → c1 and stops when c1 × CYCLE is already on the path, NOTED
	 * `relation_cycle:<tipo>` — never a silent cut, never a hang.
	 */
	test('cycle: the export walk ends at relation_cycle with the partial value (value + grid_value)', async () => {
		const cell = await exportCell(HOST, HID.c1, CYCLE);
		expect(cell.value).toBe('c two, c one');
		expect(cell.unresolved).toContain(`relation_cycle:${CYCLE}`);
		expect(joinAtomsOracle(cell.valueAtoms)).toBe('c two, c one');
		const grid = await exportColumn('grid_value', HOST, HID.c1, CYCLE);
		expect(cellByKey(grid, `${HOST}_${CYCLE}`)).toBe('c two, c one');
		const value = await exportColumn('value', HOST, HID.c1, CYCLE);
		expect(cellByKey(value, `${HOST}_${CYCLE}`)).toBe('c two, c one');
	});

	/**
	 * component_iri.php :354-367, :401: each item = iri + title glued with
	 * ddo.fields_separator ?? properties.fields_separator ?? ', '; the items
	 * join with records_separator ?? ' | ' (the leaf's fields_separator).
	 */
	const ONE = 'https://example.org/zzxv/one';
	const TWO = 'https://example.org/zzxv/two';
	const TITLE = 'zz iri title';
	for (const format of ['value', 'grid_value']) {
		test(`${format}: iri glue — properties rung`, async () => {
			const result = await exportColumn(format, HOST, HID.iri, IRI_SEP);
			expect(cellByKey(result, `${HOST}_${IRI_SEP}`)).toBe(`${ONE} — ${TITLE} | ${TWO}`);
		});
		test(`${format}: iri glue — default ", "`, async () => {
			const result = await exportColumn(format, HOST, HID.iri, IRI_PLAIN);
			expect(cellByKey(result, `${HOST}_${IRI_PLAIN}`)).toBe(`${ONE}, ${TITLE} | ${TWO}`);
		});
		test(`${format}: iri glue — the caller ddo rung wins over properties`, async () => {
			const result = await exportColumn(
				format,
				HOST,
				HID.iri,
				IRI_SEP,
				{},
				{
					fields_separator: ' ~ ',
				},
			);
			expect(cellByKey(result, `${HOST}_${IRI_SEP}`)).toBe(`${ONE} ~ ${TITLE} | ${TWO}`);
		});
	}

	test('interactive reader: iri glue from properties (no ddo)', async () => {
		const declared = await interactiveCell(HOST, HID.iri, IRI_SEP);
		expect(declared.value).toBe(`${ONE} — ${TITLE} | ${TWO}`);
		const plain = await interactiveCell(HOST, HID.iri, IRI_PLAIN);
		expect(plain.value).toBe(`${ONE}, ${TITLE} | ${TWO}`);
	});
});

// --- G6 — the frontier survives the caller-map rewire --------------------------
const identity = exportFrontierIdentity('tool_export_value_relation', 933800);
const REFUSAL = 'perm.export_column_out_of_scope';
const SENTINEL = 'zzxv hidden lapis inscription';
const G6_ID = 1;
const R7_STORED = 2;
const R7_HIDDEN = 3;
const REF_SENTINEL = 'zzxv hidden related reference';
// D6: A6#4 is pointed at (dd96) by A6#5 (mine), A6#6 (OTHER project — same,
// READABLE section) and B6#7 (a section the scoped persona may NOT read)
const INDEX_TARGET = 4;
const INDEX_VISIBLE = 5;
const INDEX_HIDDEN = 6;
const INDEX_UNREADABLE = 7;
const INDEX_UNREADABLE_OTHER = 8; // B6 AND the other project
const UNREADABLE_SENTINEL = 'zzxv index unreadable';

const SCOPED_GRANTS = [
	{ sectionTipo: A6, tipo: A6, level: 2 },
	{ sectionTipo: A6, tipo: P6, level: 2 },
	{ sectionTipo: A6, tipo: R7, level: 2 },
	{ sectionTipo: A6, tipo: A7_LABEL, level: 2 },
	{ sectionTipo: A6, tipo: INDEX6, level: 2 },
	{ sectionTipo: A6, tipo: INDEX6C, level: 2 },
];
const ADMIN_GRANTS = [
	...[A6, B6, C6, E6].map((tipo) => ({ sectionTipo: tipo, tipo, level: 3 })),
	{ sectionTipo: A6, tipo: P6, level: 3 },
	{ sectionTipo: A6, tipo: A6_FILTER, level: 3 },
	{ sectionTipo: A6, tipo: R7, level: 3 },
	{ sectionTipo: A6, tipo: A7_LABEL, level: 3 },
	{ sectionTipo: A6, tipo: INDEX6, level: 3 },
	{ sectionTipo: A6, tipo: INDEX6C, level: 3 },
	{ sectionTipo: B6, tipo: B6_LABEL, level: 3 },
	{ sectionTipo: B6, tipo: R6, level: 3 },
	{ sectionTipo: B6, tipo: B6_FILTER, level: 3 },
	{ sectionTipo: C6, tipo: C6_LABEL, level: 3 },
	{ sectionTipo: C6, tipo: S6, level: 3 },
	{ sectionTipo: C6, tipo: C6_FILTER, level: 3 },
	{ sectionTipo: E6, tipo: E6_LABEL, level: 3 },
	{ sectionTipo: E6, tipo: E6_FILTER, level: 3 },
	{ sectionTipo: E6, tipo: E6_IMAGE, level: 3 },
];

async function writeG6(
	section: string,
	filter: string,
	project: number,
	relation: Record<string, unknown>,
	label?: [string, string],
	id: number = G6_ID,
) {
	await sql.unsafe('DELETE FROM matrix_test WHERE section_tipo = $1 AND section_id = $2', [
		section,
		id,
	]);
	// E6 also holds an image file (the strict media-walk probe)
	const media =
		section === E6
			? { [E6_IMAGE]: [{ id: 1, files_info: [{ quality: 'original', file_path: E6_IMAGE_PATH }] }] }
			: null;
	await sql.unsafe(
		`INSERT INTO matrix_test (section_tipo, section_id, relation, string, data, media)
		 VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb, $5::text::jsonb, $6::text::jsonb)`,
		[
			section,
			id,
			encodeForJsonb({ [filter]: [identity.filterLocator(filter, project)], ...relation }),
			encodeForJsonb(label === undefined ? {} : { [label[0]]: text(label[1]) }),
			encodeForJsonb({ section_tipo: section, section_id: id }),
			encodeForJsonb(media),
		],
	);
}

async function exportG6(
	principal: Principal,
	ddo: Record<string, unknown> = { path: [{ section_tipo: A6, component_tipo: P6 }] },
	dataFormat = 'value',
	recordId: number = G6_ID,
): Promise<string> {
	const options = {
		section_tipo: A6,
		lang: LANG,
		data_format: dataFormat,
		breakdown: 'default',
		ar_ddo_to_export: [ddo],
		sqo: {
			section_tipo: [A6],
			filter_by_locators: [{ section_tipo: A6, section_id: recordId }],
			limit: 10,
			offset: 0,
		},
	};
	try {
		const response: ToolResponse = await toolExportGetExportGrid({
			principal,
			userId: principal.userId,
			options,
			background: false,
		} as unknown as ToolActionContext);
		return `OK:${JSON.stringify(response.data)}`;
	} catch (error) {
		const code = (error as { code?: string }).code ?? 'unknown';
		return `REFUSED:${code}:${JSON.stringify((error as { details?: unknown }).details ?? null)}`;
	}
}

/** dedalo_raw with media capture (the tool_export background build): captured addresses or the refusal. */
async function mediaG6(principal: Principal): Promise<string> {
	const options = {
		section_tipo: A6,
		lang: LANG,
		data_format: 'dedalo_raw',
		breakdown: 'default',
		ar_ddo_to_export: [{ path: [{ section_tipo: A6, component_tipo: P6 }] }],
		sqo: {
			section_tipo: [A6],
			filter_by_locators: [{ section_tipo: A6, section_id: G6_ID }],
			limit: 10,
			offset: 0,
		},
	};
	try {
		const opened = await openExportGrid(
			{ principal, options: options as ToolActionContext['options'], applicationLang: LANG },
			{ captureMedia: true },
		);
		const media: string[] = [];
		for await (const line of opened.lines) {
			// ExportRowMediaAddress = [ddo index, section_tipo, section_id, component_tipo]
			const rowMedia = (line as { [EXPORT_ROW_MEDIA]?: unknown[][] })[EXPORT_ROW_MEDIA];
			for (const [, sectionTipo, sectionId, componentTipo] of rowMedia ?? []) {
				media.push(`${String(sectionTipo)}#${String(sectionId)}#${String(componentTipo)}`);
			}
		}
		return `OK:${media.join(',')}`;
	} catch (error) {
		const code = (error as { code?: string }).code ?? 'unknown';
		return `REFUSED:${code}:${JSON.stringify((error as { details?: unknown }).details ?? null)}`;
	}
}

describe.if(DB_READY)(
	'G6 — a record reached ONLY through the caller map crosses the frontier',
	() => {
		beforeAll(async () => {
			await ensureSituation(S);
			await identity.install(SCOPED_GRANTS, ADMIN_GRANTS);
			const mine = identity.myProject;
			// D4 frontier: A6#1 stores R7 → A6#2 (mine); A6#3 (OTHER project)
			// stores R7 → A6#1 — a calculated (inverse) relation of A6#1 the
			// scoped caller may not read
			await writeG6(A6, A6_FILTER, mine, {
				[P6]: [locator(P6, B6, G6_ID)],
				[R7]: [locator(R7, A6, R7_STORED, 1, 'dd89')],
			});
			await writeG6(A6, A6_FILTER, mine, {}, [A7_LABEL, 'zzxv related stored'], R7_STORED);
			await writeG6(
				A6,
				A6_FILTER,
				identity.otherProject,
				{ [R7]: [locator(R7, A6, G6_ID, 1, 'dd89')] },
				[A7_LABEL, REF_SENTINEL],
				R7_HIDDEN,
			);
			await writeG6(B6, B6_FILTER, mine, { [R6]: [locator(R6, C6, G6_ID)] }, [B6_LABEL, 'zzxv b']);
			await writeG6(C6, C6_FILTER, mine, { [S6]: [locator(S6, E6, G6_ID)] }, [C6_LABEL, 'zzxv c']);
			// E6 sits in the OTHER project: hidden from the scoped caller
			await writeG6(E6, E6_FILTER, identity.otherProject, {}, [E6_LABEL, SENTINEL]);
			// D6: the index target and its two pointers (one per project)
			const pointsAtTarget = { [POINTER6]: [locator(POINTER6, A6, INDEX_TARGET, 1, 'dd96')] };
			await writeG6(A6, A6_FILTER, mine, {}, [A7_LABEL, 'zzxv index target'], INDEX_TARGET);
			await writeG6(
				A6,
				A6_FILTER,
				mine,
				pointsAtTarget,
				[A7_LABEL, 'zzxv index visible'],
				INDEX_VISIBLE,
			);
			await writeG6(
				A6,
				A6_FILTER,
				identity.otherProject,
				pointsAtTarget,
				[A7_LABEL, 'zzxv index hidden'],
				INDEX_HIDDEN,
			);
			await writeG6(
				B6,
				B6_FILTER,
				mine,
				{ [POINTER6B]: [locator(POINTER6B, A6, INDEX_TARGET, 1, 'dd96')] },
				[B6_LABEL, UNREADABLE_SENTINEL],
				INDEX_UNREADABLE,
			);
			await writeG6(
				B6,
				B6_FILTER,
				identity.otherProject,
				{ [POINTER6B]: [locator(POINTER6B, A6, INDEX_TARGET, 1, 'dd96')] },
				[B6_LABEL, `${UNREADABLE_SENTINEL} other`],
				INDEX_UNREADABLE_OTHER,
			);
		}, 120_000);

		afterAll(async () => {
			await identity.remove(true);
			expect(await dropSituation(S)).toBe(0);
		});

		/**
		 * DISPLAYED (T0-1 owner decision D4): the scoped caller's own read of the
		 * column embeds E6 through the caller map, so the value export must carry
		 * exactly the admin's bytes. Measured 2026-11-11: the host read DOES follow
		 * the caller map down to E6 — the plan's "throws" claim does not hold for a
		 * displayed record; the refusal law is pinned below on the strict media walk.
		 */
		test('DISPLAYED: the caller-map value of a hidden record exports scoped == admin', async () => {
			const shown = hostColumnDisplayedValues(
				await hostSectionReadItems(identity.scoped, A6, G6_ID, LANG, 't09-g6'),
				P6,
				A6,
				G6_ID,
			);
			expect(shown).toContain(SENTINEL); // the carve-out's premise, asked of the read itself
			const admin = await exportG6(identity.admin);
			// non-vacuity: the caller map reaches E6 (PHP get_export_value, injected map)
			expect(admin).toContain(SENTINEL);
			expect(await exportG6(identity.scoped)).toBe(admin);
		});

		/**
		 * REFUSES: the media walk is STRICT (beyond any display — T0-1): a hidden
		 * E6 image reached only through the caller map throws by the column for the
		 * scoped caller; the admin captures it (D1: media derives from the same atoms).
		 */
		test('REFUSES: the strict media walk under the caller map throws by the column', async () => {
			expect(await mediaG6(identity.scoped)).toBe(
				`REFUSED:${REFUSAL}:${JSON.stringify({ column: 'zz t09 frontier column' })}`,
			);
			expect(await mediaG6(identity.admin)).toContain(`${E6}#${G6_ID}#${E6_IMAGE}`);
		});

		/**
		 * D4 `#references`: a CALCULATED target crosses the frontier like any
		 * other locator the walk reads through (fanOutRelation's crossing). The
		 * hidden inverse A6#3 is not a record the scoped caller's host read
		 * DISPLAYS under R7 (the read's references are labels, not data items),
		 * so the crossing takes the full law: refused, named by the column.
		 * Flag OFF the same column exports (the stored link only) — the refusal
		 * is the calculated set's, not the column's.
		 */
		test('REFUSES: a hidden calculated target under `#references` throws by the column', async () => {
			const ddo = (extra: Record<string, unknown> = {}) => ({
				path: [{ section_tipo: A6, component_tipo: R7 }],
				...extra,
			});
			for (const format of ['value', 'grid_value']) {
				const admin = await exportG6(identity.admin, ddo({ value_with_references: true }), format);
				expect(admin).toContain(REF_SENTINEL); // non-vacuity: the closure reaches A6#3
				expect(admin).toContain('#references');
				expect(await exportG6(identity.scoped, ddo({ value_with_references: true }), format)).toBe(
					`REFUSED:${REFUSAL}:${JSON.stringify({ column: 'zz t09 frontier related' })}`,
				);
				const scopedOff = await exportG6(identity.scoped, ddo(), format);
				expect(scopedOff).toContain('zzxv related stored');
				expect(scopedOff).not.toContain(REF_SENTINEL);
			}
		});

		/**
		 * D6 (RE-DECIDED 2026-11-11 — WC-2026-11-11-relation-index-related-list-context,
		 * owner rule): SAME AS THE EDIT FORM. Every reader gets EVERY pointer — the
		 * set is never filtered ("nobody points at it" is a delete decision). A
		 * pointer in a section the requester may not read (B6 for the scoped
		 * persona) shows its section NAME + section_id, its columns blank. The
		 * predicate is the edit form's own, per pointing SECTION
		 * (locator_source.ts pointingSectionReadable): A6#6 sits in another
		 * project but in the readable section A6, so — exactly as the edit form —
		 * its columns show.
		 * D9: the same rule for a CONFIGURED index (explicit map), edit form included.
		 * D8: the export carries the unreadable pointer's name + id — B6#8 (other
		 * project too) no longer refuses the column; its content stays out.
		 */
		const asPrincipal = <T>(principal: Principal | undefined, fn: () => Promise<T>) =>
			principal === undefined
				? runWithRequestLangs({ applicationLang: LANG, dataLang: LANG }, fn)
				: runWithRequestContext(
						{ principal, session: null, requestId: 't09-d6', clientIp: '' },
						() => runWithRequestLangs({ applicationLang: LANG, dataLang: LANG }, fn),
					);
		const FULL_SET = [
			`${A6}#${INDEX_VISIBLE}`,
			`${A6}#${INDEX_HIDDEN}`,
			`${B6}#${INDEX_UNREADABLE}`,
			`${B6}#${INDEX_UNREADABLE_OTHER}`,
		];
		const EXISTENCE = `zz t09 frontier b ${INDEX_UNREADABLE}`;
		const EXISTENCE_OTHER = `zz t09 frontier b ${INDEX_UNREADABLE_OTHER}`;
		const INDEXES = [
			{ name: 'config-less', tipo: INDEX6, column: 'zz t09 frontier index' },
			{ name: 'configured (D9)', tipo: INDEX6C, column: 'zz t09 frontier index configured' },
		];

		for (const index of INDEXES) {
			describe(`D6 — ${index.name}: every pointer reaches every reader; an unreadable section shows name + id`, () => {
				const sourced = (principal: Principal | undefined) =>
					asPrincipal(principal, async () =>
						(
							await componentLocators(
								{ sectionTipo: A6, sectionId: INDEX_TARGET, columns: null },
								index.tipo,
								'component_relation_index',
							)
						).map((l) => `${String(l.section_tipo)}#${Number(l.section_id)}`),
					);
				const cell = (principal: Principal) =>
					asPrincipal(principal, async () => {
						clearFieldsSeparatorCache();
						const unresolved: string[] = [];
						return resolveCellValue(A6, INDEX_TARGET, index.tipo, LANG, unresolved);
					});

				test('the source: the FULL set for admin, system AND the scoped persona', async () => {
					expect(await sourced(identity.admin)).toEqual(FULL_SET);
					expect(await sourced(undefined)).toEqual(FULL_SET);
					expect(await sourced(identity.scoped)).toEqual(FULL_SET);
				});

				test('interactive resolveCellValue: the unreadable pointer is name + id, columns blank', async () => {
					const admin = (await cell(identity.admin)) ?? '';
					// non-vacuity: the admin reads every pointer's column
					for (const value of ['zzxv index visible', 'zzxv index hidden', UNREADABLE_SENTINEL]) {
						expect(admin).toContain(value);
					}
					expect(admin).not.toContain(EXISTENCE);
					const scoped = (await cell(identity.scoped)) ?? '';
					expect(scoped).toContain('zzxv index visible');
					expect(scoped).toContain('zzxv index hidden'); // readable SECTION — the edit form's rule
					expect(scoped).toContain(EXISTENCE); // the hidden pointer's name + id
					expect(scoped).toContain(EXISTENCE_OTHER); // ...whatever its project
					expect(scoped).not.toContain(UNREADABLE_SENTINEL); // ...and nothing of its content
				});

				test('the edit form agrees: the same pointers, the same columns withheld', async () => {
					// The edit read's pointing-record cells, as `section#id#tipo` (their
					// literal VALUES are not compared: the config-less edit form resolves a
					// translatable related_list column at 'lg-nolan' — empty for both
					// personas — so values would make this leg vacuous there).
					const editForm = async (principal: Principal, requestId: string) => {
						const read = await hostSectionRead(principal, A6, INDEX_TARGET, LANG, requestId);
						const indexItem = read.data.find(
							(item) => item.tipo === index.tipo && Number(item.section_id) === INDEX_TARGET,
						);
						const entries = (Array.isArray(indexItem?.entries) ? indexItem.entries : []) as {
							section_tipo?: unknown;
							section_id?: unknown;
						}[];
						const sqoSections = read.context
							.filter((ctx) => ctx.tipo === index.tipo)
							.flatMap((ctx) => ctx.request_config ?? [])
							.flatMap((rc) => (Array.isArray(rc.sqo?.section_tipo) ? rc.sqo.section_tipo : []))
							.filter((ddo) => ddo?.tipo === B6);
						return {
							pointers: entries.map((e) => `${String(e.section_tipo)}#${Number(e.section_id)}`),
							cells: read.data
								.filter((item) => item.section_tipo === A6 || item.section_tipo === B6)
								.filter((item) => item.tipo === A7_LABEL || item.tipo === B6_LABEL)
								// THIS index's cells only (both columns share the read): a
								// config-less index stamps `parent`, a configured one's portal
								// cells carry it as from_component_tipo
								.filter(
									(item) =>
										(item as { parent?: unknown }).parent === index.tipo ||
										item.from_component_tipo === index.tipo,
								)
								.filter((item) => Number(item.section_id) !== INDEX_TARGET)
								.map(
									(item) =>
										`${String(item.section_tipo)}#${Number(item.section_id)}#${String(item.tipo)}`,
								),
							b6ExistenceOnly: sqoSections.map((ddo) => ddo.existence_only === true),
						};
					};
					const admin = await editForm(identity.admin, 't09-d6a');
					const scoped = await editForm(identity.scoped, 't09-d6e');
					expect(admin.pointers).toEqual(FULL_SET);
					expect(scoped.pointers).toEqual(FULL_SET);
					// non-vacuity: the admin's edit form carries the B6 pointers' cells
					expect(admin.cells).toContain(`${B6}#${INDEX_UNREADABLE}#${B6_LABEL}`);
					// the scoped persona's: the A6 pointers' cells (other project
					// included — section rule), and NO cell of the unreadable B6
					expect(scoped.cells).toContain(`${A6}#${INDEX_HIDDEN}#${A7_LABEL}`);
					expect(scoped.cells.filter((c) => c.startsWith(`${B6}#`))).toEqual([]);
					// the client's existence cell (label + section_id) keys on the marker
					expect(admin.b6ExistenceOnly).toEqual([false]);
					expect(scoped.b6ExistenceOnly).toEqual([true]);
				});

				test('the seam: an unreadable pointing section gets its address only', async () => {
					const tipos = (principal: Principal | undefined, section: string) =>
						asPrincipal(principal, async () =>
							(await exportConfigChildren(index.tipo, section)).map((child) => child.tipo),
						);
					const full = index.tipo === INDEX6 ? [B6_SECTION_ID, B6_LABEL] : [A7_LABEL, B6_LABEL];
					expect(await tipos(identity.admin, B6)).toEqual(full);
					expect(await tipos(undefined, B6)).toEqual(full);
					expect(await tipos(identity.scoped, B6)).toEqual([B6_SECTION_ID]);
					expect(await tipos(identity.scoped, A6)).toEqual(
						index.tipo === INDEX6 ? [A6_SECTION_ID, A7_LABEL] : [A7_LABEL, B6_LABEL],
					);
				});

				/**
				 * EXPORT (D8): the unreadable pointers export as name + id — B6#8 too,
				 * whose RECORD the scoped persona may not reach: the frontier's
				 * existence reach admits its ADDRESS because the host read lists it
				 * among the index's entries — and reads nothing there. Admin unchanged.
				 */
				for (const format of ['value', 'grid_value']) {
					test(`export ${format}: name + id for every unreadable pointer, content blank, no refusal`, async () => {
						const ddo = { path: [{ section_tipo: A6, component_tipo: index.tipo }] };
						const admin = await exportG6(identity.admin, ddo, format, INDEX_TARGET);
						expect(admin.startsWith('OK:')).toBe(true);
						for (const value of ['zzxv index visible', 'zzxv index hidden', UNREADABLE_SENTINEL]) {
							expect(admin).toContain(value);
						}
						expect(admin).not.toContain(EXISTENCE);
						const scoped = await exportG6(identity.scoped, ddo, format, INDEX_TARGET);
						expect(scoped.startsWith('OK:')).toBe(true);
						expect(scoped).toContain('zzxv index visible');
						expect(scoped).toContain('zzxv index hidden');
						expect(scoped).toContain(EXISTENCE);
						expect(scoped).toContain(EXISTENCE_OTHER);
						expect(scoped).not.toContain(UNREADABLE_SENTINEL);
					});
				}

				test('export value: the cell bytes (admin full, scoped name + id)', async () => {
					const ddo = { path: [{ section_tipo: A6, component_tipo: index.tipo }] };
					const cellOf = async (principal: Principal) =>
						(
							JSON.parse(
								(await exportG6(principal, ddo, 'value', INDEX_TARGET)).slice('OK:'.length),
							) as { rows: { c: Record<string, string> }[] }
						).rows[0]?.c['0'];
					// config-less: [section_id, ...related_list] per pointer; configured: its map
					const id = (n: number) => (index.tipo === INDEX6 ? `${n}, ` : '');
					expect(await cellOf(identity.admin)).toBe(
						`${id(5)}zzxv index visible | ${id(6)}zzxv index hidden | ${id(7)}${UNREADABLE_SENTINEL} | ${id(8)}${UNREADABLE_SENTINEL} other`,
					);
					expect(await cellOf(identity.scoped)).toBe(
						`${id(5)}zzxv index visible | ${id(6)}zzxv index hidden | ${EXISTENCE} | ${EXISTENCE_OTHER}`,
					);
				});
			});
		}
	},
);
