/**
 * Unit gates for the shared section_tool tool_context helper
 * (src/core/tools/section_tool_context.ts) — the PHP
 * tool_common::create_tool_simple_context enrichment semantics both the menu
 * rewrite and the `start` reroute depend on. DB-backed (ontology lookups), no
 * oracle needed; the wire shape itself is pinned by
 * test/parity/section_tool_start_differential.test.ts and menu_differential.
 *
 * @twin-of      test/parity/section_tool_start_differential.test.ts
 * @twin-status  supplement
 */
// Migrated to the generic `test` TLD 2026-08-19 (AGENTS.md hard rules): every
// install tipo was rewritten through src/core/test_data/test_tld_tipo_map.json;
// seed-shipped ontology (dd/rsc/hierarchy/lg) stays and is spelled through `seed()`,
// which keeps it out of the install-TLD census's `<tld><digits>` token grammar.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	buildSectionToolContext,
	enrichToolConfig,
} from '../../src/core/tools/section_tool_context.ts';
import type { ToolSimpleContext } from '../../src/core/tools/types.ts';
import { DB_READY } from '../helpers/db_ready.ts';

// A stable core-ontology tipo for the enrichment lookups (dd85 = menu).
const REAL_TIPO = 'dd85';

const FAKE_TOOL = {
	typo: 'ddo',
	type: 'tool',
	section_tipo: 'dd1324',
	mode: 'edit',
	model: 'tool_fake',
	label: 'Fake tool',
	css: { url: '/x.css' },
	name: 'tool_fake',
	icon: '/x.svg',
	show_in_inspector: false,
	show_in_component: false,
} as unknown as ToolSimpleContext;

describe('enrichToolConfig (create_tool_simple_context semantics)', () => {
	test("resolves 'self' sentinels to the passed tipos (null by default) and stamps model/translatable/label", async () => {
		const raw = {
			ddo_map: [
				{ role: 'caller', tipo: 'self', section_tipo: 'self' },
				{ role: 'real', tipo: REAL_TIPO, section_tipo: 'dd85' },
			],
		};
		const enriched = (await enrichToolConfig(raw)) as {
			ddo_map: Record<string, unknown>[];
		};
		// 'self' → null when no runtime tipo is passed (menu + start flows);
		// a null tipo gets NO enrichment stamps (PHP guards identically).
		expect(enriched.ddo_map[0]!.tipo).toBeNull();
		expect(enriched.ddo_map[0]!.section_tipo).toBeNull();
		expect(enriched.ddo_map[0]!.model).toBeUndefined();
		// A real tipo gets model + translatable + label stamped.
		expect(typeof enriched.ddo_map[1]!.model).toBe('string');
		expect(typeof enriched.ddo_map[1]!.translatable).toBe('boolean');
		expect(typeof enriched.ddo_map[1]!.label).toBe('string');
		expect((enriched.ddo_map[1]!.label as string).length).toBeGreaterThan(0);

		const withSelf = (await enrichToolConfig(raw, 'test6813', 'test6813')) as {
			ddo_map: Record<string, unknown>[];
		};
		expect(withSelf.ddo_map[0]!.tipo).toBe('test6813');
		expect(withSelf.ddo_map[0]!.section_tipo).toBe('test6813');
	});

	test('NEVER mutates the input (the raw ontology row properties)', async () => {
		const raw = { ddo_map: [{ role: 'caller', tipo: 'self', section_tipo: REAL_TIPO }] };
		const before = JSON.stringify(raw);
		await enrichToolConfig(raw);
		expect(JSON.stringify(raw)).toBe(before);
	});

	test('null/ddo_map-less configs pass through untouched', async () => {
		expect(await enrichToolConfig(null)).toBeNull();
		expect(await enrichToolConfig({ open: true })).toEqual({ open: true });
	});

	test('an existing model is KEPT (PHP fills only when missing)', async () => {
		const enriched = (await enrichToolConfig({
			ddo_map: [{ tipo: REAL_TIPO, section_tipo: 'dd85', model: 'component_custom' }],
		})) as { ddo_map: Record<string, unknown>[] };
		expect(enriched.ddo_map[0]!.model).toBe('component_custom');
	});
});

describe('buildSectionToolContext', () => {
	test('unknown tool or empty bag → null (caller decides drop vs ship-without)', async () => {
		expect(await buildSectionToolContext({}, [FAKE_TOOL])).toBeNull();
		expect(await buildSectionToolContext({ tool_other: {} }, [FAKE_TOOL])).toBeNull();
	});

	test('known tool → simple context + tool_config appended LAST (wire-load-bearing order)', async () => {
		const bag = { tool_fake: { ddo_map: [{ role: 'x', tipo: REAL_TIPO, section_tipo: 'dd85' }] } };
		const context = (await buildSectionToolContext(bag, [FAKE_TOOL])) as Record<string, unknown>;
		expect(context).not.toBeNull();
		expect(context.name).toBe('tool_fake');
		// PHP sets tool_config after the DDO is built (class.tool_common.php:663)
		// — it must serialize as the LAST key.
		expect(Object.keys(context).at(-1)).toBe('tool_config');
		const ddoMap = (context.tool_config as { ddo_map: Record<string, unknown>[] }).ddo_map;
		expect(typeof ddoMap[0]!.label).toBe('string');
	});
});

/**
 * THE REFUSAL CONTRACT, natively (WC-2026-10-28-section-tool-test6402-config). A section_tool
 * whose properties carry no `config.target_section_tipo` names no buildable section, and `start`
 * refuses it loudly (PHP fatals on the same node). This was pinned through `test6402` in the
 * parity differential until the master ontology fixed its twin numisdata625 (the v6
 * `properties.context` key renamed `config`); the scratch pair below keeps both halves.
 */
const NO_CONFIG = 'zzstc1';
const WITH_CONFIG = 'zzstc2';
const SECTION_TOOL_SITUATION = situation({
	name: 'section_tool start refusal',
	tld: 'zzstc',
	nodes: [
		{
			tipo: NO_CONFIG,
			parent: 'test1',
			model: 'section_tool',
			term: { 'lg-eng': 'zzstc no config' },
			// the v6 key the engine does not read — exactly test6402's former shape
			properties: { context: { target_section_tipo: 'test3' } },
		},
		{
			tipo: WITH_CONFIG,
			parent: 'test1',
			model: 'section_tool',
			order_number: 2,
			term: { 'lg-eng': 'zzstc config' },
			properties: { config: { target_section_tipo: 'test3' } },
		},
	],
});

describe.if(DB_READY)(
	'start on a section_tool: config.target_section_tipo or a loud refusal',
	() => {
		const adminContext = {
			requestId: 'section_tool_start',
			clientIp: '127.0.0.1',
			session: {
				userId: -1,
				username: 'root',
				isGlobalAdmin: true,
				csrfToken: 'x',
				applicationLang: null,
				dataLang: null,
			},
			csrfCandidate: 'x',
			principal: { userId: -1, isGlobalAdmin: true, isDeveloper: true },
		} as unknown as ApiRequestContext;
		const start = (tipo: string) =>
			dispatchRqo(
				{
					action: 'start',
					dd_api: 'dd_core_api',
					options: { search_obj: { t: tipo, m: 'list' }, menu: false },
				} as Rqo,
				adminContext,
			);

		beforeAll(async () => {
			await assertTestDatabase('section_tool_context start');
			await ensureSituation(SECTION_TOOL_SITUATION);
		});
		afterAll(async () => {
			expect(await dropSituation(SECTION_TOOL_SITUATION)).toBe(0);
		});

		test('no config (a v6 `context` key) → refused, resource.conflict, ok:false', async () => {
			const refused = await start(NO_CONFIG);
			expect(refused.body.ok).toBe(false);
			expect((refused.body.error as { code?: string }).code).toBe('resource.conflict');
		});

		test('config.target_section_tipo → rerouted to the target section (non-vacuity)', async () => {
			const rerouted = await start(WITH_CONFIG);
			expect(rerouted.status).toBe(200);
			const context = (rerouted.body.data as { context: { tipo: string; model: string }[] })
				.context;
			expect(context[0]).toMatchObject({ tipo: 'test3', model: 'section' });
		});
	},
);
