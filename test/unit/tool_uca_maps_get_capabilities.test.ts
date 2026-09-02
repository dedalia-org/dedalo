/**
 * tool_uca_maps — `get_capabilities` (hito 1 vertical slice).
 *
 * What this pins:
 *  - the DECLARED gate: 'record_tipo' at read level (1) — a downgrade to
 *    `permission: null` or a plain 'section'/'tipo' would silently drop half
 *    of the record_tipo check (engineering/TOOLS_SPEC.md "Choosing a
 *    permission kind"), so the shape itself is a real assertion, not a
 *    tautology;
 *  - the handler's own contract: envelope v2 (`ok:true`, a `data` payload,
 *    never the forbidden `result` mirror), and every probed binary reporting
 *    the `{available, path, version}` / `{available, path}` shape regardless
 *    of what is actually installed on the machine running the suite.
 *
 * The declarative permission GATE ITSELF (dispatch.ts gates 1-8) is core
 * machinery, already gated by test/unit/tools_dispatch.test.ts and
 * test/unit/tools_record_tipo_permission.test.ts — reachability for THIS
 * action is not re-proven here (CLAUDE.local.md: no edits outside
 * tools/tool_uca_maps/ beyond the four named files, and those core suites are
 * where a new action would be enumerated if this repo owned them).
 *
 * No DB write: get_capabilities probes the local filesystem/binaries only.
 */

import { describe, expect, test } from 'bun:test';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type {
	GatedToolActionSpec,
	ToolActionContext,
	ToolResponse,
} from '../../src/core/tools/module.ts';
import { mustGet } from '../helpers/assert.ts';

async function loadAction(): Promise<GatedToolActionSpec> {
	const loaded = await getLoadedTool('tool_uca_maps');
	expect(loaded).not.toBeNull();
	const action = mustGet(loaded?.module.apiActions.get_capabilities, 'get_capabilities');
	// permission:null would fail this cast at the type level in a real caller;
	// asserting the declared kind below is the actual behavioural check.
	return action as GatedToolActionSpec;
}

function contextOf(): ToolActionContext {
	return {
		principal: { userId: -1, isGlobalAdmin: true, isDeveloper: true },
		userId: -1,
		options: { section_tipo: 'test2', tipo: 'test52', section_id: 905101 },
		background: false,
	};
}

describe('tool_uca_maps get_capabilities — declared gate', () => {
	test('is record_tipo at read level (1), not a downgraded kind', async () => {
		const action = await loadAction();
		expect(action.permission).toBe('record_tipo');
		expect(action.minLevel).toBe(1);
	});
});

describe('tool_uca_maps get_capabilities — handler contract', () => {
	test('answers envelope v2 with every probed binary in the declared shape', async () => {
		const action = await loadAction();
		const response: ToolResponse = await action.handler(contextOf());

		expect(response.ok).toBe(true);
		expect('result' in response).toBe(false); // forbidden PHP-era mirror key

		const data = (response as { data: Record<string, unknown> }).data;
		for (const key of ['gdal', 'ogr2ogr', 'gdalTranslate'] as const) {
			const binary = data[key] as { available: unknown; path: unknown; version: unknown };
			expect(typeof binary.available).toBe('boolean');
			expect(binary.path === null || typeof binary.path === 'string').toBe(true);
			expect(binary.version === null || typeof binary.version === 'string').toBe(true);
			// a binary reported unavailable must never carry a resolved path/version
			if (binary.available === false) {
				expect(binary.path).toBeNull();
				expect(binary.version).toBeNull();
			}
		}

		const imagemagick = data.imagemagick as { available: unknown; path: unknown };
		expect(typeof imagemagick.available).toBe('boolean');
		expect(imagemagick.path === null || typeof imagemagick.path === 'string').toBe(true);
		expect(imagemagick.available).toBe(imagemagick.path !== null);
	});
});
