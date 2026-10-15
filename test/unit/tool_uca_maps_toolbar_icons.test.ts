/**
 * tool_uca_maps — every toolbar icon a button names is drawn.
 *
 * `create_toolbar_button({icon})` only adds a `uca-maps-icon-<name>` class; the
 * glyph is a CSS mask of a core theme icon. A name with no rule, or a rule whose
 * file is not there, renders an EMPTY white square with every client test green
 * (they assert the class, not the painted mask). This pins both links.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url);
const JS_DIR = new URL('tools/tool_uca_maps/js/', ROOT);
const SHEET = new URL('tools/tool_uca_maps/css/tool_uca_maps.css', ROOT);
// the sheet is served from <root>/tools/tool_uca_maps/css/ and the theme from
// <root>/core/themes/ (client/dedalo/ is the served root)
const SERVED_CSS_DIR = new URL('client/dedalo/tools/tool_uca_maps/css/', ROOT);

const ICON_OPTION = /\bicon\s*:\s*'([a-z0-9_-]+)'/g;

const usedIcons = (): string[] => {
	const names = new Set<string>();
	for (const file of readdirSync(JS_DIR)) {
		if (!file.endsWith('.js')) continue;
		const source = readFileSync(new URL(file, JS_DIR), 'utf8');
		for (const match of source.matchAll(ICON_OPTION)) names.add(match[1]!);
	}
	return [...names].sort();
};

describe('tool_uca_maps toolbar icons', () => {
	const sheet = readFileSync(SHEET, 'utf8');
	const icons = usedIcons();

	test('the buttons name icons at all (floor, so an empty scan cannot pass)', () => {
		expect(icons.length).toBeGreaterThanOrEqual(6);
	});

	test.each(icons)(
		'"%s" has its mask rule in the compiled sheet, on a core icon that exists',
		(name) => {
			const rule = new RegExp(
				`\\.uca-maps-icon-${name}\\s*\\{[^}]*mask-image:\\s*url\\('([^']+)'\\)`,
			);
			const match = sheet.match(rule);
			expect(match, `no .uca-maps-icon-${name} mask rule in tool_uca_maps.css`).not.toBeNull();
			const resolved = new URL(match![1]!, SERVED_CSS_DIR);
			expect(
				resolved.pathname.endsWith(`/client/dedalo/core/themes/default/icons/${name}.svg`),
			).toBe(true);
			expect(existsSync(resolved), `${resolved.pathname} missing`).toBe(true);
		},
	);
});
