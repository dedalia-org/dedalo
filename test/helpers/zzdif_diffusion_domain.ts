/**
 * GENERIC diffusion domain fixture (tld `zzdif`) — the situation the plan
 * compiler and the resolver gates are asserted against.
 *
 * WHY IT EXISTS (2026-08-20). `diffusion_plan_compile` and `diffusion_resolver`
 * were the last two unit gates bound to an installation: they compiled and
 * resolved the DEPLOYMENT's diffusion domain (`DEDALO_DIFFUSION_DOMAIN`,
 * historically `numisdata_mib`, element `numisdata29`, section `numisdata6`).
 * That made them green on exactly one developer's machine — measured
 * 2026-08-20 on this checkout (domain `mht`) BOTH failed in `beforeAll`. A gate
 * that tests one install's records tests that install, not the engine.
 *
 * `buildVirtualDiffusionTree(domainName)` takes the domain as a parameter
 * (2026-08-20), so this fixture provisions a domain of its OWN under dd1190 and
 * the gates name it. Nothing is read from the ambient ontology: the domain, its
 * elements, its tables, its fields, the sections they publish AND the records
 * they project are all built here through `situation()` (reserved `zz*` TLD,
 * records land in `matrix_test`, teardown asserts zero residue).
 *
 * MINIMAL BUT FAITHFUL — the shapes are copied from a real install's dd1190
 * subtree (models, property bags, ddo_map/parser grammar), the VOLUME is not
 * (~700 nodes there, 33 here). Every law the two gates assert has a node:
 *
 *   zzdif40  diffusion_domain  'zzdif generic domain'          (parent dd1190)
 *     zzdif41  diffusion_group
 *       zzdif42  diffusion_element  {"diffusion":{"type":"sql"}}   ← THE element
 *         zzdif43  database  'zzdif_publication_db'
 *           zzdif44  table  'zzdif_primary'  → section zzdif1
 *             zzdif45  field_varchar  'title'        ← plain component read
 *             zzdif46  field_varchar  'code'
 *             zzdif47  field_text     'summary'      ← runtime parser chain
 *             zzdif48  field_int      'counter'      ← number column
 *             zzdif49  field_int      'published_at' ← REWRITER step, no ddo
 *             zzdif51  field_text     'linked_ids'   ← portal hop (frontier)
 *             zzdif52  field_enum     'publication'  ← exclude_column
 *           zzdif50  table_alias 'zzdif_linked' → zzdif60  ← ALIAS-IN-PLACE law
 *             zzdif53  field_varchar  'alias_own_field'
 *       zzdif55  diffusion_element  (holds the alias TARGET, so the real table
 *         zzdif56  database 'zzdif_alias_source_db'   is not element-suppressed)
 *           zzdif60  table 'zzdif_linked_real' → section zzdif20
 *             zzdif61  field_varchar 'name'
 *             zzdif62  field_enum    'publication' (exclude_column)
 *       zzdif70  diffusion_element  ← the LOUD-FAILURE element
 *         zzdif71  database 'zzdif_broken_db'
 *           zzdif72  table 'zzdif_broken' → section zzdif20
 *             zzdif73  field_varchar 'bad_parser'  parser fn NOT in the registry
 *       zzdif80  diffusion_element  {"diffusion":{"type":"markdown","service_name":"zzdif_md"}}
 *         zzdif81  table 'zzdif_primary_md' → section zzdif1   ← the FILE element
 *           zzdif82  field_varchar 'title'  | zzdif83 field_varchar 'code'
 *           zzdif84  field_int 'counter'    | zzdif85 field_enum 'publication' (exclude_column)
 *
 *       zzdif90  diffusion_element  {"diffusion":{"type":"markdown","service_name":"zzdif_md_hop"}}
 *         zzdif91  table 'zzdif_hop_primary_md' → section zzdif1   ← the FILE element WITH A HOP
 *           zzdif92  field_varchar 'title' | zzdif93 field_text 'linked_ids' (portal zzdif7)
 *           zzdif94  field_enum 'publication' (exclude_column)
 *         zzdif95  table 'zzdif_hop_linked_md' → section zzdif20
 *           zzdif96  field_varchar 'name'  | zzdif97 field_enum 'publication' (exclude_column)
 *
 *       zzdif100 diffusion_element {"diffusion":{"type":"sql"}}   ← the GLOBAL-TABLE element (T1-3)
 *         zzdif101 database 'zzdif_global_db'
 *           zzdif102 table 'zzdif_gt_primary' → zzdif1   global_table_maps → zzdif110
 *             zzdif103 field_varchar 'title' | zzdif104 field_varchar 'code' | zzdif105 publication (excl)
 *           zzdif106 table 'zzdif_gt_linked' → zzdif20   global_table_maps → zzdif110
 *             zzdif107 field_varchar 'name' | zzdif108 publication (excl)
 *           zzdif110 table 'zzdif_global' (NO section relation — the aggregate table)
 *             zzdif111 'section_id' varchar 64 | zzdif112 'ref_section_id' | zzdif113 'ref_section_tipo'
 *             zzdif114 'ref_table' | zzdif115 'link' | zzdif116 'title' | zzdif117 'title_code'
 *             zzdif118 'both' | zzdif119 'sort_id'
 *           zzdif120 table 'zzdif_global_unruled' (aggregate) ← zzdif102's SECOND map,
 *             zzdif121 'section_id' | zzdif122 'title'       naming an UNDECLARED target
 *                                                          column (UNRULED T1-3 D1: never
 *                                                          written, still withdrawn)
 *
 *   The GLOBAL-TABLE element (2026-11-12, T1-3) is v6 `global_table_maps`: every
 *   published row of zzdif1 / zzdif20 also lands in `zzdif_global` under
 *   `<section_tipo>_<section_id>` (test/unit/diffusion_global_table_native.test.ts).
 *   Its own database, so no sibling gate's tables or targets change shape.
 *
 *   The HOP file element (2026-09-30, DIFF-1) exists so a run has a FRONTIER:
 *   with `levels: 1` the portal field queues 940101/940102 and the run's output is
 *   the primary files PLUS the linked section's `zzdif20_<id>.md` — a crash
 *   inside the drain, and a resume that must rebuild it, become observable on
 *   disk (test/unit/diffusion_resume_ledger_native.test.ts).
 *
 *   The file element (2026-09-02) exists so the RUNNER gate can drive the real
 *   `runJob` end to end on Postgres + a scratch files root alone: the sql
 *   element needs a MariaDB target the suite does not own, a markdown target
 *   needs only DEDALO_DIFFUSION_FILES_ROOT (writers/files.ts) and lands ONE
 *   file per record (`zzdif1_<id>.md`), so a removal is an observable unlink.
 *   No portal field, so the run has no frontier and its output is exactly the
 *   primary section. (markdown, not json/csv: those two writers exist but the
 *   compiler's KNOWN_FORMATS is the PHP validate set, which never took them.)
 *
 * and the data side:
 *
 *   zzdif1   section 'zzdif primary section'   (parent test1, matrix_test)
 *     zzdif2 component_input_text (translatable) | zzdif3 component_input_text
 *     zzdif4 component_input_text | zzdif5 component_number
 *     zzdif6 component_publication | zzdif7 component_portal → zzdif20
 *   zzdif20  section 'zzdif linked section'
 *     zzdif21 component_input_text | zzdif22 component_publication
 *
 *   940001  zzdif1  PUBLISHABLE   (dd64/1) + portal → 940101, 940102
 *   940002  zzdif1  UNPUBLISHABLE (dd64/2)
 *   940003  zzdif1  PUBLISHABLE   (dd64/1) — batching/resume filler, no relations
 *   940004  zzdif1  PUBLISHABLE   (dd64/1) — idem
 *   940005  zzdif1  PUBLISHABLE   (dd64/1) — idem
 *   940101  zzdif20 publishable
 *   940102  zzdif20 publishable
 *
 * The ALIAS law needs the real table to live under ANOTHER element: the walk
 * suppresses a real node consumed by an alias INSIDE the same element
 * (virtual_tree.ts consumedByAliasByElement), which is exactly how the install
 * shape works too (an alias in one element targeting a table owned by another).
 */

import {
	dropSituation,
	ensureSituation,
	residueOf,
	type Situation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';

/** The domain NAME the gates hand to buildVirtualDiffusionTree(). */
export const ZZDIF_DOMAIN_NAME = 'zzdif generic domain';
/** The dd1190 child node that name must resolve to. */
export const ZZDIF_DOMAIN_TIPO = 'zzdif40';
/** The sql element every plan-shape assertion is made against. */
export const ZZDIF_ELEMENT = 'zzdif42';
/** The element that must FAIL to compile (unknown parser fn). */
export const ZZDIF_BROKEN_ELEMENT = 'zzdif70';
/** The primary section the resolver projects rows from. */
export const ZZDIF_SECTION = 'zzdif1';
/** The linked section reached through the portal hop (frontier level 0). */
export const ZZDIF_LINKED_SECTION = 'zzdif20';
/** The primary section's component_publication (dd64 twin). */
export const ZZDIF_PUBLICATION = 'zzdif6';
/** The primary section's component_portal into the linked section. */
export const ZZDIF_PORTAL = 'zzdif7';
/** The linked section's component_publication. */
export const ZZDIF_LINKED_PUBLICATION = 'zzdif22';
/** The alias table node (published under the ALIAS label). */
export const ZZDIF_TABLE_ALIAS = 'zzdif50';
/** The markdown FILE element — the runner gate's subject (Postgres + files root only). */
export const ZZDIF_FILE_ELEMENT = 'zzdif80';
/** Its output format (`properties.diffusion.type`) — the `<files root>/<format>/` segment. */
export const ZZDIF_FILE_FORMAT = 'markdown';
/** Its `service_name`: the directory label under `<files root>/markdown/`. */
export const ZZDIF_FILE_SERVICE_NAME = 'zzdif_md';
/** The table label under the file element — the `tables[].table_name` a run reports. */
export const ZZDIF_FILE_TABLE_NAME = 'zzdif_primary_md';
/** The markdown FILE element WITH A PORTAL HOP (DIFF-1) — its runs have a frontier. */
export const ZZDIF_HOP_FILE_ELEMENT = 'zzdif90';
/** Its `service_name`: the directory label under `<files root>/markdown/`. */
export const ZZDIF_HOP_SERVICE_NAME = 'zzdif_md_hop';
/** Its primary and linked table labels (`tables[].table_name`). */
export const ZZDIF_HOP_PRIMARY_TABLE_NAME = 'zzdif_hop_primary_md';
export const ZZDIF_HOP_LINKED_TABLE_NAME = 'zzdif_hop_linked_md';
/** The GLOBAL-TABLE sql element (T1-3) and its names. */
export const ZZDIF_GLOBAL_ELEMENT = 'zzdif100';
export const ZZDIF_GLOBAL_DATABASE = 'zzdif_global_db';
export const ZZDIF_GLOBAL_PRIMARY_TABLE = 'zzdif_gt_primary';
export const ZZDIF_GLOBAL_LINKED_TABLE = 'zzdif_gt_linked';
/** The aggregate table node + name every global row lands in. */
export const ZZDIF_GLOBAL_TABLE_TIPO = 'zzdif110';
export const ZZDIF_GLOBAL_TABLE = 'zzdif_global';
/** The `format: 'string'` separator of its `title_code` map. */
export const ZZDIF_GLOBAL_SEPARATOR = ' · ';
/** The aggregate table only an UNRULED map (T1-3 D1: unknown target column) names. */
export const ZZDIF_GLOBAL_UNRULED_TABLE_TIPO = 'zzdif120';
export const ZZDIF_GLOBAL_UNRULED_TABLE = 'zzdif_global_unruled';
/** The column zzdif102's unruled map targets — zzdif120 does NOT declare it. */
export const ZZDIF_GLOBAL_UNRULED_COLUMN = 'filter_date';
/** The parser fn no registry entry exists for — the loud-failure subject. */
export const ZZDIF_UNKNOWN_PARSER_FN = 'parser_zzdif::no_such_fn';

export const ZZDIF_PUBLISHABLE_ID = 940001;
export const ZZDIF_UNPUBLISHABLE_ID = 940002;
export const ZZDIF_LINKED_IDS = [940101, 940102] as const;
/**
 * FURTHER publishable primaries, carrying no relations — they exist so a run can
 * be INTERRUPTED with work still ahead of it. With a single publishable record
 * the first batch always finishes the job, and a resume gate comparing the two
 * tables passes without ever resuming: measured 2026-08-21, a planted offender
 * (a resume cursor advanced 1000 past its checkpoint) stayed green. Anything
 * asserting batching or checkpoints needs more than one row to be about
 * anything.
 */
export const ZZDIF_EXTRA_PUBLISHABLE_IDS = [940003, 940004, 940005] as const;

/** dd64 = DEDALO_SECTION_SI_NO_TIPO; section_id 1 = yes, 2 = no. */
const YES = [{ section_tipo: 'dd64', section_id: 1 }];
const NO = [{ section_tipo: 'dd64', section_id: 2 }];

/** The `publication` enum field shape every install writes (exclude_column). */
function publicationField(tipo: string, source: string) {
	return {
		tipo,
		model: 'field_enum',
		term: { 'lg-spa': 'publication' },
		relations: [{ tipo: source }],
		properties: {
			exclude_column: true,
			process: {
				parser: [
					{ fn: 'parser_locator::get_v6_section_id' },
					{ fn: 'parser_helper::get_first' },
					{ fn: 'parser_text::map_value', options: { map: [{ a: { '1': 'si', '2': 'no' } }] } },
				],
				default_value: 'no',
			},
		},
	};
}

function buildSituation(): Situation {
	return situation({
		name: 'zzdif generic diffusion domain',
		tld: 'zzdif',
		nodes: [
			// ---- data side: two sections with components ----------------------
			{ tipo: 'zzdif1', parent: 'test1', model: 'section', term: { 'lg-spa': 'zzdif primary' } },
			{
				tipo: 'zzdif2',
				parent: 'zzdif1',
				model: 'component_input_text',
				term: { 'lg-spa': 'title source' },
				is_translatable: true,
				order_number: 1,
			},
			{
				tipo: 'zzdif3',
				parent: 'zzdif1',
				model: 'component_input_text',
				term: { 'lg-spa': 'code source' },
				order_number: 2,
			},
			{
				tipo: 'zzdif4',
				parent: 'zzdif1',
				model: 'component_input_text',
				term: { 'lg-spa': 'summary source' },
				is_translatable: true,
				order_number: 3,
			},
			{
				tipo: 'zzdif5',
				parent: 'zzdif1',
				model: 'component_number',
				term: { 'lg-spa': 'counter source' },
				order_number: 4,
			},
			{
				tipo: ZZDIF_PUBLICATION,
				parent: 'zzdif1',
				model: 'component_publication',
				term: { 'lg-spa': 'publication source' },
				order_number: 5,
			},
			{
				tipo: ZZDIF_PORTAL,
				parent: 'zzdif1',
				model: 'component_portal',
				term: { 'lg-spa': 'linked source' },
				order_number: 6,
			},
			{ tipo: 'zzdif20', parent: 'test1', model: 'section', term: { 'lg-spa': 'zzdif linked' } },
			{
				tipo: 'zzdif21',
				parent: 'zzdif20',
				model: 'component_input_text',
				term: { 'lg-spa': 'linked name source' },
				is_translatable: true,
				order_number: 1,
			},
			{
				tipo: ZZDIF_LINKED_PUBLICATION,
				parent: 'zzdif20',
				model: 'component_publication',
				term: { 'lg-spa': 'linked publication source' },
				order_number: 2,
			},

			// ---- diffusion side: the domain ------------------------------------
			{
				tipo: 'zzdif40',
				parent: 'dd1190',
				model: 'diffusion_domain',
				term: { 'lg-spa': ZZDIF_DOMAIN_NAME },
			},
			{
				tipo: 'zzdif41',
				parent: 'zzdif40',
				model: 'diffusion_group',
				term: { 'lg-spa': 'zzdif group' },
			},
			// element 1 — the subject of every plan-shape assertion.
			{
				tipo: 'zzdif42',
				parent: 'zzdif41',
				model: 'diffusion_element',
				term: { 'lg-spa': 'zzdif sql element' },
				properties: { diffusion: { type: 'sql' } },
				order_number: 1,
			},
			{
				tipo: 'zzdif43',
				parent: 'zzdif42',
				model: 'database',
				term: { 'lg-spa': 'zzdif_publication_db' },
			},
			{
				tipo: 'zzdif44',
				parent: 'zzdif43',
				model: 'table',
				term: { 'lg-spa': 'zzdif_primary' },
				relations: [{ tipo: 'zzdif1' }],
				order_number: 1,
			},
			{
				tipo: 'zzdif45',
				parent: 'zzdif44',
				model: 'field_varchar',
				term: { 'lg-spa': 'title' },
				relations: [{ tipo: 'zzdif2' }],
				properties: { varchar: 500 },
				order_number: 1,
			},
			{
				tipo: 'zzdif46',
				parent: 'zzdif44',
				model: 'field_varchar',
				term: { 'lg-spa': 'code' },
				relations: [{ tipo: 'zzdif3' }],
				properties: { varchar: 64 },
				order_number: 2,
			},
			{
				tipo: 'zzdif47',
				parent: 'zzdif44',
				model: 'field_text',
				term: { 'lg-spa': 'summary' },
				relations: [{ tipo: 'zzdif4' }],
				properties: {
					process: { parser: [{ fn: 'parser_text::v5_html' }], output_format: 'string' },
				},
				order_number: 3,
			},
			{
				tipo: 'zzdif48',
				parent: 'zzdif44',
				model: 'field_int',
				term: { 'lg-spa': 'counter' },
				relations: [{ tipo: 'zzdif5' }],
				order_number: 4,
			},
			// REWRITER step + no ddo_map: absorbed at compile ('rewriter:…@zzdif49'),
			// executed by the resolver as the run-scoped constant.
			{
				tipo: 'zzdif49',
				parent: 'zzdif44',
				model: 'field_int',
				term: { 'lg-spa': 'published_at' },
				properties: {
					process: {
						parser: [{ fn: 'parser_global::publication_unix_timestamp' }],
						output_format: 'int',
					},
				},
				order_number: 5,
			},
			// The portal hop: its locators are what the frontier queues.
			{
				tipo: 'zzdif51',
				parent: 'zzdif44',
				model: 'field_text',
				term: { 'lg-spa': 'linked_ids' },
				relations: [{ tipo: ZZDIF_PORTAL }],
				properties: {
					process: {
						parser: [{ fn: 'parser_locator::get_v6_section_id' }],
						output_format: 'json',
					},
				},
				order_number: 6,
			},
			{ ...publicationField('zzdif52', 'zzdif6'), parent: 'zzdif44', order_number: 7 },
			// The alias: publishes under ITS label, fields merge from zzdif60.
			{
				tipo: 'zzdif50',
				parent: 'zzdif43',
				model: 'table_alias',
				term: { 'lg-spa': 'zzdif_linked' },
				relations: [{ tipo: 'zzdif60' }],
				order_number: 2,
			},
			{
				tipo: 'zzdif53',
				parent: 'zzdif50',
				model: 'field_varchar',
				term: { 'lg-spa': 'alias_own_field' },
				relations: [{ tipo: 'zzdif21' }],
				properties: { varchar: 128 },
				order_number: 1,
			},

			// element 2 — owns the alias TARGET table (see the header note).
			{
				tipo: 'zzdif55',
				parent: 'zzdif41',
				model: 'diffusion_element',
				term: { 'lg-spa': 'zzdif alias source element' },
				properties: { diffusion: { type: 'sql' } },
				order_number: 2,
			},
			{
				tipo: 'zzdif56',
				parent: 'zzdif55',
				model: 'database',
				term: { 'lg-spa': 'zzdif_alias_source_db' },
			},
			{
				tipo: 'zzdif60',
				parent: 'zzdif56',
				model: 'table',
				term: { 'lg-spa': 'zzdif_linked_real' },
				relations: [{ tipo: 'zzdif20' }],
			},
			{
				tipo: 'zzdif61',
				parent: 'zzdif60',
				model: 'field_varchar',
				term: { 'lg-spa': 'name' },
				relations: [{ tipo: 'zzdif21' }],
				properties: { varchar: 500 },
				order_number: 1,
			},
			{ ...publicationField('zzdif62', 'zzdif22'), parent: 'zzdif60', order_number: 2 },

			// element 3 — must FAIL to compile, naming the field and the fn.
			{
				tipo: 'zzdif70',
				parent: 'zzdif41',
				model: 'diffusion_element',
				term: { 'lg-spa': 'zzdif broken element' },
				properties: { diffusion: { type: 'sql' } },
				order_number: 3,
			},
			{
				tipo: 'zzdif71',
				parent: 'zzdif70',
				model: 'database',
				term: { 'lg-spa': 'zzdif_broken_db' },
			},
			{
				tipo: 'zzdif72',
				parent: 'zzdif71',
				model: 'table',
				term: { 'lg-spa': 'zzdif_broken' },
				relations: [{ tipo: 'zzdif20' }],
			},
			{
				tipo: 'zzdif73',
				parent: 'zzdif72',
				model: 'field_varchar',
				term: { 'lg-spa': 'bad_parser' },
				relations: [{ tipo: 'zzdif21' }],
				properties: { process: { parser: [{ fn: ZZDIF_UNKNOWN_PARSER_FN }] } },
			},

			// element 4 — the FILE element the runner gate publishes through
			// (see the header note): the primary section's plain fields, no hop.
			{
				tipo: 'zzdif80',
				parent: 'zzdif41',
				model: 'diffusion_element',
				term: { 'lg-spa': 'zzdif markdown file element' },
				properties: {
					diffusion: { type: ZZDIF_FILE_FORMAT, service_name: ZZDIF_FILE_SERVICE_NAME },
				},
				order_number: 4,
			},
			{
				tipo: 'zzdif81',
				parent: 'zzdif80',
				model: 'table',
				term: { 'lg-spa': ZZDIF_FILE_TABLE_NAME },
				relations: [{ tipo: 'zzdif1' }],
			},
			{
				tipo: 'zzdif82',
				parent: 'zzdif81',
				model: 'field_varchar',
				term: { 'lg-spa': 'title' },
				relations: [{ tipo: 'zzdif2' }],
				properties: { varchar: 500 },
				order_number: 1,
			},
			{
				tipo: 'zzdif83',
				parent: 'zzdif81',
				model: 'field_varchar',
				term: { 'lg-spa': 'code' },
				relations: [{ tipo: 'zzdif3' }],
				properties: { varchar: 64 },
				order_number: 2,
			},
			{
				tipo: 'zzdif84',
				parent: 'zzdif81',
				model: 'field_int',
				term: { 'lg-spa': 'counter' },
				relations: [{ tipo: 'zzdif5' }],
				order_number: 3,
			},
			{ ...publicationField('zzdif85', 'zzdif6'), parent: 'zzdif81', order_number: 4 },

			// element 5 — the FILE element WITH A HOP (DIFF-1, see the header note):
			// the primary table carries the portal field, and the linked section has
			// its OWN table in the same element, so the frontier it queues publishes.
			{
				tipo: ZZDIF_HOP_FILE_ELEMENT,
				parent: 'zzdif41',
				model: 'diffusion_element',
				term: { 'lg-spa': 'zzdif markdown hop element' },
				properties: {
					diffusion: { type: ZZDIF_FILE_FORMAT, service_name: ZZDIF_HOP_SERVICE_NAME },
				},
				order_number: 5,
			},
			{
				tipo: 'zzdif91',
				parent: ZZDIF_HOP_FILE_ELEMENT,
				model: 'table',
				term: { 'lg-spa': ZZDIF_HOP_PRIMARY_TABLE_NAME },
				relations: [{ tipo: 'zzdif1' }],
				order_number: 1,
			},
			{
				tipo: 'zzdif92',
				parent: 'zzdif91',
				model: 'field_varchar',
				term: { 'lg-spa': 'title' },
				relations: [{ tipo: 'zzdif2' }],
				properties: { varchar: 500 },
				order_number: 1,
			},
			{
				tipo: 'zzdif93',
				parent: 'zzdif91',
				model: 'field_text',
				term: { 'lg-spa': 'linked_ids' },
				relations: [{ tipo: ZZDIF_PORTAL }],
				properties: {
					process: {
						parser: [{ fn: 'parser_locator::get_v6_section_id' }],
						output_format: 'json',
					},
				},
				order_number: 2,
			},
			{ ...publicationField('zzdif94', 'zzdif6'), parent: 'zzdif91', order_number: 3 },
			{
				tipo: 'zzdif95',
				parent: ZZDIF_HOP_FILE_ELEMENT,
				model: 'table',
				term: { 'lg-spa': ZZDIF_HOP_LINKED_TABLE_NAME },
				relations: [{ tipo: 'zzdif20' }],
				order_number: 2,
			},
			{
				tipo: 'zzdif96',
				parent: 'zzdif95',
				model: 'field_varchar',
				term: { 'lg-spa': 'name' },
				relations: [{ tipo: 'zzdif21' }],
				properties: { varchar: 500 },
				order_number: 1,
			},
			{ ...publicationField('zzdif97', 'zzdif22'), parent: 'zzdif95', order_number: 2 },

			// element 6 — the GLOBAL-TABLE element (T1-3, see the header note).
			{
				tipo: ZZDIF_GLOBAL_ELEMENT,
				parent: 'zzdif41',
				model: 'diffusion_element',
				term: { 'lg-spa': 'zzdif global table element' },
				properties: { diffusion: { type: 'sql' } },
				order_number: 6,
			},
			{
				tipo: 'zzdif101',
				parent: ZZDIF_GLOBAL_ELEMENT,
				model: 'database',
				term: { 'lg-spa': ZZDIF_GLOBAL_DATABASE },
			},
			{
				tipo: 'zzdif102',
				parent: 'zzdif101',
				model: 'table',
				term: { 'lg-spa': ZZDIF_GLOBAL_PRIMARY_TABLE },
				relations: [{ tipo: 'zzdif1' }],
				properties: {
					global_table_maps: [
						{
							table_tipo: ZZDIF_GLOBAL_TABLE_TIPO,
							columns_map: [
								{ target_column: 'title', source_columns: ['title'] },
								{
									target_column: 'title_code',
									source_columns: ['title', 'code'],
									format: 'string',
									separator: ZZDIF_GLOBAL_SEPARATOR,
								},
								{ target_column: 'both', source_columns: ['title', 'code'] },
								{ target_column: 'sort_id', source_columns: ['section_id'] },
							],
						},
						{
							table_tipo: ZZDIF_GLOBAL_UNRULED_TABLE_TIPO,
							columns_map: [
								{ target_column: ZZDIF_GLOBAL_UNRULED_COLUMN, source_columns: ['title'] },
							],
						},
					],
				},
				order_number: 1,
			},
			{
				tipo: 'zzdif103',
				parent: 'zzdif102',
				model: 'field_varchar',
				term: { 'lg-spa': 'title' },
				relations: [{ tipo: 'zzdif2' }],
				properties: { varchar: 500 },
				order_number: 1,
			},
			{
				tipo: 'zzdif104',
				parent: 'zzdif102',
				model: 'field_varchar',
				term: { 'lg-spa': 'code' },
				relations: [{ tipo: 'zzdif3' }],
				properties: { varchar: 64 },
				order_number: 2,
			},
			{ ...publicationField('zzdif105', 'zzdif6'), parent: 'zzdif102', order_number: 3 },
			{
				tipo: 'zzdif106',
				parent: 'zzdif101',
				model: 'table',
				term: { 'lg-spa': ZZDIF_GLOBAL_LINKED_TABLE },
				relations: [{ tipo: 'zzdif20' }],
				properties: {
					global_table_maps: [
						{
							table_tipo: ZZDIF_GLOBAL_TABLE_TIPO,
							columns_map: [{ target_column: 'title', source_columns: ['name'] }],
						},
					],
				},
				order_number: 2,
			},
			{
				tipo: 'zzdif107',
				parent: 'zzdif106',
				model: 'field_varchar',
				term: { 'lg-spa': 'name' },
				relations: [{ tipo: 'zzdif21' }],
				properties: { varchar: 500 },
				order_number: 1,
			},
			{ ...publicationField('zzdif108', 'zzdif22'), parent: 'zzdif106', order_number: 2 },
			{
				tipo: ZZDIF_GLOBAL_TABLE_TIPO,
				parent: 'zzdif101',
				model: 'table',
				term: { 'lg-spa': ZZDIF_GLOBAL_TABLE },
				order_number: 3,
			},
			...(
				[
					['zzdif111', 'field_varchar', 'section_id', { varchar: 64 }],
					['zzdif112', 'field_int', 'ref_section_id', null],
					['zzdif113', 'field_varchar', 'ref_section_tipo', { varchar: 64 }],
					['zzdif114', 'field_varchar', 'ref_table', { varchar: 64 }],
					['zzdif115', 'field_text', 'link', null],
					['zzdif116', 'field_text', 'title', null],
					['zzdif117', 'field_text', 'title_code', null],
					['zzdif118', 'field_text', 'both', null],
					['zzdif119', 'field_int', 'sort_id', null],
				] as const
			).map(([tipo, model, name, properties], position) => ({
				tipo,
				parent: ZZDIF_GLOBAL_TABLE_TIPO,
				model,
				term: { 'lg-spa': name },
				...(properties !== null ? { properties } : {}),
				order_number: position + 1,
			})),
			{
				tipo: ZZDIF_GLOBAL_UNRULED_TABLE_TIPO,
				parent: 'zzdif101',
				model: 'table',
				term: { 'lg-spa': ZZDIF_GLOBAL_UNRULED_TABLE },
				order_number: 4,
			},
			{
				tipo: 'zzdif121',
				parent: ZZDIF_GLOBAL_UNRULED_TABLE_TIPO,
				model: 'field_varchar',
				term: { 'lg-spa': 'section_id' },
				properties: { varchar: 64 },
				order_number: 1,
			},
			{
				tipo: 'zzdif122',
				parent: ZZDIF_GLOBAL_UNRULED_TABLE_TIPO,
				model: 'field_text',
				term: { 'lg-spa': 'title' },
				order_number: 2,
			},
		],
		records: [
			{
				section_tipo: 'zzdif1',
				section_id: ZZDIF_PUBLISHABLE_ID,
				columns: {
					// component_input_text stores {value,lang} items in the `string`
					// column (its descriptor), NOT in `data`.
					string: {
						zzdif2: [{ value: 'zzdif publishable title', lang: 'lg-spa' }],
						zzdif3: [{ value: 'ZZDIF-0001' }],
						zzdif4: [{ value: 'A <b>summary</b> body', lang: 'lg-spa' }],
					},
					number: { zzdif5: [{ value: 42 }] },
					relation: {
						zzdif6: YES,
						zzdif7: ZZDIF_LINKED_IDS.map((id) => ({
							section_tipo: 'zzdif20',
							section_id: id,
						})),
					},
				},
			},
			{
				section_tipo: 'zzdif1',
				section_id: ZZDIF_UNPUBLISHABLE_ID,
				columns: {
					string: {
						zzdif2: [{ value: 'zzdif unpublishable title', lang: 'lg-spa' }],
						zzdif3: [{ value: 'ZZDIF-0002' }],
					},
					number: { zzdif5: [{ value: 7 }] },
					relation: { zzdif6: NO },
				},
			},
			...ZZDIF_EXTRA_PUBLISHABLE_IDS.map((id) => ({
				section_tipo: 'zzdif1',
				section_id: id,
				columns: {
					string: {
						zzdif2: [{ value: `zzdif publishable title ${id}`, lang: 'lg-spa' }],
						zzdif3: [{ value: `ZZDIF-${id}` }],
					},
					number: { zzdif5: [{ value: id - 940000 }] },
					relation: { zzdif6: YES },
				},
			})),
			...ZZDIF_LINKED_IDS.map((id) => ({
				section_tipo: 'zzdif20',
				section_id: id,
				columns: {
					string: { zzdif21: [{ value: `zzdif linked ${id}`, lang: 'lg-spa' }] },
					relation: { zzdif22: YES },
				},
			})),
		],
	});
}

/** The validated descriptor (pure — no DB until ensure/drop). */
export const ZZDIF_SITUATION: Situation = buildSituation();

/** Provision the fixture; any leftover from an aborted run is swept first. */
export async function ensureZzdifDomain(): Promise<void> {
	await dropSituation(ZZDIF_SITUATION);
	await ensureSituation(ZZDIF_SITUATION);
}

/** Tear it down; the returned residue count MUST be asserted 0 by the caller. */
export async function dropZzdifDomain(): Promise<number> {
	return dropSituation(ZZDIF_SITUATION);
}

/** Rows this situation currently owns (nodes + records + counters). */
export async function zzdifResidue(): Promise<number> {
	return residueOf(ZZDIF_SITUATION);
}
