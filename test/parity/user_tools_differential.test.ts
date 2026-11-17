/**
 * Phase 6 gate: dd_tools_api::user_tools differential (superuser path).
 *
 * The superuser is authorized for every ACTIVE tool, so get_user_tools returns
 * the full registry with no per-tool availability check. The TS resolver reads
 * the same matrix_tools registry (active = dd1354 → dd64/1) and builds the same
 * simple-context DDOs. We assert byte-parity of the whole 34-tool list, keyed
 * by tool name (order aside), on every DDO field.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { getSuperuserUserTools } from '../../src/core/tools/registry.ts';
import { hasPhpCredentials, PhpApiClient } from './php_client.ts';

const USER_TOOLS_RQO = {
	dd_api: 'dd_tools_api',
	action: 'user_tools',
	source: {
		typo: 'source',
		model: 'menu',
		tipo: 'dd85',
		section_tipo: 'dd85',
		mode: 'list',
		lang: 'lg-eng',
	},
	options: { ar_requested_tools: null },
};

type ToolDdo = Record<string, unknown> & { name: string };

/**
 * TS-only tools (WC-019): registered in the shared dd1324 but with no PHP
 * package on disk — PHP's get_all_registered_tools IGNORES such rows ("bad
 * config" continue, tool_common.php:788-796), so its lists never carry them.
 * Filtered from the TS side before comparing.
 */
const TS_ONLY_TOOLS: ReadonlySet<string> = new Set(['tool_error_report']);

/**
 * Tools REGISTERED AFTER the 2026-07-11 harvest froze the oracle store
 * (WC-2026-08-23-user-tools-post-harvest-census): the frozen 35-tool list can
 * never carry them, so they are filtered from the TS side — and POSITIVELY
 * asserted present there (below), so the filter can never hide a tool that
 * silently fell out of the registry. Grow-only, one WC citation each.
 */
const POST_HARVEST_TS_TOOLS: ReadonlyMap<string, string> = new Map([
	['tool_bibliography_acquisition', 'WC-2026-10-07-acquisition-tools-ts-only'],
	['tool_identify', 'WC-062'],
	['tool_numisdata_acquisition', 'WC-2026-10-07-acquisition-tools-ts-only'],
	['tool_rag', 'WC-2026-10-01-ai-spend-budget'],
	['tool_sitebuilder', 'WC-035'],
	['tool_uca_maps', 'WC-2026-11-17-tool-uca-maps-ts-only'],
]);

/**
 * Post-harvest FIELD flips on tools the frozen list DOES carry
 * (WC-2026-08-23-user-tools-post-harvest-census): dd1332 (tool_ontology)
 * `show_in_component` was deliberately set true in d43cadc1d7 (2026-07-26,
 * "feat(tool_ontology): show on ontology components") — 15 days after the
 * harvest, so the frozen DDO still says false. The oracle side is normalized
 * to the adopted value, and the TS side is POSITIVELY asserted to carry it,
 * so a regression back to false reddens instead of matching the stale record.
 */
const POST_HARVEST_FIELD_FLIPS: ReadonlyArray<{
	tool: string;
	field: string;
	adopted: unknown;
}> = [{ tool: 'tool_ontology', field: 'show_in_component', adopted: true }];

/** Index a tool list by name for order-independent comparison. */
function byName(tools: ToolDdo[]): Map<string, ToolDdo> {
	return new Map(
		tools
			.filter((tool) => !TS_ONLY_TOOLS.has(tool.name) && !POST_HARVEST_TS_TOOLS.has(tool.name))
			.map((tool) => [tool.name, tool]),
	);
}

describe.if(hasPhpCredentials())('user_tools differential (Phase 6 gate)', () => {
	let phpTools: ToolDdo[];
	let tsTools: ToolDdo[];

	beforeAll(async () => {
		const client = new PhpApiClient();
		await client.login(
			config.phpReference.username as string,
			config.phpReference.password as string,
		);
		const { body } = await client.call(structuredClone(USER_TOOLS_RQO));
		phpTools = (body.result as ToolDdo[]) ?? [];
		tsTools = (await getSuperuserUserTools()) as unknown as ToolDdo[];
	});

	test('the same set of active tools is returned', () => {
		expect(tsTools.length).toBeGreaterThan(0);
		const phpNames = [...byName(phpTools).keys()].sort();
		const tsNames = [...byName(tsTools).keys()].sort();
		expect(tsNames).toEqual(phpNames);
	});

	test('every post-harvest tool the filter removes IS actually served by TS', () => {
		// The recovery half of the POST_HARVEST_TS_TOOLS filter: a filtered
		// name that stopped being served would otherwise vanish from parity
		// coverage entirely.
		const tsNames = new Set(tsTools.map((tool) => tool.name));
		for (const [name, wc] of POST_HARVEST_TS_TOOLS) {
			expect(
				tsNames.has(name),
				`'${name}' (${wc}) is filtered as a post-harvest registration but the TS registry no longer serves it — the filter is hiding a real regression`,
			).toBe(true);
		}
	});

	test('every tool DDO matches PHP field-for-field', () => {
		const phpByName = byName(phpTools);
		const tsByName = byName(tsTools);
		// Adopt the ledgered post-harvest field flips onto the ORACLE side —
		// and prove the TS side actually carries each adopted value first.
		for (const flip of POST_HARVEST_FIELD_FLIPS) {
			const tsTool = tsByName.get(flip.tool);
			if (tsTool === undefined) continue; // set diff above reddens instead
			expect(
				tsTool[flip.field],
				`'${flip.tool}'.${flip.field} no longer serves the adopted post-harvest value — the normalization would mask a regression`,
			).toEqual(flip.adopted);
			const phpTool = phpByName.get(flip.tool);
			if (phpTool !== undefined) phpTool[flip.field] = flip.adopted;
		}
		for (const [name, phpTool] of phpByName) {
			const tsTool = tsByName.get(name);
			expect(tsTool).toBeDefined();
			// Compare the fields the TS resolver produces; PHP may carry a couple
			// of null-valued extras (e.g. developer) that dd_object drops, so we
			// assert on the resolver's own keys and confirm PHP agrees on each.
			for (const key of Object.keys(tsTool as object)) {
				expect((tsTool as ToolDdo)[key]).toEqual((phpTool as ToolDdo)[key]);
			}
		}
	});
});
