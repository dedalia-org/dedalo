/**
 * BULK REVERT — a CASCADE TARGET is undeleted only inside the reverting
 * principal's RECORD SCOPE, whoever re-links it (cross-write:r2, review of
 * b095553e22..73ff5d88a4, S2 security-authz).
 *
 * THE DEFECT. A unit whose restore image references a deleted record undeletes
 * that record inside its own transaction (bulk_revert.ts undeleteRelinked). The
 * referencing unit's gate (unitInScope) judged only the unit's OWN record, and
 * the missing-row undelete skipped the scope check on the restored row when a
 * referencing unit linked it ("the unit's gate stands for the target"). A
 * locator in A says nothing about B's projects: a level-2 user scoped to P1
 * brought back a P2 record by reverting a revert that touched an in-scope
 * referrer.
 *
 * THE OUTCOME PINNED. The referrer (`host`, an unfiltered section — in every
 * scope) re-links a target born in a FILTERED section:
 *   - target's project is NOT the reader's → the unit is refused
 *     `out_of_scope`, the target stays deleted, the frame stays out;
 *   - target's project IS the reader's (the CONTROL — same situation, one
 *     locator different) → the target comes back with its frame.
 * The contrast is what makes the refusal mean "scope", not "anything failed".
 *
 * SCOPE IS ASKED BEFORE THE IMAGE IS (review of 123d88b48d..39f6bd7622, L2).
 * A missing row's scope is judged on the RESTORED row, and the save's value
 * gates (C58) refuse an image before any row exists — so a target whose
 * snapshot held a value the gates refuse answered `failed` (with the gate's
 * code, at the in-scope referrer) to a principal who may not see it: the reason
 * told them what an out-of-scope record's history holds. And a STANDALONE
 * target's refusal was never located, in scope or not. Pinned, both ways round
 * and on both paths (re-linked by a unit / standalone):
 *   - out of scope + unrestorable image → `out_of_scope`, reason alone — the
 *     same answer as for a restorable image;
 *   - in scope + unrestorable image → `failed` with the gate's code, located
 *     (at the unit that re-links it / at the record itself, standalone).
 * Both refusals of a whole-record image are driven: a credential that is no
 * hash (write_value_gates.ts) and a relation key that is no locator array
 * (tm_record/relation_snapshot_shape.ts).
 *
 * SITUATION: a `zzbcs` scratch TLD on `test1` (→ matrix_test): an unfiltered
 * host section with a portal + its dataframe slot, and a FILTERED section
 * (component_filter) the frames address. The non-admin is the ACL identity
 * fixture's (one project, 930021). Everything is swept; the situation drop
 * asserts zero residue. assertTestDatabase before the first write.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import * as realTimeMachine from '../../src/core/db/time_machine.ts';
import { DedaloError } from '../../src/core/errors/index.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import * as realRecordScope from '../../src/core/security/record_scope.ts';
import { principalCanAccessRecord } from '../../src/core/security/record_scope.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { toolTimeMachineBulkRevert } from '../../tools/tool_time_machine/server/bulk_revert.ts';
import { resolveDataframeSlotTipos } from '../../tools/tool_time_machine/server/dataframe_restore.ts';
import {
	ACL_NON_ADMIN_PROFILE_ID,
	ACL_NON_ADMIN_USER_ID,
	ACL_PROJECT_ID,
	clearAclIdentityCaches,
	installAclIdentityFixture,
	removeAclIdentityFixture,
} from '../helpers/acl_identity_fixture.ts';
import { countActivityRows, sweepActivityRows } from '../helpers/activity_rows.ts';

/** A spread COPY taken at import: what the one mocking case re-installs (mock_isolation rule 3). */
const REAL_RECORD_SCOPE = { ...realRecordScope };
const RECORD_SCOPE = '../../src/core/security/record_scope.ts';
/** Same law for the one case that plants a throw AFTER a verdict (the birth marker's write). */
const REAL_TIME_MACHINE = { ...realTimeMachine };
const TIME_MACHINE = '../../src/core/db/time_machine.ts';

const TLD = 'zzbcs';
const SECTION = `${TLD}1`; // unfiltered host section
const HMAIN = `${TLD}2`; // portal → HSLOT
const HSLOT = `${TLD}3`;
const FSECTION = `${TLD}4`; // FILTERED section: the cascade target lives here
const FILTER = `${TLD}5`;
const FTEXT = `${TLD}6`;
const FPASS = `${TLD}7`; // component_password: an image the value gates can refuse
const SMAIN = `${TLD}8`; // portal → SSLOT (soft cascade: delete_target WIPES the frame target, row kept)
const SSLOT = `${TLD}9`;
const TABLE = 'matrix_test';
const USER_ID = -1;
/** A project the non-admin does not hold (a dangling address is enough: scope is containment). */
const FOREIGN_PROJECT_ID = 930099;

const SITUATION = situation({
	tld: TLD,
	name: 'bulk_revert_cascade_target_scope',
	nodes: [
		{ tipo: SECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'Hosts' } },
		{
			tipo: HMAIN,
			parent: SECTION,
			model: 'component_portal',
			term: { 'lg-eng': 'Main' },
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [SECTION, FSECTION], source: 'section' }] },
							show: { ddo_map: [{ tipo: HSLOT, parent: 'self', section_tipo: SECTION }] },
						},
					],
				},
			},
		},
		{ tipo: HSLOT, parent: HMAIN, model: 'component_dataframe', term: { 'lg-eng': 'Slot' } },
		{
			tipo: SMAIN,
			parent: SECTION,
			model: 'component_portal',
			term: { 'lg-eng': 'Soft main' },
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [SECTION, FSECTION], source: 'section' }] },
							show: { ddo_map: [{ tipo: SSLOT, parent: 'self', section_tipo: SECTION }] },
						},
					],
				},
			},
		},
		{
			tipo: SSLOT,
			parent: SMAIN,
			model: 'component_dataframe',
			term: { 'lg-eng': 'Soft slot' },
			properties: { dataframe: { delete_policy: 'delete_target' } },
		},
		{ tipo: FSECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'Filtered' } },
		{ tipo: FILTER, parent: FSECTION, model: 'component_filter', term: { 'lg-eng': 'Projects' } },
		{
			tipo: FTEXT,
			parent: FSECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Text' },
			is_translatable: false,
		},
		{ tipo: FPASS, parent: FSECTION, model: 'component_password', term: { 'lg-eng': 'Secret' } },
	],
});

const minted: number[] = [];
let bulkTable = '';

interface RevertData {
	counter: number;
	bulk_process_id: number;
	skipped: {
		reason: string;
		code?: string;
		section_tipo?: string;
		tipo?: string;
		section_id?: number;
	}[];
}

async function mint(): Promise<number> {
	const id = await createSectionRecord('dd800', USER_ID);
	minted.push(id);
	return id;
}

async function revertAs(bulk: number, userId: number): Promise<RevertData> {
	const response = await toolTimeMachineBulkRevert({
		principal: await resolvePrincipal(userId),
		userId,
		options: { bulk_process_id: bulk },
		background: false,
	});
	expect(response.ok).toBe(true);
	const data = response.data as RevertData;
	minted.push(data.bulk_process_id);
	return data;
}

/** `undefined` absent, 'NO-RECORD' gone. */
async function stored(section: string, id: number, column: string, key: string): Promise<unknown> {
	const rows = (await sql.unsafe(
		`SELECT (${column} ? $3) AS present, ${column}->$3 AS v FROM "${TABLE}"
		 WHERE section_tipo = $1 AND section_id = $2`,
		[section, id, key],
	)) as { present: boolean | null; v: unknown }[];
	if (rows.length === 0) return 'NO-RECORD';
	return rows[0]?.present === true ? rows[0]?.v : undefined;
}

const frameTargets = (value: unknown): string[] =>
	(Array.isArray(value) ? (value as Record<string, unknown>[]) : [])
		.map((entry) => `${String(entry.section_tipo)}#${Number(entry.section_id)}`)
		.sort();

/**
 * A run A creates `target` in FSECTION — born in project `projectId` — and
 * frames it from `host`; the revert R of A (by root) takes the frame away and
 * D2 deletes the unreferenced born record under R's id. Reverting R is what
 * re-links (and undeletes) it.
 */
async function deletedTargetIn(
	projectId: number,
): Promise<{ host: number; target: number; revertId: number }> {
	const host = await createSectionRecord(SECTION, USER_ID);
	const t1 = await createSectionRecord(SECTION, USER_ID);
	await sql.unsafe(
		`UPDATE "${TABLE}" SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
		 WHERE section_tipo = $1 AND section_id = $2`,
		[
			SECTION,
			host,
			HMAIN,
			JSON.stringify([
				{ id: 1, type: 'dd151', section_tipo: SECTION, section_id: t1, from_component_tipo: HMAIN },
			]),
		],
	);
	const run = await mint();
	const target = await createSectionRecord(FSECTION, USER_ID, new Date(), undefined, {
		bulkProcessId: run,
		filterData: [{ type: 'dd675', section_tipo: 'dd153', section_id: projectId }],
	});
	const saved = await saveComponentData({
		componentTipo: HSLOT,
		sectionTipo: SECTION,
		sectionId: host,
		lang: 'lg-nolan',
		changedData: [
			{ action: 'insert', value: { section_tipo: FSECTION, section_id: String(target) } },
		] as never,
		userId: USER_ID,
		bulkProcessId: run,
		callerDataframe: { main_component_tipo: HMAIN, id_key: 1 } as never,
	});
	expect(saved.ok).toBe(true);
	// FLOOR: the frame really addresses the filtered target.
	expect(frameTargets(await stored(SECTION, host, 'relation', HSLOT))).toEqual([
		`${FSECTION}#${target}`,
	]);
	const first = await revertAs(run, USER_ID);
	// FLOOR: D2 deleted the target under R's id, and the frame is gone.
	expect(first.skipped).toEqual([]);
	expect(await stored(FSECTION, target, 'data', 'section_id')).toBe('NO-RECORD');
	const twins = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_time_machine
		 WHERE section_tipo = $1 AND section_id = $2 AND bulk_process_id = $3 AND tm_role = 4`,
		[FSECTION, target, first.bulk_process_id],
	)) as { n: number }[];
	// FLOOR: the role-4 twin the next revert undeletes from is really there.
	expect(Number(twins[0]?.n)).toBeGreaterThan(0);
	expect(frameTargets(await stored(SECTION, host, 'relation', HSLOT))).toEqual([]);
	return { host, target, revertId: first.bulk_process_id };
}

/**
 * A run A creates `target` in FSECTION — born in project `projectId` — and
 * NOTHING references it; the revert R of A (by root) D2-deletes it under R's
 * id. Reverting R undeletes it as a STANDALONE cascade target (no unit
 * re-links it).
 */
async function deletedStandaloneIn(
	projectId: number,
): Promise<{ target: number; revertId: number }> {
	const run = await mint();
	const target = await createSectionRecord(FSECTION, USER_ID, new Date(), undefined, {
		bulkProcessId: run,
		filterData: [{ type: 'dd675', section_tipo: 'dd153', section_id: projectId }],
	});
	const first = await revertAs(run, USER_ID);
	expect(first.skipped).toEqual([]);
	// FLOOR: D2 deleted it.
	expect(await stored(FSECTION, target, 'data', 'section_id')).toBe('NO-RECORD');
	return { target, revertId: first.bulk_process_id };
}

const PLAINTEXT = 'Conforming-Passw0rd-2017!';

/** The two refusals a whole-record image can meet, as a patch of one snapshot column. */
const UNRESTORABLE = {
	'a credential that is no hash': {
		column: 'string',
		patch: { [FPASS]: [{ id: 1, lang: 'lg-nolan', value: PLAINTEXT }] },
		code: 'tool.snapshot_credential_unrestorable',
	},
	'a relation key that is no locator array': {
		column: 'relation',
		patch: { [HMAIN]: 'not-a-locator' },
		code: 'tool.snapshot_unrestorable',
	},
} as const;
type Unrestorable = keyof typeof UNRESTORABLE;

/**
 * Make the deleted target's role-4 snapshot one the restore REFUSES — what a
 * pre-gate door left in history. Written past every gate, into the history
 * row itself (the delete took the snapshot from a clean record).
 */
async function poisonSnapshot(target: number, revertId: number, kind: Unrestorable): Promise<void> {
	const { column, patch } = UNRESTORABLE[kind];
	const rows = (await sql.unsafe(
		`UPDATE matrix_time_machine
		    SET data = jsonb_set(
		          data,
		          ARRAY[$4::text],
		          (CASE WHEN jsonb_typeof(data->$4) = 'object' THEN data->$4 ELSE '{}'::jsonb END)
		            || $5::text::jsonb
		        )
		  WHERE section_tipo = $1 AND section_id = $2 AND bulk_process_id = $3 AND tm_role = 4
		  RETURNING data->$4 AS patched`,
		[FSECTION, target, revertId, column, JSON.stringify(patch)],
	)) as { patched: Record<string, unknown> }[];
	// FLOOR: the snapshot the undelete reads really carries the refused value.
	expect(rows.length).toBeGreaterThan(0);
	for (const row of rows) expect(row.patched).toMatchObject(patch);
}

beforeAll(async () => {
	await assertTestDatabase('bulk_revert_cascade_target_scope_native');
	await ensureSituation(SITUATION);
	expect(await getMatrixTableFromTipo(SECTION)).toBe(TABLE);
	expect(await getMatrixTableFromTipo(FSECTION)).toBe(TABLE);
	expect(await resolveDataframeSlotTipos(HMAIN)).toEqual([HSLOT]);
	bulkTable = (await getMatrixTableFromTipo('dd800')) as string;
	await installAclIdentityFixture();
	// Level 2 on everything the unit and the undelete touch — the SCOPE is the
	// only thing the two cases differ in.
	const grants = [
		{ id: 50, tipo: SECTION, section_tipo: SECTION, value: 2 },
		{ id: 51, tipo: HSLOT, section_tipo: SECTION, value: 2 },
		{ id: 52, tipo: HMAIN, section_tipo: SECTION, value: 2 },
		{ id: 53, tipo: FSECTION, section_tipo: FSECTION, value: 2 },
		{ id: 54, tipo: FTEXT, section_tipo: FSECTION, value: 2 },
		{ id: 55, tipo: FILTER, section_tipo: FSECTION, value: 2 },
		{ id: 56, tipo: FPASS, section_tipo: FSECTION, value: 2 },
		{ id: 57, tipo: SMAIN, section_tipo: SECTION, value: 2 },
		{ id: 58, tipo: SSLOT, section_tipo: SECTION, value: 2 },
	];
	await sql.unsafe(
		`UPDATE matrix_profiles SET misc = jsonb_set(misc, '{dd774}', (misc->'dd774') || $1::text::jsonb)
		 WHERE section_tipo = 'dd234' AND section_id = $2`,
		[JSON.stringify(grants), ACL_NON_ADMIN_PROFILE_ID],
	);
	clearAclIdentityCaches();
}, 60_000);

// `mock.module` is process-global and `mock.restore()` does not revert it.
afterEach(() => {
	mock.module(RECORD_SCOPE, () => REAL_RECORD_SCOPE);
	mock.module(TIME_MACHINE, () => REAL_TIME_MACHINE);
});

afterAll(async () => {
	mock.module(RECORD_SCOPE, () => REAL_RECORD_SCOPE);
	mock.module(TIME_MACHINE, () => REAL_TIME_MACHINE);
	await removeAclIdentityFixture();
	for (const section of [SECTION, FSECTION]) {
		await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1', [section]);
		await sql.unsafe('DELETE FROM dedalo_ts_record_generation WHERE section_tipo = $1', [section]);
		await sql.unsafe(`DELETE FROM "${TABLE}" WHERE section_tipo = $1`, [section]);
		// The scratch section's activity rows, asserted gone.
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
	// The bulk-run (dd800) records are SHARED: only the ids this gate minted.
	await sweepActivityRows('dd800', minted);
	expect(await countActivityRows('dd800', minted)).toBe(0);
	expect(await dropSituation(SITUATION)).toBe(0);
});

describe('a cascade target re-linked by an in-scope unit is judged on its OWN scope', () => {
	test('target OUTSIDE the reader’s projects: the unit is refused out_of_scope, the target stays deleted', async () => {
		const { host, target, revertId } = await deletedTargetIn(FOREIGN_PROJECT_ID);
		const reader = await resolvePrincipal(ACL_NON_ADMIN_USER_ID);
		// FLOOR: the reader passes the referrer's gate (else nothing is tested).
		expect(reader.isGlobalAdmin).toBe(false);
		expect(await principalCanAccessRecord(SECTION, host, reader)).toBe(true);
		const data = await revertAs(revertId, ACL_NON_ADMIN_USER_ID);
		expect(await stored(FSECTION, target, 'data', 'section_id')).toBe('NO-RECORD');
		expect(frameTargets(await stored(SECTION, host, 'relation', HSLOT))).toEqual([]);
		expect(data.skipped.map((entry) => entry.reason)).toEqual(['out_of_scope']);
		expect(data.counter).toBe(0);
	}, 60_000);

	test('CONTROL — target INSIDE the reader’s projects: it comes back with its frame', async () => {
		const { host, target, revertId } = await deletedTargetIn(ACL_PROJECT_ID);
		const data = await revertAs(revertId, ACL_NON_ADMIN_USER_ID);
		expect(await stored(FSECTION, target, 'data', 'section_id')).not.toBe('NO-RECORD');
		expect(
			await principalCanAccessRecord(
				FSECTION,
				target,
				await resolvePrincipal(ACL_NON_ADMIN_USER_ID),
			),
		).toBe(true);
		expect(frameTargets(await stored(SECTION, host, 'relation', HSLOT))).toEqual([
			`${FSECTION}#${target}`,
		]);
		expect(data.skipped).toEqual([]);
	}, 60_000);
});

describe('a missing target’s SCOPE is asked before its image is: the reason never tells what an out-of-scope record’s history holds', () => {
	for (const kind of Object.keys(UNRESTORABLE) as Unrestorable[]) {
		const { code } = UNRESTORABLE[kind];

		test(`re-linked, OUTSIDE the reader’s projects, ${kind}: out_of_scope — reason alone, as for a restorable image`, async () => {
			const { host, target, revertId } = await deletedTargetIn(FOREIGN_PROJECT_ID);
			await poisonSnapshot(target, revertId, kind);
			const data = await revertAs(revertId, ACL_NON_ADMIN_USER_ID);
			expect(data.skipped).toEqual([{ reason: 'out_of_scope' }]);
			expect(JSON.stringify(data)).not.toContain(PLAINTEXT);
			expect(await stored(FSECTION, target, 'data', 'section_id')).toBe('NO-RECORD');
			expect(frameTargets(await stored(SECTION, host, 'relation', HSLOT))).toEqual([]);
		}, 60_000);

		test(`CONTROL — re-linked, INSIDE the reader’s projects, ${kind}: failed with the gate’s code, located at the unit`, async () => {
			const { host, target, revertId } = await deletedTargetIn(ACL_PROJECT_ID);
			await poisonSnapshot(target, revertId, kind);
			const data = await revertAs(revertId, ACL_NON_ADMIN_USER_ID);
			const failed = data.skipped.filter((entry) => entry.reason === 'failed');
			expect(failed).toHaveLength(1);
			expect(failed[0]).toMatchObject({ code, section_tipo: SECTION, section_id: host });
			expect(data.skipped.map((entry) => entry.reason)).not.toContain('out_of_scope');
			expect(JSON.stringify(data)).not.toContain(PLAINTEXT);
			// Rolled back whole: no half-restored target, no frame onto a missing record.
			expect(await stored(FSECTION, target, 'data', 'section_id')).toBe('NO-RECORD');
			expect(frameTargets(await stored(SECTION, host, 'relation', HSLOT))).toEqual([]);
		}, 60_000);

		test(`STANDALONE, OUTSIDE the reader’s projects, ${kind}: out_of_scope — reason alone`, async () => {
			const { target, revertId } = await deletedStandaloneIn(FOREIGN_PROJECT_ID);
			await poisonSnapshot(target, revertId, kind);
			const data = await revertAs(revertId, ACL_NON_ADMIN_USER_ID);
			expect(data.skipped).toEqual([{ reason: 'out_of_scope' }]);
			expect(await stored(FSECTION, target, 'data', 'section_id')).toBe('NO-RECORD');
		}, 60_000);

		test(`STANDALONE, INSIDE the reader’s projects, ${kind}: failed with the gate’s code, located at the record`, async () => {
			const { target, revertId } = await deletedStandaloneIn(ACL_PROJECT_ID);
			await poisonSnapshot(target, revertId, kind);
			const data = await revertAs(revertId, ACL_NON_ADMIN_USER_ID);
			expect(data.skipped).toHaveLength(1);
			expect(data.skipped[0]).toMatchObject({
				reason: 'failed',
				code,
				section_tipo: FSECTION,
				section_id: target,
			});
			expect(JSON.stringify(data)).not.toContain(PLAINTEXT);
			// Nothing of the refused image was kept.
			expect(await stored(FSECTION, target, 'data', 'section_id')).toBe('NO-RECORD');
		}, 60_000);
	}

	// The record's coordinates AND the error's code ride a `failed` entry only
	// when its scope verdict had PASSED by the time it threw (owner ruling
	// 2026-11-18, TM Q3). Here the verdict itself throws for the restored row:
	// nothing was judged, so the entry is the reason ALONE — typed (the record
	// door's typed-refusal outcome) or untyped (the cascade group's own catch).
	const PLANTED = {
		typed: () => new DedaloError('internal.invariant', { message: 'planted in the scope verdict' }),
		untyped: () => new TypeError('planted in the scope verdict'),
	};
	for (const kind of Object.keys(PLANTED) as (keyof typeof PLANTED)[]) {
		test(`a ${kind} throw from INSIDE the scope verdict: \`failed\` and nothing else — no coordinates, NO CODE (both ride only once the verdict PASSED)`, async () => {
			const { target, revertId } = await deletedStandaloneIn(ACL_PROJECT_ID);
			let thrown = 0;
			mock.module(RECORD_SCOPE, () => ({
				...REAL_RECORD_SCOPE,
				principalCanAccessRecord: async (sectionTipo: string, sectionId: number, who: never) => {
					if (sectionTipo === FSECTION && sectionId === target) {
						thrown += 1;
						throw PLANTED[kind]();
					}
					return REAL_RECORD_SCOPE.principalCanAccessRecord(sectionTipo, sectionId, who);
				},
			}));
			const quiet = console.error;
			console.error = () => {};
			try {
				const data = await revertAs(revertId, ACL_NON_ADMIN_USER_ID);
				// EXACT: the reason alone. A code here would tell a principal no verdict
				// has cleared for this record why its revert stopped.
				expect(data.skipped).toEqual([{ reason: 'failed' }]);
				// The planted throw is what failed it (not a refusal further up).
				expect(thrown).toBeGreaterThanOrEqual(1);
			} finally {
				console.error = quiet;
			}
			expect(await stored(FSECTION, target, 'data', 'section_id')).toBe('NO-RECORD');
		}, 60_000);
	}

	test('RE-LINKED: a throw from INSIDE the target’s scope verdict fails the in-scope unit at ITS coordinates with NO CODE — the unit’s verdict passed, the target’s had not', async () => {
		// The unit's own record (the host) passed its gate, so the entry is located
		// there; but the error comes from inside the verdict over the cascade
		// TARGET, which has not passed — its code is not the caller's to learn
		// (owner ruling 2026-11-18, TM Q3). The CONTROL above (a value gate
		// refusing AFTER the target's verdict passed) keeps its code.
		const { host, target, revertId } = await deletedTargetIn(ACL_PROJECT_ID);
		let thrown = 0;
		mock.module(RECORD_SCOPE, () => ({
			...REAL_RECORD_SCOPE,
			principalCanAccessRecord: async (sectionTipo: string, sectionId: number, who: never) => {
				if (sectionTipo === FSECTION && sectionId === target) {
					thrown += 1;
					throw new DedaloError('internal.invariant', { message: 'planted in the scope verdict' });
				}
				return REAL_RECORD_SCOPE.principalCanAccessRecord(sectionTipo, sectionId, who);
			},
		}));
		const quiet = console.error;
		console.error = () => {};
		try {
			const data = await revertAs(revertId, ACL_NON_ADMIN_USER_ID);
			expect(thrown).toBeGreaterThanOrEqual(1);
			// EXACT: the unit, located and codeless; the target it could not bring
			// back, the reason alone.
			expect(data.skipped).toEqual([
				{ reason: 'failed', section_tipo: SECTION, tipo: HMAIN, section_id: host },
				{ reason: 'cascade_delete_not_reverted' },
			]);
			expect(JSON.stringify(data)).not.toContain('internal.');
		} finally {
			console.error = quiet;
		}
		expect(await stored(FSECTION, target, 'data', 'section_id')).toBe('NO-RECORD');
		expect(frameTargets(await stored(SECTION, host, 'relation', HSLOT))).toEqual([]);
	}, 60_000);

	// ---- review of d2bf02a187: the DEFERRED unit and the LIVE-ROW (wiped) branch.

	test('DEFERRED unit (its OWN record is one it undeletes first): a re-linked target is judged, then its restore throws untyped → `failed` and nothing else — the unit’s own verdict had not passed', async () => {
		// Run A bears BOTH the target and the host that frames it; the revert R of
		// A deletes both (D2). Reverting R, the host's unit is DEFERRED: its own
		// record's verdict waits for the prelude (the restored row). The prelude
		// undeletes the TARGET first (the newer marker): its verdict passes, then
		// the birth marker's write throws. The target's verdict passed — the
		// unit's OWN had not: no coordinates, no code (owner ruling 2026-11-18, Q3).
		const t1 = await createSectionRecord(SECTION, USER_ID);
		const run = await mint();
		const host = await createSectionRecord(SECTION, USER_ID, new Date(), undefined, {
			bulkProcessId: run,
		});
		const target = await createSectionRecord(FSECTION, USER_ID, new Date(), undefined, {
			bulkProcessId: run,
			filterData: [{ type: 'dd675', section_tipo: 'dd153', section_id: ACL_PROJECT_ID }],
		});
		const linked = await saveComponentData({
			componentTipo: HMAIN,
			sectionTipo: SECTION,
			sectionId: host,
			lang: 'lg-nolan',
			changedData: [
				{ action: 'insert', value: { section_tipo: SECTION, section_id: String(t1) } },
			] as never,
			userId: USER_ID,
			bulkProcessId: run,
		});
		expect(linked.ok).toBe(true);
		const itemId = Number(
			((await stored(SECTION, host, 'relation', HMAIN)) as { id: number }[])[0]?.id,
		);
		const framed = await saveComponentData({
			componentTipo: HSLOT,
			sectionTipo: SECTION,
			sectionId: host,
			lang: 'lg-nolan',
			changedData: [
				{ action: 'insert', value: { section_tipo: FSECTION, section_id: String(target) } },
			] as never,
			userId: USER_ID,
			bulkProcessId: run,
			callerDataframe: { main_component_tipo: HMAIN, id_key: itemId } as never,
		});
		expect(framed.ok).toBe(true);
		const first = await revertAs(run, USER_ID);
		// FLOOR: both born records are gone, each with a role-4 twin under R, and
		// the TARGET's is the newer one (the prelude takes it first).
		expect(first.skipped).toEqual([]);
		expect(await stored(SECTION, host, 'data', 'section_id')).toBe('NO-RECORD');
		expect(await stored(FSECTION, target, 'data', 'section_id')).toBe('NO-RECORD');
		const twins = (await sql.unsafe(
			`SELECT section_tipo, max(id)::int AS id FROM matrix_time_machine
			 WHERE bulk_process_id = $1 AND tm_role = 4
			   AND ((section_tipo = $2 AND section_id = $3) OR (section_tipo = $4 AND section_id = $5))
			 GROUP BY section_tipo`,
			[first.bulk_process_id, SECTION, host, FSECTION, target],
		)) as { section_tipo: string; id: number }[];
		const twinOf = (section: string) =>
			Number(twins.find((row) => row.section_tipo === section)?.id);
		expect(twinOf(FSECTION)).toBeGreaterThan(twinOf(SECTION));

		const scopeAsked: string[] = [];
		let thrown = 0;
		mock.module(RECORD_SCOPE, () => ({
			...REAL_RECORD_SCOPE,
			principalCanAccessRecord: async (sectionTipo: string, sectionId: number, who: never) => {
				const answer = await REAL_RECORD_SCOPE.principalCanAccessRecord(
					sectionTipo,
					sectionId,
					who,
				);
				scopeAsked.push(`${sectionTipo}#${sectionId}:${answer}`);
				return answer;
			},
		}));
		mock.module(TIME_MACHINE, () => ({
			...REAL_TIME_MACHINE,
			recordBulkBirth: async (entry: { sectionTipo: string; sectionId: number }) => {
				if (entry.sectionTipo === FSECTION && entry.sectionId === target) {
					thrown += 1;
					throw new TypeError('planted after the target’s scope verdict');
				}
				return REAL_TIME_MACHINE.recordBulkBirth(entry as never);
			},
		}));
		const quiet = console.error;
		console.error = () => {};
		try {
			const data = await revertAs(first.bulk_process_id, ACL_NON_ADMIN_USER_ID);
			// The planted throw is what failed it — AFTER the target's verdict passed,
			// and before the host's own was ever asked.
			expect(thrown).toBe(1);
			expect(scopeAsked).toEqual([`${FSECTION}#${target}:true`]);
			// EXACT: the unit `failed`, the reason alone (no coordinates, NO CODE);
			// the two records it could not bring back, the reason alone.
			expect(data.skipped).toEqual([
				{ reason: 'failed' },
				{ reason: 'cascade_delete_not_reverted' },
				{ reason: 'cascade_delete_not_reverted' },
			]);
			expect(JSON.stringify(data)).not.toContain('internal.');
		} finally {
			console.error = quiet;
		}
		expect(await stored(SECTION, host, 'data', 'section_id')).toBe('NO-RECORD');
		expect(await stored(FSECTION, target, 'data', 'section_id')).toBe('NO-RECORD');
	}, 60_000);

	/** A FILTERED record (the reader's project) with a text — what a soft cascade wipes. */
	async function filteredWithText(): Promise<number> {
		const id = await createSectionRecord(FSECTION, USER_ID, new Date(), undefined, {
			filterData: [{ type: 'dd675', section_tipo: 'dd153', section_id: ACL_PROJECT_ID }],
		});
		const saved = await saveComponentData({
			componentTipo: FTEXT,
			sectionTipo: FSECTION,
			sectionId: id,
			lang: 'lg-nolan',
			changedData: [
				{ action: 'set_data', value: [{ id: 1, lang: 'lg-nolan', value: 'soon wiped' }] },
			] as never,
			userId: USER_ID,
		});
		expect(saved.ok).toBe(true);
		return id;
	}

	/** `host` gets a SMAIN item and a SOFT (delete_target) frame onto `role`, past history. */
	async function softFrame(host: number, role: number): Promise<void> {
		const t1 = await createSectionRecord(SECTION, USER_ID);
		await sql.unsafe(
			`UPDATE "${TABLE}" SET relation = COALESCE(relation, '{}'::jsonb) || $3::text::jsonb
			 WHERE section_tipo = $1 AND section_id = $2`,
			[
				SECTION,
				host,
				JSON.stringify({
					[SMAIN]: [
						{
							id: 1,
							type: 'dd151',
							section_tipo: SECTION,
							section_id: t1,
							from_component_tipo: SMAIN,
						},
					],
					[SSLOT]: [
						{
							id: 1,
							type: 'dd490',
							id_key: 1,
							section_tipo: FSECTION,
							section_id: role,
							from_component_tipo: SSLOT,
							main_component_tipo: SMAIN,
						},
					],
				}),
			],
		);
	}

	/** The scope verdict over (FSECTION, id) throws a typed error; every other record is judged for real. */
	function plantScopeThrow(id: number): { thrown: () => number } {
		let thrown = 0;
		mock.module(RECORD_SCOPE, () => ({
			...REAL_RECORD_SCOPE,
			principalCanAccessRecord: async (sectionTipo: string, sectionId: number, who: never) => {
				if (sectionTipo === FSECTION && sectionId === id) {
					thrown += 1;
					throw new DedaloError('internal.invariant', { message: 'planted in the scope verdict' });
				}
				return REAL_RECORD_SCOPE.principalCanAccessRecord(sectionTipo, sectionId, who);
			},
		}));
		return { thrown: () => thrown };
	}

	test('LIVE ROW, RE-LINKED: a throw from inside a WIPED target’s scope verdict fails the in-scope unit at ITS coordinates with NO CODE', async () => {
		// The soft cascade keeps the row, so the target's scope is judged on the
		// LIVE row before any restore (mayUndelete) — the other branch of the
		// record door. Same law: the verdict had not passed, the code stays home.
		const host = await createSectionRecord(SECTION, USER_ID);
		const role = await filteredWithText();
		await softFrame(host, role);
		const run = await mint();
		const removed = await saveComponentData({
			componentTipo: SSLOT,
			sectionTipo: SECTION,
			sectionId: host,
			lang: 'lg-nolan',
			changedData: [{ action: 'remove', id: 1, value: null }] as never,
			userId: USER_ID,
			bulkProcessId: run,
		});
		expect(removed.ok).toBe(true);
		// FLOOR: WIPED, row kept.
		expect(await stored(FSECTION, role, 'data', 'section_id')).not.toBe('NO-RECORD');
		expect(await stored(FSECTION, role, 'string', FTEXT)).toBeUndefined();
		const planted = plantScopeThrow(role);
		const quiet = console.error;
		console.error = () => {};
		try {
			const data = await revertAs(run, ACL_NON_ADMIN_USER_ID);
			expect(planted.thrown()).toBeGreaterThanOrEqual(1);
			expect(data.skipped).toEqual([
				{ reason: 'failed', section_tipo: SECTION, tipo: SMAIN, section_id: host },
				{ reason: 'cascade_delete_not_reverted' },
			]);
			expect(JSON.stringify(data)).not.toContain('internal.');
		} finally {
			console.error = quiet;
		}
		// Nothing came back: the wipe stands, the frame stays out.
		expect(await stored(FSECTION, role, 'string', FTEXT)).toBeUndefined();
		expect(frameTargets(await stored(SECTION, host, 'relation', SSLOT))).toEqual([]);
	}, 60_000);

	test('LIVE ROW, STANDALONE: a throw from inside a WIPED group member’s scope verdict → `failed` and nothing else (no coordinates, NO CODE)', async () => {
		// born --soft frame--> child. Deleting `born` under a bulk id wipes child
		// (row kept) under the same id; no unit re-links either, so reverting that
		// id undeletes them as ONE standalone group. The child's row is LIVE: its
		// verdict is mayUndelete's, and it throws.
		const child = await filteredWithText();
		const born = await createSectionRecord(SECTION, USER_ID);
		await softFrame(born, child);
		const revertId = await mint();
		await deleteSectionRecord(SECTION, born, USER_ID, undefined, { bulkProcessId: revertId });
		// FLOOR: born gone, child WIPED (row kept), its role-4 twin under the id.
		expect(await stored(SECTION, born, 'data', 'section_id')).toBe('NO-RECORD');
		expect(await stored(FSECTION, child, 'data', 'section_id')).not.toBe('NO-RECORD');
		expect(await stored(FSECTION, child, 'string', FTEXT)).toBeUndefined();
		const twins = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM matrix_time_machine
			 WHERE section_tipo = $1 AND section_id = $2 AND bulk_process_id = $3 AND tm_role = 4`,
			[FSECTION, child, revertId],
		)) as { n: number }[];
		expect(Number(twins[0]?.n)).toBeGreaterThan(0);
		const planted = plantScopeThrow(child);
		const quiet = console.error;
		console.error = () => {};
		try {
			const data = await revertAs(revertId, ACL_NON_ADMIN_USER_ID);
			expect(planted.thrown()).toBeGreaterThanOrEqual(1);
			// EXACT: the member whose verdict threw, the reason alone; the parent
			// that rolled back with it, the reason alone.
			expect(data.skipped).toEqual([
				{ reason: 'failed' },
				{ reason: 'cascade_delete_not_reverted' },
			]);
			expect(JSON.stringify(data)).not.toContain('internal.');
		} finally {
			console.error = quiet;
		}
		expect(await stored(SECTION, born, 'data', 'section_id')).toBe('NO-RECORD');
		expect(await stored(FSECTION, child, 'string', FTEXT)).toBeUndefined();
	}, 60_000);

	test('CONTROL — a STANDALONE target with a restorable image: outside → out_of_scope, inside → it comes back', async () => {
		const foreign = await deletedStandaloneIn(FOREIGN_PROJECT_ID);
		const refused = await revertAs(foreign.revertId, ACL_NON_ADMIN_USER_ID);
		expect(refused.skipped).toEqual([{ reason: 'out_of_scope' }]);
		expect(await stored(FSECTION, foreign.target, 'data', 'section_id')).toBe('NO-RECORD');

		const own = await deletedStandaloneIn(ACL_PROJECT_ID);
		const done = await revertAs(own.revertId, ACL_NON_ADMIN_USER_ID);
		expect(done.skipped).toEqual([]);
		expect(await stored(FSECTION, own.target, 'data', 'section_id')).not.toBe('NO-RECORD');
	}, 60_000);
});
