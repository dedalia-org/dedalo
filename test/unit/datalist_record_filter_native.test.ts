/**
 * THE DATALIST DOOR CARRIES THE RECORD (T1-9) AND HONOURS `filtered_by_search`
 * (T1-37) — PHP get_list_of_values (class.component_common.php :2860-2877).
 *
 * WHAT THIS GATE IS FOR.
 *  - A `fixed_filter` of source `component_data` narrows a select's options by
 *    a value read FROM THE RECORD being edited (the install seed's
 *    "Biographical milestone": only the milestones of the person this record
 *    names; the test TLD twin test5056: only the entries of the record's grouping).
 *    The datalist door built its request_config with NO owner record, so the
 *    walker read nothing, no filter group was emitted and every record was
 *    offered — the wrong pick a curator could make is a wrong datum.
 *  - `properties.filtered_by_search` (the PHP `elseif` branch: applied only
 *    when no fixed_filter group exists) was not read at all (test TLD twin test4441).
 *
 * OUTCOMES pinned (RED before the fix unless marked CONTROL):
 *  1. single-hop `component_data`: record OA (reference X) is offered [R1],
 *     record OB (reference Y) [R2];
 *  2. built in either order with no cache clear in between, each stays right
 *     (the record dimension is in the cache key);
 *  3. the edit READ door, the save echo and the direct build agree for OA;
 *  4. the LIST value drops the label of a stored record outside OA's list;
 *  5. the multi-hop `search_section_id` shape (Biographical milestone): owner → person →
 *     the person's linked targets, by section_id;
 *  6. a non-admin with NO grant on the filter component still gets [R1] (the
 *     server-authored filter rides the read floor), never [] and never all;
 *  7. `filtered_by_search` narrows a check_box's options;
 *  8. fixed_filter wins over filtered_by_search (PHP elseif);
 *  CONTROL: no record (search panel / state widget posture) and a record with
 *  no reference value are both unnarrowed.
 *
 * SITUATION: `zzdlr` scratch sections (→ matrix_test), built and swept here.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getNode } from '../../src/core/ontology/resolver.ts';
import {
	clearDatalistCache,
	type DatalistItem,
	type DatalistOwner,
	getDatalist as getComponentDatalist,
	getEchoDatalist,
} from '../../src/core/relations/datalist.ts';
import { readComponentData } from '../../src/core/section/read.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	ACL_NON_ADMIN_USER_ID,
	installAclIdentityFixture,
	removeAclIdentityFixture,
} from '../helpers/acl_identity_fixture.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const getDatalist = (...args: Parameters<typeof getComponentDatalist>) =>
	getComponentDatalist(...args) as Promise<DatalistItem[]>;

const TLD = 'zzdlr';
const OPTS = `${TLD}1`; // the grouping vocabulary (X, Y)
const OPTS_LABEL = `${TLD}2`;
const TARGET = `${TLD}3`; // the option section the selects enumerate
const TARGET_LABEL = `${TLD}4`;
const TARGET_GROUP = `${TLD}5`; // component_select → OPTS (the filtered axis)
const TARGET_ID = `${TLD}6`; // component_section_id
const PERSON = `${TLD}7`;
const PERSON_TARGETS = `${TLD}8`; // component_portal → TARGET
const OWNER = `${TLD}9`;
const OWNER_REFERENCE = `${TLD}10`; // component_radio_button → OPTS
const RECORD_SELECT = `${TLD}11`; // the record-dependent select (test5056 shape)
const OWNER_PERSON = `${TLD}12`; // component_portal → PERSON
const HOP_SELECT = `${TLD}13`; // the multi-hop select (Biographical milestone shape)
const SEARCH_CHECK_BOX = `${TLD}14`; // filtered_by_search (test4441 shape)
const BOTH_CHECK_BOX = `${TLD}15`; // fixed_filter AND filtered_by_search
const LANG = 'lg-eng';

const X = 1;
const Y = 2;
const R1 = 1; // grouping X, linked to P1
const R2 = 2; // grouping Y
const R3 = 3; // no grouping, linked to P1
const OA = 1; // reference X, person P1, stores the R1 + R2 picks
const OB = 2; // reference Y
const OC = 3; // no reference

const locator = (sectionTipo: string, sectionId: number, from: string, id = 1) => ({
	id,
	type: 'dd151',
	section_tipo: sectionTipo,
	section_id: sectionId,
	from_component_tipo: from,
});
const label = (value: string) => [{ id: 1, lang: 'lg-nolan', value }];
const self = { parent: 'self', section_tipo: 'self' } as const;

const targetConfig = (sqoExtra: Record<string, unknown>) => ({
	request_config: [
		{
			sqo: { section_tipo: [{ value: [TARGET], source: 'section' }], ...sqoExtra },
			show: { ddo_map: [{ tipo: TARGET_LABEL, ...self }] },
		},
	],
});
const GROUP_PATH = [
	{ section_tipo: TARGET, component_tipo: TARGET_GROUP, model: 'component_select' },
];
const RECORD_FIXED_FILTER = [
	{
		source: 'component_data',
		operator: '$and',
		value: [{ q: OWNER_REFERENCE, path: GROUP_PATH, use_from_component_tipo: false }],
	},
];
const FILTERED_BY_X = {
	$and: [
		{
			q: [{ type: 'dd151', section_tipo: OPTS, section_id: X, from_component_tipo: TARGET_GROUP }],
			path: GROUP_PATH,
		},
	],
};

const SITUATION = situation({
	tld: TLD,
	name: 'datalist_record_filter',
	nodes: [
		{ tipo: OPTS, parent: 'test1', model: 'section', term: { 'lg-eng': 'Groupings' } },
		{ tipo: OPTS_LABEL, parent: OPTS, model: 'component_input_text', term: { 'lg-eng': 'Name' } },
		{ tipo: TARGET, parent: 'test1', model: 'section', term: { 'lg-eng': 'Entries' } },
		{
			tipo: TARGET_LABEL,
			parent: TARGET,
			model: 'component_input_text',
			term: { 'lg-eng': 'Name' },
		},
		{
			tipo: TARGET_GROUP,
			parent: TARGET,
			model: 'component_select',
			term: { 'lg-eng': 'Grouping' },
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [OPTS], source: 'section' }] },
							show: { ddo_map: [{ tipo: OPTS_LABEL, ...self }] },
						},
					],
				},
			},
		},
		{ tipo: TARGET_ID, parent: TARGET, model: 'component_section_id', term: { 'lg-eng': 'Id' } },
		{ tipo: PERSON, parent: 'test1', model: 'section', term: { 'lg-eng': 'People' } },
		{
			tipo: PERSON_TARGETS,
			parent: PERSON,
			model: 'component_portal',
			term: { 'lg-eng': 'Milestones' },
			properties: { source: targetConfig({}) },
		},
		{ tipo: OWNER, parent: 'test1', model: 'section', term: { 'lg-eng': 'Owner' } },
		{
			tipo: OWNER_REFERENCE,
			parent: OWNER,
			model: 'component_radio_button',
			term: { 'lg-eng': 'Reference grouping' },
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [OPTS], source: 'section' }] },
							show: { ddo_map: [{ tipo: OPTS_LABEL, ...self }] },
						},
					],
				},
			},
		},
		{
			tipo: RECORD_SELECT,
			parent: OWNER,
			model: 'component_select',
			term: { 'lg-eng': 'Entry of the grouping' },
			properties: { source: targetConfig({ fixed_filter: RECORD_FIXED_FILTER }) },
		},
		{
			tipo: OWNER_PERSON,
			parent: OWNER,
			model: 'component_portal',
			term: { 'lg-eng': 'Person' },
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [PERSON], source: 'section' }] },
							show: { ddo_map: [{ tipo: PERSON_TARGETS, ...self }] },
						},
					],
				},
			},
		},
		{
			tipo: HOP_SELECT,
			parent: OWNER,
			model: 'component_select',
			term: { 'lg-eng': 'Milestone of the person' },
			properties: {
				source: targetConfig({
					fixed_filter: [
						{
							source: 'component_data',
							value: [
								{
									q: PERSON_TARGETS,
									path: [
										{
											section_tipo: TARGET,
											component_tipo: TARGET_ID,
											model: 'component_section_id',
										},
									],
									ddo_map: [
										{ tipo: OWNER_PERSON, parent: 'self', section_tipo: OWNER },
										{ tipo: PERSON_TARGETS, parent: OWNER_PERSON, section_tipo: PERSON },
									],
									q_operator: null,
									search_section_id: true,
								},
							],
						},
					],
				}),
			},
		},
		{
			tipo: SEARCH_CHECK_BOX,
			parent: OWNER,
			model: 'component_check_box',
			term: { 'lg-eng': 'Entries of X' },
			properties: { source: targetConfig({}), filtered_by_search: FILTERED_BY_X },
		},
		{
			tipo: BOTH_CHECK_BOX,
			parent: OWNER,
			model: 'component_check_box',
			term: { 'lg-eng': 'Both filters' },
			properties: {
				source: targetConfig({ fixed_filter: RECORD_FIXED_FILTER }),
				filtered_by_search: FILTERED_BY_X,
			},
		},
	],
	records: [
		{ section_tipo: OPTS, section_id: X, columns: { string: { [OPTS_LABEL]: label('X') } } },
		{ section_tipo: OPTS, section_id: Y, columns: { string: { [OPTS_LABEL]: label('Y') } } },
		...[
			{ id: R1, name: 'Entry one', group: X },
			{ id: R2, name: 'Entry two', group: Y },
			{ id: R3, name: 'Entry three', group: null },
		].map((entry) => ({
			section_tipo: TARGET,
			section_id: entry.id,
			columns: {
				string: { [TARGET_LABEL]: label(entry.name) },
				...(entry.group === null
					? {}
					: { relation: { [TARGET_GROUP]: [locator(OPTS, entry.group, TARGET_GROUP)] } }),
			},
		})),
		{
			section_tipo: PERSON,
			section_id: 1,
			columns: {
				relation: {
					[PERSON_TARGETS]: [
						locator(TARGET, R1, PERSON_TARGETS, 1),
						locator(TARGET, R3, PERSON_TARGETS, 2),
					],
				},
			},
		},
		{
			section_tipo: OWNER,
			section_id: OA,
			columns: {
				relation: {
					[OWNER_REFERENCE]: [locator(OPTS, X, OWNER_REFERENCE)],
					[OWNER_PERSON]: [locator(PERSON, 1, OWNER_PERSON)],
					[RECORD_SELECT]: [
						locator(TARGET, R1, RECORD_SELECT, 1),
						locator(TARGET, R2, RECORD_SELECT, 2),
					],
				},
			},
		},
		{
			section_tipo: OWNER,
			section_id: OB,
			columns: { relation: { [OWNER_REFERENCE]: [locator(OPTS, Y, OWNER_REFERENCE)] } },
		},
		{ section_tipo: OWNER, section_id: OC },
	],
});

const owner = (sectionId: number | null): DatalistOwner => ({
	section_tipo: OWNER,
	section_id: sectionId,
});
const ids = (list: readonly { section_id: number }[]) =>
	list.map((item) => item.section_id).sort((a, b) => a - b);

async function optionsOf(tipo: string, sectionId: number | null): Promise<number[]> {
	const properties = (await getNode(tipo))?.properties ?? null;
	return ids(await getDatalist(tipo, properties, owner(sectionId), LANG));
}

type Item = { tipo?: string; mode?: string; entries?: unknown; datalist?: unknown };
async function read(tipo: string, sectionId: number, mode: string): Promise<Item | undefined> {
	const items = (await readComponentData({
		action: 'read',
		source: { tipo, section_tipo: OWNER, section_id: sectionId, mode, lang: LANG },
	} as never)) as Item[];
	return items.find((item) => item.tipo === tipo);
}

beforeAll(async () => {
	await assertTestDatabase('datalist_record_filter_native');
	await installAclIdentityFixture();
	await ensureSituation(SITUATION);
	clearDatalistCache();
}, 60_000);

afterAll(async () => {
	// The save case writes an activity row about a zzdlr record: swept with the TLD.
	await sql.unsafe(
		`DELETE FROM matrix_activity
		  WHERE section_tipo = 'dd542'
		    AND misc->'dd551'->0->'value'->>'section_tipo' LIKE $1`,
		[`${TLD}%`],
	);
	expect(await dropSituation(SITUATION)).toBe(0);
	await removeAclIdentityFixture();
	clearDatalistCache();
});

describe('fixed_filter source component_data — the record narrows the list', () => {
	test('each record is offered the entries of ITS reference grouping', async () => {
		clearDatalistCache();
		expect(await optionsOf(RECORD_SELECT, OA)).toEqual([R1]);
		expect(await optionsOf(RECORD_SELECT, OB)).toEqual([R2]);
	});

	test('the reverse order, cache NOT cleared in between, is just as right', async () => {
		clearDatalistCache();
		expect(await optionsOf(RECORD_SELECT, OB)).toEqual([R2]);
		expect(await optionsOf(RECORD_SELECT, OA)).toEqual([R1]);
		expect(await optionsOf(RECORD_SELECT, OB)).toEqual([R2]);
	});

	test('CONTROL: no record, and a record with no reference value, are unnarrowed', async () => {
		clearDatalistCache();
		expect(await optionsOf(RECORD_SELECT, null)).toEqual([R1, R2, R3]);
		expect(await optionsOf(RECORD_SELECT, OC)).toEqual([R1, R2, R3]);
	});

	test('the edit read, the save echo and the build agree for the record', async () => {
		clearDatalistCache();
		const edit = await read(RECORD_SELECT, OA, 'edit');
		expect(ids(edit?.datalist as DatalistItem[])).toEqual([R1]);
		const properties = (await getNode(RECORD_SELECT))?.properties ?? null;
		const echo = await getEchoDatalist(
			'component_select',
			RECORD_SELECT,
			properties,
			owner(OA),
			[],
		);
		expect(echo).toEqual(edit?.datalist as DatalistItem[]);
	});

	test('the SAVE door echoes the list of the saved record', async () => {
		clearDatalistCache();
		const token = createSession(-1, 'root', true);
		const session = getSession(token) as Record<string, unknown> | null;
		const response = await dispatchRqo(
			{
				action: 'save',
				dd_api: 'dd_core_api',
				prevent_lock: true,
				source: {
					model: 'component_select',
					tipo: RECORD_SELECT,
					section_tipo: OWNER,
					section_id: OB,
					mode: 'edit',
					lang: LANG,
				},
				data: {
					entries: [],
					changed_data: [{ action: 'set_data', value: [locator(TARGET, R2, RECORD_SELECT)] }],
				},
			} as unknown as Rqo,
			{
				requestId: 'datalist_record_filter',
				clientIp: '127.0.0.1',
				session,
				csrfCandidate: session?.csrfToken ?? null,
				principal: await resolvePrincipal(-1),
			} as never,
		);
		expect(response.status).toBe(200);
		const items = (response.body as { data?: { data?: Item[] } }).data?.data ?? [];
		const echoed = items.find((item) => item.tipo === RECORD_SELECT);
		expect(ids(echoed?.datalist as DatalistItem[])).toEqual([R2]);
	});

	test('the list value drops the label of a stored pick outside the record list', async () => {
		clearDatalistCache();
		const list = await read(RECORD_SELECT, OA, 'list');
		expect(list?.entries).toEqual(['Entry one']);
	});

	test('multi-hop search_section_id (Biographical milestone shape): the person’s linked entries only', async () => {
		clearDatalistCache();
		expect(await optionsOf(HOP_SELECT, OA)).toEqual([R1, R3]);
	});

	test('a non-admin with no grant on the filter component still gets the narrowed list', async () => {
		clearDatalistCache();
		const reader: Principal = {
			userId: ACL_NON_ADMIN_USER_ID,
			isGlobalAdmin: false,
			isDeveloper: false,
		};
		const options = await runWithRequestContext(
			{ principal: reader, session: null, requestId: 'datalist_record_filter', clientIp: '' },
			() => optionsOf(RECORD_SELECT, OA),
		);
		expect(options).toEqual([R1]);
	});
});

describe('properties.filtered_by_search (PHP elseif branch)', () => {
	test('narrows the check_box options', async () => {
		clearDatalistCache();
		expect(await optionsOf(SEARCH_CHECK_BOX, OB)).toEqual([R1]);
	});

	test('a fixed_filter group takes precedence over filtered_by_search', async () => {
		clearDatalistCache();
		// OB references Y: the fixed_filter answers [R2]; filtered_by_search would say [R1].
		expect(await optionsOf(BOTH_CHECK_BOX, OB)).toEqual([R2]);
		// OC has no reference: the fixed_filter expands to NO group, so PHP's elseif
		// applies filtered_by_search.
		expect(await optionsOf(BOTH_CHECK_BOX, OC)).toEqual([R1]);
	});
});
