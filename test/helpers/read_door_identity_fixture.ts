/**
 * THE READ-DOOR IDENTITY FIXTURE — two NON-ADMIN readers whose profiles differ
 * on exactly the components the read-door gates are about (P1-3).
 *
 * WHY A SECOND FIXTURE. `acl_identity_fixture.ts` mints an admin and a reader,
 * and DENIES `test91` to BOTH — it can prove "denied is withheld" but not the
 * positive half, "granted is served", for the same component on the same
 * section. A gate that only proves the negative half is satisfied by a door
 * that refuses everything. So this helper mints a READER and a CONTROL that
 * are identical in every way (non-admin, same project) EXCEPT the grants under
 * test, and every disclosure assertion in its consumers is a PAIR: the reader
 * is refused / narrowed, the control on the same call is served.
 *
 * WHAT IT MINTS (band 937000-937999, string prefix `zzdoor`; no ontology node
 * is written — users/profiles/projects are ordinary dd128/dd234/dd153 records):
 *
 *   937021 matrix_projects  the one project both readers are scoped to
 *   937011 matrix_profiles  READER  — dd774: test3=2, test3.test52=1,
 *                                     test3.test54=1, test3.test92=1,
 *                                     test3.test101=1 (the projects filter),
 *                                     test3.test126=2 (button_new),
 *                                     test3.test91=0, test3.test99=0,
 *                                     test3.test80=0, test3.test96=0 (button_delete),
 *                                     test3.test100=0 (geolocation)
 *                                     — NO test2 grant at all.
 *   937012 matrix_profiles  CONTROL — the same, PLUS test3.test91=1,
 *                                     test3.test99=1, test3.test80=1,
 *                                     test3.test96=2, test2=1, test2.test52=1,
 *                                     test2.test99=1, test3.test100=1 (geolocation)
 *   937013 matrix_profiles  MEDIA-ONLY — test2.test52=1, test2.test99=1 and
 *                                     NOTHING else (components without their section)
 *   937001 matrix_users     READER  — dd244 No, dd515 No, dd1725 → 937011,
 *                                     dd170 → 937021
 *   937002 matrix_users     CONTROL — as READER, dd1725 → 937012
 *   937003 matrix_users     MEDIA-ONLY — as READER, dd1725 → 937013
 *
 * The grants are asserted back through the REAL doors by
 * `read_door_acl_native`'s first test, so a fixture that claims a level it does
 * not confer reddens there (the ACL fixture's own posture).
 *
 * The COMPONENTS are test3's own (the seeded playground ontology): test52
 * component_input_text (string column), test54 component_relation_related and
 * test80 component_portal (relation column), test91 component_select, test92
 * component_publication, test99 component_image, test126 button_new, test96
 * button_delete. test2 is test3's SIBLING in `matrix_test` — the landed-section
 * case of the criterion path reader needs a locator whose section shares the
 * declared step's table.
 *
 * SWEEP. `removeReadDoorIdentityFixture()` deletes the seven records and their
 * TM rows and THROWS when a matrix delete removes 0 rows.
 */

import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
} from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

export const DOOR_READER_USER_ID = 937001;
export const DOOR_CONTROL_USER_ID = 937002;
/**
 * The MEDIA-ONLY reader: holds `test2.test52` and `test2.test99` (components
 * of the sibling section) at 1 and NO grant on `test2` itself — the exact
 * shape that passed the RAG image-chunk gate on the component alone (SEC-11),
 * and the MCP media door on the component key alone (SEC-06's residue).
 */
export const DOOR_MEDIA_ONLY_USER_ID = 937003;
export const DOOR_READER_PROFILE_ID = 937011;
export const DOOR_CONTROL_PROFILE_ID = 937012;
export const DOOR_MEDIA_ONLY_PROFILE_ID = 937013;
export const DOOR_PROJECT_ID = 937021;

export const DOOR_SECTION = 'test3';
/** test3's sibling in matrix_test — the landed-section case. */
export const DOOR_SIBLING_SECTION = 'test2';
export const DOOR_TEXT = 'test52';
export const DOOR_RELATED = 'test54';
export const DOOR_PORTAL = 'test80';
export const DOOR_SELECT = 'test91';
export const DOOR_PUBLICATION = 'test92';
export const DOOR_IMAGE = 'test99';
export const DOOR_FILTER = 'test101';
export const DOOR_BUTTON_NEW = 'test126';
export const DOOR_BUTTON_DELETE = 'test96';
/** component_geolocation: the tile proxy's component key (reader 0, control 1). */
export const DOOR_GEO = 'test100';

const USERS_SECTION = 'dd128';
const PROFILES_SECTION = 'dd234';
const PROJECTS_SECTION = 'dd153';
const YES_NO_SECTION = 'dd64';
const NO = 2;

const OWNED: { table: string; sectionTipo: string; sectionId: number }[] = [
	{ table: 'matrix_users', sectionTipo: USERS_SECTION, sectionId: DOOR_READER_USER_ID },
	{ table: 'matrix_users', sectionTipo: USERS_SECTION, sectionId: DOOR_CONTROL_USER_ID },
	{ table: 'matrix_profiles', sectionTipo: PROFILES_SECTION, sectionId: DOOR_READER_PROFILE_ID },
	{ table: 'matrix_profiles', sectionTipo: PROFILES_SECTION, sectionId: DOOR_CONTROL_PROFILE_ID },
	{ table: 'matrix_users', sectionTipo: USERS_SECTION, sectionId: DOOR_MEDIA_ONLY_USER_ID },
	{
		table: 'matrix_profiles',
		sectionTipo: PROFILES_SECTION,
		sectionId: DOOR_MEDIA_ONLY_PROFILE_ID,
	},
	{ table: 'matrix_projects', sectionTipo: PROJECTS_SECTION, sectionId: DOOR_PROJECT_ID },
];

const SCRATCH_ID_FLOOR = 900000;

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
function grant(id: number, sectionTipo: string, tipo: string, value: number) {
	return { id, tipo, section_tipo: sectionTipo, value };
}

/** The grants BOTH profiles carry. */
function sharedGrants() {
	return [
		grant(1, DOOR_SECTION, DOOR_SECTION, 2),
		grant(2, DOOR_SECTION, DOOR_TEXT, 1),
		grant(3, DOOR_SECTION, DOOR_RELATED, 1),
		grant(4, DOOR_SECTION, DOOR_PUBLICATION, 1),
		grant(5, DOOR_SECTION, DOOR_BUTTON_NEW, 2),
		// The projects filter component — every real profile grants it, or the
		// record's own project chip vanishes from the human read.
		grant(6, DOOR_SECTION, DOOR_FILTER, 1),
		// EXPLICIT zeros on the reader (a present-but-zero row, not an absent one,
		// so a reader that tested `!== undefined` instead of `>= 1` is caught).
	];
}

function readerOnlyGrants() {
	return [
		grant(10, DOOR_SECTION, DOOR_SELECT, 0),
		grant(11, DOOR_SECTION, DOOR_IMAGE, 0),
		grant(12, DOOR_SECTION, DOOR_PORTAL, 0),
		grant(13, DOOR_SECTION, DOOR_BUTTON_DELETE, 0),
		grant(17, DOOR_SECTION, DOOR_GEO, 0),
	];
}

function controlOnlyGrants() {
	return [
		grant(10, DOOR_SECTION, DOOR_SELECT, 1),
		grant(11, DOOR_SECTION, DOOR_IMAGE, 1),
		grant(12, DOOR_SECTION, DOOR_PORTAL, 1),
		grant(13, DOOR_SECTION, DOOR_BUTTON_DELETE, 2),
		grant(14, DOOR_SIBLING_SECTION, DOOR_SIBLING_SECTION, 1),
		grant(15, DOOR_SIBLING_SECTION, DOOR_TEXT, 1),
		grant(16, DOOR_SIBLING_SECTION, DOOR_IMAGE, 1),
		grant(18, DOOR_SECTION, DOOR_GEO, 1),
	];
}

async function insertScratchRecord(
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

function assertScratchIds(): void {
	for (const record of OWNED) {
		if (!Number.isInteger(record.sectionId) || record.sectionId < SCRATCH_ID_FLOOR) {
			throw new Error(
				`read_door_identity_fixture: ${record.table}/${record.sectionTipo} id ${record.sectionId} is below the scratch floor ${SCRATCH_ID_FLOOR}`,
			);
		}
	}
}

export function clearReadDoorIdentityCaches(): void {
	clearPrincipalCache();
	clearUserProjectsCache();
	clearPermissionsCache();
}

/** Mint the fixture. Idempotent: a crashed run's rows are swept first. */
export async function installReadDoorIdentityFixture(): Promise<void> {
	await assertTestDatabase('installReadDoorIdentityFixture');
	assertScratchIds();
	await purge({ strict: false });

	await insertScratchRecord('matrix_projects', PROJECTS_SECTION, DOOR_PROJECT_ID, {
		string: { dd156: [{ id: 1, lang: 'lg-eng', value: 'zzdoor scratch project' }] },
	});
	await insertScratchRecord('matrix_profiles', PROFILES_SECTION, DOOR_READER_PROFILE_ID, {
		string: { dd237: [{ id: 1, lang: 'lg-eng', value: 'zzdoor reader profile' }] },
		misc: { dd774: [...sharedGrants(), ...readerOnlyGrants()] },
	});
	await insertScratchRecord('matrix_profiles', PROFILES_SECTION, DOOR_CONTROL_PROFILE_ID, {
		string: { dd237: [{ id: 1, lang: 'lg-eng', value: 'zzdoor control profile' }] },
		misc: { dd774: [...sharedGrants(), ...controlOnlyGrants()] },
	});
	await insertScratchRecord('matrix_profiles', PROFILES_SECTION, DOOR_MEDIA_ONLY_PROFILE_ID, {
		string: { dd237: [{ id: 1, lang: 'lg-eng', value: 'zzdoor media-only profile' }] },
		// Components WITHOUT their section: test2.test52 = test2.test99 = 1,
		// test2 absent (0).
		misc: {
			dd774: [
				grant(1, DOOR_SIBLING_SECTION, DOOR_TEXT, 1),
				grant(2, DOOR_SIBLING_SECTION, DOOR_IMAGE, 1),
			],
		},
	});
	for (const [userId, profileId, name] of [
		[DOOR_READER_USER_ID, DOOR_READER_PROFILE_ID, 'zzdoor_reader'],
		[DOOR_CONTROL_USER_ID, DOOR_CONTROL_PROFILE_ID, 'zzdoor_control'],
		[DOOR_MEDIA_ONLY_USER_ID, DOOR_MEDIA_ONLY_PROFILE_ID, 'zzdoor_media_only'],
	] as const) {
		await insertScratchRecord('matrix_users', USERS_SECTION, userId, {
			string: { dd132: [{ id: 1, lang: 'lg-nolan', value: name }] },
			relation: {
				dd131: [locator('dd131', YES_NO_SECTION, 1)],
				dd244: [locator('dd244', YES_NO_SECTION, NO)],
				dd515: [locator('dd515', YES_NO_SECTION, NO)],
				dd1725: [locator('dd1725', PROFILES_SECTION, profileId)],
				dd170: [locator('dd170', PROJECTS_SECTION, DOOR_PROJECT_ID)],
			},
		});
	}
	clearReadDoorIdentityCaches();
}

export async function removeReadDoorIdentityFixture(): Promise<void> {
	await assertTestDatabase('removeReadDoorIdentityFixture');
	await purge({ strict: true });
	clearReadDoorIdentityCaches();
}

async function purge(options: { strict: boolean }): Promise<void> {
	assertScratchIds();
	const missing: string[] = [];
	for (const record of OWNED) {
		const removed = await deleteMatrixRecord(record.table, record.sectionTipo, record.sectionId);
		if (removed === 0) missing.push(`${record.table}/${record.sectionTipo}/${record.sectionId}`);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[record.sectionTipo, record.sectionId],
		);
	}
	if (options.strict && missing.length > 0) {
		throw new Error(
			`read_door_identity_fixture sweep removed 0 rows for: ${missing.join(', ')} — the scratch filter is wrong or another run deleted them`,
		);
	}
}

/** The project locator a scratch test3 record needs to be IN the readers' scope. */
export function doorProjectLocator(projectId: number = DOOR_PROJECT_ID) {
	return {
		id: 1,
		type: 'dd151',
		section_id: projectId,
		section_tipo: PROJECTS_SECTION,
		from_component_tipo: DOOR_FILTER,
	};
}
