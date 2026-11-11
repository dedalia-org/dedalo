/**
 * THE TM-NOTE FIXTURE (T0-4 part B — `create_tm_note`, the ONE door that creates
 * a Time Machine note bound to its TM row). Mints the identities the gate
 * `test/unit/tm_note_create_native.test.ts` contrasts, nothing else.
 *
 * WHY test6100 AND NOT test3. A TM note is admitted on TM ACCESS to the
 * annotated section (`canAccessTimeMachineList`, SECTION_SPEC §7.4): the grant
 * on the section's `time_machine_list` node. test3 declares none (fail-closed:
 * no non-admin can ever hold TM access there), so the annotated section is the
 * generic playground's test6100, whose `time_machine_list` is test6394 — the
 * gate asserts that through the real resolver before it relies on it.
 *
 * WHAT IT MINTS (band 947200-947299; users/profiles/projects are ordinary
 * dd128/dd234/dd153 records, no ontology node is written):
 *
 *   947221 dd153  project P — every identity but OTHER (record birth defaults)
 *   947222 dd153  project Q — OTHER only: a note is born in its creator's P; the
 *                 TM-path read must not hang on that (T0-4 part C — it does not:
 *                 matrix_notes is a PROJECTS_FILTER_EXEMPT table, pinned by the gate)
 *
 *   user/profile   identity   dd244  project  grants (dd774)
 *   947201/947211  AUTHOR     No     P        test6100=2, test6394 (time_machine_list)=1 — TM access, no notes-section grant
 *   947202/947212  OTHER      No     Q        = AUTHOR (TM access; never the author of the rows the gate mints)
 *   947203/947213  NO_TM      No     P        test6100=2, test6394 at an EXPLICIT 0 — authors a row, cannot see its TM
 *   947204/947214  AUDITOR    No     P        notes section=2, its text=2, its Code=2 (a PROFILE grant on the notes
 *                                             section: the AUDIT path) — no test6100 grant, no TM access
 *   947205/947215  ADMIN      YES    P        test6100=2 — a global admin (TM access everywhere), NO notes grant
 *
 * The TM ROWS are engine-built: a scratch test6100 record (createSectionRecord as
 * root) and `saveComponentData` on its input_text AS the authoring identity — the
 * row's `user_id` is that identity. Every record and TM row is swept, loudly.
 */

import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { readTimeMachineHistory } from '../../src/core/db/time_machine.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { clearUserFilterRecordsCache } from '../../src/core/security/filter_records.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearTmNoteFactsCache,
	clearUserProjectsCache,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	TM_NOTES_CODE_TIPO,
	TM_NOTES_SECTION_TIPO,
	TM_NOTES_TEXT,
} from '../../src/core/tm_record/tm_record.ts';

/** The annotated section (declares a time_machine_list — see the header). */
export const TM_NOTE_SECTION = 'test6100';
/** test6100's time_machine_list node (the §7.4 grant). */
export const TM_NOTE_TM_LIST = 'test6394';
/** test6100's component_input_text — the value saved to mint a TM row. */
export const TM_NOTE_TEXT = 'test6216';

export const TM_NOTE_PROJECT = 947221;
/** OTHER's project (Q) — see the header. */
export const TM_NOTE_FOREIGN_PROJECT = 947222;
export const TM_NOTE_AUTHOR_USER_ID = 947201;
export const TM_NOTE_OTHER_USER_ID = 947202;
export const TM_NOTE_NO_TM_USER_ID = 947203;
export const TM_NOTE_AUDITOR_USER_ID = 947204;
export const TM_NOTE_ADMIN_USER_ID = 947205;

const USERS_SECTION = 'dd128';
const PROFILES_SECTION = 'dd234';
const PROJECTS_SECTION = 'dd153';
const YES_NO_SECTION = 'dd64';
const YES = 1;
const NO = 2;
const BAND_LOW = 947200;
const BAND_HIGH = 947299;

interface IdentitySpec {
	userId: number;
	name: string;
	grants: [string, string, number][];
	/** dd244 (global admin) — absent = No. */
	admin?: boolean;
	/** dd170 project — absent = P ({@link TM_NOTE_PROJECT}). */
	project?: number;
}

const TM_ACCESS_GRANTS: [string, string, number][] = [
	[TM_NOTE_SECTION, TM_NOTE_SECTION, 2],
	[TM_NOTE_SECTION, TM_NOTE_TM_LIST, 1],
];

const IDENTITIES: readonly IdentitySpec[] = [
	{ userId: TM_NOTE_AUTHOR_USER_ID, name: 'zztmnote_author', grants: TM_ACCESS_GRANTS },
	{
		userId: TM_NOTE_OTHER_USER_ID,
		name: 'zztmnote_other',
		grants: TM_ACCESS_GRANTS,
		project: TM_NOTE_FOREIGN_PROJECT,
	},
	{
		userId: TM_NOTE_NO_TM_USER_ID,
		name: 'zztmnote_no_tm',
		grants: [
			[TM_NOTE_SECTION, TM_NOTE_SECTION, 2],
			[TM_NOTE_SECTION, TM_NOTE_TM_LIST, 0],
		],
	},
	{
		userId: TM_NOTE_AUDITOR_USER_ID,
		name: 'zztmnote_auditor',
		grants: [
			[TM_NOTES_SECTION_TIPO, TM_NOTES_SECTION_TIPO, 2],
			[TM_NOTES_SECTION_TIPO, TM_NOTES_TEXT, 2],
			[TM_NOTES_SECTION_TIPO, TM_NOTES_CODE_TIPO, 2],
		],
	},
	{
		userId: TM_NOTE_ADMIN_USER_ID,
		name: 'zztmnote_admin',
		grants: [[TM_NOTE_SECTION, TM_NOTE_SECTION, 2]],
		admin: true,
	},
];

const profileOf = (userId: number): number => userId + 10;

const OWNED: { table: string; sectionTipo: string; sectionId: number }[] = [
	{ table: 'matrix_projects', sectionTipo: PROJECTS_SECTION, sectionId: TM_NOTE_PROJECT },
	{ table: 'matrix_projects', sectionTipo: PROJECTS_SECTION, sectionId: TM_NOTE_FOREIGN_PROJECT },
	...IDENTITIES.flatMap((identity) => [
		{ table: 'matrix_users', sectionTipo: USERS_SECTION, sectionId: identity.userId },
		{
			table: 'matrix_profiles',
			sectionTipo: PROFILES_SECTION,
			sectionId: profileOf(identity.userId),
		},
	]),
];

function locator(componentTipo: string, sectionTipo: string, sectionId: number, type = 'dd151') {
	return {
		id: 1,
		type,
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: componentTipo,
	};
}

function assertBand(): void {
	for (const record of OWNED) {
		if (record.sectionId < BAND_LOW || record.sectionId > BAND_HIGH) {
			throw new Error(
				`tm_note_fixture: ${record.table}/${record.sectionId} is outside ${BAND_LOW}-${BAND_HIGH}`,
			);
		}
	}
}

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

export function clearTmNoteCaches(): void {
	clearPrincipalCache();
	clearUserProjectsCache();
	clearPermissionsCache();
	clearUserFilterRecordsCache();
	clearTmNoteFactsCache();
}

async function purgeIdentities(strict: boolean): Promise<void> {
	assertBand();
	const missing: string[] = [];
	for (const record of OWNED) {
		const removed = await deleteMatrixRecord(record.table, record.sectionTipo, record.sectionId);
		if (removed === 0) missing.push(`${record.table}/${record.sectionTipo}/${record.sectionId}`);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[record.sectionTipo, record.sectionId],
		);
	}
	if (strict && missing.length > 0) {
		throw new Error(`tm_note_fixture sweep removed 0 rows for: ${missing.join(', ')}`);
	}
}

/** Mint the identities. Idempotent (a crashed run's rows are swept first). */
export async function installTmNoteFixture(): Promise<void> {
	await assertTestDatabase('installTmNoteFixture');
	assertBand();
	await purgeIdentities(false);
	for (const project of [TM_NOTE_PROJECT, TM_NOTE_FOREIGN_PROJECT]) {
		await insertIdentityRow('matrix_projects', PROJECTS_SECTION, project, {
			string: { dd156: [{ id: 1, lang: 'lg-eng', value: `zztmnote project ${project}` }] },
		});
	}
	for (const identity of IDENTITIES) {
		await insertIdentityRow('matrix_profiles', PROFILES_SECTION, profileOf(identity.userId), {
			string: { dd237: [{ id: 1, lang: 'lg-eng', value: `${identity.name} profile` }] },
			misc: {
				dd774: identity.grants.map(([sectionTipo, tipo, value], index) => ({
					id: index + 1,
					tipo,
					section_tipo: sectionTipo,
					value,
				})),
			},
		});
		await insertIdentityRow('matrix_users', USERS_SECTION, identity.userId, {
			string: { dd132: [{ id: 1, lang: 'lg-nolan', value: identity.name }] },
			relation: {
				dd131: [locator('dd131', YES_NO_SECTION, YES)],
				dd244: [locator('dd244', YES_NO_SECTION, identity.admin === true ? YES : NO)],
				dd515: [locator('dd515', YES_NO_SECTION, NO)],
				dd1725: [locator('dd1725', PROFILES_SECTION, profileOf(identity.userId))],
				dd170: [locator('dd170', PROJECTS_SECTION, identity.project ?? TM_NOTE_PROJECT)],
			},
		});
	}
	clearTmNoteCaches();
}

/** Every record this process created (annotated records and the notes the gate made). */
const createdRecords: { sectionTipo: string; sectionId: number }[] = [];

/** Register a record for the sweep (a note the action created, found by its Code). */
export function trackTmNoteRecord(sectionTipo: string, sectionId: number): void {
	if (!createdRecords.some((r) => r.sectionTipo === sectionTipo && r.sectionId === sectionId)) {
		createdRecords.push({ sectionTipo, sectionId });
	}
}

/**
 * Forget a tracked record a gate legitimately DELETED (the sweep is loud on a
 * 0-row delete), sweeping its TM rows (a record delete leaves its history).
 */
export async function forgetDeletedTmNoteRecord(
	sectionTipo: string,
	sectionId: number,
): Promise<void> {
	await assertTestDatabase('forgetDeletedTmNoteRecord');
	const index = createdRecords.findIndex(
		(r) => r.sectionTipo === sectionTipo && r.sectionId === sectionId,
	);
	if (index === -1) throw new Error(`tm_note_fixture: ${sectionTipo}/${sectionId} is not tracked`);
	createdRecords.splice(index, 1);
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2', [
		sectionTipo,
		sectionId,
	]);
}

/**
 * Mint ONE TM row authored by `authorUserId`: a scratch test6100 record (born
 * as root) and a save of its input_text AS the author. Returns the TM row id
 * and the annotated record's id.
 */
export async function mintTmRow(
	authorUserId: number,
	value: string,
): Promise<{ tmRowId: number; sectionId: number }> {
	await assertTestDatabase('mintTmRow');
	const sectionId = await createSectionRecord(TM_NOTE_SECTION, -1, new Date(), undefined, {
		filterData: [locator('test6254', PROJECTS_SECTION, TM_NOTE_PROJECT, 'dd675')],
	});
	trackTmNoteRecord(TM_NOTE_SECTION, sectionId);
	const saved = await saveComponentData({
		componentTipo: TM_NOTE_TEXT,
		sectionTipo: TM_NOTE_SECTION,
		sectionId,
		lang: 'lg-nolan',
		changedData: [
			{ action: 'set_data', key: null, value: [{ id: 1, lang: 'lg-nolan', value }] } as never,
		],
		userId: authorUserId,
	});
	if (!saved.ok) throw new Error(`tm_note_fixture: mint save failed: ${JSON.stringify(saved)}`);
	const rows = await readTimeMachineHistory(TM_NOTE_SECTION, sectionId, TM_NOTE_TEXT, 1);
	const row = rows[0];
	// user_id may arrive as a bigint string from the driver.
	if (row === undefined || Number(row.user_id) !== authorUserId) {
		throw new Error(`tm_note_fixture: no TM row authored by ${authorUserId} on ${sectionId}`);
	}
	return { tmRowId: Number(row.id), sectionId };
}

/** Sweep every tracked record and its TM rows; then the identities. Loud on a 0-row delete. */
export async function removeTmNoteFixture(): Promise<void> {
	await assertTestDatabase('removeTmNoteFixture');
	const missing: string[] = [];
	while (createdRecords.length > 0) {
		const record = createdRecords.pop() as { sectionTipo: string; sectionId: number };
		const table = await getMatrixTableFromTipo(record.sectionTipo);
		if (table === null) throw new Error(`tm_note_fixture: no table for ${record.sectionTipo}`);
		const removed = await deleteMatrixRecord(table, record.sectionTipo, record.sectionId);
		if (removed === 0) missing.push(`${record.sectionTipo}/${record.sectionId}`);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[record.sectionTipo, record.sectionId],
		);
	}
	await purgeIdentities(true);
	clearTmNoteCaches();
	if (missing.length > 0) {
		throw new Error(`tm_note_fixture: record sweep removed 0 rows for ${missing.join(', ')}`);
	}
}

export interface TmNoteIdentities {
	author: Principal;
	other: Principal;
	noTm: Principal;
	auditor: Principal;
	admin: Principal;
}

export async function resolveTmNoteIdentities(): Promise<TmNoteIdentities> {
	return {
		author: await resolvePrincipal(TM_NOTE_AUTHOR_USER_ID),
		other: await resolvePrincipal(TM_NOTE_OTHER_USER_ID),
		noTm: await resolvePrincipal(TM_NOTE_NO_TM_USER_ID),
		auditor: await resolvePrincipal(TM_NOTE_AUDITOR_USER_ID),
		admin: await resolvePrincipal(TM_NOTE_ADMIN_USER_ID),
	};
}

/**
 * Set `userId`'s TM access (the test6394 time_machine_list grant on its
 * profile) — the "creator who LOST TM access" case (T0-4 part C, Q-d). A
 * fixture identity only (band-asserted); the grant matrix is rewritten in place
 * and every security cache is cleared.
 */
export async function setTmNoteTmAccess(userId: number, level: 0 | 1): Promise<void> {
	await assertTestDatabase('setTmNoteTmAccess');
	const identity = IDENTITIES.find((candidate) => candidate.userId === userId);
	if (identity === undefined) throw new Error(`tm_note_fixture: ${userId} is no fixture identity`);
	const grants = identity.grants
		.filter(([, tipo]) => tipo !== TM_NOTE_TM_LIST)
		.concat([[TM_NOTE_SECTION, TM_NOTE_TM_LIST, level]]);
	const dd774 = grants.map(([sectionTipo, tipo, value], index) => ({
		id: index + 1,
		tipo,
		section_tipo: sectionTipo,
		value,
	}));
	const updated = await sql.unsafe(
		`UPDATE matrix_profiles SET misc = jsonb_set(COALESCE(misc, '{}'::jsonb), '{dd774}', $3::text::jsonb)
		  WHERE section_tipo = $1 AND section_id = $2`,
		[PROFILES_SECTION, profileOf(userId), encodeForJsonb(dd774)],
	);
	if ((updated as { count?: number }).count !== 1) {
		throw new Error(`tm_note_fixture: profile ${profileOf(userId)} not rewritten`);
	}
	clearTmNoteCaches();
}
