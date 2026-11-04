/**
 * SUBDATUM PERMISSIONS, EXACT PHP — owner decisions (d), (f), (g) of the
 * nested-ddo_map plan (W4, 2026-11-03), on the suite DB.
 *
 * THE PHP PATH (section/node_permissions.ts header has the file:line map):
 *   - a SECTION caller drops every ddo of its map the user holds 0 on
 *     (trait.request_config_ddo.php:146-152 STEP 11), nested lines included;
 *   - every child of a COMPONENT caller is raised to read (1) and capped at
 *     read under a read-only caller (class.common.php:2564-2571), judged
 *     against the IMMEDIATE caller instance's level — so the cap travels down.
 *
 * THE OWNER'S CASES, each against the same restricted profile (no grant on the
 * thesaurus THES at all, 0 on MID.REL2 and LEAF.LEAF_X):
 *
 *  (i)  THESAURUS (NON-TREE components): PEOPLE's autocomplete_hi TERM_REF
 *       points into THES. The user reads PEOPLE: the term is SERVED (data +
 *       context at level 1), and the save door ACCEPTS a known locator into
 *       TERM_REF. The two former OWNER QUESTIONS are DECIDED (round 4,
 *       2026-11-03, security/writer_chain_scope.ts):
 *       (h) the autocomplete SEARCH of THES that picks a term is admitted ONLY
 *           through a verified `source.callers` chain ending at a component
 *           the user can WRITE, limited to its config's show/search columns
 *           (read and count alike); no chain, a read-only caller, a forged
 *           chain or a non-target sqo section → perm.denied;
 *       (i) the TREE-PICKER twin TERM_REF_TREE (`view: 'tree'`) is ACCEPTED at
 *           save (the TS-only target_not_readable gate of WC-2026-08-14 is
 *           retired, PHP-identical), and its tree browse (the dd_ts_api node
 *           doors, the hierarchy prune) is readable only through the same
 *           verified writer chain — a node read ONLY through it carries the
 *           writer config's columns plus the navigation entries, a scoped
 *           children page PRUNES an unreadable child, and a GRANTED parent's
 *           page stays PHP-parity (the parent alone is judged).
 *  (ii) COMPONENT-RELATED-TO-COMPONENT-RELATED THROUGH A SECTION CALLER: a
 *       section map naming REL1R → REL2 (MID) → LEAF_TEXT drops REL2 (no grant)
 *       and with it its subtree; the SAME REL2 reached through REL1's OWN
 *       config (a component caller) is served at level 1. Admin control: the
 *       section map serves REL2 and LEAF_TEXT.
 *
 * THE CAP CHAIN (decision (d), PHP-exact): REL1 (granted 2) → REL2 (own 0 →
 * raised 1) → LEAF_TEXT (own 2 → capped 1, because ITS caller REL2 is read-only)
 * at the get_data door and the section door; MID_TEXT (own 2) stays 2 under
 * REL1 and is capped 1 under the read-only REL1R — derived AND as a declared
 * nested column. Before W4 the get_data door capped by the MAIN element only
 * (LEAF_TEXT came out 2) and the column pass stamped a nested column with its
 * own level (MID_TEXT came out 2 under REL1R).
 *
 * THE CALLER CHAIN (relations/caller_chain.ts) — the read floor (decision (f),
 * plan E10) and stage 1 on page 2: REL3's own config declares REL4's (and
 * REL2's) children [LEAF_X] (their own maps are [LEAF_TEXT]). The user holds 0
 * on LEAF_X — yet the cell shows it (raised). Through the API door, a search
 * from REL4 (granted) that names its verified chain [REL3 @ PEOPLE] may filter
 * LEAF by LEAF_X (hit finds, miss does not); without the chain, with a FORGED
 * chain, or through a SECTION root whose STEP 11 drop removed the LEAF_X line
 * (DECL → DREL → REL4), the search stays KEYED (hit and miss identical). A
 * RAISED source (REL2, own 0) is refused at Gate A before any floor — DECIDED
 * (h): a read-only caller unlocks nothing (search and page 2 alike) — and gets no floor at all, so
 * the COUNT door (no Gate A) stays keyed too. The SECTION-rooted list chain
 * [DECL(list), DREL] is proven to VERIFY (STEP 11 applied), and so is the
 * EDIT-mode client shape (a component root, resolved under its section's map —
 * W4b task 5). Page 2 keeps the SERVER slots under the chain (a hidden
 * dataframe DFF of DFP, task 4), and the owner record's filter_by_locators
 * never enters the effective config's sqo (a stage-1 probe — the get_data
 * door's own outcome cannot discriminate it). And a page-2
 * get_data of REL2 under the verified chain resolves the CALLER's children
 * [LEAF_X] — a resent show of them is inherited (served), the same show with
 * no chain is judged and dropped.
 *
 * THE DDINFO GATE (decision (g)): the GOVERNING children trigger ddinfo inside
 * the kept TS gate (component_autocomplete_hi). TERM_REF_M (own line without
 * value_with_parents, plain matrix target) fires ONLY with a caller line that
 * declares it; TERM_REF (own vwp on a thesaurus table) does NOT when a caller
 * line without it governs; the plain component_portal PLAIN_P never does.
 *
 * A NESTED RELATION CHILD IN A SECTION THE USER HOLDS NOTHING ON (plan Gates,
 * the relation half of "both a literal child and a nested relation child are
 * emitted at level 1"): REL5 (granted) → THES (no grant at all) → THES_REL, a
 * portal of THES → LEAF. THES_REL is expanded (its locator served), its context
 * stamped 1, and its own child LEAF_TEXT (own 2) capped 1 under it.
 *
 * Situation: the scratch TLD `zzsubp` (ensureSituation → assertTestDatabase),
 * one restricted user + profile minted as ordinary dd128 / dd234 records, all
 * swept after (residue 0 — matrix rows, TM and counters through dropSituation,
 * and the ACTIVITY rows every read/save by the minted user and root logs,
 * which dropSituation does not count: test/helpers/activity_rows.ts).
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
	getPermissionGrant,
	getPermissions,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { countActivityRows, sweepActivityRows } from '../helpers/activity_rows.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

/** The people-like section and its relation components. */
const PEOPLE = 'zzsubp1';
/** autocomplete_hi → THES, own show [TERM (value_with_parents)]. */
const TERM_REF = 'zzsubp2';
/** portal → MID, own show [MID_TEXT, REL2]. Granted 2. */
const REL1 = 'zzsubp3';
/** portal → MID, own show [MID_TEXT]. Granted 1 (READ-ONLY caller). */
const REL1R = 'zzsubp4';
/** plain portal → THES, own show [TERM] (the ddinfo gate's OUTSIDE). */
const PLAIN_P = 'zzsubp5';
/**
 * portal → MID, own show [REL2, LEAF_X<REL2, REL4, LEAF_X<REL4] — REL2's and
 * REL4's children INJECTED (E10, page 2).
 */
const REL3 = 'zzsubp6';
/**
 * autocomplete_hi → MID (a plain `matrix` section, NOT a thesaurus table), own
 * show [MID_TEXT] WITHOUT value_with_parents — the (g) discriminator: neither
 * its own config nor the thesaurus-table branch fires ddinfo, so only a
 * caller-declared value_with_parents line can.
 */
const TERM_REF_M = 'zzsubp7';
/**
 * portal → THES (granted 2), own show [TERM, THES_REL] — the caller of the
 * nested RELATION child that lives in a section the user holds nothing on.
 */
const REL5 = 'zzsubp8';
/**
 * TERM_REF's TREE-PICKER twin (own `properties.view: 'tree'` — the shape real
 * thesaurus pickers declare: oh126, rsc1057, rsc1265, ontology10). The save
 * door's tree-picker gate (relations/save.ts refuseUnreadableTreePickerTarget,
 * WC-2026-08-14) applies to it and not to TERM_REF.
 */
const TERM_REF_TREE = 'zzsubp9';
/**
 * TERM_REF's READ-ONLY twin (granted 1): autocomplete_hi → THES, own show
 * [TERM]. Decision (h): a read-only caller unlocks no target search.
 */
const TERM_REF_R = 'zzsubp13';
/** A section the user holds NOTHING on and NO component targets (the (h) non-target sqo section). */
const OTHER = 'zzsubp14';
/** A thesaurus-TABLE section (matrix_hierarchy) the user holds NOTHING on. */
const THES = 'zzsubp10';
const TERM = 'zzsubp11';
/** portal on THES → LEAF, own show [LEAF_TEXT]. The user holds NOTHING on its section. */
const THES_REL = 'zzsubp12';
const MID = 'zzsubp20';
const MID_TEXT = 'zzsubp21';
/** portal → LEAF, own show [LEAF_TEXT]. The user holds 0 on it. */
const REL2 = 'zzsubp22';
/** portal → LEAF, own show [LEAF_TEXT]. The user holds 2 on it (a READABLE nested element). */
const REL4 = 'zzsubp23';
const LEAF = 'zzsubp30';
const LEAF_TEXT = 'zzsubp31';
/**
 * portal on MID → LEAF (granted 2), own show [LEAF_TEXT], own HIDE [DFF] — the
 * hidden dataframe page 2 must keep (task 4: stage 1 replaces the show only).
 * REL3 injects its SHOW children (show-only caller: the own hide stays).
 */
const DFP = 'zzsubp24';
/** DFP's dataframe slot (no grant row: raised to read under DFP). */
const DFF = 'zzsubp25';
/** Only REL3's map names it under REL2. The user holds 0 on it. */
const LEAF_X = 'zzsubp32';
/**
 * A section whose OWN map declares DREL → REL2 → LEAF_X and DREL → REL4 →
 * LEAF_X (the STEP 11 drop: REL2 and both LEAF_X lines go, REL4 stays).
 */
const DECL = 'zzsubp40';
/** portal on DECL → MID, own show [MID_TEXT]. */
const DREL = 'zzsubp41';
/** A THES literal NO component config shows (the foreign-declared-column and fixed_filter cases). */
const THES_NOTE = 'zzsubp15';
/**
 * OTHER's literals: shown, CHOOSE-only and HIDE-only by TERM_REF_C. OTHER is a
 * plain matrix section (NOT a globally visible thesaurus table, whose
 * components the search frontier admits whatever the floor), so a filter on
 * them is decided by the scoped floor alone.
 */
const OTHER_TEXT = 'zzsubp34';
const OTHER_LABEL = 'zzsubp16';
const OTHER_NOTE = 'zzsubp35';
/**
 * autocomplete_hi → OTHER (granted 2): show [OTHER_TEXT], CHOOSE
 * [OTHER_LABEL], HIDE [OTHER_NOTE] — the (h) slot discriminator (choose is a
 * column, hide is neither a column nor a filter path on the ungranted section).
 */
const TERM_REF_C = 'zzsubp17';
/** autocomplete_hi → THES (granted 2): show [TERM] + a declared fixed_filter path on THES_NOTE. */
const TERM_REF_F = 'zzsubp18';
/**
 * A CONFIG-LESS (v5 implicit) `view:'tree'` autocomplete_hi (granted 2), its
 * relations [THES, TERM]: STEP 5 drops TERM (the user holds 0 on it) and keeps
 * the THES target — decision (j): it opens nothing.
 */
const TERM_REF_V5 = 'zzsubp19';
/** A VIRTUAL section over THES (the exact-target discriminator). The user holds nothing on it. */
const VTHES = 'zzsubp26';
/** autocomplete_hi → VTHES (granted 2), show [TERM @ VTHES]. */
const TERM_REF_VT = 'zzsubp27';
/** autocomplete_hi IN MID → THES (granted 2), show [TERM] — the writer reached through a COMPONENT caller. */
const W_MID = 'zzsubp28';
/** portal on PEOPLE → MID, show [W_MID]. Granted 1 (a READ-ONLY component caller). */
const CALLER_RO = 'zzsubp29';
/** portal on PEOPLE → MID, show [W_MID]. Granted 2 (the control). */
const CALLER_RW = 'zzsubp33';
/**
 * A SECOND thesaurus-table section (decision (j)): the restricted profile holds
 * a COMPONENT grant on its TERM2 (1) but nothing on the section — so a v5
 * implicit config's STEP 5 KEEPS the THES2.TERM2 pair (ddoIsAuthorized is
 * per-tipo), which is exactly the case decision (j) must still close.
 */
const THES2 = 'zzsubp42';
const TERM2 = 'zzsubp43';
/** CONFIG-LESS (v5) `view:'tree'` autocomplete_hi, relations [THES2, TERM2] (granted 2). */
const TERM_REF_V5K = 'zzsubp44';
/** The (j) control: the same target with an EXPLICIT config showing TERM2, `view:'tree'` (granted 2). */
const TERM_REF_X2 = 'zzsubp45';
/**
 * An OTHER literal NO config names, on which the restricted profile holds a
 * per-tipo COMPONENT grant (1) while the section stays 0 — a scoped search must
 * not filter by it (the scope's filter pairs are EXCLUSIVE on OTHER).
 */
const OTHER_SECRET = 'zzsubp46';
/**
 * portal on PEOPLE → MID whose show line gives the nested writer W_MID
 * `view:'tree'` (a tree picker that is one ONLY through its caller's line —
 * W_MID's own properties declare no view). Granted 2.
 */
const CALLER_TREE = 'zzsubp47';
/**
 * portal on PEOPLE → MID: show [DFP], HIDE [LEAF_X < DFP] — a caller that
 * INJECTS a hide child into DFP (replacing DFP's own hide [DFF]). Granted 2.
 */
const REL6 = 'zzsubp48';
/**
 * portal on MID → LEAF with TWO own config items: dedalo (show [LEAF_TEXT])
 * and a NON-dedalo engine item (stage 1 must keep it). Probe only (no record).
 */
const EXTP = 'zzsubp49';
/** The non-dedalo engine EXTP's second item names (a scratch engine name, no service behind it). */
const EXT_ENGINE = 'zzsubp_ext';
/**
 * THES's tree (owner decision (i), W4b review): its parent / children pair
 * and a section_list_thesaurus rendering [TERM (term), THES_CHILDREN
 * (link_children), THES_NOTE (a mapped DATA element)]. TERM_REF_TREE's config
 * shows TERM only, so a node the profile reads ONLY through that picker's
 * scope carries the term and the expand link, never THES_NOTE.
 */
const THES_PARENT = 'zzsubp50';
const THES_CHILDREN = 'zzsubp51';
const THES_TREE_MAP = 'zzsubp52';
/**
 * LEAF's parent / children pair: LEAF/1's children are LEAF/2 (the profile
 * reads LEAF) and OTHER/1 (it holds 0 on OTHER) — the cross-section children
 * page a granted parent serves whole (PHP parity: only the parent is judged).
 */
const LEAF_PARENT = 'zzsubp53';
const LEAF_CHILDREN = 'zzsubp54';
/**
 * A PUBLIC-LIST section (its matrix_table node names matrix_list, which
 * permissions.ts PUBLIC_LIST_TABLES grants READ by RULE to everyone) holding
 * CALLER_PUB: portal → MID, show [W_MID]. NO profile grant — the restricted
 * profile reads CALLER_PUB by rule only (1), the rule-READ chain ROOT case.
 */
const PUBLIC = 'zzsubp55';
const PUBLIC_TABLE = 'zzsubp56';
const CALLER_PUB = 'zzsubp57';
/**
 * portal on THES → LEAF, own show [LEAF_X] — a relation column whose OWN config
 * shows a third section's component the profile holds 0 on (the (h) own-config
 * bound's subject). No grant.
 */
const THES_REL_X = 'zzsubp58';
/** portal on PEOPLE → THES, own show [TERM, THES_REL_X]. Granted 2 (a writer). */
const REL7 = 'zzsubp59';
/** The matrix_table node naming matrix_hierarchy (isThesaurusTarget). */
const MATRIX_HIERARCHY_TABLE = 'dd425';

const USER_ID = 958951;
const PROFILE_ID = 958961;
const PROJECT_ID = 958971;
const LANG = 'lg-nolan';

const textValue = (value: string) => [{ id: 1, lang: LANG, value }];

const locators = (tipo: string, sectionTipo: string, ids: readonly number[]) =>
	ids.map((sectionId, index) => ({
		id: index + 1,
		type: 'dd151',
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: tipo,
	}));

/** A component_relation_parent locator (dd47) naming `sectionTipo`/`sectionId` as the parent. */
const parentLink = (tipo: string, sectionTipo: string, sectionId: number) => ({
	id: 1,
	type: 'dd47',
	section_id: sectionId,
	section_tipo: sectionTipo,
	from_component_tipo: tipo,
});

/** A relation component's own request_config: target `section`, show `ddoMap`. */
const ownConfig = (section: string, ddoMap: Record<string, unknown>[]) => ({
	source: {
		request_config: [
			{
				sqo: { section_tipo: [{ value: [section], source: 'section' }] },
				show: { ddo_map: ddoMap },
			},
		],
	},
});

const S = situation({
	name: 'subdatum permissions',
	tld: 'zzsubp',
	nodes: [
		{ tipo: PEOPLE, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{
			tipo: TERM_REF,
			parent: PEOPLE,
			model: 'component_autocomplete_hi',
			order_number: 1,
			properties: ownConfig(THES, [
				{ tipo: TERM, parent: 'self', section_tipo: THES, value_with_parents: true },
			]),
		},
		{
			tipo: REL1,
			parent: PEOPLE,
			model: 'component_portal',
			order_number: 2,
			properties: ownConfig(MID, [
				{ tipo: MID_TEXT, parent: 'self', section_tipo: MID },
				{ tipo: REL2, parent: 'self', section_tipo: MID },
			]),
		},
		{
			tipo: REL1R,
			parent: PEOPLE,
			model: 'component_portal',
			order_number: 3,
			properties: ownConfig(MID, [{ tipo: MID_TEXT, parent: 'self', section_tipo: MID }]),
		},
		{
			tipo: PLAIN_P,
			parent: PEOPLE,
			model: 'component_portal',
			order_number: 4,
			properties: ownConfig(THES, [{ tipo: TERM, parent: 'self', section_tipo: THES }]),
		},
		{
			tipo: REL3,
			parent: PEOPLE,
			model: 'component_portal',
			order_number: 5,
			properties: ownConfig(MID, [
				{ tipo: REL2, parent: 'self', section_tipo: MID },
				{ tipo: LEAF_X, parent: REL2, section_tipo: LEAF },
				{ tipo: REL4, parent: 'self', section_tipo: MID },
				{ tipo: LEAF_X, parent: REL4, section_tipo: LEAF },
				{ tipo: DFP, parent: 'self', section_tipo: MID },
				{ tipo: LEAF_TEXT, parent: DFP, section_tipo: LEAF },
			]),
		},
		{
			tipo: TERM_REF_M,
			parent: PEOPLE,
			model: 'component_autocomplete_hi',
			order_number: 6,
			properties: ownConfig(MID, [{ tipo: MID_TEXT, parent: 'self', section_tipo: MID }]),
		},
		{
			tipo: REL5,
			parent: PEOPLE,
			model: 'component_portal',
			order_number: 7,
			properties: ownConfig(THES, [
				{ tipo: TERM, parent: 'self', section_tipo: THES },
				{ tipo: THES_REL, parent: 'self', section_tipo: THES },
			]),
		},
		{
			tipo: TERM_REF_TREE,
			parent: PEOPLE,
			model: 'component_autocomplete_hi',
			order_number: 8,
			properties: {
				...ownConfig(THES, [
					{ tipo: TERM, parent: 'self', section_tipo: THES, value_with_parents: true },
				]),
				view: 'tree',
			},
		},
		{
			tipo: TERM_REF_R,
			parent: PEOPLE,
			model: 'component_autocomplete_hi',
			order_number: 9,
			properties: ownConfig(THES, [{ tipo: TERM, parent: 'self', section_tipo: THES }]),
		},
		{
			tipo: TERM_REF_C,
			parent: PEOPLE,
			model: 'component_autocomplete_hi',
			order_number: 10,
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [OTHER], source: 'section' }] },
							show: { ddo_map: [{ tipo: OTHER_TEXT, parent: 'self', section_tipo: OTHER }] },
							choose: {
								ddo_map: [{ tipo: OTHER_LABEL, parent: 'self', section_tipo: OTHER }],
							},
							hide: { ddo_map: [{ tipo: OTHER_NOTE, parent: 'self', section_tipo: OTHER }] },
						},
					],
				},
			},
		},
		{
			tipo: TERM_REF_F,
			parent: PEOPLE,
			model: 'component_autocomplete_hi',
			order_number: 11,
			properties: {
				source: {
					request_config: [
						{
							sqo: {
								section_tipo: [{ value: [THES], source: 'section' }],
								fixed_filter: [
									{
										source: 'fixed_dato',
										value: [
											{
												q: 'zzsubp*',
												path: [{ section_tipo: THES, component_tipo: THES_NOTE }],
											},
										],
									},
								],
							},
							show: { ddo_map: [{ tipo: TERM, parent: 'self', section_tipo: THES }] },
						},
					],
				},
			},
		},
		{
			tipo: TERM_REF_V5,
			parent: PEOPLE,
			model: 'component_autocomplete_hi',
			order_number: 12,
			relations: [{ tipo: THES }, { tipo: TERM }],
			properties: { view: 'tree' },
		},
		{
			tipo: TERM_REF_VT,
			parent: PEOPLE,
			model: 'component_autocomplete_hi',
			order_number: 13,
			properties: ownConfig(VTHES, [{ tipo: TERM, parent: 'self', section_tipo: VTHES }]),
		},
		{
			tipo: CALLER_RO,
			parent: PEOPLE,
			model: 'component_portal',
			order_number: 14,
			properties: ownConfig(MID, [{ tipo: W_MID, parent: 'self', section_tipo: MID }]),
		},
		{
			tipo: CALLER_RW,
			parent: PEOPLE,
			model: 'component_portal',
			order_number: 15,
			properties: ownConfig(MID, [{ tipo: W_MID, parent: 'self', section_tipo: MID }]),
		},
		{ tipo: PUBLIC, parent: 'test1', model: 'section', relations: [{ tipo: PUBLIC_TABLE }] },
		{ tipo: PUBLIC_TABLE, model: 'matrix_table', term: { 'lg-spa': 'matrix_list' } },
		{
			tipo: CALLER_PUB,
			parent: PUBLIC,
			model: 'component_portal',
			order_number: 1,
			properties: ownConfig(MID, [{ tipo: W_MID, parent: 'self', section_tipo: MID }]),
		},
		{
			tipo: TERM_REF_V5K,
			parent: PEOPLE,
			model: 'component_autocomplete_hi',
			order_number: 16,
			relations: [{ tipo: THES2 }, { tipo: TERM2 }],
			properties: { view: 'tree' },
		},
		{
			tipo: TERM_REF_X2,
			parent: PEOPLE,
			model: 'component_autocomplete_hi',
			order_number: 17,
			properties: {
				...ownConfig(THES2, [{ tipo: TERM2, parent: 'self', section_tipo: THES2 }]),
				view: 'tree',
			},
		},
		{
			tipo: CALLER_TREE,
			parent: PEOPLE,
			model: 'component_portal',
			order_number: 18,
			properties: ownConfig(MID, [
				{ tipo: W_MID, parent: 'self', section_tipo: MID, view: 'tree' },
			]),
		},
		{
			tipo: REL7,
			parent: PEOPLE,
			model: 'component_portal',
			order_number: 20,
			properties: ownConfig(THES, [
				{ tipo: TERM, parent: 'self', section_tipo: THES },
				{ tipo: THES_REL_X, parent: 'self', section_tipo: THES },
			]),
		},
		{
			tipo: THES_REL_X,
			parent: THES,
			model: 'component_portal',
			order_number: 7,
			properties: ownConfig(LEAF, [{ tipo: LEAF_X, parent: 'self', section_tipo: LEAF }]),
		},
		{
			tipo: REL6,
			parent: PEOPLE,
			model: 'component_portal',
			order_number: 19,
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [MID], source: 'section' }] },
							show: { ddo_map: [{ tipo: DFP, parent: 'self', section_tipo: MID }] },
							hide: { ddo_map: [{ tipo: LEAF_X, parent: DFP, section_tipo: LEAF }] },
						},
					],
				},
			},
		},
		{
			tipo: THES2,
			parent: 'test1',
			model: 'section',
			relations: [{ tipo: MATRIX_HIERARCHY_TABLE }],
		},
		{ tipo: TERM2, parent: THES2, model: 'component_input_text', order_number: 1 },
		{ tipo: OTHER_SECRET, parent: OTHER, model: 'component_input_text', order_number: 4 },
		{ tipo: VTHES, parent: 'test1', model: 'section', relations: [{ tipo: THES }] },
		{ tipo: OTHER, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{
			tipo: THES,
			parent: 'test1',
			model: 'section',
			relations: [{ tipo: MATRIX_HIERARCHY_TABLE }],
		},
		{ tipo: TERM, parent: THES, model: 'component_input_text', order_number: 1 },
		{ tipo: THES_NOTE, parent: THES, model: 'component_input_text', order_number: 3 },
		{ tipo: THES_PARENT, parent: THES, model: 'component_relation_parent', order_number: 4 },
		{
			tipo: THES_CHILDREN,
			parent: THES,
			model: 'component_relation_children',
			relations: [{ tipo: THES_PARENT }],
			order_number: 5,
		},
		{
			tipo: THES_TREE_MAP,
			parent: THES,
			model: 'section_list_thesaurus',
			properties: {
				show: {
					ddo_map: [
						{ tipo: TERM, type: 'term' },
						{ tipo: THES_CHILDREN, type: 'link_children' },
						{ tipo: THES_NOTE, type: 'note' },
					],
				},
			},
			order_number: 6,
		},
		{ tipo: LEAF_PARENT, parent: LEAF, model: 'component_relation_parent', order_number: 8 },
		{
			tipo: LEAF_CHILDREN,
			parent: LEAF,
			model: 'component_relation_children',
			relations: [{ tipo: LEAF_PARENT }],
			order_number: 9,
		},
		{ tipo: OTHER_TEXT, parent: OTHER, model: 'component_input_text', order_number: 1 },
		{ tipo: OTHER_LABEL, parent: OTHER, model: 'component_input_text', order_number: 2 },
		{ tipo: OTHER_NOTE, parent: OTHER, model: 'component_input_text', order_number: 3 },
		{
			tipo: THES_REL,
			parent: THES,
			model: 'component_portal',
			order_number: 2,
			properties: ownConfig(LEAF, [{ tipo: LEAF_TEXT, parent: 'self', section_tipo: LEAF }]),
		},
		{ tipo: MID, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{ tipo: MID_TEXT, parent: MID, model: 'component_input_text', order_number: 1 },
		{
			tipo: REL2,
			parent: MID,
			model: 'component_portal',
			order_number: 2,
			properties: ownConfig(LEAF, [{ tipo: LEAF_TEXT, parent: 'self', section_tipo: LEAF }]),
		},
		{
			tipo: REL4,
			parent: MID,
			model: 'component_portal',
			order_number: 3,
			properties: ownConfig(LEAF, [{ tipo: LEAF_TEXT, parent: 'self', section_tipo: LEAF }]),
		},
		{
			tipo: DFP,
			parent: MID,
			model: 'component_portal',
			order_number: 4,
			properties: {
				has_dataframe: true,
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [LEAF], source: 'section' }] },
							show: { ddo_map: [{ tipo: LEAF_TEXT, parent: 'self', section_tipo: LEAF }] },
							hide: { ddo_map: [{ tipo: DFF, parent: 'self', section_tipo: MID }] },
						},
					],
				},
			},
		},
		{ tipo: DFF, parent: DFP, model: 'component_dataframe' },
		{
			tipo: EXTP,
			parent: MID,
			model: 'component_portal',
			order_number: 6,
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [LEAF], source: 'section' }] },
							show: { ddo_map: [{ tipo: LEAF_TEXT, parent: 'self', section_tipo: LEAF }] },
						},
						{
							api_engine: EXT_ENGINE,
							type: 'main',
							sqo: { section_tipo: [{ value: [LEAF], source: 'section' }] },
							show: { ddo_map: [{ tipo: LEAF_TEXT, parent: 'self', section_tipo: LEAF }] },
						},
					],
				},
			},
		},
		{
			tipo: W_MID,
			parent: MID,
			model: 'component_autocomplete_hi',
			order_number: 5,
			properties: ownConfig(THES, [{ tipo: TERM, parent: 'self', section_tipo: THES }]),
		},
		{ tipo: LEAF, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{ tipo: LEAF_TEXT, parent: LEAF, model: 'component_input_text', order_number: 1 },
		{ tipo: LEAF_X, parent: LEAF, model: 'component_input_text', order_number: 2 },
		{
			tipo: DECL,
			parent: 'test1',
			model: 'section',
			relations: [{ tipo: 'test24' }],
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ source: 'self' }] },
							show: {
								ddo_map: [
									{ tipo: DREL, parent: 'self', section_tipo: 'self' },
									{ tipo: REL2, parent: DREL, section_tipo: MID },
									{ tipo: LEAF_X, parent: REL2, section_tipo: LEAF },
									{ tipo: REL4, parent: DREL, section_tipo: MID },
									{ tipo: LEAF_X, parent: REL4, section_tipo: LEAF },
								],
							},
						},
					],
				},
			},
		},
		{
			tipo: DREL,
			parent: DECL,
			model: 'component_portal',
			order_number: 1,
			properties: ownConfig(MID, [{ tipo: MID_TEXT, parent: 'self', section_tipo: MID }]),
		},
	],
	records: [
		{
			section_tipo: PEOPLE,
			section_id: 1,
			columns: {
				relation: {
					[TERM_REF]: locators(TERM_REF, THES, [1]),
					[REL1]: locators(REL1, MID, [1]),
					[REL1R]: locators(REL1R, MID, [1]),
					[PLAIN_P]: locators(PLAIN_P, THES, [1]),
					[REL3]: locators(REL3, MID, [1]),
					[TERM_REF_M]: locators(TERM_REF_M, MID, [1]),
					[REL5]: locators(REL5, THES, [1]),
					[REL7]: locators(REL7, THES, [1]),
				},
			},
		},
		{
			section_tipo: THES,
			section_id: 1,
			columns: {
				string: {
					[TERM]: textValue('term one'),
					[THES_NOTE]: textValue('zzsubp secret one'),
				},
				relation: {
					[THES_REL]: locators(THES_REL, LEAF, [1]),
					[THES_REL_X]: locators(THES_REL_X, LEAF, [1]),
					// The audit stamps every record carries (create_record.ts): the
					// (h) audit-column gate's subject.
					dd200: [
						{
							id: 1,
							type: 'dd151',
							section_id: 1,
							section_tipo: 'dd128',
							from_component_tipo: 'dd200',
						},
					],
				},
				date: {
					dd199: [{ id: 1, start: { year: 2020, month: 1, day: 2 }, lang: 'lg-nolan' }],
				},
			},
		},
		{
			section_tipo: THES,
			section_id: 2,
			columns: {
				string: { [TERM]: textValue('term two'), [THES_NOTE]: textValue('zzsubp secret two') },
				relation: { [THES_PARENT]: [parentLink(THES_PARENT, THES, 1)] },
			},
		},
		{
			section_tipo: THES2,
			section_id: 1,
			columns: {
				string: { [TERM2]: textValue('second one') },
				// THES/1's child in a section the profile holds nothing on and no
				// picker targets: pruned from a scoped children page.
				relation: { [THES_PARENT]: [parentLink(THES_PARENT, THES, 1)] },
			},
		},
		{
			section_tipo: OTHER,
			section_id: 1,
			columns: {
				string: {
					[OTHER_TEXT]: textValue('other one'),
					[OTHER_LABEL]: textValue('label one'),
					[OTHER_NOTE]: textValue('zzsubp secret one'),
					[OTHER_SECRET]: textValue('zzsubp hidden one'),
				},
				relation: { [LEAF_PARENT]: [parentLink(LEAF_PARENT, LEAF, 1)] },
			},
		},
		{
			section_tipo: OTHER,
			section_id: 2,
			columns: { string: { [OTHER_TEXT]: textValue('other two') } },
		},
		{
			section_tipo: MID,
			section_id: 1,
			columns: {
				string: { [MID_TEXT]: textValue('mid one') },
				relation: {
					[REL2]: locators(REL2, LEAF, [1, 2]),
					[REL4]: locators(REL4, LEAF, [1]),
					[DFP]: locators(DFP, LEAF, [1, 2]),
					// One frame, paired with DFP's FIRST item (id_key 1 → LEAF/1).
					[DFF]: [
						{
							id: 1,
							type: 'dd490',
							id_key: 1,
							section_tipo: LEAF,
							section_id: 2,
							from_component_tipo: DFF,
							main_component_tipo: DFP,
						},
					],
				},
			},
		},
		{
			section_tipo: LEAF,
			section_id: 1,
			columns: {
				string: { [LEAF_TEXT]: textValue('leaf one'), [LEAF_X]: textValue('zzsubp alpha') },
			},
		},
		{
			section_tipo: LEAF,
			section_id: 2,
			columns: {
				string: { [LEAF_TEXT]: textValue('leaf two'), [LEAF_X]: textValue('zzsubp beta') },
				relation: { [LEAF_PARENT]: [parentLink(LEAF_PARENT, LEAF, 1)] },
			},
		},
		{
			section_tipo: DECL,
			section_id: 1,
			columns: { relation: { [DREL]: locators(DREL, MID, [1]) } },
		},
	],
});

/** One dd774 grant row. */
const grant = (id: number, sectionTipo: string, tipo: string, value: number) => ({
	id,
	tipo,
	section_tipo: sectionTipo,
	value,
});

/**
 * The restricted profile: NOTHING on THES; 0 (no row) on MID.REL2 and
 * LEAF.LEAF_X; REL1R read-only.
 */
const GRANTS = [
	grant(1, PEOPLE, PEOPLE, 2),
	grant(2, PEOPLE, TERM_REF, 2),
	grant(3, PEOPLE, REL1, 2),
	grant(4, PEOPLE, REL1R, 1),
	grant(5, PEOPLE, PLAIN_P, 2),
	grant(6, PEOPLE, REL3, 2),
	grant(7, MID, MID, 1),
	grant(8, MID, MID_TEXT, 2),
	grant(13, MID, REL4, 2),
	grant(9, LEAF, LEAF, 1),
	grant(10, LEAF, LEAF_TEXT, 2),
	grant(11, DECL, DECL, 2),
	grant(12, DECL, DREL, 2),
	grant(14, PEOPLE, REL5, 2),
	grant(15, PEOPLE, TERM_REF_TREE, 2),
	grant(16, PEOPLE, TERM_REF_R, 1),
	grant(17, MID, DFP, 2),
	grant(18, PEOPLE, TERM_REF_C, 2),
	grant(19, PEOPLE, TERM_REF_F, 2),
	grant(20, PEOPLE, TERM_REF_V5, 2),
	grant(21, PEOPLE, TERM_REF_VT, 2),
	grant(22, MID, W_MID, 2),
	grant(23, PEOPLE, CALLER_RO, 1),
	grant(24, PEOPLE, CALLER_RW, 2),
	// A per-tipo COMPONENT grant on a section the profile holds 0 on (decision
	// (j)'s STEP-5-kept pair; the exclusive scoped filter).
	grant(25, THES2, TERM2, 1),
	grant(26, PEOPLE, TERM_REF_V5K, 2),
	grant(27, PEOPLE, TERM_REF_X2, 2),
	grant(28, OTHER, OTHER_SECRET, 1),
	grant(29, PEOPLE, CALLER_TREE, 2),
	grant(30, PEOPLE, REL6, 2),
	// A PROFILE grant of 2 on the consultation-only Activity section (the
	// ownWriteLevel cap's subject).
	grant(31, 'dd542', 'dd542', 2),
	grant(32, PEOPLE, REL7, 2),
];

const yesNo = (from: string, id: number) => ({
	id: 1,
	type: 'dd151',
	section_id: id,
	section_tipo: 'dd64',
	from_component_tipo: from,
});

async function insertRow(table: string, sectionTipo: string, sectionId: number, columns: object) {
	const entries = Object.entries(columns);
	const names = entries.map(([name]) => `"${name}"`).join(', ');
	const values = entries.map((_, index) => `$${index + 3}::text::jsonb`).join(', ');
	await sql.unsafe(
		`INSERT INTO "${table}" (section_tipo, section_id, ${names}) VALUES ($1, $2, ${values})`,
		[sectionTipo, sectionId, ...entries.map(([, value]) => encodeForJsonb(value))],
	);
}

function clearSecurityCaches() {
	clearPrincipalCache();
	clearUserProjectsCache();
	clearPermissionsCache();
}

async function sweepIdentity() {
	await assertTestDatabase('subdatum_permission_native sweep');
	await deleteMatrixRecord('matrix_users', 'dd128', USER_ID);
	await deleteMatrixRecord('matrix_profiles', 'dd234', PROFILE_ID);
	clearSecurityCaches();
}

let restricted: Principal;
let root: Principal;

beforeAll(async () => {
	await assertTestDatabase('subdatum_permission_native');
	await sweepIdentity();
	await ensureSituation(S);
	await insertRow('matrix_profiles', 'dd234', PROFILE_ID, {
		string: { dd237: [{ id: 1, lang: 'lg-eng', value: 'zzsubp profile' }] },
		misc: { dd774: GRANTS },
	});
	await insertRow('matrix_users', 'dd128', USER_ID, {
		string: { dd132: [{ id: 1, lang: LANG, value: `zzsubp_${USER_ID}` }] },
		relation: {
			dd131: [yesNo('dd131', 1)],
			dd244: [yesNo('dd244', 2)],
			dd515: [yesNo('dd515', 2)],
			dd1725: [
				{
					id: 1,
					type: 'dd151',
					section_id: PROFILE_ID,
					section_tipo: 'dd234',
					from_component_tipo: 'dd1725',
				},
			],
			dd170: [
				{
					id: 1,
					type: 'dd151',
					section_id: PROJECT_ID,
					section_tipo: 'dd153',
					from_component_tipo: 'dd170',
				},
			],
		},
	});
	clearSecurityCaches();
	restricted = await resolvePrincipal(USER_ID);
	root = await resolvePrincipal(-1);
}, 60000);

afterAll(async () => {
	await sweepIdentity();
	expect(await dropSituation(S)).toBe(0);
	// Every read / save above logs Activity rows naming the read's tipo (the
	// section, or the saved component) — dropSituation neither sweeps nor counts
	// them (test/helpers/activity_rows.ts), so sweep every scratch tipo and
	// assert none is left.
	const tipos = S.nodes.map((node) => node.tipo);
	for (const tipo of tipos) await sweepActivityRows(tipo);
	let activityResidue = 0;
	for (const tipo of tipos) activityResidue += await countActivityRows(tipo);
	expect(activityResidue).toBe(0);
});

interface Item {
	typo?: unknown;
	tipo?: unknown;
	section_tipo?: unknown;
	section_id?: unknown;
	entries?: unknown;
}

interface ContextEntry {
	tipo?: unknown;
	section_tipo?: unknown;
	permissions?: unknown;
	request_config?: { show?: { ddo_map?: { tipo: string }[] } | null }[];
}

interface Answer {
	ok: boolean;
	items: Item[];
	context: ContextEntry[];
	/** The section_ids of the `sections` envelope (a search's result rows). */
	rows: number[];
	errorCode: string | null;
}

/** A dispatch context for `principal` with a real session. */
function contextFor(principal: Principal) {
	const token = createSession(
		principal.userId,
		`zzsubp_${principal.userId}`,
		principal.userId === -1,
	);
	const session = getSession(token);
	return {
		requestId: 'subdatum-permission',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal,
	};
}

async function send(rqo: Record<string, unknown>, principal: Principal): Promise<Answer> {
	clearSecurityCaches();
	const body = (await dispatchRqo(structuredClone(rqo) as never, contextFor(principal) as never))
		.body as {
		ok?: boolean;
		data?: { data?: Item[]; context?: ContextEntry[] };
		error?: { code?: string };
	};
	const envelope = (body.data?.data ?? []).find((item) => item.typo === 'sections') as
		| { entries?: { section_id: number | string }[] }
		| undefined;
	return {
		ok: body.ok !== false,
		items: (body.data?.data ?? []).filter((item) => item.typo !== 'sections'),
		context: body.data?.context ?? [],
		rows: (envelope?.entries ?? []).map((entry) => Number(entry.section_id)).sort(),
		errorCode: body.error?.code ?? null,
	};
}

/** A section read of PEOPLE/1 (edit), with a client column map or the section's own. */
function readPeople(ddoMap: Record<string, unknown>[] | null, principal: Principal) {
	const rqo: Record<string, unknown> = {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		options: {},
		source: {
			typo: 'source',
			model: 'section',
			tipo: PEOPLE,
			section_tipo: PEOPLE,
			action: 'search',
			mode: 'edit',
			lang: LANG,
			session_save: false,
		},
		sqo: {
			section_tipo: [PEOPLE],
			limit: 1,
			offset: 0,
			filter_by_locators: [{ section_tipo: PEOPLE, section_id: '1' }],
		},
	};
	if (ddoMap !== null) rqo.show = { ddo_map: ddoMap };
	return send(rqo, principal);
}

/** A component get_data of `tipo` on `section`/1 (edit), optionally with a show / callers. */
function getData(
	tipo: string,
	section: string,
	target: string,
	principal: Principal,
	extra: { show?: Record<string, unknown>[]; callers?: unknown[] } = {},
) {
	const rqo: Record<string, unknown> = {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			typo: 'source',
			type: 'component',
			action: 'get_data',
			model: 'component_portal',
			tipo,
			section_tipo: section,
			section_id: 1,
			mode: 'edit',
			lang: LANG,
			...(extra.callers !== undefined ? { callers: extra.callers } : {}),
		},
		sqo: {
			section_tipo: [target],
			limit: 10,
			offset: 0,
			filter_by_locators: [{ section_tipo: section, section_id: 1 }],
		},
	};
	if (extra.show !== undefined) rqo.show = { ddo_map: extra.show };
	return send(rqo, principal);
}

const itemsOf = (answer: Answer, tipo: string, section: string): Item[] =>
	answer.items.filter((item) => item.tipo === tipo && item.section_tipo === section);

const entryOf = (answer: Answer, tipo: string, section: string): ContextEntry | undefined =>
	answer.context.find((entry) => entry.tipo === tipo && entry.section_tipo === section);

describe('the fixture is non-degenerate', () => {
	test('the restricted profile holds exactly the levels the cases rely on', async () => {
		clearSecurityCaches();
		expect(await getPermissions(restricted, THES, THES)).toBe(0);
		expect(await getPermissions(restricted, THES, TERM)).toBe(0);
		expect(await getPermissions(restricted, PEOPLE, TERM_REF)).toBe(2);
		expect(await getPermissions(restricted, PEOPLE, REL1)).toBe(2);
		expect(await getPermissions(restricted, PEOPLE, REL1R)).toBe(1);
		expect(await getPermissions(restricted, MID, REL2)).toBe(0);
		expect(await getPermissions(restricted, MID, MID_TEXT)).toBe(2);
		expect(await getPermissions(restricted, LEAF, LEAF_TEXT)).toBe(2);
		expect(await getPermissions(restricted, LEAF, LEAF_X)).toBe(0);
		expect(await getPermissions(restricted, PEOPLE, REL5)).toBe(2);
		expect(await getPermissions(restricted, PEOPLE, TERM_REF_TREE)).toBe(2);
		expect(await getPermissions(restricted, THES, THES_REL)).toBe(0);
	});
});

describe('a nested RELATION child in a section the user holds nothing on is emitted at level 1', () => {
	// REL5 (granted 2) → THES (no grant row at all) → THES_REL (portal, own 0,
	// section 0) → LEAF.LEAF_TEXT (own 2). PHP get_subdatum raises THES_REL to
	// read under its COMPONENT caller REL5 whatever THES's grant
	// (class.common.php:2564-2571), expands it, and caps its child at read.
	const check = (answer: Answer) => {
		expect(answer.errorCode).toBeNull();
		const relItems = itemsOf(answer, THES_REL, THES);
		expect(relItems.length).toBeGreaterThan(0);
		expect(JSON.stringify(relItems.map((item) => item.entries))).toContain(
			`"section_tipo":"${LEAF}"`,
		);
		expect(entryOf(answer, THES_REL, THES)?.permissions).toBe(1);
		const leafItems = itemsOf(answer, LEAF_TEXT, LEAF);
		expect(
			leafItems.some(
				(item) => JSON.stringify(item.entries) === JSON.stringify(textValue('leaf one')),
			),
		).toBe(true);
		expect(entryOf(answer, LEAF_TEXT, LEAF)?.permissions).toBe(1);
	};

	test('the section door (REL5 a column of PEOPLE)', async () => {
		check(await readPeople([{ tipo: REL5, parent: 'self', section_tipo: 'self' }], restricted));
	});

	// No get_data-door twin: a get_data of REL5 names THES in its sqo, and the
	// read door's per-sqo-target gate refuses a section the user holds < 1 on
	// (Gate B, PHP-identical class.dd_core_api.php:2131-2153). Decision (h)
	// opens only a SEARCH (the autocomplete) through a writer chain, never a
	// get_data page of the target (pinned in the (h) describe).
});

/** A save that inserts THES/`termId` into `tipo` on PEOPLE/1. */
const saveTerm = (tipo: string, termId: number) => ({
	action: 'save',
	dd_api: 'dd_core_api',
	prevent_lock: true,
	source: {
		typo: 'source',
		type: 'component',
		model: 'component_autocomplete_hi',
		tipo,
		section_tipo: PEOPLE,
		section_id: '1',
		mode: 'edit',
		lang: LANG,
		action: null,
	},
	data: {
		section_id: '1',
		section_tipo: PEOPLE,
		tipo,
		lang: LANG,
		from_component_tipo: tipo,
		changed_data: [
			{ action: 'insert', id: null, value: { section_tipo: THES, section_id: String(termId) } },
		],
	},
});

/** The stored [section_tipo, section_id] locators of `tipo` on PEOPLE/1. */
async function storedLocators(tipo: string): Promise<[string, number][]> {
	const { getMatrixTableFromTipo } = await import('../../src/core/ontology/resolver.ts');
	const table = await getMatrixTableFromTipo(PEOPLE);
	const rows = (await sql.unsafe(
		`SELECT relation->$1 AS value FROM "${table}" WHERE section_tipo = $2 AND section_id = 1`,
		[tipo, PEOPLE],
	)) as { value: { section_tipo: string; section_id: unknown }[] | null }[];
	return (rows[0]?.value ?? []).map((locator) => [
		locator.section_tipo,
		Number(locator.section_id),
	]);
}

// Scope: case (i) for a NON-TREE component (TERM_REF declares no `view`); its
// TREE-PICKER twin is accepted alike (owner decision (i), the describe below).
describe('(i) the thesaurus case (non-tree component): a term the user holds no grant on is read and set', () => {
	test('the section read serves the term at read level (data + context)', async () => {
		const answer = await readPeople(
			[{ tipo: TERM_REF, parent: 'self', section_tipo: 'self' }],
			restricted,
		);
		expect(answer.errorCode).toBeNull();
		const terms = itemsOf(answer, TERM, THES);
		expect(terms.length).toBeGreaterThan(0);
		expect(terms[0]?.entries).toEqual(textValue('term one'));
		expect(entryOf(answer, TERM, THES)?.permissions).toBe(1);
		expect(entryOf(answer, TERM_REF, PEOPLE)?.permissions).toBe(2);
	});

	// The SAVE half only: a locator whose id is already known is accepted by the
	// save door (TERM_REF is granted 2). It does NOT claim the UI path — see the
	// next test: the autocomplete search a user picks the term with is refused.
	test('the save door ACCEPTS a known term locator into the component (save half only)', async () => {
		const saved = await send(saveTerm(TERM_REF, 2), restricted);
		expect(saved.errorCode).toBeNull();
		expect(saved.ok).toBe(true);
		expect(await storedLocators(TERM_REF)).toContainEqual([THES, 2]);
		// And the newly set term reads back at read level.
		const answer = await readPeople(
			[{ tipo: TERM_REF, parent: 'self', section_tipo: 'self' }],
			restricted,
		);
		expect(
			itemsOf(answer, TERM, THES).some(
				(item) => JSON.stringify(item.entries) === JSON.stringify(textValue('term two')),
			),
		).toBe(true);
	});
});

describe('(i) DECIDED: the TREE-PICKER variant is accepted at save (the TS-only gate retired)', () => {
	// Owner decision (i), 2026-11-03 — a DIVERGENCE FROM THE TS PAST, back to
	// PHP: the save door's tree-picker gate (relations/save.ts
	// refuseUnreadableTreePickerTarget, WC-2026-08-14 addendum 2026-08-16 item
	// 1, `target_not_readable`) is REMOVED together with the area/read.ts tree
	// prune. TERM_REF_TREE is TERM_REF with `properties.view: 'tree'`, the shape
	// every real thesaurus picker declares; the restricted profile writes it
	// (granted 2) and holds nothing on THES. Frozen PHP has no save-time read
	// gate on a relation target (class.component_portal.php:211-219), so this
	// write is accepted, exactly like the non-tree TERM_REF above. The READ side
	// (browsing the tree to pick) is opened only through the writer's verified
	// chain — the '(i) the tree picker reads' describe below.
	// (WC-2026-11-04-tree-picker-read-gate-retired, superseding the 2026-08-16
	// addendum item 1.)
	test('a known term locator into the TREE twin is ACCEPTED for the restricted profile', async () => {
		const saved = await send(saveTerm(TERM_REF_TREE, 2), restricted);
		expect(saved.errorCode).toBeNull();
		expect(saved.ok).toBe(true);
		expect(await storedLocators(TERM_REF_TREE)).toContainEqual([THES, 2]);
	});

	test('control: the read-only twin (TERM_REF_R, granted 1) is still refused — the write grant, not the target', async () => {
		const refused = await send(saveTerm(TERM_REF_R, 2), restricted);
		expect(refused.errorCode).toBe('perm.denied');
		expect(await storedLocators(TERM_REF_R)).not.toContainEqual([THES, 2]);
	});
});

/**
 * An autocomplete search of `sections` from `source` @ PEOPLE (filter on
 * THES.TERM), optionally naming the caller chain and a client column map.
 */
const pickSearch = (
	source: string,
	q: string,
	extra: {
		callers?: unknown[];
		sections?: string[];
		show?: Record<string, unknown>[];
		/** The source component's section (default PEOPLE). */
		sourceSection?: string;
		/** The filtered component (default THES.TERM). */
		filterTipo?: string;
	} = {},
) => {
	const rqo: Record<string, unknown> = {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			typo: 'source',
			tipo: source,
			section_tipo: extra.sourceSection ?? PEOPLE,
			action: 'search',
			model: 'component_autocomplete_hi',
			mode: 'search',
			lang: LANG,
			...(extra.callers !== undefined ? { callers: extra.callers } : {}),
		},
		sqo: {
			section_tipo: extra.sections ?? [THES],
			limit: 10,
			offset: 0,
			filter: {
				$and: [
					{
						q,
						path: [
							{
								section_tipo: (extra.sections ?? [THES])[0],
								component_tipo: extra.filterTipo ?? TERM,
							},
						],
					},
				],
			},
		},
	};
	if (extra.show !== undefined) rqo.show = { ddo_map: extra.show };
	return rqo;
};

/** The section-root chain the client sends for a TOP-LEVEL component's search (common.js create_search_callers). */
const PEOPLE_ROOT = [{ tipo: PEOPLE, section_tipo: PEOPLE, mode: 'edit' }];

describe('(h) DECIDED: the autocomplete search a WRITER picks a term with, through its verified chain', () => {
	// Owner decision (h), 2026-11-03 — a DIVERGENCE FROM PHP
	// (WC-2026-11-04-writer-chain-scoped-search). PHP
	// raises a component's children to read so the user "will be able to search
	// with autocomplete, to assign data" (class.common.php:2556-2563) yet its
	// read door refuses every sqo section the user holds < 1 on
	// (class.dd_core_api.php:2131-2153). TS admits that search for EXACTLY ONE
	// use (security/writer_chain_scope.ts): the request names the component's
	// caller chain, the chain VERIFIES, the component holds WRITE (>= 2) through
	// it, and its effective config targets every ungranted sqo section. The rows
	// carry only the columns that config shows / searches, stamped read (1).
	// Anything else answers exactly the pre-(h) Gate B refusal.
	const show = [
		{ tipo: TERM, parent: TERM_REF, section_tipo: THES },
		// Named by the client, NOT in TERM_REF's config: never served.
		{ tipo: THES_REL, parent: TERM_REF, section_tipo: THES },
	];

	test('writer + verified chain: the search FINDS (hit vs miss) and serves only the config columns at read', async () => {
		const hit = await send(
			pickSearch(TERM_REF, 'term one*', { callers: PEOPLE_ROOT, show }),
			restricted,
		);
		const miss = await send(
			pickSearch(TERM_REF, 'term onx*', { callers: PEOPLE_ROOT }),
			restricted,
		);
		expect(hit.errorCode).toBeNull();
		expect(miss.errorCode).toBeNull();
		expect(hit.rows).toEqual([1]);
		expect(miss.rows).toEqual([]);
		const terms = itemsOf(hit, TERM, THES);
		expect(terms.length).toBeGreaterThan(0);
		expect(terms[0]?.entries).toEqual(textValue('term one'));
		expect(entryOf(hit, TERM, THES)?.permissions).toBe(1);
		expect(itemsOf(hit, THES_REL, THES)).toHaveLength(0);
		expect(entryOf(hit, THES_REL, THES)).toBeUndefined();
	});

	test('the TREE twin (also a writer) searches alike through the same chain', async () => {
		const answer = await send(
			pickSearch(TERM_REF_TREE, 'term*', { callers: PEOPLE_ROOT }),
			restricted,
		);
		expect(answer.errorCode).toBeNull();
		expect(answer.rows).toEqual([1, 2]);
	});

	test('NO chain: perm.denied (Gate B, PHP-identical)', async () => {
		const answer = await send(pickSearch(TERM_REF, 'term*'), restricted);
		expect(answer.errorCode).toBe('perm.denied');
		expect(answer.rows).toEqual([]);
	});

	test('a READ-ONLY caller (TERM_REF_R, granted 1) under a verified chain: perm.denied', async () => {
		const answer = await send(
			pickSearch(TERM_REF_R, 'term*', { callers: PEOPLE_ROOT }),
			restricted,
		);
		expect(answer.errorCode).toBe('perm.denied');
	});

	for (const [label, callers] of [
		[
			'a FORGED root that does not declare TERM_REF',
			[{ tipo: REL3, section_tipo: PEOPLE, mode: 'edit' }],
		],
		['a section root of ANOTHER section', [{ tipo: MID, section_tipo: MID, mode: 'edit' }]],
		['a malformed chain (no root mode)', [{ tipo: PEOPLE, section_tipo: PEOPLE }]],
	] as const) {
		test(`${label}: perm.denied`, async () => {
			const answer = await send(
				pickSearch(TERM_REF, 'term*', { callers: callers as unknown as unknown[] }),
				restricted,
			);
			expect(answer.errorCode).toBe('perm.denied');
		});
	}

	test('a NON-TARGET ungranted sqo section beside the target (THES + OTHER): perm.denied', async () => {
		const answer = await send(
			pickSearch(TERM_REF, 'term*', { callers: PEOPLE_ROOT, sections: [THES, OTHER] }),
			restricted,
		);
		expect(answer.errorCode).toBe('perm.denied');
	});

	test('a get_data (not a search) of THES from TERM_REF stays refused, chain or not', async () => {
		const answer = await getData(TERM_REF, PEOPLE, THES, restricted, { callers: PEOPLE_ROOT });
		expect(answer.errorCode).toBe('perm.denied');
	});

	test('the COUNT door agrees with the read door (same scope, same total; no chain → refused)', async () => {
		const countOf = async (q: string, callers?: unknown[]) => {
			clearSecurityCaches();
			const rqo = pickSearch(TERM_REF, q, callers !== undefined ? { callers } : {});
			rqo.action = 'count';
			const body = (await dispatchRqo(rqo as never, contextFor(restricted) as never)).body as {
				data?: { total?: unknown };
				error?: { code?: string };
			};
			return { total: body.data?.total ?? null, errorCode: body.error?.code ?? null };
		};
		const read = await send(pickSearch(TERM_REF, 'term*', { callers: PEOPLE_ROOT }), restricted);
		const counted = await countOf('term*', PEOPLE_ROOT);
		expect(counted.errorCode).toBeNull();
		expect(counted.total).toBe(read.rows.length);
		expect(counted.total).toBe(2);
		expect((await countOf('term onx*', PEOPLE_ROOT)).total).toBe(0);
		expect((await countOf('term*')).errorCode).toBe('perm.denied');
	});
});

/** A count of `rqo` for the restricted profile (the generic count door). */
async function countFor(rqo: Record<string, unknown>) {
	clearSecurityCaches();
	const counted = structuredClone(rqo);
	counted.action = 'count';
	const body = (await dispatchRqo(counted as never, contextFor(restricted) as never)).body as {
		data?: { total?: unknown };
		error?: { code?: string };
	};
	return { total: body.data?.total ?? null, errorCode: body.error?.code ?? null };
}

describe('(h) the scope limits COLUMNS and FILTER PATHS to the config, at every section a row comes from', () => {
	// W4b review fixes. A scoped search opens THES ONLY for what the writer's
	// effective config shows (show + search + choose — the autocomplete renders
	// choose first) and may filter it ONLY by those pairs plus the config's
	// declared filter paths. Each case below was served before the fix.

	test('a client column DECLARING a rule-granted section (dd1324 / dd655) on a THES component is not served', async () => {
		// A row emits every direct ddo from its OWN record whatever section the
		// ddo declares; dd1324 / dd655 answer READ / EDIT by rule for any tipo.
		const answer = await send(
			pickSearch(TERM_REF, 'term one*', {
				callers: PEOPLE_ROOT,
				show: [
					{ tipo: TERM, parent: TERM_REF, section_tipo: THES },
					{ tipo: THES_NOTE, parent: TERM_REF, section_tipo: 'dd1324' },
					{ tipo: THES_NOTE, parent: TERM_REF, section_tipo: 'dd655' },
				],
			}),
			restricted,
		);
		expect(answer.errorCode).toBeNull();
		expect(answer.rows).toEqual([1]);
		expect(itemsOf(answer, TERM, THES).length).toBeGreaterThan(0);
		expect(answer.items.filter((item) => item.tipo === THES_NOTE)).toHaveLength(0);
		expect(JSON.stringify(answer.items)).not.toContain('zzsubp secret one');
	});

	// W4b review (round 2): the row gate refused a foreign-declared ddo only when
	// its tipo BELONGS to the scoped section — but the audit / section-info
	// tipos (dd199 created date, dd200 creator, dd197 / dd201 modified pair)
	// belong to no target section and EVERY record stores them by tipo, so a
	// dd1324-declared column served each ungranted THES record's creator and
	// dates. The column side now agrees with the filter side's own rule
	// (frontier_scope.ts exclusiveFloorVerdict): never on a scoped section
	// unless the writer config shows them.
	test('a client column DECLARING dd1324 on the AUDIT tipos (dd199 / dd200 / dd197 / dd201) emits nothing on a scoped row', async () => {
		const auditTipos = ['dd199', 'dd200', 'dd197', 'dd201'];
		// Floor: the THES records DO carry the audit values (else the gate is vacuous).
		const stored = (await sql`
			SELECT count(*)::int AS n FROM matrix_hierarchy
			WHERE section_tipo = ${THES} AND section_id = 1
			  AND date ? 'dd199' AND relation ? 'dd200'
		`) as { n: number }[];
		expect(stored[0]?.n).toBe(1);
		const rqo = pickSearch(TERM_REF, 'term one*', {
			callers: PEOPLE_ROOT,
			show: [
				{ tipo: TERM, parent: TERM_REF, section_tipo: THES },
				...auditTipos.map((tipo) => ({ tipo, parent: TERM_REF, section_tipo: 'dd1324' })),
			],
		});
		const answer = await send(rqo, restricted);
		expect(answer.errorCode).toBeNull();
		expect(answer.rows).toEqual([1]);
		expect(itemsOf(answer, TERM, THES).length).toBeGreaterThan(0);
		const isAudit = (item: Item) => auditTipos.includes(String(item.tipo));
		expect(answer.items.filter(isAudit)).toHaveLength(0);
		// Control: root (no scope) is served the same audit columns.
		const rootAnswer = await send(rqo, root);
		expect(rootAnswer.items.filter(isAudit).length).toBeGreaterThan(0);
	});

	// W4b review (blocker): a scoped search's stage 1 runs with no actor, so the
	// strict drop that judges EVERY section a ddo declares did not run; the
	// post gate judged a nested client child on its FIRST section only. REL5
	// (a writer, granted 2) shows THES_REL on THES, whose THES/1 locator points
	// at LEAF/1. A nested child declaring ['dd1324', LEAF] on LEAF_X (the
	// profile holds 0 on it) passed on dd1324's rule grant and served LEAF/1's
	// LEAF_X under the scoped relation column. Now each declared section is
	// judged and the ddo narrowed (section/read.ts scopedDeclaredSections).
	test('a NESTED multi-section client child under a scoped relation column is judged at EVERY section it declares', async () => {
		const nestedSearch = (leafTipo: string) =>
			pickSearch(REL5, 'term one*', {
				callers: PEOPLE_ROOT,
				show: [
					{ tipo: TERM, parent: REL5, section_tipo: THES },
					{ tipo: THES_REL, parent: REL5, section_tipo: THES },
					{ tipo: leafTipo, parent: THES_REL, section_tipo: ['dd1324', LEAF] },
				],
			});
		// Control (non-vacuity): a nested child the profile CAN read (LEAF_TEXT,
		// own 2) declared the same way IS served under the scoped column.
		const control = await send(nestedSearch(LEAF_TEXT), restricted);
		expect(control.errorCode).toBeNull();
		expect(control.rows).toEqual([1]);
		expect(JSON.stringify(control.items)).toContain('leaf one');
		// The level-0 LEAF_X behind the rule-granted dd1324: never served.
		const answer = await send(nestedSearch(LEAF_X), restricted);
		expect(answer.errorCode).toBeNull();
		expect(answer.rows).toEqual([1]);
		expect(itemsOf(answer, THES_REL, THES).length).toBeGreaterThan(0);
		expect(itemsOf(answer, LEAF_X, LEAF)).toHaveLength(0);
		expect(JSON.stringify(answer.items)).not.toContain('zzsubp alpha');
	});

	// Review 2026-11-04 (S2): a scoped relation column with NO client child
	// falls back to its OWN config, whose children were raised to read (PHP
	// :2564-2571) — so a third section the scope never opened (LEAF.LEAF_X,
	// own 0) was served on every scoped THES row. A scoped read now expands
	// relation elements one level only (resolve/component_data.ts
	// EmissionContext.callerChildrenOnly) and bounds the raise to the writer
	// config's pairs (section/node_permissions.ts NodeLevelPolicy.raises).
	test('a scoped relation column OWN-config child on an ungranted third section is NOT served', async () => {
		// Control (PHP parity outside the scope): the same chain through the
		// section door raises LEAF_X to read under REL7 → THES_REL_X.
		const plain = await readPeople(
			[{ tipo: REL7, parent: 'self', section_tipo: 'self' }],
			restricted,
		);
		expect(plain.errorCode).toBeNull();
		expect(itemsOf(plain, LEAF_X, LEAF).length).toBeGreaterThan(0);
		expect(JSON.stringify(plain.items)).toContain('zzsubp alpha');
		const answer = await send(
			pickSearch(REL7, 'term one*', {
				callers: PEOPLE_ROOT,
				show: [
					{ tipo: TERM, parent: REL7, section_tipo: THES },
					{ tipo: THES_REL_X, parent: REL7, section_tipo: THES },
				],
			}),
			restricted,
		);
		expect(answer.errorCode).toBeNull();
		expect(answer.rows).toEqual([1]);
		// The config column itself is served (its locator) …
		expect(itemsOf(answer, THES_REL_X, THES).length).toBeGreaterThan(0);
		// … its own-config child on LEAF is not.
		expect(itemsOf(answer, LEAF_X, LEAF)).toHaveLength(0);
		expect(JSON.stringify(answer.items)).not.toContain('zzsubp alpha');
	});

	/** TERM_REF_C's autocomplete search of OTHER (default filter OTHER.OTHER_TEXT). */
	const otherSearch = (
		q: string,
		extra: { show?: Record<string, unknown>[]; filterTipo?: string } = {},
	) =>
		pickSearch(TERM_REF_C, q, {
			callers: PEOPLE_ROOT,
			sections: [OTHER],
			filterTipo: extra.filterTipo ?? OTHER_TEXT,
			...(extra.show !== undefined ? { show: extra.show } : {}),
		});

	test('control: the OTHER writer search finds by its SHOWN pair (hit 1, miss 0)', async () => {
		expect((await send(otherSearch('other one*'), restricted)).rows).toEqual([1]);
		expect((await send(otherSearch('other onx*'), restricted)).rows).toEqual([]);
	});

	test('the CHOOSE column is served at read; the HIDE-only column is not', async () => {
		const answer = await send(
			otherSearch('other one*', {
				show: [
					{ tipo: OTHER_LABEL, parent: TERM_REF_C, section_tipo: OTHER },
					{ tipo: OTHER_NOTE, parent: TERM_REF_C, section_tipo: OTHER },
				],
			}),
			restricted,
		);
		expect(answer.errorCode).toBeNull();
		expect(answer.rows).toEqual([1]);
		expect(itemsOf(answer, OTHER_LABEL, OTHER)[0]?.entries).toEqual(textValue('label one'));
		expect(entryOf(answer, OTHER_LABEL, OTHER)?.permissions).toBe(1);
		expect(itemsOf(answer, OTHER_NOTE, OTHER)).toHaveLength(0);
		expect(entryOf(answer, OTHER_NOTE, OTHER)).toBeUndefined();
	});

	test('a FILTER on the HIDE-only pair stays KEYED (hit = miss), read and count alike', async () => {
		const filtered = (q: string) => otherSearch(q, { filterTipo: OTHER_NOTE });
		const hit = await send(filtered('zzsubp secret*'), restricted);
		const miss = await send(filtered('zzsubp nomatch*'), restricted);
		expect(hit.errorCode).toBeNull();
		expect(hit.rows).toEqual(miss.rows);
		const hitCount = await countFor(filtered('zzsubp secret*'));
		const missCount = await countFor(filtered('zzsubp nomatch*'));
		expect(hitCount.errorCode).toBeNull();
		expect(hitCount.total).toBe(missCount.total);
		expect(hitCount.total).toBe(hit.rows.length);
	});

	test('control: a FILTER on the CHOOSE pair finds (hit 1, miss 0), read and count alike', async () => {
		const filtered = (q: string) => otherSearch(q, { filterTipo: OTHER_LABEL });
		expect((await send(filtered('label one*'), restricted)).rows).toEqual([1]);
		expect((await send(filtered('label onx*'), restricted)).rows).toEqual([]);
		expect((await countFor(filtered('label one*'))).total).toBe(1);
		expect((await countFor(filtered('label onx*'))).total).toBe(0);
	});

	// The scope's filter pairs are EXCLUSIVE on the sections it opened
	// (security/frontier_scope.ts exclusiveFloorVerdict): a per-tipo COMPONENT
	// grant the profile happens to hold there (OTHER_SECRET, level 1, section 0)
	// is NOT a filter path — before the fix the SEC-1 key fell back to it and
	// the scoped rows could be filtered by a component outside the config.
	test('a FILTER on a component the profile holds a per-tipo grant on, outside the config, stays KEYED (read and count)', async () => {
		clearSecurityCaches();
		expect(await getPermissions(restricted, OTHER, OTHER)).toBe(0);
		expect(await getPermissions(restricted, OTHER, OTHER_SECRET)).toBe(1);
		const filtered = (q: string) => otherSearch(q, { filterTipo: OTHER_SECRET });
		const hit = await send(filtered('zzsubp hidden*'), restricted);
		const miss = await send(filtered('zzsubp nomatch*'), restricted);
		expect(hit.errorCode).toBeNull();
		expect(hit.rows).toEqual(miss.rows);
		const hitCount = await countFor(filtered('zzsubp hidden*'));
		const missCount = await countFor(filtered('zzsubp nomatch*'));
		expect(hitCount.errorCode).toBeNull();
		expect(hitCount.total).toBe(missCount.total);
	});

	// The same exclusivity on a GLOBALLY VISIBLE thesaurus table (THES is
	// matrix_hierarchy, whose components the frontier admits for anyone): the
	// THES_NOTE literal TERM_REF's config does not name is no filter path of
	// the scoped search either.
	test('a FILTER on a THES literal outside the config stays KEYED although its table is globally visible', async () => {
		const filtered = (q: string) =>
			pickSearch(TERM_REF, q, { callers: PEOPLE_ROOT, filterTipo: THES_NOTE });
		const hit = await send(filtered('zzsubp secret*'), restricted);
		const miss = await send(filtered('zzsubp nomatch*'), restricted);
		expect(hit.errorCode).toBeNull();
		expect(hit.rows).toEqual(miss.rows);
		expect((await countFor(filtered('zzsubp secret*'))).total).toBe(
			(await countFor(filtered('zzsubp nomatch*'))).total,
		);
	});

	test('a declared fixed_filter path is a FILTER pair, never a COLUMN pair', async () => {
		const { resolveWriterChainScope } = await import(
			'../../src/core/security/writer_chain_scope.ts'
		);
		clearSecurityCaches();
		await runWithRequestContext(
			{ principal: restricted, session: null, requestId: 'zzsubp-fixed', clientIp: '127.0.0.1' },
			async () => {
				const scope = await resolveWriterChainScope(restricted, {
					tipo: TERM_REF_F,
					sectionTipo: PEOPLE,
					callers: PEOPLE_ROOT,
					lang: LANG,
				});
				expect(scope).not.toBeNull();
				expect(scope?.filterPairs.has(`${THES}_${THES_NOTE}`)).toBe(true);
				expect(scope?.columnPairs.has(`${THES}_${THES_NOTE}`)).toBe(false);
				expect(scope?.columnPairs.has(`${THES}_${TERM}`)).toBe(true);
			},
		);
	});
});

describe('(h)/(i) the scope never widens: exact targets, chained caps, v5 configs (decision (j))', () => {
	const nodeRead = (section: string, caller: unknown) => ({
		action: 'get_node_data',
		dd_api: 'dd_ts_api',
		prevent_lock: true,
		source: { section_tipo: section, section_id: 1, caller },
		options: {},
	});
	const nodeAnswer = async (rqo: Record<string, unknown>) => {
		clearSecurityCaches();
		const body = (await dispatchRqo(rqo as never, contextFor(restricted) as never)).body as {
			error?: { code?: string };
		};
		return body.error?.code ?? null;
	};

	test('a config targeting THES does not open its VIRTUAL VTHES (search and tree)', async () => {
		const answer = await send(
			pickSearch(TERM_REF, 'term*', { callers: PEOPLE_ROOT, sections: [VTHES] }),
			restricted,
		);
		expect(answer.errorCode).toBe('perm.denied');
		expect(
			await nodeAnswer(
				nodeRead(VTHES, {
					tipo: TERM_REF_TREE,
					section_tipo: PEOPLE,
					section_id: 1,
					callers: PEOPLE_ROOT,
				}),
			),
		).toBe('perm.denied');
	});

	test('a config targeting the virtual VTHES does not open its REAL THES; VTHES itself is scoped', async () => {
		const answer = await send(
			pickSearch(TERM_REF_VT, 'term*', { callers: PEOPLE_ROOT, sections: [THES] }),
			restricted,
		);
		expect(answer.errorCode).toBe('perm.denied');
		const { resolveTargetSearchScope } = await import(
			'../../src/core/security/writer_chain_scope.ts'
		);
		clearSecurityCaches();
		await runWithRequestContext(
			{ principal: restricted, session: null, requestId: 'zzsubp-exact', clientIp: '127.0.0.1' },
			async () => {
				const request = (ungranted: string[]) =>
					resolveTargetSearchScope(restricted, {
						source: {
							tipo: TERM_REF_VT,
							section_tipo: PEOPLE,
							action: 'search',
							callers: PEOPLE_ROOT,
						},
						sqoMode: undefined,
						ungranted,
						lang: LANG,
					});
				expect(await request([VTHES])).not.toBeNull();
				expect(await request([THES])).toBeNull();
			},
		);
	});

	test('a WRITER (own 2) under a READ-ONLY component caller (1) is capped: perm.denied; under a writer caller: found', async () => {
		const search = (caller: string, q: string) =>
			pickSearch(W_MID, q, {
				sourceSection: MID,
				callers: [{ tipo: caller, section_tipo: PEOPLE, mode: 'edit' }],
			});
		expect((await send(search(CALLER_RO, 'term*'), restricted)).errorCode).toBe('perm.denied');
		expect((await countFor(search(CALLER_RO, 'term*'))).errorCode).toBe('perm.denied');
		const found = await send(search(CALLER_RW, 'term one*'), restricted);
		expect(found.errorCode).toBeNull();
		expect(found.rows).toEqual([1]);
	});

	// W4b review: a RULE-READ chain root (here the public-list rule) was seeded
	// at 0, so inheritSubdatumPermission's read-only cap (it fires on a caller
	// at exactly 1) never ran and the profile-2 W_MID under it counted as a
	// WRITER. PHP caps it at the root's level 1 (class.common.php:2569-2571).
	test('a WRITER (own 2) under a RULE-READ root (public list, no profile grant) is capped: perm.denied', async () => {
		clearSecurityCaches();
		const rootGrant = await getPermissionGrant(restricted, PUBLIC, CALLER_PUB);
		expect(rootGrant).toEqual({ level: 1, basis: 'rule' });
		const rqo = pickSearch(W_MID, 'term*', {
			sourceSection: MID,
			callers: [{ tipo: CALLER_PUB, section_tipo: PUBLIC, mode: 'edit' }],
		});
		expect((await send(rqo, restricted)).errorCode).toBe('perm.denied');
		expect((await countFor(rqo)).errorCode).toBe('perm.denied');
		// The chain itself VERIFIES (the root is readable) — the cap, not the
		// chain, is what refuses.
		const { resolveCallerChain } = await import('../../src/core/relations/caller_chain.ts');
		clearSecurityCaches();
		const chain = await runWithRequestContext(
			{
				principal: restricted,
				session: null,
				requestId: 'zzsubp-rule-root',
				clientIp: '127.0.0.1',
			},
			() =>
				resolveCallerChain({
					callers: [{ tipo: CALLER_PUB, section_tipo: PUBLIC, mode: 'edit' }],
					targetTipo: W_MID,
					targetSectionTipo: MID,
					lang: LANG,
					principal: restricted,
				}),
		);
		expect(chain).not.toBeNull();
	});

	test('decision (j): a CONFIG-LESS (v5) tree writer opens nothing — no scope, search / count / tree refused', async () => {
		const { resolveWriterChainScope } = await import(
			'../../src/core/security/writer_chain_scope.ts'
		);
		clearSecurityCaches();
		await runWithRequestContext(
			{ principal: restricted, session: null, requestId: 'zzsubp-v5', clientIp: '127.0.0.1' },
			async () => {
				expect(
					await resolveWriterChainScope(restricted, {
						tipo: TERM_REF_V5,
						sectionTipo: PEOPLE,
						callers: PEOPLE_ROOT,
						lang: LANG,
					}),
				).toBeNull();
			},
		);
		const rqo = pickSearch(TERM_REF_V5, 'term*', { callers: PEOPLE_ROOT });
		expect((await send(rqo, restricted)).errorCode).toBe('perm.denied');
		expect((await countFor(rqo)).errorCode).toBe('perm.denied');
		expect(
			await nodeAnswer(
				nodeRead(THES, {
					tipo: TERM_REF_V5,
					section_tipo: PEOPLE,
					section_id: 1,
					callers: PEOPLE_ROOT,
				}),
			),
		).toBe('perm.denied');
	});
});

describe('decision (j) and the write-authority caps, discriminating', () => {
	const asRestricted = <T>(requestId: string, run: () => Promise<T>) => {
		clearSecurityCaches();
		return runWithRequestContext(
			{ principal: restricted, session: null, requestId, clientIp: '127.0.0.1' },
			run,
		);
	};
	const nodeRead = (section: string, caller: unknown) => ({
		action: 'get_node_data',
		dd_api: 'dd_ts_api',
		prevent_lock: true,
		source: { section_tipo: section, section_id: 1, caller },
		options: {},
	});
	const nodeError = async (rqo: Record<string, unknown>) => {
		clearSecurityCaches();
		const body = (await dispatchRqo(rqo as never, contextFor(restricted) as never)).body as {
			error?: { code?: string };
		};
		return body.error?.code ?? null;
	};
	const v5Search = (tipo: string, q: string) =>
		pickSearch(tipo, q, { callers: PEOPLE_ROOT, sections: [THES2], filterTipo: TERM2 });
	const pickerOf = (tipo: string) => ({
		tipo,
		section_tipo: PEOPLE,
		section_id: 1,
		callers: PEOPLE_ROOT,
	});

	// Non-vacuity: STEP 5 KEEPS the THES2.TERM2 pair for this profile (a
	// per-tipo grant), the chain VERIFIES, and the explicit twin opens the scope
	// — so only the (j) rule itself can close the v5 component.
	test('the fixture floor: the v5 config keeps a pair on the ungranted target and its chain verifies', async () => {
		const { resolveCallerChain } = await import('../../src/core/relations/caller_chain.ts');
		const { resolveElement } = await import('../../src/core/relations/element_node.ts');
		const { ElementNodeRegistry } = await import('../../src/core/relations/element_registry.ts');
		const { slotPairsOf } = await import('../../src/core/security/read_floor.ts');
		await asRestricted('zzsubp-j-floor', async () => {
			expect(await getPermissions(restricted, THES2, THES2)).toBe(0);
			expect(await getPermissions(restricted, THES2, TERM2)).toBe(1);
			const chain = await resolveCallerChain({
				callers: PEOPLE_ROOT,
				targetTipo: TERM_REF_V5K,
				targetSectionTipo: PEOPLE,
				lang: LANG,
				principal: restricted,
			});
			expect(chain).not.toBeNull();
			const node = await resolveElement({
				ddo: chain?.line as never,
				parentNode: chain?.parentNode ?? null,
				ownerSectionTipo: PEOPLE,
				mode: 'edit',
				lang: LANG,
				registry: new ElementNodeRegistry(),
			});
			expect(slotPairsOf(node.effectiveConfig, ['show']).has(`${THES2}_${TERM2}`)).toBe(true);
		});
	});

	test('a v5 (implicit) writer whose kept pair lands on the ungranted target opens NOTHING: search / count / tree refused', async () => {
		const { resolveWriterChainScope } = await import(
			'../../src/core/security/writer_chain_scope.ts'
		);
		await asRestricted('zzsubp-j-v5', async () => {
			expect(
				await resolveWriterChainScope(restricted, {
					tipo: TERM_REF_V5K,
					sectionTipo: PEOPLE,
					callers: PEOPLE_ROOT,
					lang: LANG,
				}),
			).toBeNull();
		});
		expect((await send(v5Search(TERM_REF_V5K, 'second*'), restricted)).errorCode).toBe(
			'perm.denied',
		);
		expect((await countFor(v5Search(TERM_REF_V5K, 'second*'))).errorCode).toBe('perm.denied');
		expect(await nodeError(nodeRead(THES2, pickerOf(TERM_REF_V5K)))).toBe('perm.denied');
	});

	test('control: the EXPLICIT twin (same target, same pair) opens the scope — search finds, tree reads', async () => {
		const { resolveWriterChainScope } = await import(
			'../../src/core/security/writer_chain_scope.ts'
		);
		await asRestricted('zzsubp-j-x2', async () => {
			const scope = await resolveWriterChainScope(restricted, {
				tipo: TERM_REF_X2,
				sectionTipo: PEOPLE,
				callers: PEOPLE_ROOT,
				lang: LANG,
			});
			expect(scope?.targets).toEqual([THES2]);
		});
		const found = await send(v5Search(TERM_REF_X2, 'second*'), restricted);
		expect(found.errorCode).toBeNull();
		expect(found.rows).toEqual([1]);
		expect((await send(v5Search(TERM_REF_X2, 'secnd*'), restricted)).rows).toEqual([]);
		expect((await countFor(v5Search(TERM_REF_X2, 'second*'))).total).toBe(1);
		expect(await nodeError(nodeRead(THES2, pickerOf(TERM_REF_X2)))).toBeNull();
	});

	// The two caps ownWriteLevel applies to every chain link (module header of
	// writer_chain_scope.ts), each against the RAW grant it caps.
	// A rule counts READ (1), not 0 (W4b review): a rule-read chain ROOT must
	// still cap what it reaches (the PHP cap fires on a caller at exactly 1).
	test('a RULE-basis grant is not a write authority: the dd655 preset rule (2) counts read (1)', async () => {
		const { ownWriteLevel } = await import('../../src/core/security/writer_chain_scope.ts');
		await asRestricted('zzsubp-cap-rule', async () => {
			const link = { tipo: TERM_REF, section_tipo: 'dd655' };
			const raw = await getPermissionGrant(restricted, link.section_tipo, link.tipo);
			expect(raw.level).toBe(2);
			expect(raw.basis).toBe('rule');
			expect(await ownWriteLevel(restricted, link)).toBe(1);
			// Control: the same component under its own section, by profile.
			expect(await ownWriteLevel(restricted, { tipo: TERM_REF, section_tipo: PEOPLE })).toBe(2);
		});
	});

	test('a CONSULTATION-ONLY section (dd542) is capped at read although the profile grants 2', async () => {
		const { ownWriteLevel } = await import('../../src/core/security/writer_chain_scope.ts');
		await asRestricted('zzsubp-cap-consult', async () => {
			const link = { tipo: 'dd542', section_tipo: 'dd542' };
			const raw = await getPermissionGrant(restricted, link.section_tipo, link.tipo);
			expect(raw.level).toBe(2);
			expect(raw.basis).not.toBe('rule');
			expect(await ownWriteLevel(restricted, link)).toBe(1);
		});
	});
});

describe('(i) DECIDED: the tree picker reads the ungranted thesaurus ONLY through the writer chain', () => {
	// Owner decision (i): the tree node doors (ts_object/ts_api.ts
	// get_node_data / get_children_data) and the area_thesaurus hierarchy prune
	// (area/read.ts filterHierarchiesByGrant) admit a section the user holds no
	// grant on only for a GRANTED tree picker (view:'tree', relation family,
	// profile write) whose `callers` chain verifies and whose config targets it
	// (ts_object.js get_picker_caller sends `source.caller` on every node read).
	const pickerCaller = (tipo: string, callers?: unknown[]) => ({
		tipo,
		section_tipo: PEOPLE,
		section_id: 1,
		...(callers !== undefined ? { callers } : {}),
	});
	const nodeRead = (action: 'get_node_data' | 'get_children_data', caller?: unknown) => ({
		action,
		dd_api: 'dd_ts_api',
		prevent_lock: true,
		source: {
			section_tipo: THES,
			section_id: 1,
			...(action === 'get_children_data'
				? { children: [{ section_tipo: THES, section_id: 1 }] }
				: {}),
			...(caller !== undefined ? { caller } : {}),
		},
		options: {},
	});
	const answerOf = async (rqo: Record<string, unknown>) => {
		clearSecurityCaches();
		const body = (await dispatchRqo(structuredClone(rqo) as never, contextFor(restricted) as never))
			.body as { ok?: boolean; data?: unknown; error?: { code?: string } };
		return { ok: body.ok !== false, data: body.data ?? null, errorCode: body.error?.code ?? null };
	};

	for (const action of ['get_node_data', 'get_children_data'] as const) {
		test(`${action}: the writer's tree picker WITH its chain reads THES`, async () => {
			const answer = await answerOf(nodeRead(action, pickerCaller(TERM_REF_TREE, PEOPLE_ROOT)));
			expect(answer.errorCode).toBeNull();
			expect(answer.ok).toBe(true);
			// The node itself comes back (not an empty answer).
			expect(JSON.stringify(answer.data)).toContain(`"ts_id":"${THES}_1"`);
		});

		for (const [label, caller] of [
			['no caller', undefined],
			['the tree picker WITHOUT its chain', pickerCaller(TERM_REF_TREE)],
			[
				'a FORGED chain',
				pickerCaller(TERM_REF_TREE, [{ tipo: REL3, section_tipo: PEOPLE, mode: 'edit' }]),
			],
			['a NON-TREE writer (TERM_REF: no picker grant)', pickerCaller(TERM_REF, PEOPLE_ROOT)],
		] as const) {
			test(`${action}: ${label} → perm.denied`, async () => {
				const answer = await answerOf(nodeRead(action, caller));
				expect(answer.errorCode).toBe('perm.denied');
			});
		}
	}

	// EVERY node a door builds is gated by ITS section (ts_api.ts
	// requireTreeReadLevels), not only the section the request addresses: a
	// client children list naming THES under an omitted or granted
	// `section_tipo` was served before the fix.
	const childrenRead = (
		children: { section_tipo: string; section_id: number }[],
		extra: Record<string, unknown> = {},
	) => ({
		action: 'get_children_data',
		dd_api: 'dd_ts_api',
		prevent_lock: true,
		source: { children, ...extra },
		options: {},
	});
	const thesChild = [{ section_tipo: THES, section_id: 1 }];

	for (const [label, extra] of [
		['section_tipo OMITTED, no caller', {}],
		['a GRANTED section_tipo (PEOPLE/1), no caller', { section_tipo: PEOPLE, section_id: 1 }],
		[
			'section_tipo omitted, the tree picker WITHOUT its chain',
			{ caller: pickerCaller(TERM_REF_TREE) },
		],
	] as const) {
		test(`get_children_data, a children list naming THES — ${label} → perm.denied`, async () => {
			const answer = await answerOf(childrenRead(thesChild, extra));
			expect(answer.errorCode).toBe('perm.denied');
			expect(JSON.stringify(answer.data ?? null)).not.toContain('term one');
		});
	}

	test('control: the same children list under the writer chain (section_tipo omitted) is served', async () => {
		const answer = await answerOf(
			childrenRead(thesChild, { caller: pickerCaller(TERM_REF_TREE, PEOPLE_ROOT) }),
		);
		expect(answer.errorCode).toBeNull();
		expect(JSON.stringify(answer.data)).toContain(`"ts_id":"${THES}_1"`);
	});

	test('a children list naming a NON-TARGET section beside THES is refused even under the chain', async () => {
		const answer = await answerOf(
			childrenRead([...thesChild, { section_tipo: OTHER, section_id: 1 }], {
				section_tipo: THES,
				section_id: 1,
				caller: pickerCaller(TERM_REF_TREE, PEOPLE_ROOT),
			}),
		);
		expect(answer.errorCode).toBe('perm.denied');
	});

	// A well-shaped but INVALID caller earns no scope: the node door answers its
	// own perm.denied (area/read.ts pickerTreeScope), never the area boot read's
	// area.picker_caller_invalid.
	for (const [label, caller] of [
		['an UNKNOWN tipo', { tipo: 'zzsubp999', section_tipo: PEOPLE, section_id: 1 }],
		[
			'a relation tipo that is not a member of the declared section',
			{ tipo: THES_REL, section_tipo: PEOPLE, section_id: 1, callers: PEOPLE_ROOT },
		],
	] as const) {
		test(`get_node_data with ${label} as caller → perm.denied (not picker_caller_invalid)`, async () => {
			const answer = await answerOf(nodeRead('get_node_data', caller));
			expect(answer.errorCode).toBe('perm.denied');
		});
	}

	// A NESTED tree picker: W_MID's own properties declare no view; its
	// `view:'tree'` comes from CALLER_TREE's line. The view is read from the
	// VERIFIED chain's governing line (area/read.ts resolvePickerCaller).
	const nestedPicker = (caller: string) => ({
		tipo: W_MID,
		section_tipo: MID,
		section_id: 1,
		callers: [{ tipo: caller, section_tipo: PEOPLE, mode: 'edit' }],
	});
	for (const action of ['get_node_data', 'get_children_data'] as const) {
		test(`${action}: a NESTED tree picker (view from its verified caller's line) reads THES`, async () => {
			const answer = await answerOf(nodeRead(action, nestedPicker(CALLER_TREE)));
			expect(answer.errorCode).toBeNull();
			expect(JSON.stringify(answer.data)).toContain(`"ts_id":"${THES}_1"`);
		});

		test(`${action}: the same nested writer under a caller line WITHOUT view:'tree' → perm.denied`, async () => {
			const answer = await answerOf(nodeRead(action, nestedPicker(CALLER_RW)));
			expect(answer.errorCode).toBe('perm.denied');
		});
	}

	// W4b review (major): a node the profile reads ONLY through the picker's
	// scope carries what the writer component's config shows (TERM_REF_TREE:
	// TERM) plus the navigation entries (term, link_children) — never another
	// mapped THES element (ts_object.ts trimNodeToScopeColumns). A granted
	// reader (root) still gets the whole node.
	const elementTipos = (node: unknown): string[] =>
		(
			((node as { ar_elements?: { tipo: unknown }[] } | null)?.ar_elements ?? []) as {
				tipo: unknown;
			}[]
		).map((element) => String(element.tipo));
	test('get_node_data under the picker scope: THES_NOTE (outside the writer config) is absent; root sees it', async () => {
		const scoped = await answerOf(
			nodeRead('get_node_data', pickerCaller(TERM_REF_TREE, PEOPLE_ROOT)),
		);
		expect(scoped.errorCode).toBeNull();
		expect(elementTipos(scoped.data)).toContain(TERM);
		expect(elementTipos(scoped.data)).toContain(THES_CHILDREN);
		expect(elementTipos(scoped.data)).not.toContain(THES_NOTE);
		expect(JSON.stringify(scoped.data)).toContain('term one');
		expect(JSON.stringify(scoped.data)).not.toContain('zzsubp secret one');
		clearSecurityCaches();
		const granted = (
			(
				await dispatchRqo(
					structuredClone(nodeRead('get_node_data')) as never,
					contextFor(root) as never,
				)
			).body as { data?: unknown }
		).data;
		expect(elementTipos(granted)).toContain(THES_NOTE);
		expect(JSON.stringify(granted)).toContain('zzsubp secret one');
	});

	// Mode A (the children component's own page). THES/1's children: THES/2
	// (a scope target) and THES2/1 (no grant, not a target).
	const childrenPage = (section: string, childrenTipo: string, caller?: unknown) => ({
		action: 'get_children_data',
		dd_api: 'dd_ts_api',
		prevent_lock: true,
		source: {
			section_tipo: section,
			section_id: 1,
			children_tipo: childrenTipo,
			...(caller !== undefined ? { caller } : {}),
		},
		options: {},
	});
	const tsIdsOf = (data: unknown): string[] =>
		((data as { ar_children_data?: { ts_id: string }[] } | null)?.ar_children_data ?? []).map(
			(node) => node.ts_id,
		);

	test('mode A under the picker scope: an unreadable child is PRUNED (not a refusal), a scoped child is trimmed', async () => {
		const answer = await answerOf(
			childrenPage(THES, THES_CHILDREN, pickerCaller(TERM_REF_TREE, PEOPLE_ROOT)),
		);
		expect(answer.errorCode).toBeNull();
		expect(tsIdsOf(answer.data)).toEqual([`${THES}_2`]);
		expect(JSON.stringify(answer.data)).toContain('term two');
		expect(JSON.stringify(answer.data)).not.toContain('zzsubp secret two');
		expect(JSON.stringify(answer.data)).not.toContain('second one');
		// Control: root (granted everywhere) gets both children.
		clearSecurityCaches();
		const rooted = (
			(
				await dispatchRqo(
					structuredClone(childrenPage(THES, THES_CHILDREN)) as never,
					contextFor(root) as never,
				)
			).body as { data?: unknown }
		).data;
		expect(tsIdsOf(rooted).sort()).toEqual([`${THES}_2`, `${THES2}_1`].sort());
	});

	test('mode A without a caller on an ungranted parent → perm.denied', async () => {
		const answer = await answerOf(childrenPage(THES, THES_CHILDREN));
		expect(answer.errorCode).toBe('perm.denied');
	});

	test('mode A on a GRANTED parent, no caller: the cross-section page is served whole (PHP parity — the parent alone is judged)', async () => {
		clearSecurityCaches();
		expect(await getPermissions(restricted, LEAF, LEAF)).toBe(1);
		expect(await getPermissions(restricted, OTHER, OTHER)).toBe(0);
		const answer = await answerOf(childrenPage(LEAF, LEAF_CHILDREN));
		expect(answer.errorCode).toBeNull();
		expect(tsIdsOf(answer.data).sort()).toEqual([`${LEAF}_2`, `${OTHER}_1`].sort());
	});

	// W4b review: searchThesaurus expands a hit's ancestry across sections and
	// builds each ancestor level's sibling list with no section gate, so under
	// the picker scope a THES hit could pull a WHOLE node of a third section the
	// profile neither reads nor the scope targets (THES2 here). The search now
	// judges every node as the node doors do: granted untouched, scoped
	// trimmed, neither DROPPED.
	test('the tree SEARCH under the picker scope: a third-section ancestor is dropped, the scoped hit trimmed', async () => {
		const { scopeTreeSearchNodes } = await import('../../src/core/area/read.ts');
		const { resolveWriterChainScope } = await import(
			'../../src/core/security/writer_chain_scope.ts'
		);
		const node = (section_tipo: string, section_id: number, elements: [string, string][]) => ({
			section_tipo,
			section_id,
			ts_id: `${section_tipo}_${section_id}`,
			ts_parent: null,
			order: null,
			mode: 'list' as const,
			lang: LANG,
			is_descriptor: true,
			is_indexable: false,
			ar_elements: elements.map(([tipo, type]) => ({ tipo, type, value: 'zzsubp v' })),
			permissions_button_new: 0,
			permissions_button_delete: 0,
		});
		const found = {
			result: [
				node(THES2, 1, [[TERM2, 'term']]),
				node(THES, 3, [
					[TERM, 'term'],
					[THES_NOTE, 'note'],
				]),
				node(PEOPLE, 1, [[TERM_REF, 'term']]),
			],
			msg: '',
			errors: [],
			total: 1,
			found: [{ section_tipo: THES, section_id: 3 }],
		};
		clearSecurityCaches();
		await runWithRequestContext(
			{ principal: restricted, session: null, requestId: 'zzsubp-tsearch', clientIp: '127.0.0.1' },
			async () => {
				const scope = await resolveWriterChainScope(restricted, {
					tipo: TERM_REF_TREE,
					sectionTipo: PEOPLE,
					callers: PEOPLE_ROOT,
					lang: LANG,
				});
				expect(scope).not.toBeNull();
				expect(scope?.targets).toEqual([THES]);
				const scoped = await scopeTreeSearchNodes(
					found as never,
					restricted,
					scope,
					new Set([THES]),
				);
				const bySection = (section: string) =>
					scoped.result.filter((entry) => entry.section_tipo === section);
				// THES2: neither granted nor targeted → absent.
				expect(bySection(THES2)).toHaveLength(0);
				// THES: scoped → the term stays, THES_NOTE (outside the config) trimmed.
				expect(bySection(THES)[0]?.ar_elements.map((element) => element.tipo)).toEqual([TERM]);
				// PEOPLE: granted → untouched.
				expect(bySection(PEOPLE)[0]?.ar_elements).toHaveLength(1);
				// Control: a search the scope opened nothing for is untouched (PHP parity).
				const plain = await scopeTreeSearchNodes(found as never, restricted, scope, new Set());
				expect(plain.result).toHaveLength(3);
			},
		);
	});

	test('the hierarchy prune keeps THES only under the verified tree scope', async () => {
		const { filterHierarchiesByGrant } = await import('../../src/core/area/read.ts');
		const { resolveWriterChainScope } = await import(
			'../../src/core/security/writer_chain_scope.ts'
		);
		clearSecurityCaches();
		const hierarchy = {
			target_section_tipo: THES,
			children_tipo: THES_REL,
			active_in_thesaurus: true,
			typology_section_id: '1',
			root_terms: [{ section_tipo: THES, section_id: '1' }],
		};
		await runWithRequestContext(
			{ principal: restricted, session: null, requestId: 'zzsubp-prune', clientIp: '127.0.0.1' },
			async () => {
				const scope = await resolveWriterChainScope(restricted, {
					tipo: TERM_REF_TREE,
					sectionTipo: PEOPLE,
					callers: PEOPLE_ROOT,
					lang: LANG,
				});
				expect(scope).not.toBeNull();
				const scoped = await filterHierarchiesByGrant([hierarchy], restricted, false, scope);
				expect(scoped.kept.map((item) => item.target_section_tipo)).toEqual([THES]);
				const plain = await filterHierarchiesByGrant([hierarchy], restricted, false);
				expect(plain.kept).toHaveLength(0);
				expect(plain.refusedByAcl).toBe(1);
				// A read-only writer gets no scope at all.
				expect(
					await resolveWriterChainScope(restricted, {
						tipo: TERM_REF_R,
						sectionTipo: PEOPLE,
						callers: PEOPLE_ROOT,
						lang: LANG,
					}),
				).toBeNull();
			},
		);
	});
});

describe('(ii) a component-related-to-component-related child: dropped through a SECTION caller, raised through a COMPONENT caller', () => {
	const sectionMap = [
		{ tipo: REL1R, parent: 'self', section_tipo: 'self' },
		{ tipo: REL2, parent: REL1R, section_tipo: MID },
		{ tipo: LEAF_TEXT, parent: REL2, section_tipo: LEAF },
	];

	test('the section map names REL2 under REL1R: the user gets no REL2 and nothing below it', async () => {
		const answer = await readPeople(sectionMap, restricted);
		expect(answer.errorCode).toBeNull();
		// The positive half of the same read: REL1R itself is served, and — its
		// caller children all dropped — falls back to its OWN map [MID_TEXT]
		// (PHP: an empty injected slot is not replaced, class.common.php:2637-2648).
		expect(itemsOf(answer, REL1R, PEOPLE).length).toBeGreaterThan(0);
		expect(itemsOf(answer, MID_TEXT, MID).length).toBeGreaterThan(0);
		expect(itemsOf(answer, REL2, MID)).toHaveLength(0);
		expect(itemsOf(answer, LEAF_TEXT, LEAF)).toHaveLength(0);
		expect(entryOf(answer, REL2, MID)).toBeUndefined();
		expect(entryOf(answer, LEAF_TEXT, LEAF)).toBeUndefined();
	});

	test('admin control: the same section map serves REL2 and LEAF_TEXT', async () => {
		const answer = await readPeople(sectionMap, root);
		expect(itemsOf(answer, REL2, MID).length).toBeGreaterThan(0);
		expect(itemsOf(answer, LEAF_TEXT, LEAF).length).toBeGreaterThan(0);
	});

	test("the same REL2 through REL1's OWN config (a component caller) is served at read level", async () => {
		const answer = await readPeople(
			[{ tipo: REL1, parent: 'self', section_tipo: 'self' }],
			restricted,
		);
		expect(answer.errorCode).toBeNull();
		expect(itemsOf(answer, REL2, MID).length).toBeGreaterThan(0);
		expect(entryOf(answer, REL2, MID)?.permissions).toBe(1);
	});
});

describe('(d) the cap travels the caller chain (each element judged by its IMMEDIATE caller)', () => {
	const expectChainLevels = (answer: Answer) => {
		// REL2: own 0 → raised to 1 under REL1 (level 2).
		expect(entryOf(answer, REL2, MID)?.permissions).toBe(1);
		// LEAF_TEXT: own 2 → capped 1 under ITS caller REL2 (read-only), although
		// the outermost element REL1 is editable.
		expect(itemsOf(answer, LEAF_TEXT, LEAF).length).toBeGreaterThan(0);
		expect(entryOf(answer, LEAF_TEXT, LEAF)?.permissions).toBe(1);
		// MID_TEXT: own 2 under REL1 (2) stays editable.
		expect(entryOf(answer, MID_TEXT, MID)?.permissions).toBe(2);
	};

	test('the get_data door: REL1 → REL2 (1) → LEAF_TEXT capped 1, MID_TEXT 2', async () => {
		const answer = await getData(REL1, PEOPLE, MID, restricted);
		expect(answer.errorCode).toBeNull();
		expect(entryOf(answer, REL1, PEOPLE)?.permissions).toBe(2);
		expectChainLevels(answer);
	});

	test('the section door: the same chain under the section read', async () => {
		const answer = await readPeople(
			[{ tipo: REL1, parent: 'self', section_tipo: 'self' }],
			restricted,
		);
		expectChainLevels(answer);
	});

	test('a read-only caller caps its child: MID_TEXT under REL1R is 1 (derived)', async () => {
		const answer = await readPeople(
			[{ tipo: REL1R, parent: 'self', section_tipo: 'self' }],
			restricted,
		);
		expect(entryOf(answer, REL1R, PEOPLE)?.permissions).toBe(1);
		expect(itemsOf(answer, MID_TEXT, MID).length).toBeGreaterThan(0);
		expect(entryOf(answer, MID_TEXT, MID)?.permissions).toBe(1);
	});

	test('a read-only caller caps a DECLARED nested column: MID_TEXT<REL1R is 1', async () => {
		const answer = await readPeople(
			[
				{ tipo: REL1R, parent: 'self', section_tipo: 'self' },
				{ tipo: MID_TEXT, parent: REL1R, section_tipo: MID },
			],
			restricted,
		);
		expect(itemsOf(answer, MID_TEXT, MID).length).toBeGreaterThan(0);
		expect(entryOf(answer, MID_TEXT, MID)?.permissions).toBe(1);
	});
});

describe('(f) the search read floor follows the VERIFIED caller chain (E10), at the API door', () => {
	// Through dispatchRqo — the door a client request takes (Gate A on the
	// source, Gate B on the sqo targets, then the read floor). The source is
	// REL4 @ MID, which the restricted profile READS (granted 2): its own map is
	// [LEAF_TEXT]; LEAF_X (own 0) reaches it ONLY as a child REL3 injects.
	/** An autocomplete search of LEAF by LEAF_X from `source` @ MID, optionally naming callers. */
	const search = (source: string, q: string, callers?: unknown[]) => ({
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			typo: 'source',
			tipo: source,
			section_tipo: MID,
			action: 'search',
			model: 'component_portal',
			mode: 'search',
			lang: LANG,
			...(callers !== undefined ? { callers } : {}),
		},
		sqo: {
			section_tipo: [LEAF],
			limit: 50,
			offset: 0,
			filter: { $and: [{ q, path: [{ section_tipo: LEAF, component_tipo: LEAF_X }] }] },
		},
	});
	const verified = [{ tipo: REL3, section_tipo: PEOPLE, mode: 'edit' }];

	test('through the verified chain REL3 → REL4: LEAF_X is SEARCHABLE (hit finds, miss does not)', async () => {
		const hit = await send(search(REL4, 'zzsubp alpha*', verified), restricted);
		const miss = await send(search(REL4, 'zzsubp alphx*', verified), restricted);
		expect(hit.errorCode).toBeNull();
		expect(miss.errorCode).toBeNull();
		expect(hit.rows).toEqual([1]);
		expect(miss.rows).toEqual([]);
	});

	for (const [label, callers] of [
		["no chain (REL4's own map is [LEAF_TEXT] — LEAF_X is not in it)", undefined],
		[
			'a FORGED root that does not declare REL4',
			[{ tipo: REL1R, section_tipo: PEOPLE, mode: 'edit' }],
		],
		[
			'a root at a section the component does not belong to',
			[{ tipo: REL3, section_tipo: MID, mode: 'edit' }],
		],
		[
			// The chain VERIFIES (REL4 is granted, so STEP 11 keeps DECL's REL4
			// line — proven by 'the SECTION-rooted chain' describe below) but STEP
			// 11 drops the LEAF_X<REL4 line (own 0): under a SECTION caller nothing
			// is raised, so LEAF_X is in no effective config. The chain shape the
			// client sends for a LIST cell (common.js create_callers).
			'a SECTION root whose map STEP 11 strips of LEAF_X (DECL → DREL → REL4)',
			[
				{ tipo: DECL, section_tipo: DECL, mode: 'list' },
				{ tipo: DREL, section_tipo: DECL },
			],
		],
		['a malformed chain (no root mode)', [{ tipo: REL3, section_tipo: PEOPLE }]],
	] as const) {
		test(`${label}: the search stays KEYED (hit and miss identical)`, async () => {
			const hit = await send(
				search(REL4, 'zzsubp alpha*', callers as unknown[] | undefined),
				restricted,
			);
			const miss = await send(
				search(REL4, 'zzsubp alphx*', callers as unknown[] | undefined),
				restricted,
			);
			expect(hit.errorCode).toBeNull();
			expect(miss.errorCode).toBeNull();
			expect(hit.rows).toEqual(miss.rows);
		});
	}

	// A RAISED source (own 0 — REL2, served at read under REL3 on page 1) is
	// refused at Gate A before any floor or chain is consulted: PHP's read door
	// judges the source by its own grant too (class.dd_core_api.php:2081-2129,
	// resolve_component_read_permission; PHP has no caller chain at all).
	// DECIDED (owner decision (h), 2026-11-03): a verified chain does NOT raise
	// Gate A — a read-only / raised caller unlocks nothing; only a component the
	// user can WRITE through its chain opens a scoped search
	// (security/writer_chain_scope.ts; see the page-2 twin below).
	test('a RAISED source (REL2, own 0) is perm.denied at the door even under the verified chain', async () => {
		const answer = await send(search(REL2, 'zzsubp alpha*', verified), restricted);
		expect(answer.errorCode).toBe('perm.denied');
	});

	// Below the door, the floor set the door would apply to REL2 if Gate A
	// admitted it — the chain branch of subdatumReadFloor (unit level).
	test('the floor set itself (unit, below the door): LEAF_X only through the verified chain', async () => {
		const { subdatumReadFloor } = await import('../../src/core/security/read_floor.ts');
		clearSecurityCaches();
		const floorHas = async (source: string, callers?: unknown[]) =>
			runWithRequestContext(
				{ principal: restricted, session: null, requestId: 'zzsubp-floor', clientIp: '127.0.0.1' },
				async () =>
					(
						await subdatumReadFloor(restricted, {
							tipo: source,
							section_tipo: MID,
							...(callers !== undefined ? { callers } : {}),
						})
					)?.has(`${LEAF}_${LEAF_X}`) === true,
			);
		expect(await floorHas(REL4, verified)).toBe(true);
		expect(await floorHas(REL4)).toBe(false);
		// A RAISED source (own 0) gets NO floor, chain or not: the read door
		// refuses it at Gate A, and the generic count — which has no Gate A — must
		// decide alike (read_floor.ts condition 2; the count-door twin below).
		expect(await floorHas(REL2, verified)).toBe(false);
		expect(await floorHas(REL2)).toBe(false);
		expect(await floorHas(REL2, [{ tipo: REL1R, section_tipo: PEOPLE, mode: 'edit' }])).toBe(false);
	});
});

describe('(f) the COUNT door decides like the read door', () => {
	// `count` has no Gate A (dd_core_api.ts countGatedRows): the read floor alone
	// must refuse what the read refuses, or a count answers real totals — a
	// prefix oracle — for a source the read door answers perm.denied.
	const verified = [{ tipo: REL3, section_tipo: PEOPLE, mode: 'edit' }];
	const countOf = async (source: string, q: string, callers?: unknown[]) => {
		clearSecurityCaches();
		const body = (
			await dispatchRqo(
				{
					action: 'count',
					dd_api: 'dd_core_api',
					prevent_lock: true,
					source: {
						typo: 'source',
						tipo: source,
						section_tipo: MID,
						action: 'search',
						model: 'component_portal',
						mode: 'search',
						lang: LANG,
						...(callers !== undefined ? { callers } : {}),
					},
					sqo: {
						section_tipo: [LEAF],
						filter: { $and: [{ q, path: [{ section_tipo: LEAF, component_tipo: LEAF_X }] }] },
					},
				} as never,
				contextFor(restricted) as never,
			)
		).body as { data?: { total?: unknown }; error?: { code?: string } };
		return { total: body.data?.total ?? null, errorCode: body.error?.code ?? null };
	};

	test('a RAISED source (REL2, own 0) under the verified chain: the count is KEYED (hit = miss)', async () => {
		const hit = await countOf(REL2, 'zzsubp alpha*', verified);
		const miss = await countOf(REL2, 'zzsubp alphx*', verified);
		expect(hit.errorCode).toBeNull();
		expect(miss.errorCode).toBeNull();
		expect(hit.total).toEqual(miss.total);
	});

	test('control: the GRANTED source (REL4) under the same chain counts what its read finds (1 vs 0)', async () => {
		const hit = await countOf(REL4, 'zzsubp alpha*', verified);
		const miss = await countOf(REL4, 'zzsubp alphx*', verified);
		expect(hit.total).toBe(1);
		expect(miss.total).toBe(0);
	});
});

describe('the SECTION-rooted chain (the shape the client sends for a LIST cell) VERIFIES', () => {
	// common.js create_callers roots the chain at the SECTION when the outermost
	// component is a LIST column: [{S, S, list}, {C, S}]. The children of REL4
	// in DECL's map are [LEAF_X] (REL4's own map is [LEAF_TEXT]).
	const sectionRooted = [
		{ tipo: DECL, section_tipo: DECL, mode: 'list' },
		{ tipo: DREL, section_tipo: DECL },
	];
	const chainFor = async (principal: Principal, callers: unknown[]) => {
		const { resolveCallerChain } = await import('../../src/core/relations/caller_chain.ts');
		clearSecurityCaches();
		return runWithRequestContext(
			{ principal, session: null, requestId: 'zzsubp-chain', clientIp: '127.0.0.1' },
			() =>
				resolveCallerChain({
					callers,
					targetTipo: REL4,
					targetSectionTipo: MID,
					lang: LANG,
					principal,
				}),
		);
	};
	const childTipos = (chain: Awaited<ReturnType<typeof chainFor>>) =>
		(chain?.parentNode.children ?? []).map((line) => `${line.tipo}<${line.parent}`);

	test('the chain resolves for the restricted profile; STEP 11 strips only the 0-grant lines', async () => {
		const chain = await chainFor(restricted, sectionRooted);
		expect(chain).not.toBeNull();
		expect(chain?.line.tipo).toBe(REL4);
		// DREL's children under DECL: REL4 kept (granted), REL2 dropped (own 0).
		expect(childTipos(chain)).toContain(`${REL4}<${DREL}`);
		expect(childTipos(chain)).not.toContain(`${REL2}<${DREL}`);
	});

	// Review 2026-11-04: the SHAPE bound (relations/caller_chain.ts parseLinks)
	// had no gate. It refuses before any link is walked, so it is told apart
	// from an ancestry refusal by the warned reason: without it, the over-long
	// chain below is refused at its third link ('link …'), not as 'shape'.
	test('SHAPE: an empty chain, a non-array and one over MAX_DDO_DEPTH links are refused as shape (no chain)', async () => {
		const { MAX_DDO_DEPTH } = await import('../../src/core/relations/element_node.ts');
		const overLong = Array.from({ length: MAX_DDO_DEPTH + 1 }, (_, index) =>
			index === 0 ? sectionRooted[0] : sectionRooted[1],
		);
		const warn = spyOn(console, 'warn');
		try {
			// Control: the same links, at a valid length, verify.
			expect(await chainFor(restricted, sectionRooted)).not.toBeNull();
			for (const callers of [[], overLong, 'zzsubp', { tipo: DECL, section_tipo: DECL }]) {
				warn.mockClear();
				expect(await chainFor(restricted, callers as unknown[])).toBeNull();
				const refusals = warn.mock.calls
					.map((call) => String(call[0]))
					.filter((line) => line.includes('refused source.callers'));
				expect(refusals).toHaveLength(1);
				expect(refusals[0]).toContain('(shape)');
			}
		} finally {
			warn.mockRestore();
		}
	});

	// WC-2026-11-04-rqo-source-callers: ANY malformed chain degrades to "no
	// chain" — the RQO schema never 400s the read over `source.callers`.
	test('the RQO schema accepts any source.callers value (the verifier owns the shape)', async () => {
		const { rqoSchema } = await import('../../src/core/concepts/rqo.ts');
		const withCallers = (callers: unknown) => ({
			action: 'read',
			source: { tipo: REL4, section_tipo: MID, callers },
		});
		const overSchemaBound = Array.from({ length: 65 }, () => sectionRooted[1]);
		for (const callers of [overSchemaBound, 'zzsubp', { tipo: DECL }, 42, null, sectionRooted]) {
			expect(rqoSchema.safeParse(withCallers(callers)).success).toBe(true);
		}
	});

	test('page 2 (root): REL4 under the section-rooted chain resolves the SECTION map children [LEAF_X]', async () => {
		const chained = await getData(REL4, MID, LEAF, root, { callers: sectionRooted });
		expect(chained.errorCode).toBeNull();
		expect(itemsOf(chained, LEAF_X, LEAF).length).toBeGreaterThan(0);
		expect(itemsOf(chained, LEAF_TEXT, LEAF)).toHaveLength(0);
		// Control: no chain → REL4's OWN map [LEAF_TEXT].
		const own = await getData(REL4, MID, LEAF, root);
		expect(itemsOf(own, LEAF_TEXT, LEAF).length).toBeGreaterThan(0);
		expect(itemsOf(own, LEAF_X, LEAF)).toHaveLength(0);
	});

	test('page 2 (restricted): the resent LEAF_X show is NOT raised under a SECTION caller (dropped)', async () => {
		// The chain verifies (above), but STEP 11 dropped LEAF_X<REL4 from DECL's
		// map: under a section caller nothing is raised, the resent ddo is judged
		// by its own grant (0) and dropped — while the COMPONENT-rooted chain
		// (REL3) serves it (the page-2 describe below).
		const show = [{ tipo: LEAF_X, parent: REL4, section_tipo: LEAF }];
		const answer = await getData(REL4, MID, LEAF, restricted, { show, callers: sectionRooted });
		expect(answer.errorCode).toBeNull();
		expect(itemsOf(answer, LEAF_X, LEAF)).toHaveLength(0);
	});

	// TASK 5 (W4b, 2026-11-03; WC-2026-11-04-rqo-source-callers) — formerly a pinned KNOWN
	// LIMITATION: in EDIT mode the client roots the chain at the outermost
	// COMPONENT ([{DREL, DECL, edit}]). caller_chain.ts now resolves a component
	// root UNDER its section's map (sectionMapNode, STEP 11 applied), so the
	// children DECL's map injects into DREL (REL4 → LEAF_X) are reproduced.
	test('the EDIT-mode client shape (component root under a section map) VERIFIES: rooted at the section map', async () => {
		const edit = [{ tipo: DREL, section_tipo: DECL, mode: 'edit' }];
		const chain = await chainFor(root, edit);
		expect(chain).not.toBeNull();
		expect(chain?.line.tipo).toBe(REL4);
		const answer = await getData(REL4, MID, LEAF, root, { callers: edit });
		expect(answer.errorCode).toBeNull();
		expect(itemsOf(answer, LEAF_X, LEAF).length).toBeGreaterThan(0);
		expect(itemsOf(answer, LEAF_TEXT, LEAF)).toHaveLength(0);
		// Restricted: STEP 11 still applies to the section map under a component
		// root — REL2 (own 0) is not a line of it, REL4 (granted) is.
		const restrictedChain = await chainFor(restricted, edit);
		expect(restrictedChain).not.toBeNull();
		expect(childTipos(restrictedChain)).toContain(`${REL4}<${DREL}`);
		expect(childTipos(restrictedChain)).not.toContain(`${REL2}<${DREL}`);
	});
	// W4b review: a component root's mode is the CELL's render mode, not the
	// read's. The client sends a SECTION root for every list read, so a
	// component root names an edit read — a 'list' cell inside it (an edit map
	// line declaring mode 'list') must NOT be re-rooted under the section's LIST
	// map (it could inject children page 1 never resolved). It resolves from
	// its own config: DREL's own map has no REL4 line, so the chain to REL4 does
	// not verify (fail closed), and REL4 pages with its OWN map.
	test('a NON-edit component root is not re-rooted under the section map (own config, fail closed)', async () => {
		const listCell = [{ tipo: DREL, section_tipo: DECL, mode: 'list' }];
		expect(await chainFor(root, listCell)).toBeNull();
		// Control: the same link in edit mode verifies (the task-5 shape above).
		expect(await chainFor(root, [{ tipo: DREL, section_tipo: DECL, mode: 'edit' }])).not.toBeNull();
	});
});

describe('stage 1 under the verified chain keeps the SERVER slots (task 4): the hidden dataframe on page 1 AND page 2', () => {
	// REL3 injects DFP's SHOW children [LEAF_TEXT]; DFP's own HIDE [DFF] (a
	// dataframe, no grant row → raised to read under DFP) is not replaced by a
	// show-only caller. Page 2 resends the show (stage 1, component_portal.js
	// sends_own_show): mergeComponentStageOne replaces the show slot ONLY, so the
	// frame page 1 had is still there.
	const verified = [{ tipo: REL3, section_tipo: PEOPLE, mode: 'edit' }];
	const show = [{ tipo: LEAF_TEXT, parent: DFP, section_tipo: LEAF }];
	const frameServed = (answer: Answer) => {
		const frames = itemsOf(answer, DFF, MID);
		expect(JSON.stringify(frames.map((item) => item.entries))).toContain(
			`"main_component_tipo":"${DFP}"`,
		);
		expect(entryOf(answer, DFF, MID)?.permissions).toBe(1);
	};

	test('page 1 (REL3 a column of PEOPLE): DFP and its hidden dataframe are served', async () => {
		const answer = await readPeople(
			[{ tipo: REL3, parent: 'self', section_tipo: 'self' }],
			restricted,
		);
		expect(answer.errorCode).toBeNull();
		expect(itemsOf(answer, DFP, MID).length).toBeGreaterThan(0);
		frameServed(answer);
	});

	test('page 2 (get_data of DFP under the chain, show resent): the hidden dataframe is STILL served', async () => {
		const answer = await getData(DFP, MID, LEAF, restricted, { show, callers: verified });
		expect(answer.errorCode).toBeNull();
		frameServed(answer);
	});

	// getData's sqo carries the OWNER record (`filter_by_locators: [MID/1]`) —
	// the address of the portal's own value, never a filter of its targets.
	// HONEST SCOPE (W4b review): on this door the outcome below cannot tell how
	// stage 1 treats the client sqo — a stored portal emits its stored locators
	// and reads only `limit` from any sqo (relation_core.ts), and NO relation
	// model on the get_data path reads `filter_by_locators` from the config sqo
	// (the search-derived models — inverse children / related / index — build
	// their own search from the record address, never from it). So this pins
	// the DOOR's outcome only; the stage-1 contract itself is pinned by the
	// probe that follows (the effective config's sqo stays the SERVER's).
	test('page 2 (door outcome): both LEAF records DFP holds come back under the owner-record pin', async () => {
		const answer = await getData(DFP, MID, LEAF, restricted, { show, callers: verified });
		const leafTexts = itemsOf(answer, LEAF_TEXT, LEAF).map((item) => JSON.stringify(item.entries));
		expect(leafTexts).toContain(JSON.stringify(textValue('leaf one')));
		expect(leafTexts).toContain(JSON.stringify(textValue('leaf two')));
	});

	// The STAGE-1 pin: the client's paging sqo (owner-record filter_by_locators
	// included) never becomes the element's effective config sqo —
	// mergeComponentStageOne keeps the server's (element_node.ts). A stage 1
	// that adopted the client sqo would carry the owner pin into every
	// config-sqo consumer (fixed_filter / filter_by_list expansion, a future
	// search-derived model), narrowing the targets to the OWNER record.
	test('stage 1 keeps the SERVER sqo: the client owner-record filter_by_locators never enters the effective config (probe)', async () => {
		const { resolveElement } = await import('../../src/core/relations/element_node.ts');
		const { ElementNodeRegistry } = await import('../../src/core/relations/element_registry.ts');
		clearSecurityCaches();
		const resolveDfp = (rqo: Record<string, unknown> | undefined) =>
			runWithRequestContext(
				{ principal: root, session: null, requestId: 'zzsubp-sqo', clientIp: '127.0.0.1' },
				() =>
					resolveElement({
						ddo: { tipo: DFP, section_tipo: MID, parent: MID, mode: 'edit' } as never,
						parentNode: null,
						ownerSectionTipo: MID,
						ownerSectionId: 1,
						mode: 'edit',
						lang: LANG,
						registry: new ElementNodeRegistry(),
						model: 'component_portal',
						...(rqo !== undefined ? { rqo } : {}),
						principal: root,
					} as never),
			);
		const staged = await resolveDfp({
			source: { tipo: DFP, section_tipo: MID, section_id: 1, mode: 'edit' },
			show: { ddo_map: show },
			sqo: {
				section_tipo: [LEAF],
				limit: 10,
				offset: 0,
				filter_by_locators: [{ section_tipo: MID, section_id: 1 }],
			},
		});
		const own = await resolveDfp(undefined);
		expect(staged.configSource).toBe('rqo');
		const sqoOf = (node: { effectiveConfig: readonly unknown[] }) =>
			(node.effectiveConfig[0] as { sqo?: unknown }).sqo ?? null;
		expect(JSON.stringify(sqoOf(staged))).not.toContain('filter_by_locators');
		expect(sqoOf(staged)).toEqual(sqoOf(own));
	});

	// The DISCRIMINATING half: stage 1 merges onto the CHAIN-RESOLVED node (own
	// config + the caller's injection), not the own config alone. REL6 injects
	// a HIDE child into DFP (LEAF_X, replacing DFP's own hide [DFF]); page 2
	// resends the show only. Under the chain the CALLER's hide survives (LEAF_X
	// served at read, raised under DFP); without the chain DFP's OWN hide stands
	// (the frame, no LEAF_X).
	test("page 2 under the chain keeps a CALLER-INJECTED hide child; with no chain the element's own hide stands", async () => {
		const injected = [{ tipo: REL6, section_tipo: PEOPLE, mode: 'edit' }];
		const chained = await getData(DFP, MID, LEAF, restricted, { show, callers: injected });
		expect(chained.errorCode).toBeNull();
		const hidden = itemsOf(chained, LEAF_X, LEAF);
		expect(hidden.length).toBeGreaterThan(0);
		expect(JSON.stringify(hidden.map((item) => item.entries))).toContain('zzsubp alpha');
		expect(entryOf(chained, LEAF_X, LEAF)?.permissions).toBe(1);
		expect(itemsOf(chained, DFF, MID)).toHaveLength(0);
		const unchained = await getData(DFP, MID, LEAF, restricted, { show });
		expect(unchained.errorCode).toBeNull();
		expect(itemsOf(unchained, LEAF_X, LEAF)).toHaveLength(0);
		frameServed(unchained);
	});

	// A NON-dedalo engine item of the element's config is the SERVER's too:
	// stage 1 replaces the show of the FIRST dedalo item only (element_node.ts
	// mergeComponentStageOne). Probe below the door (the scratch engine has no
	// service to read from).
	test('stage 1 keeps a NON-dedalo engine item of the config (probe)', async () => {
		const { resolveElement } = await import('../../src/core/relations/element_node.ts');
		const { ElementNodeRegistry } = await import('../../src/core/relations/element_registry.ts');
		clearSecurityCaches();
		const node = await runWithRequestContext(
			{ principal: root, session: null, requestId: 'zzsubp-ext', clientIp: '127.0.0.1' },
			() =>
				resolveElement({
					ddo: { tipo: EXTP, section_tipo: MID, parent: MID, mode: 'edit' } as never,
					parentNode: null,
					ownerSectionTipo: MID,
					ownerSectionId: 1,
					mode: 'edit',
					lang: LANG,
					registry: new ElementNodeRegistry(),
					model: 'component_portal',
					rqo: {
						source: { tipo: EXTP, section_tipo: MID, section_id: 1, mode: 'edit' },
						show: { ddo_map: [{ tipo: LEAF_X, parent: 'self', section_tipo: LEAF }] },
					},
					principal: root,
				}),
		);
		expect(node.configSource).toBe('rqo');
		const engines = node.effectiveConfig.map((item) => item.api_engine ?? 'dedalo');
		expect(engines).toEqual(['dedalo', EXT_ENGINE]);
		const showOf = (index: number) =>
			(
				(node.effectiveConfig[index] as { show?: { ddo_map?: { tipo: string }[] } }).show
					?.ddo_map ?? []
			).map((ddo) => ddo.tipo);
		// The dedalo item's show is the client's; the external item is untouched.
		expect(showOf(0)).toEqual([LEAF_X]);
		expect(showOf(1)).toEqual([LEAF_TEXT]);
	});
});

describe("page 2 under the verified chain: the caller-injected children are the element's", () => {
	const verified = [{ tipo: REL3, section_tipo: PEOPLE, mode: 'edit' }];

	test('no show: the chain resolves REL2 with its CALLER children [LEAF_X] (served at read level)', async () => {
		const chained = await getData(REL2, MID, LEAF, root, { callers: verified });
		expect(chained.errorCode).toBeNull();
		expect(itemsOf(chained, LEAF_X, LEAF).length).toBeGreaterThan(0);
		expect(itemsOf(chained, LEAF_TEXT, LEAF)).toHaveLength(0);
		// Control: without the chain REL2 resolves its OWN map [LEAF_TEXT].
		const own = await getData(REL2, MID, LEAF, root);
		expect(itemsOf(own, LEAF_TEXT, LEAF).length).toBeGreaterThan(0);
		expect(itemsOf(own, LEAF_X, LEAF)).toHaveLength(0);
	});

	// STAGE 1 (from_rqo.ts READ GRANT): page 2 RESENDS the injected show. The
	// user reads REL4 (granted) but holds 0 on LEAF_X — on page 1 the cell showed
	// LEAF_X raised to read (a child of the component caller REL3). Under the
	// verified chain the resent ddo is INHERITED and served; with no chain it is
	// a foreign client ddo, judged, and dropped — the gap W4 closes.
	test('a resent injected show: inherited under the chain (served), judged without it (dropped)', async () => {
		const show = [{ tipo: LEAF_X, parent: REL4, section_tipo: LEAF }];
		const chained = await getData(REL4, MID, LEAF, restricted, { show, callers: verified });
		expect(chained.errorCode).toBeNull();
		const served = itemsOf(chained, LEAF_X, LEAF);
		expect(served.length).toBeGreaterThan(0);
		expect(served[0]?.entries).toEqual(textValue('zzsubp alpha'));
		expect(entryOf(chained, LEAF_X, LEAF)?.permissions).toBe(1);
		const unchained = await getData(REL4, MID, LEAF, restricted, { show });
		expect(unchained.errorCode).toBeNull();
		expect(itemsOf(unchained, LEAF_X, LEAF)).toHaveLength(0);
	});

	// The scope of the page-2 promise: a nested element the profile itself
	// holds a grant on (REL4). A RAISED one (REL2: own 0, served at read under
	// REL1 / REL3 on page 1) cannot page — Gate A judges the source by its own
	// grant and ignores source.callers (PHP-identical door,
	// class.dd_core_api.php:2081-2129). DECIDED (owner decision (h)): a raised
	// (read-only) element unlocks nothing — it stays refused.
	test('a RAISED nested portal (REL2, own 0) cannot page: perm.denied even under the verified chain', async () => {
		const answer = await getData(REL2, MID, LEAF, restricted, { callers: verified });
		expect(answer.errorCode).toBe('perm.denied');
	});
});

// THE CONTRACT THESE CASES PIN (owner decision (g), as the engine — and HEAD
// before W2 — implements it; relations/relation_core.ts expandPortal):
//
//   GATE    = model component_autocomplete_hi, not a Time Machine read.
//   TRIGGER = (a GOVERNING child declares value_with_parents on the target)
//             OR (the children are the element's OWN config AND the target
//                 lives in a thesaurus TABLE).
//
// The thesaurus-TABLE test is the SECOND trigger, not a gate on the first: a
// value_with_parents line fires on ANY target of an autocomplete_hi, because
// user-defined thesauri live in the generic `matrix` table (tch555's tchi1) —
// gating vwp on the table would drop their breadcrumb. Plan §9(g) words the
// thesaurus target as part of the gate; that wording is looser than HEAD's
// behaviour, which this pins (WC-2026-11-04-ddinfo-gates-kept). So "INSIDE" here
// means inside the MODEL gate; the only OUTSIDE case varies the model.
describe('(g) ddinfo: the GOVERNING children trigger it, inside the autocomplete_hi gate only', () => {
	const ddinfoAt = (answer: Answer, section: string) =>
		answer.items.filter((item) => item.tipo === 'ddinfo' && item.section_tipo === section);
	const childLine = (parent: string, tipo: string, section: string, vwp: boolean) => ({
		tipo,
		section_tipo: section,
		parent,
		mode: 'list',
		...(vwp ? { value_with_parents: true } : {}),
	});
	const self = (tipo: string) => ({ tipo, parent: 'self', section_tipo: 'self' });

	// TERM_REF_M: own line WITHOUT value_with_parents, target NOT a thesaurus
	// table — so (a) is red unless the trigger reads the CALLER's line. It also
	// pins that the vwp trigger is NOT gated on a thesaurus-TABLE target (the
	// tchi1-in-`matrix` case — see the contract above).
	test('(a) INSIDE the model gate: a caller-declared value_with_parents child on a non-thesaurus-table target → ddinfo', async () => {
		const answer = await readPeople(
			[self(TERM_REF_M), childLine(TERM_REF_M, MID_TEXT, MID, true)],
			root,
		);
		expect(answer.errorCode).toBeNull();
		expect(itemsOf(answer, MID_TEXT, MID).length).toBeGreaterThan(0);
		expect(ddinfoAt(answer, MID).length).toBeGreaterThan(0);
	});

	test('(b) the SAME caller line without value_with_parents → no ddinfo', async () => {
		const answer = await readPeople(
			[self(TERM_REF_M), childLine(TERM_REF_M, MID_TEXT, MID, false)],
			root,
		);
		expect(answer.errorCode).toBeNull();
		expect(itemsOf(answer, MID_TEXT, MID).length).toBeGreaterThan(0);
		expect(ddinfoAt(answer, MID)).toHaveLength(0);
	});

	test("(c) TERM_REF_M's own config alone → no ddinfo (no vwp line, no thesaurus table)", async () => {
		const answer = await readPeople([self(TERM_REF_M)], root);
		expect(answer.errorCode).toBeNull();
		expect(itemsOf(answer, MID_TEXT, MID).length).toBeGreaterThan(0);
		expect(ddinfoAt(answer, MID)).toHaveLength(0);
	});

	// The converse: TERM_REF's OWN line declares value_with_parents on a
	// thesaurus TABLE (own config alone fires — (e) is the control), but an
	// injected line WITHOUT it governs: no ddinfo. Reverting the trigger to the
	// own config turns (d) red.
	test('(d) own vwp + thesaurus table, but a caller line WITHOUT vwp governs → no ddinfo', async () => {
		const answer = await readPeople([self(TERM_REF), childLine(TERM_REF, TERM, THES, false)], root);
		expect(answer.errorCode).toBeNull();
		expect(itemsOf(answer, TERM, THES).length).toBeGreaterThan(0);
		expect(ddinfoAt(answer, THES)).toHaveLength(0);
	});

	test("(e) control: TERM_REF's own config alone → ddinfo", async () => {
		const answer = await readPeople([self(TERM_REF)], root);
		expect(answer.errorCode).toBeNull();
		expect(ddinfoAt(answer, THES).length).toBeGreaterThan(0);
	});

	test('OUTSIDE: a plain component_portal with a caller value_with_parents child on the SAME thesaurus → no ddinfo', async () => {
		const answer = await readPeople([self(PLAIN_P), childLine(PLAIN_P, TERM, THES, true)], root);
		expect(answer.errorCode).toBeNull();
		// The child IS emitted (the control) — only the breadcrumb is withheld.
		expect(itemsOf(answer, TERM, THES).length).toBeGreaterThan(0);
		expect(ddinfoAt(answer, THES)).toHaveLength(0);
	});
});
