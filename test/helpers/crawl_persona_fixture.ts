/**
 * THE FEATURE-CRAWL PERSONAS (scripts/feature_crawl.ts).
 *
 * Two non-root identities the crawler walks the application as, beside root:
 *
 *   948001  matrix_users     ADMIN  dd244 Yes — global admin, NOT developer, NOT
 *                                   root: still bound by its dd774 grants
 *   948002  matrix_users     EDITOR dd244 No — scoped to project A only
 *   948011  matrix_profiles  admin profile: CRAWL_EDIT_SECTION + every component 3
 *   948012  matrix_profiles  editor profile:
 *                              CRAWL_EDIT_SECTION 2, every component 2 except
 *                              CRAWL_READONLY_COMPONENT 1 and CRAWL_HIDDEN_COMPONENT
 *                              (no row = 0); CRAWL_READ_SECTION + its components 1;
 *                              CRAWL_CREATE_SECTION + its components 2;
 *                              CRAWL_DENIED_SECTION not granted at all
 *   948021 / 948022 matrix_projects  project A (editor's) / project B (not)
 *   948101 / 948102 matrix_test      CRAWL_EDIT_SECTION records in project A / B
 *
 * Ids explicit, swept by (section_tipo, section_id) as acl_identity_fixture.ts
 * does — no counter touched. Every level the crawler EXPECTS is read back through
 * the real doors (getPermissions, isRecordInScope), never from these constants:
 * the constants only shape the situation.
 */

import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getSectionRealTipo } from '../../src/core/ontology/resolver.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { clearAclIdentityCaches, resolveAclGrantedToolRegistryId } from './acl_identity_fixture.ts';

export const CRAWL_ADMIN_USER_ID = 948001;
export const CRAWL_EDITOR_USER_ID = 948002;
export const CRAWL_ADMIN_USERNAME = 'zzcrawl_admin';
export const CRAWL_EDITOR_USERNAME = 'zzcrawl_editor';
const ADMIN_PROFILE_ID = 948011;
const EDITOR_PROFILE_ID = 948012;
export const CRAWL_PROJECT_A = 948021;
export const CRAWL_PROJECT_B = 948022;
export const CRAWL_RECORD_IN_A = 948101;
export const CRAWL_RECORD_IN_B = 948102;

/** The playground section: every component model lives here. */
export const CRAWL_EDIT_SECTION = 'test3';
/** Granted level 1 on the editor profile (test3's first component_text_area). */
export const CRAWL_READONLY_COMPONENT = 'test17';
/** Never granted on the editor profile (test3's component_select). */
export const CRAWL_HIDDEN_COMPONENT = 'test91';
/** A thesaurus section with records, granted read-only (level 1) to the editor. */
export const CRAWL_READ_SECTION = 'testplace0';
/**
 * A section the editor CREATES in (level 2). Not test3: test3 is excluded from
 * the birth project default (record_defaults.ts FILTER_EXCLUDED_SECTIONS).
 */
export const CRAWL_CREATE_SECTION = 'test1001';
/** CRAWL_CREATE_SECTION's component_filter. */
export const CRAWL_CREATE_FILTER = 'test1005';
/** A section with a record the editor holds NO grant on. */
export const CRAWL_DENIED_SECTION = 'test480';
/** test3's component_filter (the project assignment). */
export const CRAWL_FILTER_COMPONENT = 'test101';
/** test3's component_input_text on the edit form (test45; test162 sits in a hidden box). */
export const CRAWL_TEXT_COMPONENT = 'test52';
const EDIT_SECTION_FILTER = CRAWL_FILTER_COMPONENT;

const OWNED: { table: string; sectionTipo: string; sectionId: number }[] = [
	{ table: 'matrix_users', sectionTipo: 'dd128', sectionId: CRAWL_ADMIN_USER_ID },
	{ table: 'matrix_users', sectionTipo: 'dd128', sectionId: CRAWL_EDITOR_USER_ID },
	{ table: 'matrix_profiles', sectionTipo: 'dd234', sectionId: ADMIN_PROFILE_ID },
	{ table: 'matrix_profiles', sectionTipo: 'dd234', sectionId: EDITOR_PROFILE_ID },
	{ table: 'matrix_projects', sectionTipo: 'dd153', sectionId: CRAWL_PROJECT_A },
	{ table: 'matrix_projects', sectionTipo: 'dd153', sectionId: CRAWL_PROJECT_B },
	{ table: 'matrix_test', sectionTipo: CRAWL_EDIT_SECTION, sectionId: CRAWL_RECORD_IN_A },
	{ table: 'matrix_test', sectionTipo: CRAWL_EDIT_SECTION, sectionId: CRAWL_RECORD_IN_B },
];

const locator = (from: string, sectionTipo: string, sectionId: number) => ({
	id: 1,
	type: 'dd151',
	section_id: sectionId,
	section_tipo: sectionTipo,
	from_component_tipo: from,
});
const text = (tipo: string, value: string, lang = 'lg-eng') => ({
	[tipo]: [{ id: 1, lang, value }],
});

async function insert(
	table: string,
	sectionTipo: string,
	sectionId: number,
	columns: Record<string, unknown>,
): Promise<void> {
	const names = ['"section_tipo"', '"section_id"'];
	const marks = ['$1', '$2'];
	const params: (string | number)[] = [sectionTipo, sectionId];
	for (const [column, value] of Object.entries(columns)) {
		names.push(`"${column}"`);
		marks.push(`$${params.length + 1}::text::jsonb`);
		params.push(encodeForJsonb(value));
	}
	await sql.unsafe(
		`INSERT INTO "${table}" (${names.join(', ')}) VALUES (${marks.join(', ')})`,
		params,
	);
}

/**
 * Every grantable tipo under a section, as component_security_access lists them
 * (components, buttons, relation_list, groupers…; virtual sections read their real one).
 */
async function componentTipos(sectionTipo: string): Promise<string[]> {
	const real = await getSectionRealTipo(sectionTipo);
	const rows = (await sql.unsafe(
		`WITH RECURSIVE t AS (SELECT tipo, model FROM dd_ontology WHERE parent = $1
		 UNION ALL SELECT o.tipo, o.model FROM dd_ontology o JOIN t ON o.parent = t.tipo)
		 SELECT tipo FROM t ORDER BY tipo`,
		[real],
	)) as { tipo: string }[];
	return rows.map((r) => r.tipo);
}

/** The section's ancestor areas: a real profile grants the path, or the menu cannot reach it. */
async function ancestorAreas(sectionTipo: string): Promise<string[]> {
	const rows = (await sql.unsafe(
		`WITH RECURSIVE a AS (SELECT parent FROM dd_ontology WHERE tipo = $1
		 UNION ALL SELECT o.parent FROM dd_ontology o JOIN a ON o.tipo = a.parent)
		 SELECT parent AS tipo FROM a WHERE parent IS NOT NULL`,
		[sectionTipo],
	)) as { tipo: string }[];
	return rows.map((r) => r.tipo);
}

type Grant = { tipo: string; section_tipo: string; value: number };
const grantRows = (grants: Grant[]) => grants.map((g, i) => ({ id: i + 1, ...g }));

export async function installCrawlPersonaFixture(): Promise<void> {
	await assertTestDatabase('installCrawlPersonaFixture');
	const toolRegistryId = await resolveAclGrantedToolRegistryId();
	await purge(false);

	const editComponents = await componentTipos(CRAWL_EDIT_SECTION);
	const readComponents = await componentTipos(CRAWL_READ_SECTION);
	const createComponents = await componentTipos(CRAWL_CREATE_SECTION);
	if (editComponents.length === 0 || readComponents.length === 0)
		throw new Error(
			`crawl_persona_fixture: ${CRAWL_EDIT_SECTION}/${CRAWL_READ_SECTION} have no components on this database — run 'bun run test:db:setup'`,
		);

	await insert('matrix_projects', 'dd153', CRAWL_PROJECT_A, {
		string: text('dd156', 'zzcrawl project A'),
	});
	await insert('matrix_projects', 'dd153', CRAWL_PROJECT_B, {
		string: text('dd156', 'zzcrawl project B'),
	});

	const areas = [
		...new Set([
			...(await ancestorAreas(CRAWL_EDIT_SECTION)),
			...(await ancestorAreas(CRAWL_READ_SECTION)),
			...(await ancestorAreas(CRAWL_CREATE_SECTION)),
		]),
	].map((tipo) => ({ tipo, section_tipo: tipo, value: 2 }));
	const adminGrants: Grant[] = [
		...areas,
		{ tipo: CRAWL_EDIT_SECTION, section_tipo: CRAWL_EDIT_SECTION, value: 3 },
		...editComponents.map((tipo) => ({ tipo, section_tipo: CRAWL_EDIT_SECTION, value: 3 })),
		{ tipo: CRAWL_READ_SECTION, section_tipo: CRAWL_READ_SECTION, value: 3 },
		...readComponents.map((tipo) => ({ tipo, section_tipo: CRAWL_READ_SECTION, value: 3 })),
		{ tipo: CRAWL_CREATE_SECTION, section_tipo: CRAWL_CREATE_SECTION, value: 2 },
		...createComponents.map((tipo) => ({ tipo, section_tipo: CRAWL_CREATE_SECTION, value: 2 })),
	];
	const editorGrants: Grant[] = [
		...areas,
		{ tipo: CRAWL_EDIT_SECTION, section_tipo: CRAWL_EDIT_SECTION, value: 2 },
		...editComponents
			.filter((tipo) => tipo !== CRAWL_HIDDEN_COMPONENT)
			.map((tipo) => ({
				tipo,
				section_tipo: CRAWL_EDIT_SECTION,
				value: tipo === CRAWL_READONLY_COMPONENT ? 1 : 2,
			})),
		{ tipo: CRAWL_READ_SECTION, section_tipo: CRAWL_READ_SECTION, value: 1 },
		...readComponents.map((tipo) => ({ tipo, section_tipo: CRAWL_READ_SECTION, value: 1 })),
		{ tipo: CRAWL_CREATE_SECTION, section_tipo: CRAWL_CREATE_SECTION, value: 2 },
		...createComponents.map((tipo) => ({ tipo, section_tipo: CRAWL_CREATE_SECTION, value: 2 })),
	];
	await insert('matrix_profiles', 'dd234', ADMIN_PROFILE_ID, {
		string: text('dd237', 'zzcrawl admin profile'),
		relation: { dd1067: [locator('dd1067', 'dd1324', toolRegistryId)] },
		misc: { dd774: grantRows(adminGrants) },
	});
	await insert('matrix_profiles', 'dd234', EDITOR_PROFILE_ID, {
		string: text('dd237', 'zzcrawl editor profile'),
		relation: { dd1067: [locator('dd1067', 'dd1324', toolRegistryId)] },
		misc: { dd774: grantRows(editorGrants) },
	});

	await insert('matrix_users', 'dd128', CRAWL_ADMIN_USER_ID, {
		string: text('dd132', CRAWL_ADMIN_USERNAME, 'lg-nolan'),
		relation: {
			dd131: [locator('dd131', 'dd64', 1)],
			dd244: [locator('dd244', 'dd64', 1)],
			dd515: [locator('dd515', 'dd64', 2)],
			dd1725: [locator('dd1725', 'dd234', ADMIN_PROFILE_ID)],
		},
	});
	await insert('matrix_users', 'dd128', CRAWL_EDITOR_USER_ID, {
		string: text('dd132', CRAWL_EDITOR_USERNAME, 'lg-nolan'),
		relation: {
			dd131: [locator('dd131', 'dd64', 1)],
			dd244: [locator('dd244', 'dd64', 2)],
			dd515: [locator('dd515', 'dd64', 2)],
			dd1725: [locator('dd1725', 'dd234', EDITOR_PROFILE_ID)],
			dd170: [locator('dd170', 'dd153', CRAWL_PROJECT_A)],
		},
	});

	for (const [id, project] of [
		[CRAWL_RECORD_IN_A, CRAWL_PROJECT_A],
		[CRAWL_RECORD_IN_B, CRAWL_PROJECT_B],
	] as const) {
		await insert('matrix_test', CRAWL_EDIT_SECTION, id, {
			string: text(CRAWL_TEXT_COMPONENT, `zzcrawl record ${id}`),
			relation: {
				[EDIT_SECTION_FILTER]: [
					{ ...locator(EDIT_SECTION_FILTER, 'dd153', project), type: 'dd675' },
				],
			},
		});
	}
	clearAclIdentityCaches();
}

export async function removeCrawlPersonaFixture(): Promise<void> {
	await assertTestDatabase('removeCrawlPersonaFixture');
	await purge(true);
	clearAclIdentityCaches();
}

async function purge(strict: boolean): Promise<void> {
	const missing: string[] = [];
	for (const r of OWNED) {
		if (r.sectionId < 900000)
			throw new Error(`crawl_persona_fixture: ${r.sectionId} below scratch floor`);
		if ((await deleteMatrixRecord(r.table, r.sectionTipo, r.sectionId)) === 0)
			missing.push(`${r.table}/${r.sectionTipo}/${r.sectionId}`);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[r.sectionTipo, r.sectionId],
		);
	}
	if (strict && missing.length > 0)
		throw new Error(`crawl_persona_fixture sweep removed 0 rows for: ${missing.join(', ')}`);
}

/** A record a journey created (it may already be gone): its row and its time-machine rows. */
export async function sweepCrawlRecord(
	table: string,
	sectionTipo: string,
	sectionId: number,
): Promise<void> {
	await assertTestDatabase('sweepCrawlRecord');
	await deleteMatrixRecord(table, sectionTipo, sectionId);
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2', [
		sectionTipo,
		sectionId,
	]);
}
