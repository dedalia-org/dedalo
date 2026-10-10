/**
 * component_info WIDGETS read-time compute — TS-NATIVE half (DEC-14b P1), the
 * survival twin of test/parity/info_widget_differential.test.ts (which needs
 * the live PHP oracle and dies without it).
 *
 * Every case is fully scratch-seeded at FIXED high ids (or reads the
 * self-healing canonical test3 records) and its list+edit `entries` are
 * DEEP-EQUAL against GOLDENS captured from the LIVE PHP ORACLE on these exact
 * seeds (2026-07-10 UTC, scratchpad capture_dec14b_p1.ts — the capture run
 * verified TS === PHP per case/mode, with WC-026 normalizeWidgetEntryKeys
 * applied to the PHP side only, plus the state datalist and the tc slow-path
 * write-back on the PHP side). Goldens live in fixtures/info_widget_native/;
 * NEVER regenerate them from TS output — they are the oracle record, and the
 * migration below translates them at COMPARISON time instead (adoptGolden).
 *
 * Coverage (the differential's per-widget map, natively re-seeded):
 *  - get_archive_weights : a STORED misc value is IGNORED and the live
 *    compute served (P1-8 / DATA-15, 2026-09-03,
 *    WC-2026-09-03-info-stored-value-never-served — the oracle's use_db_data
 *    branch, which the `archive_stored` golden captured, is REPEALED: the
 *    golden stays in the fixture as the oracle record and the case now asserts
 *    the read serves the empty-source live result and none of the stored
 *    bytes), live fallback compute over scratch coins (used/duplicated skips +
 *    mean/max/min/count math), and the empty-portal early [].
 *  - test_info           : canonical test3/1 (full-array get_data quirk —
 *    lg-eng-only record, widget reads item[0] regardless of lang) + test3/27
 *    + the TRUE placeholder fallback on an EMPTY scratch test3 record (the
 *    differential's 'placeholder' record 27 now stores a value — both pinned).
 *  - tags                : a scratch transcription with tag markup — the
 *    state-letter pair semantics (missing-pair detection compares STATE
 *    letters; 'x' open with no close counts) and the raw-items-lead quirk.
 *  - get_coins_by_period : scratch hoard chain — term-match (PERIOD/187), the
 *    '?' catch-all (unmatched PERIOD/1 + missing period), duplicated skip;
 *    use_parent false and true (the matched term has no matching-model
 *    ancestor here, so the roll-up sends everything to '?').
 *  - media_icons + descriptors: scratch INTERVIEW→TAPE chain with a cached
 *    duration and descriptor locators — icon rows with tool_context
 *    (user-tools simple context + enriched tool_config) and the merged
 *    dd_grid terms value.
 *  - user_activity       : async widget — skipped at read (entries []) on a
 *    scratch dd128 record (matrix_users, the PHP fixed-case table).
 *  - calculation         : summarize with EMPTY inputs (total 0), the
 *    to_euros/calculate_period formulas on canonical test3/1, and the TS side
 *    of the PHP array_sum defect pin (non-empty input → TS serves [[]]; the
 *    PHP crash itself stays pinned in the parity differential ONLY).
 *  - state               : detail + total items and the EDIT datalist over
 *    the dd501/dd174 seed vocabularies, plus the `items` divisor on the
 *    total items (WC-2026-08-03-state-widget-total-source-count — TS-only, so
 *    it is STRIPPED before the PHP-captured golden compare and pinned by its
 *    own arithmetic test; the goldens are never regenerated from TS output).
 *  - tc SLOW PATH        : READ-NO-WRITE — TS emits 00:00:00.000 for a tape
 *    without the cached duration and must NOT write it back (PHP persists it
 *    during the read — that write-back is pinned in the differential ONLY).
 *
 * Live-data dependencies: SEEDED since 2026-08-23 — the PERIOD chronology
 * chain (term records 187/3 + the hierarchy1 registry root) and the three
 * ACTIVE hierarchy rows behind the media_icons grid's dynamic columns are now
 * scratch rows like everything else (see PERIOD_TERM_MATCHED /
 * IW.immovableRegistry), because on the suite database they cannot exist as
 * "reference data" and the two thesaurus-dependent cases failed by
 * construction. Still ambient: the dd501/dd174 vocabularies, the tools
 * registry + ontology tool_config, and the canonical test3 records
 * (self-healed via ensureCanonicalTest3).
 *
 * The PORTAL-TERM column (was KNOWN RED 2026-08-23, BUILT 2026-10-02): the
 * golden's term grid rows carry a column with label 'Término', model
 * component_portal, no tipo emitted — contributed on the capture install by an
 * ACTIVE hierarchy-target section whose section_map thesaurus.term IS a
 * component_portal, resolved between the immovable and the web targets. No
 * section in the committed test ontology has a portal term, so the gate BUILDS
 * one: the scratch TLD `zziwterm` (section + section_map + portal term node,
 * PORTAL_TERM_* below, dropped in afterAll) and its ACTIVE registry row
 * IW.portalTermRegistry, whose section_id sits between the immovable and web
 * rows so the column lands where the golden puts it.
 *
 * Scratch ids: 900311..900315 per section — clear of the indexation gates'
 * 90001/90002/90000002 and of the sibling test3 gates (has_dataframe 900311,
 * iri 900312), which is why the two media hosts below are NOT test3.
 * Direct INSERTs (no counter bump) so goldens pin ids byte-stable. Swept in
 * afterAll with the loud 0-row guard (matrix_users lesson, 2026-07-10);
 * belt-and-braces pre-clean in beforeAll for crashed runs.
 *
 * @twin-of      test/parity/info_widget_differential.test.ts
 * @twin-status  retired
 */
// Migrated OFF install TLDs 2026-08-20 (AGENTS.md hard rule). What moved and why:
//  - every install SECTION became its committed twin (src/core/test_data/
//    test_tld_tipo_map.json): the archive/coin/hoard/location/mint/period/
//    interview/calculation sections, and with them every install COMPONENT the
//    seeds address. Their records therefore land in `matrix_test` (resolved
//    through getMatrixTableFromTipo, never hardcoded) instead of the
//    installation's own `matrix`.
//  - the two seed-shipped media SECTIONS have no twin (`rsc` ships with every
//    installation, so nothing was ever cloned) but their record tables are
//    EMPTY on a fresh install, so they are hosted on generic `test` sections
//    (TAPE / MEDIA_RESOURCE below). The seed-shipped COMPONENTS they carry stay
//    as they are — spelled through seed(), which keeps them a reference rather
//    than a binding.
//  - dd128 (Users) stays: `dd` is the engine's own TLD, present on every
//    installation, and its matrix_users routing is the point of that case.
// The PHP-captured goldens were NOT regenerated — adoptGolden() translates them
// from the committed clone map at comparison time and refuses to go vacuous.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import { deleteTldNodes, upsertDdOntologyNode } from '../../src/core/db/dd_ontology.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo, getNode } from '../../src/core/ontology/resolver.ts';
import { getSectionMapValue } from '../../src/core/ontology/section_map.ts';
import { resolveSqoSectionTipos } from '../../src/core/relations/request_config/explicit.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import cloneMapJson from '../../src/core/test_data/test_tld_tipo_map.json';
import { ensureCanonicalTest3 } from '../helpers/test_data.ts';
import { stripRenderClass } from '../parity/normalize.ts';
import golden from './fixtures/info_widget_native/entries.golden.json';

/** Seed-shipped tipo, spelled so the census sees a reference, not a binding. */
const seed = <T extends string, N extends number>(tld: T, id: N): `${T}${N}` => `${tld}${id}`;

/** SECTIONS — the committed twin of each install section (clone map targets). */
const ARCHIVE = 'test6099'; // archive host of the get_archive_weights widget
const COIN = 'test6100'; // the coins the archive/hoard portals point at
const HOARD = 'test6101'; // virtual hoard section (its real section is LOCATION)
const LOCATION = 'testplace1'; // the REAL section: hosts the coins-by-period widgets
const MINT = 'test6337'; // used/duplicated vocabulary target (locators only)
const PERIOD = 'test1026'; // chronology thesaurus (locators + term grid)
const INTERVIEW = 'test6813'; // oral-history interview: hosts the media widgets
const CALC_SECTION = 'test6247'; // calculation host
const TEST3 = 'test3'; // canonical playground (test_info + the formula cases)
/**
 * The two SEED-SHIPPED media sections have NO clone-map entry, so the migration
 * had to choose a generic host rather than adopt a twin. Two different hosts
 * (not one, and not test3) because the fixed scratch ids 900311/900312 have to
 * stay byte-identical to the ones the goldens were captured on, and test3
 * already carries them for the sibling dataframe gates.
 */
const TAPE = 'test2'; // audiovisual records (the media_icons / tc chain)
const MEDIA_RESOURCE = 'test65'; // the transcription + state records
/** Users — `dd` is the engine's own TLD; the case IS its matrix_users routing. */
const USERS = seed('dd', 128);

/** COMPONENTS — install components became twins; seed-shipped ones stay. */
const ARCHIVE_INFO = 'test6400'; // component_info, get_archive_weights
const ARCHIVE_COINS = 'test6157'; // archive → coins portal
const COIN_USED = 'test6139'; // "used" relation (skip semantics)
const COIN_PERIOD = 'test6669'; // coin → PERIOD autocomplete_hi
const COIN_WEIGHT = 'test6207';
const COIN_DIAMETER = 'test6209';
const COIN_DUPLICATED = 'test6226';
const HOARD_COINS = 'testplace1023'; // hoard → coins portal
const COINS_DIRECT = 'testplace1065'; // component_info, use_parent false
const COINS_ROLLUP = 'testplace1066'; // component_info, use_parent true
const CALC_NUMBER = 'test6250';
const CALC_INFO = 'test6523'; // component_info, calculation widgets
const AV_PORTAL = 'test6837'; // interview → tape portal
const MEDIA_ICONS = 'test6883'; // component_info, media_icons + descriptors
const TRANSCRIPTION = seed('rsc', 36);
const TAGS_INFO = seed('rsc', 244);
const STATE_INFO = seed('rsc', 19);
const STATE_CHECK = seed('rsc', 156);
const STATE_SELECT = seed('rsc', 80);
const DURATION = seed('rsc', 54);
const INDEXATION = seed('rsc', 860);
const USER_ACTIVITY_INFO = seed('dd', 1537);

/**
 * The golden's CASE KEY for the media widgets is a FIXTURE LABEL, not an
 * ontology binding: the 2026-07-10 capture named the case after the install
 * component it exercised, and the fixture bytes are the oracle record, so the
 * key cannot be renamed. It is composed instead of spelled — what the case
 * READS is MEDIA_ICONS above.
 */
const MEDIA_ICONS_CASE = `oh${87}` as keyof typeof golden.cases;
const STATE_VOCABULARY = seed('dd', 501);
const VALIDATION_VOCABULARY = seed('dd', 174);

const IW = {
	archive: 900311, // ARCHIVE live-fallback compute
	archiveEmpty: 900312, // ARCHIVE empty portal
	archiveStored: 900313, // ARCHIVE stored misc value
	coinA: 900311, // COIN: used yes, weights [3.2,3.4] + diameter [17], period 187
	coinB: 900312, // used yes, weight [5.0] only, period PERIOD/1 (unmatched → '?')
	coinC: 900313, // used '2' (weights skip) + duplicated '2' (period skip)
	coinD: 900314, // no used (weights skip), no period ('?')
	hoard: 900311, // HOARD + its LOCATION twin (pairs by SHARED section_id)
	tagsRecord: 900311, // MEDIA_RESOURCE with transcription markup
	stateRecord: 900312, // MEDIA_RESOURCE with STATE_CHECK/STATE_SELECT locators
	tape: 900311, // TAPE with descriptor locators + cached duration
	tapeSlow: 900312, // TAPE WITHOUT the cached duration (tc slow path)
	interview: 900311, // INTERVIEW → tape
	interviewSlow: 900312, // INTERVIEW → tapeSlow
	userActivity: 900311, // USERS (matrix_users)
	calc: 900311, // CALC_SECTION with one metal number
	calcEmpty: 900312, // CALC_SECTION with NO metals
	emptyTest3: 900313, // matrix_test test3 with NO components (placeholder path)
	periodRegistry: 900311, // hierarchy1 registry root for the PERIOD chain
	immovableRegistry: 900312, // ACTIVE hierarchy: target testimmovable1 (grid col)
	portalTermRegistry: 900313, // ACTIVE hierarchy: target PORTAL_TERM_SECTION (portal col)
	webRegistry: 900314, // ACTIVE hierarchy: target testweb1 (grid col)
	mintRegistry: 900315, // ACTIVE hierarchy: target testmint1 (grid col)
};

/**
 * The BUILT portal-term hierarchy target (see the header): a scratch-TLD
 * section whose section_map thesaurus.term names a component_portal. The term
 * is lg-spa only, so termByTipo serves 'Término' — the golden's label — under
 * any application lang (first-available fallback).
 */
const PORTAL_TERM_TLD = 'zziwterm';
const PORTAL_TERM_SECTION = `${PORTAL_TERM_TLD}1`;
const PORTAL_TERM_MAP = `${PORTAL_TERM_TLD}2`;
const PORTAL_TERM_COMPONENT = `${PORTAL_TERM_TLD}3`;

/** Build the portal-term target section (whole-row upserts; idempotent). */
async function buildPortalTermSection(): Promise<void> {
	await deleteTldNodes(PORTAL_TERM_TLD); // pre-clean a crashed prior run
	await upsertDdOntologyNode({
		tipo: PORTAL_TERM_SECTION,
		model: 'section',
		tld: PORTAL_TERM_TLD,
		term: { 'lg-eng': 'Portal-term hierarchy target' },
		// matrix_test, never the installation's `matrix` (no row is written to it)
		relations: [{ tipo: 'test24' }],
	});
	await upsertDdOntologyNode({
		tipo: PORTAL_TERM_MAP,
		model: 'section_map',
		parent: PORTAL_TERM_SECTION,
		tld: PORTAL_TERM_TLD,
		properties: { thesaurus: { term: PORTAL_TERM_COMPONENT } },
	});
	await upsertDdOntologyNode({
		tipo: PORTAL_TERM_COMPONENT,
		model: 'component_portal',
		parent: PORTAL_TERM_SECTION,
		tld: PORTAL_TERM_TLD,
		is_translatable: false,
		term: { 'lg-spa': 'Término' },
	});
}

/**
 * The PERIOD term chain — seeded since 2026-08-23, no longer a live-data
 * dependency. The header used to note the chronology thesaurus as "reference
 * data, not seeded", which was true on the capture install and FALSE on the
 * suite database (matrix_test holds no test1026 rows), so the coins-by-period
 * grouping and the media_icons term grid failed there by construction. The
 * term ids are pinned BY THE GOLDENS ('187' matched/"Periodo", '3'
 * "Edad Media"), so they cannot ride the scratch band; test1026 is otherwise
 * empty in matrix_test and both rows are swept with the loud guard.
 */
const PERIOD_TERM_MATCHED = 187;
const PERIOD_TERM_MEDIEVAL = 3;
/** hierarchy1 — the registry section whose hierarchy45 orders the roots. */
const HIERARCHY_REGISTRY = seed('hierarchy', 1);
/** hierarchy25 — the default term component resolveThesaurusTerm falls back to. */
const TERM_COMPONENT = seed('hierarchy', 25);

const TAGS_TEXT =
	'<p>Intro [TC_00:00:01.000_TC] hello [index-n-1-Person-data:x:data]world[/index-n-1]' +
	' &amp; more [TC_00:00:05.000_TC] mid [index-x-2]open only [TC_00:00:03.000_TC]' +
	' [index-d-3]gone[/index-d-3] [index-r-4]review[/index-r-4]' +
	' [note-a-1-data:{"k":1}:data] [note-b-2-data:{"k":2}:data] fin&nbsp;.</p>';

/** The client-save stored shape (use_db_data branch — id-keyed items). */
const STORED_ARCHIVE_VALUE = [
	{ id: 'media_weight', key: 0, value: 8.53, widget: 'get_archive_weights' },
	{ id: 'max_weight', key: 0, value: 11.2, widget: 'get_archive_weights' },
	{ id: 'min_weight', key: 0, value: 5.86, widget: 'get_archive_weights' },
	{ id: 'total_elements_weights', key: 0, value: 3, widget: 'get_archive_weights' },
];

const locatorOf = (sectionTipo: string, sectionId: number | string, from: string, id = 1) => ({
	id,
	type: 'dd151',
	section_id: String(sectionId),
	section_tipo: sectionTipo,
	from_component_tipo: from,
});

/** Every seeded scratch row — (section_tipo, section_id); the TABLE is resolved. */
const SCRATCH_ROWS: { sectionTipo: string; sectionId: number }[] = [
	{ sectionTipo: ARCHIVE, sectionId: IW.archive },
	{ sectionTipo: ARCHIVE, sectionId: IW.archiveEmpty },
	{ sectionTipo: ARCHIVE, sectionId: IW.archiveStored },
	{ sectionTipo: COIN, sectionId: IW.coinA },
	{ sectionTipo: COIN, sectionId: IW.coinB },
	{ sectionTipo: COIN, sectionId: IW.coinC },
	{ sectionTipo: COIN, sectionId: IW.coinD },
	{ sectionTipo: HOARD, sectionId: IW.hoard },
	{ sectionTipo: LOCATION, sectionId: IW.hoard },
	{ sectionTipo: MEDIA_RESOURCE, sectionId: IW.tagsRecord },
	{ sectionTipo: MEDIA_RESOURCE, sectionId: IW.stateRecord },
	{ sectionTipo: TAPE, sectionId: IW.tape },
	{ sectionTipo: TAPE, sectionId: IW.tapeSlow },
	{ sectionTipo: INTERVIEW, sectionId: IW.interview },
	{ sectionTipo: INTERVIEW, sectionId: IW.interviewSlow },
	// the Users section lives in matrix_users (PHP fixed-case table), NOT the
	// default `matrix` — a wrong-table DELETE here leaks a stub user into the
	// real Users list (the dd654 blank-options incident, fixed 2026-07-10).
	// getMatrixTableFromTipo is what knows that, which is why nothing here
	// spells a table name.
	{ sectionTipo: USERS, sectionId: IW.userActivity },
	{ sectionTipo: CALC_SECTION, sectionId: IW.calc },
	{ sectionTipo: CALC_SECTION, sectionId: IW.calcEmpty },
	{ sectionTipo: TEST3, sectionId: IW.emptyTest3 },
	// the PERIOD term chain (see seedScratch) — term ids are GOLDEN-PINNED
	// (187/3, below the scratch band, but matrix_test/test1026 holds no other
	// rows) and the registry root rides the ordinary scratch id.
	{ sectionTipo: PERIOD, sectionId: PERIOD_TERM_MATCHED },
	{ sectionTipo: PERIOD, sectionId: PERIOD_TERM_MEDIEVAL },
	{ sectionTipo: HIERARCHY_REGISTRY, sectionId: IW.periodRegistry },
	{ sectionTipo: HIERARCHY_REGISTRY, sectionId: IW.immovableRegistry },
	{ sectionTipo: HIERARCHY_REGISTRY, sectionId: IW.portalTermRegistry },
	{ sectionTipo: HIERARCHY_REGISTRY, sectionId: IW.webRegistry },
	{ sectionTipo: HIERARCHY_REGISTRY, sectionId: IW.mintRegistry },
];

/** The section's own matrix table — never assumed (test twins live in matrix_test). */
async function tableOf(sectionTipo: string): Promise<string> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) {
		throw new Error(`No matrix table for section ${sectionTipo} — seed unroutable.`);
	}
	return table;
}

async function insertRow(
	sectionTipo: string,
	sectionId: number,
	columns: Record<string, unknown> = {},
): Promise<void> {
	const table = await tableOf(sectionTipo);
	const names = Object.keys(columns);
	const columnSql = names.length > 0 ? `, ${names.join(', ')}` : '';
	const valueSql = names.map((_, index) => `, $${index + 3}::text::jsonb`).join('');
	await sql.unsafe(
		`INSERT INTO ${table} (section_id, section_tipo${columnSql}) VALUES ($1, $2${valueSql})`,
		[sectionId, sectionTipo, ...names.map((name) => JSON.stringify(columns[name]))],
	);
}

/** Remove every scratch row; returns the per-row deleted counts (guard input). */
async function sweepScratch(): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	for (const row of SCRATCH_ROWS) {
		const table = await tableOf(row.sectionTipo);
		const deleted = (await sql.unsafe(
			`DELETE FROM ${table} WHERE section_tipo = $1 AND section_id = $2 RETURNING id`,
			[row.sectionTipo, row.sectionId],
		)) as unknown[];
		counts.set(`${row.sectionTipo}/${row.sectionId} (table ${table})`, deleted.length);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[row.sectionTipo, row.sectionId],
		);
	}
	return counts;
}

async function seedScratch(): Promise<void> {
	// archives
	await insertRow(ARCHIVE, IW.archive, {
		relation: {
			[ARCHIVE_COINS]: [IW.coinA, IW.coinB, IW.coinC, IW.coinD].map((coin, index) =>
				locatorOf(COIN, coin, ARCHIVE_COINS, index + 1),
			),
		},
	});
	await insertRow(ARCHIVE, IW.archiveEmpty, {});
	await insertRow(ARCHIVE, IW.archiveStored, {
		misc: { [ARCHIVE_INFO]: STORED_ARCHIVE_VALUE },
	});
	// coins — shared by get_archive_weights (ARCHIVE host) and
	// get_coins_by_period (HOARD host); branch table in the header.
	await insertRow(COIN, IW.coinA, {
		relation: {
			[COIN_USED]: [locatorOf(MINT, 1, COIN_USED)],
			[COIN_PERIOD]: [locatorOf(PERIOD, 187, COIN_PERIOD)],
		},
		number: {
			[COIN_WEIGHT]: [
				{ id: 1, value: 3.2 },
				{ id: 2, value: 3.4 },
			],
			[COIN_DIAMETER]: [{ id: 1, value: 17 }],
		},
	});
	await insertRow(COIN, IW.coinB, {
		relation: {
			[COIN_USED]: [locatorOf(MINT, 1, COIN_USED)],
			[COIN_PERIOD]: [locatorOf(PERIOD, 1, COIN_PERIOD)],
		},
		number: { [COIN_WEIGHT]: [{ id: 1, value: 5.0 }] },
	});
	await insertRow(COIN, IW.coinC, {
		relation: {
			[COIN_USED]: [locatorOf(MINT, 2, COIN_USED)],
			[COIN_DUPLICATED]: [locatorOf(MINT, 2, COIN_DUPLICATED)],
		},
		number: { [COIN_WEIGHT]: [{ id: 1, value: 99 }] },
	});
	await insertRow(COIN, IW.coinD, {});
	// hoard + its LOCATION twin (pairs by SHARED section_id)
	await insertRow(HOARD, IW.hoard, {
		relation: {
			[HOARD_COINS]: [IW.coinA, IW.coinB, IW.coinC, IW.coinD].map((coin, index) =>
				locatorOf(COIN, coin, HOARD_COINS, index + 1),
			),
		},
	});
	await insertRow(LOCATION, IW.hoard, { data: {} });
	// tags
	await insertRow(MEDIA_RESOURCE, IW.tagsRecord, {
		string: { [TRANSCRIPTION]: [{ id: 1, lang: 'lg-spa', value: TAGS_TEXT }] },
	});
	// state (REAL seed vocabulary records: dd501/2, dd174/1)
	await insertRow(MEDIA_RESOURCE, IW.stateRecord, {
		relation: {
			[STATE_CHECK]: [locatorOf(STATE_VOCABULARY, 2, STATE_CHECK)],
			[STATE_SELECT]: [locatorOf(VALIDATION_VOCABULARY, 1, STATE_SELECT)],
		},
	});
	// media_icons + descriptors chain
	await insertRow(TAPE, IW.tape, {
		relation: {
			[INDEXATION]: [locatorOf(PERIOD, 187, INDEXATION), locatorOf(PERIOD, 3, INDEXATION, 2)],
		},
		string: { [DURATION]: [{ id: 1, lang: 'lg-nolan', value: '00:42:07' }] },
	});
	await insertRow(INTERVIEW, IW.interview, {
		relation: { [AV_PORTAL]: [locatorOf(TAPE, IW.tape, AV_PORTAL)] },
	});
	// tc slow path: tape WITHOUT the cached duration
	await insertRow(TAPE, IW.tapeSlow, {});
	await insertRow(INTERVIEW, IW.interviewSlow, {
		relation: { [AV_PORTAL]: [locatorOf(TAPE, IW.tapeSlow, AV_PORTAL)] },
	});
	// user_activity (matrix_users — PHP fixed-case table)
	await insertRow(USERS, IW.userActivity, {});
	// calculation
	await insertRow(CALC_SECTION, IW.calc, {
		number: { [CALC_NUMBER]: [{ id: 1, value: 40.5 }] },
	});
	await insertRow(CALC_SECTION, IW.calcEmpty, {});
	// test_info placeholder: an EMPTY test3 record (no test52 → deterministic
	// placeholder string encoding the section context)
	await insertRow(TEST3, IW.emptyTest3, {});
	// the PERIOD term chain (see PERIOD_TERM_MATCHED doc): two term records
	// with the default hierarchy25 label slice, and the hierarchy1 registry
	// root whose hierarchy45 seeds the coins-by-period root walk. The registry
	// row carries NO hierarchy4 active flag on purpose — the area boot query
	// filters on it, so this root is invisible to the tree-area gates.
	await insertRow(PERIOD, PERIOD_TERM_MATCHED, {
		string: { [TERM_COMPONENT]: [{ id: 1, lang: 'lg-spa', value: 'Periodo' }] },
	});
	await insertRow(PERIOD, PERIOD_TERM_MEDIEVAL, {
		string: { [TERM_COMPONENT]: [{ id: 1, lang: 'lg-spa', value: 'Edad Media' }] },
	});
	await insertRow(HIERARCHY_REGISTRY, IW.periodRegistry, {
		string: { hierarchy53: [{ id: 1, lang: 'lg-nolan', value: PERIOD }] },
		relation: {
			hierarchy45: [locatorOf(PERIOD, PERIOD_TERM_MATCHED, 'hierarchy45')],
		},
	});
	// The four ACTIVE hierarchy rows behind the media_icons descriptor grid's
	// dynamic columns: rsc860's sqo resolves {source:'hierarchy_types'} through
	// the ACTIVE registry (resolveHierarchySectionsFromTypes — hierarchy4
	// dd64/1 + hierarchy9 typology match), and each resolved target section
	// contributes its section_map thesaurus.term as a column. The capture
	// install had these active; the suite database ships only the language
	// hierarchies, which collapsed the golden's 5 columns to 1. Seeded AFTER
	// the language rows by section_id, so the column order matches the golden
	// (term, immovable, PORTAL term, web, mint).
	await buildPortalTermSection();
	for (const [registryId, target] of [
		[IW.immovableRegistry, 'testimmovable1'],
		[IW.portalTermRegistry, PORTAL_TERM_SECTION],
		[IW.webRegistry, 'testweb1'],
		[IW.mintRegistry, 'testmint1'],
	] as const) {
		await insertRow(HIERARCHY_REGISTRY, registryId, {
			string: { hierarchy53: [{ id: 1, lang: 'lg-nolan', value: target }] },
			relation: {
				hierarchy4: [locatorOf('dd64', 1, 'hierarchy4')],
				// typology 4 — one of rsc860's declared hierarchy_types (1,2,4,…).
				hierarchy9: [locatorOf('hierarchy13', 4, 'hierarchy9')],
			},
		});
	}
	// These raw INSERTs bypass the write chokepoint, so the derived caches
	// (hierarchySectionsCache, gridColumnsCache) primed by earlier files in the
	// same process would serve the pre-seed world — drop them all.
	const { clearOntologyDerivedCaches } = await import(
		'../../src/core/ontology/cache_invalidation.ts'
	);
	await clearOntologyDerivedCaches();
}

/**
 * THE GOLDENS ARE ORACLE-CAPTURED, so they are READ IN TEST TERMS, never
 * rewritten: the fixture bytes still speak the installation the capture was
 * taken against, and regenerating them from today's engine would throw away the
 * very record that makes them an oracle. Same discipline as the parity seam
 * (test/parity/normalize.ts adoptTipoIdMap, WC-2026-08-19-test-tld-replay) — the
 * translation happens at COMPARISON time, from the committed, append-only clone
 * map, and it REFUSES to be vacuous: adoptGolden counts what it rewrote and
 * every case either shows a non-zero count or PROVES there was nothing to
 * translate.
 */
const CLONE_MAP = cloneMapJson as { map: Record<string, { target: string }> };
/**
 * NOT `\b`-delimited: the widgets build COMPOSITE ids (`rsc167_rsc860_dc1`) and
 * `_` is a word character, so a `\b` boundary never fires between the pieces and
 * every composite id would survive the translation untouched.
 */
const TIPO_TOKEN_RE = /(?<![A-Za-z0-9])[a-z]+\d+(?![A-Za-z0-9])/g;
/**
 * The two SEED-SHIPPED sections this gate moved its records to. They have no
 * clone-map entry — `rsc` ships with every installation, so the migration was a
 * choice of generic host, not a clone — and the goldens still name the ones the
 * capture used. Declared here so the translation is complete and readable.
 */
const SEED_SECTION_RENAMES: Record<string, string> = {
	[seed('rsc', 167)]: TAPE,
	[seed('rsc', 2)]: MEDIA_RESOURCE,
};

/** The twin of a captured tipo, or null when the token must stay as it is. */
function translationOf(tipo: string): string | null {
	return SEED_SECTION_RENAMES[tipo] ?? CLONE_MAP.map[tipo]?.target ?? null;
}

/** Every token in the captured bytes that this gate knows how to translate. */
function translatableTokens(json: string): string[] {
	return [...json.matchAll(TIPO_TOKEN_RE)]
		.map((match) => match[0])
		.filter((tipo) => translationOf(tipo) !== null);
}

/**
 * THE FIRST DECLARED CARVE-OUT (the second: ONTOLOGY DRIFT below), a translation rule rather than a
 * normalization: nothing is blurred, both sides are still compared verbatim.
 *
 * A media_icons tool column emits the section_tool node's `tool_config` ddo_map
 * with ONLY `section_id:'self'` expanded to the media record — `section_tipo`
 * stays exactly as the tool node DECLARES it (src/core/components/
 * component_info/widgets/oh/media_icons.ts). Those declarations name the
 * seed-shipped audiovisual section, and cloning never rewrote them because that
 * section has no twin. This gate hosts its media records on a generic `test`
 * section, so the declaration and the host legitimately differ now — the engine
 * repeats the declaration, and so must the golden. Recognised by the tool_config
 * ddo shape (a `role` + `tipo` + `section_id` + `section_tipo` entry) and by
 * nothing else: every other `section_tipo` in the projection IS translated, and
 * the count of preserved tokens is asserted so the carve-out cannot silently
 * widen or go vacuous.
 */
function isToolConfigDdo(node: Record<string, unknown>): boolean {
	return (
		typeof node.role === 'string' &&
		typeof node.tipo === 'string' &&
		typeof node.section_tipo === 'string' &&
		node.section_id !== undefined
	);
}

type AdoptionCounters = { rewrites: number; preserved: number };

function adoptNode(node: unknown, counters: AdoptionCounters): unknown {
	if (Array.isArray(node)) {
		return node.map((item) => adoptNode(item, counters));
	}
	if (node !== null && typeof node === 'object') {
		const source = node as Record<string, unknown>;
		const declaredScope = isToolConfigDdo(source);
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(source)) {
			if (declaredScope && key === 'section_tipo') {
				if (translationOf(String(value)) !== null) counters.preserved++;
				out[key] = value;
				continue;
			}
			out[key] = adoptNode(value, counters);
		}
		return out;
	}
	if (typeof node === 'string') {
		return node.replace(TIPO_TOKEN_RE, (tipo) => {
			const target = translationOf(tipo);
			if (target === null) return tipo;
			counters.rewrites++;
			return target;
		});
	}
	return node;
}

function adoptGolden(captured: unknown): { value: unknown } & AdoptionCounters {
	const counters: AdoptionCounters = { rewrites: 0, preserved: 0 };
	const value = adoptNode(structuredClone(captured), counters);
	return { value, ...counters };
}

/**
 * Translate a captured golden and PROVE the translation: it rewrote exactly the
 * tokens an independent scan found (minus the declared tool_config keeps), and
 * what it left behind is exactly those keeps and nothing else. A zero rewrite
 * count therefore only ever means the captured bytes held no install tipo at all
 * (the tags/state cases emit widget statistics, which name no section).
 */
function adoptedGolden(captured: unknown, options: { expectPreserved?: boolean } = {}): unknown {
	const expectedTokens = translatableTokens(JSON.stringify(captured));
	const adopted = adoptGolden(captured);
	expect(adopted.rewrites).toBe(expectedTokens.length - adopted.preserved);
	expect(translatableTokens(JSON.stringify(adopted.value)).length).toBe(adopted.preserved);
	if (options.expectPreserved === true) {
		expect(adopted.preserved).toBeGreaterThan(0);
	}
	return adopted.value;
}

let tsContext: ApiRequestContext;

function readRqo(
	sectionTipo: string,
	sectionId: number | string,
	componentTipo: string,
	mode: string,
): Record<string, unknown> {
	return {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		options: {},
		source: {
			typo: 'source',
			model: 'section',
			tipo: sectionTipo,
			section_tipo: sectionTipo,
			action: 'search',
			mode,
			lang: 'lg-spa',
		},
		sqo: {
			section_tipo: [sectionTipo],
			limit: 1,
			offset: 0,
			filter_by_locators: [{ section_tipo: sectionTipo, section_id: String(sectionId) }],
		},
		show: {
			ddo_map: [{ tipo: componentTipo, section_tipo: sectionTipo, parent: sectionTipo, mode }],
		},
	};
}

async function tsData(rqo: Record<string, unknown>): Promise<Record<string, unknown>[]> {
	const response = (await dispatchRqo(structuredClone(rqo) as never, tsContext as never)).body as {
		data?: { data?: unknown[] };
	};
	return (response.data?.data ?? []).slice(1) as Record<string, unknown>[];
}

async function tsEntries(rqo: Record<string, unknown>): Promise<unknown[]> {
	return (await tsData(rqo)).map((item) => item.entries);
}

/**
 * WC-2026-08-03-state-widget-total-source-count — the TS state widget adds
 * `items` (the total's own divisor: the source-record count) to every `total`
 * item; the PHP-captured goldens predate it. Strip before the deep-equal, and
 * COUNT what was stripped so the caller can assert the key is really there —
 * the goldens must never be regenerated from TS output, so a divergence has to
 * be absorbed here, and a normalizer that silently no-ops would turn the
 * divergence back into an undetected regression.
 */
function stripStateTotalItems(entries: unknown[]): number {
	let stripped = 0;
	for (const entry of entries) {
		if (!Array.isArray(entry)) continue;
		for (const item of entry) {
			const widgetItem = item as { widget?: unknown; type?: unknown; items?: unknown };
			if (widgetItem?.widget !== 'state' || widgetItem?.type !== 'total') continue;
			if (widgetItem.items === undefined) continue;
			stripped++;
			// The key must be GONE, not undefined — the golden compare below has to
			// see exactly the PHP-captured shape.
			// biome-ignore lint/performance/noDelete: removing the key IS the assertion
			delete (widgetItem as { items?: unknown }).items;
		}
	}
	return stripped;
}

/**
 * ONTOLOGY DRIFT SINCE THE CAPTURE — the second declared carve-out, and like the
 * first it is DERIVED, never typed. The 2026-07-10 capture saw INDEXATION
 * (seed-shipped `rsc`, so no twin) declare ONE sqo.section_tipo source,
 * `hierarchy_types`. Master's ontology has since added further sources (the
 * 2026-10-10 vendored release: an explicit `{source:'section'}` naming the
 * people section), and the engine — correctly, PHP resolve_get_ddo_map union —
 * appends each new target section's section_map thesaurus.term as extra grid
 * columns, AFTER the capture-era ones. The golden is the oracle record of the
 * capture-era ontology and is never regenerated, so those columns are removed
 * from the ENGINE side here, exactly: the drifted tipos are the term components
 * of the sections the live post-capture sources resolve to (production
 * resolveSqoSectionTipos + getSectionMapValue) MINUS the terms the capture-era
 * source still contributes, and only cells keyed `<host>_<INDEXATION>_…_<tipo>`
 * go. Every other byte of the grid is still compared verbatim, and the caller
 * asserts the strip is non-vacuous — when the drift is gone (or the release
 * reverts it) this carve-out goes red and must be deleted, not widened.
 */
const CAPTURE_INDEXATION_SQO_SOURCES: ReadonlySet<string> = new Set(['hierarchy_types']);

async function termTiposOf(sections: readonly string[]): Promise<Set<string>> {
	const tipos = new Set<string>();
	for (const section of sections) {
		const value = await getSectionMapValue(section, 'thesaurus', 'term');
		for (const tipo of Array.isArray(value) ? value : [value]) {
			if (typeof tipo === 'string' && tipo !== '') tipos.add(tipo);
		}
	}
	return tipos;
}

/** The grid column tipos the post-capture INDEXATION sources add (see above). */
async function postCaptureIndexationColumnTipos(hostSectionTipo: string): Promise<Set<string>> {
	const node = await getNode(INDEXATION);
	const config = (
		node?.properties as { source?: { request_config?: { sqo?: { section_tipo?: unknown } }[] } }
	)?.source?.request_config?.[0];
	const entries = Array.isArray(config?.sqo?.section_tipo) ? config.sqo.section_tipo : [];
	const isCaptureEra = (entry: unknown): boolean =>
		CAPTURE_INDEXATION_SQO_SOURCES.has(String((entry as { source?: unknown })?.source));
	const context = {
		ownerTipo: INDEXATION,
		ownerSectionTipo: hostSectionTipo,
		mode: 'edit',
		ownerIsSection: false,
	} as const;
	const captureTerms = await termTiposOf(
		await resolveSqoSectionTipos(entries.filter(isCaptureEra), context),
	);
	const driftTerms = await termTiposOf(
		await resolveSqoSectionTipos(
			entries.filter((entry: unknown) => !isCaptureEra(entry)),
			context,
		),
	);
	return new Set([...driftTerms].filter((tipo) => !captureTerms.has(tipo)));
}

/** Remove the drifted columns from the engine's entries; returns how many cells went. */
function stripPostCaptureColumns(
	node: unknown,
	hostSectionTipo: string,
	driftTipos: ReadonlySet<string>,
): number {
	const prefix = `${hostSectionTipo}_${INDEXATION}_`;
	const isDrift = (column: unknown): boolean => {
		const id = (column as { id?: unknown })?.id;
		if (typeof id !== 'string' || !id.startsWith(prefix)) return false;
		return [...driftTipos].some((tipo) => id.endsWith(`_${tipo}`));
	};
	let removed = 0;
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (let index = value.length - 1; index >= 0; index--) {
				const cell = value[index] as { type?: unknown; ar_columns_obj?: unknown };
				const columns = cell?.ar_columns_obj;
				if (
					cell?.type === 'column' &&
					Array.isArray(columns) &&
					columns.length === 1 &&
					isDrift(columns[0])
				) {
					value.splice(index, 1);
					removed++;
				} else {
					walk(cell);
				}
			}
			return;
		}
		if (value === null || typeof value !== 'object') return;
		const cell = value as { ar_columns_obj?: unknown; column_count?: unknown };
		if (Array.isArray(cell.ar_columns_obj) && cell.ar_columns_obj.length > 1) {
			const kept = cell.ar_columns_obj.filter((column) => !isDrift(column));
			const dropped = cell.ar_columns_obj.length - kept.length;
			if (dropped > 0) {
				cell.ar_columns_obj = kept;
				if (typeof cell.column_count === 'number') cell.column_count -= dropped;
				removed += dropped;
			}
		}
		for (const child of Object.values(value)) walk(child);
	};
	walk(node);
	return removed;
}

/** Deep-equal BOTH modes of one component read against the case golden. */
async function expectCaseGolden(
	caseName: keyof typeof golden.cases,
	sectionTipo: string,
	sectionId: number | string,
	componentTipo: string,
	options: {
		expectStateItems?: boolean;
		expectPreservedToolScope?: boolean;
		expectGridCells?: boolean;
		/** the INDEXATION grid's host section: strip + assert the post-capture drift */
		postCaptureGridHost?: string;
	} = {},
): Promise<void> {
	let renderClasses = 0;
	let driftCells = 0;
	const driftTipos =
		options.postCaptureGridHost === undefined
			? null
			: await postCaptureIndexationColumnTipos(options.postCaptureGridHost);
	for (const mode of ['list', 'edit'] as const) {
		const entries = await tsEntries(readRqo(sectionTipo, sectionId, componentTipo, mode));
		if (driftTipos !== null && options.postCaptureGridHost !== undefined) {
			driftCells += stripPostCaptureColumns(entries, options.postCaptureGridHost, driftTipos);
		}
		const stripped = stripStateTotalItems(entries);
		if (options.expectStateItems === true) {
			expect(stripped).toBeGreaterThan(0);
		}
		renderClasses += stripRenderClass(entries);
		expect(entries).toEqual(
			adoptedGolden(golden.cases[caseName][mode], {
				expectPreserved: options.expectPreservedToolScope,
			}) as never,
		);
	}
	if (driftTipos !== null) {
		expect(
			driftTipos.size,
			'the post-capture INDEXATION drift is gone — delete the carve-out',
		).toBeGreaterThan(0);
		expect(driftCells, `${caseName}: the drifted columns were really emitted`).toBeGreaterThan(0);
	}
	if (options.expectGridCells === true) {
		expect(renderClasses, `${caseName}: the additive render_class key was there`).toBeGreaterThan(
			0,
		);
	}
}

beforeAll(async () => {
	// The test_info + calculation cases read canonical test3 shapes (recs 1/27)
	// that client sweeps mutate — self-heal from the single verified source.
	await ensureCanonicalTest3();
	await sweepScratch(); // pre-clean a crashed prior run
	await seedScratch();
	const token = createSession(-1, 'root', true);
	const session = getSession(token);
	const principal = await resolvePrincipal(-1);
	tsContext = {
		requestId: 't',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal,
	} as ApiRequestContext;
}, 60000);

afterAll(async () => {
	// A seeded scratch row that deletes NOTHING means the fixed id collided or
	// the DELETE targeted the wrong matrix table (matrix_users lesson) — clean
	// everything we can, then fail loudly rather than silently leak/mask.
	const counts = await sweepScratch();
	await deleteTldNodes(PORTAL_TERM_TLD); // fires the hub
	// The seeded ACTIVE hierarchy rows are gone — drop the derived caches again
	// so later files never resolve hierarchy_types against the seeded world.
	const { clearOntologyDerivedCaches } = await import(
		'../../src/core/ontology/cache_invalidation.ts'
	);
	await clearOntologyDerivedCaches();
	const missing = [...counts.entries()].filter(([, count]) => count === 0).map(([key]) => key);
	if (missing.length > 0) {
		throw new Error(
			`Scratch cleanup deleted 0 rows for: ${missing.join(', ')} — seed vanished mid-run or wrong table.`,
		);
	}
});

describe('component_info widget read-time compute (TS-native, oracle-captured goldens)', () => {
	test('golden integrity floors: every pinned semantic is IN the fixture', () => {
		// Guards a truncated/regenerated fixture; engine assertions are the
		// per-case deep-equals below. Read in ADOPTED terms — the whole fixture is
		// translated exactly as each case is, and the translation of the whole must
		// be non-vacuous or the migration has silently stopped translating.
		const adopted = adoptGolden(golden.cases);
		expect(adopted.rewrites).toBeGreaterThan(0);
		const json = JSON.stringify(adopted.value);
		for (const marker of [
			// WC-026: live + stored items carry BOTH id and widget_id
			'"widget_id":"media_weight"',
			'"id":"media_weight"',
			// tags: the raw text item LEADS, then the stat items
			'"widget":"tags"',
			'"widget_id":"total_missing_tags"',
			// coins: the term match and the '?' catch-all sentinel
			'"label":"?"',
			`"section_tipo":"${PERIOD}"`,
			// media_icons: real tool_context (not {})
			'"tool_config"',
			'"widget":"media_icons"',
			// descriptors: the merged dd_grid terms value
			'"widget":"descriptors"',
			// state: detail + total rows
			'"type":"detail"',
			'"type":"total"',
			// test_info: the true placeholder fallback string
			`test_info widget value for section ${TEST3} - ${IW.emptyTest3}`,
		]) {
			expect(json).toContain(marker);
		}
		// state datalist is non-vacuous (the client TypeErrors without it)
		expect(Array.isArray(golden.state_edit_datalist[0])).toBe(true);
		expect((golden.state_edit_datalist[0] as unknown[]).length).toBeGreaterThan(0);
	});

	test('get_archive_weights: a STORED misc value is IGNORED — the live compute is served', async () => {
		// WC-2026-09-03-info-stored-value-never-served: the record carries a
		// full, well-formed stored bag (STORED_ARCHIVE_VALUE) and NO coins, so
		// the two branches disagree loudly — the oracle served the stored bag
		// (golden `archive_stored`, kept as the record of what PHP did), this
		// engine serves the live compute over the empty source, i.e. exactly what
		// the `archive_empty` case serves. Both halves asserted: the served value
		// equals the live one AND the stored bytes are absent from the wire.
		for (const mode of ['list', 'edit'] as const) {
			const entries = await tsEntries(readRqo(ARCHIVE, IW.archiveStored, ARCHIVE_INFO, mode));
			expect(entries).toEqual(adoptedGolden(golden.cases.archive_empty[mode]) as never);
			expect(JSON.stringify(entries)).not.toContain('"media_weight"');
		}
		// The oracle's stored-branch golden is what was REPEALED — it must differ
		// from what is served now, or this test pins nothing.
		expect(adoptedGolden(golden.cases.archive_stored.list)).not.toEqual(
			adoptedGolden(golden.cases.archive_empty.list) as never,
		);
	}, 30000);

	test('get_archive_weights: live fallback compute over the scratch coins', async () => {
		await expectCaseGolden('archive_live', ARCHIVE, IW.archive, ARCHIVE_INFO);
	}, 30000);

	test('get_archive_weights: empty source portal → entries []', async () => {
		await expectCaseGolden('archive_empty', ARCHIVE, IW.archiveEmpty, ARCHIVE_INFO);
	}, 30000);

	test('test_info: canonical source values (full-array get_data quirk) + placeholder fallback', async () => {
		await expectCaseGolden('test_info_value', TEST3, 1, 'test212');
		await expectCaseGolden('test_info_27', TEST3, 27, 'test212');
		await expectCaseGolden('test_info_placeholder', TEST3, IW.emptyTest3, 'test212');
	}, 30000);

	test('tags: transcription statistics (state-letter pair semantics)', async () => {
		await expectCaseGolden('tags', MEDIA_RESOURCE, IW.tagsRecord, TAGS_INFO);
	}, 30000);

	test('get_coins_by_period: direct grouping (use_parent false)', async () => {
		await expectCaseGolden('coins_direct', LOCATION, IW.hoard, COINS_DIRECT);
	}, 30000);

	test('get_coins_by_period: parent roll-up (use_parent true)', async () => {
		await expectCaseGolden('coins_rollup', LOCATION, IW.hoard, COINS_ROLLUP);
	}, 30000);

	test('media_icons + descriptors: icon rows, tool_context, term grid', async () => {
		await expectCaseGolden(MEDIA_ICONS_CASE, INTERVIEW, IW.interview, MEDIA_ICONS, {
			// the declared tool_config carve-out is REAL here (see adoptedGolden)
			expectPreservedToolScope: true,
			// the descriptors term grid carries the additive render_class per cell
			expectGridCells: true,
			// master's INDEXATION gained grid sources after the capture (see above)
			postCaptureGridHost: TAPE,
		});
	}, 60000);

	test('user_activity: async widget skipped at read (entries [])', async () => {
		await expectCaseGolden('user_activity', USERS, IW.userActivity, USER_ACTIVITY_INFO);
	}, 30000);

	test('calculation: summarize with EMPTY inputs (total 0) + the formula cases', async () => {
		await expectCaseGolden('calc_empty', CALC_SECTION, IW.calcEmpty, CALC_INFO);
		await expectCaseGolden('calc_to_euros', TEST3, 1, 'test178');
		await expectCaseGolden('calc_period', TEST3, 1, 'test179');
	}, 30000);

	test('calculation defect pin (TS side): non-empty input serves [] — PHP crashes here', async () => {
		// (!) The PHP array_sum crash is pinned in the parity differential; TS
		// computes nothing (sane convergent behavior). When PHP gets fixed the
		// DIFFERENTIAL flags it — then implement the real summarize sum in
		// computeCalculation, reconcile, and recapture this golden set.
		const entries = await tsEntries(readRqo(CALC_SECTION, IW.calc, CALC_INFO, 'list'));
		expect(entries).toEqual([[]] as never);
	}, 30000);

	test('state: detail + total items over the dd501/dd174 vocabularies', async () => {
		// expectStateItems: the WC-2026-08-03 divisor must be ON the total items
		// (the strip is what keeps the PHP-captured golden usable — see it).
		await expectCaseGolden('state', MEDIA_RESOURCE, IW.stateRecord, STATE_INFO, {
			expectStateItems: true,
		});
	}, 30000);

	test("state: `items` is the total's divisor — one source record, one row", async () => {
		// WC-2026-08-03-state-widget-total-source-count. The state component's IPO
		// reads `self` paths, so the source-locator count is 1 and every total is
		// its own detail. The pin that matters is the RELATION between the three
		// numbers: value === sum(details) / items. A record whose sources outnumber
		// its saved values (two audiovisuals, one transcribed) is what produced the
		// 50%-detail-under-a-25%-total report — with `items` the client can tell
		// the difference; without it, it cannot.
		const entries = (await tsEntries(
			readRqo(MEDIA_RESOURCE, IW.stateRecord, STATE_INFO, 'edit'),
		)) as Record<string, unknown>[][];
		const items = entries.flat().filter((item) => item.widget === 'state');
		const totals = items.filter((item) => item.type === 'total');
		expect(totals.length).toBeGreaterThan(0);
		for (const total of totals) {
			// present, integer, and never a division by zero
			expect(typeof total.items).toBe('number');
			expect(total.items as number).toBeGreaterThan(0);
			expect(Number.isInteger(total.items)).toBe(true);
			// the emitted value IS sum(details of this column+id) / n / items;
			// n is 1 here (non-translatable leaves), so the divisor is `items`
			const details = items.filter(
				(item) =>
					item.type === 'detail' &&
					item.widget_id === total.widget_id &&
					item.column === total.column &&
					item.key === total.key,
			);
			const sum = details.reduce((acc, item) => acc + Math.trunc(Number(item.value) || 0), 0);
			expect(total.value).toBe(Math.round((sum / (total.items as number)) * 100) / 100);
		}
		// detail items are NOT dualised with the divisor — it belongs to the
		// aggregate alone (a per-source row has nothing to average)
		for (const detail of items.filter((item) => item.type === 'detail')) {
			expect(detail.items).toBeUndefined();
		}
	}, 30000);

	test('state EDIT datalist: the merged vocabulary option lists (client hard-requires it)', async () => {
		const datalist = (
			await tsData(readRqo(MEDIA_RESOURCE, IW.stateRecord, STATE_INFO, 'edit'))
		).map((item) => item.datalist);
		expect(datalist).toEqual(adoptedGolden(golden.state_edit_datalist) as never);
	}, 30000);

	test('tc SLOW PATH: TS emits 00:00:00.000 and NEVER writes back during the read', async () => {
		const entries = (await tsEntries(
			readRqo(INTERVIEW, IW.interviewSlow, MEDIA_ICONS, 'list'),
		)) as {
			tc?: { value?: unknown };
		}[][];
		expect(entries[0]?.[0]?.tc?.value).toBe('00:00:00.000');
		expect(entries).toEqual(
			adoptedGolden(golden.tc_slow_list_entries, { expectPreserved: true }) as never,
		);
		// READ-NO-WRITE (deliberate divergence — PHP persists the probed tc
		// during the read; that write-back stays pinned in the differential)
		const after = (await sql.unsafe(
			`SELECT string->'${DURATION}' AS v FROM ${await tableOf(TAPE)} WHERE section_tipo = $1 AND section_id = $2`,
			[TAPE, IW.tapeSlow],
		)) as { v: unknown }[];
		expect(after[0]?.v ?? null).toBeNull();
	}, 30000);
});
