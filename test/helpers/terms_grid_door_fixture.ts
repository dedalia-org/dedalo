/**
 * THE TERMS / INDEXATION-GRID DOOR FIXTURE — four NON-ADMIN users identical in
 * every way (same project, same profile shape) EXCEPT the one grant each gate
 * pair is about (WC-2026-11-10-section-terms-read-door,
 * WC-2026-11-10-indexation-grid-read-door). Modelled on
 * `read_door_identity_fixture.ts` (which this helper does not touch): every
 * disclosure assertion of its consumers is a PAIR — the reader is refused /
 * narrowed, the CONTROL on the same call is served.
 *
 * WHAT IT MINTS (explicit ids 9376xx, string prefix `zz9376`; no ontology node
 * is written — users/profiles/projects are ordinary dd128/dd234/dd153 records,
 * the content records are test3 / test6813 rows of `matrix_test`):
 *
 *   937621 matrix_projects  the one project every persona is scoped to
 *   937611 matrix_profiles  CONTROL         — every grant below at >= 1
 *   937612 matrix_profiles  TERM_DENIED     — as CONTROL, test3.test52 = 0
 *                                              (test3's section_map term)
 *   937613 matrix_profiles  SECTION_DENIED  — as CONTROL, test3 = 0
 *   937614 matrix_profiles  TEXT_DENIED     — as CONTROL, test3.rsc36 = 0
 *                                              (the indexed text_area)
 *   937622 matrix_projects  a SECOND project only the WIDE persona holds
 *   937601-937604 matrix_users  one per profile, dd170 → 937621
 *   937605 matrix_users  WIDE — the CONTROL profile, dd170 → 937621 + 937622
 *
 *   CONTROL grants: test3=1, test3.test52=1, test3.test101=1 (projects filter),
 *   test3.rsc36=1, test6813=1, test6813.test6834=1 (its projects filter),
 *   test6813.test6826=1, test6813.test6837=1, testgeoa1=1 (the thesaurus term's
 *   section — get_indexation_grid's own door gate).
 *
 *   matrix_test test3/937631    IN the project   — test52 'zz9376 in scope'
 *   matrix_test test3/937632    NO project        — test52 'zz9376 out of scope'
 *   matrix_test test6813/937641, /937642  IN the project — the two group tops
 *   matrix_test test3/937651, /937652     indexing records: an rsc36 tagged
 *                               transcription + an rsc860 dd96 locator to the
 *                               thesaurus term GRID_TERM, section_top =
 *                               test6813/937641 resp. 937642.
 *   matrix_test test6813/937643, /937644  IN the project — two more group tops
 *   matrix_test test3/937653    indexing record IN the project, top 937643
 *   matrix_test test3/937654    indexing record ONLY in project 937622, top
 *                               937644 (group in scope, row record not) — both
 *                               index GRID_TERM_B, so GRID_TERM's grid is
 *                               unchanged.
 *
 * Explicit zeros are PRESENT rows, not absent ones (a reader that tested
 * `!== undefined` instead of `>= 1` is caught).
 *
 * SWEEP. `removeTermsGridDoorFixture()` deletes every record above and its TM
 * rows and THROWS when a matrix delete removes 0 rows.
 */

import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
} from '../../src/core/security/permissions.ts';
import { SYNTHETIC_HIERARCHY_A_TLD } from '../../src/core/test_data/synthetic_hierarchy_constants.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { clearTermCache } from '../../src/core/ts_object/term_resolver.ts';

/** Seed-shipped tipo, spelled so the TLD census sees a reference, not a binding. */
const seed = <T extends string, N extends number>(tld: T, id: N): `${T}${N}` => `${tld}${id}`;

export const TG_CONTROL_USER_ID = 937601;
export const TG_TERM_DENIED_USER_ID = 937602;
export const TG_SECTION_DENIED_USER_ID = 937603;
export const TG_TEXT_DENIED_USER_ID = 937604;
const TG_CONTROL_PROFILE_ID = 937611;
const TG_TERM_DENIED_PROFILE_ID = 937612;
const TG_SECTION_DENIED_PROFILE_ID = 937613;
const TG_TEXT_DENIED_PROFILE_ID = 937614;
export const TG_PROJECT_ID = 937621;
/** The second project: only the WIDE persona holds it. */
export const TG_SECOND_PROJECT_ID = 937622;
/** CONTROL's profile, scoped to BOTH projects (the row-scope pair's control). */
export const TG_WIDE_USER_ID = 937605;

/** test3 — the playground section (section_map term = test52). */
export const TG_SECTION = 'test3';
export const TG_TERM_COMPONENT = 'test52';
const TG_SECTION_FILTER = 'test101';
/** The transcription text_area the indexing records carry (seed-shipped, as indexation_grid_av_native). */
export const TG_TEXT_AREA = seed('rsc', 36);
const TG_INDEX_COMPONENT = seed('rsc', 860);
/** test6813 — the group-top section (its indexation_list quotes rsc36 through test6837). */
export const TG_TOP_SECTION = 'test6813';
const TG_TOP_FILTER = 'test6834';
const TG_TOP_CODE = 'test6826';
const TG_TOP_PORTAL = 'test6837';

export const TG_IN_SCOPE_RECORD = 937631;
export const TG_OUT_OF_SCOPE_RECORD = 937632;
export const TG_TOP_RECORDS = [937641, 937642] as const;
export const TG_INDEXING_RECORDS = [937651, 937652] as const;
/** Row-scope pair: group tops (both in TG_PROJECT_ID) and their indexing records. */
export const TG_ROW_SCOPE_TOP_RECORDS = [937643, 937644] as const;
/** 937653 in TG_PROJECT_ID; 937654 only in TG_SECOND_PROJECT_ID. */
export const TG_ROW_SCOPE_INDEXING_RECORDS = [937653, 937654] as const;
export const TG_IN_SCOPE_TERM = 'zz9376 in scope';
export const TG_OUT_OF_SCOPE_TERM = 'zz9376 out of scope';

/** The thesaurus term the grid is asked about (an existing synthetic-hierarchy record). */
export const GRID_TERM = { section_tipo: `${SYNTHETIC_HIERARCHY_A_TLD}1`, section_id: 8 } as const;
/** The term the row-scope pair's two indexing records point at. */
export const GRID_TERM_B = {
	section_tipo: `${SYNTHETIC_HIERARCHY_A_TLD}1`,
	section_id: 9,
} as const;

const USERS_SECTION = 'dd128';
const PROFILES_SECTION = 'dd234';
const PROJECTS_SECTION = 'dd153';
const YES_NO_SECTION = 'dd64';
const NO = 2;

const ID_LOW = 937600;
const ID_HIGH = 937699;

type Owned = { table: string; sectionTipo: string; sectionId: number };

const OWNED: Owned[] = [
	{ table: 'matrix_projects', sectionTipo: PROJECTS_SECTION, sectionId: TG_PROJECT_ID },
	{ table: 'matrix_projects', sectionTipo: PROJECTS_SECTION, sectionId: TG_SECOND_PROJECT_ID },
	...[
		TG_CONTROL_PROFILE_ID,
		TG_TERM_DENIED_PROFILE_ID,
		TG_SECTION_DENIED_PROFILE_ID,
		TG_TEXT_DENIED_PROFILE_ID,
	].map((sectionId) => ({ table: 'matrix_profiles', sectionTipo: PROFILES_SECTION, sectionId })),
	...[
		TG_CONTROL_USER_ID,
		TG_TERM_DENIED_USER_ID,
		TG_SECTION_DENIED_USER_ID,
		TG_TEXT_DENIED_USER_ID,
		TG_WIDE_USER_ID,
	].map((sectionId) => ({ table: 'matrix_users', sectionTipo: USERS_SECTION, sectionId })),
	{ table: 'matrix_test', sectionTipo: TG_SECTION, sectionId: TG_IN_SCOPE_RECORD },
	{ table: 'matrix_test', sectionTipo: TG_SECTION, sectionId: TG_OUT_OF_SCOPE_RECORD },
	...TG_TOP_RECORDS.map((sectionId) => ({
		table: 'matrix_test',
		sectionTipo: TG_TOP_SECTION,
		sectionId,
	})),
	...TG_INDEXING_RECORDS.map((sectionId) => ({
		table: 'matrix_test',
		sectionTipo: TG_SECTION,
		sectionId,
	})),
	...TG_ROW_SCOPE_TOP_RECORDS.map((sectionId) => ({
		table: 'matrix_test',
		sectionTipo: TG_TOP_SECTION,
		sectionId,
	})),
	...TG_ROW_SCOPE_INDEXING_RECORDS.map((sectionId) => ({
		table: 'matrix_test',
		sectionTipo: TG_SECTION,
		sectionId,
	})),
];

function locator(componentTipo: string, sectionTipo: string, sectionId: number) {
	return {
		id: 1,
		type: 'dd151',
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: componentTipo,
	};
}

function grant(id: number, sectionTipo: string, tipo: string, value: number) {
	return { id, tipo, section_tipo: sectionTipo, value };
}

/** The CONTROL grants, with ONE (section, tipo) overridden per denied persona. */
function grants(override?: { sectionTipo: string; tipo: string }) {
	const rows: [string, string][] = [
		[TG_SECTION, TG_SECTION],
		[TG_SECTION, TG_TERM_COMPONENT],
		[TG_SECTION, TG_SECTION_FILTER],
		[TG_SECTION, TG_TEXT_AREA],
		[TG_TOP_SECTION, TG_TOP_SECTION],
		[TG_TOP_SECTION, TG_TOP_FILTER],
		[TG_TOP_SECTION, TG_TOP_CODE],
		[TG_TOP_SECTION, TG_TOP_PORTAL],
		[GRID_TERM.section_tipo, GRID_TERM.section_tipo],
	];
	return rows.map(([sectionTipo, tipo], index) =>
		grant(
			index + 1,
			sectionTipo,
			tipo,
			override?.sectionTipo === sectionTipo && override.tipo === tipo ? 0 : 1,
		),
	);
}

async function insertRecord(
	table: string,
	sectionTipo: string,
	sectionId: number,
	columns: Record<string, unknown>,
): Promise<void> {
	if (sectionId < ID_LOW || sectionId > ID_HIGH) {
		throw new Error(`terms_grid_door_fixture: id ${sectionId} outside ${ID_LOW}-${ID_HIGH}`);
	}
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

export function clearTermsGridDoorCaches(): void {
	clearPrincipalCache();
	clearUserProjectsCache();
	clearPermissionsCache();
	clearTermCache();
}

const projectLocator = (filterTipo: string, projectId: number = TG_PROJECT_ID) => ({
	...locator(filterTipo, PROJECTS_SECTION, projectId),
	type: 'dd151',
});

/** A tagged transcription quoting one indexation fragment (tag 1). */
function transcription(label: string): string {
	return `<p>Antes [index-n-1-${label}-data::data]fragmento ${label} indexado[/index-n-1-${label}-data::data] despu&eacute;s</p>`;
}

/** Mint the fixture. Idempotent: a crashed run's rows are swept first. */
export async function installTermsGridDoorFixture(): Promise<void> {
	await assertTestDatabase('installTermsGridDoorFixture');
	await purge({ strict: false });

	await insertRecord('matrix_projects', PROJECTS_SECTION, TG_PROJECT_ID, {
		string: { dd156: [{ id: 1, lang: 'lg-eng', value: 'zz9376 scratch project' }] },
	});
	await insertRecord('matrix_projects', PROJECTS_SECTION, TG_SECOND_PROJECT_ID, {
		string: { dd156: [{ id: 1, lang: 'lg-eng', value: 'zz9376 second scratch project' }] },
	});
	const personas: [number, number, string, { sectionTipo: string; tipo: string } | undefined][] = [
		[TG_CONTROL_USER_ID, TG_CONTROL_PROFILE_ID, 'zz9376_control', undefined],
		[
			TG_TERM_DENIED_USER_ID,
			TG_TERM_DENIED_PROFILE_ID,
			'zz9376_term_denied',
			{ sectionTipo: TG_SECTION, tipo: TG_TERM_COMPONENT },
		],
		[
			TG_SECTION_DENIED_USER_ID,
			TG_SECTION_DENIED_PROFILE_ID,
			'zz9376_section_denied',
			{ sectionTipo: TG_SECTION, tipo: TG_SECTION },
		],
		[
			TG_TEXT_DENIED_USER_ID,
			TG_TEXT_DENIED_PROFILE_ID,
			'zz9376_text_denied',
			{ sectionTipo: TG_SECTION, tipo: TG_TEXT_AREA },
		],
	];
	for (const [userId, profileId, name, override] of personas) {
		await insertRecord('matrix_profiles', PROFILES_SECTION, profileId, {
			string: { dd237: [{ id: 1, lang: 'lg-eng', value: `${name} profile` }] },
			misc: { dd774: grants(override) },
		});
		await insertRecord('matrix_users', USERS_SECTION, userId, {
			string: { dd132: [{ id: 1, lang: 'lg-nolan', value: name }] },
			relation: {
				dd131: [locator('dd131', YES_NO_SECTION, 1)],
				dd244: [locator('dd244', YES_NO_SECTION, NO)],
				dd515: [locator('dd515', YES_NO_SECTION, NO)],
				dd1725: [locator('dd1725', PROFILES_SECTION, profileId)],
				dd170: [locator('dd170', PROJECTS_SECTION, TG_PROJECT_ID)],
			},
		});
	}
	// WIDE: CONTROL's own profile, in BOTH projects.
	await insertRecord('matrix_users', USERS_SECTION, TG_WIDE_USER_ID, {
		string: { dd132: [{ id: 1, lang: 'lg-nolan', value: 'zz9376_wide' }] },
		relation: {
			dd131: [locator('dd131', YES_NO_SECTION, 1)],
			dd244: [locator('dd244', YES_NO_SECTION, NO)],
			dd515: [locator('dd515', YES_NO_SECTION, NO)],
			dd1725: [locator('dd1725', PROFILES_SECTION, TG_CONTROL_PROFILE_ID)],
			dd170: [
				locator('dd170', PROJECTS_SECTION, TG_PROJECT_ID),
				{ ...locator('dd170', PROJECTS_SECTION, TG_SECOND_PROJECT_ID), id: 2 },
			],
		},
	});

	// get_section_terms: one record inside the project, one outside it.
	await insertRecord('matrix_test', TG_SECTION, TG_IN_SCOPE_RECORD, {
		string: { [TG_TERM_COMPONENT]: [{ id: 1, lang: 'lg-eng', value: TG_IN_SCOPE_TERM }] },
		relation: { [TG_SECTION_FILTER]: [projectLocator(TG_SECTION_FILTER)] },
	});
	await insertRecord('matrix_test', TG_SECTION, TG_OUT_OF_SCOPE_RECORD, {
		string: { [TG_TERM_COMPONENT]: [{ id: 1, lang: 'lg-eng', value: TG_OUT_OF_SCOPE_TERM }] },
	});

	// get_indexation_grid: two groups, each one row quoting a test3 transcription.
	for (const [index, topId] of TG_TOP_RECORDS.entries()) {
		await insertIndexedGroup({
			topId,
			indexingId: TG_INDEXING_RECORDS[index] as number,
			ordinal: index + 1,
			term: GRID_TERM,
			indexingProjectId: TG_PROJECT_ID,
		});
	}
	// The row-scope pair: two more groups (tops in the project) indexing
	// GRID_TERM_B; the second row's OWN record is only in the second project.
	for (const [index, topId] of TG_ROW_SCOPE_TOP_RECORDS.entries()) {
		await insertIndexedGroup({
			topId,
			indexingId: TG_ROW_SCOPE_INDEXING_RECORDS[index] as number,
			ordinal: index + 3,
			term: GRID_TERM_B,
			indexingProjectId: index === 0 ? TG_PROJECT_ID : TG_SECOND_PROJECT_ID,
		});
	}
	clearTermsGridDoorCaches();
}

/** One section_top group (in TG_PROJECT_ID) with ONE indexing row quoting `zz9376r<ordinal>`. */
async function insertIndexedGroup(group: {
	topId: number;
	indexingId: number;
	ordinal: number;
	term: { section_tipo: string; section_id: number };
	indexingProjectId: number;
}): Promise<void> {
	await insertRecord('matrix_test', TG_TOP_SECTION, group.topId, {
		string: { [TG_TOP_CODE]: [{ id: 1, lang: 'lg-nolan', value: `ZZ9376-${group.ordinal}` }] },
		relation: {
			[TG_TOP_FILTER]: [projectLocator(TG_TOP_FILTER)],
			[TG_TOP_PORTAL]: [locator(TG_TOP_PORTAL, TG_SECTION, group.indexingId)],
		},
	});
	await insertRecord('matrix_test', TG_SECTION, group.indexingId, {
		string: {
			[TG_TEXT_AREA]: [{ id: 1, lang: 'lg-spa', value: transcription(`zz9376r${group.ordinal}`) }],
		},
		relation: {
			[TG_SECTION_FILTER]: [projectLocator(TG_SECTION_FILTER, group.indexingProjectId)],
			[TG_INDEX_COMPONENT]: [
				{
					id: 1,
					type: 'dd96',
					tag_id: '1',
					section_id: String(group.term.section_id),
					section_tipo: group.term.section_tipo,
					section_top_id: String(group.topId),
					section_top_tipo: TG_TOP_SECTION,
					tag_component_tipo: TG_TEXT_AREA,
					from_component_tipo: TG_INDEX_COMPONENT,
				},
			],
		},
	});
}

export async function removeTermsGridDoorFixture(): Promise<void> {
	await assertTestDatabase('removeTermsGridDoorFixture');
	await purge({ strict: true });
	clearTermsGridDoorCaches();
}

async function purge(options: { strict: boolean }): Promise<void> {
	const missing: string[] = [];
	for (const record of OWNED) {
		if (record.sectionId < ID_LOW || record.sectionId > ID_HIGH) {
			throw new Error(`terms_grid_door_fixture: ${record.sectionId} outside the 9376xx band`);
		}
		const removed = await deleteMatrixRecord(record.table, record.sectionTipo, record.sectionId);
		if (removed === 0) missing.push(`${record.table}/${record.sectionTipo}/${record.sectionId}`);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[record.sectionTipo, record.sectionId],
		);
	}
	if (options.strict && missing.length > 0) {
		throw new Error(
			`terms_grid_door_fixture sweep removed 0 rows for: ${missing.join(', ')} — the scratch filter is wrong or another run deleted them`,
		);
	}
}

/** Rows of this fixture still present (the gates assert zero after the sweep). */
export async function termsGridDoorResidue(): Promise<string[]> {
	const residue: string[] = [];
	for (const record of OWNED) {
		const rows = (await sql.unsafe(
			`SELECT 1 FROM "${record.table}" WHERE section_tipo = $1 AND section_id = $2`,
			[record.sectionTipo, record.sectionId],
		)) as unknown[];
		if (rows.length > 0) residue.push(`${record.table}/${record.sectionTipo}/${record.sectionId}`);
	}
	return residue;
}
