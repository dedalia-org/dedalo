/**
 * D2 — NIGHTLIES NEVER CARRY DATA CHANGES (VERSIONING_SPEC §4 D2).
 *
 * An UNTAGGED build (RELEASE_IDENTITY.kind === 'dev') names the next release
 * (`7.0.1-dev`) but has not been released, so its unreleased data entry at that
 * triple waits for the tag. The engine must therefore never MATCH that entry on
 * a dev build: `getMatchedDescriptor(DATA)` — the migration a dev install at its
 * data version would run — must not return a descriptor whose triple equals NEXT.
 *
 * data_version_tripwire.test.ts proves the data VERSION derivation; this gate
 * proves the ENGINE side: the descriptor the update path would actually apply.
 * It is not a duplicate: a catalog could derive the right DATA and still match
 * the NEXT entry through `updateFrom*`. The predicate is also run on a synthetic
 * catalog that DOES carry the forbidden entry, so the check is not vacuous.
 */

import { describe, expect, test } from 'bun:test';
import { RELEASE_IDENTITY } from '../../src/core/update/build_stamp.ts';
import {
	type DataUpdateDescriptor,
	getMatchedDescriptor,
	UPDATE_CATALOG,
	type UpdateDescriptor,
} from '../../src/core/update/catalog.ts';
import { DEDALO_DATA_VERSION, DEDALO_NEXT_RELEASE } from '../../src/core/update/version.ts';

/** The NEXT-triple data entry the engine would apply to `current` on an untagged build, or null. */
function nightlyDataMatchOf(
	current: readonly number[],
	catalog: Readonly<Record<string, UpdateDescriptor>>,
	next: readonly number[],
): DataUpdateDescriptor | null {
	const matched = getMatchedDescriptor(current, catalog);
	if (matched === null) return null;
	const triple = [matched.versionMajor, matched.versionMedium, matched.versionMinor];
	return triple.join('.') === next.join('.') ? matched : null;
}

const NEXT_DATA_ENTRY: UpdateDescriptor = {
	versionMajor: 7,
	versionMedium: 0,
	versionMinor: 1,
	updateFromMajor: 7,
	updateFromMedium: 0,
	updateFromMinor: 0,
	updateData: true,
	sqlUpdate: ['SELECT 1;'],
};

describe('the predicate is not vacuous (a synthetic catalog that carries the forbidden entry)', () => {
	test('a NEXT data entry reached from DATA is detected', () => {
		const catalog = { '7.0.1': NEXT_DATA_ENTRY } as Record<string, UpdateDescriptor>;
		expect(nightlyDataMatchOf([7, 0, 0], catalog, [7, 0, 1])).not.toBeNull();
	});

	test('a NEXT code-only entry is not a data match', () => {
		const catalog = {
			'7.0.1': { ...NEXT_DATA_ENTRY, updateData: false, sqlUpdate: undefined },
		} as unknown as Record<string, UpdateDescriptor>;
		expect(nightlyDataMatchOf([7, 0, 0], catalog, [7, 0, 1])).toBeNull();
	});

	test('a data entry below NEXT is not a nightly match', () => {
		const catalog = { '7.0.0': { ...NEXT_DATA_ENTRY, versionMinor: 0 } } as Record<
			string,
			UpdateDescriptor
		>;
		expect(nightlyDataMatchOf([6, 9, 0], catalog, [7, 0, 1])).toBeNull();
	});
});

describe('the real catalog on an untagged build', () => {
	const untagged = RELEASE_IDENTITY.kind === 'dev';

	test.skipIf(!untagged)(
		'getMatchedDescriptor(DATA) never returns the NEXT data entry (D2)',
		() => {
			expect(
				nightlyDataMatchOf([...DEDALO_DATA_VERSION], UPDATE_CATALOG, DEDALO_NEXT_RELEASE),
			).toBeNull();
		},
	);

	test.skipIf(!untagged)('the DATA update target of an untagged build is not NEXT', () => {
		// `null` (no update target) is never the NEXT triple, so one assertion covers both.
		const matched = getMatchedDescriptor([...DEDALO_DATA_VERSION], UPDATE_CATALOG);
		const target =
			matched === null ? null : [matched.versionMajor, matched.versionMedium, matched.versionMinor];
		expect(target).not.toEqual([...DEDALO_NEXT_RELEASE]);
	});
});
