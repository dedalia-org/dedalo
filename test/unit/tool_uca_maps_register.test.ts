/**
 * tool_uca_maps — register.json validates as an AUTHORING-format manifest.
 *
 * A malformed authoring file fails silently at import time (register.ts:
 * "detects the format… validates it"), not at edit time — this pins the same
 * zod schema `importTools` runs against, on the actual checked-in file, so a
 * typo (a bad lang key, a missing required field) fails the SUITE instead of
 * surfacing as "tool_uca_maps: unregistered" days later on a real install.
 */

import { describe, expect, test } from 'bun:test';
import { authoringRegisterSchema } from '../../src/core/tools/register_schema.ts';

describe('tool_uca_maps register.json', () => {
	test('parses as a valid authoring-format manifest', async () => {
		const raw = await Bun.file(
			new URL('../../tools/tool_uca_maps/register.json', import.meta.url),
		).json();
		const parsed = authoringRegisterSchema.safeParse(raw);
		if (!parsed.success) {
			throw new Error(`register.json failed authoring schema: ${parsed.error.message}`);
		}
		expect(parsed.data.name).toBe('tool_uca_maps');
		expect(parsed.data.affected_models).toEqual(['component_geolocation']);
		// every label entry references a name actually used by get_tool_label()
		// call sites in this hito's client code — catches a renamed key going
		// stale on one side only.
		const labelNames = new Set((parsed.data.labels ?? []).map((l) => l.name));
		for (const used of [
			'capabilities_title',
			'capabilities_gdal',
			'capabilities_imagemagick',
			'capability_available',
			'capability_unavailable',
			'waiting_for_map',
			'map_not_found',
			'uca_maps_control_title',
		]) {
			expect(labelNames.has(used)).toBe(true);
		}
	});
});
