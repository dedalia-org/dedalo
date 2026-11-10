/**
 * THE get_tags_info READ-DOOR FIXTURE — non-admin personas whose profiles
 * differ from a CONTROL on exactly ONE grant each, plus the scratch records the
 * door and its hops read (T0-3, WC-2026-11-10-tags-info-read-door).
 *
 * Modelled on read_door_identity_fixture.ts (the reader/control PAIR law: every
 * refusal is asserted next to a control that is served on the same call, so a
 * door refusing everything cannot pass), but on the `zztags` scratch situation
 * (test/helpers/zztags_situation.ts) and in its own explicit-id band 937300-937399.
 *
 * WHAT IT MINTS (no ontology node — users/profiles/projects are ordinary
 * dd128/dd234/dd153 records; the zztags records die with the situation too):
 *
 *   937301 matrix_projects  IN  — every persona's one project
 *   937302 matrix_projects  OUT — nobody's project
 *   937311 matrix_profiles  CONTROL           every zztags grant = 1
 *   937312 matrix_profiles  NO_SECTION        CONTROL with zztags1 (host section) = 0
 *   937313 matrix_profiles  NO_TEXT_AREA      CONTROL with zztags2 (the text_area) = 0
 *   937314 matrix_profiles  NO_NOTE_SECTION   CONTROL with zztags4 (note section) = 0
 *   937315 matrix_profiles  NO_NOTE_COMPONENT CONTROL with zztags6 (note body) = 0
 *   937316 matrix_profiles  NO_TAG_SOURCE     CONTROL with zztags3 (tags_index source) = 0
 *   937317 matrix_profiles  NO_PERSONS_COMPONENT CONTROL with zztags9 (tags_persons source) = 0
 *   937321..937327 matrix_users  one per profile above, same order, all → project IN
 *
 *   zztags1/937331  the host: lg-spa transcription with an index mark and TWO
 *                   note marks (937341 in scope, 937342 out), an index locator
 *                   (→ test3/1), filter → IN
 *   zztags4/937341  a real NOTE, filter → IN (title / body / publishable)
 *   zztags4/937342  a real NOTE, filter → OUT
 *   zztags4/937351  a RELATED record (zztags9 → the host + zztags1/937391), filter → OUT
 *   zztags4/937352  a RELATED record (zztags9 → the host + zztags1/937392), filter → IN
 *
 * The zero grants are EXPLICIT rows (present-but-zero), never absent ones, so a
 * reader that tested `!== undefined` instead of `>= 1` is caught.
 *
 * SWEEP. `removeTagsInfoDoorFixture()` deletes every owned row + its TM rows and
 * THROWS when a delete removes 0 rows (strict) — then asserts zero residue.
 */

import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
} from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	ZZTAGS_HOST_FILTER,
	ZZTAGS_NOTE_BODY,
	ZZTAGS_NOTE_FILTER,
	ZZTAGS_NOTE_PUBLISHABLE,
	ZZTAGS_NOTE_SECTION,
	ZZTAGS_NOTE_TITLE,
	ZZTAGS_PERSONS_PORTAL,
	ZZTAGS_SECTION,
	ZZTAGS_TAGS_INDEX,
	ZZTAGS_TEXT_AREA,
} from './zztags_situation.ts';

export const TAGS_PROJECT_IN = 937301;
export const TAGS_PROJECT_OUT = 937302;

/** The persona → the ONE grant it differs from CONTROL on (null = CONTROL itself). */
export const TAGS_PERSONAS = {
	CONTROL: { userId: 937321, profileId: 937311, zero: null },
	NO_SECTION: { userId: 937322, profileId: 937312, zero: ZZTAGS_SECTION },
	NO_TEXT_AREA: { userId: 937323, profileId: 937313, zero: ZZTAGS_TEXT_AREA },
	NO_NOTE_SECTION: { userId: 937324, profileId: 937314, zero: ZZTAGS_NOTE_SECTION },
	NO_NOTE_COMPONENT: { userId: 937325, profileId: 937315, zero: ZZTAGS_NOTE_BODY },
	NO_TAG_SOURCE: { userId: 937326, profileId: 937316, zero: ZZTAGS_TAGS_INDEX },
	NO_PERSONS_COMPONENT: { userId: 937327, profileId: 937317, zero: ZZTAGS_PERSONS_PORTAL },
} as const;

export const TAGS_HOST_ID = 937331;
export const TAGS_NOTE_IN_ID = 937341;
export const TAGS_NOTE_OUT_ID = 937342;
export const TAGS_RELATED_OUT_ID = 937351;
export const TAGS_RELATED_IN_ID = 937352;
export const TAGS_PERSON_OF_OUT = 937391;
export const TAGS_PERSON_OF_IN = 937392;

const USERS_SECTION = 'dd128';
const PROFILES_SECTION = 'dd234';
const PROJECTS_SECTION = 'dd153';
const YES_NO_SECTION = 'dd64';
const NO = 2;
const BAND_FLOOR = 937300;
const BAND_CEILING = 937399;

/** The host transcription: one index mark, two note marks (in / out of scope). */
export const TAGS_HOST_TEXT =
	'<p>uno [index-n-1-Person-data:x:data]dos[/index-n-1] tres' +
	` [note-a-1-data:{'section_tipo':'${ZZTAGS_NOTE_SECTION}','section_id':'${TAGS_NOTE_IN_ID}'}:data]` +
	` [note-a-2-data:{'section_tipo':'${ZZTAGS_NOTE_SECTION}','section_id':'${TAGS_NOTE_OUT_ID}'}:data] fin.</p>`;

/** The tags_index locator stored on the host (canonical test3/1 — its term is known). */
export const TAGS_INDEX_LOCATOR = {
	id: 1,
	type: 'dd151',
	section_id: 1,
	section_tipo: 'test3',
	from_component_tipo: ZZTAGS_TAGS_INDEX,
};

function locator(componentTipo: string, sectionTipo: string, sectionId: number, id = 1) {
	return {
		id,
		type: 'dd151',
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: componentTipo,
	};
}

function grant(id: number, sectionTipo: string, tipo: string, value: number) {
	return { id, tipo, section_tipo: sectionTipo, value };
}

/** Every grant a persona carries; the ONE `zero` tipo is an explicit 0. */
function grantsFor(zero: string | null) {
	const pairs: [string, string][] = [
		[ZZTAGS_SECTION, ZZTAGS_SECTION],
		[ZZTAGS_SECTION, ZZTAGS_TEXT_AREA],
		[ZZTAGS_SECTION, ZZTAGS_TAGS_INDEX],
		[ZZTAGS_SECTION, ZZTAGS_HOST_FILTER],
		[ZZTAGS_NOTE_SECTION, ZZTAGS_NOTE_SECTION],
		[ZZTAGS_NOTE_SECTION, ZZTAGS_NOTE_TITLE],
		[ZZTAGS_NOTE_SECTION, ZZTAGS_NOTE_BODY],
		[ZZTAGS_NOTE_SECTION, ZZTAGS_NOTE_PUBLISHABLE],
		[ZZTAGS_NOTE_SECTION, ZZTAGS_PERSONS_PORTAL],
		[ZZTAGS_NOTE_SECTION, ZZTAGS_NOTE_FILTER],
	];
	return pairs.map(([section, tipo], index) =>
		grant(index + 1, section, tipo, tipo === zero ? 0 : 1),
	);
}

interface Owned {
	table: string;
	sectionTipo: string;
	sectionId: number;
}

async function owned(): Promise<Owned[]> {
	const hostTable = (await getMatrixTableFromTipo(ZZTAGS_SECTION)) ?? '';
	const noteTable = (await getMatrixTableFromTipo(ZZTAGS_NOTE_SECTION)) ?? '';
	if (hostTable === '' || noteTable === '') {
		throw new Error('tags_info_door_fixture: the zztags situation is not ensured');
	}
	const rows: Owned[] = [
		{ table: 'matrix_projects', sectionTipo: PROJECTS_SECTION, sectionId: TAGS_PROJECT_IN },
		{ table: 'matrix_projects', sectionTipo: PROJECTS_SECTION, sectionId: TAGS_PROJECT_OUT },
		{ table: hostTable, sectionTipo: ZZTAGS_SECTION, sectionId: TAGS_HOST_ID },
	];
	for (const id of [TAGS_NOTE_IN_ID, TAGS_NOTE_OUT_ID, TAGS_RELATED_OUT_ID, TAGS_RELATED_IN_ID]) {
		rows.push({ table: noteTable, sectionTipo: ZZTAGS_NOTE_SECTION, sectionId: id });
	}
	for (const persona of Object.values(TAGS_PERSONAS)) {
		rows.push({
			table: 'matrix_profiles',
			sectionTipo: PROFILES_SECTION,
			sectionId: persona.profileId,
		});
		rows.push({ table: 'matrix_users', sectionTipo: USERS_SECTION, sectionId: persona.userId });
	}
	for (const row of rows) {
		if (row.sectionId < BAND_FLOOR || row.sectionId > BAND_CEILING) {
			throw new Error(
				`tags_info_door_fixture: id ${row.sectionId} is outside ${BAND_FLOOR}-${BAND_CEILING}`,
			);
		}
	}
	return rows;
}

async function insertRecord(
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

export function clearTagsInfoDoorCaches(): void {
	clearPrincipalCache();
	clearUserProjectsCache();
	clearPermissionsCache();
}

/** Mint the fixture (the zztags situation must already be ensured). Idempotent. */
export async function installTagsInfoDoorFixture(): Promise<void> {
	await assertTestDatabase('installTagsInfoDoorFixture');
	await purge({ strict: false });
	const hostTable = (await getMatrixTableFromTipo(ZZTAGS_SECTION)) as string;
	const noteTable = (await getMatrixTableFromTipo(ZZTAGS_NOTE_SECTION)) as string;

	for (const [id, name] of [
		[TAGS_PROJECT_IN, 'zztags door project IN'],
		[TAGS_PROJECT_OUT, 'zztags door project OUT'],
	] as const) {
		await insertRecord('matrix_projects', PROJECTS_SECTION, id, {
			string: { dd156: [{ id: 1, lang: 'lg-eng', value: name }] },
		});
	}
	for (const [name, persona] of Object.entries(TAGS_PERSONAS)) {
		await insertRecord('matrix_profiles', PROFILES_SECTION, persona.profileId, {
			string: { dd237: [{ id: 1, lang: 'lg-eng', value: `zztags door ${name}` }] },
			misc: { dd774: grantsFor(persona.zero) },
		});
		await insertRecord('matrix_users', USERS_SECTION, persona.userId, {
			string: { dd132: [{ id: 1, lang: 'lg-nolan', value: `zztags_door_${name.toLowerCase()}` }] },
			relation: {
				dd131: [locator('dd131', YES_NO_SECTION, 1)],
				dd244: [locator('dd244', YES_NO_SECTION, NO)],
				dd515: [locator('dd515', YES_NO_SECTION, NO)],
				dd1725: [locator('dd1725', PROFILES_SECTION, persona.profileId)],
				dd170: [locator('dd170', PROJECTS_SECTION, TAGS_PROJECT_IN)],
			},
		});
	}

	await insertRecord(hostTable, ZZTAGS_SECTION, TAGS_HOST_ID, {
		string: { [ZZTAGS_TEXT_AREA]: [{ id: 1, lang: 'lg-spa', value: TAGS_HOST_TEXT }] },
		relation: {
			[ZZTAGS_TAGS_INDEX]: [TAGS_INDEX_LOCATOR],
			[ZZTAGS_HOST_FILTER]: [locator(ZZTAGS_HOST_FILTER, PROJECTS_SECTION, TAGS_PROJECT_IN)],
		},
	});
	for (const [id, project, title] of [
		[TAGS_NOTE_IN_ID, TAGS_PROJECT_IN, 'note in scope'],
		[TAGS_NOTE_OUT_ID, TAGS_PROJECT_OUT, 'note out of scope'],
	] as const) {
		await insertRecord(noteTable, ZZTAGS_NOTE_SECTION, id, {
			string: {
				[ZZTAGS_NOTE_TITLE]: [{ id: 1, lang: 'lg-nolan', value: title }],
				[ZZTAGS_NOTE_BODY]: [{ id: 1, lang: 'lg-nolan', value: `${title} body` }],
			},
			relation: {
				[ZZTAGS_NOTE_PUBLISHABLE]: [locator(ZZTAGS_NOTE_PUBLISHABLE, YES_NO_SECTION, 1)],
				[ZZTAGS_NOTE_FILTER]: [locator(ZZTAGS_NOTE_FILTER, PROJECTS_SECTION, project)],
			},
		});
	}
	for (const [id, project, person] of [
		[TAGS_RELATED_OUT_ID, TAGS_PROJECT_OUT, TAGS_PERSON_OF_OUT],
		[TAGS_RELATED_IN_ID, TAGS_PROJECT_IN, TAGS_PERSON_OF_IN],
	] as const) {
		await insertRecord(noteTable, ZZTAGS_NOTE_SECTION, id, {
			relation: {
				[ZZTAGS_PERSONS_PORTAL]: [
					locator(ZZTAGS_PERSONS_PORTAL, ZZTAGS_SECTION, TAGS_HOST_ID, 1),
					locator(ZZTAGS_PERSONS_PORTAL, ZZTAGS_SECTION, person, 2),
				],
				[ZZTAGS_NOTE_FILTER]: [locator(ZZTAGS_NOTE_FILTER, PROJECTS_SECTION, project)],
			},
		});
	}
	clearTagsInfoDoorCaches();
}

/** Sweep every owned row + TM tail; strict = a 0-row delete throws; residue asserted. */
export async function removeTagsInfoDoorFixture(): Promise<void> {
	await assertTestDatabase('removeTagsInfoDoorFixture');
	await purge({ strict: true });
	const residue: string[] = [];
	for (const row of await owned()) {
		const left = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM "${row.table}" WHERE section_tipo = $1 AND section_id = $2`,
			[row.sectionTipo, row.sectionId],
		)) as { n: number }[];
		const tm = (await sql.unsafe(
			'SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[row.sectionTipo, row.sectionId],
		)) as { n: number }[];
		if ((left[0]?.n ?? 0) + (tm[0]?.n ?? 0) > 0) {
			residue.push(`${row.table}/${row.sectionTipo}/${row.sectionId}`);
		}
	}
	if (residue.length > 0) {
		throw new Error(`tags_info_door_fixture residue: ${residue.join(', ')}`);
	}
	clearTagsInfoDoorCaches();
}

async function purge(options: { strict: boolean }): Promise<void> {
	const missing: string[] = [];
	for (const row of await owned()) {
		const removed = await deleteMatrixRecord(row.table, row.sectionTipo, row.sectionId);
		if (removed === 0) missing.push(`${row.table}/${row.sectionTipo}/${row.sectionId}`);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[row.sectionTipo, row.sectionId],
		);
	}
	if (options.strict && missing.length > 0) {
		throw new Error(
			`tags_info_door_fixture sweep removed 0 rows for: ${missing.join(', ')} — the scratch filter is wrong or another run deleted them`,
		);
	}
}
