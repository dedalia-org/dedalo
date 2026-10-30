/**
 * TS-native gate for U-08 / U-41 — the ontology update's SOURCE is held by the
 * SERVER (src/core/ontology/ontology_update_source.ts `resolveOntologySource`,
 * called by `updateOntology` after the TLD scope check and before the latch).
 *
 * Every branch is planted through the seams (`readManifest`,
 * `installedDataVersion`): no network, no database read, same branch on every
 * machine. TLDs are `zz*` scratch names; the origin is never contacted.
 *
 * Mutations: skip the `!manifest.ok` refusal → case 1 red; drop the
 * ontologyCompatibility verdict → cases 2/3 red; compare TLD only (not URL) →
 * case 4 red; skip the matrix_dd URL check → case 5 red; return the client's
 * files instead of the manifest's → case 6 red.
 */

import { describe, expect, test } from 'bun:test';
import { DedaloError } from '../../src/core/errors/index.ts';
import type { ManifestResult } from '../../src/core/ontology/ontology_manifest.ts';
import {
	type OntologySourceDeps,
	resolveOntologySource,
} from '../../src/core/ontology/ontology_update_source.ts';
import type {
	OntologyUpdateCatalog,
	OntologyUpdateFile,
	UpdateTarget,
} from '../../src/core/ontology/ontology_update_target.ts';
import { DEDALO_DATA_VERSION } from '../../src/core/update/version.ts';
import { manifestSourceDeps, plantedManifest } from '../helpers/ontology_manifest_fixture.ts';

const ORIGIN = 'http://127.0.0.1:9';
const TARGET: UpdateTarget = { isLocal: false, configuredOrigin: ORIGIN };
const CATALOG: OntologyUpdateCatalog = {
	servers: [{ code: 'fixture_master', url: `${ORIGIN}/api/` }],
	isOntologyServer: false,
};

const MANIFEST_FILES = [
	{
		tld: 'zzsrca',
		url: `${ORIGIN}/zzsrca.copy.gz`,
		typology_id: 3,
		name_data: { 'lg-eng': 'zz source a' },
		dependencies: [{ tld: 'dd', main: 'ontology35' as const, mandatory: true }],
	},
	{ tld: 'matrix_dd', url: `${ORIGIN}/matrix_dd.copy.gz` },
];

/** Run `work`, return the `coordinates.rule` of the `update.refused` it threw. */
async function refusedRule(work: () => Promise<unknown>): Promise<string> {
	let caught: unknown = null;
	try {
		await work();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(DedaloError);
	const refusal = caught as DedaloError;
	expect(refusal.code).toBe('update.refused');
	return String(refusal.coordinates?.rule);
}

function resolve(files: OntologyUpdateFile[], deps: OntologySourceDeps) {
	return resolveOntologySource(files, TARGET, CATALOG, deps);
}

const REQUEST: OntologyUpdateFile[] = [
	{ tld: 'zzsrca', url: `${ORIGIN}/zzsrca.copy.gz` },
	{ tld: 'matrix_dd', url: `${ORIGIN}/matrix_dd.copy.gz` },
];

describe('U-08/U-41 ontology update source (server-side manifest)', () => {
	test('an unreadable manifest is refused: manifest_unreadable', async () => {
		const unreadable: ManifestResult = { ok: false, reason: 'unreachable (HTTP 404)' };
		const rule = await refusedRule(() =>
			resolve(REQUEST, {
				readManifest: async () => unreadable,
				installedDataVersion: async () => [...DEDALO_DATA_VERSION],
			}),
		);
		expect(rule).toBe('manifest_unreadable');
	});

	test('a master exporting another data model is refused: ontology_model_unknown', async () => {
		const rule = await refusedRule(() =>
			resolve(REQUEST, {
				readManifest: async () => plantedManifest(MANIFEST_FILES, '99.0.0'),
				installedDataVersion: async () => [...DEDALO_DATA_VERSION],
			}),
		);
		expect(rule).toBe('ontology_model_unknown');
	});

	test('an unreadable installed version is refused WITHOUT the database’s own text on the wire', async () => {
		let caught: DedaloError | null = null;
		const quiet = console.error;
		console.error = () => {};
		try {
			await resolve(REQUEST, {
				readManifest: async () => plantedManifest(MANIFEST_FILES),
				installedDataVersion: async () => {
					throw new Error('relation "matrix_updates" does not exist at /tmp/.s.PGSQL.5432');
				},
			});
		} catch (error) {
			caught = error as DedaloError;
		} finally {
			console.error = quiet;
		}
		expect(caught?.coordinates?.rule).toBe('installed_version_unreadable');
		expect(caught?.message).not.toContain('matrix_updates');
		expect(caught?.message).not.toContain('PGSQL');
	});

	test('a database on another data model is refused: installed_model_mismatch', async () => {
		const rule = await refusedRule(() =>
			resolve(REQUEST, {
				readManifest: async () => plantedManifest(MANIFEST_FILES),
				// below the line start: version_contract reads it as an unknown model
				installedDataVersion: async () => [6, 9, 0],
			}),
		);
		expect(rule).toBe('installed_model_mismatch');
	});

	test('a file at a URL the manifest does not list is refused: file_not_in_manifest', async () => {
		const rule = await refusedRule(() =>
			resolve(
				[{ tld: 'zzsrca', url: `${ORIGIN}/elsewhere/zzsrca.copy.gz` }],
				manifestSourceDeps(MANIFEST_FILES),
			),
		);
		expect(rule).toBe('file_not_in_manifest');
	});

	test('a TLD the manifest does not list is refused: file_not_in_manifest', async () => {
		const rule = await refusedRule(() =>
			resolve(
				[{ tld: 'zzsrcb', url: `${ORIGIN}/zzsrcb.copy.gz` }],
				manifestSourceDeps(MANIFEST_FILES),
			),
		);
		expect(rule).toBe('file_not_in_manifest');
	});

	test('matrix_dd at a URL other than the manifest’s is refused: file_not_in_manifest', async () => {
		const rule = await refusedRule(() =>
			resolve(
				[{ tld: 'matrix_dd', url: `${ORIGIN}/other/matrix_dd.copy.gz` }],
				manifestSourceDeps(MANIFEST_FILES),
			),
		);
		expect(rule).toBe('file_not_in_manifest');
	});

	test('a LOCAL master: its file:// manifest accepts the panel’s http URLs, by TLD (staging reads by name)', async () => {
		const local: UpdateTarget = { isLocal: true, configuredOrigin: null };
		const exportDir = 'file:///srv/dedalo/ontology_io/7.0';
		const deps = manifestSourceDeps([
			{ ...(MANIFEST_FILES[0] as (typeof MANIFEST_FILES)[0]), url: `${exportDir}/zzsrca.copy.gz` },
			{ tld: 'matrix_dd', url: `${exportDir}/matrix_dd.copy.gz` },
		]);
		const files = await resolveOntologySource(REQUEST, local, CATALOG, deps);
		expect(files.map((file) => file.tld)).toEqual(['zzsrca', 'matrix_dd']);
		const unlisted = await refusedRule(() =>
			resolveOntologySource(
				[{ tld: 'zzsrcb', url: `${ORIGIN}/zzsrcb.copy.gz` }],
				local,
				CATALOG,
				deps,
			),
		);
		expect(unlisted).toBe('file_not_in_manifest');
	});

	test('a good request returns the MANIFEST’s entries, not the client’s', async () => {
		const files = await resolve(
			[
				{
					tld: 'zzsrca',
					url: `${ORIGIN}/zzsrca.copy.gz`,
					typology_id: 99,
					name_data: { 'lg-eng': 'client name' },
					// the browser claims a different dependency set — ignored
					dependencies: [{ tld: 'zzclient', main: 'hierarchy1', mandatory: false }],
				},
				{ tld: 'matrix_dd', url: `${ORIGIN}/matrix_dd.copy.gz` },
			],
			manifestSourceDeps(MANIFEST_FILES),
		);
		expect(files).toEqual([
			{
				tld: 'zzsrca',
				url: `${ORIGIN}/zzsrca.copy.gz`,
				typology_id: 3,
				name_data: { 'lg-eng': 'zz source a' },
				dependencies: [{ tld: 'dd', main: 'ontology35', mandatory: true }],
			},
			{ tld: 'matrix_dd', url: `${ORIGIN}/matrix_dd.copy.gz` },
		]);
	});

	test('an undeclared manifest dependency set drops the client’s claim entirely', async () => {
		const files = await resolve(
			[
				{
					tld: 'zzsrca',
					url: `${ORIGIN}/zzsrca.copy.gz`,
					dependencies: [{ tld: 'zzclient', main: 'ontology35', mandatory: true }],
				},
			],
			manifestSourceDeps([{ tld: 'zzsrca', url: `${ORIGIN}/zzsrca.copy.gz` }]),
		);
		expect(files).toEqual([
			{ tld: 'zzsrca', url: `${ORIGIN}/zzsrca.copy.gz`, typology_id: null, name_data: null },
		]);
		expect('dependencies' in (files[0] as object)).toBe(false);
	});
});
