/**
 * Shape contract for the canonical test3 fixture (test3_canonical.json).
 *
 * The `test3` playground section (matrix_test) is the substrate for the
 * component test suites (unit, parity and the byte-identical client harness).
 * This manifest pins WHAT the canonical records must contain so the fixture
 * stays load-bearing: test/unit/test3_canonical_fixture.test.ts fails when the
 * fixture stops satisfying it, and when the test3 section ontology grows a
 * component nobody made a fixture decision for.
 *
 * Consumers: scripts/capture_test3_fixture.ts (record set), seed.ts (restore
 * targets), the canonical gate (all predicates).
 */

export const CANONICAL_SECTION_TIPO = 'test3';
export const CANONICAL_TABLE = 'matrix_test';

/**
 * The BASE record set — the LIVE, hand-captured records
 * (scripts/capture_test3_fixture.ts reads exactly these).
 *  - 1  — THE component playground record (rich: every covered component).
 *  - 2  — the client harness portal-host record (test_component_portal saves
 *         into it; rewrite/client_tests.md).
 *  - 27 — the info-widget placeholder-fallback record (its test52 holds a
 *         single lg-spa item; test/parity/info_widget_differential.test.ts).
 */
export const BASE_RECORD_IDS = [1, 2, 27] as const;

/** The clone source (record 1: the rich, every-component playground record). */
export const CLONE_SOURCE_ID = 1 as const;

/**
 * PER-SUITE ISOLATION records (WC-021 in-run isolation): CLONES of record 1
 * that give write-heavy / run-order-fragile client suites their OWN test3
 * record, so a write-sweep stops mutating the record another suite is
 * asserting against (the run-order-flake class — rewrite/LEDGER.md in-run
 * isolation row). elements.js binds each suite to its id here; the seed
 * materializes these as deep copies of record 1 (same component shapes → the
 * manifest/hole-check semantics extend by construction). Kept < CLONE-count
 * minimal: only the suites that actually collide get an id.
 */
export const SUITE_ISOLATION_RECORDS: Readonly<Record<number, string>> = {
	10: 'test_components_data_changes — the all-component save SWEEP (clears+inserts every element); off record 1 so its random values never poison a read suite',
	11: 'test_component_date — run-order-flaky date read suite (client_tests.md); its own record removes the shared-test3/1 date pollution that stalled its render',
	12: 'test_component_iri — iri read/label-dataframe suite; own record hardens it against the save sweep (defensive, matches date)',
	13: 'test_component_publication — write-heavy add/remove/update relation-locator suite; several of its cases add a stray test92 locator without cleanup or remove by index instead of by locator, permanently growing whatever record they target. Own record isolates that accumulation from the shared record 1 the generic component sweeps (test_component_full et al.) render, whose contract is zero-or-one value.',
	14: 'test_component_geolocation — write-heavy suite whose saves append a new test100 entry whenever the targeted key holds no id, and whose removes leave a null in the slot. On the shared record 1 the geo array grew to [null,{…},null,…] across runs, after which the suite asserted entries[0] against a null hole and failed on run order alone. Own record + teardown keeps the growth out of the record the generic sweeps render.',
	15: 'test_component_3d — write-heavy suite whose add/update/remove chain ends on a REMOVE with no teardown, leaving media.test26 as [] on whatever record it targets. On the shared record 1 that served an EMPTY 3d component to every generic sweep that renders it. Own record + teardown keeps the emptying out of the canonical record.',
	16: 'test_additional_text_area — the text_area+geolocation / text_area+image pairing suite (migrated off the `dmm` install ontology 2026-08-22). It ACTIVATES the editor and SAVES test84/test98 on every run; own record keeps that written text out of the record the generic sweeps render.',
};

/** The per-suite clone ids, ascending. */
export const CLONE_RECORD_IDS: readonly number[] = Object.keys(SUITE_ISOLATION_RECORDS)
	.map(Number)
	.sort((a, b) => a - b);

/**
 * The full canonical record set the seed provisions and the gate verifies =
 * live-captured base + per-suite clones. Capture reads BASE_RECORD_IDS only;
 * seed/restore/reset and the tripwire cover this whole set.
 */
export const CANONICAL_RECORD_IDS: readonly number[] = [
	...BASE_RECORD_IDS,
	...CLONE_RECORD_IDS,
].sort((a, b) => a - b);

/**
 * Columns whose keys are component tipos — the coverage universe. `data` is
 * record metadata (label, created_date, …), `meta` holds per-tipo id counters
 * and `relation_search` is a derived index: captured verbatim, not
 * coverage-counted.
 */
export const COMPONENT_DATA_COLUMNS = [
	'relation',
	'string',
	'date',
	'iri',
	'geo',
	'number',
	'media',
	'misc',
] as const;

/**
 * test3-section components DELIBERATELY absent from (or empty in) the
 * canonical fixture. The coverage gate requires every component of the test3
 * ontology subtree to be either populated on record 1 or listed here — adding
 * a component to the section forces a fixture decision.
 */
export const LEDGERED_EMPTY_TIPOS: Readonly<Record<string, string>> = {
	test25: 'component_relation_index — index locators are written by tag-indexing tools on demand',
	test54:
		'component_relation_related — no canonical related record; write tests provision their own',
	test60:
		'component_dataframe — frames pair with a master item; dataframe gates provision their own',
	test68: 'component_inverse — computed from inverse relations at read, nothing stored',
	test71: 'component_relation_parent — parent/children pairs are created by guard tests on demand',
	test201: 'component_relation_children — see test71',
	test169:
		'component_relation_model — targets dd922 records and the shared dev DB has none; no canonical value',
	test212: 'component_info — computes from its source (test52) at read, nothing stored',
	test215: 'component_external — value comes from an external service, no canonical stored value',
};

/**
 * test3 components PARKED UNDER the `box elements` container test115 — OUTSIDE
 * the section by THE SECTION CONTAINMENT LAW (ontology/resolver.ts, T2-SL-3a,
 * owner ruling (b) 2026-11-21: the v6 law, everywhere). No section walker
 * returns them (edit form, search, declared components, the record wipe), so
 * they are not coverage-counted; the fixture may still STORE them — the
 * record keeps what it holds (delete_data leaves data of box-parked
 * components, as v6) and the pair check still admits a root read/write. The
 * coverage gate asserts each one IS in test3's structural subtree and is NOT
 * in its section subtree — the reason it is listed here.
 */
export const OUTSIDE_SECTION_TIPOS: Readonly<Record<string, string>> = {
	test97:
		'component_text_area — pdf transcription text with [page-n] tag markup (stored on record 1: REQUIRED_SHAPES)',
	test56: 'component_relation_related — secondary related slot, same as test54',
	test204: 'component_portal — auxiliary portal slot, no canonical content',
	test205:
		'component_autocomplete_hi — hierarchical picker exercised against real hierarchies, not stored here',
	test9: 'component_autocomplete_hi — see test205',
	test84: 'component_text_area — geo tag-source slot (observed by test100), no canonical text',
	test98:
		'component_text_area — image draw-tag source slot (observed by test99), no canonical text',
	test162: 'component_input_text — auxiliary input, no canonical value',
	test166: 'component_input_text — auxiliary input, no canonical value',
	test172: 'component_date — auxiliary date slot, no canonical value',
	test173: 'component_date — auxiliary date slot, no canonical value',
	test174: 'component_date — auxiliary date slot, no canonical value',
};

/**
 * Fixture component keys that are NOT part of the test3 ontology subtree —
 * the inverse (no-orphan-keys) check admits exactly these.
 */
export const EXTRA_COMPONENT_TIPOS: Readonly<Record<string, string>> = {
	dd197: 'created_by_user audit component (global section metadata, outside the subtree)',
	dd199: 'created_date audit component (global section metadata)',
	dd200: 'modified_by_user audit component (global section metadata)',
	dd201: 'modified_date audit component (global section metadata)',
	test139:
		'component_number calc source of the test178/test179 info widgets — its ontology home is ' +
		'section test65, but the calculations read it from the CURRENT (test3) record',
};

/** One pinned shape the fixture must exhibit (interpreted by the gate). */
export interface RequiredShape {
	readonly sectionId: (typeof CANONICAL_RECORD_IDS)[number];
	readonly column: (typeof COMPONENT_DATA_COLUMNS)[number];
	readonly tipo: string;
	/** Exact set of item langs when the shape is lang-sensitive. */
	readonly langs?: readonly string[];
	readonly why: string;
}

/**
 * Load-bearing shapes: gates in test/parity and the client harness depend on
 * these existing exactly so. A change here must reconcile the listed gate the
 * same day.
 */
export const REQUIRED_SHAPES: readonly RequiredShape[] = [
	{
		sectionId: 1,
		column: 'string',
		tipo: 'test52',
		langs: ['lg-eng'],
		why: 'test212 info source; info_widget_differential pins the full-array lg-eng-only quirk',
	},
	{
		sectionId: 27,
		column: 'string',
		tipo: 'test52',
		langs: ['lg-spa'],
		why: 'info_widget_differential placeholder-fallback record (single lg-spa item)',
	},
	{
		sectionId: 1,
		column: 'number',
		tipo: 'test139',
		why: 'input of the test178 (to_euros) and test179 (calculate_period) calculation widgets',
	},
	{
		sectionId: 1,
		column: 'date',
		tipo: 'test145',
		why:
			'component_date playground value (client date suite renders it); must be hole-free — the ' +
			'null-hole read path is pinned by test/unit/component_data_null_filter.test.ts instead',
	},
	{
		sectionId: 1,
		column: 'media',
		tipo: 'test26',
		why: 'component_3d playground media (file exists under MEDIA_PATH /3d/original/0/)',
	},
	{
		sectionId: 1,
		column: 'media',
		tipo: 'test85',
		why: 'component_pdf playground media',
	},
	{
		sectionId: 1,
		column: 'media',
		tipo: 'test94',
		why: 'component_av playground media',
	},
	{
		sectionId: 1,
		column: 'media',
		tipo: 'test99',
		why: 'component_image playground media',
	},
	{
		sectionId: 1,
		column: 'media',
		tipo: 'test177',
		why: 'component_svg playground media',
	},
	{
		sectionId: 1,
		column: 'string',
		tipo: 'test97',
		why: 'pdf transcription text_area with [page-n] tag markup (tag-aware read paths)',
	},
] as const;
