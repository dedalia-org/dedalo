/**
 * TS-native gate for U-52 — the ontology update's TLD SCOPE is decided by the
 * SERVER (src/core/ontology/ontology_update.ts `assertUpdateTldScope`, called by
 * `updateOntology` before the latch, the io dir and any staging).
 *
 * Owner rule (2026-10-29): an update replaces ONLY the shared TLDs listed in
 * ACTIVE_ONTOLOGY_TLDS, the core pair the panel always offers (`ontology`,
 * `ontologytype`) and `matrix_dd` (the shared value lists). Never a local TLD,
 * never `localontology` — even when configured. The client's own filter is a
 * convenience; a crafted request naming any other TLD must be refused WHOLE.
 *
 * How it is made safe: the refusal cases are refused before anything touches
 * the filesystem or the database (asserted: the injected `ioBaseDir` stays
 * empty, the latch stays free). The admissible case is driven only as far as
 * Phase A staging against a local `Bun.serve` fixture answering 404 — the
 * staging refusal stops it before Phase B, so nothing is imported. Every
 * environment-shaped input (`catalog`, `activeTlds`) is INJECTED, so the gate
 * takes the same branch on every machine. TLDs are `zz*` scratch names.
 *
 * Mutations: delete the `assertUpdateTldScope` call → case 1/2 red (no throw);
 * drop `matrix_dd` or the core pair from the admissible set → case 3 red;
 * drop the localontology exclusion → case 4 red; move the check after
 * `setOntologyIoPath` → case 1 red (io dir created).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DedaloError } from '../../src/core/errors/index.ts';
import {
	admissibleUpdateTlds,
	assertUpdateTldScope,
	claimOntologyImportLatch,
	releaseOntologyImportLatch,
	updateOntology,
} from '../../src/core/ontology/ontology_update.ts';
import { manifestSourceDeps } from '../helpers/ontology_manifest_fixture.ts';

const ACTIVE = ['zzscopea', 'zzscopeb'];
const ORIGIN = 'http://127.0.0.1:9';

const tempRoots: string[] = [];

function ioBase(): string {
	const root = mkdtempSync(join(tmpdir(), 'zz_upd_scope_'));
	tempRoots.push(root);
	const base = join(root, 'io');
	mkdirSync(base);
	return base;
}

function optionsFor(origin: string, tlds: readonly string[]): unknown {
	return {
		server: { name: 'zz master', url: `${origin}/api/`, code: 'fixture_master' },
		files: tlds.map((tld) => ({ tld, url: `${origin}/${tld}.copy.gz` })),
	};
}

function catalogFor(origin: string) {
	return { servers: [{ code: 'fixture_master', url: `${origin}/api/` }], isOntologyServer: false };
}

/** Run `work`, return the DedaloError it threw (fails the test if none / another type). */
async function refusalOf(work: () => Promise<unknown>): Promise<DedaloError> {
	let caught: unknown = null;
	try {
		await work();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(DedaloError);
	return caught as DedaloError;
}

afterAll(() => {
	for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe('U-52 ontology update TLD scope (server-side)', () => {
	test('a request naming a TLD outside the active set is refused WHOLE before anything is staged', async () => {
		const ioBaseDir = ioBase();
		const refusal = await refusalOf(() =>
			updateOntology(optionsFor(ORIGIN, ['zzscopea', 'zzforeign', 'matrix_dd']), -1, {
				catalog: catalogFor(ORIGIN),
				activeTlds: ACTIVE,
				ioBaseDir,
				changesDir: join(ioBaseDir, '..', 'changes'),
			}),
		);
		expect(refusal.code).toBe('update.refused');
		// Names the offender — and only the offender.
		expect(refusal.message).toContain('zzforeign');
		expect(refusal.message).not.toContain('zzscopea');
		// Nothing staged: the versioned io dir (staging + recovery) was never created.
		expect(readdirSync(ioBaseDir)).toEqual([]);
		// The latch was never claimed (the refusal sits before it).
		expect(claimOntologyImportLatch()).toBe(true);
		releaseOntologyImportLatch();
	});

	test('every offending TLD is named, once, in request order', () => {
		let caught: unknown = null;
		try {
			assertUpdateTldScope(
				[{ tld: 'zzbad' }, { tld: 'zzscopea' }, { tld: 'zzworse' }, { tld: 'zzbad' }],
				ACTIVE,
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(DedaloError);
		const refusal = caught as DedaloError;
		expect(refusal.code).toBe('update.refused');
		expect(refusal.message).toMatch(/: zzbad, zzworse$/);
	});

	test('the active TLDs, the core pair and matrix_dd pass the check', () => {
		const admissible = admissibleUpdateTlds(ACTIVE);
		expect([...admissible].sort()).toEqual(
			['matrix_dd', 'ontology', 'ontologytype', 'zzscopea', 'zzscopeb'].sort(),
		);
		expect(() =>
			assertUpdateTldScope(
				[
					{ tld: 'matrix_dd' },
					{ tld: 'zzscopea' },
					{ tld: 'zzscopeb' },
					{ tld: 'ontology' },
					{ tld: 'ontologytype' },
				],
				ACTIVE,
			),
		).not.toThrow();
	});

	test('the suite fixture TLD `test` is never admissible, even when configured as active', () => {
		expect(admissibleUpdateTlds([...ACTIVE, 'test']).has('test')).toBe(false);
		expect(() => assertUpdateTldScope([{ tld: 'test' }], [...ACTIVE, 'test'])).toThrow(DedaloError);
	});

	test('an operator pick may replace ANY shared TLD — never localontology, never the fixture', () => {
		expect(() =>
			assertUpdateTldScope([{ tld: 'zzbad' }, { tld: 'matrix_dd' }], ACTIVE, true),
		).not.toThrow();
		expect(() => assertUpdateTldScope([{ tld: 'localontology' }], ACTIVE, true)).toThrow(
			DedaloError,
		);
		expect(() => assertUpdateTldScope([{ tld: 'test' }], ACTIVE, true)).toThrow(DedaloError);
	});

	test('localontology is never admissible, even when configured as active', () => {
		expect(admissibleUpdateTlds([...ACTIVE, 'localontology']).has('localontology')).toBe(false);
		expect(() =>
			assertUpdateTldScope([{ tld: 'localontology' }], [...ACTIVE, 'localontology']),
		).toThrow(DedaloError);
	});

	test('an admissible request (active TLD + matrix_dd) passes the scope check and reaches staging', async () => {
		// 404 for every file: Phase A refuses the download, nothing reaches Phase B.
		const server = Bun.serve({ port: 0, fetch: () => new Response('nope', { status: 404 }) });
		const origin = `http://localhost:${server.port}`;
		const ioBaseDir = ioBase();
		try {
			const options = optionsFor(origin, ['zzscopea', 'matrix_dd']) as {
				files: { tld: string; url: string }[];
			};
			const out = await updateOntology(options, -1, {
				catalog: catalogFor(origin),
				// The master lists exactly what is requested (U-08/U-41 source check).
				...manifestSourceDeps(options.files),
				activeTlds: ACTIVE,
				ioBaseDir,
				changesDir: join(ioBaseDir, '..', 'changes'),
			});
			// Past the scope check: the io dir was created and staging ran (and
			// refused on the 404), returning a soft response — not a throw.
			expect(out.ok).toBe(false);
			expect(out.errors.join(' ')).not.toContain('outside the active ontology set');
			expect(readdirSync(ioBaseDir).length).toBe(1);
		} finally {
			server.stop(true);
		}
		expect(claimOntologyImportLatch()).toBe(true);
		releaseOntologyImportLatch();
	});
});
