/**
 * tool_uca_maps — `get_capabilities` (hito 1 vertical slice).
 *
 * What this pins:
 *  - the handler's own contract: envelope v2 (`ok:true`, a `data` payload,
 *    never the forbidden `result` mirror), and every probed binary reporting
 *    the `{available, path, version}` / `{available, path}` shape regardless
 *    of what is actually installed on the machine running the suite.
 *
 * No DB write: get_capabilities probes the local filesystem/binaries only.
 */

import { describe, expect, test } from 'bun:test';
import type { ToolResponse } from '../../src/core/tools/module.ts';
import { contextOf, dataOf, loadAction } from './fixtures/tool_uca_maps/helpers.ts';

describe('tool_uca_maps get_capabilities — handler contract', () => {
	test('answers envelope v2 with every probed binary in the declared shape', async () => {
		const action = await loadAction('get_capabilities');
		const response: ToolResponse = await action.handler(contextOf());

		const data = dataOf(response);
		expect('result' in response).toBe(false); // forbidden PHP-era mirror key

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

		// hito 18 (fila #14): the local gazetteer store is reported the same
		// way a binary is — and it NEVER names the install's own directory,
		// only what can be served out of it
		// importing an object's linked images is on unless an install turns
		// it off, and the suite never does
		expect(data.externalImages).toBe(true);

		const gazetteers = data.gazetteers as {
			configured: unknown;
			pleiades: unknown;
			pelagios: unknown;
		};
		expect(typeof gazetteers.configured).toBe('boolean');
		expect(typeof gazetteers.pleiades).toBe('boolean');
		expect(Array.isArray(gazetteers.pelagios)).toBe(true);
		expect(Object.keys(gazetteers).sort()).toEqual(['configured', 'pelagios', 'pleiades']);
		if (gazetteers.configured === false) {
			expect(gazetteers.pleiades).toBe(false);
			expect(gazetteers.pelagios).toEqual([]);
		}
	});
});
