/**
 * DELETE_DATA keeps a record in its curator's PROJECT (T0-5, audit OX3,
 * WC-2026-11-10-wipe-filter-user-default).
 *
 * THE DEFECT. A data wipe (deleteSectionData — the `delete_data` mode, the
 * dataframe `delete_target` soft policy) emptied every component except
 * component_filter, which it reset to a CONSTANT: DEDALO_DEFAULT_PROJECT, type
 * dd151 (the link type, not the filter type dd675), no item `id`. A
 * project-scoped non-admin who wiped a record of their own project moved it OUT
 * of their scope: they could no longer see, edit or revert it.
 *
 * THE CONTRACT PINNED (PHP section_record::delete_data →
 * component_filter::get_default_data_for_user, then set_data's item counter):
 *   - the wiped filter is the WIPER's birth default (resolveDefaultFilterData):
 *     a non-admin's first project; a global admin, or a non-admin with no
 *     project, the configured default project;
 *   - type dd675, from_component_tipo the filter, and an `id` from the
 *     component's item counter (meta count + 1 — the wipe keeps the counters);
 *   - a bulk revert recognises the wiped key by what the wipe ITSELF wrote (its
 *     own Time Machine row), not by recomputing a value that now depends on who
 *     wiped and when — so a pre-fix wipe (dd151, no id) still reverts, a write
 *     after the wipe is kept, and a wipe whose row is gone is never guessed.
 *
 * SITUATION: a `zzdfw` scratch TLD on `test1` (→ matrix_test): a FILTERED
 * section, and an unfiltered host whose `delete_target` dataframe slot frames
 * records of it. Identities: the ACL identity fixture (an admin; a non-admin
 * scoped to one project). Everything is swept; the situation drop asserts zero
 * residue. assertTestDatabase before the first write.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { dbTimestamp } from '../../src/core/db/db_timestamp.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { recordTimeMachine } from '../../src/core/db/time_machine.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionData } from '../../src/core/section/record/delete_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { principalCanAccessRecord } from '../../src/core/security/record_scope.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { toolTimeMachineBulkRevert } from '../../tools/tool_time_machine/server/bulk_revert.ts';
import {
	ACL_ADMIN_USER_ID,
	ACL_NON_ADMIN_PROFILE_ID,
	ACL_NON_ADMIN_USER_ID,
	ACL_PROJECT_ID,
	clearAclIdentityCaches,
	installAclIdentityFixture,
	removeAclIdentityFixture,
} from '../helpers/acl_identity_fixture.ts';
import { countActivityRows, sweepActivityRows } from '../helpers/activity_rows.ts';

const TLD = 'zzdfw';
const SECTION = `${TLD}1`; // FILTERED: the wiped records live here
const FILTER = `${TLD}2`;
const TEXT = `${TLD}3`;
const HOST = `${TLD}4`; // unfiltered host of the delete_target slot
const HMAIN = `${TLD}5`; // portal → HSLOT
const HSLOT = `${TLD}6`; // dataframe slot, delete_policy delete_target
const TABLE = 'matrix_test';
const ROOT = -1;
/** A project neither identity holds (scope is containment: a dangling address is enough). */
const FOREIGN_PROJECT_ID = 930098;

const SITUATION = situation({
	tld: TLD,
	name: 'delete_data_filter',
	nodes: [
		{ tipo: SECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'Filtered' } },
		{ tipo: FILTER, parent: SECTION, model: 'component_filter', term: { 'lg-eng': 'Projects' } },
		{
			tipo: TEXT,
			parent: SECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Text' },
			is_translatable: false,
		},
		{ tipo: HOST, parent: 'test1', model: 'section', term: { 'lg-eng': 'Hosts' } },
		{
			tipo: HMAIN,
			parent: HOST,
			model: 'component_portal',
			term: { 'lg-eng': 'Main' },
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] },
							show: { ddo_map: [{ tipo: HSLOT, parent: 'self', section_tipo: HOST }] },
						},
					],
				},
			},
		},
		{
			tipo: HSLOT,
			parent: HMAIN,
			model: 'component_dataframe',
			term: { 'lg-eng': 'Soft slot' },
			properties: { dataframe: { delete_policy: 'delete_target' } },
		},
	],
});

const minted: number[] = [];
let bulkTable = '';

interface RevertData {
	counter: number;
	bulk_process_id: number;
	skipped: { reason: string; section_tipo?: string; section_id?: number }[];
	inexact: { basis: string; section_tipo: string; section_id: number }[];
}

/** The filter locator a record of SECTION holds for `projectId`, as a wipe or a birth writes it. */
const filterItem = (projectId: number, id: number) => ({
	id,
	type: 'dd675',
	section_id: projectId,
	section_tipo: config.features.filterSectionTipo,
	from_component_tipo: FILTER,
});

/** The pre-fix wipe's constant (dd151, no id) — what every TS-era wipe left on real installs. */
const legacyWiped = () => [
	{
		type: 'dd151',
		section_id: config.features.defaultProject,
		section_tipo: config.features.filterSectionTipo,
		from_component_tipo: FILTER,
	},
];

/** `undefined` absent, 'NO-RECORD' gone. */
async function stored(
	section: string,
	id: number,
	column: string,
	key: string,
	table = TABLE,
): Promise<unknown> {
	const rows = (await sql.unsafe(
		`SELECT (${column} ? $3) AS present, ${column}->$3 AS v FROM "${table}"
		 WHERE section_tipo = $1 AND section_id = $2`,
		[section, id, key],
	)) as { present: boolean | null; v: unknown }[];
	if (rows.length === 0) return 'NO-RECORD';
	return rows[0]?.present === true ? rows[0]?.v : undefined;
}

async function setKey(
	section: string,
	id: number,
	column: string,
	key: string,
	value: unknown,
): Promise<void> {
	await sql.unsafe(
		`UPDATE "${TABLE}" SET ${column} = COALESCE(${column}, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
		 WHERE section_tipo = $1 AND section_id = $2`,
		[section, id, key, JSON.stringify(value)],
	);
}

/** The filter's item counter (meta), 0 when none. */
async function filterCount(id: number): Promise<number> {
	const meta = (await stored(SECTION, id, 'meta', FILTER)) as { count?: number }[] | undefined;
	return Number(meta?.[0]?.count ?? 0);
}

/** A record of SECTION born in `projectId`, holding a text value. */
async function born(projectId: number): Promise<number> {
	const id = await createSectionRecord(SECTION, ROOT, new Date(), undefined, {
		filterData: [{ type: 'dd675', section_tipo: 'dd153', section_id: projectId }],
	});
	await setKey(SECTION, id, 'string', TEXT, [{ id: 1, lang: 'lg-nolan', value: 'kept text' }]);
	// FLOOR: born in that project, with its text.
	expect(await stored(SECTION, id, 'relation', FILTER)).toEqual([filterItem(projectId, 1)]);
	return id;
}

async function mint(): Promise<number> {
	const id = await createSectionRecord('dd800', ROOT);
	minted.push(id);
	return id;
}

async function revertAsRoot(bulk: number): Promise<RevertData> {
	const response = await toolTimeMachineBulkRevert({
		principal: await resolvePrincipal(ROOT),
		userId: ROOT,
		options: { bulk_process_id: bulk },
		background: false,
	});
	expect(response.ok).toBe(true);
	const data = response.data as RevertData;
	minted.push(data.bulk_process_id);
	return data;
}

/** The visible Time Machine rows of the record's filter key, oldest first. */
async function filterHistory(id: number): Promise<{ id: number; data: unknown }[]> {
	return (await sql.unsafe(
		`SELECT id, data FROM matrix_time_machine
		 WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 AND tm_role IS NULL
		 ORDER BY id`,
		[SECTION, id, FILTER],
	)) as { id: number; data: unknown }[];
}

beforeAll(async () => {
	await assertTestDatabase('delete_data_filter_native');
	await ensureSituation(SITUATION);
	expect(await getMatrixTableFromTipo(SECTION)).toBe(TABLE);
	expect(await getMatrixTableFromTipo(HOST)).toBe(TABLE);
	bulkTable = (await getMatrixTableFromTipo('dd800')) as string;
	await installAclIdentityFixture();
	// The distinction every case rests on: the non-admin's project is not the default one.
	expect(ACL_PROJECT_ID).not.toBe(config.features.defaultProject);
	expect((await resolvePrincipal(ACL_ADMIN_USER_ID)).isGlobalAdmin).toBe(true);
	expect((await resolvePrincipal(ACL_NON_ADMIN_USER_ID)).isGlobalAdmin).toBe(false);
	// Level 2 on what the curator's delete_target save touches (the policy asks
	// for a write grant on the frame target section). Swept with the fixture's profile.
	const grants = [
		{ id: 60, tipo: HOST, section_tipo: HOST, value: 2 },
		{ id: 61, tipo: HMAIN, section_tipo: HOST, value: 2 },
		{ id: 62, tipo: HSLOT, section_tipo: HOST, value: 2 },
		{ id: 63, tipo: SECTION, section_tipo: SECTION, value: 2 },
		{ id: 64, tipo: FILTER, section_tipo: SECTION, value: 2 },
		{ id: 65, tipo: TEXT, section_tipo: SECTION, value: 2 },
	];
	await sql.unsafe(
		`UPDATE matrix_profiles SET misc = jsonb_set(misc, '{dd774}', (misc->'dd774') || $1::text::jsonb)
		 WHERE section_tipo = 'dd234' AND section_id = $2`,
		[JSON.stringify(grants), ACL_NON_ADMIN_PROFILE_ID],
	);
	clearAclIdentityCaches();
}, 60_000);

afterAll(async () => {
	await removeAclIdentityFixture();
	for (const section of [SECTION, HOST]) {
		await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1', [section]);
		await sql.unsafe('DELETE FROM dedalo_ts_record_generation WHERE section_tipo = $1', [section]);
		await sql.unsafe(`DELETE FROM "${TABLE}" WHERE section_tipo = $1`, [section]);
		await sweepActivityRows(section);
		expect(await countActivityRows(section)).toBe(0);
	}
	for (const id of minted) {
		await sql.unsafe(
			`DELETE FROM "${bulkTable}" WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
	}
	await sweepActivityRows('dd800', minted);
	expect(await countActivityRows('dd800', minted)).toBe(0);
	expect(await dropSituation(SITUATION)).toBe(0);
});

describe('delete_data resets component_filter to the WIPER’s default project (PHP get_default_data_for_user)', () => {
	test('a NON-ADMIN’s wipe keeps the record in their project — dd675, a counter id — and in their scope', async () => {
		const id = await born(ACL_PROJECT_ID);
		const count = await filterCount(id);
		await deleteSectionData(SECTION, id, ACL_NON_ADMIN_USER_ID);
		expect(await stored(SECTION, id, 'string', TEXT)).toBeUndefined(); // FLOOR: it wiped
		expect(await stored(SECTION, id, 'relation', FILTER)).toEqual([
			filterItem(ACL_PROJECT_ID, count + 1),
		]);
		expect(await filterCount(id)).toBe(count + 1);
		expect(
			await principalCanAccessRecord(SECTION, id, await resolvePrincipal(ACL_NON_ADMIN_USER_ID)),
		).toBe(true);
	});

	test('a GLOBAL ADMIN’s wipe lands in the configured default project — dd675, a counter id', async () => {
		const id = await born(ACL_PROJECT_ID);
		const count = await filterCount(id);
		await deleteSectionData(SECTION, id, ACL_ADMIN_USER_ID);
		expect(await stored(SECTION, id, 'relation', FILTER)).toEqual([
			filterItem(config.features.defaultProject, count + 1),
		]);
	});

	test('a non-admin with NO project falls back to the configured default project', async () => {
		const id = await born(ACL_PROJECT_ID);
		const count = await filterCount(id);
		const users = (await getMatrixTableFromTipo('dd128')) as string;
		const projects = await stored('dd128', ACL_NON_ADMIN_USER_ID, 'relation', 'dd170', users);
		await sql.unsafe(
			`UPDATE "${users}" SET relation = relation - 'dd170' WHERE section_tipo = 'dd128' AND section_id = $1`,
			[ACL_NON_ADMIN_USER_ID],
		);
		clearAclIdentityCaches();
		try {
			await deleteSectionData(SECTION, id, ACL_NON_ADMIN_USER_ID);
		} finally {
			await sql.unsafe(
				`UPDATE "${users}" SET relation = relation || jsonb_build_object('dd170', $2::text::jsonb)
				 WHERE section_tipo = 'dd128' AND section_id = $1`,
				[ACL_NON_ADMIN_USER_ID, JSON.stringify(projects)],
			);
			clearAclIdentityCaches();
		}
		expect(Array.isArray(projects)).toBe(true); // FLOOR: the projects really were there
		expect(await stored(SECTION, id, 'relation', FILTER)).toEqual([
			filterItem(config.features.defaultProject, count + 1),
		]);
	});

	test('the dataframe delete_target policy wipes a frame target as the curator: it stays in their project', async () => {
		const target = await born(ACL_PROJECT_ID);
		const count = await filterCount(target);
		const host = await createSectionRecord(HOST, ROOT);
		await setKey(HOST, host, 'relation', HMAIN, [
			{
				id: 1,
				type: 'dd151',
				section_tipo: SECTION,
				section_id: target,
				from_component_tipo: HMAIN,
			},
		]);
		const saved = await saveComponentData({
			componentTipo: HSLOT,
			sectionTipo: HOST,
			sectionId: host,
			lang: 'lg-nolan',
			changedData: [
				{ action: 'insert', value: { section_tipo: SECTION, section_id: String(target) } },
			] as never,
			userId: ACL_NON_ADMIN_USER_ID,
			callerDataframe: { main_component_tipo: HMAIN, id_key: 1 } as never,
		});
		expect(saved.ok).toBe(true);
		const removed = await saveComponentData({
			componentTipo: HSLOT,
			sectionTipo: HOST,
			sectionId: host,
			lang: 'lg-nolan',
			changedData: [{ action: 'remove', id: 1, value: null }] as never,
			userId: ACL_NON_ADMIN_USER_ID,
		});
		expect(removed.ok).toBe(true);
		expect(await stored(SECTION, target, 'string', TEXT)).toBeUndefined(); // FLOOR: the policy wiped it
		expect(await stored(SECTION, target, 'relation', FILTER)).toEqual([
			filterItem(ACL_PROJECT_ID, count + 1),
		]);
	});
});

describe('a bulk revert judges the wiped filter by the wipe’s OWN history row', () => {
	test('wiped by a non-admin, reverted by root: the key is recognised as wiped and put back', async () => {
		const id = await born(ACL_PROJECT_ID);
		const count = await filterCount(id);
		const run = await mint();
		await deleteSectionData(SECTION, id, ACL_NON_ADMIN_USER_ID, undefined, { bulkProcessId: run });
		// FLOOR: the WIPER's value, which root's own default (the default project) is not.
		expect(await stored(SECTION, id, 'relation', FILTER)).toEqual([
			filterItem(ACL_PROJECT_ID, count + 1),
		]);
		const data = await revertAsRoot(run);
		expect(data.skipped).toEqual([]);
		expect(await stored(SECTION, id, 'relation', FILTER)).toEqual([filterItem(ACL_PROJECT_ID, 1)]);
		expect(await stored(SECTION, id, 'string', TEXT)).toEqual([
			{ id: 1, lang: 'lg-nolan', value: 'kept text' },
		]);
	});

	test('a PRE-FIX wipe (dd151, no id, in record and history) still reverts', async () => {
		const id = await born(FOREIGN_PROJECT_ID);
		const run = await mint();
		await deleteSectionData(SECTION, id, ROOT, undefined, { bulkProcessId: run });
		// Rewrite the wipe to what the pre-fix engine left: the live key AND its own history row.
		const history = await filterHistory(id);
		const wipeRow = history.at(-1);
		expect(wipeRow).toBeDefined();
		await setKey(SECTION, id, 'relation', FILTER, legacyWiped());
		await sql.unsafe('UPDATE matrix_time_machine SET data = $2::text::jsonb WHERE id = $1', [
			wipeRow?.id,
			JSON.stringify(legacyWiped()),
		]);
		const data = await revertAsRoot(run);
		expect(data.skipped).toEqual([]);
		expect(await stored(SECTION, id, 'relation', FILTER)).toEqual([
			filterItem(FOREIGN_PROJECT_ID, 1),
		]);
		expect(await stored(SECTION, id, 'string', TEXT)).toEqual([
			{ id: 1, lang: 'lg-nolan', value: 'kept text' },
		]);
	});

	test('a filter WRITTEN after the wipe is kept: nothing is put back over it', async () => {
		const id = await born(FOREIGN_PROJECT_ID);
		const run = await mint();
		await deleteSectionData(SECTION, id, ROOT, undefined, { bulkProcessId: run });
		const curated = [filterItem(ACL_PROJECT_ID, 9)];
		await setKey(SECTION, id, 'relation', FILTER, curated);
		await revertAsRoot(run);
		expect(await stored(SECTION, id, 'relation', FILTER)).toEqual(curated);
		expect(await stored(SECTION, id, 'string', TEXT)).toBeUndefined();
	});

	test('a wipe whose history row is GONE is never guessed: the record is kept as it is', async () => {
		const id = await born(FOREIGN_PROJECT_ID);
		const run = await mint();
		await deleteSectionData(SECTION, id, ROOT, undefined, { bulkProcessId: run });
		const wiped = await stored(SECTION, id, 'relation', FILTER);
		const history = await filterHistory(id);
		expect(history.length).toBeGreaterThan(0); // FLOOR: there was a row to lose
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3',
			[SECTION, id, FILTER],
		);
		await revertAsRoot(run);
		expect(await stored(SECTION, id, 'relation', FILTER)).toEqual(wiped);
		expect(await stored(SECTION, id, 'string', TEXT)).toBeUndefined();
	});

	test('a record wiped with NO filter, then filed by a curator: the filter is a write since, the record is kept', async () => {
		// The wipe skips an empty key, so it writes NO filter row: the first filter
		// row after the twin is the curator's, and must not be read as the wipe's.
		const id = await born(FOREIGN_PROJECT_ID);
		await sql.unsafe(
			`UPDATE "${TABLE}" SET relation = relation - $3::text WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, id, FILTER],
		);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3',
			[SECTION, id, FILTER],
		);
		expect(await stored(SECTION, id, 'relation', FILTER)).toBeUndefined(); // FLOOR: no filter
		const run = await mint();
		await deleteSectionData(SECTION, id, ROOT, undefined, { bulkProcessId: run });
		expect(await stored(SECTION, id, 'string', TEXT)).toBeUndefined(); // FLOOR: it wiped
		expect(await stored(SECTION, id, 'relation', FILTER)).toBeUndefined(); // FLOOR: no filter written
		// The curator files it — a save: its own history row, then the key.
		const curated = [filterItem(ACL_PROJECT_ID, 1)];
		await recordTimeMachine(
			{
				sectionTipo: SECTION,
				sectionId: id,
				componentTipo: FILTER,
				lang: 'lg-nolan',
				userId: ACL_NON_ADMIN_USER_ID,
				data: curated,
			},
			dbTimestamp(),
		);
		await setKey(SECTION, id, 'relation', FILTER, curated);
		await revertAsRoot(run);
		expect(await stored(SECTION, id, 'relation', FILTER)).toEqual(curated);
		expect(await stored(SECTION, id, 'string', TEXT)).toBeUndefined();
	});
});
