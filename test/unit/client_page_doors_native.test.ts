/**
 * READ-4 — EVERY DOOR THAT HANDS A CLIENT PAGE TO THE RELATION SINK BOUNDS IT.
 *
 * The relation sink (`search/search_related.ts` findInverseReferences /
 * findInverseReferenceLocators) renders whatever window it is given. Three
 * doors handed it the CLIENT's sqo window raw:
 *   - read / get_relation_list and read / related_search (section/read_facade.ts)
 *     mapped `limit: 0` AND an absent limit to `false` = UNBOUNDED, passed any
 *     string straight through (`'all'` → `LIMIT NaN` → a raw Postgres 500) and
 *     never clamped the offset (`1e21` → `OFFSET 1e+21` → 500);
 *   - get_indexation_grid (api/handlers/dd_core_api.ts) forwarded rqo.sqo raw
 *     (default 500, no ceiling).
 * The ONE-clamp law (DEC-07) says a client window is clamped to
 * CLIENT_MAX_LIMIT — a 200 with a visible clamp, never an unbounded read and
 * never a refusal.
 *
 * THE OUTCOME PINNED. With the ceiling pinned to 3 (this file runs in its own
 * process — `ISOLATED_GATE_ENV`, test/helpers/isolated_gate.ts — because
 * CLIENT_MAX_LIMIT is read once at module load), against a host referenced by
 * SIX records that this file builds:
 *   - every hostile limit {absent, null, 0, 'all', -1, 'x', 1e9, 1e21} × offset
 *     {absent, -5, 'x', 1e21, MAX_SAFE_INTEGER - 1, MAX_SAFE_INTEGER} is
 *     answered 200 with AT MOST 3 records — exactly 3 at offset 0 (the clamp
 *     goes to the CEILING, not to 1), 0 past the end —
 *     or refused at the WIRE (request.invalid_rqo) when the wire schema rejects
 *     the value, the way server.ts parses every body; never a 500;
 *   - the `search.page_clamped` notice is on the envelope EXACTLY when a value
 *     the client SENT was changed (`'clamped'`), or when a DEFAULTED page (no
 *     limit sent) actually cut rows (a row the caller may see exists past the
 *     served window — the door's own question; the relation doors used to mean
 *     "all" by an absent limit, so a truncation by the default must be
 *     visible). The SAME rule on all three doors, the grid included;
 *   - and ONLY then: an absent limit whose answer is whole (offset 3 = exactly
 *     the last full page, offset 4 = a short one) carries NO notice — the
 *     client toasts every notice, and the tools that send no limit must not
 *     warn on every record they open;
 *   - controls: an honoured window (limit 2, offset 0 / 4) returns exactly that
 *     window and NO notice;
 *   - THE NOTICE IS SCOPED (AUTHZ-05): a NON-ADMIN who may read the host AND
 *     the referencing section, but none of the six referencing RECORDS (each
 *     carries the suite's second project, the reader holds only its own), gets,
 *     at the very cell where the admin is owed the notice (absent limit,
 *     offset 0: rows past the window exist), zero records and NO notice — the
 *     next page holds nothing it may see. An unscoped "anything past?" probe
 *     would answer for records it cannot reach: a binary search on the offset
 *     reads the host's exact unscoped reference count. The reader is the ACL
 *     identity fixture's (930002) with read grants on the zzpg sections added;
 *     the relation doors are addressed with the referencing section named
 *     (since D3, 2026-10-21, a non-admin may also send ['all'] — Gate B gates
 *     the HOST of a related sqo; related_scope_equivalence_native pins that);
 *   - THE PROBE LOOKS PAST THE PAGE (HOST2): for the same reader, where the
 *     unscoped next window opens on a hidden record with a visible one behind
 *     it, or is WHOLLY hidden with a visible record after it, the visible
 *     record is never lost. On the RELATION doors the page is a window of the
 *     reader's SCOPED records (D1 — hidden rows take no window slot), owed the
 *     notice exactly when more of them lie past it; on the GRID (which windows
 *     its groups before scoping) the visible rows of the unscoped window, owed
 *     the notice when a visible group lies anywhere past it (a probe of one
 *     window, or of one row, called those answers whole and dropped the visible
 *     records silently); nothing past the page owes none;
 *   - THE PROBE ASKS THE PAGE'S QUESTION: a request (all three doors) narrowed to a
 *     second referencing section (zzpg11, fewer rows than the ceiling) gets a
 *     whole page and no notice, while the same host unnarrowed is owed one — a
 *     probe that dropped the owning-section narrowing would count the other
 *     section's rows;
 *   - THE PROBE IS BOUNDED (the long tail): for the same reader, a default
 *     page over a hidden tail of 250 records (far past the 64 × limit window a
 *     windowed probe grew to) costs exactly the statements and rows of one over
 *     a four-record hidden tail, and a visible record AFTER that tail is still
 *     found (owed the notice) — the tail is asked one scoped question in SQL
 *     (relation doors: search_related anyInverseReferencePast through
 *     record_scope rowScopeFor; grid: record_scope anyRowInScope), never read;
 *     a window loop or a row budget reddens here;
 *   - THE SET-SHAPED SCOPE IS THE LIST'S: anyRowInScope answers record by record
 *     what scopeInverseReferenceHits answers, for the reader and the admin, with
 *     the projects filter, the section grant and a dd478 allow-list each
 *     deciding at least one reader cell; and its PER-RECORD half
 *     (buildRowsInScopeSql), with the granted list FORCED so the SQL alone
 *     decides, KEEPS, on single rows AND multi-row sets, exactly the rows the
 *     list's predicate keeps (isRecordInScope over the granted rows) — the Users root
 *     exclusion, the section_tipo join, the per-section guard of a mixed set,
 *     a projects-filter-EXEMPT table carrying a component_filter (zzpg18,
 *     matrix_list) and an empty granted list each decide a cell; a row naming
 *     no section is no record;
 *   - THE GRID'S SECTION_TOP TWIN: the SQL projection the past probe asks
 *     (sectionTopProjection) names, stored shape by stored shape, the record the
 *     page scopes each group as (groupBySectionTop → sectionTopGroupHits) — or,
 *     only for forms the strict-integer rule refuses, none; and end to end,
 *     three hosts whose row past the page has an owner and a section_top that
 *     disagree for the reader (HOST3 owner visible / top hidden, HOST4 owner
 *     hidden / top visible, HOST5 top in an unreadable section) get the notice
 *     exactly when the TOP AND the row's OWN record are the reader's (the page
 *     withholds a row whose indexing record is out of scope —
 *     WC-2026-11-10-indexation-grid-read-door, row record scope);
 *   - A DDO-BORNE WINDOW: a section read's literal show.ddo_map naming a
 *     component_relation_index with a hostile `limit` (0, over the ceiling,
 *     MAX_SAFE_INTEGER) emits at most the ceiling of inverse locators, its
 *     pagination naming the limit applied — on BOTH emission strategies (no
 *     request_config: zzpg2; its own request_config: zzpg17);
 *   - THE WINDOWED SINK NEVER OVER-FETCHES: under the query tap, no statement
 *     issued from `search_related.ts` on a windowed-sink door
 *     (findInverseReferences: get_relation_list, related_search) returns more
 *     than CEILING + 1 rows — a fetch-all-then-slice, or an unbounded `more`
 *     probe, reddens here even when the visible answer is right. The BREAKDOWN
 *     sink (findInverseReferenceLocators: get_indexation_grid, the generic
 *     read's relation_index get_data) first runs its owner-plan probe, bounded
 *     by its OWN fixed owner cap (ownerCap + 1, independent of any client
 *     window — search_related.ts STEP 1), so its doors are NAMED in
 *     BREAKDOWN_SINK_DOORS and held to the visible bound only. Measured through
 *     the tap's per-caller `maxRows` (Lane 1 integrator request 3); a tap
 *     without it is red, never skipped.
 *
 * THE DOOR SET IS DERIVED, NOT LISTED. Every non-mutating door of
 * `READ_DOOR_POSTURE` (the total door census) and every read route of
 * `SECTION_READ_ROUTES` is driven with hostile templates under the query tap;
 * a door whose statements come from `search_related.ts` is a MEMBER. A member
 * must be a route that declares `page: 'client_sqo'` (the reads WITHOUT a
 * source.action route — `read#(default)`: the component get_data and the
 * generic section read — declare it as `SECTION_READ_DEFAULT_PAGE`), or
 * get_indexation_grid, or a NAMED exemption below with its reason
 * (shrink-only). So a new route that forwards rqo.sqo raw to the sink reddens
 * here without anyone listing it.
 *
 * EVERY MEMBER BOUNDS ITS OWN PAGE — the wire bound is a backstop, never the
 * bound. The universal bound holds a second time with the wire schema
 * BYPASSED: the RQO handed straight to dispatch, as a server-internal caller
 * or a page that never crossed `wireSqoSchema` hands it (save's echo reads its
 * limit from `data.pagination`, dd_core_api.ts). The `read#(default)` member
 * (a component_relation_index get_data) read `rqo.sqo.offset` raw
 * (section/read.ts readComponentData → relation_index
 * findInverseReferenceLocators) until it adopted clampClientPage: offset `1e21`
 * reached the sink and was refused 400 `search.invalid_sqo` — so a declared
 * posture that is not honoured reddens here, not only an undeclared one.
 *
 * Situation `zzpg` (matrix_test via test24, ids 900740..901021 and
 * 901024..901032; zzpg18 in matrix_list via dd22, ids 901022..901023 — dropped
 * with a
 * residue-0 assertion).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isIsolatedGateChild, mirrorIsolatedGate } from '../helpers/isolated_gate.ts';

// ISOLATED GATE (test/helpers/isolated_gate.ts): this file needs a CONFIG value
// pinned at boot (DEDALO_SEARCH_CLIENT_MAX_LIMIT=3, ISOLATED_GATE_ENV) — in the
// tier's process it only MIRRORS a child run of itself; its body below
// registers in that child alone.
if (!isIsolatedGateChild(import.meta.path)) mirrorIsolatedGate(import.meta.path);
else {
	const { registerSessionCleanup } = await import('../helpers/session_cleanup.ts');
	const { DB_READY } = await import('../helpers/db_ready.ts');
	const { dispatchRqo } = await import('../../src/core/api/dispatch.ts');
	const { rqoSchema } = await import('../../src/core/concepts/rqo.ts');
	const { CLIENT_MAX_LIMIT } = await import('../../src/core/concepts/sqo.ts');
	const { runWithQueryTap } = await import('../../src/core/db/query_tap.ts');
	const { resolvePrincipal } = await import('../../src/core/security/permissions.ts');
	const { READ_DOOR_POSTURE } = await import('../../src/core/security/read_door.ts');
	const { createSession, getSession } = await import('../../src/core/security/session_store.ts');
	const { getToolSpec, runTool } = await import('../../src/ai/mcp/registry.ts');
	const readFacade = (await import('../../src/core/section/read_facade.ts')) as Record<
		string,
		unknown
	>;
	const { dropSituation, ensureSituation, situation } = await import(
		'../../src/core/test_data/situations/situation.ts'
	);
	const { sql } = await import('../../src/core/db/postgres.ts');
	const { ensureSuiteProjectsFixture, removeSuiteProjectsFixture, SUITE_SECOND_PROJECT_ID } =
		await import('../../src/core/test_data/projects_fixture.ts');
	const { assertTestDatabase } = await import('../../src/core/test_data/test_database_marker.ts');
	const { clearUserFilterRecordsCache } = await import('../../src/core/security/filter_records.ts');
	const {
		ACL_NON_ADMIN_PROFILE_ID,
		ACL_NON_ADMIN_USER_ID,
		ACL_PROJECT_ID,
		clearAclIdentityCaches,
		installAclIdentityFixture,
		removeAclIdentityFixture,
	} = await import('../helpers/acl_identity_fixture.ts');

	registerSessionCleanup();

	/** The ceiling this process was booted with (ISOLATED_GATE_ENV). */
	const CEILING = 3;
	const HOST_SECTION = 'zzpg1';
	const HOST_ID = 900740;
	const REF_SECTION = 'zzpg3';
	const REF_IDS = [900741, 900742, 900743, 900744, 900745, 900746];
	/**
	 * HOST2 — the PAST-THE-PAGE situation (its own host, so HOST's legs are
	 * untouched). Nine zzpg3 references in section_id order, each in the
	 * READER's project (visible) or the second one (not), laid out so that
	 * at offset 0 the next window opens on a hidden row with a visible one
	 * behind it (mixed), and at offset 2 the WHOLE next window is hidden
	 * with a visible row after it (the gap). Plus two references from a
	 * SECOND referencing section (zzpg11), fewer than the ceiling.
	 */
	const HOST2_ID = 900747;
	const PAST_REFS: readonly { id: number; visible: boolean }[] = [
		{ id: 900748, visible: true },
		{ id: 900749, visible: true },
		{ id: 900750, visible: true },
		{ id: 900751, visible: false },
		{ id: 900752, visible: true },
		{ id: 900753, visible: false },
		{ id: 900754, visible: false },
		{ id: 900755, visible: false },
		{ id: 900756, visible: true },
	];
	const SECOND_REF_SECTION = 'zzpg11';
	const SECOND_REF_IDS = [900757, 900758];
	/**
	 * THE LONG HIDDEN TAIL (READ-4 review: the defaulted probe must be bounded
	 * whatever the tail). Three hosts share referencing records, all in
	 * section_id order:
	 *   - TAIL_FIRST: three records the READER sees, referencing all three hosts
	 *     (so the served page is the same three records on every host);
	 *   - TAIL_HIDDEN: LONG_TAIL records in the second project (hidden from the
	 *     reader), referencing HOST_LONG_END and HOST_LONG_HIDDEN — far longer
	 *     than the 64 × CEILING window the retired windowed probe grew to;
	 *   - TAIL_SHORT_HIDDEN: four hidden records referencing HOST_SHORT only;
	 *   - TAIL_LAST: one VISIBLE record after the whole hidden tail, referencing
	 *     HOST_LONG_END only — the reader can page to it, so its default page
	 *     owes the notice there and only there.
	 */
	const HOST_LONG_END = 901018;
	const HOST_LONG_HIDDEN = 901019;
	const HOST_SHORT = 901020;
	const LONG_TAIL = 250;
	const TAIL_FIRST = [900760, 900761, 900762];
	const TAIL_HIDDEN = Array.from({ length: LONG_TAIL }, (_, index) => 900763 + index);
	const TAIL_SHORT_HIDDEN = [901013, 901014, 901015, 901016];
	const TAIL_LAST = 901017;
	/**
	 * A host record OUTSIDE the reader's dd478 allow-list for the host section
	 * (grantReaderTheHost): granted section, no projects component — hidden by
	 * the row-level allow-list alone.
	 */
	const HOST_OUTSIDE_ALLOW_LIST = 901021;
	/**
	 * A section in a PROJECTS-FILTER-EXEMPT table (matrix_list, via dd22) that
	 * nevertheless carries a component_filter: the list ignores its projects
	 * (sectionNeedsRecordAcl), so both records are in scope for any reader — one
	 * in the reader's project, one in the second suite project.
	 */
	const EXEMPT_SECTION = 'zzpg18';
	const EXEMPT_IDS = [901022, 901023];
	/**
	 * THE SECTION_TOP HOSTS (the grid's past probe scopes a row as its top, never
	 * its owner). Each host is indexed by the three TOP_PAGE records (visible to
	 * the reader, each its own top — a full page) and by ONE row past the page
	 * whose owner and section_top disagree for the reader (see the grid leg).
	 */
	const HOST3_ID = 901024;
	const HOST4_ID = 901025;
	const HOST5_ID = 901026;
	const TOP_PAGE = [901027, 901028, 901029];
	/** Owner VISIBLE, top a HIDDEN zzpg3 record (HOST3). */
	const TOP_HIDDEN_ROW = 901030;
	/** Owner HIDDEN, top a VISIBLE zzpg3 record (HOST4). */
	const TOP_VISIBLE_ROW = 901031;
	/** Owner VISIBLE, top the visible id but in zzpg11, a section the reader may not read (HOST5). */
	const TOP_OTHER_SECTION_ROW = 901032;
	/** A component_relation_index declaring its OWN request_config (the own-config emission). */
	const OWN_CONFIG_INDEX = 'zzpg17';
	/** Each referencing record's column value — what a door's answer is counted by. */
	const marker = (id: number): string => `ZZPGREF${id}`;
	const MARKER_RE = /ZZPGREF\d+/g;

	/** One zzpg3 referencing record: marker, projects, the portal + index links to `hostIds`. */
	const refRecord = (id: number, hostIds: readonly number[], projectId: number) => ({
		section_tipo: REF_SECTION,
		section_id: id,
		columns: {
			string: { zzpg4: [{ id: 1, lang: 'lg-nolan', value: marker(id) }] },
			relation: {
				zzpg10: [
					{
						id: 1,
						type: 'dd151',
						section_tipo: 'dd153',
						section_id: projectId,
						from_component_tipo: 'zzpg10',
					},
				],
				zzpg5: hostIds.map((hostId, index) => ({
					id: index + 1,
					type: 'dd151',
					section_tipo: HOST_SECTION,
					section_id: hostId,
					from_component_tipo: 'zzpg5',
				})),
				zzpg8: hostIds.map((hostId, index) => ({
					id: index + 1,
					type: 'dd96',
					section_tipo: HOST_SECTION,
					section_id: hostId,
					from_component_tipo: 'zzpg8',
				})),
			},
		},
	});

	/** One zzpg3 record indexing ONE host through zzpg8 with a stored section_top. */
	const topRef = (
		id: number,
		hostId: number,
		projectId: number,
		top: { section_top_tipo: string; section_top_id: number },
	) => ({
		section_tipo: REF_SECTION,
		section_id: id,
		columns: {
			string: { zzpg4: [{ id: 1, lang: 'lg-nolan', value: marker(id) }] },
			relation: {
				zzpg10: [
					{
						id: 1,
						type: 'dd151',
						section_tipo: 'dd153',
						section_id: projectId,
						from_component_tipo: 'zzpg10',
					},
				],
				zzpg8: [
					{
						id: 1,
						type: 'dd96',
						section_tipo: HOST_SECTION,
						section_id: hostId,
						from_component_tipo: 'zzpg8',
						...top,
					},
				],
			},
		},
	});

	const S = situation({
		name: 'zzpg client page doors',
		tld: 'zzpg',
		nodes: [
			// HOST = the referenced record AND the indexation term.
			{
				tipo: 'zzpg1',
				parent: 'test1',
				model: 'section',
				term: { 'lg-spa': 'Anfitrión página', 'lg-eng': 'Page host' },
				relations: [{ tipo: 'test24' }],
			},
			{
				tipo: 'zzpg2',
				parent: 'zzpg1',
				model: 'component_relation_index',
				term: { 'lg-spa': 'Indexaciones' },
				relations: [{ tipo: 'zzpg3' }],
			},
			{ tipo: 'zzpg9', parent: 'zzpg1', model: 'relation_list', term: { 'lg-spa': 'Referencias' } },
			// The OWN-CONFIG strategy (relation_index.ts emitOwnConfigIndexData): a
			// request_config over the referencing section, its marker as the ddo_map.
			{
				tipo: OWN_CONFIG_INDEX,
				parent: 'zzpg1',
				model: 'component_relation_index',
				order_number: 4,
				term: { 'lg-spa': 'Indexaciones (configuración propia)' },
				properties: {
					source: {
						mode: 'external',
						request_config: [
							{
								sqo: { section_tipo: [{ value: ['zzpg3'], source: 'section' }] },
								show: {
									ddo_map: [{ tipo: 'zzpg4', section_tipo: 'self', parent: 'self' }],
								},
							},
						],
					},
				},
			},
			// REFERENCING section: a portal to the host + a dd96 index locator to it.
			{
				tipo: 'zzpg3',
				parent: 'test1',
				model: 'section',
				term: { 'lg-spa': 'Referencias página', 'lg-eng': 'Page refs' },
				relations: [{ tipo: 'test24' }],
			},
			{
				tipo: 'zzpg4',
				parent: 'zzpg3',
				model: 'component_input_text',
				term: { 'lg-spa': 'Marca', 'lg-eng': 'Marker' },
			},
			{
				tipo: 'zzpg5',
				parent: 'zzpg3',
				model: 'component_portal',
				order_number: 2,
				term: { 'lg-spa': 'Portal al anfitrión' },
				relations: [{ tipo: 'zzpg1' }],
			},
			{
				tipo: 'zzpg8',
				parent: 'zzpg3',
				model: 'component_portal',
				order_number: 3,
				term: { 'lg-spa': 'Indexa' },
				relations: [{ tipo: 'zzpg1' }],
			},
			// The referencing records' PROJECTS (the non-admin leg: out of the reader's).
			{
				tipo: 'zzpg10',
				parent: 'zzpg3',
				model: 'component_filter',
				order_number: 6,
				term: { 'lg-eng': 'Projects' },
				relations: [{ tipo: 'dd153' }],
			},
			{
				tipo: 'zzpg6',
				parent: 'zzpg3',
				model: 'relation_list',
				order_number: 4,
				term: { 'lg-spa': 'relation_list' },
				relations: [{ tipo: 'zzpg4' }],
			},
			// A SECOND referencing section (HOST2 only): a portal and an index link to the host, a marker.
			{
				tipo: SECOND_REF_SECTION,
				parent: 'test1',
				model: 'section',
				term: { 'lg-spa': 'Segundas referencias página', 'lg-eng': 'Page refs 2' },
				relations: [{ tipo: 'test24' }],
			},
			{
				tipo: 'zzpg12',
				parent: SECOND_REF_SECTION,
				model: 'component_input_text',
				term: { 'lg-spa': 'Marca 2', 'lg-eng': 'Marker 2' },
			},
			{
				tipo: 'zzpg13',
				parent: SECOND_REF_SECTION,
				model: 'component_portal',
				order_number: 2,
				term: { 'lg-spa': 'Portal al anfitrión 2' },
				relations: [{ tipo: 'zzpg1' }],
			},
			{
				tipo: 'zzpg14',
				parent: SECOND_REF_SECTION,
				model: 'relation_list',
				order_number: 3,
				term: { 'lg-spa': 'relation_list' },
				relations: [{ tipo: 'zzpg12' }],
			},
			{
				tipo: 'zzpg15',
				parent: SECOND_REF_SECTION,
				model: 'component_portal',
				order_number: 4,
				term: { 'lg-spa': 'Indexa 2' },
				relations: [{ tipo: 'zzpg1' }],
			},
			{
				tipo: 'zzpg16',
				parent: SECOND_REF_SECTION,
				model: 'indexation_list',
				order_number: 5,
				term: { 'lg-spa': 'indexation_list' },
				properties: {
					row: { show: { ddo_map: [{ tipo: 'zzpg12', section_tipo: 'self', parent: 'self' }] } },
				},
			},
			// A projects-filter-EXEMPT table with a component_filter (EXEMPT_SECTION).
			{
				tipo: EXEMPT_SECTION,
				parent: 'test1',
				model: 'section',
				term: { 'lg-spa': 'Lista exenta página', 'lg-eng': 'Page exempt list' },
				relations: [{ tipo: 'dd22' }],
			},
			{
				tipo: 'zzpg19',
				parent: EXEMPT_SECTION,
				model: 'component_filter',
				term: { 'lg-eng': 'Projects' },
				relations: [{ tipo: 'dd153' }],
			},
			{
				tipo: 'zzpg7',
				parent: 'zzpg3',
				model: 'indexation_list',
				order_number: 5,
				term: { 'lg-spa': 'indexation_list' },
				properties: {
					row: { show: { ddo_map: [{ tipo: 'zzpg4', section_tipo: 'self', parent: 'self' }] } },
				},
			},
		],
		records: [
			{ section_tipo: HOST_SECTION, section_id: HOST_ID, columns: { data: {} } },
			...REF_IDS.map((id) => refRecord(id, [HOST_ID], SUITE_SECOND_PROJECT_ID)),
			{ section_tipo: HOST_SECTION, section_id: HOST2_ID, columns: { data: {} } },
			...PAST_REFS.map(({ id, visible }) =>
				refRecord(id, [HOST2_ID], visible ? ACL_PROJECT_ID : SUITE_SECOND_PROJECT_ID),
			),
			...[HOST_LONG_END, HOST_LONG_HIDDEN, HOST_SHORT, HOST_OUTSIDE_ALLOW_LIST].map((id) => ({
				section_tipo: HOST_SECTION,
				section_id: id,
				columns: { data: {} },
			})),
			...TAIL_FIRST.map((id) =>
				refRecord(id, [HOST_LONG_END, HOST_LONG_HIDDEN, HOST_SHORT], ACL_PROJECT_ID),
			),
			...TAIL_HIDDEN.map((id) =>
				refRecord(id, [HOST_LONG_END, HOST_LONG_HIDDEN], SUITE_SECOND_PROJECT_ID),
			),
			...TAIL_SHORT_HIDDEN.map((id) => refRecord(id, [HOST_SHORT], SUITE_SECOND_PROJECT_ID)),
			refRecord(TAIL_LAST, [HOST_LONG_END], ACL_PROJECT_ID),
			...[HOST3_ID, HOST4_ID, HOST5_ID].map((id) => ({
				section_tipo: HOST_SECTION,
				section_id: id,
				columns: { data: {} },
			})),
			...TOP_PAGE.map((id) => refRecord(id, [HOST3_ID, HOST4_ID, HOST5_ID], ACL_PROJECT_ID)),
			topRef(TOP_HIDDEN_ROW, HOST3_ID, ACL_PROJECT_ID, {
				section_top_tipo: REF_SECTION,
				section_top_id: REF_IDS[0] as number,
			}),
			topRef(TOP_VISIBLE_ROW, HOST4_ID, SUITE_SECOND_PROJECT_ID, {
				section_top_tipo: REF_SECTION,
				section_top_id: PAST_REFS[0]?.id as number,
			}),
			topRef(TOP_OTHER_SECTION_ROW, HOST5_ID, ACL_PROJECT_ID, {
				section_top_tipo: SECOND_REF_SECTION,
				section_top_id: PAST_REFS[0]?.id as number,
			}),
			...EXEMPT_IDS.map((id, index) => ({
				section_tipo: EXEMPT_SECTION,
				section_id: id,
				columns: {
					relation: {
						zzpg19: [
							{
								id: 1,
								type: 'dd151',
								section_tipo: 'dd153',
								section_id: index === 0 ? ACL_PROJECT_ID : SUITE_SECOND_PROJECT_ID,
								from_component_tipo: 'zzpg19',
							},
						],
					},
				},
			})),
			...SECOND_REF_IDS.map((id) => ({
				section_tipo: SECOND_REF_SECTION,
				section_id: id,
				columns: {
					string: { zzpg12: [{ id: 1, lang: 'lg-nolan', value: marker(id) }] },
					relation: {
						zzpg13: [
							{
								id: 1,
								type: 'dd151',
								section_tipo: HOST_SECTION,
								section_id: HOST2_ID,
								from_component_tipo: 'zzpg13',
							},
						],
						zzpg15: [
							{
								id: 1,
								type: 'dd96',
								section_tipo: HOST_SECTION,
								section_id: HOST2_ID,
								from_component_tipo: 'zzpg15',
							},
						],
					},
				},
			})),
		],
	});

	// ── the doors ───────────────────────────────────────────────────────────

	/** A request template aimed at the sink; `page` is written into its sqo. */
	type Template = { name: string; source: Record<string, unknown>; sqo: Record<string, unknown> };

	/** The relation-list / related-search shape (the Referencias panel, the tools). */
	const RELATION_TEMPLATE: Template = {
		name: 'relation',
		source: {
			typo: 'source',
			model: 'relation_list',
			tipo: 'zzpg9',
			section_tipo: HOST_SECTION,
			section_id: HOST_ID,
			mode: 'edit',
			lang: 'lg-spa',
		},
		sqo: {
			section_tipo: ['all'],
			mode: 'related',
			filter_by_locators: [{ section_tipo: HOST_SECTION, section_id: HOST_ID }],
		},
	};

	/** The thesaurus "show indexations" shape (ts_object.js show_indexations). */
	const INDEXATION_TEMPLATE: Template = {
		name: 'indexation',
		source: {
			model: 'component_relation_index',
			tipo: 'zzpg2',
			section_tipo: HOST_SECTION,
			section_id: HOST_ID,
			mode: 'edit',
			lang: 'lg-spa',
			value: null,
		},
		sqo: {
			mode: 'related',
			section_tipo: [REF_SECTION],
			total: null,
			filter_by_locators: [{ section_tipo: HOST_SECTION, section_id: HOST_ID, tipo: 'zzpg2' }],
		},
	};

	const TEMPLATES = [RELATION_TEMPLATE, INDEXATION_TEMPLATE];

	/** `template` aimed at another host, optionally narrowed to `sectionTipos`. */
	function atHost(template: Template, hostId: number, sectionTipos?: string[]): Template {
		const locators = template.sqo.filter_by_locators as Record<string, unknown>[];
		return {
			...template,
			source: { ...template.source, section_id: hostId },
			sqo: {
				...template.sqo,
				...(sectionTipos === undefined ? {} : { section_tipo: sectionTipos }),
				filter_by_locators: locators.map((locator) => ({ ...locator, section_id: hostId })),
			},
		};
	}

	/** The read routes keyed on `source.action` (falls back to today's two when unexported). */
	type RouteSpec = { page?: unknown };
	const sectionReadRoutes = readFacade.SECTION_READ_ROUTES as
		| ReadonlyMap<string, RouteSpec>
		| undefined;
	const READ_ROUTE_KEYS: string[] =
		sectionReadRoutes instanceof Map
			? [...sectionReadRoutes.keys()]
			: ['get_relation_list', 'related_search'];

	/** One addressable door: `<dd_api>:<action>[#<source.action>]` or `mcp:<tool>`. */
	interface Door {
		key: string;
		apiClass: string;
		action: string;
		route?: string;
	}

	/**
	 * Doors that cannot be DRIVEN in the suite, each with its reason — shrink-only.
	 * Not a statement that they never reach the sink: they are outside what a
	 * hermetic run can execute (external egress, a model call, an open stream).
	 */
	const UNDRIVABLE: ReadonlyMap<string, string> = new Map([
		['dd_rag_api:semantic_search', 'embeds the query through the model sidecar (egress)'],
		['dd_rag_api:retrieve', 'embeds the query through the model sidecar (egress)'],
		['dd_rag_api:get_agent_context', 'embeds the query through the model sidecar (egress)'],
		['dd_rag_api:similar_to', 'vector index of the RAG database, model sidecar (egress)'],
		['dd_rag_api:ask', 'retrieval + an LLM call (paid egress)'],
		['dd_rag_api:similar_objects', 'image embedding through the model sidecar (egress)'],
		['dd_rag_api:search_by_text_image', 'text→image embedding through the model sidecar (egress)'],
		['dd_rag_api:characterize_object', 'an LLM call (paid egress)'],
		['dd_rag_api:embed_groups', 'RAG configuration of the model sidecar'],
		['dd_identify_api:identify_by_image', 'image embedding through the model sidecar (egress)'],
		['dd_external_api:search', 'an external record service (egress)'],
		['dd_mcp_api:agent_chat', 'an LLM agent loop (paid egress)'],
		['dd_mcp_api:agent_chat_stream', 'an LLM agent loop (paid egress), streamed'],
		['dd_utils_api:get_code_update_info', 'the update server (egress)'],
		['dd_utils_api:get_ontology_update_info', 'the ontology master server (egress)'],
		['dd_diffusion_api:follow_queue', 'an open event stream'],
		['dd_utils_api:get_job_events', 'an open event stream'],
	]);

	/**
	 * Sink members that are NOT a client page route, each with its reason —
	 * shrink-only. They are still held to the universal bound below (every
	 * member answers a hostile window with a 200 of at most CEILING records);
	 * what they are exempt from is only the ROUTE posture declaration.
	 */
	const MEMBERS_WITHOUT_ROUTE_POSTURE: ReadonlyMap<string, string> = new Map([
		[
			'dd_core_api:count',
			"mode 'related' answers a TOTAL, never a window — the related search's own scoped question counted in SQL (D1, 2026-10-21; bounded: related_scope_equivalence_native)",
		],
	]);

	/**
	 * Members whose sink is the BREAKDOWN sink (findInverseReferenceLocators):
	 * its first statement is the owner-plan probe, bounded by the sink's own
	 * fixed owner cap — not by the client page — so the per-statement row
	 * bound (CEILING + 1) does not apply; the visible bound does. Shrink-only:
	 * a name here that no longer reaches the sink is stale (asserted below).
	 */
	const BREAKDOWN_SINK_DOORS: ReadonlyMap<string, string> = new Map([
		[
			'dd_core_api:get_indexation_grid',
			'indexation_grid.ts buildIndexationGrid → findInverseReferenceLocators (owner probe: ownerCap + 1 rows)',
		],
		[
			'dd_core_api:read#(default)',
			'component_relation_index get_data → relation_index findInverseReferenceLocators (owner probe: ownerCap + 1 rows)',
		],
	]);

	/** Whether a door's sink statements are held to CEILING + 1 rows each. */
	const rowBounded = (key: string): boolean => !BREAKDOWN_SINK_DOORS.has(key);

	function allDoors(): Door[] {
		const doors: Door[] = [];
		for (const [key, posture] of READ_DOOR_POSTURE) {
			if (posture.posture === 'mutating' || key.startsWith('http:')) continue;
			const [apiClass, action] = key.split(':') as [string, string];
			if (key === 'dd_core_api:read') {
				for (const route of READ_ROUTE_KEYS) {
					doors.push({ key: `${key}#${route}`, apiClass, action, route });
				}
				doors.push({ key: `${key}#(default)`, apiClass, action });
				continue;
			}
			doors.push({ key, apiClass, action });
		}
		return doors;
	}

	const ABSENT = Symbol('absent');
	type PageValue = unknown | typeof ABSENT;

	/** Who drives a door: the global admin, or the non-admin READER (see the header). */
	type Caller = 'admin' | 'reader';

	/**
	 * How a door is reached: 'wire' — through the wire schema first, the way
	 * server.ts parses every body; 'bypassed' — the RQO handed to dispatch as
	 * built (a server-internal caller, a page that never crossed wireSqoSchema).
	 */
	type Via = 'wire' | 'bypassed';

	async function callerContext(caller: Caller): Promise<Record<string, unknown>> {
		const userId = caller === 'admin' ? -1 : ACL_NON_ADMIN_USER_ID;
		const token = createSession(userId, `client_page_doors_native_${caller}`, caller === 'admin');
		const session = getSession(token);
		return {
			requestId: 'client_page_doors_native',
			clientIp: '127.0.0.1',
			session,
			sessionToken: token,
			csrfCandidate: session?.csrfToken ?? null,
			principal: await resolvePrincipal(userId),
		};
	}

	/**
	 * The READER's read grants on the zzpg sections (the host, its two door
	 * components, the referencing section), appended to the ACL fixture's reader
	 * profile (a scratch record that fixture sweeps). The referencing RECORDS
	 * stay out of reach: they carry SUITE_SECOND_PROJECT_ID, the reader holds
	 * only ACL_PROJECT_ID.
	 */
	async function grantReaderTheHost(): Promise<void> {
		await assertTestDatabase('client_page_doors_native');
		const grants = [
			{ id: 101, tipo: HOST_SECTION, section_tipo: HOST_SECTION, value: 1 },
			{ id: 102, tipo: 'zzpg2', section_tipo: HOST_SECTION, value: 1 },
			{ id: 103, tipo: 'zzpg9', section_tipo: HOST_SECTION, value: 1 },
			{ id: 104, tipo: REF_SECTION, section_tipo: REF_SECTION, value: 1 },
			{ id: 105, tipo: 'zzpg4', section_tipo: REF_SECTION, value: 1 },
		];
		await sql.unsafe(
			`UPDATE matrix_profiles
			    SET misc = jsonb_set(coalesce(misc, '{}'::jsonb), '{dd774}',
			                         coalesce(misc->'dd774', '[]'::jsonb) || $1::text::jsonb)
			  WHERE section_tipo = 'dd234' AND section_id = $2`,
			[JSON.stringify(grants), ACL_NON_ADMIN_PROFILE_ID],
		);
		// A dd478 row-level allow-list on the HOST section: every host a reader leg
		// drives, and not HOST_OUTSIDE_ALLOW_LIST (the scope-equality leg's third half).
		const allowList = [
			{
				id: 1,
				tipo: HOST_SECTION,
				value: [
					HOST_ID,
					HOST2_ID,
					HOST_LONG_END,
					HOST_LONG_HIDDEN,
					HOST_SHORT,
					HOST3_ID,
					HOST4_ID,
					HOST5_ID,
				],
			},
		];
		await sql.unsafe(
			`UPDATE matrix_users
			    SET misc = jsonb_set(coalesce(misc, '{}'::jsonb), '{dd478}', $1::text::jsonb)
			  WHERE section_tipo = 'dd128' AND section_id = $2`,
			[JSON.stringify(allowList), ACL_NON_ADMIN_USER_ID],
		);
		clearUserFilterRecordsCache();
		clearAclIdentityCaches();
	}

	function buildRqo(
		door: Door,
		template: Template,
		limit: PageValue,
		offset: PageValue,
	): Record<string, unknown> {
		const source: Record<string, unknown> = { ...template.source };
		if (door.route !== undefined) source.action = door.route;
		const sqo: Record<string, unknown> = { ...template.sqo };
		if (limit !== ABSENT) sqo.limit = limit;
		if (offset !== ABSENT) sqo.offset = offset;
		return {
			action: door.action,
			dd_api: door.apiClass,
			prevent_lock: true,
			options: {},
			source,
			sqo,
		};
	}

	interface DoorAnswer {
		/** 'wire' = refused by the wire schema before dispatch (server.ts). */
		outcome: 'wire' | 'answered' | 'threw' | 'timeout';
		status: number;
		body: Record<string, unknown>;
		markers: number;
		reachedSink: boolean;
		/**
		 * The most rows any ONE statement issued from search_related.ts returned
		 * (tap `callers[].maxRows`); NaN when the tap does not report it.
		 */
		sinkMaxRows: number;
		/** Every statement the request issued (tap `count`). */
		statements: number;
		/** Rows all of them returned (tap `callers[].sumRows`); NaN when the tap does not report it. */
		rows: number;
		/** The same, without the statements issued from search_related.ts. */
		rowsOutsideSink: number;
		error?: string;
	}

	const DOOR_TIMEOUT_MS = 20_000;

	async function withTimeout<T>(work: Promise<T>): Promise<T | 'timeout'> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const expiry = new Promise<'timeout'>((resolve) => {
			timer = setTimeout(() => resolve('timeout'), DOOR_TIMEOUT_MS);
		});
		try {
			return await Promise.race([work, expiry]);
		} finally {
			clearTimeout(timer);
		}
	}

	function countMarkers(body: unknown): number {
		return new Set(JSON.stringify(body ?? null).match(MARKER_RE) ?? []).size;
	}

	/** Drive one door once — through the wire parse, then dispatch, under the tap. */
	async function drive(
		door: Door,
		template: Template,
		limit: PageValue,
		offset: PageValue,
		caller: Caller = 'admin',
		via: Via = 'wire',
	): Promise<DoorAnswer> {
		const context = await callerContext(caller);
		const rqo = buildRqo(door, template, limit, offset);
		const empty = {
			status: 0,
			body: {},
			markers: 0,
			reachedSink: false,
			sinkMaxRows: 0,
			statements: 0,
			rows: 0,
			rowsOutsideSink: 0,
		};
		try {
			const tapped = await withTimeout(
				runWithQueryTap(`client_page_doors ${door.key}`, async () => {
					if (door.apiClass === 'mcp') {
						const spec = getToolSpec(door.action);
						if (spec === undefined) throw new Error(`no MCP tool '${door.action}'`);
						const input = {
							...template.sqo,
							section_tipo: template.source.section_tipo,
							section_id: template.source.section_id,
							tipo: template.source.tipo,
							...(limit === ABSENT ? {} : { limit }),
							...(offset === ABSENT ? {} : { offset }),
						};
						const structured = await runTool(spec, context.principal as never, input);
						return { wire: false, status: 200, body: structured as Record<string, unknown> };
					}
					// 'bypassed': the RQO reaches dispatch as built, never parsed by
					// the wire schema — the door must bound the window itself.
					if (via === 'bypassed') {
						const result = await dispatchRqo(rqo as never, context as never);
						return {
							wire: false,
							status: result.status,
							body: result.body as Record<string, unknown>,
						};
					}
					const parsed = rqoSchema.safeParse(rqo);
					if (!parsed.success) return { wire: true, status: 400, body: {} };
					const result = await dispatchRqo(parsed.data, context as never);
					return {
						wire: false,
						status: result.status,
						body: result.body as Record<string, unknown>,
					};
				}),
			);
			if (tapped === 'timeout') return { ...empty, outcome: 'timeout' };
			const sinkCallers = tapped.report.callers.filter((caller) =>
				caller.frames.includes('search_related.ts'),
			);
			const reachedSink = sinkCallers.length > 0;
			const sinkMaxRows = sinkCallers.reduce((max, caller) => {
				const rows = (caller as { maxRows?: unknown }).maxRows;
				return typeof rows === 'number' ? Math.max(max, rows) : Number.NaN;
			}, 0);
			const sumRows = (callers: typeof tapped.report.callers): number =>
				callers.reduce((sum, caller) => {
					const rows = (caller as { sumRows?: unknown }).sumRows;
					return typeof rows === 'number' ? sum + rows : Number.NaN;
				}, 0);
			const { wire, status, body } = tapped.result;
			return {
				outcome: wire ? 'wire' : 'answered',
				status,
				body,
				markers: countMarkers((body as { data?: unknown }).data),
				reachedSink,
				sinkMaxRows,
				statements: tapped.report.count,
				rows: sumRows(tapped.report.callers),
				rowsOutsideSink: sumRows(
					tapped.report.callers.filter((caller) => !caller.frames.includes('search_related.ts')),
				),
			};
		} catch (error) {
			return { ...empty, outcome: 'threw', error: String((error as Error)?.message ?? error) };
		}
	}

	function noticeCodes(body: Record<string, unknown>): string[] {
		const notices = body.notices;
		return Array.isArray(notices)
			? notices.map((notice) => String((notice as { code?: unknown }).code))
			: [];
	}

	// ── the page matrix ─────────────────────────────────────────────────────

	const HOSTILE_LIMITS: PageValue[] = [ABSENT, null, 0, 'all', -1, 'x', 1e9, 1e21];
	/**
	 * The two MAX_SAFE_INTEGER values are the BOUNDARY the offset clamp itself
	 * produces (1e21 → MAX_SAFE_INTEGER) and passes through: served as sent, so a
	 * page with no limit stays 'defaulted' and its "anything past?" probe would
	 * name offset + limit past MAX_SAFE_INTEGER — which no row can occupy
	 * (sqo.ts offsetPastPage). An empty 200 with no notice, never a refusal.
	 */
	const HOSTILE_OFFSETS: PageValue[] = [
		ABSENT,
		-5,
		'x',
		1e21,
		Number.MAX_SAFE_INTEGER - 1,
		Number.MAX_SAFE_INTEGER,
	];
	/** The offset a page is served at (the clamp's own rule: absent/NaN → 0, ≤ MAX_SAFE_INTEGER). */
	const appliedOffsetOf = (offset: PageValue): number => {
		if (!isSent(offset) || Number.isNaN(Number(offset))) return 0;
		return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(Number(offset))));
	};
	const label = (value: PageValue): string => (value === ABSENT ? 'absent' : JSON.stringify(value));

	/** A value the client SENT (not absent, not null). */
	const isSent = (value: PageValue): boolean => value !== ABSENT && value !== null;

	/**
	 * Whether the notice is owed for one cell — computed from the cell, never
	 * read back from the engine. A sent limit is served as sent only when it is
	 * an integer in [1, CEILING]; a sent offset only when it is an integer >= 0
	 * (within MAX_SAFE_INTEGER). An unsent limit is DEFAULTED, and owes the
	 * notice only when rows past the window exist (`more`).
	 */
	function owesNotice(limit: PageValue, offset: PageValue): boolean {
		const limitChanged =
			isSent(limit) &&
			!(Number.isInteger(limit) && (limit as number) >= 1 && (limit as number) <= CEILING);
		const offsetChanged =
			isSent(offset) && !(Number.isSafeInteger(offset) && (offset as number) >= 0);
		if (limitChanged || offsetChanged) return true;
		if (isSent(limit)) return false;
		return appliedOffsetOf(offset) + CEILING < REF_IDS.length;
	}

	/** The page doors and the template that reaches each one's sink. */
	const PAGE_DOORS: { door: Door; template: Template }[] = [
		{
			door: {
				key: 'dd_core_api:read#get_relation_list',
				apiClass: 'dd_core_api',
				action: 'read',
				route: 'get_relation_list',
			},
			template: RELATION_TEMPLATE,
		},
		{
			door: {
				key: 'dd_core_api:read#related_search',
				apiClass: 'dd_core_api',
				action: 'read',
				route: 'related_search',
			},
			template: RELATION_TEMPLATE,
		},
		{
			door: {
				key: 'dd_core_api:get_indexation_grid',
				apiClass: 'dd_core_api',
				action: 'get_indexation_grid',
			},
			template: INDEXATION_TEMPLATE,
		},
	];

	describe.if(DB_READY)('READ-4 — client page doors (ceiling pinned to 3)', () => {
		beforeAll(async () => {
			await installAclIdentityFixture();
			await ensureSuiteProjectsFixture();
			await ensureSituation(S);
			await grantReaderTheHost();
		});

		afterAll(async () => {
			expect(await dropSituation(S)).toBe(0);
			await removeSuiteProjectsFixture();
			await removeAclIdentityFixture();
			clearUserFilterRecordsCache();
		});

		test('the process runs with the pinned ceiling', () => {
			expect(CLIENT_MAX_LIMIT).toBe(CEILING);
			// Non-degeneracy: more referencing records than the ceiling.
			expect(REF_IDS.length).toBeGreaterThan(CEILING * 1);
		});

		for (const { door, template } of PAGE_DOORS) {
			test(`${door.key}: controls — an honoured window is served exactly, without a notice`, async () => {
				const first = await drive(door, template, 2, 0);
				expect({ status: first.status, markers: first.markers }).toEqual({
					status: 200,
					markers: 2,
				});
				expect(noticeCodes(first.body)).not.toContain('search.page_clamped');
				const tail = await drive(door, template, 2, 4);
				expect({ status: tail.status, markers: tail.markers }).toEqual({ status: 200, markers: 2 });
				const full = await drive(door, template, CEILING, 0);
				expect(full.markers).toBe(CEILING);
				expect(noticeCodes(full.body)).not.toContain('search.page_clamped');
				// A served-as-sent window that leaves rows behind is NOT a clamp.
				if (rowBounded(door.key)) expect(full.sinkMaxRows).toBeLessThanOrEqual(CEILING + 1);
			});
		}

		for (const { door, template } of PAGE_DOORS) {
			test(`${door.key}: a defaulted page that CUTS rows carries the notice; the sink never over-fetches`, async () => {
				for (const limit of [ABSENT, null] as PageValue[]) {
					const answer = await drive(door, template, limit, 0);
					expect({
						cell: `${label(limit)}@0`,
						status: answer.status,
						markers: answer.markers,
						notice: noticeCodes(answer.body).includes('search.page_clamped'),
						sinkWithinPagePlusOne: !rowBounded(door.key) || answer.sinkMaxRows <= CEILING + 1,
					}).toEqual({
						cell: `${label(limit)}@0`,
						status: 200,
						markers: CEILING,
						notice: true,
						sinkWithinPagePlusOne: true,
					});
				}
			});
		}

		for (const { door, template } of PAGE_DOORS) {
			test(`${door.key}: the defaulted notice is SCOPED — a reader who can see none of the rows past the window gets none`, async () => {
				// The relation doors name the referencing section (['all'] is pinned by
				// related_scope_equivalence_native, D3).
				const scoped: Template =
					template === RELATION_TEMPLATE
						? { ...template, sqo: { ...template.sqo, section_tipo: [REF_SECTION] } }
						: template;
				// CONTROL: at this cell the ADMIN is owed the notice (rows past the window).
				const admin = await drive(door, scoped, ABSENT, 0, 'admin');
				expect(noticeCodes(admin.body)).toContain('search.page_clamped');
				// The reader passes the door (a 200, not a 403: the host grant is real) …
				const reader = await drive(door, scoped, ABSENT, 0, 'reader');
				expect({
					outcome: reader.outcome,
					status: reader.status,
					error: reader.body.error ?? null,
				}).toEqual({
					outcome: 'answered',
					status: 200,
					error: null,
				});
				// … sees none of the referencing records, and is told NOTHING about them.
				expect({
					markers: reader.markers,
					notice: noticeCodes(reader.body).includes('search.page_clamped'),
				}).toEqual({ markers: 0, notice: false });
				// A CLAMPED cell still owes it: a sent value was changed — the request, not the rows.
				const clamped = await drive(door, scoped, 1e9, 0, 'reader');
				expect(noticeCodes(clamped.body)).toContain('search.page_clamped');
			});
		}

		for (const { door, template } of PAGE_DOORS) {
			test(`${door.key}: the defaulted notice looks PAST the page — a hidden row, or a whole hidden window, never hides a visible row behind it`, async () => {
				// Non-degeneracy of HOST2's layout (see PAST_REFS).
				expect(PAST_REFS.slice(CEILING, CEILING + 2).map((ref) => ref.visible)).toEqual([
					false,
					true,
				]);
				expect(PAST_REFS.slice(5, 8).every((ref) => !ref.visible)).toBe(true);
				expect(PAST_REFS[8]?.visible).toBe(true);
				const onHost2 = atHost(template, HOST2_ID, [REF_SECTION]);
				const visible = PAST_REFS.filter((ref) => ref.visible).length;
				const visibleIn = (from: number, to: number) =>
					PAST_REFS.slice(from, to).filter((ref) => ref.visible).length;
				// The RELATION doors window the reader's SCOPED records (D1): a page is
				// a window of the visible sequence, owed the notice exactly when more
				// visible records lie past it. The GRID windows its groups before
				// scoping (READ-4): its page holds the visible rows of the unscoped
				// window, owed the notice when a visible group lies anywhere past it.
				const scopedPage = door.key !== 'dd_core_api:get_indexation_grid';
				const cells = [
					// MIXED: the unscoped next window opens on a hidden row, a visible one behind it.
					{ offset: 0 },
					// THE GAP: the WHOLE unscoped window [5, 8) is hidden; row 8 is visible.
					{ offset: 2 },
					// Nothing past the served page.
					{ offset: 6 },
				].map(({ offset }) => ({
					offset,
					readerMarkers: scopedPage
						? Math.max(0, Math.min(CEILING, visible - offset))
						: visibleIn(offset, offset + CEILING),
					readerOwed: scopedPage
						? visible > offset + CEILING
						: visibleIn(offset + CEILING, PAST_REFS.length) > 0,
					adminOwed: PAST_REFS.length > offset + CEILING,
				}));
				// Non-degeneracy: the cells decide both ways for the reader, and on the
				// scoped doors the reader's page is FULLER than the unscoped window's
				// visible rows at the gap (hidden rows no longer take window slots).
				expect(cells.map((cell) => cell.readerOwed)).toContain(true);
				expect(cells.map((cell) => cell.readerOwed)).toContain(false);
				if (scopedPage) expect(cells[1]?.readerMarkers).toBeGreaterThan(visibleIn(2, 2 + CEILING));
				for (const cell of cells) {
					const reader = await drive(door, onHost2, ABSENT, cell.offset, 'reader');
					expect({
						cell: `reader absent@${cell.offset}`,
						status: reader.status,
						markers: reader.markers,
						notice: noticeCodes(reader.body).includes('search.page_clamped'),
					}).toEqual({
						cell: `reader absent@${cell.offset}`,
						status: 200,
						markers: cell.readerMarkers,
						notice: cell.readerOwed,
					});
					// CONTROL: the admin sees every row, and is owed the notice while rows lie past the page.
					const admin = await drive(door, onHost2, ABSENT, cell.offset, 'admin');
					expect({
						cell: `admin absent@${cell.offset}`,
						markers: admin.markers,
						notice: noticeCodes(admin.body).includes('search.page_clamped'),
					}).toEqual({
						cell: `admin absent@${cell.offset}`,
						markers: Math.min(CEILING, PAST_REFS.length - cell.offset),
						notice: cell.adminOwed,
					});
				}
			});
		}

		for (const { door, template } of PAGE_DOORS) {
			test(`${door.key}: the defaulted probe is BOUNDED — a hidden tail of any length costs the reader the same statements and rows, and a visible record behind it is still found`, async () => {
				// Non-degeneracy: the hidden tail is far longer than the 64 × CEILING
				// window the retired windowed probe grew to before reading on.
				expect(TAIL_HIDDEN.length).toBeGreaterThan(64 * CEILING);
				const at = (hostId: number) => atHost(template, hostId, [REF_SECTION]);
				// Warm what the reader's first request reads once (grants, ontology, projects).
				await drive(door, at(HOST_SHORT), ABSENT, 0, 'reader');
				const cells = [
					{ host: 'short hidden tail', id: HOST_SHORT, owed: false },
					{ host: 'long hidden tail', id: HOST_LONG_HIDDEN, owed: false },
					{ host: 'long hidden tail, then a visible record', id: HOST_LONG_END, owed: true },
				];
				const answers: { host: string; answer: DoorAnswer }[] = [];
				for (const cell of cells) {
					answers.push({
						host: cell.host,
						answer: await drive(door, at(cell.id), ABSENT, 0, 'reader'),
					});
				}
				// THE ANSWER: the same served page everywhere; the notice exactly where
				// the reader can page to a record the default left out.
				expect(
					answers.map(({ host, answer }) => ({
						host,
						status: answer.status,
						markers: answer.markers,
						notice: noticeCodes(answer.body).includes('search.page_clamped'),
					})),
				).toEqual(
					cells.map((cell) => ({
						host: cell.host,
						status: 200,
						markers: TAIL_FIRST.length,
						notice: cell.owed,
					})),
				);
				// THE BOUND: what the request costs does not grow with the tail — the
				// same statements, and the same rows carried back (on the breakdown
				// sink, outside its owner probe, which is bounded by its own cap).
				const cost = ({ host, answer }: { host: string; answer: DoorAnswer }) => ({
					host,
					statements: answer.statements,
					rows: rowBounded(door.key) ? answer.rows : answer.rowsOutsideSink,
				});
				const [short, ...long] = answers.map(cost);
				if (short === undefined) throw new Error('no short-tail answer');
				expect(Number.isFinite(short.rows)).toBe(true);
				expect(short.statements).toBeGreaterThan(0);
				expect(long.map(({ statements, rows }) => ({ statements, rows }))).toEqual(
					long.map(() => ({ statements: short.statements, rows: short.rows })),
				);
				if (rowBounded(door.key)) {
					for (const { answer } of answers) {
						expect(answer.sinkMaxRows).toBeLessThanOrEqual(CEILING + 1);
					}
				}
			}, 60_000);
		}

		test('the SET-SHAPED scope (anyRowInScope) answers record by record exactly what the hit-list scope answers', async () => {
			// The defaulted probe asks its tail ONE question in SQL; the page scopes
			// its hits through scopeInverseReferenceHits. The two must be one rule:
			// a record the probe calls visible that the page would hide is a leak, the
			// converse a silently dropped notice.
			const { anyRowInScope, scopeInverseReferenceHits } = await import(
				'../../src/core/security/record_scope.ts'
			);
			const records: { section_tipo: string; section_id: number }[] = [
				// hidden by PROJECT (the second suite project)
				...REF_IDS.slice(0, 2).map((id) => ({ section_tipo: REF_SECTION, section_id: id })),
				// visible and hidden by project, one section
				...PAST_REFS.map(({ id }) => ({ section_tipo: REF_SECTION, section_id: id })),
				// hidden by the SECTION grant (the reader holds none on zzpg11)
				...SECOND_REF_IDS.map((id) => ({ section_tipo: SECOND_REF_SECTION, section_id: id })),
				// a granted section with no projects component: a record in the reader's
				// dd478 allow-list, one outside it, one that does not exist
				{ section_tipo: HOST_SECTION, section_id: HOST_ID },
				{ section_tipo: HOST_SECTION, section_id: HOST_OUTSIDE_ALLOW_LIST },
				{ section_tipo: HOST_SECTION, section_id: 999_999_999 },
				// the users section (its own rule + the root exclusion) and the projects section
				{ section_tipo: 'dd128', section_id: -1 },
				{ section_tipo: 'dd128', section_id: ACL_NON_ADMIN_USER_ID },
				{ section_tipo: 'dd153', section_id: ACL_PROJECT_ID },
				{ section_tipo: 'dd153', section_id: SUITE_SECOND_PROJECT_ID },
			];
			const seen: string[] = [];
			const expected: string[] = [];
			const readerVisible: boolean[] = [];
			for (const userId of [ACL_NON_ADMIN_USER_ID, -1]) {
				const principal = await resolvePrincipal(userId);
				for (const record of records) {
					const cell = `${userId} ${record.section_tipo}/${record.section_id}`;
					const set = await anyRowInScope(
						{
							sql: 'SELECT $1::text AS section_tipo, $2::int AS section_id',
							params: [record.section_tipo, record.section_id],
						},
						principal,
					);
					const list = (await scopeInverseReferenceHits([record], principal)).length > 0;
					seen.push(`${cell}: ${set}`);
					expected.push(`${cell}: ${list}`);
					if (userId !== -1) readerVisible.push(list);
				}
			}
			expect(seen).toEqual(expected);
			// Non-degeneracy: each half of the rule decides at least one reader cell —
			// the projects filter, the section grant, the dd478 allow-list.
			const reader = (tipo: string, id: number) => `${ACL_NON_ADMIN_USER_ID} ${tipo}/${id}`;
			expect(
				[
					reader(REF_SECTION, PAST_REFS[0]?.id as number),
					reader(REF_SECTION, REF_IDS[0] as number),
					reader(SECOND_REF_SECTION, SECOND_REF_IDS[0] as number),
					reader(HOST_SECTION, HOST_ID),
					reader(HOST_SECTION, HOST_OUTSIDE_ALLOW_LIST),
				].map((cell) => expected.find((line) => line.startsWith(`${cell}:`))),
			).toEqual([
				`${reader(REF_SECTION, PAST_REFS[0]?.id as number)}: true`,
				`${reader(REF_SECTION, REF_IDS[0] as number)}: false`,
				`${reader(SECOND_REF_SECTION, SECOND_REF_IDS[0] as number)}: false`,
				`${reader(HOST_SECTION, HOST_ID)}: true`,
				`${reader(HOST_SECTION, HOST_OUTSIDE_ALLOW_LIST)}: false`,
			]);
			expect(readerVisible.filter((visible) => !visible).length).toBeGreaterThan(0);
		});

		test("the set-shaped scope's PER-RECORD half (buildRowsInScopeSql) keeps exactly the rows the list's predicate keeps, arm by arm, on row SETS", async () => {
			// The leg above drives anyRowInScope END TO END, so every cell whose
			// SECTION the reader may not read (dd128, dd153, zzpg11) is decided by
			// the grant leg before the SQL is ever built, and every row set holds ONE
			// row — the per-record arms behind the grant (the Users root exclusion,
			// the section_tipo join, the per-section guard of a multi-section set,
			// the projects-exempt tables) were unproven. Here the granted list is
			// FORCED, so the SQL alone decides, and it must answer exactly the list's
			// per-record predicate (isRecordInScope, the assembler's own WHERE):
			//   expected(rows, granted) = some row r: r's section ∈ granted AND
			//                             isRecordInScope(r) —
			// for the reader AND the global admin (the admin arm of the SQL is the
			// existence half alone).
			const { isRecordInScope } = await import('../../src/core/security/record_scope.ts');
			const { buildRowsInScopeSql } = await import('../../src/core/search/sql_assembler.ts');
			type Row = { section_tipo: string; section_id: number };
			const rowsSql = (rows: readonly Row[]) => ({
				sql: `SELECT v.section_tipo, v.section_id FROM (VALUES ${rows
					.map((_, index) => `($${index * 2 + 1}::text, $${index * 2 + 2}::int)`)
					.join(', ')}) AS v(section_tipo, section_id)`,
				params: rows.flatMap((row) => [row.section_tipo, row.section_id]),
			});
			const rowKey = (row: Row) => `${row.section_tipo}/${Number(row.section_id)}`;
			// The SCOPED SET the SQL keeps (the rows the related count counts and the
			// page windows — D1), not only whether it is empty.
			const askSet = async (
				rows: readonly Row[],
				granted: readonly string[],
				principal: Awaited<ReturnType<typeof resolvePrincipal>>,
			): Promise<string[]> => {
				const query = await buildRowsInScopeSql(rowsSql(rows), granted, principal);
				const kept = (await sql.unsafe(query.sql, query.params as never)) as Row[];
				return kept.map(rowKey).sort();
			};
			const askList = async (
				rows: readonly Row[],
				granted: readonly string[],
				principal: Awaited<ReturnType<typeof resolvePrincipal>>,
			): Promise<string[]> => {
				const kept: string[] = [];
				for (const row of rows) {
					if (!granted.includes(row.section_tipo)) continue;
					if (await isRecordInScope(row.section_tipo, row.section_id, principal)) {
						kept.push(rowKey(row));
					}
				}
				return kept.sort();
			};
			const singles: Row[] = [
				{ section_tipo: REF_SECTION, section_id: REF_IDS[0] as number },
				{ section_tipo: REF_SECTION, section_id: PAST_REFS[0]?.id as number },
				{ section_tipo: HOST_SECTION, section_id: HOST_ID },
				{ section_tipo: HOST_SECTION, section_id: HOST_OUTSIDE_ALLOW_LIST },
				{ section_tipo: HOST_SECTION, section_id: 999_999_999 },
				{ section_tipo: SECOND_REF_SECTION, section_id: SECOND_REF_IDS[0] as number },
				// another section's record in the SAME table (matrix_test): not this record
				{ section_tipo: REF_SECTION, section_id: HOST_ID },
				{ section_tipo: HOST_SECTION, section_id: PAST_REFS[0]?.id as number },
				// the users section: the root, the reader's own account
				{ section_tipo: 'dd128', section_id: -1 },
				{ section_tipo: 'dd128', section_id: ACL_NON_ADMIN_USER_ID },
				// the projects section (ungated by the projects filter itself)
				{ section_tipo: 'dd153', section_id: ACL_PROJECT_ID },
				{ section_tipo: 'dd153', section_id: SUITE_SECOND_PROJECT_ID },
				// a projects-filter-EXEMPT table whose section has a component_filter
				...EXEMPT_IDS.map((id) => ({ section_tipo: EXEMPT_SECTION, section_id: id })),
			];
			// Multi-row sets: [rows, granted]. A row of an UNGRANTED section must never
			// answer through a granted section's arm; a hidden row never masks a
			// visible one; an empty granted list answers false.
			const sets: [Row[], string[]][] = [
				[[{ section_tipo: REF_SECTION, section_id: REF_IDS[0] as number }], [HOST_SECTION]],
				[
					[
						{ section_tipo: REF_SECTION, section_id: PAST_REFS[0]?.id as number },
						{ section_tipo: HOST_SECTION, section_id: HOST_OUTSIDE_ALLOW_LIST },
					],
					[HOST_SECTION],
				],
				[
					[
						{ section_tipo: REF_SECTION, section_id: REF_IDS[0] as number },
						{ section_tipo: REF_SECTION, section_id: PAST_REFS[0]?.id as number },
					],
					[REF_SECTION],
				],
				[
					[
						{ section_tipo: REF_SECTION, section_id: REF_IDS[0] as number },
						{ section_tipo: HOST_SECTION, section_id: HOST_OUTSIDE_ALLOW_LIST },
						{ section_tipo: 'dd128', section_id: -1 },
					],
					[REF_SECTION, HOST_SECTION, 'dd128'],
				],
				[[{ section_tipo: HOST_SECTION, section_id: HOST_ID }], []],
			];
			const seen: string[] = [];
			const expected: string[] = [];
			for (const userId of [ACL_NON_ADMIN_USER_ID, -1]) {
				const principal = await resolvePrincipal(userId);
				const cases: [Row[], string[]][] = [
					...singles.map((row): [Row[], string[]] => [[row], [row.section_tipo]]),
					...sets,
				];
				for (const [rows, granted] of cases) {
					const cell = `${userId} [${rows.map((row) => `${row.section_tipo}/${row.section_id}`).join(' ')}] granted [${granted.join(' ')}]`;
					const setRows = await askSet(rows, granted, principal);
					const listRows = await askList(rows, granted, principal);
					seen.push(`${cell}: ${setRows.length > 0} {${setRows.join(' ')}}`);
					expected.push(`${cell}: ${listRows.length > 0} {${listRows.join(' ')}}`);
				}
			}
			expect(seen).toEqual(expected);
			// Non-degeneracy: the cells each arm decides, with the answer the list gives.
			const at = (userId: number, rows: Row[], granted: string[]) =>
				expected.find((line) =>
					line.startsWith(
						`${userId} [${rows.map((row) => `${row.section_tipo}/${row.section_id}`).join(' ')}] granted [${granted.join(' ')}]:`,
					),
				);
			const single = (userId: number, row: Row) => at(userId, [row], [row.section_tipo]);
			expect([
				// the Users root exclusion — for the admin too
				single(-1, { section_tipo: 'dd128', section_id: -1 }),
				// the section_tipo join: another section's record is not this one
				single(-1, { section_tipo: REF_SECTION, section_id: HOST_ID }),
				// existence: the admin arm still needs the record
				single(-1, { section_tipo: HOST_SECTION, section_id: 999_999_999 }),
				// the per-section guard: an ungranted section's row never answers
				at(-1, [{ section_tipo: REF_SECTION, section_id: REF_IDS[0] as number }], [HOST_SECTION]),
				// the projects-exempt table: a record of ANOTHER project, no projects filter applied
				single(ACL_NON_ADMIN_USER_ID, {
					section_tipo: EXEMPT_SECTION,
					section_id: EXEMPT_IDS[1] as number,
				}),
				// the projects filter and the dd478 allow-list, each deciding a reader cell
				single(ACL_NON_ADMIN_USER_ID, {
					section_tipo: REF_SECTION,
					section_id: REF_IDS[0] as number,
				}),
				single(ACL_NON_ADMIN_USER_ID, {
					section_tipo: HOST_SECTION,
					section_id: HOST_OUTSIDE_ALLOW_LIST,
				}),
				// a hidden row never masks a visible one
				at(
					ACL_NON_ADMIN_USER_ID,
					[
						{ section_tipo: REF_SECTION, section_id: REF_IDS[0] as number },
						{ section_tipo: REF_SECTION, section_id: PAST_REFS[0]?.id as number },
					],
					[REF_SECTION],
				),
				// an empty granted list
				at(-1, [{ section_tipo: HOST_SECTION, section_id: HOST_ID }], []),
			]).toEqual([
				`-1 [dd128/-1] granted [dd128]: false {}`,
				`-1 [${REF_SECTION}/${HOST_ID}] granted [${REF_SECTION}]: false {}`,
				`-1 [${HOST_SECTION}/999999999] granted [${HOST_SECTION}]: false {}`,
				`-1 [${REF_SECTION}/${REF_IDS[0]}] granted [${HOST_SECTION}]: false {}`,
				`${ACL_NON_ADMIN_USER_ID} [${EXEMPT_SECTION}/${EXEMPT_IDS[1]}] granted [${EXEMPT_SECTION}]: true {${EXEMPT_SECTION}/${EXEMPT_IDS[1]}}`,
				`${ACL_NON_ADMIN_USER_ID} [${REF_SECTION}/${REF_IDS[0]}] granted [${REF_SECTION}]: false {}`,
				`${ACL_NON_ADMIN_USER_ID} [${HOST_SECTION}/${HOST_OUTSIDE_ALLOW_LIST}] granted [${HOST_SECTION}]: false {}`,
				`${ACL_NON_ADMIN_USER_ID} [${REF_SECTION}/${REF_IDS[0]} ${REF_SECTION}/${PAST_REFS[0]?.id}] granted [${REF_SECTION}]: true {${REF_SECTION}/${PAST_REFS[0]?.id}}`,
				`-1 [${HOST_SECTION}/${HOST_ID}] granted []: false {}`,
			]);
		});

		test("the grid's SQL section_top projection is the page's group key, stored shape by stored shape", async () => {
			// The past probe projects breakdown rows onto their section_top in SQL
			// (sectionTopProjection); the page groups the hits it read in JS
			// (groupBySectionTop → sectionTopGroupHits) and scopes each group as that
			// record. A hand twin: every stored form of section_top_tipo/_id must
			// project to the SAME record — or, only where the strict-integer rule
			// refuses a form the page's Number() reads as a record ('007', ' 7',
			// '7.0', past 15 digits), to NO record (the probe may miss a visible group,
			// never claim a hidden one). The relation of each shape is pinned, so
			// an arm that stops matching moves an 'equal' to 'sql-none' and reddens.
			const { groupBySectionTop, sectionTopGroupHits, sectionTopProjection } = await import(
				'../../src/core/section/indexation_grid.ts'
			);
			const owner = { section_tipo: REF_SECTION, section_id: REF_IDS[0] as number };
			const shapes: [string, 'equal' | 'sql-none' | 'both-none'][] = [
				['{}', 'equal'],
				['{"section_top_tipo":"zzpg11","section_top_id":900757}', 'equal'],
				['{"section_top_id":null}', 'equal'],
				['{"section_top_tipo":null,"section_top_id":5}', 'equal'],
				['{"section_top_tipo":5}', 'equal'],
				['{"section_top_tipo":"zzpg11"}', 'equal'],
				['{"section_top_id":"7"}', 'equal'],
				['{"section_top_id":"0"}', 'equal'],
				['{"section_top_id":"-4"}', 'equal'],
				['{"section_top_id":7.0}', 'equal'],
				['{"section_top_id":-3}', 'equal'],
				['{"section_top_id":123456789012345}', 'equal'],
				['{"section_top_id":"007"}', 'sql-none'],
				['{"section_top_id":" 7"}', 'sql-none'],
				['{"section_top_id":"7.0"}', 'sql-none'],
				['{"section_top_id":1234567890123456}', 'sql-none'],
				['{"section_top_id":7.5}', 'both-none'],
				['{"section_top_id":"abc"}', 'both-none'],
				['{"section_top_id":true}', 'both-none'],
				['{"section_top_id":1e20}', 'both-none'],
				['{"section_top_id":9007199254740993}', 'both-none'],
			];
			const seen: string[] = [];
			const expected: string[] = [];
			for (const [locatorData, relation] of shapes) {
				const [page] = sectionTopGroupHits(
					groupBySectionTop([{ ...owner, locator_data: JSON.parse(locatorData) }]),
				);
				const projected = sectionTopProjection({
					sql: 'SELECT $1::text AS section_tipo, $2::int AS section_id, $3::text::jsonb AS locator_data',
					params: [owner.section_tipo, owner.section_id, locatorData],
				});
				const [row] = (await sql.unsafe(projected.sql, projected.params as never)) as {
					section_tipo: string;
					section_id: unknown;
				}[];
				const sqlId = row?.section_id === null ? null : Number(row?.section_id);
				const pageId = Number.isSafeInteger(page?.section_id) ? page?.section_id : null;
				const actual =
					row?.section_tipo !== page?.section_tipo
						? `tipo ${row?.section_tipo} vs ${page?.section_tipo}`
						: sqlId === pageId && sqlId !== null
							? 'equal'
							: sqlId === null && pageId === null
								? 'both-none'
								: sqlId === null
									? 'sql-none'
									: `id ${sqlId} vs ${page?.section_id}`;
				seen.push(`${locatorData}: ${actual}`);
				expected.push(`${locatorData}: ${relation}`);
			}
			expect(seen).toEqual(expected);
		});

		test('get_indexation_grid: the past probe scopes each row as its SECTION_TOP group AND its own record', async () => {
			// Three hosts, each a full visible page (TOP_PAGE, every record its own
			// top) and ONE row past it whose owner and section_top disagree for the
			// reader — the page scopes that row as its top AND withholds it when
			// its own (indexing) record is out of scope, so the probe must too:
			//   - HOST3: owner VISIBLE, top a HIDDEN record → nothing past is the
			//     reader's: no notice (an owner-scoped probe claims one);
			//   - HOST4: owner HIDDEN, top a VISIBLE record → the page WITHHOLDS the
			//     row (its indexing record is out of scope — the row record key,
			//     WC-2026-11-10-indexation-grid-read-door), so nothing past is the
			//     reader's: no notice (a top-only probe claims one). Re-pinned
			//     2026-11-10 from `true` (group scope only) with that law;
			//   - HOST5: owner VISIBLE, top the same id in a section the reader may
			//     not read (zzpg11) → no notice (a probe that kept the owner's
			//     section would ask about a visible zzpg3 record).
			const door = PAGE_DOORS.find((page) => page.door.key === 'dd_core_api:get_indexation_grid')
				?.door as Door;
			const cells: [number, boolean][] = [
				[HOST3_ID, false],
				[HOST4_ID, false],
				[HOST5_ID, false],
			];
			for (const [hostId, owed] of cells) {
				const onHost = atHost(INDEXATION_TEMPLATE, hostId, [REF_SECTION]);
				const reader = await drive(door, onHost, ABSENT, 0, 'reader');
				expect({
					host: hostId,
					status: reader.status,
					markers: reader.markers,
					notice: noticeCodes(reader.body).includes('search.page_clamped'),
				}).toEqual({ host: hostId, status: 200, markers: CEILING, notice: owed });
				// CONTROL: the admin (unscoped) is owed the notice on every host.
				const admin = await drive(door, onHost, ABSENT, 0, 'admin');
				expect({
					host: hostId,
					notice: noticeCodes(admin.body).includes('search.page_clamped'),
				}).toEqual({ host: hostId, notice: true });
			}
		});

		test('anyRowInScope: a row naming no section is no record — it neither throws nor masks a visible row', async () => {
			const { anyRowInScope } = await import('../../src/core/security/record_scope.ts');
			const reader = await resolvePrincipal(ACL_NON_ADMIN_USER_ID);
			const ask = (rows: [string | null, number][]) =>
				anyRowInScope(
					{
						sql: `SELECT v.section_tipo, v.section_id FROM (VALUES ${rows
							.map((_, index) => `($${index * 2 + 1}::text, $${index * 2 + 2}::int)`)
							.join(', ')}) AS v(section_tipo, section_id)`,
						params: rows.flat(),
					},
					reader,
				);
			expect([
				await ask([[null, PAST_REFS[0]?.id as number]]),
				await ask([
					[null, PAST_REFS[0]?.id as number],
					[REF_SECTION, PAST_REFS[0]?.id as number],
				]),
			]).toEqual([false, true]);
		});

		for (const { door, template } of PAGE_DOORS) {
			test(`${door.key}: the probe asks the PAGE's question — a narrowed request whose own rows are whole carries no notice`, async () => {
				// HOST2 is referenced by nine zzpg3 records and two zzpg11 ones.
				expect(SECOND_REF_IDS.length).toBeLessThan(CEILING);
				const narrowed = await drive(
					door,
					atHost(template, HOST2_ID, [SECOND_REF_SECTION]),
					ABSENT,
					0,
				);
				expect({
					status: narrowed.status,
					markers: narrowed.markers,
					notice: noticeCodes(narrowed.body).includes('search.page_clamped'),
				}).toEqual({ status: 200, markers: SECOND_REF_IDS.length, notice: false });
				// CONTROL: unnarrowed, the same host's default page DOES cut rows.
				const wide = await drive(door, atHost(template, HOST2_ID, ['all']), ABSENT, 0);
				expect({
					markers: wide.markers,
					notice: noticeCodes(wide.body).includes('search.page_clamped'),
				}).toEqual({ markers: CEILING, notice: true });
			});
		}

		for (const { door, template } of PAGE_DOORS) {
			test(`${door.key}: an absent limit whose answer is WHOLE carries no notice`, async () => {
				const cells: { limit: PageValue; offset: PageValue; markers: number }[] = [
					// Exactly the last full page: a full window, nothing past it.
					{ limit: ABSENT, offset: CEILING, markers: CEILING },
					// A short page.
					{ limit: ABSENT, offset: REF_IDS.length - 2, markers: 2 },
					{ limit: null, offset: REF_IDS.length - 2, markers: 2 },
				];
				for (const cell of cells) {
					const answer = await drive(door, template, cell.limit, cell.offset);
					const seen = {
						status: answer.status,
						markers: answer.markers,
						notice: noticeCodes(answer.body).includes('search.page_clamped'),
					};
					expect({ cell: `${label(cell.limit)}@${label(cell.offset)}`, ...seen }).toEqual({
						cell: `${label(cell.limit)}@${label(cell.offset)}`,
						status: 200,
						markers: cell.markers,
						notice: false,
					});
				}
			});
		}

		for (const { door, template } of PAGE_DOORS) {
			test(`${door.key}: every hostile window is a bounded 200 (or a wire refusal), never unbounded or a 500`, async () => {
				const failures: string[] = [];
				let answered = 0;
				for (const limit of HOSTILE_LIMITS) {
					for (const offset of HOSTILE_OFFSETS) {
						const cell = `limit=${label(limit)} offset=${label(offset)}`;
						const answer = await drive(door, template, limit, offset);
						if (answer.outcome === 'wire') {
							// Only a non-numeric offset may be refused by the wire schema.
							if (typeof offset === 'number' || offset === ABSENT) {
								failures.push(`${cell}: refused at the wire`);
							}
							continue;
						}
						if (answer.outcome !== 'answered') {
							failures.push(`${cell}: ${answer.outcome} ${answer.error ?? ''}`);
							continue;
						}
						answered++;
						if (answer.status !== 200) {
							const code = (answer.body.error as { code?: string } | undefined)?.code;
							failures.push(`${cell}: status ${answer.status} (${code})`);
							continue;
						}
						const expected = Math.max(
							0,
							Math.min(CEILING, REF_IDS.length - appliedOffsetOf(offset)),
						);
						if (answer.markers !== expected) {
							failures.push(`${cell}: ${answer.markers} records (expected ${expected})`);
						}
						const owed = owesNotice(limit, offset);
						const noticed = noticeCodes(answer.body).includes('search.page_clamped');
						if (owed !== noticed) {
							failures.push(`${cell}: notice ${noticed ? 'present' : 'absent'}, owed=${owed}`);
						}
						if (rowBounded(door.key) && !(answer.sinkMaxRows <= CEILING + 1)) {
							failures.push(
								`${cell}: a sink statement returned ${answer.sinkMaxRows} rows (> ${CEILING + 1})`,
							);
						}
					}
				}
				// Anti-vacuity: the numeric offsets all reached the door.
				expect(answered).toBeGreaterThanOrEqual(HOSTILE_LIMITS.length * 3);
				expect(failures).toEqual([]);
			}, 120_000);
		}

		for (const { indexTipo, strategy } of [
			{ indexTipo: 'zzpg2', strategy: 'no request_config — the per-locator emission' },
			{ indexTipo: OWN_CONFIG_INDEX, strategy: 'its OWN request_config — the subdatum emission' },
		]) {
			test(`a DDO-borne window (show.ddo_map[].limit) on a component_relation_index is bounded like any client page (${indexTipo}: ${strategy})`, async () => {
				// The client's literal show.ddo_map wins in a section read, and a
				// component_relation_index pages its INVERSE set (unbounded by the
				// record's own data) at that ddo's limit. Hostile values the ddo schema
				// accepts as integers are clamped to the ceiling; one in range is honoured.
				const context = await callerContext('admin');
				const cells: { limit: PageValue; applied: number }[] = [
					{ limit: ABSENT, applied: CEILING },
					{ limit: 0, applied: CEILING },
					{ limit: 2, applied: 2 },
					{ limit: CEILING + 4, applied: CEILING },
					{ limit: 1e9, applied: CEILING },
					{ limit: Number.MAX_SAFE_INTEGER, applied: CEILING },
				];
				const seen: unknown[] = [];
				const expected: unknown[] = [];
				for (const cell of cells) {
					const rqo = {
						action: 'read',
						dd_api: 'dd_core_api',
						prevent_lock: true,
						options: {},
						source: {
							typo: 'source',
							model: 'section',
							tipo: HOST_SECTION,
							section_tipo: HOST_SECTION,
							section_id: HOST_ID,
							mode: 'edit',
							lang: 'lg-spa',
						},
						sqo: {
							section_tipo: [HOST_SECTION],
							filter_by_locators: [{ section_tipo: HOST_SECTION, section_id: HOST_ID }],
							limit: 1,
							offset: 0,
						},
						show: {
							ddo_map: [
								{
									tipo: indexTipo,
									section_tipo: HOST_SECTION,
									parent: HOST_SECTION,
									mode: 'edit',
									...(cell.limit === ABSENT ? {} : { limit: cell.limit }),
								},
							],
						},
					};
					const parsed = rqoSchema.safeParse(rqo);
					if (!parsed.success) {
						seen.push({ limit: label(cell.limit), wire: 'refused' });
						expected.push({
							limit: label(cell.limit),
							entries: cell.applied,
							pageLimit: cell.applied,
						});
						continue;
					}
					const result = await dispatchRqo(parsed.data, context as never);
					const data = ((result.body as { data?: { data?: unknown[] } }).data?.data ?? []) as {
						tipo?: string;
						section_id?: unknown;
						entries?: unknown;
						pagination?: { limit?: number; total?: number };
					}[];
					const item = data.find(
						(entry) => entry.tipo === indexTipo && Number(entry.section_id) === HOST_ID,
					);
					seen.push({
						limit: label(cell.limit),
						entries: Array.isArray(item?.entries) ? item.entries.length : null,
						pageLimit: item?.pagination?.limit ?? null,
					});
					expected.push({
						limit: label(cell.limit),
						entries: Math.min(cell.applied, REF_IDS.length),
						pageLimit: cell.applied,
					});
				}
				expect(seen).toEqual(expected);
			});
		}

		/** Membership, measured once: door key → the template that reached the sink. */
		let membership: Promise<{
			members: Map<string, Template>;
			unrun: string[];
			driven: number;
		}> | null = null;
		function measureMembership() {
			membership ??= (async () => {
				const members = new Map<string, Template>();
				const unrun: string[] = [];
				let driven = 0;
				for (const door of allDoors()) {
					if (UNDRIVABLE.has(door.key)) continue;
					for (const template of TEMPLATES) {
						const answer = await drive(door, template, 2, 0);
						if (answer.outcome === 'timeout' || answer.outcome === 'threw') {
							unrun.push(`${door.key} (${template.name}): ${answer.outcome} ${answer.error ?? ''}`);
							continue;
						}
						driven++;
						if (answer.reachedSink && !members.has(door.key)) members.set(door.key, template);
					}
				}
				console.log(`[client_page_doors] sink members: ${[...members.keys()].join(', ')}`);
				return { members, unrun, driven };
			})();
			return membership;
		}
		const doorByKey = (key: string): Door => {
			const door = allDoors().find((candidate) => candidate.key === key);
			if (door === undefined) throw new Error(`no door '${key}'`);
			return door;
		};

		test('the door set is DERIVED: every door that reaches the relation sink declares its page posture', async () => {
			const { members, unrun, driven } = await measureMembership();
			// Every door could be driven (an undrivable one is a NAMED exemption).
			expect(unrun).toEqual([]);
			expect(driven).toBeGreaterThan(40);
			// Anti-vacuity floor: the three known page doors are found by the probe.
			for (const known of PAGE_DOORS.map((page) => page.door.key)) {
				expect([...members.keys()]).toContain(known);
			}
			const undeclared = [...members.keys()].filter((key) => {
				if (key === 'dd_core_api:get_indexation_grid') return false;
				if (MEMBERS_WITHOUT_ROUTE_POSTURE.has(key)) return false;
				const route = key.startsWith('dd_core_api:read#')
					? key.slice('dd_core_api:read#'.length)
					: null;
				if (route === null) return true;
				const posture =
					route === '(default)'
						? readFacade.SECTION_READ_DEFAULT_PAGE
						: sectionReadRoutes?.get(route)?.page;
				return posture !== 'client_sqo';
			});
			expect(undeclared).toEqual([]);
			// Shrink-only: an exemption that no longer names a member is stale.
			for (const key of MEMBERS_WITHOUT_ROUTE_POSTURE.keys())
				expect([...members.keys()]).toContain(key);
			for (const key of BREAKDOWN_SINK_DOORS.keys()) expect([...members.keys()]).toContain(key);
			// Anti-vacuity of the row bound: the windowed-sink doors are row-bounded.
			expect([...members.keys()].filter(rowBounded).length).toBeGreaterThanOrEqual(2);
		}, 600_000);

		test('the universal bound: EVERY sink member answers every hostile window with a 200 of at most the ceiling', async () => {
			const { members } = await measureMembership();
			expect(members.size).toBeGreaterThanOrEqual(PAGE_DOORS.length);
			const failures: string[] = [];
			for (const [key, template] of members) {
				const door = doorByKey(key);
				for (const limit of HOSTILE_LIMITS) {
					for (const offset of HOSTILE_OFFSETS) {
						const answer = await drive(door, template, limit, offset);
						const cell = `${key} limit=${label(limit)} offset=${label(offset)}`;
						if (answer.outcome === 'wire') {
							if (typeof offset === 'number' || offset === ABSENT) {
								failures.push(`${cell}: refused at the wire`);
							}
							continue;
						}
						if (answer.outcome !== 'answered' || answer.status !== 200) {
							const code = (answer.body.error as { code?: string } | undefined)?.code;
							failures.push(
								`${cell}: ${answer.outcome} status ${answer.status} (${code ?? answer.error ?? ''})`,
							);
							continue;
						}
						if (answer.markers > CEILING) failures.push(`${cell}: ${answer.markers} records`);
						if (rowBounded(key) && !(answer.sinkMaxRows <= CEILING + 1)) {
							failures.push(`${cell}: a sink statement returned ${answer.sinkMaxRows} rows`);
						}
					}
				}
			}
			expect(failures).toEqual([]);
		}, 600_000);

		test('every member bounds its OWN page: driven with the wire schema BYPASSED, each hostile window is a 200 of at most the ceiling', async () => {
			// The wire bound (wireSqoSchema) is the backstop, never the bound: a
			// member must bound the window it is HANDED. Same cells as the universal
			// bound above, minus the parse — so no cell can be 'refused at the wire',
			// and a door that forwards a raw offset to the sink (1e21 → the sink's
			// search.invalid_sqo, 400) or a raw limit reddens here.
			const { members } = await measureMembership();
			expect(members.size).toBeGreaterThanOrEqual(PAGE_DOORS.length);
			expect([...members.keys()]).toContain('dd_core_api:read#(default)');
			const failures: string[] = [];
			for (const [key, template] of members) {
				const door = doorByKey(key);
				for (const limit of HOSTILE_LIMITS) {
					for (const offset of HOSTILE_OFFSETS) {
						const answer = await drive(door, template, limit, offset, 'admin', 'bypassed');
						const cell = `${key} limit=${label(limit)} offset=${label(offset)} (wire bypassed)`;
						if (answer.outcome !== 'answered' || answer.status !== 200) {
							const code = (answer.body.error as { code?: string } | undefined)?.code;
							failures.push(
								`${cell}: ${answer.outcome} status ${answer.status} (${code ?? answer.error ?? ''})`,
							);
							continue;
						}
						if (answer.markers > CEILING) failures.push(`${cell}: ${answer.markers} records`);
					}
				}
			}
			expect(failures).toEqual([]);
		}, 600_000);

		test('SECTION_READ_ROUTES is the exported route table and the page routes declare client_sqo', () => {
			expect(sectionReadRoutes instanceof Map).toBe(true);
			for (const route of ['get_relation_list', 'related_search']) {
				expect(sectionReadRoutes?.get(route)?.page).toBe('client_sqo');
			}
		});
	});
}
