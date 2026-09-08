/**
 * tool_uca_maps — `get_administrative_unit` (fila #9, "UA").
 *
 * What this pins:
 *  - the DECLARED gate: 'record_tipo' at read level (1), same criterion as
 *    every other read-only action this tool ships;
 *  - the handler's caller-fault validation: a missing/malformed click
 *    payload (`parseClickParams`, shared with `get_catastro_parcel`) and a
 *    missing/invalid `level` are both refused BEFORE any outbound fetch.
 *
 * The live "reaches www.ign.es" path is NOT exercised here — same reasoning
 * as `tool_uca_maps_get_wms_layers.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { GatedToolActionSpec, ToolActionContext } from '../../src/core/tools/module.ts';
import { mustGet } from '../helpers/assert.ts';

async function loadAction(): Promise<GatedToolActionSpec> {
	const loaded = await getLoadedTool('tool_uca_maps');
	expect(loaded).not.toBeNull();
	const action = mustGet(
		loaded?.module.apiActions.get_administrative_unit,
		'get_administrative_unit',
	);
	return action as GatedToolActionSpec;
}

const VALID_CLICK = { bbox: [-1, 38, -0.9, 38.1], width: 512, height: 400, x: 128, y: 64 };

function contextOf(options: Record<string, unknown>): ToolActionContext {
	return {
		principal: { userId: -1, isGlobalAdmin: true, isDeveloper: true },
		userId: -1,
		options: { section_tipo: 'test2', tipo: 'test52', section_id: 905101, ...options },
		background: false,
	};
}

describe('tool_uca_maps get_administrative_unit — declared gate', () => {
	test('is record_tipo at read level (1)', async () => {
		const action = await loadAction();
		expect(action.permission).toBe('record_tipo');
		expect(action.minLevel).toBe(1);
	});
});

describe('tool_uca_maps get_administrative_unit — handler validation', () => {
	test('a missing bbox is refused as request.invalid_options, before the level check', async () => {
		const action = await loadAction();
		await expect(action.handler(contextOf({ level: 'Municipio' }))).rejects.toThrow(/bounding box/);
	});

	test('a missing/unknown level is refused as request.invalid_options', async () => {
		const action = await loadAction();
		await expect(action.handler(contextOf(VALID_CLICK))).rejects.toThrow(/administrative level/);
		await expect(action.handler(contextOf({ ...VALID_CLICK, level: 'Galaxy' }))).rejects.toThrow(
			/administrative level/,
		);
	});
});
