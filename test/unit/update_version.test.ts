/**
 * core/update/version.ts — the ONE engine-version source (UPDATE_PROCESS
 * Phase 0). Byte-pins every exported shape (these are WIRE values: the client
 * displays the strings, update_data_version/environment emit the triple) and
 * the matrix_updates semantic-ordering compare contract.
 */

import { describe, expect, test } from 'bun:test';
import { DEDALO_ENGINE_VERSION, RELEASE_IDENTITY } from '../../src/core/update/build_stamp.ts';
import {
	compareVersionArrays,
	DEDALO_NEXT_DEV_TRIPLE,
	DEDALO_VERSION,
	DEDALO_VERSION_MAJOR_MINOR,
	DEDALO_VERSION_TRIPLE,
	parseVersionString,
} from '../../src/core/update/version.ts';

describe('version exports (byte-pinned wire values)', () => {
	test('the ONE deliberate pin of the engine version triple', () => {
		// The single literal in the suite: bumping the engine version means
		// consciously editing THIS line (everything else derives from the triple).
		expect(JSON.stringify(DEDALO_VERSION_TRIPLE)).toBe('[7,0,0]');
	});

	test('the derived shapes follow the triple (relational — a bump touches one line)', () => {
		expect(DEDALO_VERSION).toBe(DEDALO_VERSION_TRIPLE.join('.'));
		// the code identity: a dev build names the NEXT triple (version.ts), a tag
		// names its own release, which is never below the data triple it runs on
		expect(DEDALO_ENGINE_VERSION).toBe(RELEASE_IDENTITY.version);
		if (RELEASE_IDENTITY.kind === 'dev') {
			expect(RELEASE_IDENTITY.triple).toEqual(DEDALO_NEXT_DEV_TRIPLE);
		} else {
			expect(
				compareVersionArrays(RELEASE_IDENTITY.triple, DEDALO_VERSION_TRIPLE),
			).toBeGreaterThanOrEqual(0);
		}
		expect(DEDALO_VERSION_MAJOR_MINOR).toBe(
			`${DEDALO_VERSION_TRIPLE[0]}.${DEDALO_VERSION_TRIPLE[1]}`,
		);
	});

	test('the triple is frozen (shared by reference into wire payloads)', () => {
		expect(Object.isFrozen(DEDALO_VERSION_TRIPLE)).toBe(true);
	});
});

describe('compareVersionArrays (matrix_updates int[] semantic ordering)', () => {
	test('orders semantically, not lexically', () => {
		expect(compareVersionArrays([7, 0, 0], [7, 0, 0])).toBe(0);
		expect(compareVersionArrays([7, 0, 1], [7, 0, 0])).toBe(1);
		expect(compareVersionArrays([6, 9, 9], [7, 0, 0])).toBe(-1);
		// The lexical trap: 6.10.0 > 6.9.0 semantically.
		expect(compareVersionArrays([6, 10, 0], [6, 9, 0])).toBe(1);
	});

	test('missing segments count as 0 (PHP version_compare padding)', () => {
		expect(compareVersionArrays([7, 0], [7, 0, 0])).toBe(0);
		expect(compareVersionArrays([7], [7, 0, 1])).toBe(-1);
		expect(compareVersionArrays([7, 0, 1], [7])).toBe(1);
	});
});

describe('parseVersionString', () => {
	test('strips the prerelease tag and splits on dots', () => {
		expect(parseVersionString('7.0.0.dev')).toEqual([7, 0, 0]);
		expect(parseVersionString('7.0.0')).toEqual([7, 0, 0]);
		expect(parseVersionString('6.8.10')).toEqual([6, 8, 10]);
	});

	test('a prerelease identity is its data triple (alpha|beta|rc — the one release grammar)', () => {
		expect(parseVersionString('7.0.0-beta.6')).toEqual([7, 0, 0]);
		expect(parseVersionString('7.0.1-alpha.1')).toEqual([7, 0, 1]);
		expect(parseVersionString('7.0.0-rc.12')).toEqual([7, 0, 0]);
		// a foreign suffix is no identity: its NaN part is the caller's refusal
		expect(parseVersionString('7.0.0-pre.1').some((n) => !Number.isInteger(n))).toBe(true);
		// the historical split is kept for everything else
		expect(parseVersionString('7.0.0.1')).toEqual([7, 0, 0, 1]);
	});

	test('round-trips the DATA version; a dev engine identity is never read as a data triple', () => {
		expect(parseVersionString(DEDALO_VERSION)).toEqual([...DEDALO_VERSION_TRIPLE]);
		if (RELEASE_IDENTITY.kind === 'dev') {
			expect(parseVersionString(DEDALO_ENGINE_VERSION).some((n) => !Number.isInteger(n))).toBe(
				true,
			);
		} else {
			expect(parseVersionString(DEDALO_ENGINE_VERSION)).toEqual([...RELEASE_IDENTITY.triple]);
		}
	});
});
