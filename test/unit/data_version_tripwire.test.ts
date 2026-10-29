/**
 * The data version is DERIVED from the catalog (VERSIONING_SPEC §4, D2/D4 b):
 * DEDALO_DATA_VERSION is hand-set, but it must equal what the catalog derives
 * for this build — the highest data entry below NEXT, plus the entry AT NEXT
 * only on a tagged build of that release. A nightly never carries a data
 * entry of its own release (D2); a tagged release carries its own (D3).
 *
 * The derivation is pure (catalog.ts dataVersionOf) and is proven on synthetic
 * catalogs for both branches; the real tree is then held to the same function.
 */

import { describe, expect, test } from 'bun:test';
import { RELEASE_IDENTITY } from '../../src/core/update/build_stamp.ts';
import {
	DATA_LINE_START,
	dataVersionOf,
	UPDATE_CATALOG,
	type UpdateDescriptor,
} from '../../src/core/update/catalog.ts';
import {
	compareVersionArrays,
	DEDALO_DATA_VERSION,
	DEDALO_NEXT_RELEASE,
} from '../../src/core/update/version.ts';

function dataEntry(major: number, medium: number, minor: number): UpdateDescriptor {
	return {
		versionMajor: major,
		versionMedium: medium,
		versionMinor: minor,
		updateFromMajor: major,
		updateFromMedium: medium,
		updateFromMinor: 0,
		updateData: true,
	};
}

function codeEntry(major: number, medium: number, minor: number): UpdateDescriptor {
	return {
		versionMajor: major,
		versionMedium: medium,
		versionMinor: minor,
		updateFromMajor: major,
		updateFromMedium: medium,
		updateFromMinor: 0,
		updateData: false,
	};
}

describe('dataVersionOf: the derivation, on synthetic catalogs', () => {
	const cases: Array<{
		name: string;
		catalog: Record<string, UpdateDescriptor>;
		next: number[];
		tagged: boolean;
		expected: number[];
	}> = [
		{
			name: 'no entry: the line start',
			catalog: {},
			next: [7, 0, 0],
			tagged: false,
			expected: [7, 0, 0],
		},
		{
			name: 'an entry above NEXT is not due yet',
			catalog: { '7.1.0': dataEntry(7, 1, 0) },
			next: [7, 0, 0],
			tagged: true,
			expected: [7, 0, 0],
		},
		{
			name: 'an untagged nightly of the entry release does not move the data version (D2)',
			catalog: { '7.1.0': dataEntry(7, 1, 0) },
			next: [7, 1, 0],
			tagged: false,
			expected: [7, 0, 0],
		},
		{
			name: 'the tagged release carries its own data version (D3)',
			catalog: { '7.1.0': dataEntry(7, 1, 0) },
			next: [7, 1, 0],
			tagged: true,
			expected: [7, 1, 0],
		},
		{
			name: 'a code-only entry never moves the data version',
			catalog: { '7.0.1': codeEntry(7, 0, 1) },
			next: [7, 0, 1],
			tagged: true,
			expected: [7, 0, 0],
		},
		{
			name: 'the highest entry below NEXT wins',
			catalog: { '7.0.1': dataEntry(7, 0, 1), '7.1.0': dataEntry(7, 1, 0) },
			next: [7, 2, 0],
			tagged: false,
			expected: [7, 1, 0],
		},
		{
			name: 'key order does not decide: the highest triple does',
			catalog: { '7.1.0': dataEntry(7, 1, 0), '7.0.1': dataEntry(7, 0, 1) },
			next: [7, 1, 1],
			tagged: false,
			expected: [7, 1, 0],
		},
	];

	for (const row of cases) {
		test(row.name, () => {
			expect(dataVersionOf(row.catalog, row.next, row.tagged)).toEqual(row.expected);
		});
	}
});

describe('the real build: DEDALO_DATA_VERSION is the one its catalog derives', () => {
	const tagged = RELEASE_IDENTITY.kind !== 'dev';

	test('DATA equals the derivation for this build (tagged or untagged)', () => {
		expect([...DEDALO_DATA_VERSION]).toEqual(
			dataVersionOf(UPDATE_CATALOG, DEDALO_NEXT_RELEASE, tagged),
		);
	});

	test('DATA is the line start or a data entry of the catalog', () => {
		const isLineStart = compareVersionArrays(DEDALO_DATA_VERSION, DATA_LINE_START) === 0;
		const isEntry = Object.values(UPDATE_CATALOG).some(
			(d) =>
				d.updateData === true &&
				d.versionMajor === DEDALO_DATA_VERSION[0] &&
				d.versionMedium === DEDALO_DATA_VERSION[1] &&
				d.versionMinor === DEDALO_DATA_VERSION[2],
		);
		expect(isLineStart || isEntry).toBe(true);
	});

	test('NEXT is never below DATA', () => {
		expect(compareVersionArrays(DEDALO_NEXT_RELEASE, DEDALO_DATA_VERSION)).toBeGreaterThanOrEqual(
			0,
		);
	});

	test.skipIf(!tagged)('a tagged build is the release it names: NEXT is its tag triple', () => {
		expect([...DEDALO_NEXT_RELEASE]).toEqual([...RELEASE_IDENTITY.triple]);
	});
});
