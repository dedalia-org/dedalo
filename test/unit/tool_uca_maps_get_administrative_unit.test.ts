/**
 * tool_uca_maps — `get_administrative_unit` (fila #9, "UA").
 *
 * What this pins:
 *  - the handler's caller-fault validation: a missing/malformed click
 *    payload (`parseClickParams`, shared with `get_catastro_parcel`) and a
 *    missing/invalid `level` are both refused BEFORE any outbound fetch.
 *
 * The live "reaches www.ign.es" path is NOT exercised here — same reasoning
 * as `tool_uca_maps_get_wms_layers.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { contextOf, loadAction } from './fixtures/tool_uca_maps/helpers.ts';

const VALID_CLICK = { bbox: [-1, 38, -0.9, 38.1], width: 512, height: 400, x: 128, y: 64 };

describe('tool_uca_maps get_administrative_unit — handler validation', () => {
	test('a missing bbox is refused as request.invalid_options, before the level check', async () => {
		const action = await loadAction('get_administrative_unit');
		await expect(action.handler(contextOf({ level: 'Municipio' }))).rejects.toThrow(/bounding box/);
	});

	test('a missing/unknown level is refused as request.invalid_options', async () => {
		const action = await loadAction('get_administrative_unit');
		await expect(action.handler(contextOf(VALID_CLICK))).rejects.toThrow(/administrative level/);
		await expect(action.handler(contextOf({ ...VALID_CLICK, level: 'Galaxy' }))).rejects.toThrow(
			/administrative level/,
		);
	});
});
