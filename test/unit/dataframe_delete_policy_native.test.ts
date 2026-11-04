/**
 * DATAFRAME DELETE POLICY — the SLOT's, on every door, and NEVER a row removal
 * (WC-2026-09-06-dataframe-delete-policy-on-slot; hard value retired by
 * WC-2026-09-29-dataframe-hard-delete-retired).
 *
 * THE DEFECTS THIS GATE CLOSES, each reproduced by a test that goes red when
 * its fix is undone:
 *  - WRONG NODE. The engine read `dataframe.delete_policy` from the MAIN
 *    component; the docs and the retired-key tripline put it on the SLOT.
 *    Test "a policy on the MAIN node alone is ignored" pins the slot as the
 *    ONE home.
 *  - ONE DOOR. The dataframe modal's Delete button removes the frame through
 *    `action:'remove'` on the SLOT itself, which reached the main-item cascade
 *    with the slot as "main" and returned without touching the target. The
 *    `direct` door of every case is that button.
 *  - A TARGET ROW REMOVED (2026-09-29). The 2026-09-06 entry read the v6
 *    `hard_delete: true` as "delete the target record" and REMOVED frame
 *    targets (numisdata251 → rsc1242 on a curator's Delete). v6 had retired
 *    that key on purpose: Time Machine renders a main's past frames through
 *    the target, so the row must stay. `hard_delete` and the TS-invented
 *    `delete_target_record` are now `unlink`: every door leaves the target
 *    whole, and no door writes a whole-record `deleted` snapshot for it. The
 *    only opt-in is the soft `delete_target` (components emptied, row kept).
 *
 * ANTI-VACUITY. Every case first proves the frame target EXISTS with its
 * literal (a target that was never there makes "row gone" free), asserts the
 * SIBLING frame's target is untouched (a policy that deletes everything paired
 * to the record would pass a single-frame fixture), and the slot node is
 * asserted to resolve to `component_dataframe` (a mis-modelled slot takes a
 * different save path and the direct door would be testing nothing).
 *
 * THE COMMIT LANE IS ASSERTED, not trusted: a target wipe never shares the
 * save's transaction (deleteSectionData's media move is irreversible and must
 * be genuinely post-commit), so inside an OUTER transaction the target must
 * still carry its note after the save returns and be emptied only after COMMIT
 * — and on ROLLBACK both the unlink and the target's data come back.
 *
 * THE WHOLE-RECORD DOOR: deleting the host itself applies each slot's policy to
 * its own frames (applyOwnFramePolicies) — a `delete_target` slot does not
 * keep its frame-private data because the curator deleted the coin instead of
 * the valuation.
 *
 * THE SITUATION IS BUILT on the reserved scratch TLD `zzdfdp` — host section,
 * portal main, dataframe slot, frame-private target section with one literal,
 * portal target section — and swept whole (records, time machine, counters,
 * nodes) by dropSituation. The slot's properties are the ONE variable: each
 * case re-ensures the situation with a different slot node and drops the
 * resolver caches, so the policy under test is what the ontology says at that
 * moment, never a value threaded through the call.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { MATRIX_JSONB_COLUMNS } from '../../src/core/db/matrix.ts';
import { deleteMatrixRecord, updateMatrixKeyData } from '../../src/core/db/matrix_write.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import * as REAL_TIME_MACHINE from '../../src/core/db/time_machine.ts';
import { isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import {
	clearOntologyCaches,
	getMatrixTableFromTipo,
	getModelByTipo,
} from '../../src/core/ontology/resolver.ts';
import { dataframeDeletePolicyOf, dataframeTargetsOf } from '../../src/core/relations/dataframe.ts';
import { deletePortalLocator } from '../../src/core/relations/save.ts';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import {
	deleteSectionData,
	deleteSectionRecord,
} from '../../src/core/section/record/delete_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import {
	registerSectionDataListener,
	unregisterSectionDataListener,
} from '../../src/core/section_record/save_event.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
	getSectionPermissions,
	resolvePrincipal,
	SUPERUSER_ID,
} from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	type Situation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

/**
 * FAILURE INJECTION for the atomicity case: when set, the Time Machine write
 * for THIS component tipo throws — the second component of a delete_data
 * wipe, so the first has already been emptied when the failure lands. Every
 * other call goes to the real writer. mock.module is process-global and
 * mock.restore() does NOT revert it (see agent_stream_protocol.test.ts), so
 * afterAll re-installs the real module.
 */
let failTimeMachineFor: string | null = null;
/** Second injection: the Time Machine write for THIS frame-target record id throws. */
let failTimeMachineForRecord: number | null = null;
// SNAPSHOT the real exports BEFORE the mock: the namespace import is a LIVE
// binding that the mock rebinds, so `REAL_TIME_MACHINE.recordTimeMachine` read
// inside the replacement would be the replacement itself — an infinite loop.
const REAL_TIME_MACHINE_EXPORTS = { ...REAL_TIME_MACHINE };
const realRecordTimeMachine = REAL_TIME_MACHINE.recordTimeMachine;
mock.module('../../src/core/db/time_machine.ts', () => ({
	...REAL_TIME_MACHINE_EXPORTS,
	recordTimeMachine: (
		...args: Parameters<typeof realRecordTimeMachine>
	): ReturnType<typeof realRecordTimeMachine> => {
		if (failTimeMachineFor !== null && args[0]?.componentTipo === failTimeMachineFor) {
			throw new Error(`injected: time machine write refused for ${failTimeMachineFor}`);
		}
		if (
			failTimeMachineForRecord !== null &&
			args[0]?.sectionTipo === FRAME_SECTION &&
			args[0]?.sectionId === failTimeMachineForRecord
		) {
			throw new Error(
				`injected: time machine write refused for record ${failTimeMachineForRecord}`,
			);
		}
		return realRecordTimeMachine(...args);
	},
}));

const TLD = 'zzdfdp';
const HOST = 'zzdfdp1'; // section: the record whose main items get framed
const MAIN = 'zzdfdp2'; // component_portal: the main
const SLOT = 'zzdfdp3'; // component_dataframe: THE node under test
const FRAME_SECTION = 'zzdfdp4'; // section: frame-private targets
const FRAME_NOTE = 'zzdfdp5'; // component_input_text on the frame target
const PORTAL_TARGET = 'zzdfdp6'; // section: what the main's items point at
const FRAME_NOTE_2 = 'zzdfdp7'; // a SECOND literal on the frame target (the atomicity case)
const USER_ID = SUPERUSER_ID;
/** The one destructive opt-in: soft, row kept. */
const SOFT = { dataframe: { delete_policy: 'delete_target' } } as const;

/** The situation with the SLOT carrying `slotProperties` beside its portal source. */
function situationWithSlot(
	slotProperties: Record<string, unknown>,
	mainExtra: Record<string, unknown> = {},
): Situation {
	return situation({
		tld: TLD,
		name: 'dataframe delete policy on the slot',
		nodes: [
			{ tipo: HOST, model: 'section', parent: 'dd14' },
			{ tipo: PORTAL_TARGET, model: 'section', parent: 'dd14' },
			{ tipo: FRAME_SECTION, model: 'section', parent: 'dd14' },
			{
				tipo: FRAME_NOTE,
				model: 'component_input_text',
				parent: FRAME_SECTION,
				is_translatable: false,
				order_number: 1,
			},
			{
				tipo: FRAME_NOTE_2,
				model: 'component_input_text',
				parent: FRAME_SECTION,
				is_translatable: false,
				order_number: 2,
			},
			{
				tipo: MAIN,
				model: 'component_portal',
				parent: HOST,
				properties: {
					source: {
						request_config: [
							{
								sqo: { section_tipo: [{ value: [PORTAL_TARGET], source: 'section' }] },
								show: {
									ddo_map: [
										{ tipo: SLOT, mode: 'edit', view: 'line', parent: 'self', section_tipo: HOST },
									],
								},
							},
						],
					},
					...mainExtra,
				},
			},
			{
				tipo: SLOT,
				model: 'component_dataframe',
				parent: MAIN,
				properties: {
					source: {
						request_config: [
							{
								sqo: { section_tipo: [{ value: [FRAME_SECTION], source: 'section' }] },
								show: {
									ddo_map: [
										{
											tipo: FRAME_NOTE,
											mode: 'edit',
											view: 'line',
											parent: 'self',
											section_tipo: 'self',
										},
									],
									sqo_config: { limit: 1 },
								},
							},
						],
					},
					...slotProperties,
				},
			},
		],
	});
}

/** The situation as currently ensured — dropped whole in afterAll. */
let current: Situation = situationWithSlot({});
let HOST_TABLE = '';
let FRAME_TABLE = '';

async function ensureSlot(
	slotProperties: Record<string, unknown>,
	mainExtra: Record<string, unknown> = {},
): Promise<void> {
	current = situationWithSlot(slotProperties, mainExtra);
	await ensureSituation(current);
	clearOntologyCaches();
}

interface Seeded {
	hostId: number;
	portalTargetId: number;
	frameA: number;
	frameB: number;
}

/** A frame target record carrying one readable note. */
async function mintFrameTarget(note: string): Promise<number> {
	const id = await createSectionRecord(FRAME_SECTION, USER_ID);
	const saved = await saveComponentData({
		componentTipo: FRAME_NOTE,
		sectionTipo: FRAME_SECTION,
		sectionId: id,
		lang: 'lg-nolan',
		changedData: [{ action: 'insert', id: null, value: { value: note } }],
		userId: USER_ID,
	});
	if (saved.ok !== true) throw new Error(`frame target seed failed: ${saved.message}`);
	const saved2 = await saveComponentData({
		componentTipo: FRAME_NOTE_2,
		sectionTipo: FRAME_SECTION,
		sectionId: id,
		lang: 'lg-nolan',
		changedData: [{ action: 'insert', id: null, value: { value: `${note} (second)` } }],
		userId: USER_ID,
	});
	if (saved2.ok !== true) throw new Error(`frame target seed failed: ${saved2.message}`);
	return id;
}

/** Whether the frame target still carries its SECOND literal. */
async function hasSecondNote(id: number): Promise<boolean> {
	const rows = (await sql.unsafe(
		`SELECT string->$1 AS v FROM "${FRAME_TABLE}" WHERE section_tipo = $2 AND section_id = $3`,
		[FRAME_NOTE_2, FRAME_SECTION, id],
	)) as { v: unknown }[];
	return rows[0]?.v !== null && rows[0]?.v !== undefined;
}

/** Time Machine rows this frame target carries, any tipo. */
async function tmRowsOf(id: number): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2`,
		[FRAME_SECTION, id],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

/** A host with two main items (ids 1, 2), each framed by its own target. */
async function seed(): Promise<Seeded> {
	const portalTargetId = await createSectionRecord(PORTAL_TARGET, USER_ID);
	const hostId = await createSectionRecord(HOST, USER_ID);
	const frameA = await mintFrameTarget('frame A');
	const frameB = await mintFrameTarget('frame B');
	const mainItem = (id: number) => ({
		id,
		type: 'dd151',
		section_id: portalTargetId,
		section_tipo: PORTAL_TARGET,
		from_component_tipo: MAIN,
	});
	const frameEntry = (id: number, idKey: number, targetId: number) => ({
		id,
		type: 'dd490',
		section_id: targetId,
		section_tipo: FRAME_SECTION,
		from_component_tipo: SLOT,
		main_component_tipo: MAIN,
		id_key: idKey,
	});
	// Written through the matrix write primitive (the one JSONB serializer),
	// never a raw UPDATE with JSON.stringify.
	await updateMatrixKeyData(HOST_TABLE, HOST, hostId, 'relation', MAIN, [mainItem(1), mainItem(2)]);
	await updateMatrixKeyData(HOST_TABLE, HOST, hostId, 'relation', SLOT, [
		frameEntry(1, 1, frameA),
		frameEntry(2, 2, frameB),
	]);
	return { hostId, portalTargetId, frameA, frameB };
}

/**
 * The columns a VALUE lives in. `meta` holds the per-component item counter,
 * which delete_data KEEPS by contract (PHP leaves it), and `relation_search`
 * is a derived index — neither is the note.
 */
const VALUE_COLUMNS = MATRIX_JSONB_COLUMNS.filter(
	(column) => column !== 'meta' && column !== 'relation_search',
);

/** The frame target's state: row present? note present (in whichever value column it stores)? */
async function targetState(id: number): Promise<{ row: boolean; note: boolean }> {
	const columns = VALUE_COLUMNS.map((column) => `"${column}"`).join(', ');
	const rows = (await sql.unsafe(
		`SELECT ${columns} FROM "${FRAME_TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
		[FRAME_SECTION, id],
	)) as Record<string, unknown>[];
	const row = rows[0];
	if (row === undefined) return { row: false, note: false };
	const note = VALUE_COLUMNS.some((column) => {
		const bag = row[column];
		return (
			bag !== null &&
			typeof bag === 'object' &&
			(bag as Record<string, unknown>)[FRAME_NOTE] !== undefined
		);
	});
	return { row: true, note };
}

/** deleteSectionRecord's 'deleted' snapshot: a TM row whose tipo is the section's own. */
async function deletedSnapshots(id: number): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tipo = $1`,
		[FRAME_SECTION, id],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

async function slotEntries(hostId: number): Promise<Record<string, unknown>[]> {
	const rows = (await sql.unsafe(
		`SELECT relation->$1 AS v FROM "${HOST_TABLE}" WHERE section_tipo = $2 AND section_id = $3`,
		[SLOT, HOST, hostId],
	)) as { v: Record<string, unknown>[] | null }[];
	return rows[0]?.v ?? [];
}

type Door = 'main' | 'direct';

/** Remove main item 1's frame through one of the two doors. */
async function removeThrough(door: Door, hostId: number): Promise<void> {
	const result =
		door === 'main'
			? await saveComponentData({
					componentTipo: MAIN,
					sectionTipo: HOST,
					sectionId: hostId,
					lang: 'lg-nolan',
					changedData: [{ action: 'remove', id: 1, value: null }],
					userId: USER_ID,
				})
			: await saveComponentData({
					componentTipo: SLOT,
					sectionTipo: HOST,
					sectionId: hostId,
					lang: 'lg-nolan',
					changedData: [{ action: 'remove', id: 1, value: null }],
					userId: USER_ID,
					callerDataframe: {
						section_tipo: HOST,
						section_id: hostId,
						main_component_tipo: MAIN,
						id_key: 1,
					} as never,
				});
	if (result.ok !== true) throw new Error(`${door} remove failed: ${result.message}`);
}

type Expected = 'survives' | 'emptied';

/** Every section tipo the save event fired for — the cache-invalidation channel. */
const saveEventsFired: string[] = [];
const saveEventListener = (sectionTipo: string): void => {
	saveEventsFired.push(sectionTipo);
};
registerSectionDataListener(saveEventListener);

/** One case: seed, prove the fixture, remove through `door`, judge frame A and its sibling. */
async function runCase(door: Door, expected: Expected): Promise<void> {
	const { hostId, frameA, frameB } = await seed();
	saveEventsFired.length = 0;
	// positive control: both targets exist WITH their note before anything happens
	expect(await targetState(frameA)).toEqual({ row: true, note: true });
	expect(await targetState(frameB)).toEqual({ row: true, note: true });

	await removeThrough(door, hostId);

	// the unlink itself, on both doors: frame A's locator left, frame B's stayed
	const after = await slotEntries(hostId);
	expect(after.map((entry) => entry.id_key)).toEqual([2]);

	const a = await targetState(frameA);
	if (expected === 'survives') expect(a).toEqual({ row: true, note: true });
	if (expected === 'emptied') {
		expect(a).toEqual({ row: true, note: false });
		// an emptied record stales the same listeners a write does — fired by
		// the write chokepoint the wipe goes through, on the post-tx lane
		expect(saveEventsFired.filter((tipo) => tipo === FRAME_SECTION).length).toBeGreaterThan(0);
	}
	// under EVERY policy the target row stays: no whole-record removal snapshot
	expect(await deletedSnapshots(frameA)).toBe(0);
	// the sibling's target is never touched, whatever the policy
	expect(await targetState(frameB)).toEqual({ row: true, note: true });
}

beforeAll(async () => {
	await assertTestDatabase('dataframe_delete_policy_native');
	await ensureSlot({});
	HOST_TABLE = (await getMatrixTableFromTipo(HOST)) ?? '';
	FRAME_TABLE = (await getMatrixTableFromTipo(FRAME_SECTION)) ?? '';
	expect(HOST_TABLE).toBe('matrix_test');
	expect(FRAME_TABLE).toBe('matrix_test');
	// the slot really is a dataframe: the direct door takes the dataframe save path only then
	expect(await getModelByTipo(SLOT)).toBe('component_dataframe');
});

afterAll(async () => {
	expect(await dropSituation(current)).toBe(0);
	clearOntologyCaches();
	mock.module('../../src/core/db/time_machine.ts', () => REAL_TIME_MACHINE_EXPORTS);
	mock.restore();
	unregisterSectionDataListener(saveEventListener);
	await removeReaderIdentity();
});

describe('dataframeDeletePolicyOf — the reader', () => {
	test('ONE destructive spelling, soft; everything else — hard_delete included — is unlink', () => {
		expect(dataframeDeletePolicyOf(null)).toBe('unlink');
		expect(dataframeDeletePolicyOf({})).toBe('unlink');
		expect(dataframeDeletePolicyOf(SOFT)).toBe('delete_target');
		// the retired hard spellings: inert (WC-2026-09-29-dataframe-hard-delete-retired)
		expect(dataframeDeletePolicyOf({ hard_delete: true })).toBe('unlink');
		expect(dataframeDeletePolicyOf({ dataframe: { delete_policy: 'delete_target_record' } })).toBe(
			'unlink',
		);
		expect(dataframeDeletePolicyOf({ hard_delete: true, ...SOFT })).toBe('delete_target');
		// an unknown spelling never destroys data
		expect(dataframeDeletePolicyOf({ hard_delete: 'true' })).toBe('unlink');
		expect(dataframeDeletePolicyOf({ hard_delete: 1 })).toBe('unlink');
		expect(dataframeDeletePolicyOf({ dataframe: { delete_policy: 'delete' } })).toBe('unlink');
		expect(dataframeDeletePolicyOf({ delete_policy: 'delete_target_record' })).toBe('unlink');
	});
});

describe('dataframeTargetsOf — what a policy may reach', () => {
	test('a legacy string id converts, a non-address entry is left alone, order is kept', () => {
		const entries = [
			{ section_tipo: FRAME_SECTION, section_id: '42', id_key: 1 },
			{ section_tipo: FRAME_SECTION, section_id: 'abc', id_key: 2 }, // not an address
			{ section_tipo: FRAME_SECTION, section_id: null, id_key: 3 },
			{ section_id: 7, id_key: 4 }, // no section
			null,
			'a string',
			{ section_tipo: FRAME_SECTION, section_id: 9, id_key: 5 },
		];
		expect(dataframeTargetsOf(entries)).toEqual([
			{ section_tipo: FRAME_SECTION, section_id: 42 },
			{ section_tipo: FRAME_SECTION, section_id: 9 },
		]);
		expect(dataframeTargetsOf([])).toHaveLength(0);
	});
});

describe('the wipe runs on the COMMIT lane — after the unlink, never inside it', () => {
	test('inside an outer transaction the target keeps its data through the save and is emptied at COMMIT', async () => {
		await ensureSlot(SOFT);
		const { hostId, frameA, frameB } = await seed();
		let insideAfterSave: { row: boolean; note: boolean } | null = null;
		let slotInside: unknown[] = [];
		await withTransaction(async () => {
			await removeThrough('direct', hostId);
			// the unlink is written (uncommitted); the target is NOT touched yet
			slotInside = await slotEntries(hostId);
			insideAfterSave = await targetState(frameA);
		});
		expect((slotInside as { id_key?: unknown }[]).map((entry) => entry.id_key)).toEqual([2]);
		expect(insideAfterSave as unknown).toEqual({ row: true, note: true });
		// after COMMIT the queued wipe ran, in its own transaction; the row stays
		expect(await targetState(frameA)).toEqual({ row: true, note: false });
		expect(await deletedSnapshots(frameA)).toBe(0);
		expect(await targetState(frameB)).toEqual({ row: true, note: true });
	}, 30000);

	test('on ROLLBACK the unlink and the target both come back — the queue is discarded', async () => {
		await ensureSlot(SOFT);
		const { hostId, frameA, frameB } = await seed();
		await expect(
			withTransaction(async () => {
				await removeThrough('direct', hostId);
				throw new Error('a later statement of the same request fails');
			}),
		).rejects.toThrow('a later statement');
		expect((await slotEntries(hostId)).map((entry) => entry.id_key)).toEqual([1, 2]);
		expect(await targetState(frameA)).toEqual({ row: true, note: true });
		expect(await deletedSnapshots(frameA)).toBe(0);
		expect(await targetState(frameB)).toEqual({ row: true, note: true });
	}, 30000);
});

/**
 * A REAL non-admin principal for the authorization case (shape copied from
 * duplicate_record_dataframe_native.test.ts): the superuser clears every
 * grant and the suite's installed users hold none, so "the curator is
 * refused" is only expressible with a minted identity holding level 2 on the
 * HOST and level 1 (read-only) on the FRAME section. Ids are explicit and
 * swept in afterAll; the band is unique to this file.
 */
const READER_USER_ID = 943201;
const READER_PROFILE_ID = 943211;

async function insertIdentityRow(
	table: string,
	sectionTipo: string,
	sectionId: number,
	columns: Record<string, unknown>,
): Promise<void> {
	const names = ['"section_tipo"', '"section_id"'];
	const placeholders = ['$1', '$2'];
	const params: (string | number)[] = [sectionTipo, sectionId];
	let index = 3;
	for (const [column, value] of Object.entries(columns)) {
		names.push(`"${column}"`);
		placeholders.push(`$${index}::text::jsonb`);
		params.push(encodeForJsonb(value));
		index++;
	}
	await sql.unsafe(
		`INSERT INTO "${table}" (${names.join(', ')}) VALUES (${placeholders.join(', ')})`,
		params,
	);
}

function identityLocator(componentTipo: string, sectionTipo: string, sectionId: number) {
	return {
		id: 1,
		type: 'dd151',
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: componentTipo,
	};
}

async function removeReaderIdentity(): Promise<void> {
	await assertTestDatabase('dataframe_delete_policy_native');
	await deleteMatrixRecord('matrix_users', 'dd128', READER_USER_ID);
	await deleteMatrixRecord('matrix_profiles', 'dd234', READER_PROFILE_ID);
	clearPrincipalCache();
	clearUserProjectsCache();
	clearPermissionsCache();
}

/** Level 2 on the host, level 1 on the frame section; dd244 admin flag PRESENT but "No". */
async function installReaderIdentity(): Promise<void> {
	await assertTestDatabase('dataframe_delete_policy_native');
	await removeReaderIdentity();
	await insertIdentityRow('matrix_profiles', 'dd234', READER_PROFILE_ID, {
		string: { dd237: [{ id: 1, lang: 'lg-eng', value: 'dfdp reader profile' }] },
		misc: {
			dd774: [
				{ id: 1, tipo: HOST, section_tipo: HOST, value: 2 },
				{ id: 2, tipo: FRAME_SECTION, section_tipo: FRAME_SECTION, value: 1 },
				// the (HOST, MAIN) pair at 2: the portal-unlink write door
				// (deletePortalLocator) admits this caller, so its frame-target
				// refusal below is the cascade's grant, not the door's.
				{ id: 3, tipo: MAIN, section_tipo: HOST, value: 2 },
			],
		},
	});
	await insertIdentityRow('matrix_users', 'dd128', READER_USER_ID, {
		string: { dd132: [{ id: 1, lang: 'lg-nolan', value: 'dfdp_reader' }] },
		relation: {
			dd131: [identityLocator('dd131', 'dd64', 1)],
			dd244: [identityLocator('dd244', 'dd64', 2)],
			dd515: [identityLocator('dd515', 'dd64', 2)],
			dd1725: [identityLocator('dd1725', 'dd234', READER_PROFILE_ID)],
		},
	});
	clearPrincipalCache();
	clearUserProjectsCache();
	clearPermissionsCache();
}

describe('the WRITE GRANT on the frame target section is asked, not inherited from the host', () => {
	test('level 2 on the host, level 1 on the frame section → perm.denied, unlink rolled back, target intact', async () => {
		await ensureSlot(SOFT);
		await installReaderIdentity();
		const { hostId, frameA, frameB } = await seed();
		// the grant really is the difference: the identity resolves to a non-admin
		const principal = await resolvePrincipal(READER_USER_ID);
		expect(principal.isGlobalAdmin).toBe(false);
		expect(await getSectionPermissions(principal, HOST)).toBe(2);
		expect(await getSectionPermissions(principal, FRAME_SECTION)).toBe(1);

		let refused: unknown = null;
		try {
			await saveComponentData({
				componentTipo: SLOT,
				sectionTipo: HOST,
				sectionId: hostId,
				lang: 'lg-nolan',
				changedData: [{ action: 'remove', id: 1, value: null }],
				userId: READER_USER_ID,
				callerDataframe: {
					section_tipo: HOST,
					section_id: hostId,
					main_component_tipo: MAIN,
					id_key: 1,
				} as never,
			});
		} catch (error) {
			refused = error;
		}
		expect(isDedaloError(refused)).toBe(true);
		expect((refused as { code: string }).code).toBe('perm.denied');
		// the refusal rolled the unlink back: locator, target and sibling untouched
		expect((await slotEntries(hostId)).map((entry) => entry.id_key)).toEqual([1, 2]);
		expect(await targetState(frameA)).toEqual({ row: true, note: true });
		expect(await deletedSnapshots(frameA)).toBe(0);
		expect(await targetState(frameB)).toEqual({ row: true, note: true });
		// positive control: the same remove as root goes through
		await removeThrough('direct', hostId);
		expect(await targetState(frameA)).toEqual({ row: true, note: false });
	}, 30000);

	test('the PORTAL UNLINK door (deletePortalLocator) asks it as the CALLER: perm.denied on the frame section, unlink rolled back', async () => {
		// SEC-2 (closure 2026-09-26 Step 3): the cascade under the write door's
		// grant must run the frame-target grant as `grant.userId`. An effect that
		// audited as any other actor (the superuser above all) would wipe a
		// target this curator can only read — this leg is that hunk's only pin.
		await ensureSlot(SOFT);
		await installReaderIdentity();
		const { hostId, portalTargetId, frameA, frameB } = await seed();
		const principal = await resolvePrincipal(READER_USER_ID);
		expect(principal.isGlobalAdmin).toBe(false);
		expect(await getSectionPermissions(principal, FRAME_SECTION)).toBe(1);
		const mainBefore = await mainItems(hostId);
		expect(mainBefore.map((item) => item.id)).toEqual([1, 2]);

		let refused: unknown = null;
		try {
			await deletePortalLocator(
				principal,
				{ tipo: MAIN, section_tipo: HOST, section_id: hostId },
				{
					locator: {
						id: 1,
						section_id: portalTargetId,
						section_tipo: PORTAL_TARGET,
						from_component_tipo: MAIN,
						type: 'dd151',
					},
					ar_properties: ['id', 'section_id', 'section_tipo', 'from_component_tipo', 'type'],
				},
			);
		} catch (error) {
			refused = error;
		}
		expect(isDedaloError(refused)).toBe(true);
		expect((refused as { code: string }).code).toBe('perm.denied');
		// the refusal is the FRAME section's grant — the door itself admitted the caller
		expect(
			(refused as { coordinates?: Record<string, unknown> }).coordinates?.target_section_tipo,
		).toBe(FRAME_SECTION);
		// rolled back whole: the main's items, the slot, both targets
		expect(await mainItems(hostId)).toEqual(mainBefore);
		expect((await slotEntries(hostId)).map((entry) => entry.id_key)).toEqual([1, 2]);
		expect(await targetState(frameA)).toEqual({ row: true, note: true });
		expect(await targetState(frameB)).toEqual({ row: true, note: true });
	}, 30000);
});

async function mainItems(hostId: number): Promise<{ id: number }[]> {
	const rows = (await sql.unsafe(
		`SELECT relation->$1 AS v FROM "${HOST_TABLE}" WHERE section_tipo = $2 AND section_id = $3`,
		[MAIN, HOST, hostId],
	)) as { v: { id: number }[] | null }[];
	return rows[0]?.v ?? [];
}

describe('a target wipe that fails AFTER commit is logged, and the loop continues', () => {
	test('host delete under delete_target with frame A refused: host gone, A whole, B emptied', async () => {
		await ensureSlot(SOFT);
		const { hostId, frameA, frameB } = await seed();
		failTimeMachineForRecord = frameA;
		let outcome: { removed: boolean } | null = null;
		try {
			outcome = await deleteSectionRecord(HOST, hostId, USER_ID); // resolves: no rejection reaches the lane
		} finally {
			failTimeMachineForRecord = null;
		}
		expect(outcome?.removed).toBe(true);
		expect(await targetState(frameA)).toEqual({ row: true, note: true }); // the orphan, whole
		expect(await targetState(frameB)).toEqual({ row: true, note: false }); // the loop went on
		expect(await deletedSnapshots(frameB)).toBe(0);
	}, 30000);
});

describe('the inverse-cleanup doors — a target delete and a portal unlink reach the slot policy', () => {
	test('deleting the PORTAL TARGET record strips the host’s items and empties both frame targets', async () => {
		await ensureSlot(SOFT);
		const { hostId, portalTargetId, frameA, frameB } = await seed();
		expect((await deleteSectionRecord(PORTAL_TARGET, portalTargetId, USER_ID)).removed).toBe(true);
		expect(await slotEntries(hostId)).toEqual([]);
		expect(await targetState(frameA)).toEqual({ row: true, note: false });
		expect(await targetState(frameB)).toEqual({ row: true, note: false });
		expect(await deletedSnapshots(frameA)).toBe(0);
		expect(await deletedSnapshots(frameB)).toBe(0);
	}, 30000);

	test('deletePortalLocator on main item 1 empties frame A’s target and leaves frame B’s', async () => {
		await ensureSlot(SOFT);
		const { hostId, portalTargetId, frameA, frameB } = await seed();
		// both main items point at the same portal target: remove ONE by its id
		const response = await deletePortalLocator(
			{ isGlobalAdmin: true, userId: SUPERUSER_ID },
			{ tipo: MAIN, section_tipo: HOST, section_id: hostId },
			{
				locator: {
					id: 1,
					section_id: String(portalTargetId),
					section_tipo: PORTAL_TARGET,
					from_component_tipo: MAIN,
					type: 'dd151',
				},
				ar_properties: ['id', 'section_id', 'section_tipo', 'from_component_tipo', 'type'],
			},
		);
		expect(response.removed).toBe(1);
		expect((await slotEntries(hostId)).map((entry) => entry.id_key)).toEqual([2]);
		expect(await targetState(frameA)).toEqual({ row: true, note: false });
		expect(await deletedSnapshots(frameA)).toBe(0);
		expect(await targetState(frameB)).toEqual({ row: true, note: true });
	}, 30000);

	for (const [name, properties] of [
		['hard_delete: true', { hard_delete: true }],
		[
			'delete_policy: delete_target_record',
			{ dataframe: { delete_policy: 'delete_target_record' } },
		],
	] as const) {
		test(`${name} (retired) → deleting the PORTAL TARGET leaves both frame targets whole`, async () => {
			await ensureSlot(properties);
			const { hostId, portalTargetId, frameA, frameB } = await seed();
			expect((await deleteSectionRecord(PORTAL_TARGET, portalTargetId, USER_ID)).removed).toBe(
				true,
			);
			expect(await slotEntries(hostId)).toEqual([]);
			expect(await targetState(frameA)).toEqual({ row: true, note: true });
			expect(await targetState(frameB)).toEqual({ row: true, note: true });
			expect(await deletedSnapshots(frameA)).toBe(0);
			expect(await deletedSnapshots(frameB)).toBe(0);
		}, 30000);
	}
});

describe('the whole-record door — deleting the host applies each slot’s policy to its own frames', () => {
	for (const mode of ['record', 'data'] as const) {
		/** Delete the host through `mode`, and prove it happened (the floor). */
		const deleteHost = async (hostId: number): Promise<void> => {
			if (mode === 'record') {
				expect((await deleteSectionRecord(HOST, hostId, USER_ID)).removed).toBe(true);
			} else {
				expect((await deleteSectionData(HOST, hostId, USER_ID)).deleted).toEqual([hostId]);
				// the wipe really emptied the slot the policy reads its targets from
				expect(await slotEntries(hostId)).toEqual([]);
			}
		};

		test(`[${mode}] delete_target → both frame targets are emptied, rows kept`, async () => {
			await ensureSlot(SOFT);
			const { hostId, frameA, frameB } = await seed();
			await deleteHost(hostId);
			expect(await targetState(frameA)).toEqual({ row: true, note: false });
			expect(await targetState(frameB)).toEqual({ row: true, note: false });
			expect(await deletedSnapshots(frameA)).toBe(0);
			expect(await deletedSnapshots(frameB)).toBe(0);
		}, 30000);

		const retired: [string, Record<string, unknown>][] = [
			['hard_delete: true', { hard_delete: true }],
			[
				'delete_policy: delete_target_record',
				{ dataframe: { delete_policy: 'delete_target_record' } },
			],
		];
		for (const [name, properties] of retired) {
			test(`[${mode}] ${name} (retired) → both frame targets survive whole`, async () => {
				await ensureSlot(properties);
				const { hostId, frameA, frameB } = await seed();
				await deleteHost(hostId);
				expect(await targetState(frameA)).toEqual({ row: true, note: true });
				expect(await targetState(frameB)).toEqual({ row: true, note: true });
				expect(await deletedSnapshots(frameA)).toBe(0);
				expect(await deletedSnapshots(frameB)).toBe(0);
			}, 30000);
		}
	}

	test('no policy → deleting the host leaves both frame targets as they were', async () => {
		await ensureSlot({});
		const { hostId, frameA, frameB } = await seed();
		expect((await deleteSectionRecord(HOST, hostId, USER_ID)).removed).toBe(true);
		expect(await targetState(frameA)).toEqual({ row: true, note: true });
		expect(await targetState(frameB)).toEqual({ row: true, note: true });
	}, 30000);
});

describe('the resolved policy is SERVED to the client — context.delete_policy', () => {
	const contextOf = async (tipo: string) =>
		buildStructureContext({
			configFrom: { source: 'own', reason: 'unit-test' },
			tipo,
			sectionTipo: HOST,
			mode: 'edit',
			lang: 'lg-eng',
			permissions: 3,
		});

	const spellings: [string, Record<string, unknown>, string][] = [
		['no policy', {}, 'unlink'],
		['delete_target', SOFT, 'delete_target'],
		[
			'delete_target_record (retired)',
			{ dataframe: { delete_policy: 'delete_target_record' } },
			'unlink',
		],
		['hard_delete: true (retired)', { hard_delete: true }, 'unlink'],
	];
	for (const [name, properties, expected] of spellings) {
		test(`${name} → the slot's context entry carries delete_policy '${expected}'`, async () => {
			await ensureSlot(properties);
			const entry = await contextOf(SLOT);
			expect(entry?.model).toBe('component_dataframe');
			expect(entry?.delete_policy).toBe(expected as never);
		});
	}

	test('a non-dataframe entry (the MAIN) carries no delete_policy key at all', async () => {
		await ensureSlot(SOFT, SOFT);
		const entry = await contextOf(MAIN);
		expect(entry?.model).toBe('component_portal');
		expect('delete_policy' in (entry as object)).toBe(false);
	});
});

describe('deleteSectionData is ATOMIC — a wipe is whole or it is nothing', () => {
	test('a failure on the second component leaves the first one intact, no TM row, no save event', async () => {
		await ensureSlot({});
		const { frameA } = await seed();
		const tmBefore = await tmRowsOf(frameA);
		saveEventsFired.length = 0;
		failTimeMachineFor = FRAME_NOTE_2;
		try {
			await expect(deleteSectionData(FRAME_SECTION, frameA, USER_ID)).rejects.toThrow('injected');
		} finally {
			failTimeMachineFor = null;
		}
		// the FIRST component's wipe (TM pair + key removal) rolled back with the second's failure
		expect(await targetState(frameA)).toEqual({ row: true, note: true });
		expect(await hasSecondNote(frameA)).toBe(true);
		expect(await tmRowsOf(frameA)).toBe(tmBefore);
		// (the section-data save event is NOT asserted absent here: the write
		// chokepoint queues cache invalidation on the lane that replays on
		// rollback too — idempotent by contract — so it fires either way)
		// and the injection really bites the happy path when lifted: the same wipe now completes
		expect((await deleteSectionData(FRAME_SECTION, frameA, USER_ID)).deleted).toEqual([frameA]);
		expect(await targetState(frameA)).toEqual({ row: true, note: false });
		expect(await hasSecondNote(frameA)).toBe(false);
	}, 30000);
});

describe('a REFUSED save runs no cascade — the cascade is deferred past the batch', () => {
	test('a valid remove followed by a duplicate of itself: refused, nothing written, nothing queued', async () => {
		await ensureSlot(SOFT);
		const { hostId, frameA, frameB } = await seed();
		const result = await saveComponentData({
			componentTipo: MAIN,
			sectionTipo: HOST,
			sectionId: hostId,
			lang: 'lg-nolan',
			changedData: [
				{ action: 'remove', id: 1, value: null },
				{ action: 'remove', id: 1, value: null }, // misses: already removed in this batch
			],
			userId: USER_ID,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain('no item with id 1');
		expect((await slotEntries(hostId)).map((entry) => entry.id_key)).toEqual([1, 2]);
		expect(await targetState(frameA)).toEqual({ row: true, note: true });
		expect(await targetState(frameB)).toEqual({ row: true, note: true });
		expect(await deletedSnapshots(frameA)).toBe(0);
	}, 30000);

	test('a valid remove followed by an unknown id: nothing is written, nothing is queued', async () => {
		await ensureSlot(SOFT);
		const { hostId, frameA, frameB } = await seed();
		const result = await saveComponentData({
			componentTipo: MAIN,
			sectionTipo: HOST,
			sectionId: hostId,
			lang: 'lg-nolan',
			changedData: [
				{ action: 'remove', id: 1, value: null },
				{ action: 'remove', id: 99, value: null },
			],
			userId: USER_ID,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain('no item with id 99');
		// main items, slot entries and both targets exactly as seeded
		const rows = (await sql.unsafe(
			`SELECT relation->$1 AS v FROM "${HOST_TABLE}" WHERE section_tipo = $2 AND section_id = $3`,
			[MAIN, HOST, hostId],
		)) as { v: { id?: unknown }[] | null }[];
		expect((rows[0]?.v ?? []).map((item) => item.id)).toEqual([1, 2]);
		expect((await slotEntries(hostId)).map((entry) => entry.id_key)).toEqual([1, 2]);
		expect(await targetState(frameA)).toEqual({ row: true, note: true });
		expect(await targetState(frameB)).toEqual({ row: true, note: true });
		expect(await deletedSnapshots(frameA)).toBe(0);
	}, 30000);
});

describe('the policy is the SLOT node’s, on both doors — and never removes the row', () => {
	for (const door of ['main', 'direct'] as const) {
		test(`[${door}] no policy → the target survives`, async () => {
			await ensureSlot({});
			await runCase(door, 'survives');
		}, 30000);

		test(`[${door}] dataframe.delete_policy: delete_target → the target is emptied, row kept`, async () => {
			await ensureSlot(SOFT);
			await runCase(door, 'emptied');
		}, 30000);

		test(`[${door}] dataframe.delete_policy: delete_target_record (retired) → the target survives`, async () => {
			await ensureSlot({ dataframe: { delete_policy: 'delete_target_record' } });
			await runCase(door, 'survives');
		}, 30000);

		test(`[${door}] hard_delete: true (retired in v6) → the target survives`, async () => {
			await ensureSlot({ hard_delete: true });
			await runCase(door, 'survives');
		}, 30000);

		test(`[${door}] a policy on the MAIN node alone is ignored — the target survives`, async () => {
			await ensureSlot({}, SOFT);
			await runCase(door, 'survives');
		}, 30000);
	}
});
