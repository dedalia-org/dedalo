/**
 * ddo.section_tipo SOURCE ARRAYS — owner decision (c) of the nested-ddo_map
 * plan: a ddo may declare its section_tipo in the SQO grammar
 * (`[{value:[…], source:'section'|'hierarchy_types'|…}]`), and it resolves
 * through THE resolver `sqo.section_tipo` uses (explicit.ts
 * resolveSqoSectionTipos) — never a fork. This is how a deep ddo that may no
 * longer say 'self' (self_depth.ts) names a family of sections declaratively.
 *
 * The gate is EQUIVALENCE, not a re-spelled expectation: for each declaration
 * the ddo's resolved section_tipo must equal what the sqo resolver answers for
 * the same value, AND one case must resolve to a known non-empty list (so the
 * equivalence cannot hold at empty-vs-empty).
 *
 * ONE MEANING OF 'self' (self_depth.ts refuses four spellings as one sentinel
 * at depth >= 2, so at depth 1 they must mean the same sections): 'self',
 * ['self'], [{source:'self'}] and [{source:'section', value:['self']}] all
 * resolve to the item TARGETS — the last one used to reach the sqo resolver
 * whole and mean the OWNER section (tch197 → tch1, which holds no rsc1399).
 *
 * And the RAW list seam (relations/models/portal.ts, rawListDdos) resolves the
 * same declaration, so the list DATA agrees with the context: a list read of a
 * portal whose own config names its child at a source array emits the child's
 * value (before, the context had the column and the cell stayed empty).
 *
 * Situation: the suite's `test` TLD sections test3 / test38 and component
 * test92 (no records); the emission case builds scratch `zzsa` (host —portal→
 * target, one record each), swept after with residue 0.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	buildExplicitRequestConfig,
	isSourceArraySectionTipo,
	type RequestConfigContext,
	resolveDdoSectionTipo,
	resolveRawDdoSectionTipo,
	resolveSqoSectionTipos,
} from '../../src/core/relations/request_config/explicit.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { countActivityRows, sweepActivityRows } from '../helpers/activity_rows.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

let dbReady = false;
try {
	await sql`SELECT 1`;
	dbReady = true;
} catch {
	console.warn('[ddo_section_tipo_source_array] DB unavailable — gate SKIPPED');
}

const context: RequestConfigContext = {
	ownerTipo: 'test80',
	ownerSectionTipo: 'test3',
	mode: 'list',
	ownerIsSection: false,
};
const withLangs = <T>(fn: () => Promise<T>): Promise<T> =>
	runWithRequestLangs({ applicationLang: 'lg-eng', dataLang: 'lg-eng' }, fn);

describe('isSourceArraySectionTipo', () => {
	test('object entries (alone or mixed) are the source grammar; plain tipos are not', () => {
		expect(isSourceArraySectionTipo([{ source: 'section', value: ['test3'] }])).toBe(true);
		expect(isSourceArraySectionTipo({ source: 'hierarchy_types', value: [1] })).toBe(true);
		expect(isSourceArraySectionTipo(['test3', { source: 'self' }])).toBe(true);
		expect(isSourceArraySectionTipo(['test3', 'test38'])).toBe(false);
		expect(isSourceArraySectionTipo('self')).toBe(false);
		expect(isSourceArraySectionTipo(undefined)).toBe(false);
	});
});

describe.if(dbReady)('resolveDdoSectionTipo — the sqo resolver, reused', () => {
	const declarations: unknown[] = [
		[{ source: 'section', value: ['test3', 'test38'] }],
		[{ source: 'section', value: ['test3', 'zzzqnotinstalled1'] }], // uninstalled TLD dropped
		[{ source: 'hierarchy_types', value: [1, 2] }],
		{ source: 'section', value: 'test38' }, // a single object, scalar value
		['test38', { source: 'section', value: ['test3'] }], // mixed
	];

	test('anti-vacuity: the section source resolves to the known sections', async () => {
		expect(
			await resolveDdoSectionTipo(declarations[0], 'component_input_text', context, ['test38']),
		).toEqual(['test3', 'test38']);
		expect(
			await resolveDdoSectionTipo(declarations[1], 'component_input_text', context, []),
		).toEqual(['test3']);
	});

	for (const [index, declaration] of declarations.entries()) {
		test(`declaration #${index} resolves exactly as sqo.section_tipo does`, async () => {
			const asDdo = await resolveDdoSectionTipo(declaration, 'component_input_text', context, []);
			const asSqo = await resolveSqoSectionTipos(declaration, context);
			expect(asDdo).toEqual(asSqo);
		});
	}

	test("the literal 'self' and plain tipos keep their ddo meaning (targets / verbatim)", async () => {
		expect(
			await resolveDdoSectionTipo('self', 'component_input_text', context, ['test38']),
		).toEqual(['test38']);
		expect(await resolveDdoSectionTipo('self', 'component_dataframe', context, ['test38'])).toBe(
			'test3',
		);
		expect(await resolveDdoSectionTipo(['test38'], 'component_input_text', context, [])).toEqual([
			'test38',
		]);
		expect(
			await resolveDdoSectionTipo(undefined, 'component_input_text', context, []),
		).toBeUndefined();
	});

	test('through the config parser: a show ddo with a source-array section_tipo ships the resolved list', async () => {
		const properties = {
			source: {
				request_config: [
					{
						api_engine: 'dedalo',
						sqo: { section_tipo: ['test3'] },
						show: {
							ddo_map: [
								{
									tipo: 'test92',
									parent: 'self',
									section_tipo: [{ source: 'section', value: ['test3', 'test38'] }],
								},
							],
						},
					},
				],
			},
		};
		const config = await withLangs(() => buildExplicitRequestConfig(properties, context));
		const shown = config[0]?.show?.ddo_map ?? [];
		expect(shown).toHaveLength(1);
		expect(shown[0]?.section_tipo).toEqual(['test3', 'test38']);
		expect(shown[0]?.parent).toBe('test80');
	});
});

describe.if(dbReady)("one meaning of 'self' in a ddo, whatever the spelling (depth 1)", () => {
	const spellings: unknown[] = [
		'self',
		['self'],
		[{ source: 'self' }],
		{ source: 'self' },
		// 'self' inside a section-semantics entry's value (the shipped sqo grammar)
		[{ source: 'section', value: ['self'] }],
		{ source: 'section', value: 'self' },
		[{ source: 'section_tipo', value: ['self'] }], // the live 'section' alias
	];

	test('every spelling resolves to the item TARGETS (not the owner section, never verbatim)', async () => {
		for (const spelling of spellings) {
			const resolved = await resolveDdoSectionTipo(spelling, 'component_input_text', context, [
				'test38',
			]);
			expect([spelling, resolved]).toEqual([spelling, ['test38']]);
		}
	});

	test('a dataframe: every spelling is the owner section (scalar only for the literal)', async () => {
		expect(await resolveDdoSectionTipo('self', 'component_dataframe', context, ['test38'])).toBe(
			'test3',
		);
		for (const spelling of spellings.slice(1)) {
			expect(
				await resolveDdoSectionTipo(spelling, 'component_dataframe', context, ['test38']),
			).toEqual(['test3']);
		}
	});

	test("'self' beside other entries: the targets plus the rest, the rest through the sqo resolver", async () => {
		expect(
			await resolveDdoSectionTipo(
				[{ source: 'self' }, { source: 'section', value: ['test3'] }],
				'component_input_text',
				context,
				['test38'],
			),
		).toEqual(['test38', 'test3']);
		expect(
			await resolveDdoSectionTipo(['test3', 'self'], 'component_input_text', context, ['test38']),
		).toEqual(['test38', 'test3']);
		// a mixed entry splits: the 'self' is the targets, the rest of its value the sqo resolver's
		expect(
			await resolveDdoSectionTipo(
				[{ source: 'section', value: ['self', 'test3'] }],
				'component_input_text',
				context,
				['test38'],
			),
		).toEqual(['test38', 'test3']);
	});

	test("a section_model 'self' keeps ITS meaning (the owner's model twin), it is not the sentinel", async () => {
		// same answer as the sqo resolver gives it — never rewritten to the targets
		for (const declared of [
			[{ source: 'section_model' }],
			[{ source: 'section_model', value: ['self'] }],
		]) {
			const resolved = await resolveDdoSectionTipo(declared, 'component_input_text', context, [
				'test38',
			]);
			expect(resolved).toEqual(await resolveSqoSectionTipos(declared, context));
			expect(resolved).not.toEqual(['test38']);
		}
	});

	test("the RAW seam: any 'self' spelling stays the match-all wildcard; a self-free source array resolves", async () => {
		for (const spelling of spellings) {
			expect(await resolveRawDdoSectionTipo(spelling, context)).toBe('self');
		}
		expect(
			await resolveRawDdoSectionTipo([{ source: 'section', value: ['test3', 'test38'] }], context),
		).toEqual(['test3', 'test38']);
		expect(await resolveRawDdoSectionTipo(['test38'], context)).toEqual(['test38']);
		expect(await resolveRawDdoSectionTipo('test38', context)).toBe('test38');
		expect(await resolveRawDdoSectionTipo(undefined, context)).toBeUndefined();
	});
});

// ── list emission: the raw seam agrees with the context ─────────────────────

const HOST = 'zzsa1';
const PORTAL = 'zzsa2';
const TARGET = 'zzsa3';
const TARGET_TEXT = 'zzsa4';
const HOST_ID = 900711;
const TARGET_ID = 900712;
const TARGET_VALUE = 'source-array child value';

const EMISSION = situation({
	name: 'ddo source-array list emission',
	tld: 'zzsa',
	nodes: [
		{ tipo: HOST, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{
			tipo: PORTAL,
			parent: HOST,
			model: 'component_portal',
			// The portal's OWN config names its child at a SOURCE ARRAY: the list
			// cell reads this raw (portal.ts rawListDdos), never through the
			// explicit builder.
			properties: {
				source: {
					request_config: [
						{
							api_engine: 'dedalo',
							type: 'main',
							sqo: { section_tipo: [TARGET] },
							show: {
								ddo_map: [
									{
										tipo: TARGET_TEXT,
										parent: 'self',
										section_tipo: [{ source: 'section', value: [TARGET] }],
									},
								],
							},
						},
					],
				},
			},
		},
		{ tipo: TARGET, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{ tipo: TARGET_TEXT, parent: TARGET, model: 'component_input_text' },
	],
	records: [
		{
			section_tipo: HOST,
			section_id: HOST_ID,
			columns: {
				relation: {
					[PORTAL]: [
						{
							id: 1,
							type: 'dd151',
							section_id: TARGET_ID,
							section_tipo: TARGET,
							from_component_tipo: PORTAL,
						},
					],
				},
			},
		},
		{
			section_tipo: TARGET,
			section_id: TARGET_ID,
			columns: { string: { [TARGET_TEXT]: [{ id: 1, lang: 'lg-nolan', value: TARGET_VALUE }] } },
		},
	],
});

describe.if(dbReady)('list emission of a source-array child (raw seam)', () => {
	let tsContext: Record<string, unknown>;

	beforeAll(async () => {
		await ensureSituation(EMISSION);
		const token = createSession(-1, 'root', true);
		const session = getSession(token);
		tsContext = {
			requestId: 'ddo-source-array-emission',
			clientIp: '127.0.0.1',
			session,
			csrfCandidate: session?.csrfToken ?? null,
			principal: await resolvePrincipal(-1),
		};
	}, 60000);

	afterAll(async () => {
		expect(await dropSituation(EMISSION)).toBe(0);
		// Every section read of a scratch section logs a dd542 LOAD row naming its
		// tipo (dd_core_api logReadActivity); dropSituation neither sweeps nor
		// counts them (test/helpers/activity_rows.ts) — sweep, then assert none left.
		const tipos = EMISSION.nodes.map((node) => node.tipo);
		for (const tipo of tipos) await sweepActivityRows(tipo);
		let activityResidue = 0;
		for (const tipo of tipos) activityResidue += await countActivityRows(tipo);
		expect(activityResidue).toBe(0);
	});

	test('the portal cell emits the source-array child value (data agrees with context)', async () => {
		const rqo = {
			action: 'read',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			options: {},
			source: {
				typo: 'source',
				model: 'section',
				tipo: HOST,
				section_tipo: HOST,
				action: 'search',
				mode: 'list',
				lang: 'lg-nolan',
			},
			sqo: { section_tipo: [HOST], limit: 1, offset: 0 },
			// the caller declares the portal and NO children → its own list config
			show: { ddo_map: [{ tipo: PORTAL, section_tipo: HOST, parent: HOST, mode: 'list' }] },
		};
		const body = (await dispatchRqo(structuredClone(rqo) as never, tsContext as never)).body as {
			ok?: boolean;
			data?: { data?: { tipo?: unknown; entries?: unknown; section_id?: unknown }[] };
		};
		expect(body.ok).not.toBe(false);
		const items = body.data?.data ?? [];
		expect(items.some((item) => item.tipo === PORTAL)).toBe(true); // anti-vacuity
		const child = items.find((item) => item.tipo === TARGET_TEXT);
		expect(child?.section_id).toBe(TARGET_ID);
		expect(child?.entries).toEqual([{ id: 1, lang: 'lg-nolan', value: TARGET_VALUE }]);
	}, 30000);
});
