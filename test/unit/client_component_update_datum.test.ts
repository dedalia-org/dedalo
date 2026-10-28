/**
 * component_common.build calls self.update_datum() for every non-standalone instance, so a
 * client component that borrows that build must borrow update_datum too. component_inverse
 * did not: tool_time_machine opened from it rebuilt the caller and threw
 * "self.update_datum is not a function" (feature crawl #9).
 */

import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CORE = join(import.meta.dir, '../../client/dedalo/core');

test('every component that borrows component_common.build also wires update_datum', () => {
	const borrowers: string[] = [];
	const missing: string[] = [];
	for (const dir of readdirSync(CORE).filter((name) => name.startsWith('component_'))) {
		let source: string;
		try {
			source = readFileSync(join(CORE, dir, 'js', `${dir}.js`), 'utf8');
		} catch {
			continue;
		}
		if (!/\.prototype\.build\s*=\s*component_common\.prototype\.build\b/.test(source)) continue;
		borrowers.push(dir);
		if (!/\.prototype\.update_datum\s*=/.test(source)) missing.push(dir);
	}
	expect(borrowers).toContain('component_inverse'); // non-vacuity
	expect(missing).toEqual([]);
});
