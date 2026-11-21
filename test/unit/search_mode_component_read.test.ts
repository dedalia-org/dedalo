/**
 * Search-panel component READ in mode 'search' (the service_autocomplete
 * picker) — the dd543 "Who" portal of Activity (dd542). Reported 2026-07-18:
 * "the search of the who dd543 in activity section doesn't work".
 *
 * TWO stacked defects, both server-side:
 *
 * 1. The search-panel portal instance runs in mode 'search' and the client
 *    stamps it on the source (create_source) — readSectionRows THREW
 *    "mode 'search' not implemented yet (covered: 'list', 'edit', 'tm')" on
 *    every typeahead keystroke, so the picker never listed users. PHP serves
 *    the same RQO fine (dd_core_api.php:2256 case 'search'). The BUG-0 gate
 *    only covered the EDIT-form picker (source.mode 'list'), so the
 *    search-panel door stayed red. Fixed by normalizing source.mode
 *    'search' → 'list' in readSection/readSectionRows.
 *
 * 2. resolveSearchData echoed the picked locator VERBATIM, and the datalist
 *    publishes the envelope's NUMERIC section_id — so the chip entries fed
 *    get_search_value a numeric section_id and the final filter's JSONB
 *    containment missed the string-stored locators (0 rows). PHP's locator
 *    casts set_section_id to string (class.locator.php:338). Fixed by
 *    echoing a CANONICAL section_id — string then; INT since
 *    WC-2026-08-10-section-id-int-canonical, where the containment probe went
 *    dual-form so both stored types are matched regardless of the echo.
 *
 * 3. The REAL client pick lands on the SAVE action (link_record → change_value,
 *    host id 'search_1'), not resolve_data — and the dd_core_api search_ save
 *    branch looked the resolved main item up by section_id 'search_1', which
 *    resolveSearchData never stamps (synthetic record ⇒ null identity). The
 *    always-firing fallback rebuilt the chip from the RAW numeric picked
 *    locator, undoing fix 2 on the only path the client uses. Fixed by
 *    matching on tipo+section_tipo and re-stamping the synthetic id.
 *
 * 4. The save branch echoed ONLY the changed_data inserts, but the client
 *    reuses the echo as its whole next state (refresh tmp_api_response) — a
 *    second pick silently dropped the first chip and an unlink cleared ALL
 *    chips. Fixed by reconciling the client's ridden-along current entries
 *    with the insert/remove deltas server-side. NOTE: a multi-chip filter
 *    still ANDs its locators in ONE @> containment — PHP-parity
 *    (extract_normalized_relation_q strips the array brackets into a single
 *    {"tipo":[loc1,loc2]} wrapper); OR semantics would be a WC divergence.
 *
 * Scratch twins (a fake user + two activity rows) are SQL-seeded and deleted
 * in afterAll — root is hidden from user searches by design
 * (root_user_hidden_tripwire), so a non-root twin is required for a positive
 * typeahead assertion.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ApiRequestContext } from '../../src/core/api/dispatch.ts';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

const ACTIVITY = 'dd542'; // consultation-only
const WHO_PORTAL = 'dd543'; // component_portal → matrix_activity.relation
const USERS = 'dd128';
const USERNAME = 'dd132'; // the target's display component (resolved chip label)

const TWIN_USER_ID = 999901;
const TWIN_USERNAME = 'zz_search_twin';
const TWIN_USER_ID_2 = 999902; // second picker target (multi-chip reconcile test)
const TWIN_USERNAME_2 = 'zz_search_twin_2';
const TWIN_ACTIVITY_IDS = [999901, 999902];
// Three more picker targets: the T2-SL-1 gate injects FIVE chips past a page of two.
const EXTRA_TWIN_USERS = [
	[999903, 'zz_search_twin_3'],
	[999904, 'zz_search_twin_4'],
	[999905, 'zz_search_twin_5'],
] as const;
const ALL_TWIN_USERS = [
	[TWIN_USER_ID, TWIN_USERNAME],
	[TWIN_USER_ID_2, TWIN_USERNAME_2],
	...EXTRA_TWIN_USERS,
] as const;

let ctx: ApiRequestContext;

async function deleteTwins(): Promise<void> {
	await sql.unsafe(
		`DELETE FROM matrix_activity WHERE section_tipo = $1 AND section_id IN (${TWIN_ACTIVITY_IDS.join(',')})`,
		[ACTIVITY],
	);
	await sql.unsafe(
		`DELETE FROM matrix_users WHERE section_tipo = $1 AND section_id IN (${ALL_TWIN_USERS.map(([id]) => id).join(',')})`,
		[USERS],
	);
}

async function seedTwins(): Promise<void> {
	// Idempotent: clear any leftover from a crashed run first.
	await deleteTwins();
	for (const [userId, username] of ALL_TWIN_USERS) {
		await sql.unsafe(
			`INSERT INTO matrix_users (section_id, section_tipo, string, relation)
			 VALUES ($1, $2, $3::text::jsonb, '{}'::jsonb)`,
			[userId, USERS, JSON.stringify({ [USERNAME]: [{ lang: 'lg-nolan', value: username }] })],
		);
	}
	for (const activityId of TWIN_ACTIVITY_IDS) {
		await sql.unsafe(
			`INSERT INTO matrix_activity (section_id, section_tipo, relation, string)
			 VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb)`,
			[
				activityId,
				ACTIVITY,
				JSON.stringify({
					[WHO_PORTAL]: [
						{
							// LEGACY string-stored address, kept deliberately: it is what a
							// pre-sweep install holds, and the search below (an int chip
							// against a string row) is live proof that the containment probe
							// is DUAL-FORM (WC-2026-08-10-section-id-int-canonical).
							section_id: String(TWIN_USER_ID),
							type: 'dd151',
							section_tipo: USERS,
							from_component_tipo: WHO_PORTAL,
						},
					],
				}),
				JSON.stringify({ dd544: [{ lang: 'lg-nolan', value: 'search-mode-gate' }] }),
			],
		);
	}
}

beforeAll(async () => {
	const token = createSession(-1, 'root', true);
	registerSessionCleanup();
	const session = getSession(token);
	ctx = {
		requestId: 'search_mode_component_read_test',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal: await resolvePrincipal(-1),
	} as ApiRequestContext;
	await seedTwins();
}, 60000);

afterAll(async () => {
	await deleteTwins();
});

/** The exact client typeahead RQO (service_autocomplete from a search panel). */
function typeaheadRqo(q: string): Rqo {
	return {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			typo: 'source',
			type: 'component',
			model: 'component_portal',
			tipo: WHO_PORTAL,
			section_tipo: ACTIVITY,
			section_id: 'search_1', // client-minted synthetic id (search.js get_section_id)
			mode: 'search', // the search-panel portal's mode — stamped onto the source
			lang: 'lg-eng',
			action: 'search',
		},
		show: {
			ddo_map: [
				{
					tipo: USERNAME,
					section_tipo: USERS,
					parent: WHO_PORTAL,
					mode: 'list',
					model: 'component_input_text',
				},
			],
			fields_separator: ', ',
			columns: [],
		},
		sqo: {
			mode: 'search',
			section_tipo: [USERS],
			filter: {
				$and: [
					{
						$or: [
							{
								q,
								path: [
									{
										tipo: USERNAME,
										section_tipo: USERS,
										parent: WHO_PORTAL,
										mode: 'list',
										model: 'component_input_text',
										component_tipo: USERNAME,
									},
								],
								q_split: true,
							},
						],
					},
				],
			},
			offset: 0,
			limit: 10,
			full_count: false,
			allow_sub_select_by_id: true,
		},
	} as unknown as Rqo;
}

/** The resolve_data chip echo (same shape as the search_ save echo). */
function echoRqo(
	injectedSectionId: number | string | (number | string)[],
	sqo?: Record<string, unknown>,
): Rqo {
	const ids = Array.isArray(injectedSectionId) ? injectedSectionId : [injectedSectionId];
	return {
		...(sqo === undefined ? {} : { sqo }),
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			typo: 'source',
			type: 'component',
			model: 'component_portal',
			tipo: WHO_PORTAL,
			section_tipo: ACTIVITY,
			section_id: 'search_1',
			mode: 'search',
			lang: 'lg-eng',
			action: 'resolve_data',
			value: ids.map((id) => ({
				section_tipo: USERS,
				section_id: id,
				from_component_tipo: WHO_PORTAL,
			})),
		},
	} as unknown as Rqo;
}

/**
 * The exact client PICK contract: link_record → change_value → action 'save' on
 * the client-minted 'search_1' host (component_portal.js:982 → component_common
 * .js:672). The response is reused verbatim via refresh({tmp_api_response}) —
 * whatever entries it carries become the search q.
 */
function pickSaveRqo(
	changedData: Record<string, unknown>[],
	existingEntries: Record<string, unknown>[] = [],
): Rqo {
	return {
		action: 'save',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			typo: 'source',
			type: 'component',
			model: 'component_portal',
			tipo: WHO_PORTAL,
			section_tipo: ACTIVITY,
			section_id: 'search_1',
			mode: 'search',
			lang: 'lg-eng',
			action: 'save',
		},
		// clone(self.data): the portal's CURRENT chips ride along in entries.
		data: {
			entries: existingEntries,
			changed_data: changedData,
		},
	} as unknown as Rqo;
}

/** link_record's single-insert delta (the NUMERIC datalist locator). */
function insertChange(pickedSectionId: number | string): Record<string, unknown> {
	return {
		action: 'insert',
		id: null,
		value: {
			type: 'dd151',
			section_tipo: USERS,
			section_id: pickedSectionId,
			from_component_tipo: WHO_PORTAL,
		},
	};
}

describe('search-mode component read (Activity dd542 Who picker)', () => {
	test('typeahead (source.mode search) resolves users instead of throwing', async () => {
		const { body } = await dispatchRqo(typeaheadRqo(TWIN_USERNAME), ctx);
		const result = (body as { data?: { data?: Record<string, unknown>[] } }).data;
		expect(result).toBeDefined();

		const data = result?.data ?? [];
		const usernames = data
			.filter((item) => item.tipo === USERNAME)
			.map((item) => (item.entries as { value?: unknown }[])?.[0]?.value);
		expect(usernames).toContain(TWIN_USERNAME);
		// root stays hidden from user searches by design (root_user_hidden_tripwire).
		const rootItems = data.filter(
			(item) => item.tipo === USERNAME && String(item.section_id) === '-1',
		);
		expect(rootItems.length).toBe(0);
	});

	test('chip echo emits the injected section_id as int (WC-2026-08-10-section-id-int-canonical)', async () => {
		const { body } = await dispatchRqo(echoRqo(TWIN_USER_ID), ctx);
		const result = (body as { data?: { data?: Record<string, unknown>[] } }).data;
		expect(result).toBeDefined();

		const data = result?.data ?? [];
		const mainItem = data.find((item) => item.tipo === WHO_PORTAL) as
			| { entries?: Record<string, unknown>[] }
			| undefined;
		expect(mainItem).toBeDefined();
		const entry = mainItem?.entries?.[0];
		// WC-2026-08-10-section-id-int-canonical: the echo emitted the string
		// "999901" in the PHP-locator era; a record address is an int now.
		expect(typeof entry?.section_id).toBe('number');
		expect(entry?.section_id).toBe(TWIN_USER_ID);

		// The chip label still resolves (the 2026-07-17 fix stays green).
		const usernameItem = data.find((item) => item.tipo === USERNAME) as
			| { entries?: { value?: unknown }[] }
			| undefined;
		expect(usernameItem?.entries?.[0]?.value).toBe(TWIN_USERNAME);
	});

	test('T2-SL-1: every injected chip resolves its child data past the page; pagination is an echo', async () => {
		// PHP resolve_data: set_data(source.value) is the FULL injected value and
		// sqo.limit/offset are only stamped on the element. The engine sliced the
		// injected locators by sqo.limit with no offset, so the chips beyond one
		// page (page 2 of a search-mode portal, or an 11th chip) had no label.
		const ids = ALL_TWIN_USERS.map(([id]) => id);
		const { body } = await dispatchRqo(echoRqo(ids, { limit: 2, offset: 2 }), ctx);
		const data = (body as { data?: { data?: Record<string, unknown>[] } }).data?.data ?? [];
		const mainItem = data.find((item) => item.tipo === WHO_PORTAL) as
			| { entries?: Record<string, unknown>[]; pagination?: Record<string, unknown> }
			| undefined;
		expect(mainItem?.entries?.map((entry) => entry.section_id)).toEqual(ids);
		expect(mainItem?.entries?.map((entry) => entry.id)).toEqual([1, 2, 3, 4, 5]);
		// One child row per injected locator, each stamped with its target.
		const labels = data
			.filter((item) => item.tipo === USERNAME)
			.map((item) => [
				Number(item.section_id),
				(item.entries as { value?: unknown }[])?.[0]?.value,
			]);
		expect(labels).toEqual(ALL_TWIN_USERS.map(([id, name]) => [id, name]));
		// The request's page is echoed, never applied; total is the injected count.
		expect(mainItem?.pagination).toEqual({ total: 5, limit: 2, offset: 2 });
	});

	test('T2-SL-1: an oversized source.value is refused loudly (request.invalid_source)', async () => {
		const { CLIENT_MAX_LOCATOR_PINS } = await import('../../src/core/concepts/sqo.ts');
		const atBound = Array.from({ length: CLIENT_MAX_LOCATOR_PINS }, () => TWIN_USER_ID);
		const accepted = await dispatchRqo(echoRqo(atBound), ctx);
		expect((accepted.body as { ok?: boolean }).ok).toBe(true);
		const refused = await dispatchRqo(echoRqo([...atBound, TWIN_USER_ID_2]), ctx);
		const refusedBody = refused.body as { ok?: boolean; error?: { code?: string } };
		expect(refusedBody.ok).toBe(false);
		expect(refusedBody.error?.code).toBe('request.invalid_source');
		expect(refused.status).toBe(400);
	});

	test("save on the 'search_1' host echoes int entries under the synthetic id", async () => {
		const { body } = await dispatchRqo(pickSaveRqo([insertChange(TWIN_USER_ID)]), ctx);
		const result = (body as { data?: { data?: Record<string, unknown>[] } }).data;
		expect(result).toBeDefined();

		const data = result?.data ?? [];
		// The client picks its item by tipo + section_tipo + synthetic section_id
		// (component_common.js:400) — a null/absent section_id loses the chip.
		const mainItem = data.find(
			(item) =>
				item.tipo === WHO_PORTAL &&
				item.section_tipo === ACTIVITY &&
				String(item.section_id) === 'search_1',
		) as { entries?: Record<string, unknown>[]; pagination?: { total?: number } } | undefined;
		expect(mainItem).toBeDefined();

		// The echoed chip carries the INT section_id the containment needs
		// (WC-2026-08-10-section-id-int-canonical; the containment probe is
		// dual-form, the emitted address is not). The HOST id stays the
		// synthetic 'search_1' token — a different concept, asserted above.
		const entry = mainItem?.entries?.[0];
		expect(typeof entry?.section_id).toBe('number');
		expect(entry?.section_id).toBe(TWIN_USER_ID);

		// link_record's server-authoritative duplicate check reads pagination.total
		// and requires it to exceed the pre-insert count (component_portal.js:1063).
		expect(mainItem?.pagination?.total).toBe(1);

		// The chip label resolves (the picked user's username subdatum).
		const usernameItem = data.find((item) => item.tipo === USERNAME) as
			| { entries?: { value?: unknown }[] }
			| undefined;
		expect(usernameItem?.entries?.[0]?.value).toBe(TWIN_USERNAME);
	});

	test('second pick keeps the first chip; unlink removes only its target', async () => {
		// Helper: run a pick/unlink save and return the echoed main-item entries.
		const saveEntries = async (
			changedData: Record<string, unknown>[],
			existing: Record<string, unknown>[],
		): Promise<Record<string, unknown>[]> => {
			const { body } = await dispatchRqo(pickSaveRqo(changedData, existing), ctx);
			const data = (body as { data?: { data?: Record<string, unknown>[] } }).data?.data ?? [];
			const mainItem = data.find(
				(item) => item.tipo === WHO_PORTAL && String(item.section_id) === 'search_1',
			) as { entries?: Record<string, unknown>[] } | undefined;
			expect(mainItem).toBeDefined();
			return mainItem?.entries ?? [];
		};

		// Pick twin 1 on an empty filter, then twin 2 with twin 1 already chipped
		// (the client sends clone(self.data) — the reconcile must KEEP chip 1).
		// WC-2026-08-10-section-id-int-canonical: the echoed addresses are ints,
		// so compare the values directly (no String() laundering).
		const afterFirst = await saveEntries([insertChange(TWIN_USER_ID)], []);
		expect(afterFirst.map((entry) => entry.section_id)).toEqual([TWIN_USER_ID]);

		const afterSecond = await saveEntries([insertChange(TWIN_USER_ID_2)], afterFirst);
		expect(afterSecond.map((entry) => entry.section_id)).toEqual([TWIN_USER_ID, TWIN_USER_ID_2]);
		// Re-stamped ids 1..n, every section_id echoed as int.
		expect(afterSecond.map((entry) => entry.id)).toEqual([1, 2]);
		for (const entry of afterSecond) {
			expect(typeof entry.section_id).toBe('number');
		}

		// Duplicate pick: the reconcile drops it, the set is unchanged.
		const afterDuplicate = await saveEntries([insertChange(TWIN_USER_ID)], afterSecond);
		expect(afterDuplicate.map((entry) => entry.section_id)).toEqual([TWIN_USER_ID, TWIN_USER_ID_2]);

		// Unlink chip 1 (unlink_record sends 'remove' by the entry id stamp):
		// only its target drops — previously EVERY chip was cleared.
		const afterUnlink = await saveEntries(
			[{ action: 'remove', id: afterSecond[0]?.id ?? 1, value: null }],
			afterSecond,
		);
		expect(afterUnlink.map((entry) => String(entry.section_id))).toEqual([String(TWIN_USER_ID_2)]);
		expect(afterUnlink[0]?.id).toBe(1); // re-stamped from 1 again
	});

	test('dd15 (Time Machine) fields build in the search panel instead of throwing', async () => {
		// Reported 2026-07-18: dragging any Time Machine (dd15) field into the search
		// panel rendered a red "Invalid component". dd15 is a VIRTUAL section whose
		// matrix "table" is matrix_time_machine — rejected by readMatrixRecord's
		// identifier allowlist. The search-panel component read addresses a SYNTHETIC
		// id ('search_<n>', Number() → NaN) that maps to NO record, but the read
		// tried to load it anyway and threw ("Refusing unknown matrix table"), so
		// the client's build() got result.context.length === 0 → "Invalid component".
		// Fix: a synthetic (non-numeric) id resolves to a null record WITHOUT the DB
		// read, so the search branches build the record-independent widget.
		const TM_SECTION = 'dd15';
		// One field per model that reaches the two matrix-read branches: the JSONB
		// "Value" grid (component_json, non-relation) and the "Who" (component_portal,
		// relation) — both threw before the fix.
		const fields: { tipo: string; model: string }[] = [
			{ tipo: 'dd1574', model: 'component_json' }, // Value
			{ tipo: 'dd578', model: 'component_portal' }, // Who
			{ tipo: 'dd559', model: 'component_date' }, // When
		];
		for (const { tipo, model } of fields) {
			const rqo = {
				action: 'read',
				dd_api: 'dd_core_api',
				prevent_lock: true,
				source: {
					typo: 'source',
					type: 'component',
					model,
					tipo,
					section_tipo: TM_SECTION,
					section_id: 'search_8', // synthetic search-filter id (search.js get_section_id)
					mode: 'search',
					view: null,
					lang: 'lg-eng',
					action: 'get_data',
				},
			} as unknown as Rqo;
			const { body } = await dispatchRqo(rqo, ctx);
			expect((body as { ok?: boolean }).ok).toBe(true);
			const result = (body as { data?: { context?: unknown[]; data?: unknown[] } }).data;
			// Before the fix this was a failure envelope (Throwable Exception). The
			// client's build() gate is exactly `data.context?.length`.
			const context = (result as { context?: unknown[] }).context ?? [];
			expect(context.length).toBeGreaterThan(0);
		}
	});

	test('end-to-end: the picked entries drive a section filter that finds the rows', async () => {
		// 1. The real pick: SAVE on the 'search_1' host (link_record). The response
		// is what lands in the component's data.entries (refresh tmp_api_response).
		const { body: echoBody } = await dispatchRqo(pickSaveRqo([insertChange(TWIN_USER_ID)]), ctx);
		const echoData = (echoBody as { data?: { data?: Record<string, unknown>[] } }).data?.data ?? [];
		const echoMain = echoData.find(
			(item) => item.tipo === WHO_PORTAL && String(item.section_id) === 'search_1',
		) as {
			entries: Record<string, unknown>[];
		};
		// 2. The client's get_search_value + serialize_filter_model (id stamped to 1).
		const q = echoMain.entries.map((entry) => ({
			id: 1,
			section_tipo: entry.section_tipo,
			section_id: entry.section_id,
			from_component_tipo: entry.from_component_tipo,
		}));
		// 3. The section search read.
		const searchRqo = {
			action: 'read',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			options: {},
			source: {
				typo: 'source',
				model: 'section',
				tipo: ACTIVITY,
				section_tipo: ACTIVITY,
				action: 'search',
				mode: 'list',
				lang: 'lg-spa',
			},
			sqo: {
				section_tipo: [ACTIVITY],
				limit: 10,
				offset: 0,
				order: [{ direction: 'ASC', path: [{ component_tipo: 'section_id' }] }],
				filter: {
					$and: [
						{
							q,
							q_operator: null,
							path: [{ section_tipo: ACTIVITY, component_tipo: WHO_PORTAL }],
							q_split: false,
							type: 'jsonb',
						},
					],
				},
			},
			show: {
				ddo_map: [{ tipo: WHO_PORTAL, section_tipo: ACTIVITY, parent: ACTIVITY, mode: 'list' }],
			},
		} as unknown as Rqo;
		const { body } = await dispatchRqo(searchRqo, ctx);
		const data = (body as { data?: { data?: Record<string, unknown>[] } }).data?.data ?? [];
		const rows = data
			.filter((item) => item.tipo === WHO_PORTAL)
			.map((item) => Number(item.row_section_id))
			.sort((a, b) => a - b);
		expect(rows).toEqual(TWIN_ACTIVITY_IDS);
		// The Who column resolves the username subdatum for the found rows.
		const usernames = data
			.filter((item) => item.tipo === USERNAME)
			.map((item) => (item.entries as { value?: unknown }[])?.[0]?.value);
		expect(usernames).toContain(TWIN_USERNAME);
	});
});
