/**
 * T1-32 (O10) — the term resolver reads a NON-LITERAL term component through
 * its model's flat value (PHP get_term_by_locator → component::get_value →
 * get_export_value()->to_flat_string), not only literal string `value` items.
 *
 * A section_map `term` may name a relation (autocomplete_hi: a catalogue
 * labelled by its linked type), a column-less alias (component_autocomplete), a select, or
 * the record's own component_section_id (an ontology-node shape). Before the fix
 * every such part rendered '' — a whole label blank, or a joined label missing
 * a part. The fix routes every non-string flatValue family through THE
 * interactive flat reader (resolve/relation_list.ts resolveCellValue).
 *
 * Cache law pinned here (T8/T9): a term that crosses into OTHER records depends
 * on those records AND on the request principal (implicit-config narrowing), so
 * it is never served from — nor stored in — the content-keyed process cache.
 *
 * FRONTIER law (T1-32 review): a frontier-armed caller (the export) threads its
 * CellFrontier into the term read; every record the term crosses into and
 * every implicit child it reads there is asked of it — refusal skips, a throw
 * propagates. (End-to-end twin: export_frontier_fanout_native, parents chain.)
 *
 * Situation: `zztrm` scratch TLD on matrix_test, built by ensureSituation and
 * dropped after (residue asserted 0). Identity: exportFrontierIdentity at its
 * own explicit ids (935100+), swept strictly.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ApiRequestContext } from '../../src/core/api/handler_context.ts';
import { coreApiActions } from '../../src/core/api/handlers/dd_core_api.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import type { CellFrontier } from '../../src/core/resolve/relation_list.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	clearTermCache,
	getDdoValueByLocator,
	getTermByLocator,
} from '../../src/core/ts_object/term_resolver.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import {
	clearFrontierIdentityCaches,
	exportFrontierIdentity,
	type FrontierGrant,
} from '../helpers/export_frontier_identity.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const LANG = 'lg-eng';
const TLD = 'zztrm';

// T — the TARGET section (its own term is a literal input_text)
const T = 'zztrm10';
const T_TERM = 'zztrm11';
const T_SECRET = 'zztrm12'; // NO grant for the scoped persona
const T_MAP = 'zztrm13';
const T_FILTER = 'zztrm14';
// H1 — term = [autocomplete_hi, explicit get_ddo_map section_map term] (catalogue shape)
const H1 = 'zztrm20';
const H1_REL = 'zztrm21';
// H2 — term = [component_autocomplete] (column-less alias)
const H2 = 'zztrm30';
const H2_REL = 'zztrm31';
// H3 — term = [component_select]
const H3 = 'zztrm40';
const H3_SEL = 'zztrm41';
// H4 — term = [input, input, autocomplete_hi] + ' / ' (typology shape)
const H4 = 'zztrm50';
const H4_A = 'zztrm51';
const H4_B = 'zztrm52';
const H4_REL = 'zztrm53';
// H5 — term = [input, component_section_id] (ontology-node shape)
const H5 = 'zztrm60';
const H5_NAME = 'zztrm61';
const H5_ID = 'zztrm62';
// H6 — term = [portal with IMPLICIT config → T_TERM, T_SECRET]
const H6 = 'zztrm70';
const H6_REL = 'zztrm71';
const H6_FILTER = 'zztrm72';
// C1 ⇄ C2 — each term = [input, relation → the other's term]
const C1 = 'zztrm80';
const C1_NAME = 'zztrm81';
const C1_REL = 'zztrm82';
const C2 = 'zztrm90';
const C2_NAME = 'zztrm91';
const C2_REL = 'zztrm92';
// H7 — term = [portal with NO config children → H1] (relation_list's no-children
// branch: the label is H1's TERM via datalist resolveLocatorLabels, which crosses on to T)
const H7 = 'zztrm100';
const H7_SEL = 'zztrm101';

const term = (value: string) => ({ [LANG]: value });
const section = (tipo: string) => ({
	tipo,
	parent: 'test1',
	model: 'section',
	term: term(`zz trm ${tipo}`),
	relations: [{ tipo: 'test24' }],
});
const input = (tipo: string, parent: string) => ({
	tipo,
	parent,
	model: 'component_input_text',
	term: term(`zz trm ${tipo}`),
	is_translatable: true,
});
const sectionMap = (tipo: string, parent: string, termTipos: string[], separator?: string) => ({
	tipo,
	parent,
	model: 'section_map',
	properties: {
		thesaurus: {
			term: termTipos.length === 1 ? termTipos[0] : termTipos,
			...(separator === undefined ? {} : { fields_separator: separator }),
		},
	},
});
/** A relation whose explicit config targets `target` and shows its section_map term. */
const termConfig = (target: string) => ({
	source: {
		request_config: [
			{
				sqo: { section_tipo: [{ value: [target], source: 'section' }] },
				show: {
					get_ddo_map: { model: 'section_map', columns: [['thesaurus', 'term']] },
				},
			},
		],
	},
});
const relation = (tipo: string, parent: string, model: string, extra: Record<string, unknown>) => ({
	tipo,
	parent,
	model,
	term: term(`zz trm ${tipo}`),
	...extra,
});

const text = (value: string) => [{ id: 1, lang: LANG, value }];
const link = (from: string, sectionTipo: string, ids: number[]) =>
	ids.map((id, index) => ({
		id: index + 1,
		type: 'dd151',
		section_tipo: sectionTipo,
		section_id: id,
		from_component_tipo: from,
	}));

function records() {
	const projectOf = (filterTipo: string) => ({
		[filterTipo]: [identity.filterLocator(filterTipo, identity.myProject)],
	});
	return [
		{
			section_tipo: T,
			section_id: 1,
			columns: {
				string: { [T_TERM]: text('Target one'), [T_SECRET]: text('Secret one') },
				relation: projectOf(T_FILTER),
			},
		},
		{
			section_tipo: T,
			section_id: 2,
			columns: { string: { [T_TERM]: text('Target two') }, relation: projectOf(T_FILTER) },
		},
		{ section_tipo: H1, section_id: 1, columns: { relation: { [H1_REL]: link(H1_REL, T, [1]) } } },
		{
			section_tipo: H1,
			section_id: 2,
			columns: { relation: { [H1_REL]: link(H1_REL, T, [1, 2]) } },
		},
		{ section_tipo: H2, section_id: 1, columns: { relation: { [H2_REL]: link(H2_REL, T, [2]) } } },
		{ section_tipo: H3, section_id: 1, columns: { relation: { [H3_SEL]: link(H3_SEL, T, [1]) } } },
		{
			section_tipo: H4,
			section_id: 1,
			columns: {
				string: { [H4_A]: text('Alpha'), [H4_B]: text('Beta') },
				relation: { [H4_REL]: link(H4_REL, T, [2]) },
			},
		},
		{ section_tipo: H5, section_id: 7, columns: { string: { [H5_NAME]: text('Name') } } },
		{
			section_tipo: H6,
			section_id: 1,
			columns: {
				relation: { [H6_REL]: link(H6_REL, T, [1]), ...projectOf(H6_FILTER) },
			},
		},
		{
			section_tipo: C1,
			section_id: 1,
			columns: {
				string: { [C1_NAME]: text('Cycle A') },
				relation: { [C1_REL]: link(C1_REL, C2, [1]) },
			},
		},
		{
			section_tipo: C2,
			section_id: 1,
			columns: {
				string: { [C2_NAME]: text('Cycle B') },
				relation: { [C2_REL]: link(C2_REL, C1, [1]) },
			},
		},
		{ section_tipo: H7, section_id: 1, columns: { relation: { [H7_SEL]: link(H7_SEL, H1, [1]) } } },
	];
}

const identity = exportFrontierIdentity('term_resolver_model_flat', 935100);

const S = situation({
	name: 'T1-32 term resolver model flat value',
	tld: TLD,
	nodes: [
		section(T),
		input(T_TERM, T),
		input(T_SECRET, T),
		{ tipo: T_FILTER, parent: T, model: 'component_filter', term: term('zz trm t projects') },
		sectionMap(T_MAP, T, [T_TERM]),

		section(H1),
		relation(H1_REL, H1, 'component_autocomplete_hi', { properties: termConfig(T) }),
		sectionMap('zztrm29', H1, [H1_REL]),

		section(H2),
		relation(H2_REL, H2, 'component_autocomplete', { relations: [{ tipo: T }, { tipo: T_TERM }] }),
		sectionMap('zztrm39', H2, [H2_REL]),

		section(H3),
		relation(H3_SEL, H3, 'component_select', { relations: [{ tipo: T }, { tipo: T_TERM }] }),
		sectionMap('zztrm49', H3, [H3_SEL]),

		section(H4),
		input(H4_A, H4),
		input(H4_B, H4),
		relation(H4_REL, H4, 'component_autocomplete_hi', { properties: termConfig(T) }),
		sectionMap('zztrm59', H4, [H4_A, H4_B, H4_REL], ' / '),

		section(H5),
		input(H5_NAME, H5),
		{ tipo: H5_ID, parent: H5, model: 'component_section_id', term: term('zz trm id') },
		sectionMap('zztrm69', H5, [H5_NAME, H5_ID]),

		section(H6),
		relation(H6_REL, H6, 'component_portal', {
			relations: [{ tipo: T }, { tipo: T_TERM }, { tipo: T_SECRET }],
		}),
		{ tipo: H6_FILTER, parent: H6, model: 'component_filter', term: term('zz trm h6 projects') },
		sectionMap('zztrm79', H6, [H6_REL]),

		section(C1),
		input(C1_NAME, C1),
		relation(C1_REL, C1, 'component_portal', { properties: termConfig(C2) }),
		sectionMap('zztrm89', C1, [C1_NAME, C1_REL]),

		section(C2),
		input(C2_NAME, C2),
		relation(C2_REL, C2, 'component_portal', { properties: termConfig(C1) }),
		sectionMap('zztrm99', C2, [C2_NAME, C2_REL]),

		section(H7),
		// a ddo with NO parent is no config child (D11) → the no-children branch;
		// the label pick (datalist) still takes it, and it is H1's term tipo
		relation(H7_SEL, H7, 'component_portal', {
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [H1], source: 'section' }] },
							show: { ddo_map: [{ tipo: H1_REL, section_tipo: H1 }] },
						},
					],
				},
			},
		}),
		sectionMap('zztrm109', H7, [H7_SEL]),
	],
	records: records(),
});

const SCOPED_GRANTS: FrontierGrant[] = [
	{ sectionTipo: T, tipo: T, level: 1 },
	{ sectionTipo: T, tipo: T_TERM, level: 1 },
	{ sectionTipo: H6, tipo: H6, level: 1 },
	{ sectionTipo: H6, tipo: H6_REL, level: 1 },
];
const ADMIN_GRANTS: FrontierGrant[] = [
	...[T, T_TERM, T_SECRET, T_FILTER].map((tipo) => ({ sectionTipo: T, tipo, level: 3 })),
	...[H6, H6_REL, H6_FILTER].map((tipo) => ({ sectionTipo: H6, tipo, level: 3 })),
];

let root: Principal;

const termOf = (sectionTipo: string, sectionId: number, fromCache = false) =>
	runWithRequestLangs({ applicationLang: LANG, dataLang: LANG }, () =>
		getTermByLocator({ section_tipo: sectionTipo, section_id: sectionId }, LANG, fromCache),
	);

/** termOf under a request principal (the ALS read filterAuthorizedRelated makes). */
function termAs(principal: Principal, sectionTipo: string, sectionId: number) {
	clearFrontierIdentityCaches();
	return runWithRequestContext(
		{ principal, session: null, requestId: 't1-32-term', clientIp: '' },
		() => termOf(sectionTipo, sectionId, true),
	);
}

/** A recording frontier: refuses (false) or throws on the listed `tipo#id` crossings. */
function spyFrontier(
	refuse: readonly string[] = [],
	mode: 'skip' | 'throw' = 'skip',
	implicit?: readonly string[],
): { frontier: CellFrontier; asked: string[] } {
	const asked: string[] = [];
	const frontier: CellFrontier = {
		crossRecord: async (sectionTipo, sectionId) => {
			const key = `${sectionTipo}#${String(sectionId)}`;
			asked.push(key);
			if (!refuse.includes(key)) return true;
			if (mode === 'throw') throw new Error(`frontier refused ${key}`);
			return false;
		},
		implicitChildren: async (_sectionTipo, tipos) =>
			new Set(implicit === undefined ? tipos : tipos.filter((tipo) => implicit.includes(tipo))),
	};
	return { frontier, asked };
}

/** Fails loudly instead of hanging the run (the cycle leg's red is a non-terminating read). */
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

describe.if(DB_READY)('T1-32 — term parts drawn from non-literal components', () => {
	beforeAll(async () => {
		await assertTestDatabase('term_resolver_model_flat_native');
		root = await resolvePrincipal(-1);
		await identity.install(SCOPED_GRANTS, ADMIN_GRANTS);
		await ensureSituation(S);
		clearTermCache();
	}, 120_000);

	afterAll(async () => {
		await assertTestDatabase('term_resolver_model_flat_native');
		clearTermCache();
		await identity.remove(true);
		expect(await dropSituation(S)).toBe(0);
	});

	test('precondition: the target term itself is a literal and resolves', async () => {
		expect(await termOf(T, 1)).toBe('Target one');
	});

	test('autocomplete_hi term (explicit section_map config) → the target term', async () => {
		expect(await termOf(H1, 1)).toBe('Target one');
	});

	test('two targets → joined with the records separator', async () => {
		expect(await termOf(H1, 2)).toBe('Target one | Target two');
	});

	test('component_autocomplete (column-less alias) term → the target term', async () => {
		expect(await termOf(H2, 1)).toBe('Target two');
	});

	test('component_select term → the option label', async () => {
		expect(await termOf(H3, 1)).toBe('Target one');
	});

	test('mixed join keeps every part in order with the scope separator (typology shape)', async () => {
		expect(await termOf(H4, 1)).toBe('Alpha / Beta / Target two');
	});

	test('component_section_id part → the record id (ontology-node shape)', async () => {
		expect(await termOf(H5, 7)).toBe('Name, 7');
	});

	test('getDdoValueByLocator (the M badge reader) resolves a relation tipo too', async () => {
		const value = await runWithRequestLangs({ applicationLang: LANG, dataLang: LANG }, () =>
			getDdoValueByLocator({ section_tipo: H1, section_id: 1 }, [H1_REL], ', ', LANG),
		);
		expect(value).toBe('Target one');
	});

	test('STALENESS: a renamed target is seen through a cached host term read', async () => {
		expect(await termOf(H4, 1, true)).toBe('Alpha / Beta / Target two');
		const saved = await runWithRequestContext(
			{ principal: root, session: null, requestId: 't1-32-rename', clientIp: '' },
			() =>
				saveComponentData({
					componentTipo: T_TERM,
					sectionTipo: T,
					sectionId: 2,
					lang: LANG,
					changedData: [{ action: 'set_data', value: text('Target two renamed') }],
					userId: -1,
				}),
		);
		expect(saved.ok).toBe(true);
		try {
			expect(await termOf(H4, 1, true)).toBe('Alpha / Beta / Target two renamed');
		} finally {
			await runWithRequestContext(
				{ principal: root, session: null, requestId: 't1-32-rename', clientIp: '' },
				() =>
					saveComponentData({
						componentTipo: T_TERM,
						sectionTipo: T,
						sectionId: 2,
						lang: LANG,
						changedData: [{ action: 'set_data', value: text('Target two') }],
						userId: -1,
					}),
			);
		}
	});

	test('PRINCIPAL: an implicit-config term narrows per requester — never cross-served by the cache', async () => {
		clearTermCache();
		expect(await termAs(identity.scoped, H6, 1)).toBe('Target one');
		expect(await termAs(root, H6, 1)).toBe('Target one, Secret one');
		expect(await termAs(identity.scoped, H6, 1)).toBe('Target one');
		expect(await termAs(identity.admin, H6, 1)).toBe('Target one, Secret one');
	});

	test('a term cycle (A → B → A) terminates and keeps the crossed literal parts', async () => {
		const value = await bounded(termOf(C1, 1));
		// C1 → C2's term ('Cycle B' + its relation back to C1, cut on the path).
		expect(value).toBe('Cycle A, Cycle B');
	});

	describe("FRONTIER: a frontier-armed caller's term read asks its frontier (T1-32 review)", () => {
		const armed = (sectionTipo: string, sectionId: number, frontier: CellFrontier) =>
			runWithRequestContext(
				{ principal: root, session: null, requestId: 't1-32-frontier', clientIp: '' },
				() =>
					runWithRequestLangs({ applicationLang: LANG, dataLang: LANG }, () =>
						getTermByLocator(
							{ section_tipo: sectionTipo, section_id: sectionId },
							LANG,
							true,
							'thesaurus',
							{
								frontier,
							},
						),
					),
			);

		test('every crossed target is asked; a refused target is skipped', async () => {
			const open = spyFrontier();
			expect(await armed(H1, 2, open.frontier)).toBe('Target one | Target two');
			expect(open.asked).toEqual([`${T}#1`, `${T}#2`]);
			const narrowed = spyFrontier([`${T}#1`]);
			expect(await armed(H1, 2, narrowed.frontier)).toBe('Target two');
		});

		test("a throwing frontier (the export's law) propagates — nothing is read past it", async () => {
			const strict = spyFrontier([`${T}#2`], 'throw');
			await expect(armed(H4, 1, strict.frontier)).rejects.toThrow(`frontier refused ${T}#2`);
		});

		test('implicit children answer to the frontier, not to the ambient principal', async () => {
			// root sees T_SECRET ambiently; the frontier allows only T_TERM
			const only = spyFrontier([], 'skip', [T_TERM]);
			expect(await armed(H6, 1, only.frontier)).toBe('Target one');
			expect(only.asked).toEqual([`${T}#1`]);
		});

		test('nested crossings (a target term crossing back) are asked at every depth', async () => {
			const deep = spyFrontier();
			expect(await bounded(armed(C1, 1, deep.frontier))).toBe('Cycle A, Cycle B');
			expect(deep.asked).toContain(`${C2}#1`);
			expect(deep.asked).toContain(`${C1}#1`);
		});

		test("a label read through the target's TERM (no-children branch) carries the frontier on", async () => {
			const open = spyFrontier();
			expect(await armed(H7, 1, open.frontier)).toBe('Target one');
			// H1#1 asked by the branch itself; T#1 only if the label's term read got the frontier
			expect(open.asked).toEqual([`${H1}#1`, `${T}#1`]);
			const strict = spyFrontier([`${T}#1`], 'throw');
			await expect(armed(H7, 1, strict.frontier)).rejects.toThrow(`frontier refused ${T}#1`);
		});

		test('getDdoValueByLocator (the M badge reader) threads the frontier too', async () => {
			const strict = spyFrontier([`${T}#1`], 'throw');
			await expect(
				runWithRequestLangs({ applicationLang: LANG, dataLang: LANG }, () =>
					getDdoValueByLocator({ section_tipo: H1, section_id: 1 }, [H1_REL], ', ', LANG, {
						frontier: strict.frontier,
					}),
				),
			).rejects.toThrow(`frontier refused ${T}#1`);
		});
	});

	test('get_section_terms (the graph door) returns the relation-drawn term', async () => {
		const handler = coreApiActions.get_section_terms;
		expect(handler).toBeDefined();
		const context = {
			requestId: 't1-32-terms',
			clientIp: '127.0.0.1',
			session: {
				userId: -1,
				username: 'root',
				isGlobalAdmin: true,
				csrfToken: 'tok',
				applicationLang: null,
				dataLang: null,
			},
			csrfCandidate: 'tok',
			principal: root,
		} as unknown as ApiRequestContext;
		const outcome = await runWithRequestContext(
			{ principal: root, session: null, requestId: 't1-32-terms', clientIp: '' },
			() =>
				(handler as NonNullable<typeof handler>)(
					{
						action: 'get_section_terms',
						dd_api: 'dd_core_api',
						locators: [{ section_tipo: H1, section_id: 2 }],
						lang: LANG,
					} as unknown as Rqo,
					context,
				),
		);
		expect(outcome.status).toBe(200);
		const data = (outcome.body as { data: Record<string, unknown> }).data;
		expect(data[`${H1}_2`]).toBe('Target one | Target two');
	});
});
