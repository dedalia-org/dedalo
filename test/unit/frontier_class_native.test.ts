/**
 * THE FRONTIER CLASS — one behavioural probe, three surfaces (2026-08-28).
 *
 * WHY A CLASS GATE AND NOT THREE MORE SITE GATES. Four ACL-at-the-frontier
 * defects were found in one audit round; two were fixed with two different
 * shapes, and a class review found a fourth nobody had named. The per-site
 * gates (search_path_acl_native, export_gate_b_native) assert STRUCTURE — that
 * a join alias carries a predicate, that a declared segment is refused. None of
 * them can say the thing the class is actually about:
 *
 *     A CALLER MUST NOT BE ABLE TO TELL, FROM ANY SURFACE'S ANSWER, WHAT A
 *     RECORD THEY MAY NOT READ CONTAINS.
 *
 * So this file asks that question the only way it can be answered — by CHANGING
 * the hidden value and looking at the bytes. The same hidden record is written
 * with sentinel ALPHA, the surface is exercised, its answer is serialized; then
 * the record is written with sentinel BRAVO and the surface is exercised again.
 * For a scoped caller the two answers must be BYTE-IDENTICAL and must contain
 * neither sentinel. A structural gate cannot be fooled into passing here: the
 * assertion is over the observable answer, whatever produced it.
 *
 * NON-DEGENERACY IS PART OF THE GATE, not a side note. A probe that compares
 * two empty strings passes for the wrong reason forever — that is the
 * green-suite trap the foundation audit named (S2-40). So EVERY surface runs
 * the identical pair of probes as a GLOBAL ADMIN, and the admin's two answers
 * are REQUIRED TO DIFFER. If they do not, the probe is not measuring anything
 * and this file is red — regardless of what the scoped half did.
 *
 * THE THREE SURFACES and the refusal law each one obeys
 * (src/core/security/frontier_scope.ts, property 3):
 *
 *   SEARCH     a two-hop filter path whose leaf reads the hidden record's
 *              component. Hit and miss must be the same answer.
 *   EXPORT     a tool_export ddo path across the same hop. The export THROWS
 *              `perm.denied` — a deliverable is never quietly short — so its
 *              serialized answer is the refusal itself, which is identical for
 *              both sentinels and names neither.
 *   DIFFUSION  a publication run whose FRONTIER drains into a section the
 *              caller holds no grant on. The row is DROPPED and ledgered, and
 *              the published rows never carry the sentinel.
 *
 * THE SITUATION IS BUILT, NEVER ASSUMED (AGENTS.md). Two situations, both on
 * the generic `test` TLD:
 *   - search/export: this file's own users / profiles / projects / test3
 *     records in the reserved band 932000-932099, swept with a
 *     throw-if-nothing-deleted;
 *   - diffusion: the repo-owned `zzdif` domain helper (its own reserved band),
 *     plus this file's scoped identity.
 * No installation tipo is named anywhere.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sanitizeClientSqo } from '../../src/core/concepts/sqo.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { clearUserFilterRecordsCache } from '../../src/core/security/filter_records.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
	type Principal,
} from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import type { ToolActionContext, ToolResponse } from '../../src/core/tools/module.ts';
import { compileElementPlan } from '../../src/diffusion/plan/compile.ts';
import type { PublicationPlan } from '../../src/diffusion/plan/types.ts';
import type { VirtualDiffusionTree } from '../../src/diffusion/plan/virtual_tree.ts';
import { buildVirtualDiffusionTree } from '../../src/diffusion/plan/virtual_tree.ts';
import { resolvePublication } from '../../src/diffusion/resolve/resolver.ts';
import { toolExportGetExportGrid } from '../../tools/tool_export/server/tool_export.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';
import {
	dropZzdifDomain,
	ensureZzdifDomain,
	ZZDIF_DOMAIN_NAME,
	ZZDIF_ELEMENT,
	ZZDIF_LINKED_IDS,
	ZZDIF_LINKED_SECTION,
	ZZDIF_PUBLISHABLE_ID,
	ZZDIF_SECTION,
} from '../helpers/zzdif_diffusion_domain.ts';

// --- the two sentinels -----------------------------------------------------

/**
 * The two values the hidden record is written with, in turn. They share NO
 * substring beyond the common stem, so "the answer contains neither" and "the
 * two answers are equal" are independent facts and one cannot mask the other.
 */
const SENTINEL_ALPHA = 'zzfrontier alpha kestrel manuscript';
const SENTINEL_BRAVO = 'zzfrontier bravo obsidian reliquary';
/** Everything this file writes carries it — the sweep is keyed on ids, not this. */
const STEM = 'zzfrontier';

// --- the search / export situation ----------------------------------------

const SCRATCH_FLOOR = 932000;
const SCRATCH_CEILING = 932099;

const USERS_SECTION = 'dd128';
const PROFILES_SECTION = 'dd234';
const PROJECTS_SECTION = 'dd153';
const YES_NO_SECTION = 'dd64';

/** The playground section: project-gated by `test101`, table `matrix_test`. */
const SECTION = 'test3';
const SECTION_TABLE = 'matrix_test';
const FILTER_COMPONENT = 'test101';
/** component_relation_related — the HOP that stores the frontier locator. */
const HOP_COMPONENT = 'test54';
/** component_input_text — the LEAF that holds the sentinel. */
const LEAF_COMPONENT = 'test52';

const SCOPED_USER_ID = 932001;
const ADMIN_USER_ID = 932002;
const SCOPED_PROFILE_ID = 932011;
const ADMIN_PROFILE_ID = 932012;
const MY_PROJECT_ID = 932021;
const OTHER_PROJECT_ID = 932022;
/** In MY project; hops to the hidden record. The caller MAY list this one. */
const MAIN_ID = 932031;
/** In the OTHER project; holds the sentinel. The caller may NOT read it. */
const HIDDEN_ID = 932032;

const SCOPED: Principal = { userId: SCOPED_USER_ID, isGlobalAdmin: false, isDeveloper: false };
const ADMIN: Principal = { userId: ADMIN_USER_ID, isGlobalAdmin: true, isDeveloper: false };

const OWNED: { table: string; sectionTipo: string; sectionId: number }[] = [
	{ table: 'matrix_users', sectionTipo: USERS_SECTION, sectionId: SCOPED_USER_ID },
	{ table: 'matrix_users', sectionTipo: USERS_SECTION, sectionId: ADMIN_USER_ID },
	{ table: 'matrix_profiles', sectionTipo: PROFILES_SECTION, sectionId: SCOPED_PROFILE_ID },
	{ table: 'matrix_profiles', sectionTipo: PROFILES_SECTION, sectionId: ADMIN_PROFILE_ID },
	{ table: 'matrix_projects', sectionTipo: PROJECTS_SECTION, sectionId: MY_PROJECT_ID },
	{ table: 'matrix_projects', sectionTipo: PROJECTS_SECTION, sectionId: OTHER_PROJECT_ID },
	{ table: SECTION_TABLE, sectionTipo: SECTION, sectionId: MAIN_ID },
	{ table: SECTION_TABLE, sectionTipo: SECTION, sectionId: HIDDEN_ID },
];

/**
 * The scratch band, ENFORCED before any INSERT or DELETE. The sweep deletes by
 * (section_tipo, section_id) on the SHARED suite database, so an id edited down
 * into the installed band would destroy a real users/profiles/projects/test3
 * record.
 */
function assertScratchIds(): void {
	for (const record of OWNED) {
		if (
			!Number.isInteger(record.sectionId) ||
			record.sectionId < SCRATCH_FLOOR ||
			record.sectionId > SCRATCH_CEILING
		) {
			throw new Error(
				`frontier_class gate: ${record.table}/${record.sectionTipo} id ${record.sectionId} is outside the reserved band ${SCRATCH_FLOOR}-${SCRATCH_CEILING} — refusing to touch a record this gate does not own`,
			);
		}
	}
}

const locator = (
	componentTipo: string,
	sectionTipo: string,
	sectionId: number,
	type = 'dd151',
) => ({
	id: 1,
	type,
	section_id: sectionId,
	section_tipo: sectionTipo,
	from_component_tipo: componentTipo,
});

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

const grant = (id: number, sectionTipo: string, tipo: string, value: number) => ({
	id,
	tipo,
	section_tipo: sectionTipo,
	value,
});

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
			`frontier_class gate: the sweep deleted NOTHING for ${missing.join(', ')} — a filter that matches nothing is the bug, not a clean tree`,
		);
	}
}

async function install(): Promise<void> {
	await assertTestDatabase('frontier_class_native');
	assertScratchIds();
	await purge(false); // a crashed previous run

	for (const projectId of [MY_PROJECT_ID, OTHER_PROJECT_ID]) {
		await insertScratch('matrix_projects', PROJECTS_SECTION, projectId, {
			string: { dd156: [{ id: 1, lang: 'lg-eng', value: `${STEM} project ${projectId}` }] },
		});
	}

	// The scoped profile grants EXACTLY what a lawful crossing needs — the
	// section, the hop and the leaf — and NOTHING on the diffusion frontier's
	// linked section, which is what makes the diffusion drop happen for a
	// COMPONENT-key reason rather than by accident.
	await insertScratch('matrix_profiles', PROFILES_SECTION, SCOPED_PROFILE_ID, {
		string: { dd237: [{ id: 1, lang: 'lg-eng', value: `${STEM} scoped profile` }] },
		misc: {
			dd774: [
				grant(1, SECTION, SECTION, 2),
				grant(2, SECTION, HOP_COMPONENT, 2),
				grant(3, SECTION, LEAF_COMPONENT, 2),
				grant(4, SECTION, FILTER_COMPONENT, 2),
				grant(5, ZZDIF_SECTION, ZZDIF_SECTION, 2),
			],
		},
	});
	await insertScratch('matrix_profiles', PROFILES_SECTION, ADMIN_PROFILE_ID, {
		string: { dd237: [{ id: 1, lang: 'lg-eng', value: `${STEM} admin profile` }] },
		misc: {
			dd774: [
				grant(1, SECTION, SECTION, 3),
				grant(2, SECTION, HOP_COMPONENT, 3),
				grant(3, SECTION, LEAF_COMPONENT, 3),
				grant(4, SECTION, FILTER_COMPONENT, 3),
				grant(5, ZZDIF_SECTION, ZZDIF_SECTION, 3),
				grant(6, ZZDIF_LINKED_SECTION, ZZDIF_LINKED_SECTION, 3),
			],
		},
	});

	await insertScratch('matrix_users', USERS_SECTION, SCOPED_USER_ID, {
		string: { dd132: [{ id: 1, lang: 'lg-nolan', value: `${STEM}_scoped` }] },
		relation: {
			dd131: [locator('dd131', YES_NO_SECTION, 1)],
			dd244: [locator('dd244', YES_NO_SECTION, 2)], // present-but-negative admin flag
			dd515: [locator('dd515', YES_NO_SECTION, 2)],
			dd1725: [locator('dd1725', PROFILES_SECTION, SCOPED_PROFILE_ID)],
			dd170: [locator('dd170', PROJECTS_SECTION, MY_PROJECT_ID)],
		},
	});
	await insertScratch('matrix_users', USERS_SECTION, ADMIN_USER_ID, {
		string: { dd132: [{ id: 1, lang: 'lg-nolan', value: `${STEM}_admin` }] },
		relation: {
			dd131: [locator('dd131', YES_NO_SECTION, 1)],
			dd244: [locator('dd244', YES_NO_SECTION, 1)],
			dd515: [locator('dd515', YES_NO_SECTION, 2)],
			dd1725: [locator('dd1725', PROFILES_SECTION, ADMIN_PROFILE_ID)],
			dd170: [locator('dd170', PROJECTS_SECTION, MY_PROJECT_ID)],
		},
	});

	const inProject = (projectId: number) => [
		locator(FILTER_COMPONENT, PROJECTS_SECTION, projectId, 'dd675'),
	];
	await insertScratch(SECTION_TABLE, SECTION, MAIN_ID, {
		relation: {
			[FILTER_COMPONENT]: inProject(MY_PROJECT_ID),
			[HOP_COMPONENT]: [locator(HOP_COMPONENT, SECTION, HIDDEN_ID)],
		},
		string: { [LEAF_COMPONENT]: [{ id: 1, lang: 'lg-eng', value: `${STEM} main` }] },
		data: { label: `${STEM} main`, section_tipo: SECTION },
	});
	await insertScratch(SECTION_TABLE, SECTION, HIDDEN_ID, {
		relation: { [FILTER_COMPONENT]: inProject(OTHER_PROJECT_ID) },
		string: { [LEAF_COMPONENT]: [{ id: 1, lang: 'lg-eng', value: SENTINEL_ALPHA }] },
		data: { label: `${STEM} hidden`, section_tipo: SECTION },
	});

	clearCaches();
}

/** Write one sentinel into the record the caller may not read. */
async function setHiddenValue(value: string): Promise<void> {
	const updated = (await sql.unsafe(
		`UPDATE "${SECTION_TABLE}" SET "string" = $1::text::jsonb
		 WHERE section_tipo = $2 AND section_id = $3 RETURNING section_id`,
		[encodeForJsonb({ [LEAF_COMPONENT]: [{ id: 1, lang: 'lg-eng', value }] }), SECTION, HIDDEN_ID],
	)) as unknown[];
	if (updated.length !== 1) {
		throw new Error(
			`frontier_class gate: the sentinel write touched ${updated.length} rows — the hidden record is not where this gate thinks it is, so every probe below would be vacuous`,
		);
	}
}

/** Write one sentinel into the DIFFUSION frontier's linked record. */
async function setLinkedValue(value: string): Promise<void> {
	const linkedId = ZZDIF_LINKED_IDS[0] as number;
	const updated = (await sql.unsafe(
		`UPDATE "${SECTION_TABLE}" SET "string" = $1::text::jsonb
		 WHERE section_tipo = $2 AND section_id = $3 RETURNING section_id`,
		[encodeForJsonb({ zzdif21: [{ value, lang: 'lg-spa' }] }), ZZDIF_LINKED_SECTION, linkedId],
	)) as unknown[];
	if (updated.length !== 1) {
		throw new Error(
			`frontier_class gate: the diffusion sentinel write touched ${updated.length} rows — the zzdif linked record is missing, so the diffusion probe would be vacuous`,
		);
	}
}

// --- the three surface adapters -------------------------------------------
//
// Each returns the SERIALIZED answer a caller observes. What is serialized is
// deliberately generous (rows, ids, values, refusal codes): the assertion is
// "these bytes are the same", so anything the surface could leak through must
// be inside them.

/** SEARCH: a two-hop filter whose leaf probes the hidden value. */
async function searchAnswer(principal: Principal, probe: string): Promise<string> {
	const sqo = sanitizeClientSqo({
		section_tipo: [SECTION],
		limit: 50,
		offset: 0,
		filter: {
			$and: [
				{
					q: probe,
					path: [
						{ section_tipo: SECTION, component_tipo: HOP_COMPONENT },
						{ section_tipo: SECTION, component_tipo: LEAF_COMPONENT },
					],
				},
			],
		},
	} as never);
	const built = await buildSearchSql(sqo, { principal });
	const rows = (await sql.unsafe(built.sql, built.params as (string | number | null)[])) as Record<
		string,
		unknown
	>[];
	return JSON.stringify(rows.map((row) => Number(row.section_id)).sort((a, b) => a - b));
}

const contextOf = (options: Record<string, unknown>, principal: Principal): ToolActionContext =>
	({ principal, userId: principal.userId, options, background: false }) as ToolActionContext;

/** EXPORT: the same hop as a tool_export ddo path over the MAIN record. */
async function exportAnswer(principal: Principal): Promise<string> {
	const options = {
		section_tipo: SECTION,
		lang: 'lg-eng',
		data_format: 'value',
		breakdown: 'default',
		ar_ddo_to_export: [
			{
				path: [
					{ section_tipo: SECTION, component_tipo: HOP_COMPONENT },
					{ section_tipo: SECTION, component_tipo: LEAF_COMPONENT },
				],
			},
		],
		sqo: {
			section_tipo: [SECTION],
			filter_by_locators: [{ section_tipo: SECTION, section_id: MAIN_ID }],
			limit: 10,
			offset: 0,
		},
	};
	try {
		const response: ToolResponse = await toolExportGetExportGrid(contextOf(options, principal));
		return `OK:${JSON.stringify(response.data)}`;
	} catch (error) {
		// The EXPORT refusal law: a refusal IS the answer, and it must be the
		// same answer whichever sentinel the hidden record holds.
		const code = (error as { code?: string }).code ?? 'unknown';
		return `REFUSED:${code}`;
	}
}

let tree: VirtualDiffusionTree;
let plan: PublicationPlan;

/** DIFFUSION: a publication run whose frontier drains into the linked section. */
async function diffusionAnswer(principal: Principal): Promise<string> {
	const emitted: unknown[] = [];
	for await (const batch of resolvePublication(plan, {
		sectionTipo: ZZDIF_SECTION,
		runStartedAt: 1_751_700_000,
		tree,
		principal,
		maxLevels: 1,
		sqo: {
			section_tipo: ZZDIF_SECTION,
			filter_by_locators: [
				{ section_tipo: ZZDIF_SECTION, section_id: String(ZZDIF_PUBLISHABLE_ID) },
			],
		},
	})) {
		emitted.push({
			section: batch.section.sectionTipo,
			records: batch.records.map((record) => ({
				id: record.sectionId,
				status: record.status,
			})),
			rows: batch.rows.map((row) => ({ id: row.sectionId, columns: row.columns })),
		});
	}
	return JSON.stringify(emitted);
}

/** Run one surface twice, once per sentinel. */
async function bothSentinels(
	write: (value: string) => Promise<void>,
	run: () => Promise<string>,
): Promise<[string, string]> {
	await write(SENTINEL_ALPHA);
	const alpha = await run();
	await write(SENTINEL_BRAVO);
	const bravo = await run();
	return [alpha, bravo];
}

describe.if(DB_READY)('THE FRONTIER CLASS — a hidden value is invisible on every surface', () => {
	beforeAll(async () => {
		await install();
		await ensureZzdifDomain();
		const built = await buildVirtualDiffusionTree(ZZDIF_DOMAIN_NAME);
		if (built === null) {
			throw new Error(`no dd1190 domain node is named '${ZZDIF_DOMAIN_NAME}'`);
		}
		tree = built;
		plan = await compileElementPlan(ZZDIF_ELEMENT, { tree });
	}, 180_000);

	afterAll(async () => {
		await purge(true);
		expect(await dropZzdifDomain()).toBe(0);
		clearCaches();
	});

	test('the situation is real: the scoped caller may list MAIN and may not read HIDDEN', async () => {
		// Without this the whole file could pass at empty-versus-empty.
		const { principalCanAccessRecord } = await import('../../src/core/security/record_scope.ts');
		expect(await principalCanAccessRecord(SECTION, MAIN_ID, SCOPED)).toBe(true);
		expect(await principalCanAccessRecord(SECTION, HIDDEN_ID, SCOPED)).toBe(false);
		expect(SCOPED.isGlobalAdmin).toBe(false);
		expect(ADMIN.isGlobalAdmin).toBe(true);
	});

	test('SEARCH: the two sentinels give the scoped caller ONE answer, and the admin TWO', async () => {
		// The probe asks for ALPHA both times. If the hop leaked, the run holding
		// ALPHA would match and the run holding BRAVO would not.
		const [alpha, bravo] = await bothSentinels(setHiddenValue, () =>
			searchAnswer(SCOPED, `'${SENTINEL_ALPHA}'`),
		);
		expect(alpha).toBe(bravo);
		expect(alpha).not.toContain(STEM);

		const [adminAlpha, adminBravo] = await bothSentinels(setHiddenValue, () =>
			searchAnswer(ADMIN, `'${SENTINEL_ALPHA}'`),
		);
		expect(
			adminAlpha,
			'the admin probes did not differ — the probe measures nothing and the scoped equality above is vacuous',
		).not.toBe(adminBravo);
		expect(adminAlpha).toContain(String(MAIN_ID));
	}, 120_000);

	test('EXPORT: the two sentinels give the scoped caller ONE answer, and the admin TWO', async () => {
		const [alpha, bravo] = await bothSentinels(setHiddenValue, () => exportAnswer(SCOPED));
		expect(alpha).toBe(bravo);
		expect(alpha).not.toContain(STEM);
		// The EXPORT law, stated: the refusal is the answer, not a short cell.
		expect(alpha.startsWith('REFUSED:')).toBe(true);
		expect(alpha).toBe('REFUSED:perm.denied');

		const [adminAlpha, adminBravo] = await bothSentinels(setHiddenValue, () => exportAnswer(ADMIN));
		expect(
			adminAlpha,
			'the admin exports did not differ — the export probe measures nothing',
		).not.toBe(adminBravo);
		expect(adminAlpha).toContain(SENTINEL_ALPHA);
		expect(adminBravo).toContain(SENTINEL_BRAVO);
	}, 120_000);

	test('DIFFUSION: the two sentinels give the scoped caller ONE answer, and the admin TWO', async () => {
		const [alpha, bravo] = await bothSentinels(setLinkedValue, () => diffusionAnswer(SCOPED));
		expect(alpha).toBe(bravo);
		expect(alpha).not.toContain(STEM);
		// …and the run still did its lawful work: the primary record published.
		expect(alpha).toContain(String(ZZDIF_PUBLISHABLE_ID));

		const [adminAlpha, adminBravo] = await bothSentinels(setLinkedValue, () =>
			diffusionAnswer(ADMIN),
		);
		expect(
			adminAlpha,
			'the admin diffusion runs did not differ — the frontier never drained, so the scoped equality is vacuous',
		).not.toBe(adminBravo);
		expect(adminAlpha).toContain(SENTINEL_ALPHA);
		expect(adminBravo).toContain(SENTINEL_BRAVO);
	}, 180_000);
});

/**
 * THE CLASS CENSUS — the frontier doors this batch did NOT close.
 *
 * AGENTS.md: an uncovered path throws loudly and gets a ledger line, and the
 * ledger line lives next to a gate that verifies it. `rewrite/` is gitignored
 * and no gate may read a path under it, so the residue of this class is
 * declared HERE, shrink-only. A door removed from this list must be closed, and
 * a NEW door may not be added without a fix landing with it.
 *
 * Each entry is a file this class review named that carries the same defect and
 * that the owning agent could not edit in this batch (the batch's file list is
 * disjoint from them by construction — they belong to the read path and the
 * identification subsystem, not to search/export/diffusion).
 */
const OPEN_FRONTIER_DOORS: readonly { file: string; why: string }[] = [
	// CLOSED 2026-09-03 (P1-3 / SEC-12): src/core/identify/path_read.ts now takes
	// a FrontierScope (`options.scope`, surface 'door') and authorizes every
	// landed record on its own section with the frontier's two keys — gated by
	// identify_path_read.test.ts "the LANDED section is authorized".
	{
		file: 'src/core/search/search_related.ts',
		why: 'the inverse/related scan takes no principal anywhere. Its user-facing doors scope its OUTPUT through record_scope.ts scopeInverseReferenceHits, so the leak is bounded to callers that forget to; the scan itself is unscoped by design and needs the scope threaded.',
	},
	{
		file: 'src/diffusion/export/grid.ts',
		why: "Gate B authorizes a DECLARED export column on the bare `getPermissions >= 1`, without the frontier's globally-visible exemptions. STRICTER than the frontier, therefore fail-closed and not a hole — reconciling it would WIDEN the export, which is a decision for the lead rather than a cleanup, and human_write_scope_tripwire's TOOLS-02 assertion pins the current call.",
	},
	{
		file: 'src/core/relations/request_config/implicit.ts',
		why: 'filterAuthorizedRelated answers the COMPONENT key with no frontier exemption, so a non-admin sees no project name in a component_filter widget. STRICTER than the frontier, therefore fail-closed and not a hole — but it is the same predicate answered twice and must adopt frontierComponentAllowed.',
	},
];

describe.if(DB_READY)('THE OTHER DIRECTION — the frontier refuses no lawful crossing', () => {
	beforeAll(install);
	afterAll(async () => {
		await purge(true);
		clearCaches();
	});

	test('a DANGLING locator does not kill the export', async () => {
		// A reference whose target was deleted is ordinary in heritage data. It
		// discloses nothing — there is no record to read — so refusing it would be
		// a guard that refuses lawful traffic, and it would take the WHOLE export
		// down with it (the export law is a throw).
		const missingId = SCRATCH_CEILING; // inside the band, deliberately unwritten
		const stillThere = (await sql.unsafe(
			`SELECT section_id FROM "${SECTION_TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, missingId],
		)) as unknown[];
		expect(stillThere.length, 'the "missing" id must really be missing').toBe(0);

		await sql.unsafe(
			`UPDATE "${SECTION_TABLE}" SET "relation" = $1::text::jsonb
			 WHERE section_tipo = $2 AND section_id = $3`,
			[
				encodeForJsonb({
					[FILTER_COMPONENT]: [locator(FILTER_COMPONENT, PROJECTS_SECTION, MY_PROJECT_ID, 'dd675')],
					[HOP_COMPONENT]: [locator(HOP_COMPONENT, SECTION, missingId)],
				}),
				SECTION,
				MAIN_ID,
			],
		);
		const answer = await exportAnswer(SCOPED);
		expect(answer.startsWith('OK:'), `a dangling locator refused the export: ${answer}`).toBe(true);
	});

	test('the ROOT USER locator is not refused (it resolves to a label, for anyone)', async () => {
		// PHP resolves dd128/-1 for any caller with section permission — an
		// activity / "who" chip must render — and record access to it stays
		// blocked by the assembler's own `section_id > 0`. The frontier's record
		// key goes through the SAME door that already carries this carve-out, so
		// it cannot be re-derived differently here.
		const { frontierRecordAllowed } = await import('../../src/core/security/frontier_scope.ts');
		const scope = { principal: SCOPED, surface: 'export', door: 'tool_export' } as const;
		expect(await frontierRecordAllowed(scope, USERS_SECTION, -1)).toBe(true);
		// Non-degenerate: an ORDINARY record outside her scope is still refused.
		expect(await frontierRecordAllowed(scope, SECTION, HIDDEN_ID)).toBe(false);
	});

	test('an INTERNAL crossing (no principal) is never gated', async () => {
		const { frontierRecordAllowed, frontierComponentAllowed } = await import(
			'../../src/core/security/frontier_scope.ts'
		);
		const internal = { surface: 'export', door: 'internal' } as const;
		expect(await frontierRecordAllowed(internal, SECTION, HIDDEN_ID)).toBe(true);
		expect(
			await frontierComponentAllowed(internal, {
				sectionTipo: PROFILES_SECTION,
				componentTipo: 'dd774',
			}),
		).toBe(true);
	});
});

describe('the frontier keys read ONE declaration', () => {
	test("the record key's exempt-table set is DERIVED from the frontier key's", async () => {
		// The over-refusal was two lists disagreeing. They are now one list plus
		// one stated addendum, and this is the assertion that keeps them tied: a
		// table added to either side without the other shows up here.
		const { FRONTIER_VISIBLE_TABLES } = await import('../../src/core/security/frontier_scope.ts');
		const { PROJECTS_FILTER_EXEMPT_TABLES } = await import(
			'../../src/core/search/sql_assembler.ts'
		);
		// Non-degenerate: both sets are real and non-trivial.
		expect(FRONTIER_VISIBLE_TABLES.size).toBeGreaterThanOrEqual(7);
		// The frontier set is a SUBSET — the component key may never exempt a
		// table the record key still gates.
		const notExemptForRecords = [...FRONTIER_VISIBLE_TABLES].filter(
			(table) => !PROJECTS_FILTER_EXEMPT_TABLES.has(table),
		);
		expect(
			notExemptForRecords,
			'a table the COMPONENT key waves through while the RECORD key still gates it — the component gate would be the looser of the two, which is the one direction that is a hole',
		).toEqual([]);
		// …and the difference is exactly the ONE stated addendum.
		const recordOnly = [...PROJECTS_FILTER_EXEMPT_TABLES].filter(
			(table) => !FRONTIER_VISIBLE_TABLES.has(table),
		);
		expect(
			recordOnly.length,
			`the record key exempts ${recordOnly.length} tables the frontier does not; exactly ONE is declared (the subsystem-owned activity-stats table). Reconcile the two lists rather than widening this number.`,
		).toBe(1);
	});
});

describe('the frontier class census is SHRINK-ONLY', () => {
	test('every open door names a real file and a reason', async () => {
		for (const door of OPEN_FRONTIER_DOORS) {
			expect(await Bun.file(door.file).exists(), `${door.file} does not exist`).toBe(true);
			expect(door.why.length).toBeGreaterThan(40);
		}
	});

	test('the census may only shrink', () => {
		// Measured 2026-08-28 at 4; path_read.ts closed 2026-09-03 (P1-3). Lower
		// this number when a door closes; raising it means a NEW frontier door
		// shipped unfixed, which this gate refuses.
		expect(OPEN_FRONTIER_DOORS.length).toBeLessThanOrEqual(3);
	});
});
