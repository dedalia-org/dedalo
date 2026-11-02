/**
 * MULTI-HOP SEARCH PATH ACL — the SEC-02 gate (audit 2026-08-26, item P1-1).
 *
 * WHAT WAS WRONG. A search filter (or ORDER) leaf whose `path` has more than
 * one step makes the assembler emit, per hop, a `LEFT JOIN LATERAL
 * jsonb_array_elements(<prev>.relation->'<hopTipo>')` plus a `LEFT JOIN
 * <stepTable>`, and it builds the leaf predicate against the LAST alias.
 * Neither `conformLeaf` nor `buildJoinChain` received a principal, and
 * `buildSearchSql` emitted its ACL clauses — the projects containment and the
 * dd478 record filter — against the MAIN alias ONLY. So the WHERE clause of a
 * listing the caller IS allowed to run could name a component of a record the
 * caller is NOT allowed to see, and the row's presence answered a question
 * about that hidden record. Begins-with, ends-with, contains and `==` are all
 * reachable through the string builder, which makes it a PREFIX ORACLE: the
 * hidden value comes out character by character.
 *
 * WHAT THIS GATE PROVES, in the two halves the finding demands:
 *
 *  (a) STRUCTURAL CENSUS — TOTAL over the join aliases the builder emits. The
 *      SQL is PARSED: every `LEFT JOIN <table> AS j_… ON …` is found, its ON
 *      clause is isolated, and an alias whose ON clause carries no
 *      `<alias>.relation @> …` project containment is RED. A count assertion
 *      alone would pass on zero aliases, so the alias count is asserted too,
 *      at one hop AND at two.
 *  (b) BEHAVIOURAL — the oracle itself. A scoped non-admin probes a value
 *      stored on a record of a project she does not hold. HIT and MISS must be
 *      byte-identical answers. Non-degeneracy is proved in the same test: the
 *      admin running the SAME hit query DOES get the row, so the value really
 *      is there and the equality is not vacuous.
 *
 * AND THE OTHER DIRECTION, which is half the point: an over-eager refusal here
 * would break ordinary searching for every user. So this file also pins that
 *   - the same non-admin's hop into a record IN HER OWN project still returns
 *     it (legitimate multi-hop traffic is untouched),
 *   - an INTERNAL search (no principal) emits a join with NO ACL conjuncts —
 *     byte-identical to the pre-fix shape,
 *   - a global admin's hop carries no projects predicate.
 *
 * THE COMPONENT HALF. A path step beyond the main section also needs the
 * caller's per-component read grant (`ddoIsAuthorized(principal, step.section,
 * step.component)`) — the same predicate `filterAuthorizedRelated` runs when it
 * decides which of a target section's components may enter a portal's ddo_map,
 * i.e. the gate that decides whether a client can legitimately BUILD this path.
 * An unauthorized leaf answers `1=0`: not a throw (a refusal is itself a signal,
 * and it would break the one unauthorized leaf of an autocomplete's `$or`
 * filter_free for every user) and not a drop (dropping a conjunct WIDENS an
 * `$and`).
 *
 * THE SITUATION IS BUILT, NEVER ASSUMED (AGENTS.md): this file mints its own
 * user / profile / projects / records in the reserved band 931000-931099 on the
 * generic `test` TLD, with the grants it needs and no others, and sweeps them
 * in afterAll with a throw-if-nothing-deleted. It does NOT reuse
 * acl_identity_fixture: that fixture's reader profile grants `test3.test92`
 * (a component_publication) and nothing else on test3, so neither the hop
 * component nor a searchable leaf component would be authorized and every
 * assertion here would be satisfiable at empty-versus-empty.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sanitizeClientSqo } from '../../src/core/concepts/sqo.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { clearUserFilterRecordsCache } from '../../src/core/security/filter_records.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
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
import { DB_READY } from '../helpers/db_ready.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

// --- the situation ---------------------------------------------------------

/** The reserved scratch band this file owns (SEC-02 gate). */
const SCRATCH_FLOOR = 931000;
const SCRATCH_CEILING = 931099;

const USERS_SECTION = 'dd128';
const PROFILES_SECTION = 'dd234';
const PROJECTS_SECTION = 'dd153';
const YES_NO_SECTION = 'dd64';

/** The playground section: project-gated by `test101`, table `matrix_test`. */
const SECTION = 'test3';
const SECTION_TABLE = 'matrix_test';
/** test3's component_filter — the tipo the projects containment probes, and
 * the column whose ENGINE-MINTED sort path hops into the projects section
 * (PHP component_filter::get_order_path). */
const FILTER_COMPONENT = 'test101';
/** component_relation_related — the HOP: it stores the locator we traverse. */
const HOP_COMPONENT = 'test54';
// "created by user" — on every section, configured target dd128 (the users section).
const USERS_HOP = 'dd200';
/** component_input_text — the LEAF whose value the oracle used to extract. */
const LEAF_COMPONENT = 'test52';
/** A component of the same section the profile grants NOTHING on. */
const DENIED_LEAF_COMPONENT = 'test91';
/** test91 is a component_select: its q is a LOCATOR (a text q is refused,
 * request.invalid — the builder no longer drops it quietly). */
const DENIED_LEAF_Q = JSON.stringify({ section_tipo: 'test3', section_id: 1 });
/** lg1 / hierarchy25 — component_select_lang's engine-minted sort target. */
const LANGS_SECTION = 'lg1';
const THESAURUS_TERM = 'hierarchy25';

const SCOPED_USER_ID = 931001;
const ADMIN_USER_ID = 931002;
/** SEC-1's READ FLOOR user: the portal source granted, its target field NOT. */
const FLOOR_USER_ID = 931003;
const SCOPED_PROFILE_ID = 931011;
const ADMIN_PROFILE_ID = 931012;
const FLOOR_PROFILE_ID = 931013;
/** test3's own component_portal → test3, whose show/search ddo_map names test52. */
const FLOOR_SOURCE_PORTAL = 'test80';
/** A zz portal → test3 whose request_config names test162 ONLY in its fixed_filter. */
const FLOOR_FIXED_FILTER_SOURCE = 'zzfloor1';
/** A zz portal → test3 whose request_config names test162 ONLY in its filter_by_list. */
const FLOOR_FILTER_BY_LIST_SOURCE = 'zzfloor2';
/** The same filter_by_list source, but a child of test65 — NOT a component of test3. */
const FLOOR_FOREIGN_SOURCE = 'zzfloor3';
/** The same filter_by_list source, a member of dd655 (every principal holds 2 there by rule). */
const FLOOR_PRESET_SOURCE = 'zzfloor4';
/** The same filter_by_list source, a member of dd1324 (every principal holds 1 there by rule). */
const FLOOR_TOOLS_SOURCE = 'zzfloor5';
/**
 * A zz portal → test3 with NO request_config: its IMPLICIT config's ddo is
 * test162 — which the implicit builder drops per user (filterAuthorizedRelated).
 */
const FLOOR_IMPLICIT_SOURCE = 'zzfloor6';
/** The one project the scoped user holds. */
const MY_PROJECT_ID = 931021;
/** A project she does NOT hold — the hidden record's project. */
const OTHER_PROJECT_ID = 931022;

/** test3 record the scoped user MAY list; it hops to {@link HIDDEN_ID}. */
const MAIN_TO_HIDDEN_ID = 931031;
/** test3 record in OTHER_PROJECT_ID holding the value she may not read. */
const HIDDEN_ID = 931032;
/** test3 record she MAY list; it hops to {@link VISIBLE_ID}. */
const MAIN_TO_VISIBLE_ID = 931033;
/** test3 record in HER OWN project — the legitimate-traffic control. */
const VISIBLE_ID = 931034;
/**
 * SEC-1's MULTI-MAIN sibling: a test65 record in HER project carrying the same
 * hidden-on-test3 values (test162 = ROOT_ALPHA, test91 → dd64/1). test65 GRANTS
 * both to her, so an SQO over [test3, test65] is the "some mains grant the
 * root" case: the predicate must hold on THIS row and on no test3 row.
 */
const SIBLING_ID = 931035;

/** The value on the record she cannot read. Never shares a prefix with… */
const HIDDEN_VALUE = 'zzhop02 hidden heritage note';
/** …the value on the record she CAN read. */
const VISIBLE_VALUE = 'zzhop02 visible heritage note';

const SCOPED: Principal = { userId: SCOPED_USER_ID, isGlobalAdmin: false, isDeveloper: false };
const ADMIN: Principal = { userId: ADMIN_USER_ID, isGlobalAdmin: true, isDeveloper: false };
const FLOOR_USER: Principal = { userId: FLOOR_USER_ID, isGlobalAdmin: false, isDeveloper: false };

/** Every (table, section_tipo, section_id) this file owns, in sweep order. */
const OWNED: { table: string; sectionTipo: string; sectionId: number }[] = [
	{ table: 'matrix_users', sectionTipo: USERS_SECTION, sectionId: SCOPED_USER_ID },
	{ table: 'matrix_users', sectionTipo: USERS_SECTION, sectionId: ADMIN_USER_ID },
	{ table: 'matrix_users', sectionTipo: USERS_SECTION, sectionId: FLOOR_USER_ID },
	{ table: 'matrix_profiles', sectionTipo: PROFILES_SECTION, sectionId: SCOPED_PROFILE_ID },
	{ table: 'matrix_profiles', sectionTipo: PROFILES_SECTION, sectionId: ADMIN_PROFILE_ID },
	{ table: 'matrix_profiles', sectionTipo: PROFILES_SECTION, sectionId: FLOOR_PROFILE_ID },
	{ table: 'matrix_projects', sectionTipo: PROJECTS_SECTION, sectionId: MY_PROJECT_ID },
	{ table: 'matrix_projects', sectionTipo: PROJECTS_SECTION, sectionId: OTHER_PROJECT_ID },
	{ table: SECTION_TABLE, sectionTipo: SECTION, sectionId: MAIN_TO_HIDDEN_ID },
	{ table: SECTION_TABLE, sectionTipo: SECTION, sectionId: HIDDEN_ID },
	{ table: SECTION_TABLE, sectionTipo: SECTION, sectionId: MAIN_TO_VISIBLE_ID },
	{ table: SECTION_TABLE, sectionTipo: SECTION, sectionId: VISIBLE_ID },
	{ table: SECTION_TABLE, sectionTipo: 'test65', sectionId: SIBLING_ID },
];

/**
 * The scratch band, ENFORCED before any INSERT or DELETE runs. The sweep
 * deletes by (section_tipo, section_id) on the SHARED suite database, so an id
 * edited down into the installed band would destroy a real users/profiles/
 * projects/test3 record (this is not hypothetical — see the same guard's
 * docblock in acl_identity_fixture.ts).
 */
function assertScratchIds(): void {
	for (const record of OWNED) {
		if (
			!Number.isInteger(record.sectionId) ||
			record.sectionId < SCRATCH_FLOOR ||
			record.sectionId > SCRATCH_CEILING
		) {
			throw new Error(
				`search_path_acl gate: ${record.table}/${record.sectionTipo} id ${record.sectionId} is outside the reserved band ${SCRATCH_FLOOR}-${SCRATCH_CEILING} — refusing to touch a record this gate does not own`,
			);
		}
	}
}

/** A locator as the live records carry it. */
function locator(componentTipo: string, sectionTipo: string, sectionId: number, type = 'dd151') {
	return {
		id: 1,
		type,
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: componentTipo,
	};
}

/** Insert one record at an EXPLICIT section_id — no counter, no advisory lock. */
async function insertScratch(
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
	clearUserFilterRecordsCache();
}

/** One dd774 grant row as getPermissionsTable reads it off `misc`. */
function grant(id: number, sectionTipo: string, tipo: string, value: number) {
	return { id, tipo, section_tipo: sectionTipo, value };
}

async function purge(strict: boolean): Promise<void> {
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
	if (strict && missing.length > 0) {
		throw new Error(
			`search_path_acl gate: the sweep deleted NOTHING for ${missing.join(', ')} — a filter that matches nothing is the bug, not a clean tree`,
		);
	}
}

/** The relation-column component tipos of a section's own subtree (grants for them). */
async function relationComponentTiposOf(sectionTipo: string): Promise<string[]> {
	const { getOrderedSubtree, getColumnNameByModel } = await import(
		'../../src/core/ontology/resolver.ts'
	);
	return (await getOrderedSubtree(sectionTipo))
		.filter(
			(node) =>
				typeof node.model === 'string' &&
				node.model.startsWith('component_') &&
				getColumnNameByModel(node.model) === 'relation',
		)
		.map((node) => node.tipo);
}

async function install(): Promise<void> {
	await assertTestDatabase('search_path_acl_native');
	assertScratchIds();
	await purge(false); // a crashed previous run

	for (const projectId of [MY_PROJECT_ID, OTHER_PROJECT_ID]) {
		await insertScratch('matrix_projects', PROJECTS_SECTION, projectId, {
			string: { dd156: [{ id: 1, lang: 'lg-eng', value: `zzhop02 project ${projectId}` }] },
		});
	}

	// The scoped profile grants EXACTLY what a legitimate multi-hop needs: the
	// section, the hop component and the leaf component — and nothing on
	// DENIED_LEAF_COMPONENT, so "granted" can be told from "the gate never ran".
	// The component_filter (FILTER_COMPONENT) is granted too: its engine-minted
	// ORDER path is only reachable from a column the profile can SEE — and since
	// closure Step 3 (SEC-1) the ROOT step of a path is keyed like every hop, so a
	// profile holding 0 on it has its sort dropped, by design.
	await insertScratch('matrix_profiles', PROFILES_SECTION, SCOPED_PROFILE_ID, {
		string: { dd237: [{ id: 1, lang: 'lg-eng', value: 'zzhop02 scoped profile' }] },
		misc: {
			dd774: [
				grant(1, SECTION, SECTION, 1),
				grant(2, SECTION, HOP_COMPONENT, 1),
				grant(3, SECTION, LEAF_COMPONENT, 1),
				grant(4, SECTION, FILTER_COMPONENT, 1),
				// SEC-1's "granted sibling" spoof: test162 is readable HERE, never on test3.
				grant(5, SPOOF_GRANTED_SECTION, ROOT_HIDDEN_LEAF, 1),
				// SEC-1's MULTI-MAIN sibling: test65 itself, test91 (explicit relation
				// leaf) and EVERY relation component of test65 (so "any component" is
				// unrestricted there — the absent-from_component leaf's granted main).
				grant(6, SPOOF_GRANTED_SECTION, SPOOF_GRANTED_SECTION, 1),
				grant(7, SPOOF_GRANTED_SECTION, 'test91', 1),
				// …and the relation leaf's PATH component (test54) on both mains, so its
				// root verdict is "all" and only the per-section from_component key
				// decides — the row binding under test, isolated from the root one.
				grant(8, SPOOF_GRANTED_SECTION, HOP_COMPONENT, 1),
				...(await relationComponentTiposOf(SPOOF_GRANTED_SECTION)).map((tipo, index) =>
					grant(9 + index, SPOOF_GRANTED_SECTION, tipo, 1),
				),
				// SEC-1's VIRTUAL main (zzvmain1 → test3): the section, the relation
				// leaf's path component and the filter — NOT test91, which the virtual
				// carries only through its REAL section.
				grant(200, VIRTUAL_MAIN, VIRTUAL_MAIN, 1),
				grant(201, VIRTUAL_MAIN, HOP_COMPONENT, 1),
				grant(202, VIRTUAL_MAIN, FILTER_COMPONENT, 1),
			],
		},
	});
	await insertScratch('matrix_profiles', PROFILES_SECTION, ADMIN_PROFILE_ID, {
		string: { dd237: [{ id: 1, lang: 'lg-eng', value: 'zzhop02 admin profile' }] },
		misc: {
			dd774: [
				grant(1, SECTION, SECTION, 3),
				grant(2, SECTION, HOP_COMPONENT, 3),
				grant(3, SECTION, LEAF_COMPONENT, 3),
				grant(4, SECTION, FILTER_COMPONENT, 3),
			],
		},
	});

	// The READ FLOOR profile (SEC-1): the section, its component_filter and the
	// PORTAL test80 — and NOTHING on test52, the field test80's request_config
	// names. What she may search through the portal is the floor's to decide.
	await insertScratch('matrix_profiles', PROFILES_SECTION, FLOOR_PROFILE_ID, {
		string: { dd237: [{ id: 1, lang: 'lg-eng', value: 'zzhop02 floor profile' }] },
		misc: {
			dd774: [
				grant(1, SECTION, SECTION, 1),
				grant(2, SECTION, FILTER_COMPONENT, 1),
				grant(3, SECTION, FLOOR_SOURCE_PORTAL, 1),
				// The zzfloor sources (fixed_filter / filter_by_list on test162).
				grant(4, SECTION, FLOOR_FIXED_FILTER_SOURCE, 1),
				grant(5, SECTION, FLOOR_FILTER_BY_LIST_SOURCE, 1),
				// A STRAY matrix pair: zzfloor3 is not a component of test3. The matrix is
				// data — a floor must not trust it to describe the ontology.
				grant(6, SECTION, FLOOR_FOREIGN_SOURCE, 1),
				// The VIRTUAL control: zzvmain1 borrows test3's children, so zzfloor2
				// legitimately belongs to it (membership resolves the virtual side).
				grant(7, VIRTUAL_MAIN, VIRTUAL_MAIN, 1),
				grant(8, VIRTUAL_MAIN, FLOOR_FILTER_BY_LIST_SOURCE, 1),
				// zzfloor3 on its OWN section test65 — but NOT test65 itself: the read
				// door's pair wants the section grant too.
				grant(9, SPOOF_GRANTED_SECTION, FLOOR_FOREIGN_SOURCE, 1),
				// The IMPLICIT source (no request_config; relations test3 + test162).
				grant(10, SECTION, FLOOR_IMPLICIT_SOURCE, 1),
			],
		},
	});
	await insertScratch('matrix_users', USERS_SECTION, FLOOR_USER_ID, {
		string: { dd132: [{ id: 1, lang: 'lg-nolan', value: 'zzhop02_floor' }] },
		relation: {
			dd131: [locator('dd131', YES_NO_SECTION, 1)],
			dd244: [locator('dd244', YES_NO_SECTION, 2)],
			dd515: [locator('dd515', YES_NO_SECTION, 2)],
			dd1725: [locator('dd1725', PROFILES_SECTION, FLOOR_PROFILE_ID)],
			dd170: [locator('dd170', PROJECTS_SECTION, MY_PROJECT_ID)],
		},
	});
	await insertScratch('matrix_users', USERS_SECTION, SCOPED_USER_ID, {
		string: { dd132: [{ id: 1, lang: 'lg-nolan', value: 'zzhop02_scoped' }] },
		relation: {
			dd131: [locator('dd131', YES_NO_SECTION, 1)],
			dd244: [locator('dd244', YES_NO_SECTION, 2)], // present-but-negative admin flag
			dd515: [locator('dd515', YES_NO_SECTION, 2)],
			dd1725: [locator('dd1725', PROFILES_SECTION, SCOPED_PROFILE_ID)],
			dd170: [locator('dd170', PROJECTS_SECTION, MY_PROJECT_ID)],
		},
	});
	await insertScratch('matrix_users', USERS_SECTION, ADMIN_USER_ID, {
		string: { dd132: [{ id: 1, lang: 'lg-nolan', value: 'zzhop02_admin' }] },
		relation: {
			dd131: [locator('dd131', YES_NO_SECTION, 1)],
			dd244: [locator('dd244', YES_NO_SECTION, 1)],
			dd515: [locator('dd515', YES_NO_SECTION, 2)],
			dd1725: [locator('dd1725', PROFILES_SECTION, ADMIN_PROFILE_ID)],
			dd170: [locator('dd170', PROJECTS_SECTION, MY_PROJECT_ID)],
		},
	});

	// The four test3 records. The `test101` locator is the project membership the
	// projects containment probes; `type` is dd675 exactly as the live rows carry
	// it (the predicate matches on section_id alone — see
	// WC-2026-08-09-users-section-record-scope).
	const inProject = (projectId: number) => [
		locator(FILTER_COMPONENT, PROJECTS_SECTION, projectId, 'dd675'),
	];
	await insertScratch(SECTION_TABLE, SECTION, MAIN_TO_HIDDEN_ID, {
		relation: {
			[FILTER_COMPONENT]: inProject(MY_PROJECT_ID),
			[HOP_COMPONENT]: [locator(HOP_COMPONENT, SECTION, HIDDEN_ID)],
		},
		string: { [LEAF_COMPONENT]: [{ id: 1, lang: 'lg-eng', value: 'zzhop02 main to hidden' }] },
	});
	await insertScratch(SECTION_TABLE, SECTION, HIDDEN_ID, {
		relation: { [FILTER_COMPONENT]: inProject(OTHER_PROJECT_ID) },
		string: { [LEAF_COMPONENT]: [{ id: 1, lang: 'lg-eng', value: HIDDEN_VALUE }] },
	});
	await insertScratch(SECTION_TABLE, SECTION, MAIN_TO_VISIBLE_ID, {
		relation: {
			[FILTER_COMPONENT]: inProject(MY_PROJECT_ID),
			[HOP_COMPONENT]: [locator(HOP_COMPONENT, SECTION, VISIBLE_ID)],
		},
		string: { [LEAF_COMPONENT]: [{ id: 1, lang: 'lg-eng', value: 'zzhop02 main to visible' }] },
	});
	await insertScratch(SECTION_TABLE, SECTION, VISIBLE_ID, {
		relation: { [FILTER_COMPONENT]: inProject(MY_PROJECT_ID) },
		string: { [LEAF_COMPONENT]: [{ id: 1, lang: 'lg-eng', value: VISIBLE_VALUE }] },
	});
	// The MULTI-MAIN sibling (test65; its component_filter is test151).
	await insertScratch(SECTION_TABLE, 'test65', SIBLING_ID, {
		relation: {
			test151: [locator('test151', PROJECTS_SECTION, MY_PROJECT_ID, 'dd675')],
			test91: [locator('test91', 'dd64', 1)],
		},
		// test162 is non-translatable: the engine stores it under lg-nolan.
		string: { test162: [{ id: 1, lang: 'lg-nolan', value: 'zzroot alpha heritage' }] },
	});

	clearCaches();
}

// --- the query shapes ------------------------------------------------------

/** A two-hop filter: SECTION.HOP → SECTION.<leaf> begins-with `q`. */
function twoHopSqo(q: string, leafComponent: string = LEAF_COMPONENT) {
	return sanitizeClientSqo({
		section_tipo: [SECTION],
		limit: 50,
		offset: 0,
		filter: {
			$and: [
				{
					q,
					path: [
						{ section_tipo: SECTION, component_tipo: HOP_COMPONENT },
						{ section_tipo: SECTION, component_tipo: leafComponent },
					],
				},
			],
		},
	} as never);
}

/** A three-hop filter over the same relation, twice — two join aliases. */
function threeHopSqo(q: string) {
	return sanitizeClientSqo({
		section_tipo: [SECTION],
		limit: 50,
		offset: 0,
		filter: {
			$and: [
				{
					q,
					path: [
						{ section_tipo: SECTION, component_tipo: HOP_COMPONENT },
						{ section_tipo: SECTION, component_tipo: HOP_COMPONENT },
						{ section_tipo: SECTION, component_tipo: LEAF_COMPONENT },
					],
				},
			],
		},
	} as never);
}

/**
 * Every hop alias the builder emitted, in emission order — in EITHER shape.
 * Forward (buildJoinChain): `LEFT JOIN <table> AS j_… ON <acl>`. Reversed
 * (deep_path.ts): the leaf record enters as `FROM <table> AS j_… WHERE <acl>`,
 * an intermediate record as `JOIN <table> AS j_… ON <acl>` (emitted only when
 * it carries an ACL). The census is total over both, so a reversal that lost a
 * hop's predicate is as red as a forward join that never had one.
 */
function joinAliases(builtSql: string): string[] {
	// BOTH chain namespaces: buildJoinChain emits `j_` for a FILTER chain and
	// `o_` for an ORDER one (PERF-08 — the order twin collapses the locator
	// fan-out, so it is a different join and must not dedup into the filter's).
	// The SEC-02 census below is about the ORDER twin, so a helper blind to
	// `o_` would report zero joins and pass its refusal legs vacuously.
	return [...builtSql.matchAll(/(?:JOIN|FROM) \S+ AS ([jo]_[A-Za-z0-9_]+) (?:ON|WHERE) /g)].map(
		(match) => match[1] as string,
	);
}

/** The ON / WHERE clause the builder gave one hop alias (one line, by construction). */
function onClauseOf(builtSql: string, alias: string): string {
	const found = new RegExp(` AS ${alias} (?:ON|WHERE) `).exec(builtSql);
	if (found === null) throw new Error(`no join for alias ${alias}`);
	const from = found.index + found[0].length;
	const end = builtSql.indexOf('\n', from);
	return builtSql.slice(from, end === -1 ? undefined : end);
}

/** Run a built query and return the matched section_ids, sorted. */
async function idsOf(built: { sql: string; params: unknown[] }): Promise<number[]> {
	const rows = (await sql.unsafe(built.sql, built.params as (string | number | null)[])) as {
		section_id: number | string;
	}[];
	return rows.map((row) => Number(row.section_id)).sort((a, b) => a - b);
}

describe.if(DB_READY)('SEC-02 — the ACL holds at EVERY hop of a search path', () => {
	beforeAll(install);
	afterAll(async () => {
		await purge(true);
		clearCaches();
	});

	// --- (a) the structural census -----------------------------------------

	test('CENSUS: every join alias a two-hop filter emits carries the projects predicate', async () => {
		const built = await buildSearchSql(twoHopSqo('zzhop02*'), { principal: SCOPED });
		const aliases = joinAliases(built.sql);
		// Non-degeneracy: a census over zero aliases proves nothing.
		expect(aliases.length).toBe(1);
		const uncovered = aliases.filter(
			(alias) => !onClauseOf(built.sql, alias).includes(`${alias}.relation @> `),
		);
		expect(
			uncovered,
			`hop aliases with NO record-ACL predicate in their ON clause: ${uncovered.join(', ')}\n${built.sql}`,
		).toEqual([]);
		// …and the bound payload is this caller's OWN project, not some other id.
		const payload = `{"${FILTER_COMPONENT}":[{"section_id":${MY_PROJECT_ID}}]}`;
		expect(built.params).toContain(payload);
	});

	test('CENSUS: a three-hop filter emits TWO aliases and both are covered', async () => {
		const built = await buildSearchSql(threeHopSqo('zzhop02*'), { principal: SCOPED });
		const aliases = joinAliases(built.sql);
		expect(aliases.length).toBe(2);
		const uncovered = aliases.filter(
			(alias) => !onClauseOf(built.sql, alias).includes(`${alias}.relation @> `),
		);
		expect(
			uncovered,
			`hop aliases with NO record-ACL predicate in their ON clause: ${uncovered.join(', ')}\n${built.sql}`,
		).toEqual([]);
	});

	test('CENSUS: a NEGATED deep leaf (NOT EXISTS) carries the ACL on every hop', async () => {
		// Negations are never reversed (WC-2026-09-29-search-deep-leaf-mixed-rule):
		// they render as a correlated NOT EXISTS whose hop joins must carry the
		// same record ACL as a positive leaf — at one hop and at two.
		for (const [built, hops] of [
			[await buildSearchSql(twoHopSqo('-zzhop02'), { principal: SCOPED }), 1],
			[await buildSearchSql(twoHopSqo('!*'), { principal: SCOPED }), 1],
			[await buildSearchSql(threeHopSqo('-zzhop02'), { principal: SCOPED }), 2],
		] as const) {
			expect(built.sql).toContain('NOT EXISTS (SELECT 1 FROM');
			const aliases = joinAliases(built.sql);
			expect(aliases.length).toBe(hops);
			for (const alias of aliases) {
				expect(onClauseOf(built.sql, alias)).toContain(`${alias}.relation @> `);
			}
			// Runs: every bound value is referenced (no orphan `$n`).
			await idsOf(built);
		}
	});

	test('CENSUS: the ORDER path twin is covered too (it shares buildJoinChain)', async () => {
		const built = await buildSearchSql(
			sanitizeClientSqo({
				section_tipo: [SECTION],
				limit: 50,
				offset: 0,
				order: [
					{
						direction: 'ASC',
						path: [
							{ section_tipo: SECTION, component_tipo: HOP_COMPONENT },
							{ section_tipo: SECTION, component_tipo: LEAF_COMPONENT },
						],
					},
				],
			} as never),
			{ principal: SCOPED },
		);
		const aliases = joinAliases(built.sql);
		expect(aliases.length).toBe(1);
		for (const alias of aliases) {
			expect(onClauseOf(built.sql, alias)).toContain(`${alias}.relation @> `);
		}
	});

	test('CENSUS: the dd478 record allow-list rides every hop alias as well', async () => {
		await sql.unsafe(
			`UPDATE matrix_users SET misc = $1::text::jsonb WHERE section_tipo = $2 AND section_id = $3`,
			[
				encodeForJsonb({ dd478: [{ id: 1, tipo: SECTION, value: [VISIBLE_ID] }] }),
				USERS_SECTION,
				SCOPED_USER_ID,
			],
		);
		clearUserFilterRecordsCache(SCOPED_USER_ID);
		try {
			const built = await buildSearchSql(twoHopSqo('zzhop02*'), { principal: SCOPED });
			const aliases = joinAliases(built.sql);
			expect(aliases.length).toBe(1);
			for (const alias of aliases) {
				expect(onClauseOf(built.sql, alias)).toContain(`${alias}.section_id IN (${VISIBLE_ID})`);
			}
		} finally {
			await sql.unsafe(
				`UPDATE matrix_users SET misc = NULL WHERE section_tipo = $1 AND section_id = $2`,
				[USERS_SECTION, SCOPED_USER_ID],
			);
			clearUserFilterRecordsCache(SCOPED_USER_ID);
		}
	});

	test('CENSUS: the audit repro shape — a hop into dd128 — carries the users rule', async () => {
		// The finding's repro: a hop into the users section, `{dd128,dd132}`. dd128
		// carries no component_filter, so the GENERIC branch emits nothing for it
		// — the users-section visibility rule (own record / created_by / shared
		// project) is what must ride the hop alias, and it is the only statement
		// of that rule in the engine.
		// The hop is dd200 ("created by user", on every section; its configured
		// target IS dd128). The audit's literal hop was test54, whose configured
		// target is test3 only: since WC-2026-10-01-search-hop-configured-targets a
		// hop reaches only its component's configured targets, so that shape now
		// matches nothing at all (asserted at the end).
		const auditSqo = (hop = USERS_HOP) =>
			sanitizeClientSqo({
				section_tipo: [SECTION],
				limit: 50,
				offset: 0,
				filter: {
					$and: [
						{
							q: 'zzhop02*',
							path: [
								{ section_tipo: SECTION, component_tipo: hop },
								{ section_tipo: USERS_SECTION, component_tipo: 'dd132' },
							],
						},
					],
				},
			} as never);

		// (1) As run by a caller the read door answers 403 for: dd132 is not
		// granted, so the leaf is 1=0 and — being a semi-join over the related
		// records (WC-2026-09-29-search-deep-leaf-mixed-rule) — it opens NO hop at
		// all: nothing reads the hidden dd128 record.
		const refused = await buildSearchSql(auditSqo(), { principal: SCOPED });
		expect(refused.sql).toContain('1=0');
		expect(joinAliases(refused.sql)).toEqual([]);
		expect(await idsOf(refused)).toEqual([]);

		// (2) With dd128.dd132 granted, the hop IS read — and carries the users rule.
		const grants = [
			grant(1, SECTION, SECTION, 1),
			grant(2, SECTION, HOP_COMPONENT, 1),
			grant(3, SECTION, LEAF_COMPONENT, 1),
		];
		const setGrants = async (rows: ReturnType<typeof grant>[]) => {
			await sql.unsafe(
				`UPDATE matrix_profiles SET misc = $1::text::jsonb WHERE section_tipo = $2 AND section_id = $3`,
				[encodeForJsonb({ dd774: rows }), PROFILES_SECTION, SCOPED_PROFILE_ID],
			);
			clearCaches();
		};
		// Restore the profile's ORIGINAL grants afterwards — not a hand-written
		// subset: a narrower restore leaks into every later test of this file
		// (the SEC-1 root ORDER key reads test101 from this same profile).
		const [original] = await sql.unsafe(
			`SELECT misc::text AS misc FROM matrix_profiles WHERE section_tipo = $1 AND section_id = $2`,
			[PROFILES_SECTION, SCOPED_PROFILE_ID],
		);
		await setGrants([
			...grants,
			grant(4, USERS_SECTION, USERS_SECTION, 1),
			grant(5, USERS_SECTION, 'dd132', 1),
		]);
		try {
			const built = await buildSearchSql(auditSqo(), { principal: SCOPED });
			expect(built.sql).not.toContain('1=0');
			const aliases = joinAliases(built.sql);
			expect(aliases.length).toBe(1);
			const on = onClauseOf(built.sql, aliases[0] as string);
			expect(on).toContain(`${aliases[0]}.section_tipo IN ('${USERS_SECTION}')`);
			expect(on).toContain(`${aliases[0]}.section_id > 0`);
			expect(on).toContain(`${aliases[0]}.data @> `);
			expect(on).toContain(`${aliases[0]}.relation @> `);
			// The literal audit hop (test54 targets test3 only) reaches nothing.
			const outside = await buildSearchSql(auditSqo(HOP_COMPONENT), { principal: SCOPED });
			expect(onClauseOf(outside.sql, joinAliases(outside.sql)[0] as string)).toContain('(FALSE)');
		} finally {
			await sql.unsafe(
				`UPDATE matrix_profiles SET misc = $1::text::jsonb WHERE section_tipo = $2 AND section_id = $3`,
				[(original as { misc: string }).misc, PROFILES_SECTION, SCOPED_PROFILE_ID],
			);
			clearCaches();
		}
	});

	test('a ROOT $or filter stays inside the section pin and the record ACL', async () => {
		// The client filter tree is rendered to ONE WHERE part and ANDed with the
		// section pin and the ACL parts. A root `$or` rendered bare
		// (`pin AND A OR B AND acl`) binds as `(pin AND A) OR (B AND acl)`:
		// branch A escapes the ACL, branch B the section pin
		// (WC-2026-09-29-search-where-parts-parenthesized).
		const rootOr = () =>
			sanitizeClientSqo({
				section_tipo: [SECTION],
				limit: 50,
				offset: 0,
				filter: {
					$or: [
						{ q: HIDDEN_VALUE, path: [{ section_tipo: SECTION, component_tipo: LEAF_COMPONENT }] },
						{ q: VISIBLE_VALUE, path: [{ section_tipo: SECTION, component_tipo: LEAF_COMPONENT }] },
					],
				},
			} as never);

		// Non-degeneracy: the admin (no record ACL) sees both records.
		const admin = await idsOf(await buildSearchSql(rootOr(), { principal: ADMIN }));
		expect(admin).toContain(HIDDEN_ID);
		expect(admin).toContain(VISIBLE_ID);

		// The scoped caller sees only the record in her own project.
		const scoped = await buildSearchSql(rootOr(), { principal: SCOPED });
		const ids = await idsOf(scoped);
		expect(ids).toContain(VISIBLE_ID);
		expect(ids).not.toContain(HIDDEN_ID);
	});

	// --- (b) the oracle itself ---------------------------------------------

	test('ORACLE CLOSED: HIT and MISS are the same answer for a value she cannot read', async () => {
		// The prefix probe an attacker walks character by character.
		const hit = await idsOf(
			await buildSearchSql(twoHopSqo('zzhop02 hidden*'), { principal: SCOPED }),
		);
		const miss = await idsOf(
			await buildSearchSql(twoHopSqo('zzhop02 hiddex*'), { principal: SCOPED }),
		);
		expect(hit).toEqual(miss);
		expect(hit).not.toContain(MAIN_TO_HIDDEN_ID);

		// NON-DEGENERACY. The value IS there and the query DOES discriminate — an
		// admin running the same two probes gets different answers.
		const adminHit = await idsOf(
			await buildSearchSql(twoHopSqo('zzhop02 hidden*'), { principal: ADMIN }),
		);
		const adminMiss = await idsOf(
			await buildSearchSql(twoHopSqo('zzhop02 hiddex*'), { principal: ADMIN }),
		);
		expect(adminHit).toContain(MAIN_TO_HIDDEN_ID);
		expect(adminMiss).not.toContain(MAIN_TO_HIDDEN_ID);
	});

	test('ORACLE CLOSED: equality and contains answer identically too', async () => {
		for (const [probe, control] of [
			[`'${HIDDEN_VALUE}'`, `'${HIDDEN_VALUE}x'`],
			['*hidden heritage*', '*hiddex heritage*'],
		] as const) {
			const hit = await idsOf(await buildSearchSql(twoHopSqo(probe), { principal: SCOPED }));
			const miss = await idsOf(await buildSearchSql(twoHopSqo(control), { principal: SCOPED }));
			expect(hit, `probe ${probe}`).toEqual(miss);
			expect(hit, `probe ${probe}`).not.toContain(MAIN_TO_HIDDEN_ID);
		}
	});

	// --- the other direction: legitimate traffic is untouched ---------------

	test('NOT OVER-EAGER: the same hop into a record in HER OWN project still matches', async () => {
		const found = await idsOf(
			await buildSearchSql(twoHopSqo('zzhop02 visible*'), { principal: SCOPED }),
		);
		expect(found).toContain(MAIN_TO_VISIBLE_ID);
		// …and the admin sees exactly the same row, so the scoped answer is not a
		// coincidence of some other predicate.
		const adminFound = await idsOf(
			await buildSearchSql(twoHopSqo('zzhop02 visible*'), { principal: ADMIN }),
		);
		expect(adminFound).toContain(MAIN_TO_VISIBLE_ID);
	});

	test('NOT OVER-EAGER: an internal search (no principal) emits the bare join', async () => {
		const built = await buildSearchSql(twoHopSqo('zzhop02*'), {});
		const aliases = joinAliases(built.sql);
		expect(aliases.length).toBe(1);
		for (const alias of aliases) {
			const on = onClauseOf(built.sql, alias);
			expect(on).not.toContain('@>');
			if (built.sql.includes(`FROM matrix_relation_index AS ri_${alias}`)) {
				// Reversed (deep_path.ts): the leaf's WHERE opens straight on its
				// predicate — no ACL conjunct in front of it.
				expect(on.startsWith(`(${alias}.`) || on.startsWith(`((${alias}.`)).toBe(true);
				expect(on).not.toContain(`${alias}.section_id > 0`);
			} else {
				expect(on).toBe(
					`${alias}.section_id = NULLIF((rel_${alias}->>'section_id'), '')::bigint AND ${alias}.section_tipo = (rel_${alias}->>'section_tipo')::text`,
				);
			}
		}
		// It still finds the hidden record — an internal resolution is not scoped.
		expect(await idsOf(await buildSearchSql(twoHopSqo('zzhop02 hidden*'), {}))).toContain(
			MAIN_TO_HIDDEN_ID,
		);
	});

	test('NOT OVER-EAGER: a global admin hop carries no projects predicate', async () => {
		const built = await buildSearchSql(twoHopSqo('zzhop02*'), { principal: ADMIN });
		for (const alias of joinAliases(built.sql)) {
			expect(onClauseOf(built.sql, alias)).not.toContain('@>');
		}
	});

	// --- the component half -------------------------------------------------

	test('a hop leaf the principal holds 0 on answers 1=0, and the granted twin does not', async () => {
		const denied = await buildSearchSql(twoHopSqo(DENIED_LEAF_Q, DENIED_LEAF_COMPONENT), {
			principal: SCOPED,
		});
		expect(denied.sql).toContain('1=0');
		expect(await idsOf(denied)).toEqual([]);

		// The SAME shape on the GRANTED leaf is a real predicate and matches.
		const granted = await buildSearchSql(twoHopSqo('zzhop02 visible*'), { principal: SCOPED });
		expect(granted.sql).not.toContain('1=0');
		expect(await idsOf(granted)).toContain(MAIN_TO_VISIBLE_ID);
	});

	test('the component gate does not fire for an internal search', async () => {
		const built = await buildSearchSql(twoHopSqo(DENIED_LEAF_Q, DENIED_LEAF_COMPONENT), {});
		expect(built.sql).not.toContain('1=0');
	});

	// --- THE OVER-REFUSAL, and why the exemption exists ---------------------
	//
	// The component half over-refused on first landing. MEASURED on this suite
	// database with this file's own non-admin principal (2026-08-28): the
	// ENGINE-MINTED order path of every `component_filter` column is
	// `[self, dd156@dd153]` (search/order_path.ts, PHP
	// component_filter::get_order_path), no profile in any install grants
	// `dd153_dd156` — dd153 is engine infrastructure, not curator-configured —
	// so the grant resolved false, buildOrderClauses dropped the entry and the
	// sort SILENTLY became `section_id ASC` for every non-admin. Same wall for
	// `component_select_lang`'s `[self, hierarchy25@lg1]`.
	//
	// The fix is not a hole: `buildProjectsFilter` already returns '' for dd153
	// BECAUSE projects are globally visible, and PROJECTS_FILTER_EXEMPT_TABLES
	// already exempts matrix_langs. The component key now reads the SAME
	// declaration the record key does (security/frontier_scope.ts).

	test('NOT OVER-EAGER: the engine-minted component_filter ORDER path SURVIVES', async () => {
		// Non-degeneracy FIRST: the grant really is absent, so what saves the
		// sort below is the frontier exemption and nothing else.
		expect(await getPermissions(SCOPED, PROJECTS_SECTION, 'dd156')).toBe(0);

		const built = await buildSearchSql(
			sanitizeClientSqo({
				section_tipo: [SECTION],
				limit: 50,
				offset: 0,
				order: [
					{
						direction: 'ASC',
						path: [
							{ section_tipo: SECTION, component_tipo: FILTER_COMPONENT },
							{ section_tipo: PROJECTS_SECTION, component_tipo: 'dd156' },
						],
					},
				],
			} as never),
			{ principal: SCOPED },
		);
		// The join is emitted AND the sort really orders by the project name —
		// `expect(joins).toBe(1)` alone would pass on a query that then fell back
		// to section_id.
		expect(joinAliases(built.sql).length).toBe(1);
		expect(built.sql).toContain('dd156_order');
		expect(built.sql).toContain('ORDER BY dd156_order');
		// The ADMIN's query is the same shape — the scoped caller is not being
		// served a quietly different sort.
		const adminBuilt = await buildSearchSql(
			sanitizeClientSqo({
				section_tipo: [SECTION],
				limit: 50,
				offset: 0,
				order: [
					{
						direction: 'ASC',
						path: [
							{ section_tipo: SECTION, component_tipo: FILTER_COMPONENT },
							{ section_tipo: PROJECTS_SECTION, component_tipo: 'dd156' },
						],
					},
				],
			} as never),
			{ principal: ADMIN },
		);
		expect(adminBuilt.sql).toContain('ORDER BY dd156_order');
	});

	test('NOT OVER-EAGER: the component_select_lang ORDER twin survives too (lg1)', async () => {
		expect(await getPermissions(SCOPED, LANGS_SECTION, THESAURUS_TERM)).toBe(0);
		const built = await buildSearchSql(
			sanitizeClientSqo({
				section_tipo: [SECTION],
				limit: 50,
				offset: 0,
				order: [
					{
						direction: 'ASC',
						path: [
							{ section_tipo: SECTION, component_tipo: HOP_COMPONENT },
							{ section_tipo: LANGS_SECTION, component_tipo: THESAURUS_TERM },
						],
					},
				],
			} as never),
			{ principal: SCOPED },
		);
		expect(joinAliases(built.sql).length).toBe(1);
		expect(built.sql).toContain(`${THESAURUS_TERM}_order`);
	});

	test('the exemption does NOT reach the profiles or users sections', async () => {
		// dd234 and dd128 are named by buildProjectsFilter but are DELIBERATELY
		// not frontier-exempt (frontier_scope.ts): dd774 is the grant matrix, and
		// the users rule is a restriction rather than an exemption. A hop naming
		// either still needs the grant, and this caller has none.
		for (const [section, component] of [
			[PROFILES_SECTION, 'dd774'],
			[USERS_SECTION, 'dd132'],
		] as const) {
			const built = await buildSearchSql(
				sanitizeClientSqo({
					section_tipo: [SECTION],
					limit: 50,
					offset: 0,
					filter: {
						$and: [
							{
								q: 'zzhop02*',
								path: [
									{ section_tipo: SECTION, component_tipo: HOP_COMPONENT },
									{ section_tipo: section, component_tipo: component },
								],
							},
						],
					},
				} as never),
				{ principal: SCOPED },
			);
			expect(built.sql, `${section}.${component}`).toContain('1=0');
		}
	});

	// --- the refusal is LOUD ------------------------------------------------

	test('a surviving refusal records a request notice, never a silent narrowing', async () => {
		// AGENTS.md forbids a silent narrowing even when the narrowing is
		// correct. The CALLER's answer stays identical for hit and miss (the
		// oracle); the OPERATOR gets a named log line and the request carries a
		// `perm.out_of_scope` notice for the envelope.
		const { runWithRequestContext } = await import('../../src/core/security/request_context.ts');
		const { currentFrontierRefusals, frontierRefusalNotice } = await import(
			'../../src/core/security/frontier_scope.ts'
		);
		await runWithRequestContext(
			{ session: null, requestId: 'zzhop02-loud', clientIp: '', principal: SCOPED },
			async () => {
				// Before: nothing narrowed, so no notice may be invented.
				expect(currentFrontierRefusals()).toEqual([]);
				expect(frontierRefusalNotice()).toBeUndefined();

				await buildSearchSql(twoHopSqo(DENIED_LEAF_Q, DENIED_LEAF_COMPONENT), {
					principal: SCOPED,
				});

				const refusals = currentFrontierRefusals();
				expect(refusals.length).toBeGreaterThan(0);
				expect(refusals[0]?.surface).toBe('search');
				expect(refusals[0]?.key).toBe('component');
				expect(refusals[0]?.componentTipo).toBe(DENIED_LEAF_COMPONENT);
				expect(frontierRefusalNotice()?.code).toBe('perm.out_of_scope');
			},
		);
		// The sink is REQUEST-scoped: outside the scope there is nothing to read,
		// so one caller's narrowing can never appear on another's envelope.
		expect(currentFrontierRefusals()).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-1 (closure Step 3) — THE ROOT STEP. `buildJoinChain` starts at index 1,
// so `path[0]` — the MAIN section's own component — was never keyed: a
// non-admin holding 0 on test3.test162 still filtered (and sorted) her OWN
// records by test162's hidden values. Contains / `==` / begins-with / `$not`
// are all the prefix oracle again, one hop shorter; a relation leaf is the
// same oracle through `matrix_relation_index` (an explicit hidden
// from_component_tipo, or an ABSENT one that matches any component).
//
// The records are ENGINE-BUILT (createSectionRecord + saveComponentData,
// authz_door_fixture) in HER project, so everything below is a question about
// records she may list — only the component is hidden. The CONTROL is the
// superuser (-1): every grant, every project.
// ─────────────────────────────────────────────────────────────────────────────

/** test3's second component_input_text — the SCOPED profile grants NOTHING on it. */
const ROOT_HIDDEN_LEAF = 'test162';
const ROOT_SELECT = 'test91';
const ROOT_ALPHA = 'zzroot alpha heritage';
const ROOT_BETA = 'zzroot beta heritage';
const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
/** A section the SCOPED profile grants test162 on — the "granted sibling" spoof. */
const SPOOF_GRANTED_SECTION = 'test65';
/**
 * A scratch VIRTUAL section over test3 (its ontology relation names test3, whose
 * model is section): it OWNS no component — every relation component its rows
 * carry is the REAL section's. SCOPED holds it, its hop and its filter, and
 * NOTHING on test91: "any component" on a virtual main must walk the real section.
 */
const VIRTUAL_MAIN = 'zzvmain1';
/** The virtual main's one record (in her project; test91 → dd64/1). */
const VIRTUAL_ID = 931036;
const VIRTUAL_MAIN_SITUATION = situation({
	tld: 'zzvmain',
	name: 'search_path_acl SEC-1 virtual main (relations → test3)',
	nodes: [
		{
			tipo: VIRTUAL_MAIN,
			parent: 'test1',
			model: 'section',
			term: { 'lg-eng': 'zzvmain virtual of test3' },
			// test24 = the matrix_test table (a matrix_table relation does not make a
			// section virtual); test3 = the REAL section (model section — this does).
			relations: [{ tipo: 'test24' }, { tipo: SECTION }],
		},
	],
	records: [
		{
			section_tipo: VIRTUAL_MAIN,
			section_id: VIRTUAL_ID,
			columns: {
				relation: {
					[FILTER_COMPONENT]: [locator(FILTER_COMPONENT, PROJECTS_SECTION, MY_PROJECT_ID, 'dd675')],
					test91: [locator('test91', 'dd64', 1)],
				},
			},
		},
	],
});

function rootSqo(leaf: Record<string, unknown>, wrap: '$and' | '$not' = '$and') {
	return sanitizeClientSqo({
		section_tipo: [SECTION],
		limit: 200,
		offset: 0,
		// The client grammar roots a filter at $and/$or; `$not` nests under it.
		filter: wrap === '$and' ? { $and: [leaf] } : { $and: [{ $not: [leaf] }] },
	} as never);
}
const stringLeaf = (q: string) => ({
	q,
	path: [{ section_tipo: SECTION, component_tipo: ROOT_HIDDEN_LEAF }],
});
const relationLeaf = (q: Record<string, unknown>) => ({
	q,
	format: 'relation',
	// The path names a component she IS granted: the relation leaf's answer is
	// decided by its q, so the hop's own grant must not be what lets it through.
	path: [{ section_tipo: SECTION, component_tipo: HOP_COMPONENT }],
});

/**
 * The two floor sources SEC-1's harvest legs need: test80's own request_config
 * (show / search ddo_map test52) plus test162 named ONLY in the declared
 * `fixed_filter` (zzfloor1) or ONLY in `filter_by_list` (zzfloor2) — so a floor
 * that stopped harvesting the declared filters would key test162 again.
 */
const floorSourceProperties = (sqoExtra: Record<string, unknown>) => ({
	source: {
		request_config: [
			{
				sqo: { section_tipo: [{ value: [SECTION], source: 'section' }], ...sqoExtra },
				show: { ddo_map: [{ tipo: LEAF_COMPONENT, parent: 'self', section_tipo: 'self' }] },
				search: { ddo_map: [{ tipo: LEAF_COMPONENT, parent: 'self', section_tipo: 'self' }] },
			},
		],
	},
});
const FLOOR_SOURCES_SITUATION = situation({
	tld: 'zzfloor',
	name: 'search_path_acl SEC-1 read-floor sources (fixed_filter / filter_by_list)',
	nodes: [
		{
			tipo: FLOOR_FIXED_FILTER_SOURCE,
			parent: 'test45',
			model: 'component_portal',
			term: { 'lg-eng': 'zzfloor fixed_filter source' },
			relations: [{ tipo: SECTION }],
			properties: floorSourceProperties({
				fixed_filter: [
					{
						source: 'fixed_dato',
						value: [{ q: 'zzfloor', path: [{ section_tipo: SECTION, component_tipo: 'test162' }] }],
					},
				],
			}),
		},
		{
			tipo: FLOOR_FILTER_BY_LIST_SOURCE,
			parent: 'test45',
			model: 'component_portal',
			term: { 'lg-eng': 'zzfloor filter_by_list source' },
			relations: [{ tipo: SECTION }],
			properties: floorSourceProperties({
				filter_by_list: [{ section_tipo: SECTION, component_tipo: 'test162' }],
			}),
		},
		// THE FORGED-SOURCE twins (refuter-surviving S1 on the floor): the same
		// test162-naming request_config, on a component that does NOT belong to
		// the section a forger pairs it with (zzfloor3 lives under test65; her
		// matrix holds the stray pair test3_zzfloor3), and on members of the two
		// sections every principal holds by RULE, not by profile (dd655 the
		// editing presets, dd1324 the tools register).
		...(
			[
				[FLOOR_FOREIGN_SOURCE, SPOOF_GRANTED_SECTION],
				[FLOOR_PRESET_SOURCE, 'dd655'],
				[FLOOR_TOOLS_SOURCE, 'dd1324'],
			] as const
		).map(([tipo, parent]) => ({
			tipo,
			parent,
			model: 'component_portal',
			term: { 'lg-eng': `zzfloor forged source under ${parent}` },
			relations: [{ tipo: SECTION }],
			properties: floorSourceProperties({
				filter_by_list: [{ section_tipo: SECTION, component_tipo: 'test162' }],
			}),
		})),
		// THE IMPLICIT twin (refuter-surviving S1 on the floor cache): no
		// request_config at all, so the IMPLICIT builder resolves it from its
		// relations — target test3, one ddo test162 — and DROPS that ddo for a
		// principal who holds 0 on it (filterAuthorizedRelated, PHP STEP 5).
		{
			tipo: FLOOR_IMPLICIT_SOURCE,
			parent: 'test45',
			model: 'component_portal',
			term: { 'lg-eng': 'zzfloor implicit source' },
			relations: [{ tipo: SECTION }, { tipo: ROOT_HIDDEN_LEAF }],
		},
	],
});

describe.if(DB_READY)('SEC-1 — the ROOT step of a search path is keyed too', () => {
	let alphaId = 0;
	let betaId = 0;

	beforeAll(async () => {
		await ensureSituation(FLOOR_SOURCES_SITUATION);
		await ensureSituation(VIRTUAL_MAIN_SITUATION);
		await install();
		const { createDoorRecord } = await import('../helpers/authz_door_fixture.ts');
		const dd64 = (id: number) => [
			{
				id: 1,
				type: 'dd151',
				section_id: id,
				section_tipo: 'dd64',
				from_component_tipo: ROOT_SELECT,
			},
		];
		alphaId = await createDoorRecord(SECTION, MY_PROJECT_ID, [
			{
				tipo: ROOT_HIDDEN_LEAF,
				lang: 'lg-eng',
				value: [{ id: 1, lang: 'lg-eng', value: ROOT_ALPHA }],
			},
			{ tipo: ROOT_SELECT, lang: 'lg-nolan', value: dd64(1) },
			{
				tipo: LEAF_COMPONENT,
				lang: 'lg-eng',
				value: [{ id: 1, lang: 'lg-eng', value: ROOT_ALPHA }],
			},
		]);
		betaId = await createDoorRecord(SECTION, MY_PROJECT_ID, [
			{
				tipo: ROOT_HIDDEN_LEAF,
				lang: 'lg-eng',
				value: [{ id: 1, lang: 'lg-eng', value: ROOT_BETA }],
			},
			{ tipo: ROOT_SELECT, lang: 'lg-nolan', value: dd64(2) },
		]);
		clearCaches();
	});
	afterAll(async () => {
		const { dropDoorRecords } = await import('../helpers/authz_door_fixture.ts');
		await dropDoorRecords();
		await purge(true);
		clearCaches();
		expect(await dropSituation(FLOOR_SOURCES_SITUATION)).toBe(0);
		expect(await dropSituation(VIRTUAL_MAIN_SITUATION)).toBe(0);
	});

	test('non-degeneracy: she holds the section, NOT the leaf; both records are hers to list', async () => {
		expect(await getPermissions(SCOPED, SECTION, SECTION)).toBe(1);
		expect(await getPermissions(SCOPED, SECTION, ROOT_HIDDEN_LEAF)).toBe(0);
		expect(await getPermissions(SCOPED, SECTION, ROOT_SELECT)).toBe(0);
		const listed = await idsOf(
			await buildSearchSql(sanitizeClientSqo({ section_tipo: [SECTION], limit: 200 } as never), {
				principal: SCOPED,
			}),
		);
		expect(listed).toContain(alphaId);
		expect(listed).toContain(betaId);
	});

	for (const [label, hit, miss] of [
		['begins-with', 'zzroot alpha*', 'zzroot alphx*'],
		['equality', `'${ROOT_ALPHA}'`, `'${ROOT_ALPHA}x'`],
		['contains', '*alpha heritage*', '*alphx heritage*'],
	] as const) {
		for (const wrap of ['$and', '$not'] as const) {
			test(`ORACLE CLOSED (${label}, ${wrap}): HIT and MISS on the hidden ROOT leaf are the same answer; the CONTROL's differ`, async () => {
				const scopedHit = await idsOf(
					await buildSearchSql(rootSqo(stringLeaf(hit), wrap), { principal: SCOPED }),
				);
				const scopedMiss = await idsOf(
					await buildSearchSql(rootSqo(stringLeaf(miss), wrap), { principal: SCOPED }),
				);
				expect(scopedHit).toEqual(scopedMiss);

				const controlHit = await idsOf(
					await buildSearchSql(rootSqo(stringLeaf(hit), wrap), { principal: SUPERUSER }),
				);
				const controlMiss = await idsOf(
					await buildSearchSql(rootSqo(stringLeaf(miss), wrap), { principal: SUPERUSER }),
				);
				expect(controlHit.includes(alphaId)).not.toBe(controlMiss.includes(alphaId));
			});
		}
	}

	test('RELATION leaf, EXPLICIT hidden from_component_tipo: HIT and MISS identical; the CONTROL differs', async () => {
		const hit = relationLeaf({
			section_tipo: 'dd64',
			section_id: 1,
			from_component_tipo: ROOT_SELECT,
		});
		const miss = relationLeaf({
			section_tipo: 'dd64',
			section_id: 3,
			from_component_tipo: ROOT_SELECT,
		});
		expect(await idsOf(await buildSearchSql(rootSqo(hit), { principal: SCOPED }))).toEqual(
			await idsOf(await buildSearchSql(rootSqo(miss), { principal: SCOPED })),
		);
		expect(await idsOf(await buildSearchSql(rootSqo(hit), { principal: SUPERUSER }))).toContain(
			alphaId,
		);
		expect(
			await idsOf(await buildSearchSql(rootSqo(miss), { principal: SUPERUSER })),
		).not.toContain(alphaId);
	});

	test('RELATION leaf, ABSENT from_component_tipo: "any component" means any GRANTED one', async () => {
		const hit = relationLeaf({ section_tipo: 'dd64', section_id: 1 });
		const miss = relationLeaf({ section_tipo: 'dd64', section_id: 3 });
		expect(await idsOf(await buildSearchSql(rootSqo(hit), { principal: SCOPED }))).toEqual(
			await idsOf(await buildSearchSql(rootSqo(miss), { principal: SCOPED })),
		);
		// CONTROL, both halves: the relation match is real (hit), not a tautology (miss).
		expect(await idsOf(await buildSearchSql(rootSqo(hit), { principal: SUPERUSER }))).toContain(
			alphaId,
		);
		expect(
			await idsOf(await buildSearchSql(rootSqo(miss), { principal: SUPERUSER })),
		).not.toContain(alphaId);
	});

	// A DECLARATION IS NOT A ROW. The key used to be asked of the client's
	// `path[0].section_tipo`: declaring the globally visible projects section
	// (dd153), or any section the profile happens to grant the component on, over
	// test3 rows handed the hidden predicate straight back. The key is now asked
	// of the SQO's own sections (the rows' own), so the declaration changes
	// nothing: the spoofed probe is exactly as blind as the honest one.
	const declaredOver = (
		declared: string,
		leaf: { q: unknown; path: object[]; format?: string },
	) => ({
		...leaf,
		path: [{ ...(leaf.path[0] as object), section_tipo: declared }],
	});
	for (const [label, declared] of [
		['the projects section (globally visible)', PROJECTS_SECTION],
		['a section she holds the component on', SPOOF_GRANTED_SECTION],
	] as const) {
		test(`SPOOFED ROOT (${label}): HIT and MISS identical; the CONTROL's differ`, async () => {
			expect(await getPermissions(SCOPED, SPOOF_GRANTED_SECTION, ROOT_HIDDEN_LEAF)).toBe(1);
			const hit = declaredOver(declared, stringLeaf('zzroot alpha*'));
			const miss = declaredOver(declared, stringLeaf('zzroot alphx*'));
			expect(await idsOf(await buildSearchSql(rootSqo(hit), { principal: SCOPED }))).toEqual(
				await idsOf(await buildSearchSql(rootSqo(miss), { principal: SCOPED })),
			);
			expect(await idsOf(await buildSearchSql(rootSqo(hit), { principal: SUPERUSER }))).toContain(
				alphaId,
			);
			expect(
				await idsOf(await buildSearchSql(rootSqo(miss), { principal: SUPERUSER })),
			).not.toContain(alphaId);
		});
		for (const [shape, hitQ, missQ] of [
			[
				'explicit from_component_tipo',
				{ section_tipo: 'dd64', section_id: 1, from_component_tipo: ROOT_SELECT },
				{ section_tipo: 'dd64', section_id: 3, from_component_tipo: ROOT_SELECT },
			],
			[
				'absent from_component_tipo',
				{ section_tipo: 'dd64', section_id: 1 },
				{ section_tipo: 'dd64', section_id: 3 },
			],
		] as const) {
			test(`SPOOFED RELATION leaf (${label}, ${shape}): HIT and MISS identical; the CONTROL's differ`, async () => {
				const hit = declaredOver(declared, relationLeaf(hitQ));
				const miss = declaredOver(declared, relationLeaf(missQ));
				expect(await idsOf(await buildSearchSql(rootSqo(hit), { principal: SCOPED }))).toEqual(
					await idsOf(await buildSearchSql(rootSqo(miss), { principal: SCOPED })),
				);
				expect(await idsOf(await buildSearchSql(rootSqo(hit), { principal: SUPERUSER }))).toContain(
					alphaId,
				);
				expect(
					await idsOf(await buildSearchSql(rootSqo(miss), { principal: SUPERUSER })),
				).not.toContain(alphaId);
			});
		}
	}

	// THE SEARCH SURFACE'S STANDING GRANTS. The section-info metadata components
	// (dd199 created date, dd200 created by …) are offered by the search panel to
	// every searcher and granted per section by NO profile; the root key reads the
	// same rule the search-mode context stamp does (permissions.searchSurfaceGrants),
	// so the offered field is never the refused one. Served = the non-admin's
	// answer equals the superuser's, on a hit AND on a miss, and the hit is real.
	const createdThisYear = { q: String(new Date().getFullYear()), path: [] as object[] };
	for (const [label, hitLeaf, missLeaf] of [
		[
			'dd199 created date',
			{ ...createdThisYear, path: [{ section_tipo: SECTION, component_tipo: 'dd199' }] },
			{ q: '1901', path: [{ section_tipo: SECTION, component_tipo: 'dd199' }] },
		],
		[
			'dd200 created by (relation leaf)',
			{
				q: { section_tipo: USERS_SECTION, section_id: -1, from_component_tipo: 'dd200' },
				format: 'relation',
				path: [{ section_tipo: SECTION, component_tipo: 'dd200' }],
			},
			{
				q: { section_tipo: USERS_SECTION, section_id: 931099, from_component_tipo: 'dd200' },
				format: 'relation',
				path: [{ section_tipo: SECTION, component_tipo: 'dd200' }],
			},
		],
	] as const) {
		for (const [who, principal] of [
			['a non-admin', SCOPED],
			['a global admin (not the superuser)', ADMIN],
		] as const) {
			test(`SERVED (${label}, ${who}): the metadata filter answers exactly as the superuser's`, async () => {
				expect(
					await getPermissions(principal, SECTION, hitLeaf.path[0]?.component_tipo ?? ''),
				).toBe(0);
				const mine = (ids: number[]) => ids.filter((id) => id === alphaId || id === betaId);
				const control = mine(
					await idsOf(await buildSearchSql(rootSqo(hitLeaf), { principal: SUPERUSER })),
				);
				expect(control).toContain(alphaId);
				expect(mine(await idsOf(await buildSearchSql(rootSqo(hitLeaf), { principal })))).toEqual(
					control,
				);
				expect(mine(await idsOf(await buildSearchSql(rootSqo(missLeaf), { principal })))).toEqual(
					[],
				);
			});
		}
	}

	test('ORDER on the hidden root leaf sorts by a constant: ASC and DESC give her the same order', async () => {
		// idsOf sorts numerically; read the RAW row order instead.
		const rawOrder = async (direction: 'ASC' | 'DESC', principal: Principal) => {
			const built = await buildSearchSql(
				sanitizeClientSqo({
					section_tipo: [SECTION],
					limit: 200,
					order: [
						{ direction, path: [{ section_tipo: SECTION, component_tipo: ROOT_HIDDEN_LEAF }] },
					],
				} as never),
				{ principal },
			);
			const rows = (await sql.unsafe(built.sql, built.params as (string | number | null)[])) as {
				section_id: number | string;
			}[];
			return rows
				.map((row) => Number(row.section_id))
				.filter((id) => id === alphaId || id === betaId);
		};
		expect(await rawOrder('ASC', SCOPED)).toEqual(await rawOrder('DESC', SCOPED));
		// CONTROL: the sort is real — ASC and DESC are reversed for the superuser.
		const controlAsc = await rawOrder('ASC', SUPERUSER);
		expect(controlAsc).toEqual([alphaId, betaId]);
		expect(await rawOrder('DESC', SUPERUSER)).toEqual([betaId, alphaId]);
	});

	test('the refusal is LOUD: a perm.out_of_scope notice, never a silent narrowing', async () => {
		const { runWithRequestContext } = await import('../../src/core/security/request_context.ts');
		const { frontierRefusalNotice } = await import('../../src/core/security/frontier_scope.ts');
		await runWithRequestContext(
			{ session: null, requestId: 'zzroot-loud', clientIp: '', principal: SCOPED },
			async () => {
				await buildSearchSql(rootSqo(stringLeaf('zzroot alpha*')), { principal: SCOPED });
				expect(frontierRefusalNotice()?.code).toBe('perm.out_of_scope');
			},
		);
	});

	test('the READ FLOOR (a Gate-A-verified request_config ddo) serves the leaf', async () => {
		// The subdatum floor: a portal/autocomplete whose verified ddo_map names
		// test3.test162 may search it although the profile holds 0 on it. The
		// floor is an ASSEMBLER option computed server-side (never client/ALS).
		const floor = {
			principal: SCOPED,
			readFloor: new Set([`${SECTION}_${ROOT_HIDDEN_LEAF}`]),
		} as never;
		const hit = await idsOf(await buildSearchSql(rootSqo(stringLeaf('zzroot alpha*')), floor));
		const miss = await idsOf(await buildSearchSql(rootSqo(stringLeaf('zzroot alphx*')), floor));
		expect(hit).toContain(alphaId);
		expect(miss).not.toContain(alphaId);
	});

	// THE AUTOCOMPLETE, END TO END (the design's P1 blocker). A non-admin holds
	// the portal test80 on test3 and 0 on test52 — the field test80's
	// request_config searches by. Through the READ PATH (readSectionRows, the
	// function the read handler routes an autocomplete to), with the portal as
	// the rqo source, her search is SERVED: the floor is computed server-side
	// from the verified source. The same search with NO source (a plain list
	// read), or through a source she holds nothing on, stays keyed — and a
	// field the portal does NOT name (test162) is not floored by it.
	const autocomplete = (q: string, component: string, source: Record<string, unknown>) => ({
		action: 'read',
		source: { ...source, mode: 'search', lang: 'lg-eng' },
		sqo: {
			section_tipo: [SECTION],
			limit: 200,
			offset: 0,
			filter: { $and: [{ q, path: [{ section_tipo: SECTION, component_tipo: component }] }] },
		},
	});
	const readIds = async (rqo: Record<string, unknown>, principal: Principal): Promise<number[]> => {
		const { readSectionRows } = await import('../../src/core/section/read.ts');
		const items = await readSectionRows(rqo as never, principal);
		const envelope = items.find((item) => (item as { typo?: string }).typo === 'sections') as
			| { entries: { section_id: number | string }[] }
			| undefined;
		return (envelope?.entries ?? []).map((entry) => Number(entry.section_id));
	};
	const portalSource = {
		tipo: FLOOR_SOURCE_PORTAL,
		section_tipo: SECTION,
		action: 'search',
		model: 'component_portal',
	};
	const sectionSource = { tipo: SECTION, section_tipo: SECTION, model: 'section' };

	test('AUTOCOMPLETE (non-admin, portal source): the floored field is SERVED — hit finds, miss does not', async () => {
		expect(await getPermissions(FLOOR_USER, SECTION, FLOOR_SOURCE_PORTAL)).toBe(1);
		expect(await getPermissions(FLOOR_USER, SECTION, LEAF_COMPONENT)).toBe(0);
		const hit = await readIds(
			autocomplete('zzroot alpha*', LEAF_COMPONENT, portalSource),
			FLOOR_USER,
		);
		const miss = await readIds(
			autocomplete('zzroot alphx*', LEAF_COMPONENT, portalSource),
			FLOOR_USER,
		);
		expect(hit).toContain(alphaId);
		expect(miss).not.toContain(alphaId);
	});

	test('AUTOCOMPLETE twins: no source, or a field the portal does not name, stay KEYED', async () => {
		for (const [component, source, hitQ, missQ] of [
			[LEAF_COMPONENT, sectionSource, 'zzroot alpha*', 'zzroot alphx*'],
			[ROOT_HIDDEN_LEAF, portalSource, 'zzroot alpha*', 'zzroot alphx*'],
		] as const) {
			expect(await readIds(autocomplete(hitQ, component, source), FLOOR_USER)).toEqual(
				await readIds(autocomplete(missQ, component, source), FLOOR_USER),
			);
		}
		// A source she holds NOTHING on mints no floor, although its request_config
		// names the very field: test54 (component_relation_related on test3, show
		// ddo test52) is not in her profile. The floor is VERIFIED, never trusted.
		const ungrantedSource = {
			...portalSource,
			tipo: HOP_COMPONENT,
			model: 'component_relation_related',
		};
		expect(await getPermissions(FLOOR_USER, SECTION, HOP_COMPONENT)).toBe(0);
		expect(
			await readIds(autocomplete('zzroot alpha*', LEAF_COMPONENT, ungrantedSource), FLOOR_USER),
		).toEqual(
			await readIds(autocomplete('zzroot alphx*', LEAF_COMPONENT, ungrantedSource), FLOOR_USER),
		);
	});

	// THE COUNT SHARES THE FLOOR. dd_core_api.count is the autocomplete's
	// paginator: a count that refused what the page read serves would report a
	// total of 0 under a list of rows. Through the portal source, the count of a
	// hit and of a miss equals the rows readSectionRows serves for them.
	test('AUTOCOMPLETE COUNT (portal source): the total equals the rows the read serves — hit and miss', async () => {
		const { coreApiActions } = await import('../../src/core/api/handlers/dd_core_api.ts');
		const count = coreApiActions.count;
		if (count === undefined) throw new Error('dd_core_api.count is not registered');
		const totalOf = async (rqo: Record<string, unknown>): Promise<number> => {
			const result = await count(
				{ ...rqo, action: 'count' } as never,
				{ requestId: 'zzfloor-count', principal: FLOOR_USER } as never,
			);
			return Number((result.body as { data?: { total?: unknown } }).data?.total);
		};
		const hitRqo = autocomplete('zzroot alpha*', LEAF_COMPONENT, portalSource);
		const missRqo = autocomplete('zzroot alphx*', LEAF_COMPONENT, portalSource);
		const hitRows = await readIds(hitRqo, FLOOR_USER);
		expect(hitRows).toContain(alphaId);
		expect({ hit: await totalOf(hitRqo), miss: await totalOf(missRqo) }).toEqual({
			hit: hitRows.length,
			miss: (await readIds(missRqo, FLOOR_USER)).length,
		});
	});

	// THE DECLARED FILTERS ARE PART OF THE FLOOR. A source whose request_config
	// names test162 ONLY in its fixed_filter, or ONLY in its filter_by_list, lets
	// the autocomplete search test162 (hit finds, miss does not) although she
	// holds 0 on it — the floor harvests the declarations, not only the ddo maps.
	for (const [label, tipo] of [
		['fixed_filter', FLOOR_FIXED_FILTER_SOURCE],
		['filter_by_list', FLOOR_FILTER_BY_LIST_SOURCE],
	] as const) {
		test(`AUTOCOMPLETE through a source naming test162 only in its ${label}: SERVED`, async () => {
			expect(await getPermissions(FLOOR_USER, SECTION, tipo)).toBe(1);
			expect(await getPermissions(FLOOR_USER, SECTION, ROOT_HIDDEN_LEAF)).toBe(0);
			const source = { ...portalSource, tipo };
			const hit = await readIds(
				autocomplete('zzroot alpha*', ROOT_HIDDEN_LEAF, source),
				FLOOR_USER,
			);
			const miss = await readIds(
				autocomplete('zzroot alphx*', ROOT_HIDDEN_LEAF, source),
				FLOOR_USER,
			);
			expect({ hitFinds: hit.includes(alphaId), missFinds: miss.includes(alphaId) }).toEqual({
				hitFinds: true,
				missFinds: false,
			});
		});
	}

	// THE FLOOR IS MINTED ONLY FROM A SOURCE THE ONTOLOGY AND THE PROFILE BOTH
	// VOUCH FOR (refuter-surviving S1, 2026-10-01). Both coordinates of
	// rqo.source are the client's: before the fix, a component named against a
	// section it does not belong to, or against a section every principal holds
	// by RULE (dd655 = 2, dd1324 = 1, whatever the profile says), minted the
	// floor of ITS request_config — test162, which she holds 0 on, became
	// searchable and `count` a prefix oracle again. Each forged source must leave
	// the search KEYED: HIT and MISS identical, through the read AND the count.
	const countOf = async (rqo: Record<string, unknown>): Promise<number> => {
		const { coreApiActions } = await import('../../src/core/api/handlers/dd_core_api.ts');
		const count = coreApiActions.count;
		if (count === undefined) throw new Error('dd_core_api.count is not registered');
		const result = await count(
			{ ...rqo, action: 'count' } as never,
			{ requestId: 'zzfloor-forged', principal: FLOOR_USER } as never,
		);
		return Number((result.body as { data?: { total?: unknown } }).data?.total);
	};
	for (const [label, sectionTipo, tipo] of [
		['the audit repro: a test3 portal named under dd655', 'dd655', FLOOR_FIXED_FILTER_SOURCE],
		['a dd655 MEMBER (the blanket preset grant)', 'dd655', FLOOR_PRESET_SOURCE],
		['a dd1324 MEMBER (the blanket tools-register grant)', 'dd1324', FLOOR_TOOLS_SOURCE],
		[
			'a component of test65 paired with test3 (a stray matrix pair)',
			SECTION,
			FLOOR_FOREIGN_SOURCE,
		],
		[
			'a member of test65, component granted but NOT the section',
			SPOOF_GRANTED_SECTION,
			FLOOR_FOREIGN_SOURCE,
		],
	] as const) {
		test(`FORGED SOURCE (${label}): mints no floor — read and count stay KEYED`, async () => {
			// Non-degeneracy: the RAW level the old floor asked is >= 1 for each, so
			// a floor that trusted it would serve test162 (the CONTROL below).
			expect(await getPermissions(FLOOR_USER, sectionTipo, tipo)).toBeGreaterThanOrEqual(1);
			expect(await getPermissions(FLOOR_USER, SECTION, ROOT_HIDDEN_LEAF)).toBe(0);
			const source = { ...portalSource, section_tipo: sectionTipo, tipo };
			const hitRqo = autocomplete('zzroot alpha*', ROOT_HIDDEN_LEAF, source);
			const missRqo = autocomplete('zzroot alphx*', ROOT_HIDDEN_LEAF, source);
			expect(await readIds(hitRqo, FLOOR_USER)).toEqual(await readIds(missRqo, FLOOR_USER));
			expect(await countOf(hitRqo)).toBe(await countOf(missRqo));
		});
	}
	test('FORGED SOURCE control: the same request_config through a VERIFIED source is served (read and count differ)', async () => {
		const source = { ...portalSource, tipo: FLOOR_FILTER_BY_LIST_SOURCE };
		const hitRqo = autocomplete('zzroot alpha*', ROOT_HIDDEN_LEAF, source);
		const missRqo = autocomplete('zzroot alphx*', ROOT_HIDDEN_LEAF, source);
		expect((await readIds(hitRqo, FLOOR_USER)).includes(alphaId)).toBe(true);
		expect(await countOf(hitRqo)).toBeGreaterThan(await countOf(missRqo));
	});
	// THE FLOOR IS THE CALLER'S OWN SUBDATUM MAP, never the first caller's
	// (refuter-surviving S1, 2026-10-01). An IMPLICIT config is built per user:
	// the implicit builder keeps only the ddos the request's principal holds >= 1
	// on. The floor cached that per-user build under a principal-free key, so
	// whoever populated it first decided everyone's floor — the superuser first
	// handed her test162 (a prefix oracle on a component her own portal does not
	// show her), she first narrowed the superuser's. Both orders, under the
	// request ALS exactly as dispatchRqo seeds it: each principal gets HIS map.
	const asRequest = <T>(principal: Principal, fn: () => Promise<T>): Promise<T> =>
		runWithRequestContext(
			{ principal, session: null, requestId: 'zzfloor-implicit', clientIp: '127.0.0.1' },
			fn,
		);
	const implicitSource = { ...portalSource, tipo: FLOOR_IMPLICIT_SOURCE };
	const implicitFloorHas = (principal: Principal): Promise<boolean> =>
		asRequest(principal, async () => {
			const { subdatumReadFloor } = await import('../../src/core/security/read_floor.ts');
			const floor = await subdatumReadFloor(principal, implicitSource);
			return floor?.has(`${SECTION}_${ROOT_HIDDEN_LEAF}`) === true;
		});
	for (const [label, order] of [
		['the superuser populates first', [SUPERUSER, FLOOR_USER]],
		['she populates first', [FLOOR_USER, SUPERUSER]],
	] as const) {
		test(`IMPLICIT SOURCE (${label}): each principal's floor is his own map — read and count keyed for her`, async () => {
			await clearOntologyDerivedCaches();
			clearCaches();
			expect(await getPermissions(FLOOR_USER, SECTION, FLOOR_IMPLICIT_SOURCE)).toBe(1);
			expect(await getPermissions(FLOOR_USER, SECTION, ROOT_HIDDEN_LEAF)).toBe(0);
			const has = new Map<number, boolean>();
			for (const principal of order) has.set(principal.userId, await implicitFloorHas(principal));
			expect({ superuser: has.get(SUPERUSER.userId), her: has.get(FLOOR_USER.userId) }).toEqual({
				superuser: true,
				her: false,
			});
			// End to end, AFTER both populated: her autocomplete through the implicit
			// source stays KEYED on test162 (HIT and MISS identical), read and count.
			const hitRqo = autocomplete('zzroot alpha*', ROOT_HIDDEN_LEAF, implicitSource);
			const missRqo = autocomplete('zzroot alphx*', ROOT_HIDDEN_LEAF, implicitSource);
			expect(await asRequest(FLOOR_USER, () => readIds(hitRqo, FLOOR_USER))).toEqual(
				await asRequest(FLOOR_USER, () => readIds(missRqo, FLOOR_USER)),
			);
			expect(await asRequest(FLOOR_USER, () => countOf(hitRqo))).toBe(
				await asRequest(FLOOR_USER, () => countOf(missRqo)),
			);
		});
	}
	test('IMPLICIT SOURCE outside any request scope, or under ANOTHER principal: the THREADED principal decides — keyed for her', async () => {
		// A direct engine call threads `principal` with no ALS around it (a job, a
		// harness), or inside a scope seeded for someone else. The implicit
		// builder alone would answer for the ALS (no principal: every ddo; the
		// superuser: every ddo); the floor builds for the principal it verified.
		await clearOntologyDerivedCaches();
		clearCaches();
		const { subdatumReadFloor } = await import('../../src/core/security/read_floor.ts');
		const pairsOf = (floor: ReadonlySet<string> | undefined) => [
			...(floor ?? new Set(['no floor minted'])),
		];
		expect(pairsOf(await subdatumReadFloor(FLOOR_USER, implicitSource))).toEqual([]);
		expect(
			pairsOf(await asRequest(SUPERUSER, () => subdatumReadFloor(FLOOR_USER, implicitSource))),
		).toEqual([]);
		const hitRqo = autocomplete('zzroot alpha*', ROOT_HIDDEN_LEAF, implicitSource);
		const missRqo = autocomplete('zzroot alphx*', ROOT_HIDDEN_LEAF, implicitSource);
		expect(await readIds(hitRqo, FLOOR_USER)).toEqual(await readIds(missRqo, FLOOR_USER));
	});
	test("NOT OVER-EAGER: a VIRTUAL section source (zzvmain1 → test3) borrows test3's components and mints the floor", async () => {
		expect(await getPermissions(FLOOR_USER, VIRTUAL_MAIN, FLOOR_FILTER_BY_LIST_SOURCE)).toBe(1);
		const source = {
			...portalSource,
			section_tipo: VIRTUAL_MAIN,
			tipo: FLOOR_FILTER_BY_LIST_SOURCE,
		};
		const hit = await readIds(autocomplete('zzroot alpha*', ROOT_HIDDEN_LEAF, source), FLOOR_USER);
		const miss = await readIds(autocomplete('zzroot alphx*', ROOT_HIDDEN_LEAF, source), FLOOR_USER);
		expect({ hitFinds: hit.includes(alphaId), missFinds: miss.includes(alphaId) }).toEqual({
			hitFinds: true,
			missFinds: false,
		});
	});

	// "ANY COMPONENT" INCLUDES THE METADATA RELATIONS. An absent-from_component
	// relation leaf on a dd128 locator (created by, dd200, lives OUTSIDE test3's
	// subtree) is served to a non-admin whose profile hides another relation
	// component (test91): the granted list must still carry dd200/dd197, or her
	// answer silently drops every record she created.
	test('RELATION leaf, ABSENT from_component_tipo, a created-by (dd200) locator: SERVED as the superuser answers', async () => {
		expect(await getPermissions(SCOPED, SECTION, ROOT_SELECT)).toBe(0);
		const createdBy = (sectionId: number) =>
			relationLeaf({ section_tipo: USERS_SECTION, section_id: sectionId });
		const mine = (ids: number[]) => ids.filter((id) => id === alphaId || id === betaId);
		const control = mine(
			await idsOf(await buildSearchSql(rootSqo(createdBy(-1)), { principal: SUPERUSER })),
		);
		expect(control).toContain(alphaId);
		expect(
			mine(await idsOf(await buildSearchSql(rootSqo(createdBy(-1)), { principal: SCOPED }))),
		).toEqual(control);
		expect(
			mine(await idsOf(await buildSearchSql(rootSqo(createdBy(931099)), { principal: SCOPED }))),
		).toEqual([]);
	});

	// ── SOME MAINS GRANT, SOME DO NOT (SEC-1's row keying) ───────────────────
	// An SQO over [test3, test65]: test65 grants her test162 / test91, test3 does
	// not. The predicate must hold ONLY on the granted main's rows — on test3 rows
	// HIT and MISS are the same answer (with the loud notice), the sibling's rows
	// are still FILTERED (hit finds it, miss does not), and the superuser's test3
	// answers differ. Dropping the row binding (the `some` verdict's section IN,
	// or `r.section_tipo` in a per-section relation condition) reopens the oracle
	// on test3 rows here.
	const multiSqo = (leaf: Record<string, unknown>, wrap: '$and' | '$not' = '$and') =>
		sanitizeClientSqo({
			section_tipo: [SECTION, SPOOF_GRANTED_SECTION],
			limit: 200,
			offset: 0,
			filter: wrap === '$and' ? { $and: [leaf] } : { $and: [{ $not: [leaf] }] },
		} as never);
	const onTest3 = (ids: number[]) => ids.filter((id) => id === alphaId || id === betaId);
	async function multiMainLeg(hitLeaf: object, missLeaf: object, wrap: '$and' | '$not' = '$and') {
		const { runWithRequestContext } = await import('../../src/core/security/request_context.ts');
		const { frontierRefusalNotice } = await import('../../src/core/security/frontier_scope.ts');
		const scoped = async (leaf: object) =>
			runWithRequestContext(
				{ session: null, requestId: 'zzroot-multi', clientIp: '', principal: SCOPED },
				async () => ({
					ids: await idsOf(
						await buildSearchSql(multiSqo(leaf as never, wrap), { principal: SCOPED }),
					),
					notice: frontierRefusalNotice()?.code,
				}),
			);
		const hit = await scoped(hitLeaf);
		const miss = await scoped(missLeaf);
		const control = async (leaf: object) =>
			onTest3(
				await idsOf(await buildSearchSql(multiSqo(leaf as never, wrap), { principal: SUPERUSER })),
			);
		return {
			test3Blind: JSON.stringify(onTest3(hit.ids)) === JSON.stringify(onTest3(miss.ids)),
			loud: hit.notice,
			siblingFiltered: hit.ids.includes(SIBLING_ID) !== miss.ids.includes(SIBLING_ID),
			controlSees:
				(await control(hitLeaf)).includes(alphaId) !== (await control(missLeaf)).includes(alphaId),
		};
	}
	const MULTI_OK: Awaited<ReturnType<typeof multiMainLeg>> = {
		test3Blind: true,
		loud: 'perm.out_of_scope',
		siblingFiltered: true,
		controlSees: true,
	};

	test('MULTI-MAIN non-degeneracy: the sibling is hers to list and grants what test3 hides', async () => {
		expect(await getPermissions(SCOPED, SPOOF_GRANTED_SECTION, SPOOF_GRANTED_SECTION)).toBe(1);
		expect(await getPermissions(SCOPED, SPOOF_GRANTED_SECTION, ROOT_HIDDEN_LEAF)).toBe(1);
		expect(await getPermissions(SCOPED, SPOOF_GRANTED_SECTION, ROOT_SELECT)).toBe(1);
		expect(await getPermissions(SCOPED, SECTION, ROOT_HIDDEN_LEAF)).toBe(0);
		const listed = await idsOf(
			await buildSearchSql(multiSqo({ q: '', path: [] } as never), { principal: SCOPED }),
		);
		expect([alphaId, betaId, SIBLING_ID].every((id) => listed.includes(id))).toBe(true);
	});

	for (const [label, hit, miss] of [
		['begins-with', 'zzroot alpha*', 'zzroot alphx*'],
		['equality', `'${ROOT_ALPHA}'`, `'${ROOT_ALPHA}x'`],
		['contains', '*alpha heritage*', '*alphx heritage*'],
	] as const) {
		test(`MULTI-MAIN string leaf (${label}): test3 rows blind, the sibling filtered, the CONTROL sees`, async () => {
			expect(await multiMainLeg(stringLeaf(hit), stringLeaf(miss))).toEqual(MULTI_OK);
		});
	}
	test('MULTI-MAIN string leaf under $not: test3 rows blind, the sibling filtered, the CONTROL sees', async () => {
		expect(
			await multiMainLeg(stringLeaf('zzroot alpha*'), stringLeaf('zzroot alphx*'), '$not'),
		).toEqual(MULTI_OK);
	});
	for (const [shape, hitQ, missQ] of [
		[
			'explicit hidden-on-test3 from_component_tipo',
			{ section_tipo: 'dd64', section_id: 1, from_component_tipo: ROOT_SELECT },
			{ section_tipo: 'dd64', section_id: 3, from_component_tipo: ROOT_SELECT },
		],
		[
			'absent from_component_tipo',
			{ section_tipo: 'dd64', section_id: 1 },
			{ section_tipo: 'dd64', section_id: 3 },
		],
	] as const) {
		test(`MULTI-MAIN relation leaf (${shape}): test3 rows blind, the sibling filtered, the CONTROL sees`, async () => {
			expect(await multiMainLeg(relationLeaf(hitQ), relationLeaf(missQ))).toEqual(MULTI_OK);
		});
	}

	// ── ORDER over SOME mains (review r7): fail-closed, never "some" ─────────
	// test65 grants her test162, test3 does not. Sorting the MIXED result by
	// test162 would rank her test3 rows by values she cannot read (the relative
	// order IS the comparison oracle), so a root order key granted on only some
	// mains is DROPPED: her rows keep the default order under ASC and DESC alike,
	// while the superuser's are really sorted.
	test('MULTI-MAIN ORDER on test162 (granted on the sibling only): dropped — ASC == DESC == the default order; the CONTROL sorts', async () => {
		const rawOrder = async (direction: 'ASC' | 'DESC' | null, principal: Principal) => {
			const built = await buildSearchSql(
				sanitizeClientSqo({
					section_tipo: [SECTION, SPOOF_GRANTED_SECTION],
					limit: 200,
					...(direction === null
						? {}
						: {
								order: [
									{
										direction,
										path: [{ section_tipo: SECTION, component_tipo: ROOT_HIDDEN_LEAF }],
									},
								],
							}),
				} as never),
				{ principal },
			);
			const rows = (await sql.unsafe(built.sql, built.params as (string | number | null)[])) as {
				section_tipo: string;
				section_id: number | string;
			}[];
			return rows
				.map((row) => `${row.section_tipo}/${Number(row.section_id)}`)
				.filter((key) =>
					[
						`${SECTION}/${alphaId}`,
						`${SECTION}/${betaId}`,
						`${SPOOF_GRANTED_SECTION}/${SIBLING_ID}`,
					].includes(key),
				);
		};
		const scopedDefault = await rawOrder(null, SCOPED);
		expect(scopedDefault).toHaveLength(3);
		expect({
			asc: await rawOrder('ASC', SCOPED),
			desc: await rawOrder('DESC', SCOPED),
		}).toEqual({ asc: scopedDefault, desc: scopedDefault });
		// CONTROL: the key is real — the superuser's test3 rows reverse.
		const onTest3Keys = (keys: string[]) => keys.filter((key) => key.startsWith(`${SECTION}/`));
		expect(onTest3Keys(await rawOrder('ASC', SUPERUSER))).toEqual([
			`${SECTION}/${alphaId}`,
			`${SECTION}/${betaId}`,
		]);
		expect(onTest3Keys(await rawOrder('DESC', SUPERUSER))).toEqual([
			`${SECTION}/${betaId}`,
			`${SECTION}/${alphaId}`,
		]);
	});

	// ── a VIRTUAL main (review r7): "any component" walks the REAL section ──
	// zzvmain1 is virtual over test3 and owns no component: the relation
	// components its rows carry are test3's. Were "any component" asked of the
	// virtual's OWN subtree only, the granted list (the metadata relations) would
	// equal the whole list, the key would read "unrestricted", and the hidden
	// test91 locator would be searchable again through an absent-from leaf.
	test('VIRTUAL MAIN, ABSENT from_component_tipo: a relation component hidden on the REAL section stays hidden; the CONTROL sees', async () => {
		const { getSectionRealTipo } = await import('../../src/core/ontology/resolver.ts');
		const { runWithRequestContext } = await import('../../src/core/security/request_context.ts');
		const { frontierRefusalNotice } = await import('../../src/core/security/frontier_scope.ts');
		expect(await getSectionRealTipo(VIRTUAL_MAIN)).toBe(SECTION);
		expect(await getPermissions(SCOPED, VIRTUAL_MAIN, VIRTUAL_MAIN)).toBe(1);
		expect(await getPermissions(SCOPED, VIRTUAL_MAIN, HOP_COMPONENT)).toBe(1);
		expect(await getPermissions(SCOPED, VIRTUAL_MAIN, ROOT_SELECT)).toBe(0);
		const virtualSqo = (q: Record<string, unknown> | null) =>
			sanitizeClientSqo({
				section_tipo: [VIRTUAL_MAIN],
				limit: 200,
				...(q === null
					? {}
					: {
							filter: {
								$and: [
									{
										q,
										format: 'relation',
										path: [{ section_tipo: VIRTUAL_MAIN, component_tipo: HOP_COMPONENT }],
									},
								],
							},
						}),
			} as never);
		// Non-degeneracy: the virtual record is hers to list.
		expect(await idsOf(await buildSearchSql(virtualSqo(null), { principal: SCOPED }))).toContain(
			VIRTUAL_ID,
		);
		const hitQ = { section_tipo: 'dd64', section_id: 1 };
		const missQ = { section_tipo: 'dd64', section_id: 3 };
		const scoped = async (q: Record<string, unknown>) =>
			runWithRequestContext(
				{ session: null, requestId: 'zzroot-virtual', clientIp: '', principal: SCOPED },
				async () => ({
					ids: await idsOf(await buildSearchSql(virtualSqo(q), { principal: SCOPED })),
					notice: frontierRefusalNotice()?.code,
				}),
			);
		const hit = await scoped(hitQ);
		const miss = await scoped(missQ);
		expect({
			blind: JSON.stringify(hit.ids) === JSON.stringify(miss.ids),
			loud: hit.notice,
		}).toEqual({
			blind: true,
			loud: 'perm.out_of_scope',
		});
		expect(await idsOf(await buildSearchSql(virtualSqo(hitQ), { principal: SUPERUSER }))).toContain(
			VIRTUAL_ID,
		);
		expect(
			await idsOf(await buildSearchSql(virtualSqo(missQ), { principal: SUPERUSER })),
		).not.toContain(VIRTUAL_ID);
	});

	// ── the refusal law's SHAPE (review r7): `1=0`, never a dropped leaf ─────
	// Every hidden-root leg above holds nothing but the leaf, where a DROPPED
	// leaf (no predicate) also gives hit == miss — both return everything. Next
	// to a granted leaf under `$and`, a dropped hidden leaf WIDENS the answer to
	// what the granted leaf alone matches; `1=0` keeps it EMPTY.
	test('a refused ROOT leaf is 1=0, not dropped: under $and beside a GRANTED leaf matching alpha, her answer is EMPTY; the CONTROL finds alpha', async () => {
		const granted = {
			q: 'zzroot alpha*',
			path: [{ section_tipo: SECTION, component_tipo: LEAF_COMPONENT }],
		};
		const both = sanitizeClientSqo({
			section_tipo: [SECTION],
			limit: 200,
			offset: 0,
			filter: { $and: [stringLeaf('zzroot alpha*'), granted] },
		} as never);
		// Non-degeneracy: the granted leaf ALONE finds alpha for her.
		expect(await idsOf(await buildSearchSql(rootSqo(granted), { principal: SCOPED }))).toContain(
			alphaId,
		);
		expect(await idsOf(await buildSearchSql(both, { principal: SCOPED }))).toEqual([]);
		expect(await idsOf(await buildSearchSql(both, { principal: SUPERUSER }))).toContain(alphaId);
	});

	// ── the mains are REQUIRED (review r7): a scope without them is refused ──
	// The SEC-1 keys are asked of the SQO's own sections. A principal-bearing
	// scope that cannot name them (a second scope builder that forgets the key,
	// a cast) must never be conformed UNKEYED — that silently re-opens the
	// root-step oracle. It is an engine invariant breach: internal.invariant.
	test('a principal-bearing scope WITHOUT mainSectionTipos is REFUSED (internal.invariant) — never conformed unkeyed', async () => {
		const { conformFilter, rootOrderStepAllowed } = await import(
			'../../src/core/search/conform.ts'
		);
		const scope = {
			principal: SCOPED,
			surface: 'search',
			door: 'zzroot.no_mains',
			recordPredicate: async () => '',
		} as unknown as Parameters<typeof rootOrderStepAllowed>[0];
		const codeOf = async (run: () => Promise<unknown>) => {
			try {
				await run();
				return 'served';
			} catch (error) {
				return (error as { code?: string }).code ?? String(error);
			}
		};
		expect({
			order: await codeOf(() =>
				rootOrderStepAllowed(
					scope,
					[{ section_tipo: SECTION, component_tipo: ROOT_HIDDEN_LEAF }],
					SECTION_TABLE,
				),
			),
			filter: await codeOf(() =>
				conformFilter({ $and: [stringLeaf('zzroot alpha*')] }, 'mix', SECTION_TABLE, scope),
			),
		}).toEqual({ order: 'internal.invariant', filter: 'internal.invariant' });
	});
});
