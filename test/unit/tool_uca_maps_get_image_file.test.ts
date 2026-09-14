/**
 * tool_uca_maps — `get_image_file` (fila #3: where an image associated with a
 * drawn object is served from).
 *
 * What this pins:
 *  - the DECLARED gate: 'record_tipo' at read level (1) — and note WHICH
 *    record it names: the IMAGE component's (rsc29/rsc170), not the map's, so
 *    the check asks whether the caller may read the thing whose media path
 *    the answer discloses;
 *  - that the action REFUSES a component that is not an image, rather than
 *    scanning whatever files happen to sit under some other model's record;
 *  - that `image_overlay.ts` and this action resolve the SAME tier, because
 *    they are now literally the same function — the regression this replaces
 *    is the two drifting apart and a map overlay and a gallery thumbnail
 *    showing different versions of one upload.
 */

import { describe, expect, test } from 'bun:test';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { GatedToolActionSpec } from '../../src/core/tools/module.ts';
import { getImageFile, OVERLAY_EXTENSIONS } from '../../tools/tool_uca_maps/server/image_media.ts';
import { mustGet } from '../helpers/assert.ts';

async function loadAction(name: string): Promise<GatedToolActionSpec> {
	const loaded = await getLoadedTool('tool_uca_maps');
	expect(loaded).not.toBeNull();
	return mustGet(loaded?.module.apiActions[name], name) as GatedToolActionSpec;
}

describe('tool_uca_maps get_image_file — declared gate', () => {
	test('is record_tipo at read level (1)', async () => {
		const action = await loadAction('get_image_file');
		expect(action.permission).toBe('record_tipo');
		expect(action.minLevel).toBe(1);
	});

	test('carries the same gate as get_image_overlay — both disclose a media path', async () => {
		const file = await loadAction('get_image_file');
		const overlay = await loadAction('get_image_overlay');
		expect(file.permission).toBe(overlay.permission);
		expect(file.minLevel).toBe(overlay.minLevel);
	});

	test('the registered handler is the module function, not a wrapper that could skip it', async () => {
		const action = await loadAction('get_image_file');
		expect(action.handler).toBe(getImageFile);
	});
});

describe('the served-tier contract', () => {
	test('only browser-renderable extensions are candidates — a master .tif never is', () => {
		expect(OVERLAY_EXTENSIONS).toContain('jpg');
		expect(OVERLAY_EXTENSIONS).toContain('png');
		expect(OVERLAY_EXTENSIONS).not.toContain('tif');
		expect(OVERLAY_EXTENSIONS).not.toContain('tiff');
		expect(OVERLAY_EXTENSIONS).not.toContain('psd');
	});
});

describe('get_image_file — refusals', () => {
	test('a component that is not an image is refused, not scanned', async () => {
		// test52 is the geolocation component of the generic test TLD — a real
		// tipo, and deliberately the wrong model for this action
		expect(
			getImageFile({
				principal: { userId: -1, isGlobalAdmin: true, isDeveloper: true },
				userId: -1,
				options: { section_tipo: 'test2', tipo: 'test52', section_id: 905101 },
				background: false,
			}),
		).rejects.toThrow();
	});
});
