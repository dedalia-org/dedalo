/**
 * THE DATALIST DOOR CARRIES THE PRINCIPAL (T1-13 / S01 — PHP COMP-01).
 *
 * WHAT THIS GATE IS FOR. A select-family option list (`getDatalist` and the
 * doors built on it: the edit read, the save echoes, the list value, the size
 * probe) used to enumerate its target section with a raw `SELECT section_id`
 * — no projects filter, no dd478 allow-list — and cached the result under a
 * key with no ACL dimension. A non-admin was offered (and shown the labels of)
 * records outside their projects; whoever built the list first decided what
 * every other user saw. PHP built the same list through `search::get_instance`
 * (projects filter + build_filter_by_user_records) and keyed its cache by user.
 *
 * OUTCOMES pinned (each RED before the fix):
 *  1. a non-admin's list holds the in-project record, never the other one;
 *  2. a dd478 allow-list narrows the list — for a global admin too (the
 *     assembler's filter has no admin arm);
 *  3. the cache never serves one scope's list to another, in either order;
 *  4. the size probe counts what THAT principal's list holds;
 *  5. the list value (labels of the stored locators) drops the out-of-scope
 *     record's label;
 *  6. a filter_by_list field's simple context carries the CALLER's level on
 *     that field (WC-2026-11-12-datalist-principal-record-scope #4), never a
 *     hard-coded 3 — and its datalist is scoped like any other;
 * and the CONTROLS that must stay green: no principal (internal) and a global
 * admin enumerate both; two non-admins with the SAME project set share ONE
 * cached list (the key is the scope, not the user); the Users section still
 * enumerates the root record (-1) for an unscoped / admin caller while a
 * non-admin gets the users-section rule (`section_id > 0 AND …`).
 *
 * SITUATION: `zzdlp` scratch sections (→ matrix_test): TARGET carries a
 * component_filter (so the projects filter gates it), OWNER a component_select
 * over TARGET. The identities: the ACL fixture's non-admin (project 930021) and
 * scratch dd128 users minted through the write door (swept in afterAll, with
 * the 'NEW' activity rows the door logs for them).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { updateMatrixKeyData } from '../../src/core/db/matrix_write.ts';
import { getComponentFilterTipo } from '../../src/core/ontology/resolver.ts';
import {
	clearDatalistCache,
	type DatalistItem,
	type DatalistOwner,
	getDatalist as getComponentDatalist,
	getEditDatalist,
	getRelationListValue,
	probeDatalistSize,
} from '../../src/core/relations/datalist.ts';
import { expandFilterByList } from '../../src/core/relations/request_config/filters.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { clearUserFilterRecordsCache } from '../../src/core/security/filter_records.ts';
import {
	clearUserProjectsCache,
	getPermissions,
	type Principal,
} from '../../src/core/security/permissions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	ACL_ADMIN_USER_ID,
	ACL_NON_ADMIN_USER_ID,
	ACL_PROJECT_ID,
	installAclIdentityFixture,
	removeAclIdentityFixture,
} from '../helpers/acl_identity_fixture.ts';
import { countActivityRows, sweepActivityRows } from '../helpers/activity_rows.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const getDatalist = (...args: Parameters<typeof getComponentDatalist>) =>
	getComponentDatalist(...args) as Promise<DatalistItem[]>;

const TLD = 'zzdlp';
const TARGET = `${TLD}1`; // the project-gated option section
const LABEL = `${TLD}2`; // option label
const FILTER = `${TLD}3`; // component_filter — makes TARGET project-gated
const OWNER = `${TLD}4`; // section of the select
const SELECT = `${TLD}5`; // component_select over TARGET
const USERS_SELECT = `${TLD}6`; // component_select over the Users section
const LANG = 'lg-eng';
/** A project id no identity in this file holds (never resolved, only contained). */
const FOREIGN_PROJECT = 930099;
const IN_ID = 1;
const OUT_ID = 2;

const projectLocator = (projectId: number) => ({
	id: 1,
	type: 'dd151',
	section_tipo: 'dd153',
	section_id: projectId,
	from_component_tipo: FILTER,
});
const optionLocator = (sectionId: number) => ({
	id: sectionId,
	type: 'dd151',
	section_tipo: TARGET,
	section_id: sectionId,
	from_component_tipo: SELECT,
});

const SELECT_PROPERTIES = {
	source: {
		request_config: [
			{
				sqo: { section_tipo: [{ value: [TARGET], source: 'section' }] },
				show: { ddo_map: [{ tipo: LABEL, parent: 'self', section_tipo: 'self' }] },
			},
		],
	},
};
const USERS_PROPERTIES = {
	source: {
		request_config: [
			{
				sqo: { section_tipo: [{ value: ['dd128'], source: 'section' }] },
				show: { ddo_map: [{ tipo: 'dd132', parent: 'self', section_tipo: 'self' }] },
			},
		],
	},
};

const SITUATION = situation({
	tld: TLD,
	name: 'datalist_projects_scope',
	nodes: [
		{ tipo: TARGET, parent: 'test1', model: 'section', term: { 'lg-eng': 'Gated options' } },
		{ tipo: LABEL, parent: TARGET, model: 'component_input_text', term: { 'lg-eng': 'Label' } },
		{ tipo: FILTER, parent: TARGET, model: 'component_filter', term: { 'lg-eng': 'Projects' } },
		{ tipo: OWNER, parent: 'test1', model: 'section', term: { 'lg-eng': 'Owner' } },
		{
			tipo: SELECT,
			parent: OWNER,
			model: 'component_select',
			term: { 'lg-eng': 'Pick' },
			properties: SELECT_PROPERTIES,
		},
		{
			tipo: USERS_SELECT,
			parent: OWNER,
			model: 'component_select',
			term: { 'lg-eng': 'Pick a user' },
			properties: USERS_PROPERTIES,
		},
	],
	records: [
		{
			section_tipo: TARGET,
			section_id: IN_ID,
			columns: {
				string: { [LABEL]: [{ id: 1, lang: 'lg-nolan', value: 'In project' }] },
				relation: { [FILTER]: [projectLocator(ACL_PROJECT_ID)] },
			},
		},
		{
			section_tipo: TARGET,
			section_id: OUT_ID,
			columns: {
				string: { [LABEL]: [{ id: 1, lang: 'lg-nolan', value: 'Other project' }] },
				relation: { [FILTER]: [projectLocator(FOREIGN_PROJECT)] },
			},
		},
		{
			section_tipo: OWNER,
			section_id: 1,
			columns: { relation: { [SELECT]: [optionLocator(IN_ID), optionLocator(OUT_ID)] } },
		},
	],
});

const OWNER_RECORD: DatalistOwner = { section_tipo: OWNER, section_id: 1 };

/** Scratch dd128 users minted by this file (swept in afterAll). */
const scratchUsers: number[] = [];
/** A second non-admin holding exactly the ACL fixture non-admin's project set. */
let twinUserId = 0;
/** A user carrying a dd478 allow-list on TARGET naming only IN_ID (+ the project). */
let allowListUserId = 0;

const NON_ADMIN: Principal = {
	userId: ACL_NON_ADMIN_USER_ID,
	isGlobalAdmin: false,
	isDeveloper: false,
};
const ADMIN: Principal = { userId: ACL_ADMIN_USER_ID, isGlobalAdmin: true, isDeveloper: false };

function as<T>(principal: Principal | undefined, fn: () => Promise<T>): Promise<T> {
	return runWithRequestContext(
		{
			...(principal === undefined ? {} : { principal }),
			session: null,
			requestId: 'datalist_projects_scope',
			clientIp: '',
		},
		fn,
	);
}

const ids = (list: readonly { section_id: number }[]) =>
	list.map((item) => item.section_id).sort((a, b) => a - b);
const scratchIds = (list: readonly DatalistItem[]) =>
	ids(list.filter((item) => item.value.section_tipo === TARGET));

async function mintUser(write: (userId: number) => Promise<void>): Promise<number> {
	const userId = await createSectionRecord('dd128', -1);
	scratchUsers.push(userId);
	await write(userId);
	return userId;
}

const optionList = () => getDatalist(SELECT, SELECT_PROPERTIES, OWNER_RECORD, LANG);

beforeAll(async () => {
	await assertTestDatabase('datalist_projects_scope_native');
	await installAclIdentityFixture();
	await ensureSituation(SITUATION);
	twinUserId = await mintUser((userId) =>
		updateMatrixKeyData('matrix_users', 'dd128', userId, 'relation', 'dd170', [
			{ ...projectLocator(ACL_PROJECT_ID), from_component_tipo: 'dd170' },
		]),
	);
	allowListUserId = await mintUser(async (userId) => {
		await updateMatrixKeyData('matrix_users', 'dd128', userId, 'relation', 'dd170', [
			{ ...projectLocator(ACL_PROJECT_ID), from_component_tipo: 'dd170' },
		]);
		await updateMatrixKeyData('matrix_users', 'dd128', userId, 'misc', 'dd478', [
			{ id: 1, tipo: TARGET, value: [IN_ID] },
		]);
	});
	clearUserProjectsCache();
	clearUserFilterRecordsCache();
	clearDatalistCache();
}, 60_000);

afterAll(async () => {
	for (const userId of scratchUsers) await cleanScratchRecord('dd128', userId, 'matrix_users');
	// The write door logs one 'NEW' activity row per minted user: the filter
	// must find exactly those (non-vacuous), and the sweep must leave none.
	expect(await countActivityRows('dd128', scratchUsers)).toBe(scratchUsers.length);
	await sweepActivityRows('dd128', scratchUsers);
	expect(await countActivityRows('dd128', scratchUsers)).toBe(0);
	expect(await dropSituation(SITUATION)).toBe(0);
	await removeAclIdentityFixture();
	clearUserProjectsCache();
	clearUserFilterRecordsCache();
	clearDatalistCache();
});

describe('precondition — the situation is what the gate says it is', () => {
	test('TARGET is project-gated by its own component_filter', async () => {
		expect(await getComponentFilterTipo(TARGET)).toBe(FILTER);
	});
});

describe('the projects filter and the dd478 allow-list scope the option list', () => {
	test('a non-admin is offered the in-project record only', async () => {
		clearDatalistCache();
		expect(scratchIds(await as(NON_ADMIN, optionList))).toEqual([IN_ID]);
	});

	test('a dd478 allow-list narrows the list — for a non-admin and for a global admin', async () => {
		clearDatalistCache();
		const restricted: Principal = {
			userId: allowListUserId,
			isGlobalAdmin: false,
			isDeveloper: false,
		};
		expect(scratchIds(await as(restricted, optionList))).toEqual([IN_ID]);
		const restrictedAdmin: Principal = { ...restricted, isGlobalAdmin: true };
		expect(scratchIds(await as(restrictedAdmin, optionList))).toEqual([IN_ID]);
	});

	test('CONTROL: no principal (internal) and a global admin enumerate both records', async () => {
		clearDatalistCache();
		expect(scratchIds(await as(undefined, optionList))).toEqual([IN_ID, OUT_ID]);
		expect(scratchIds(await as(ADMIN, optionList))).toEqual([IN_ID, OUT_ID]);
	});
});

describe('the cache never crosses scopes', () => {
	test('admin first, then non-admin: each gets its own list', async () => {
		clearDatalistCache();
		expect(scratchIds(await as(ADMIN, optionList))).toEqual([IN_ID, OUT_ID]);
		expect(scratchIds(await as(NON_ADMIN, optionList))).toEqual([IN_ID]);
	});

	test('non-admin first, then admin: each gets its own list', async () => {
		clearDatalistCache();
		expect(scratchIds(await as(NON_ADMIN, optionList))).toEqual([IN_ID]);
		expect(scratchIds(await as(ADMIN, optionList))).toEqual([IN_ID, OUT_ID]);
	});

	test('CONTROL: two non-admins with the same project set share ONE cached list', async () => {
		clearDatalistCache();
		const twin: Principal = { userId: twinUserId, isGlobalAdmin: false, isDeveloper: false };
		const first = await as(NON_ADMIN, optionList);
		const second = await as(twin, optionList);
		expect(scratchIds(first)).toEqual([IN_ID]);
		expect(second).toBe(first);
	});
});

describe('every door on the option list is scoped', () => {
	test('the size probe counts what the principal is offered', async () => {
		clearDatalistCache();
		const probe = () => probeDatalistSize(SELECT, SELECT_PROPERTIES, OWNER_RECORD, LANG, 100_000);
		const unscoped = await as(undefined, probe);
		clearDatalistCache();
		const scoped = await as(NON_ADMIN, probe);
		expect(unscoped - scoped).toBe(1); // exactly OUT_ID leaves
		clearDatalistCache();
		expect(scoped).toBe((await as(NON_ADMIN, optionList)).length);
	});

	test('the edit door (read + both save echoes) carries the scoped list', async () => {
		clearDatalistCache();
		const edit = (await as(NON_ADMIN, () =>
			getEditDatalist(SELECT, SELECT_PROPERTIES, OWNER_RECORD, LANG, []),
		)) as DatalistItem[];
		expect(scratchIds(edit)).toEqual([IN_ID]);
	});

	test('the list value drops the label of a stored out-of-scope record', async () => {
		clearDatalistCache();
		const stored = [optionLocator(IN_ID), optionLocator(OUT_ID)];
		const labels = await as(NON_ADMIN, () =>
			getRelationListValue(SELECT, SELECT_PROPERTIES, OWNER_RECORD, LANG, stored),
		);
		expect(labels).toEqual(['In project']);
		clearDatalistCache();
		const unscoped = await as(undefined, () =>
			getRelationListValue(SELECT, SELECT_PROPERTIES, OWNER_RECORD, LANG, stored),
		);
		expect([...unscoped].sort()).toEqual(['In project', 'Other project']);
	});
});

describe('the Users section (root record -1)', () => {
	const userList = () =>
		getDatalist(USERS_SELECT, USERS_PROPERTIES, { section_tipo: OWNER, section_id: 1 }, LANG);

	test('CONTROL: an unscoped caller and a global admin still enumerate the root user', async () => {
		clearDatalistCache();
		expect((await as(undefined, userList)).some((item) => item.section_id === -1)).toBe(true);
		clearDatalistCache();
		expect((await as(ADMIN, userList)).some((item) => item.section_id === -1)).toBe(true);
	});

	test('a non-admin gets the users-section rule: no root, themselves included', async () => {
		clearDatalistCache();
		const list = await as(NON_ADMIN, userList);
		expect(list.some((item) => item.section_id === -1)).toBe(false);
		expect(list.some((item) => item.section_id === ACL_NON_ADMIN_USER_ID)).toBe(true);
	});
});

describe('filter_by_list context carries the caller level (WC #4)', () => {
	const descriptors = [{ section_tipo: OWNER, component_tipo: SELECT }];
	const expand = () => expandFilterByList(descriptors, LANG);
	const contextOf = (expanded: Awaited<ReturnType<typeof expand>>) => {
		expect(expanded).toHaveLength(1);
		return expanded[0]?.context as { permissions?: unknown; tipo?: unknown };
	};

	test('a non-admin is served THEIR level on the field, not 3', async () => {
		clearDatalistCache();
		const level = await getPermissions(NON_ADMIN, OWNER, SELECT);
		// Non-degenerate: the fixture's reader profile grants nothing on zzdlp.
		expect(level).toBeLessThan(3);
		const expanded = await as(NON_ADMIN, expand);
		const context = contextOf(expanded);
		expect(context.tipo).toBe(SELECT);
		expect(context.permissions).toBe(level);
		// …and the field's datalist is the principal-scoped one.
		expect(scratchIds(expanded[0]?.datalist as DatalistItem[])).toEqual([IN_ID]);
	});

	test('CONTROL: no principal (internal build) keeps the full level and the full list', async () => {
		clearDatalistCache();
		const expanded = await as(undefined, expand);
		expect(contextOf(expanded).permissions).toBe(3);
		expect(scratchIds(expanded[0]?.datalist as DatalistItem[])).toEqual([IN_ID, OUT_ID]);
	});
});
