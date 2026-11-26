/**
 * `seed:build --from <master>` — pullOntologyRelease mirrors a master's verified release
 * into the seed's release dir, and writes NOTHING when any file fails or lacks a digest.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	pullOntologyRelease,
	RELEASE_EXCLUDED_TLDS,
	type ReleasePullDeps,
} from '../../src/core/install/ontology_release_pull.ts';
import type { ManifestResult } from '../../src/core/ontology/ontology_manifest.ts';
import { DEDALO_DATA_VERSION, formatVersion } from '../../src/core/update/version.ts';

const BASE = 'https://master.example/dedalo/install/import/ontology/7.0';
const SERVER = { name: 'm', url: 'https://master.example/dedalo/core/api/v1/json/', code: 'x' };
const roots: string[] = [];

/** The refusal's public sentence (DedaloError.message is the code's generic text). */
async function refusal(run: Promise<unknown>): Promise<string> {
	try {
		await run;
	} catch (error) {
		return String((error as { publicMessage?: string }).publicMessage);
	}
	throw new Error('expected a refusal');
}

function releaseDir(): string {
	const root = mkdtempSync(join(tmpdir(), 'release_pull_'));
	roots.push(root);
	const dir = join(root, '7.0');
	mkdirSync(dir);
	for (const name of ['dd.copy.gz', 'gone.copy.gz', 'ontology.json', 'ontology_llm_map.json'])
		writeFileSync(join(dir, name), 'old');
	return dir;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deps(
	dir: string,
	over: Partial<{ sha: string | undefined; failOn: string }> = {},
): ReleasePullDeps {
	const sha = 'sha' in over ? over.sha : 'abc';
	const manifest: ManifestResult = {
		ok: true,
		version: formatVersion(DEDALO_DATA_VERSION),
		ontologies: ['dd', 'zzpull'].map((tld) => ({
			tld,
			name: tld,
			name_data: null,
			typology_id: null,
			typology_name: null,
			dependencies: null,
			url: `${BASE}/${tld}.copy.gz`,
			...(sha === undefined ? {} : { sha256: sha }),
		})),
		matrixDdUrl: `${BASE}/matrix_dd.copy.gz`,
		matrixDdSha256: 'abc',
		warnings: [],
	};
	const info = {
		version: manifest.version,
		files_sha256: { 'dd.copy.gz': 'abc', 'zzpull.copy.gz': 'abc', 'matrix_dd.copy.gz': 'abc' },
	};
	return {
		servers: [SERVER],
		releaseDir: dir,
		fetchManifest: async () => manifest,
		download: async (options) => {
			expect(options.configuredOrigin).toBe('https://master.example');
			if (options.expectedBasename === over.failOn)
				return { ok: false, msg: 'Error. sha256 mismatch', errors: ['x'] };
			const body = options.expectedBasename === 'ontology.json' ? JSON.stringify(info) : 'new';
			writeFileSync(join(options.targetDir, options.expectedBasename), body);
			return { ok: true, msg: 'OK', errors: [] };
		},
	};
}

describe('pullOntologyRelease', () => {
	test('mirrors the master: packages + ontology.json replaced, unlisted packages removed, other files kept', async () => {
		const dir = releaseDir();
		const result = await pullOntologyRelease('m', deps(dir));
		expect(result.removed).toEqual(['gone.copy.gz']);
		expect(readdirSync(dir).sort()).toEqual([
			'dd.copy.gz',
			'matrix_dd.copy.gz',
			'ontology.json',
			'ontology_llm_map.json',
			'zzpull.copy.gz',
		]);
		expect(await Bun.file(join(dir, 'ontology_llm_map.json')).text()).toBe('old');
		expect(await Bun.file(join(dir, 'zzpull.copy.gz')).text()).toBe('new');
		expect(readdirSync(join(dir, '..'))).toEqual(['7.0']); // staging swept
	});

	test("the suite's test fixtures a master exports are never vendored", async () => {
		const dir = releaseDir();
		const base = deps(dir);
		const manifest = (await base.fetchManifest?.(
			{ name: 'm', url: SERVER.url, code: 'x' },
			[],
		)) as Extract<ManifestResult, { ok: true }>;
		const withFixture: ManifestResult = {
			...manifest,
			ontologies: [
				...manifest.ontologies,
				{ ...manifest.ontologies[0]!, tld: 'test', url: `${BASE}/test.copy.gz` },
			],
		};
		const result = await pullOntologyRelease('m', {
			...base,
			fetchManifest: async () => withFixture,
		});
		expect(result.written).not.toContain('test.copy.gz');
		expect(readdirSync(dir)).not.toContain('test.copy.gz');
		expect(result.warnings.join(' ')).toContain('test');
	});

	test('an excluded package (RELEASE_EXCLUDED_TLDS) is not vendored: no file, no digest, entry kept', async () => {
		const excludedTld = Object.keys(RELEASE_EXCLUDED_TLDS)[0]!;
		const dir = releaseDir();
		writeFileSync(join(dir, `${excludedTld}.copy.gz`), 'stale local copy');
		const base = deps(dir);
		const manifest = (await base.fetchManifest?.(
			{ name: 'm', url: SERVER.url, code: 'x' },
			[],
		)) as Extract<ManifestResult, { ok: true }>;
		const info = {
			version: manifest.version,
			files_sha256: {
				'dd.copy.gz': 'abc',
				'zzpull.copy.gz': 'abc',
				'matrix_dd.copy.gz': 'abc',
				[`${excludedTld}.copy.gz`]: 'abc',
			},
			active_ontologies: [{ tld: 'dd' }, { tld: excludedTld }],
		};
		const downloaded: string[] = [];
		const result = await pullOntologyRelease('m', {
			...base,
			fetchManifest: async () => ({
				...manifest,
				ontologies: [
					...manifest.ontologies,
					{ ...manifest.ontologies[0]!, tld: excludedTld, url: `${BASE}/${excludedTld}.copy.gz` },
				],
			}),
			download: async (options) => {
				downloaded.push(options.expectedBasename);
				const body = options.expectedBasename === 'ontology.json' ? JSON.stringify(info) : 'new';
				writeFileSync(join(options.targetDir, options.expectedBasename), body);
				return { ok: true, msg: 'OK', errors: [] };
			},
		});
		expect(downloaded).not.toContain(`${excludedTld}.copy.gz`);
		expect(readdirSync(dir)).not.toContain(`${excludedTld}.copy.gz`); // the stale copy removed
		expect(result.removed).toContain(`${excludedTld}.copy.gz`);
		const vendored = JSON.parse(await Bun.file(join(dir, 'ontology.json')).text());
		expect(Object.keys(vendored.files_sha256)).not.toContain(`${excludedTld}.copy.gz`);
		expect(vendored.active_ontologies.map((e: { tld: string }) => e.tld)).toContain(excludedTld);
		expect(result.warnings.join(' ')).toContain(`'${excludedTld}': not vendored`);
	});

	test('a failed download writes nothing', async () => {
		const dir = releaseDir();
		expect(
			await refusal(pullOntologyRelease('m', deps(dir, { failOn: 'zzpull.copy.gz' }))),
		).toContain('zzpull.copy.gz: Error. sha256 mismatch');
		expect(existsSync(join(dir, 'gone.copy.gz'))).toBe(true);
		expect(await Bun.file(join(dir, 'dd.copy.gz')).text()).toBe('old');
		expect(readdirSync(join(dir, '..'))).toEqual(['7.0']);
	});

	test('a package without a published sha256 refuses before any download', async () => {
		const dir = releaseDir();
		expect(await refusal(pullOntologyRelease('m', deps(dir, { sha: undefined })))).toContain(
			'publishes no sha256',
		);
		expect(await Bun.file(join(dir, 'dd.copy.gz')).text()).toBe('old');
	});

	test('ontology.json disagreeing with the manifest refuses', async () => {
		const dir = releaseDir();
		expect(
			await refusal(pullOntologyRelease('m', deps(dir, { sha: 'not-the-manifest-sha' }))),
		).toContain('ontology.json disagrees');
		expect(await Bun.file(join(dir, 'dd.copy.gz')).text()).toBe('old');
	});

	test('an unknown server name refuses', async () => {
		expect(await refusal(pullOntologyRelease('nope', deps(releaseDir())))).toContain(
			'ONTOLOGY_SERVERS',
		);
	});
});
