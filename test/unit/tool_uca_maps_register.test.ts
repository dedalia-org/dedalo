/**
 * tool_uca_maps — register.json validates as an AUTHORING-format manifest.
 *
 * A malformed authoring file fails silently at import time (register.ts:
 * "detects the format… validates it"), not at edit time — this pins the same
 * zod schema `importTools` runs against, on the actual checked-in file, so a
 * typo (a bad lang key, a missing required field) fails the SUITE instead of
 * surfacing as "tool_uca_maps: unregistered" days later on a real install.
 *
 * The label half used to be a HAND-WRITTEN list of the keys hito 1 happened to
 * use, so every hito after it widened the gap in silence (review-diff, hito
 * 17): a `get_tool_label('legend_titel_placeholder')` typo ships as a
 * permanently-English string in the Spanish UI, because every call site carries
 * an English `||` fallback and the client suite forces `get_tool_label` to
 * return undefined. It now DERIVES the used keys from the client source, so the
 * two sides cannot drift: every key a call site asks for must exist in both
 * shipped languages.
 */

import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { authoringRegisterSchema } from '../../src/core/tools/register_schema.ts';

const TOOL_DIR = new URL('../../tools/tool_uca_maps/', import.meta.url);

/** `self.get_tool_label('some_key')` — the only form the tool's own client
 * uses for a literal key. The two dynamic call sites (the `get_tool_label`
 * DEFINITION in tool_uca_maps.js and a helper that forwards its argument in
 * render_object_console.js) carry no literal and are correctly not matched. */
const LABEL_CALL = /get_tool_label\(\s*'([A-Za-z0-9_]+)'\s*\)/g;

async function usedLabelKeys(): Promise<Set<string>> {
	const keys = new Set<string>();
	// js/lib/ is vendored third-party code — it never calls get_tool_label
	const glob = new Glob('js/**/*.js');
	for await (const relative of glob.scan({ cwd: Bun.fileURLToPath(TOOL_DIR) })) {
		if (relative.startsWith('js/lib/')) {
			continue;
		}
		const source = await Bun.file(new URL(relative, TOOL_DIR)).text();
		for (const match of source.matchAll(LABEL_CALL)) {
			keys.add(match[1] as string);
		}
	}
	return keys;
}

describe('tool_uca_maps register.json', () => {
	test('parses as a valid authoring-format manifest', async () => {
		const raw = await Bun.file(new URL('register.json', TOOL_DIR)).json();
		const parsed = authoringRegisterSchema.safeParse(raw);
		if (!parsed.success) {
			throw new Error(`register.json failed authoring schema: ${parsed.error.message}`);
		}
		expect(parsed.data.name).toBe('tool_uca_maps');
		expect(parsed.data.affected_models).toEqual(['component_geolocation']);
	});

	test('every label key the client asks for is shipped in every language', async () => {
		const raw = await Bun.file(new URL('register.json', TOOL_DIR)).json();
		const parsed = authoringRegisterSchema.parse(raw);
		const labels = parsed.labels ?? [];

		const langs = [...new Set(labels.map((label) => label.lang))].sort();
		expect(langs.length).toBeGreaterThan(0);

		const shipped = new Map<string, Set<string>>();
		for (const label of labels) {
			const forKey = shipped.get(label.name) ?? new Set<string>();
			forKey.add(label.lang);
			shipped.set(label.name, forKey);
		}

		const used = await usedLabelKeys();
		// a floor, so an accidentally-empty scan (a moved directory, a changed
		// call shape) cannot pass as "nothing to check"
		expect(used.size).toBeGreaterThan(40);

		// only this direction: a key the client asks for MUST ship. The reverse
		// (a shipped key nothing asks for) is not a defect here — several
		// families are addressed by computed keys the scan cannot see
		// (`get_tool_label('raster_format_' + format)`, `'ua_level_' + level`,
		// `'info_' + info.label_key`), so set-equality would fail on correct code.
		const missing = [...used]
			.filter((key) => langs.some((lang) => !shipped.get(key)?.has(lang)))
			.sort();
		expect(missing).toEqual([]);
	});
});
