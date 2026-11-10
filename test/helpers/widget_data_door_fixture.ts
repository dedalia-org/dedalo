/**
 * THE WIDGET-DATA READ-DOOR FIXTURE — the personas and records of
 * test/unit/widget_data_read_door_native.test.ts (WC-2026-11-10-widget-data-read-door).
 *
 * Modelled on read_door_identity_fixture.ts (that file is another lane's and
 * stays untouched): every disclosure assertion is a PAIR — a READER refused and
 * a CONTROL served on the same call — and the two are IDENTICAL (non-admin,
 * same project, same filter grant) except for the ONE grant under test, so a
 * door that refuses everybody cannot pass.
 *
 * WHAT IT MINTS (band 937400-937499 ONLY — concurrent lanes own other bands;
 * string prefix `zzwidget`; no ontology node is written — users / profiles /
 * projects are ordinary dd128 / dd234 / dd153 records, the records test3's):
 *
 *   937421 matrix_projects  the one project every persona is scoped to
 *   937412 matrix_profiles  CONTROL       — test3=1, test3.test212=1, test3.test101=1
 *   937411 matrix_profiles  NO_SECTION    — test3=0 (explicit), test212=1, test101=1
 *   937413 matrix_profiles  NO_COMPONENT  — test3=1, test212=0 (explicit), test101=1
 *   937402 / 937401 / 937403 matrix_users — one per profile, dd170 → 937421
 *   937450 matrix_test test3 — IN scope (test101 → 937421), test52 = a value
 *   937451 matrix_test test3 — OUT of scope (no project), test52 = a value
 *
 * The explicit zeros are present-but-zero rows (not absent ones), so a reader
 * that tested `!== undefined` instead of `>= 1` is caught. NO persona holds a
 * test52 grant: the widget's `ipo` input passes "as displayed" (owner decision
 * 2026-11-10), and the served value proves it.
 *
 * SWEEP. `removeWidgetDataDoorFixture()` deletes every owned row and its TM
 * tail and THROWS when a delete removes 0 rows or a row survives.
 */

import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
} from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

export const WIDGET_CONTROL_USER_ID = 937402;
export const WIDGET_NO_SECTION_USER_ID = 937401;
export const WIDGET_NO_COMPONENT_USER_ID = 937403;
const CONTROL_PROFILE_ID = 937412;
const NO_SECTION_PROFILE_ID = 937411;
const NO_COMPONENT_PROFILE_ID = 937413;
const PROJECT_ID = 937421;

export const WIDGET_SECTION = 'test3';
/** component_info, properties.widgets = [test_info] reading test52 of the current record. */
export const WIDGET_INFO = 'test212';
export const WIDGET_NAME = 'test_info';
/** The widget's ipo input (component_input_text) — granted to NO persona. */
export const WIDGET_INPUT = 'test52';
const FILTER = 'test101';

export const IN_SCOPE_RECORD_ID = 937450;
export const OUT_OF_SCOPE_RECORD_ID = 937451;
export const IN_SCOPE_VALUE = 'zzwidget in-scope value';
export const OUT_OF_SCOPE_VALUE = 'zzwidget out-of-scope value';

const BAND_LOW = 937400;
const BAND_HIGH = 937499;

const USERS_SECTION = 'dd128';
const PROFILES_SECTION = 'dd234';
const PROJECTS_SECTION = 'dd153';
const YES_NO_SECTION = 'dd64';
const NO = 2;

type Owned = { table: string; sectionTipo: string; sectionId: number };

const OWNED: Owned[] = [
	{ table: 'matrix_users', sectionTipo: USERS_SECTION, sectionId: WIDGET_CONTROL_USER_ID },
	{ table: 'matrix_users', sectionTipo: USERS_SECTION, sectionId: WIDGET_NO_SECTION_USER_ID },
	{ table: 'matrix_users', sectionTipo: USERS_SECTION, sectionId: WIDGET_NO_COMPONENT_USER_ID },
	{ table: 'matrix_profiles', sectionTipo: PROFILES_SECTION, sectionId: CONTROL_PROFILE_ID },
	{ table: 'matrix_profiles', sectionTipo: PROFILES_SECTION, sectionId: NO_SECTION_PROFILE_ID },
	{ table: 'matrix_profiles', sectionTipo: PROFILES_SECTION, sectionId: NO_COMPONENT_PROFILE_ID },
	{ table: 'matrix_projects', sectionTipo: PROJECTS_SECTION, sectionId: PROJECT_ID },
	{ table: 'matrix_test', sectionTipo: WIDGET_SECTION, sectionId: IN_SCOPE_RECORD_ID },
	{ table: 'matrix_test', sectionTipo: WIDGET_SECTION, sectionId: OUT_OF_SCOPE_RECORD_ID },
];

function assertBand(): void {
	for (const row of OWNED) {
		if (!Number.isInteger(row.sectionId) || row.sectionId < BAND_LOW || row.sectionId > BAND_HIGH) {
			throw new Error(
				`widget_data_door_fixture: ${row.table}/${row.sectionTipo}/${row.sectionId} is outside the owned band ${BAND_LOW}-${BAND_HIGH}`,
			);
		}
	}
}

function locator(componentTipo: string, sectionTipo: string, sectionId: number) {
	return {
		id: 1,
		type: 'dd151',
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: componentTipo,
	};
}

/** One dd774 row — `${section}_${tipo}` → value is how getPermissionsTable reads it. */
function grant(id: number, tipo: string, value: number) {
	return { id, tipo, section_tipo: WIDGET_SECTION, value };
}

/** The ONLY lines that differ between the three profiles are the first two. */
function grantsOf(section: number, info: number) {
	return [grant(1, WIDGET_SECTION, section), grant(2, WIDGET_INFO, info), grant(3, FILTER, 1)];
}

async function insert(
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

function clearCaches(): void {
	clearPrincipalCache();
	clearUserProjectsCache();
	clearPermissionsCache();
}

/** Mint the fixture. Idempotent: a crashed run's rows are swept first. */
export async function installWidgetDataDoorFixture(): Promise<void> {
	await assertTestDatabase('installWidgetDataDoorFixture');
	assertBand();
	await purge();

	await insert('matrix_projects', PROJECTS_SECTION, PROJECT_ID, {
		string: { dd156: [{ id: 1, lang: 'lg-eng', value: 'zzwidget scratch project' }] },
	});
	for (const [profileId, label, section, info] of [
		[CONTROL_PROFILE_ID, 'control', 1, 1],
		[NO_SECTION_PROFILE_ID, 'no section', 0, 1],
		[NO_COMPONENT_PROFILE_ID, 'no component', 1, 0],
	] as const) {
		await insert('matrix_profiles', PROFILES_SECTION, profileId, {
			string: { dd237: [{ id: 1, lang: 'lg-eng', value: `zzwidget ${label} profile` }] },
			misc: { dd774: grantsOf(section, info) },
		});
	}
	for (const [userId, profileId, name] of [
		[WIDGET_CONTROL_USER_ID, CONTROL_PROFILE_ID, 'zzwidget_control'],
		[WIDGET_NO_SECTION_USER_ID, NO_SECTION_PROFILE_ID, 'zzwidget_no_section'],
		[WIDGET_NO_COMPONENT_USER_ID, NO_COMPONENT_PROFILE_ID, 'zzwidget_no_component'],
	] as const) {
		await insert('matrix_users', USERS_SECTION, userId, {
			string: { dd132: [{ id: 1, lang: 'lg-nolan', value: name }] },
			relation: {
				dd131: [locator('dd131', YES_NO_SECTION, 1)],
				dd244: [locator('dd244', YES_NO_SECTION, NO)],
				dd515: [locator('dd515', YES_NO_SECTION, NO)],
				dd1725: [locator('dd1725', PROFILES_SECTION, profileId)],
				dd170: [locator('dd170', PROJECTS_SECTION, PROJECT_ID)],
			},
		});
	}
	await insert('matrix_test', WIDGET_SECTION, IN_SCOPE_RECORD_ID, {
		string: { [WIDGET_INPUT]: [{ id: 1, lang: 'lg-nolan', value: IN_SCOPE_VALUE }] },
		relation: { [FILTER]: [locator(FILTER, PROJECTS_SECTION, PROJECT_ID)] },
	});
	await insert('matrix_test', WIDGET_SECTION, OUT_OF_SCOPE_RECORD_ID, {
		string: { [WIDGET_INPUT]: [{ id: 1, lang: 'lg-nolan', value: OUT_OF_SCOPE_VALUE }] },
	});
	clearCaches();
}

/** Sweep the fixture; THROWS on a delete that removed nothing or on any residue. */
export async function removeWidgetDataDoorFixture(): Promise<void> {
	await assertTestDatabase('removeWidgetDataDoorFixture');
	const missing = await purge();
	const residue: string[] = [];
	for (const row of OWNED) {
		const rows = (await sql.unsafe(
			`SELECT 1 FROM "${row.table}" WHERE section_tipo = $1 AND section_id = $2
			 UNION ALL SELECT 1 FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2`,
			[row.sectionTipo, row.sectionId],
		)) as unknown[];
		if (rows.length > 0) residue.push(`${row.table}/${row.sectionTipo}/${row.sectionId}`);
	}
	clearCaches();
	if (missing.length > 0 || residue.length > 0) {
		throw new Error(
			`widget_data_door_fixture sweep: removed 0 rows for [${missing.join(', ')}]; residue [${residue.join(', ')}]`,
		);
	}
}

/** Delete every owned row + its TM tail; returns the rows whose delete removed nothing. */
async function purge(): Promise<string[]> {
	assertBand();
	const missing: string[] = [];
	for (const row of OWNED) {
		const removed = (await sql.unsafe(
			`DELETE FROM "${row.table}" WHERE section_tipo = $1 AND section_id = $2 RETURNING section_id`,
			[row.sectionTipo, row.sectionId],
		)) as unknown[];
		if (removed.length === 0) missing.push(`${row.table}/${row.sectionTipo}/${row.sectionId}`);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[row.sectionTipo, row.sectionId],
		);
	}
	return missing;
}
