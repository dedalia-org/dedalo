/**
 * The installation colour (src/config/instance_color.ts): opt-in — active only
 * for a valid DEDALO_INSTANCE_COLOR, never derived, never passed through malformed.
 */
import { describe, expect, test } from 'bun:test';
import { resolveInstanceColor } from '../../src/config/instance_color.ts';

describe('instance colour', () => {
	test('a valid value is active, normalised to lower case', () => {
		expect(resolveInstanceColor(' #B23838 ')).toBe('#b23838');
	});

	test('unset or empty: feature off', () => {
		expect(resolveInstanceColor(undefined)).toBeNull();
		expect(resolveInstanceColor('')).toBeNull();
		expect(resolveInstanceColor('   ')).toBeNull();
	});

	test('malformed value: feature off, refused loudly (it is painted into page CSS)', () => {
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => errors.push(args[0]);
		try {
			for (const bad of ['red', '#fff', '#12345g', '#123456; background:url(x)']) {
				expect(resolveInstanceColor(bad)).toBeNull();
			}
		} finally {
			console.error = original;
		}
		expect(errors.length).toBe(4);
		expect(String(errors[0])).toContain('DEDALO_INSTANCE_COLOR');
	});
});
