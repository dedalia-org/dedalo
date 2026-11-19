/**
 * A DATABASE THIS ENGINE CANNOT UPDATE IS SAID SO — never "run Update data" (T2 D08-b).
 *
 * `classifyDataVersion` knew three states: ok / pending / ahead. A Dédalo v6
 * database (data version 6.x) under the v7 engine read as `pending`: the boot
 * line told the operator to run "Update data" in the maintenance area, /health
 * stayed green, and the panel said "Data format is updated: 6.9.1" — while no
 * rung of this engine's catalog can ever move that database. The v6 → v7
 * migration runs ON v6 (docs/install/migrating_from_v6.md).
 *
 * THE STATE IS CATALOG-DERIVED: `unreachable` = the installed MAJOR is below the
 * major of the lowest from-version any rung of the catalog starts at
 * (`lowestReachableFrom`). Nothing here names "6": a catalog that one day
 * carries a rung from 6.9.x makes that database `pending` again, by itself.
 *
 * Pinned: the classification (the shipped catalog and injected ones), the boot
 * line, /health through the real route (red), the code-update door's reason,
 * and the Update-data panel's value.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { BootSchemaVerdict } from '../../install/db/migrate.ts';
import { updateDataVersionPanel } from '../../src/core/area_maintenance/widgets/update_data_version.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import {
	classifyDataVersion,
	dataVersionAdvice,
	recordBootSchemaVerdict,
	refreshDataVersionState,
	resetBootStateForTest,
} from '../../src/core/update/boot_state.ts';
import {
	lowestReachableFrom,
	UPDATE_CATALOG,
	type UpdateDescriptor,
} from '../../src/core/update/catalog.ts';
import { requireDataVersionCurrent } from '../../src/core/update/preconditions.ts';
import { DATA_LINE_START, DEDALO_DATA_VERSION } from '../../src/core/update/version.ts';
import { createRequestContext, handleRequest } from '../../src/server.ts';

const OK_VERDICT: BootSchemaVerdict = {
	state: 'ok',
	applied: [],
	deferred: [],
	schemaMoved: false,
	error: null,
};

/** A catalog of ONE rung `from → to` (only the fields the derivation reads). */
function catalogOf(...rungs: [number[], number[]][]): Record<string, UpdateDescriptor> {
	return Object.fromEntries(
		rungs.map(([from, to]) => [
			to.join('.'),
			{
				versionMajor: to[0],
				versionMedium: to[1],
				versionMinor: to[2],
				updateFromMajor: from[0],
				updateFromMedium: from[1],
				updateFromMinor: from[2],
				updateData: false,
			} as unknown as UpdateDescriptor,
		]),
	);
}

afterEach(() => {
	resetBootStateForTest();
});

describe('the lowest reachable from-version is read off the catalog', () => {
	test('the shipped catalog starts at this engine’s own major (FLOOR: it has rungs)', () => {
		expect(Object.keys(UPDATE_CATALOG).length).toBeGreaterThan(0);
		const lowest = lowestReachableFrom();
		expect(lowest).toHaveLength(3);
		expect(lowest[0]).toBe(DEDALO_DATA_VERSION[0]);
	});

	test('the minimum of every rung’s from-version; an EMPTY catalog starts at the line start', () => {
		expect(
			lowestReachableFrom(
				catalogOf(
					[
						[7, 0, 0],
						[7, 0, 1],
					],
					[
						[7, 0, 1],
						[7, 1, 0],
					],
				),
			),
		).toEqual([7, 0, 0]);
		expect(
			lowestReachableFrom(
				catalogOf(
					[
						[7, 0, 1],
						[7, 1, 0],
					],
					[
						[6, 9, 8],
						[7, 0, 0],
					],
				),
			),
		).toEqual([6, 9, 8]);
		expect(lowestReachableFrom({})).toEqual([...DATA_LINE_START]);
	});
});

describe('classification', () => {
	test('a v6 triple under this engine is UNREACHABLE — every 6.x, and anything older', () => {
		for (const installed of [
			[6, 9, 1],
			[6, 9, 8],
			[6, 0, 0],
			[6, 99, 99],
			[5, 8, 2],
			[0, 0, 1],
		]) {
			expect(classifyDataVersion(installed, [7, 0, 0])).toEqual({
				state: 'unreachable',
				installed: installed.join('.'),
				code: '7.0.0',
			});
		}
	});

	test('CONTROLS: the three old states are what they were', () => {
		expect(classifyDataVersion([7, 0, 0], [7, 0, 0]).state).toBe('ok');
		expect(classifyDataVersion([7, 0, 0], [7, 0, 1]).state).toBe('pending');
		expect(classifyDataVersion([7, 1, 0], [7, 0, 0]).state).toBe('ahead');
		expect(classifyDataVersion([], [7, 0, 0]).state).toBe('unknown');
		expect(classifyDataVersion(null, [7, 0, 0]).state).toBe('unknown');
	});

	test('CATALOG-DERIVED, not a literal: a catalog with a rung from 6.9.8 makes 6.x pending, 5.x still unreachable', () => {
		const lowest = lowestReachableFrom(
			catalogOf([
				[6, 9, 8],
				[7, 0, 0],
			]),
		);
		expect(classifyDataVersion([6, 9, 8], [7, 0, 0], lowest).state).toBe('pending');
		// Same major as the lowest from-version: this rule does not speak (the
		// rung walk decides) — it is about the MAJOR.
		expect(classifyDataVersion([6, 9, 1], [7, 0, 0], lowest).state).toBe('pending');
		expect(classifyDataVersion([5, 8, 2], [7, 0, 0], lowest).state).toBe('unreachable');
	});
});

describe('what the operator is told', () => {
	async function bootLines(installed: number[]): Promise<string[]> {
		const lines: string[] = [];
		const [warn, error] = [console.warn, console.error];
		console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
		console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
		try {
			await refreshDataVersionState(async () => installed);
		} finally {
			console.warn = warn;
			console.error = error;
		}
		return lines;
	}

	test('BOOT: a 6.x database gets one line naming the v6 migration — never "run Update data"', async () => {
		const lines = await bootLines([6, 9, 1]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('6.9.1');
		expect(lines[0]).toMatch(/v6/);
		expect(lines[0]).toContain('migrating_from_v6');
		expect(lines[0]).not.toContain('Update data');
	});

	test('CONTROL: a pending database is still told to run "Update data"', async () => {
		const lines: string[] = [];
		const warn = console.warn;
		console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
		try {
			await refreshDataVersionState(async () => [7, 0, 0], [7, 0, 1]);
		} finally {
			console.warn = warn;
		}
		expect(lines.join('\n')).toContain('Update data');
	});

	test('/health through the real route: 503, data_version.state unreachable', async () => {
		recordBootSchemaVerdict(OK_VERDICT);
		await bootLines([6, 9, 1]);
		const response = await handleRequest(
			new Request('http://localhost/health'),
			createRequestContext(),
		);
		const body = (await response.json()) as Record<string, unknown>;
		expect(response.status).toBe(503);
		expect(body.result).toBe('error');
		expect(body.data_version).toEqual({ state: 'unreachable' });
	});

	test('the code-update door refuses with ITS reason (not "run Update data first")', async () => {
		let caught: unknown = null;
		try {
			await requireDataVersionCurrent(async () => [6, 9, 1], [7, 0, 0]);
		} catch (error) {
			caught = error;
		}
		expect(isDedaloError(caught)).toBe(true);
		const typed = caught as { code: string; coordinates?: { rule?: string }; message: string };
		expect(typed.code).toBe('update.refused');
		expect(typed.coordinates?.rule).toBe('data_version_unreachable');
		expect(typed.message).not.toContain('run "Update data"');
		expect(typed.message).toMatch(/v6/);
	});

	test('the Update-data panel VALUE carries the notice for a 6.x database, and no such key otherwise', async () => {
		const stuck = await updateDataVersionPanel([6, 9, 1]);
		// What made the panel say "Data format is updated": no rung matches.
		expect(stuck.update_version).toBeNull();
		expect(typeof stuck.notice).toBe('string');
		expect(stuck.notice as string).toContain('6.9.1');
		expect(stuck.notice as string).toMatch(/v6/);
		// The FACTS of that sentence ride with it, so the panel words it from its
		// label catalog in the reader's language (the sentence stays the fallback).
		expect(stuck.notice_data).toEqual({
			code: 'data_version_unreachable',
			installed: '6.9.1',
			engine: DEDALO_DATA_VERSION.join('.'),
			installed_major: '6',
			engine_major: String(DEDALO_DATA_VERSION[0]),
			doc: 'docs/install/migrating_from_v6.md',
		});
		// …and every fact is IN the sentence: the two are one statement.
		for (const fact of ['installed', 'engine', 'doc'] as const) {
			expect(stuck.notice as string).toContain(
				(stuck.notice_data as Record<string, string>)[fact] as string,
			);
		}
		// The label the panel fills names exactly those facts as placeholders.
		const master = (await import('../../src/core/labels/master.json')).default as Record<
			string,
			string
		>;
		const slots = [...(master.update_data_notice_unreachable ?? '').matchAll(/\$\{(\w+)\}/g)].map(
			(match) => match[1] as string,
		);
		expect(slots.length).toBeGreaterThan(0);
		for (const slot of slots) {
			expect(Object.keys(stuck.notice_data as object)).toContain(slot);
		}
		const current = await updateDataVersionPanel([...DEDALO_DATA_VERSION]);
		expect('notice' in current).toBe(false);
		expect('notice_data' in current).toBe(false);
		expect(Object.keys(current).sort()).toEqual([
			'current_version_in_db',
			'dedalo_version',
			'update_version',
			'updates',
		]);
	});

	test('the Update-data panel: ONE sentence for an unreachable database, none for the other states', () => {
		const advice = dataVersionAdvice(classifyDataVersion([6, 9, 1], [7, 0, 0]));
		expect(advice).toContain('6.9.1');
		expect(advice).toMatch(/v6/);
		expect(advice).not.toContain('Update data');
		for (const [installed, code] of [
			[
				[7, 0, 0],
				[7, 0, 0],
			],
			[
				[7, 0, 0],
				[7, 0, 1],
			],
		] as const) {
			expect(dataVersionAdvice(classifyDataVersion(installed, code))).toBeNull();
		}
	});
});
