/**
 * T0-9 FIX ROUND A — the INTERACTIVE flat reader (resolve/relation_list.ts:
 * relation_list panel, Referencias, related labels) applies the edit form's
 * own rules, and terminates.
 *
 * Legs:
 *   A1 STEP 5 — an IMPLICIT child (config-less portal `relations`, config-less
 *      relation_index per-locator related_list columns) the requester holds no
 *      grant on is NOT resolved by the panel reader (resolveCellValue and
 *      buildRelationList), exactly as the edit form drops it
 *      (request_config/implicit.ts filterAuthorizedRelated — ONE predicate,
 *      the ALS principal, per call); a global admin sees it; the record's
 *      ADDRESS (an explicit child) always shows.
 *   A6 STEP 5 on the TOP-LEVEL columns — the pointing section's relation_list
 *      columns themselves: an ungranted column has neither a context column nor
 *      a data cell in the panel (buildRelationList) nor the related_search
 *      payload (buildRelatedSections) — resolve/relation_list.ts
 *      authorizedRelationListColumns, the same predicate
 *      (WC-2026-11-11-relation-list-column-grants).
 *   A2 CYCLE — config-less relation_index columns listed in their own
 *      section's relation_list, on records that point at each other (and at
 *      themselves): the reader terminates; the repeated record resolves to
 *      nothing and the cell notes `relation_cycle:<tipo>` (never a silent cut).
 *   A4 D11 — a ddo_map entry WITHOUT `parent` is NOT a child (PHP
 *      `parent === tipo`): config_children.ts isDirectConfigChild.
 *   A5 D12 — a config-less component_relation_parent THROWS
 *      `ontology.invalid_node` naming the node (PHP: v5 fallback refused).
 *
 * SITUATION (built, torn down, residue 0): scratch TLD `zzpsc`; records in
 * matrix_test at ids this file owns; the persona identity at 933900+.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { isDirectConfigChild } from '../../src/core/relations/config_children.ts';
import { buildRelatedSections } from '../../src/core/resolve/related_sections.ts';
import {
	buildRelationList,
	clearFieldsSeparatorCache,
	resolveCellValue,
} from '../../src/core/resolve/relation_list.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import {
	clearFrontierIdentityCaches,
	exportFrontierIdentity,
	type FrontierGrant,
} from '../helpers/export_frontier_identity.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const LANG = 'lg-eng';
const TLD = 'zzpsc';
const TABLE = 'matrix_test';

// T — the target section
const T = 'zzpsc1';
const T_LABEL = 'zzpsc2';
const T_SECRET = 'zzpsc3'; // NO grant for the scoped persona
const T_FILTER = 'zzpsc4';
const T_RL = 'zzpsc5'; // relation_list → [T_LABEL, T_SECRET]
const T_SID = 'zzpsc6'; // component_section_id (the pointer's address)
const T_PTR = 'zzpsc7'; // portal storing dd96 pointers (indexation)
const T_INDEX = 'zzpsc8'; // config-less relation_index
const T_IMPL = 'zzpsc9'; // config-less portal: relations [T, T_LABEL, T_SECRET]
const T_MAP = 'zzpsc10'; // D11: explicit map, one entry WITHOUT parent
const T_PARENT = 'zzpsc11'; // D12: config-less relation_parent
// Q — a section pointing at T (the panel host's referencing section)
const Q = 'zzpsc20';
const Q_FILTER = 'zzpsc21';
const Q_IMPL = 'zzpsc22'; // config-less portal → T [T_LABEL, T_SECRET]
const Q_RL = 'zzpsc23'; // relation_list → [Q_IMPL]
// C — the cycle section
const C = 'zzpsc30';
const C_FILTER = 'zzpsc31';
const C_PTR = 'zzpsc32'; // dd96 pointers
const C_INDEX = 'zzpsc33'; // config-less relation_index, listed in its own relation_list
const C_RL = 'zzpsc34'; // relation_list → [C_LABEL, C_INDEX]
const C_LABEL = 'zzpsc35';

const term = (value: string) => ({ [LANG]: value });
const gatedSection = (tipo: string, label: string) => ({
	tipo,
	parent: 'test1',
	model: 'section',
	term: term(label),
	relations: [{ tipo: 'test24' }],
});
const input = (tipo: string, parent: string, label: string) => ({
	tipo,
	parent,
	model: 'component_input_text',
	term: term(label),
	is_translatable: true,
});
const filter = (tipo: string, parent: string) => ({
	tipo,
	parent,
	model: 'component_filter',
	term: term(`${tipo} projects`),
});
const explicitConfig = (target: string, ddoMap: Record<string, unknown>[]) => ({
	source: {
		request_config: [
			{
				sqo: { section_tipo: [{ value: [target], source: 'section' }] },
				show: { ddo_map: ddoMap },
			},
		],
	},
});

const S = situation({
	name: 'T0-9 relation_list panel scope',
	tld: TLD,
	nodes: [
		gatedSection(T, 'zz psc target'),
		input(T_LABEL, T, 'zz psc label'),
		input(T_SECRET, T, 'zz psc secret'),
		filter(T_FILTER, T),
		{
			tipo: T_RL,
			parent: T,
			model: 'relation_list',
			term: term('zz psc t rl'),
			relations: [{ tipo: T_LABEL }, { tipo: T_SECRET }],
		},
		{ tipo: T_SID, parent: T, model: 'component_section_id', term: term('zz psc id') },
		{
			tipo: T_PTR,
			parent: T,
			model: 'component_portal',
			term: term('zz psc pointer'),
			properties: explicitConfig(T, [{ tipo: T_LABEL, parent: 'self', section_tipo: 'self' }]),
		},
		{ tipo: T_INDEX, parent: T, model: 'component_relation_index', term: term('zz psc index') },
		{
			tipo: T_IMPL,
			parent: T,
			model: 'component_portal',
			term: term('zz psc implicit'),
			relations: [{ tipo: T }, { tipo: T_LABEL }, { tipo: T_SECRET }],
		},
		{
			tipo: T_MAP,
			parent: T,
			model: 'component_portal',
			term: term('zz psc map'),
			properties: explicitConfig(T, [
				{ tipo: T_LABEL, parent: 'self', section_tipo: 'self' },
				// D11: no `parent` — NOT a child (PHP parent === tipo)
				{ tipo: T_SECRET, section_tipo: T },
			]),
		},
		{ tipo: T_PARENT, parent: T, model: 'component_relation_parent', term: term('zz psc parent') },
		gatedSection(Q, 'zz psc pointing'),
		filter(Q_FILTER, Q),
		{
			tipo: Q_IMPL,
			parent: Q,
			model: 'component_portal',
			term: term('zz psc q implicit'),
			relations: [{ tipo: T }, { tipo: T_LABEL }, { tipo: T_SECRET }],
		},
		{
			tipo: Q_RL,
			parent: Q,
			model: 'relation_list',
			term: term('zz psc q rl'),
			relations: [{ tipo: Q_IMPL }],
		},
		gatedSection(C, 'zz psc cycle'),
		filter(C_FILTER, C),
		{
			tipo: C_PTR,
			parent: C,
			model: 'component_portal',
			term: term('zz psc c pointer'),
			properties: explicitConfig(C, [{ tipo: C_LABEL, parent: 'self', section_tipo: 'self' }]),
		},
		{ tipo: C_INDEX, parent: C, model: 'component_relation_index', term: term('zz psc c index') },
		{
			tipo: C_RL,
			parent: C,
			model: 'relation_list',
			term: term('zz psc c rl'),
			relations: [{ tipo: C_LABEL }, { tipo: C_INDEX }],
		},
		input(C_LABEL, C, 'zz psc c label'),
	],
});

const identity = exportFrontierIdentity('relation_list_panel_scope', 933900);

const SCOPED_GRANTS: FrontierGrant[] = [
	{ sectionTipo: T, tipo: T, level: 1 },
	{ sectionTipo: T, tipo: T_LABEL, level: 1 },
	{ sectionTipo: T, tipo: T_SID, level: 1 },
	{ sectionTipo: T, tipo: T_IMPL, level: 1 },
	{ sectionTipo: T, tipo: T_INDEX, level: 1 },
	{ sectionTipo: Q, tipo: Q, level: 1 },
	{ sectionTipo: Q, tipo: Q_IMPL, level: 1 },
];
const ADMIN_GRANTS: FrontierGrant[] = [
	...[T, T_LABEL, T_SECRET, T_SID, T_IMPL, T_INDEX, T_FILTER].map((tipo) => ({
		sectionTipo: T,
		tipo,
		level: 3,
	})),
	...[Q, Q_IMPL, Q_FILTER].map((tipo) => ({ sectionTipo: Q, tipo, level: 3 })),
];

const text = (value: string) => [{ id: 1, lang: LANG, value }];
const locator = (from: string, sectionTipo: string, sectionId: number, type = 'dd151') => ({
	id: 1,
	type,
	section_tipo: sectionTipo,
	section_id: sectionId,
	from_component_tipo: from,
});

/** Every (section, id) this file writes — swept before and after. */
const OWNED: [string, number][] = [];

async function writeRecord(
	section: string,
	filterTipo: string,
	id: number,
	strings: Record<string, string>,
	relation: Record<string, unknown> = {},
): Promise<void> {
	await sql.unsafe(`DELETE FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`, [
		section,
		id,
	]);
	const string: Record<string, unknown> = {};
	for (const [tipo, value] of Object.entries(strings)) string[tipo] = text(value);
	await sql.unsafe(
		`INSERT INTO ${TABLE} (section_tipo, section_id, relation, string, data)
		 VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb, $5::text::jsonb)`,
		[
			section,
			id,
			encodeForJsonb({
				[filterTipo]: [identity.filterLocator(filterTipo, identity.myProject)],
				...relation,
			}),
			encodeForJsonb(string),
			encodeForJsonb({ section_tipo: section, section_id: id }),
		],
	);
	OWNED.push([section, id]);
}

async function sweepRecords(): Promise<void> {
	for (const section of [T, Q, C]) {
		await sql.unsafe(`DELETE FROM ${TABLE} WHERE section_tipo = $1`, [section]);
	}
}

let root: Principal;

/** The panel reader's cell as `principal` (undefined = no request principal). */
async function cell(
	principal: Principal | undefined,
	sectionTipo: string,
	sectionId: number,
	tipo: string,
): Promise<{ value: string | null; unresolved: string[] }> {
	clearFieldsSeparatorCache();
	clearFrontierIdentityCaches();
	const run = () =>
		runWithRequestLangs({ applicationLang: LANG, dataLang: LANG }, async () => {
			const unresolved: string[] = [];
			const value = await resolveCellValue(sectionTipo, sectionId, tipo, LANG, unresolved);
			return { value, unresolved };
		});
	return principal === undefined
		? run()
		: runWithRequestContext(
				{ principal, session: null, requestId: 't09-panel', clientIp: '' },
				run,
			);
}

/** buildRelationList as the dispatcher runs it: principal in ALS AND passed. */
async function panel(principal: Principal, hostTipo: string, hostId: number) {
	clearFieldsSeparatorCache();
	clearFrontierIdentityCaches();
	return runWithRequestContext(
		{ principal, session: null, requestId: 't09-panel', clientIp: '' },
		() =>
			runWithRequestLangs({ applicationLang: LANG, dataLang: LANG }, () =>
				buildRelationList(hostTipo, hostId, { principal, lang: LANG }),
			),
	);
}

/** Fails loudly instead of hanging the run (A2's red is a non-terminating read). */
async function bounded<T>(promise: Promise<T>, ms = 15_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`did not terminate within ${ms} ms`)), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

describe.if(DB_READY)('T0-9 round A — the interactive flat reader', () => {
	beforeAll(async () => {
		await assertTestDatabase('relation_list_panel_scope_native');
		root = await resolvePrincipal(-1);
		await ensureSituation(S);
		await identity.install(SCOPED_GRANTS, ADMIN_GRANTS);
		await sweepRecords();
		await writeRecord(
			T,
			T_FILTER,
			1,
			{ [T_LABEL]: 'psc one' },
			{ [T_IMPL]: [locator(T_IMPL, T, 2)] },
		);
		await writeRecord(T, T_FILTER, 2, { [T_LABEL]: 'psc two', [T_SECRET]: 'psc secret two' });
		await writeRecord(
			T,
			T_FILTER,
			3,
			{ [T_LABEL]: 'psc three', [T_SECRET]: 'psc secret three' },
			{ [T_PTR]: [locator(T_PTR, T, 2, 'dd96')] },
		);
		await writeRecord(T, T_FILTER, 4, { [T_LABEL]: 'psc four', [T_SECRET]: 'psc secret four' });
		await writeRecord(T, T_FILTER, 5, {}, { [T_MAP]: [locator(T_MAP, T, 2)] });
		await writeRecord(T, T_FILTER, 6, {}, { [T_PARENT]: [locator(T_PARENT, T, 2, 'dd47')] });
		await writeRecord(Q, Q_FILTER, 1, {}, { [Q_IMPL]: [locator(Q_IMPL, T, 4)] });
		// the cycle: c#1 ⇄ c#2, c#3 → itself (dd96 pointers)
		await writeRecord(
			C,
			C_FILTER,
			1,
			{ [C_LABEL]: 'c one' },
			{ [C_PTR]: [locator(C_PTR, C, 2, 'dd96')] },
		);
		await writeRecord(
			C,
			C_FILTER,
			2,
			{ [C_LABEL]: 'c two' },
			{ [C_PTR]: [locator(C_PTR, C, 1, 'dd96')] },
		);
		await writeRecord(
			C,
			C_FILTER,
			3,
			{ [C_LABEL]: 'c three' },
			{ [C_PTR]: [locator(C_PTR, C, 3, 'dd96')] },
		);
	}, 120_000);

	afterAll(async () => {
		await assertTestDatabase('relation_list_panel_scope_native');
		await sweepRecords();
		await identity.remove(true);
		expect(await dropSituation(S)).toBe(0);
	});

	describe('A1 — STEP 5: an implicit child the requester may not read is not resolved', () => {
		test('config-less portal (implicit `relations` children): scoped drops the secret, admin shows it', async () => {
			const admin = await cell(identity.admin, T, 1, T_IMPL);
			expect(admin.value).toBe('psc two, psc secret two'); // non-vacuity
			expect((await cell(root, T, 1, T_IMPL)).value).toBe('psc two, psc secret two');
			expect((await cell(identity.scoped, T, 1, T_IMPL)).value).toBe('psc two');
		});

		test('config-less relation_index (per-locator related_list columns): the same predicate', async () => {
			const admin = await cell(identity.admin, T, 2, T_INDEX);
			expect(admin.value).toBe('3, psc three, psc secret three'); // non-vacuity
			// the ADDRESS (explicit) shows; the ungranted column does not
			expect((await cell(identity.scoped, T, 2, T_INDEX)).value).toBe('3, psc three');
		});

		test('no request principal (an internal resolution): no filter, as the edit form', async () => {
			expect((await cell(undefined, T, 1, T_IMPL)).value).toBe('psc two, psc secret two');
		});

		test('buildRelationList (Referencias panel): the cell drops the secret for scoped', async () => {
			const panelCell = (result: Awaited<ReturnType<typeof panel>>) =>
				result.data.find((entry) => entry.section_tipo === Q && entry.component_tipo === Q_IMPL)
					?.value;
			expect(panelCell(await panel(identity.admin, T, 4))).toBe('psc four, psc secret four');
			expect(panelCell(await panel(identity.scoped, T, 4))).toBe('psc four');
		});
	});

	describe('A6 — STEP 5 on the panel TOP-LEVEL columns (the pointing section relation_list)', () => {
		// T#3 points at T#2 (T_PTR): its row's columns are T's relation_list
		// [T_LABEL, T_SECRET]. The edit form's related_list drops a column the
		// viewer may not read (section/related_list.ts sectionRelatedListConfig);
		// the panel applies the same predicate — neither a context column nor a
		// data cell for it. The ROW itself always shows (the referencing record
		// is in the persona's projects).
		const columnsOf = (result: Awaited<ReturnType<typeof panel>>) =>
			result.context
				.filter((entry) => entry.section_tipo === T)
				.map((entry) => entry.component_tipo);
		const cellsOf = (result: Awaited<ReturnType<typeof panel>>) =>
			result.data
				.filter((entry) => entry.section_tipo === T && entry.section_id === 3)
				.map((entry) => entry.component_tipo);

		test('admin: both columns (non-vacuity)', async () => {
			const result = await panel(identity.admin, T, 2);
			expect(columnsOf(result)).toEqual(['id', T_LABEL, T_SECRET]);
			expect(cellsOf(result)).toEqual(['id', T_LABEL, T_SECRET]);
			const secret = result.data.find(
				(entry) => entry.section_id === 3 && entry.component_tipo === T_SECRET,
			);
			expect(secret?.value).toBe('psc secret three');
		});

		test('root: both columns', async () => {
			expect(columnsOf(await panel(root, T, 2))).toEqual(['id', T_LABEL, T_SECRET]);
		});

		test('scoped persona without a T_SECRET grant: no column, no cell, row kept', async () => {
			const result = await panel(identity.scoped, T, 2);
			expect(columnsOf(result)).toEqual(['id', T_LABEL]);
			expect(cellsOf(result)).toEqual(['id', T_LABEL]);
			expect(JSON.stringify(result)).not.toContain('psc secret three');
		});

		test('related_search payload (buildRelatedSections): the same columns, same rule', async () => {
			const related = (principal: Principal) => {
				clearFieldsSeparatorCache();
				clearFrontierIdentityCaches();
				return runWithRequestContext(
					{ principal, session: null, requestId: 't09-related', clientIp: '' },
					() =>
						runWithRequestLangs({ applicationLang: LANG, dataLang: LANG }, () =>
							buildRelatedSections([{ section_tipo: T, section_id: 2 }], {
								callerTipo: T_PTR,
								principal,
								lang: LANG,
							}),
						),
				);
			};
			const columnTipos = (result: Awaited<ReturnType<typeof related>>) =>
				result.context
					.filter((entry) => entry.section_tipo === T && entry.model !== 'section')
					.map((entry) => entry.tipo);
			const admin = await related(identity.admin);
			expect(columnTipos(admin)).toEqual([T_LABEL, T_SECRET]); // non-vacuity
			expect(JSON.stringify(admin)).toContain('psc secret three');
			const scoped = await related(identity.scoped);
			expect(columnTipos(scoped)).toEqual([T_LABEL]);
			expect(scoped.data.some((entry) => entry.tipo === T_SECRET)).toBe(false);
			expect(JSON.stringify(scoped)).not.toContain('psc secret three');
		});
	});

	describe('A2 — a data cycle through relation_list index columns terminates, noted', () => {
		test('c#1 ⇄ c#2: the repeated record resolves to nothing, `relation_cycle` noted', async () => {
			const result = await bounded(cell(root, C, 1, C_INDEX));
			expect(result.value).toBe('c two, c one');
			expect(result.unresolved).toContain(`relation_cycle:${C_INDEX}`);
		}, 30_000);

		test('c#3 → itself: terminates, noted', async () => {
			const result = await bounded(cell(root, C, 3, C_INDEX));
			expect(result.value).toBe('c three');
			expect(result.unresolved).toContain(`relation_cycle:${C_INDEX}`);
		}, 30_000);

		test('the panel over the cycle terminates', async () => {
			const result = await bounded(panel(root, C, 1));
			const cellOf = (id: number) =>
				result.data.find((entry) => entry.section_id === id && entry.component_tipo === C_INDEX)
					?.value;
			// c#2 → c#1 (label) → c#2 again: the repeat resolves to nothing
			expect(cellOf(2)).toBe('c one, c two');
			expect(result.unresolved).toContain(`relation_cycle:${C_INDEX}`);
		}, 30_000);

		test('no cycle, no note (the guard is path-scoped, not a dedup)', async () => {
			const result = await cell(root, T, 1, T_IMPL);
			expect(result.value).toBe('psc two, psc secret two'); // the read did resolve
			expect(result.unresolved.some((note) => note.startsWith('relation_cycle:'))).toBe(false);
		});
	});

	describe('A4 — D11: a ddo_map entry without `parent` is NOT a child', () => {
		test('the predicate', () => {
			const entry = (parent?: string): { tipo: string; parent?: string } =>
				parent === undefined ? { tipo: 'x' } : { tipo: 'x', parent };
			expect(isDirectConfigChild(entry('self'), 'owner')).toBe(true);
			expect(isDirectConfigChild(entry('owner'), 'owner')).toBe(true);
			expect(isDirectConfigChild(entry(), 'owner')).toBe(false);
			expect(isDirectConfigChild(entry('other'), 'owner')).toBe(false);
			// a nested level: 'self' aliases ONLY the map owner
			expect(isDirectConfigChild(entry('nested'), 'nested', 'owner')).toBe(true);
			expect(isDirectConfigChild(entry('self'), 'nested', 'owner')).toBe(false);
			expect(isDirectConfigChild(entry(), 'nested', 'owner')).toBe(false);
		});

		test('the panel reader: the parent-less entry is not resolved', async () => {
			expect((await cell(root, T, 5, T_MAP)).value).toBe('psc two');
		});
	});

	describe('A5 — D12: a config-less relation_parent throws ontology.invalid_node naming the node', () => {
		test('resolveCellValue', async () => {
			let caught: unknown;
			try {
				await cell(root, T, 6, T_PARENT);
			} catch (error) {
				caught = error;
			}
			expect((caught as { code?: string } | undefined)?.code).toBe('ontology.invalid_node');
			const coordinates = (caught as { coordinates?: { tipo?: string } }).coordinates;
			expect(coordinates?.tipo).toBe(T_PARENT);
		});
	});
});
