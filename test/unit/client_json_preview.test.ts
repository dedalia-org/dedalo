/**
 * component_json list cells preview a value with `json_preview`
 * (component_json/js/json_preview.js): the first `max` chars of its
 * JSON, built without serializing the whole value. Same text as
 * `JSON.stringify(value).substring(0, max)` on JSON data.
 */
import { beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';

let json_preview: (value: unknown, max: number) => string;

beforeAll(async () => {
	({ json_preview } = await import(
		join(import.meta.dir, '..', '..', 'client', 'dedalo', 'core', 'component_json', 'js', 'json_preview.js')
	));
});

test('json_preview equals the truncated full stringify', () => {
	const big = Array.from({ length: 5000 }, (_, i) => ({ id: i, msg: `m"${i}`, n: null, ok: true, sub: [1, 'x', { a: 'é' }] }));
	const cases: unknown[] = [[], {}, [{}], [{ a: 1 }], 'x'.repeat(500), 42, null, [{ msg: 'a\nb' }], big, { k: big }];
	for (const value of cases) {
		for (const max of [1, 5, 100]) expect(json_preview(value, max)).toBe(JSON.stringify(value).substring(0, max));
	}
});
