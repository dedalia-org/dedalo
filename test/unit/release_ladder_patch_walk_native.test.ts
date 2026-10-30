/**
 * THE CODE LADDER WALKS FROM THE RELEASE IDENTITY (audit U-06, 2026-10-29).
 *
 * The defect: the manifest walked the catalog from the asker's DATA triple. A
 * code-only patch never moves DEDALO_DATA_VERSION, so a `7.0.1` install still
 * asks with data `7.0.0`; the walk reached only `7.0.1`, the asker floor
 * dropped it (its own identity), and `7.0.2` — which the swap door accepts from
 * `7.0.1` — was NEVER offered. The manifest and the door disagreed.
 *
 * This gate builds the REAL situation (data 7.0.0, release 7.0.1, catalog
 * {7.0.1, 7.0.2} — both code-only, archives on disk) and asserts the offer,
 * then that the manifest's rungs and the door's verdicts are one answer:
 * both ask version_walk.ts nextRungKind.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UpdateDescriptor } from '../../src/core/update/catalog.ts';
import {
	buildCodeUpdateInfo,
	type CodeUpdateInfoOptions,
	codeLadderTargets,
	linearUpgradeTargets,
} from '../../src/core/update/code_manifest.ts';
import {
	assertLinearUpgrade,
	identityWalkRefusal,
	nextRungKind,
} from '../../src/core/update/version_walk.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

/** A code-only descriptor of `major.minor.patch` (the manifest walks the target triple). */
function codeOnly(major: number, minor: number, patch: number): UpdateDescriptor {
	return {
		versionMajor: major,
		versionMedium: minor,
		versionMinor: patch,
		updateFromMajor: major,
		updateFromMedium: minor,
		updateFromMinor: Math.max(0, patch - 1),
		updateData: false,
	};
}

function catalogOf(...triples: [number, number, number][]): Record<string, UpdateDescriptor> {
	return Object.fromEntries(triples.map((t) => [t.join('.'), codeOnly(...t)]));
}

const ROOT = scratchDir('release_ladder');
const FILES = join(ROOT, 'files');
const ARCHIVES = ['7.0.1.zip', '7.0.2.zip', '7.0.3.zip', '7.0.1-beta.2.zip'];

beforeAll(() => {
	mkdirSync(join(FILES, '7', '7.0'), { recursive: true });
	for (const name of ARCHIVES) writeFileSync(join(FILES, '7', '7.0', name), `PK-${name}`);
});
afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

/** The identity each offered row installs. */
function offered(options: Partial<CodeUpdateInfoOptions>): string[] {
	return buildCodeUpdateInfo({
		clientVersion: [7, 0, 0],
		serverVersion: [7, 0, 2],
		codeFilesDir: FILES,
		publicBaseUrl: 'http://m',
		info: { date: 'now', entity_id: 1, entity: 'e', host: 'h' },
		catalog: catalogOf([7, 0, 1], [7, 0, 2]),
		...options,
	}).files.map((item) => item.release ?? item.version);
}

describe('U-06: the code ladder walks from the release identity, not the data version', () => {
	test('THE REAL SITUATION: data 7.0.0, release 7.0.1, catalog {7.0.1, 7.0.2} offers 7.0.2', () => {
		expect(offered({ clientVersion: [7, 0, 0], clientRelease: '7.0.1' })).toEqual(['7.0.2']);
		// and the swap door accepts exactly that move from the running identity
		expect(identityWalkRefusal('7.0.1', '7.0.2', 'master')).toBeNull();
	});

	test('anti-vacuity: release 7.0.0 is offered 7.0.1 only — never the 7.0.2 skip', () => {
		const fromStart = offered({ clientVersion: [7, 0, 0], clientRelease: '7.0.0' });
		// the floor every empty-ladder assertion below stands on: the walk does offer
		expect(fromStart).toHaveLength(1);
		expect(fromStart).toEqual(['7.0.1']);
		expect(identityWalkRefusal('7.0.0', '7.0.2', 'master')?.refusal).toBe('version_skip');
	});

	test('the ladder keeps climbing over an unchanged data version (7.0.2 on data 7.0.0 → 7.0.3)', () => {
		const catalog = catalogOf([7, 0, 1], [7, 0, 2], [7, 0, 3]);
		expect(offered({ catalog, clientRelease: '7.0.2' })).toEqual(['7.0.3']);
		expect(offered({ catalog, clientRelease: '7.0.3' })).toEqual([]);
	});

	test('an OLDER consumer (no release) is walked from its data triple: next rung only, never a downgrade', () => {
		// before the release identity existed, an install's code WAS its data triple
		expect(offered({ clientVersion: [7, 0, 0] })).toEqual(['7.0.1']);
		expect(offered({ clientVersion: [7, 0, 1] })).toEqual(['7.0.2']);
		expect(offered({ clientVersion: [7, 0, 2] })).toEqual([]);
	});

	test('a claim BELOW the data triple, or garbage, falls back to the data triple', () => {
		for (const clientRelease of ['6.9.9', '7.0.0-beta.1; rm', 42, null]) {
			expect(offered({ clientVersion: [7, 0, 1], clientRelease })).toEqual(['7.0.2']);
		}
	});

	test('a prerelease of a code-only patch (7.0.1-beta.2 on data 7.0.0) sees its stable and the rung above', () => {
		expect(
			offered({
				clientRelease: '7.0.1-beta.2',
				channel: 'prerelease',
				prereleaseChannelEnabled: true,
			}),
		).toEqual(['7.0.1', '7.0.2']);
		expect(identityWalkRefusal('7.0.1-beta.2', '7.0.2', 'prerelease')).toBeNull();
	});

	test('codeLadderTargets reads the identity triple; garbage walks nowhere', () => {
		const catalog = catalogOf([7, 0, 1], [7, 0, 2], [7, 1, 0]);
		expect(codeLadderTargets('7.0.1', catalog)).toEqual([
			[7, 0, 2],
			[7, 1, 0],
		]);
		expect(codeLadderTargets('7.0.1-dev', catalog)).toEqual(codeLadderTargets('7.0.1', catalog));
		expect(codeLadderTargets('not-a-version', catalog)).toEqual([]);
	});
});

describe('one next-rung rule: the manifest offers exactly what the door accepts', () => {
	// every triple within one step of each origin (and a few beyond)
	const CANDIDATES: [number, number, number][] = [];
	for (const major of [6, 7, 8, 9]) {
		for (const minor of [0, 1, 2]) {
			for (const patch of [0, 1, 2, 3]) CANDIDATES.push([major, minor, patch]);
		}
	}
	const ORIGINS: [number, number, number][] = [
		[7, 0, 0],
		[7, 0, 1],
		[7, 1, 2],
		[8, 2, 3],
	];

	test('nextRungKind ⇔ assertLinearUpgrade admits (the door), over the whole grid', () => {
		let admittedCount = 0;
		for (const origin of ORIGINS) {
			for (const candidate of CANDIDATES) {
				const door = assertLinearUpgrade(origin, candidate) === null;
				if (door) admittedCount++;
				expect(nextRungKind(origin, candidate) !== null).toBe(door);
			}
		}
		// floor: the grid really exercises admitted moves (patch, minor and major)
		expect(admittedCount).toBeGreaterThanOrEqual(8);
	});

	test('every manifest rung is admitted by the door; only a MASKED major boundary is withheld', () => {
		const catalog = catalogOf(...CANDIDATES);
		let offeredCount = 0;
		for (const origin of ORIGINS) {
			const targets = linearUpgradeTargets(origin, catalog);
			offeredCount += targets.length;
			for (const target of targets) expect(assertLinearUpgrade(origin, target)).toBeNull();
			const offeredKeys = new Set(targets.map((t) => t.join('.')));
			const withheld = CANDIDATES.filter(
				(c) => assertLinearUpgrade(origin, c) === null && !offeredKeys.has(c.join('.')),
			);
			// the next minor exists in this catalog, so the major boundary waits
			for (const c of withheld) expect(nextRungKind(origin, c)).toBe('major');
		}
		expect(offeredCount).toBeGreaterThanOrEqual(ORIGINS.length);
	});
});
