/**
 * HERMETIC gate of the ontology manifest CLIENT (src/core/ontology/ontology_manifest.ts):
 * how the installer reads an ontology source's catalog — which TLDs, their
 * metadata, and their DECLARED dependencies
 * (WC-2026-10-10-ontology-dependencies-hierarchy60: `{tld, main, mandatory}`
 * objects, normalized by the shared ontology_dependencies.ts normalizer).
 *
 * The network arm runs against a LOOPBACK `Bun.serve` stand-in that answers
 * like a master's `dd_utils_api.get_ontology_update_info` — never the official
 * server, never the network. The local arm reads a mkdtemp directory the test
 * fills from the package fixture (src/core/test_data/ontology_package_fixture.ts).
 * Scratch `zz…` TLDs only. No database.
 *
 * Legs: envelope ok → parsed (dependencies normalized: tld trimmed +
 * lowercased, `(tld, main)` deduplicated first-wins, an ontology35
 * self-reference dropped, a hierarchy1 one kept, a TLD twice under two mains
 * kept, a bad item — string shape, bad main, non-boolean mandatory — warned); envelope ok:false → the
 * server's reason; HTTP 403 → the access-code/version reason; any other status
 * and an oversize body → `unreachable (…)` with no address in it; a body that
 * is not JSON / not an envelope; a URL that is not EXACTLY a configured master
 * → refused `internal.invariant` BEFORE any socket (the stand-in counts zero
 * requests); the request the master receives (action, this engine's version,
 * the access code); a local directory → `file://` URLs, the matrix_dd file
 * split out; `info: null` → bare-TLD entries with a warning; ABSENT
 * dependencies stay `null` (not declared), never `[]`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	assertConfiguredMasterUrl,
	fetchOntologyManifest,
	type ManifestResult,
	parseOntologyManifest,
	readLocalOntologyManifest,
} from '../../src/core/ontology/ontology_manifest.ts';
import {
	buildOntologyPackage,
	type FixtureOntologyTld,
} from '../../src/core/test_data/ontology_package_fixture.ts';
import { DEDALO_VERSION } from '../../src/core/update/version.ts';
import { refusalOf, refusalOfSync } from '../helpers/refusal.ts';

const DOMAIN: FixtureOntologyTld = {
	tld: 'zzma',
	name: 'zz manifest domain',
	typologyId: 15,
	typologyName: 'Others',
	dependencies: [
		{ tld: 'dd', main: 'ontology35', mandatory: true },
		{ tld: ' ZZMB ', main: 'ontology35', mandatory: true },
		{ tld: 'zzmb', main: 'ontology35', mandatory: false }, // duplicate (tld, main)
		{ tld: 'zzmb', main: 'hierarchy1', mandatory: false }, // same TLD, other main: kept
		{ tld: 'zzma', main: 'ontology35', mandatory: true }, // ontology self-reference
		{ tld: 'zzma', main: 'hierarchy1', mandatory: true }, // own thesaurus: kept
		{ tld: 'not a tld', main: 'ontology35', mandatory: true },
		{ tld: 'dd', main: 'thesaurus', mandatory: true },
		{ tld: 'dd', main: 'hierarchy1', mandatory: 'yes' },
		'zzmf', // the retired string shape
		{ tld: 'zzmf', main: 'ontology35', mandatory: false },
	],
	nodes: [{ id: 1, parent: 'zzma0', model: 'zzmb1', term: 'zz section' }],
};
const PROVIDER: FixtureOntologyTld = {
	tld: 'zzmb',
	name: 'zz manifest models',
	typologyId: 15,
	dependencies: [{ tld: 'dd', main: 'ontology35', mandatory: true }],
	nodes: [{ id: 1, parent: 'zzmb0', model: 'zzmb1', term: 'zz model', isModel: true }],
};
/** No `dependencies` key: the older-server case. */
const UNDECLARED: FixtureOntologyTld = {
	tld: 'zzmf',
	name: 'zz manifest undeclared',
	typologyId: 15,
	nodes: [{ id: 1, parent: 'zzmf0', model: 'zzmb1', term: 'zz node' }],
};

const PACKAGE = buildOntologyPackage([DOMAIN, PROVIDER, UNDECLARED], { matrixDdLines: [] });

function manifestFor(origin: string): { info: unknown; files: unknown[] } {
	const info = JSON.parse(new TextDecoder().decode(PACKAGE.get('ontology.json')));
	const tlds = ['zzma', 'zzmb', 'zzmf', 'matrix_dd'];
	return {
		info,
		files: tlds.map((tld) => ({
			tld,
			section_tipo: tld === 'matrix_dd' ? 'matrix_dd0' : `${tld}0`,
			url: `${origin}/files/${tld}.copy.gz`,
		})),
	};
}

// ---------------------------------------------------------------------------
// the loopback stand-in master
// ---------------------------------------------------------------------------

type Route = 'ok' | 'refused' | 'forbidden' | 'teapot' | 'huge' | 'garbage' | 'legacy';

const received: { path: string; body: Record<string, unknown> }[] = [];
let server: ReturnType<typeof Bun.serve>;
let origin = '';

function answer(route: Route): Response {
	switch (route) {
		case 'ok':
			return Response.json({
				ok: true,
				request_id: 'manifest-stand-in',
				data: manifestFor(origin),
				notices: [],
			});
		case 'refused':
			return Response.json({
				ok: false,
				request_id: 'manifest-stand-in',
				error: { code: 'update_server.refused', message: 'Error. Invalid code' },
			});
		case 'forbidden':
			return new Response('{"ok":false}', { status: 403 });
		case 'teapot':
			return new Response('nope', { status: 418 });
		case 'huge':
			return new Response('x'.repeat(4096));
		case 'garbage':
			return new Response('<html>not json</html>');
		case 'legacy':
			return Response.json({ result: manifestFor(origin), msg: 'OK' });
	}
}

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		async fetch(request) {
			const path = new URL(request.url).pathname;
			received.push({
				path,
				body: (await request.json().catch(() => ({}))) as Record<string, unknown>,
			});
			return answer(path.split('/')[1] as Route);
		},
	});
	origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server.stop(true);
});

function masterAt(route: Route): { name: string; url: string; code: string } {
	return {
		name: `zz ${route} master`,
		url: `${origin}/${route}/dedalo/core/api/v1/json/`,
		code: 'zzmcode',
	};
}

async function fetchFrom(route: Route, options = {}): Promise<ManifestResult> {
	const master = masterAt(route);
	return fetchOntologyManifest(master, [{ url: master.url }], options);
}

function failure(result: ManifestResult): string {
	if (result.ok) throw new Error('expected a failed manifest');
	return result.reason;
}

// ---------------------------------------------------------------------------

describe('fetchOntologyManifest — a configured master, through the bounded transport', () => {
	test('envelope ok → the catalog, dependencies normalized, absent stays null', async () => {
		const before = received.length;
		const result = await fetchFrom('ok');
		if (!result.ok) throw new Error(result.reason);
		expect(result.version).toBe(DEDALO_VERSION);
		expect(result.ontologies.map((entry) => [entry.tld, entry.dependencies])).toEqual([
			[
				'zzma',
				[
					{ tld: 'dd', main: 'ontology35', mandatory: true },
					{ tld: 'zzmb', main: 'ontology35', mandatory: true },
					{ tld: 'zzmb', main: 'hierarchy1', mandatory: false },
					{ tld: 'zzma', main: 'hierarchy1', mandatory: true },
					{ tld: 'zzmf', main: 'ontology35', mandatory: false },
				],
			], // declared order kept
			['zzmb', [{ tld: 'dd', main: 'ontology35', mandatory: true }]],
			['zzmf', null], // NOT declared — never mistaken for "needs nothing"
		]);
		expect(result.ontologies[0]).toMatchObject({
			name: 'zz manifest domain',
			typology_id: 15,
			typology_name: 'Others',
			url: `${origin}/files/zzma.copy.gz`,
		});
		expect(result.matrixDdUrl).toBe(`${origin}/files/matrix_dd.copy.gz`);
		expect(result.warnings).toEqual([
			"'zzma' declares 'zzmb' (ontology35) more than once — the first declaration wins",
			"'zzma' declares its own ontology as a dependency — ignored",
			`'zzma' declares a dependency whose tld is not a TLD ({"tld":"not a tld","main":"ontology35","mandatory":true}) — ignored`,
			`'zzma' declares a dependency whose main is not one of ontology35/hierarchy1 ({"tld":"dd","main":"thesaurus","mandatory":true}) — ignored`,
			`'zzma' declares a dependency whose mandatory is not a boolean ({"tld":"dd","main":"hierarchy1","mandatory":"yes"}) — ignored`,
			`'zzma' declares a dependency that is not an object ("zzmf") — ignored`,
		]);
		// what the master was asked
		expect(received.length).toBe(before + 1);
		expect(received.at(-1)?.body).toEqual({
			dd_api: 'dd_utils_api',
			action: 'get_ontology_update_info',
			options: { version: DEDALO_VERSION, code: 'zzmcode' },
		});
	});

	test('envelope ok:false → the server says why', async () => {
		expect(failure(await fetchFrom('refused'))).toBe('Error. Invalid code');
	});

	test('HTTP 403 → the access code / version reason, naming the server, never its address', async () => {
		const reason = failure(await fetchFrom('forbidden'));
		expect(reason).toBe(
			"HTTP 403 — the ontology server 'zz forbidden master' refused this request (access code or Dédalo version not accepted)",
		);
	});

	test('other statuses, an oversize body and a dead server are `unreachable (…)`, no address echoed', async () => {
		expect(failure(await fetchFrom('teapot'))).toBe('unreachable (HTTP 418)');
		expect(failure(await fetchFrom('huge', { maxBytes: 1024 }))).toBe('unreachable (body_cap)');
		const dead = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
		const deadUrl = `http://127.0.0.1:${dead.port}/api/`;
		dead.stop(true);
		const reason = failure(
			await fetchOntologyManifest(
				{ name: 'zz dead', url: deadUrl, code: 'x' },
				[{ url: deadUrl }],
				{
					timeoutMs: 5000,
				},
			),
		);
		expect(reason).toMatch(/^unreachable \(/);
		for (const text of [reason, 'unreachable (HTTP 418)']) expect(text).not.toContain('127.0.0.1');
	});

	test('a body that is not JSON, or not an envelope v2, is a reason, not a throw', async () => {
		expect(failure(await fetchFrom('garbage'))).toBe(
			'the ontology server answered something that is not JSON',
		);
		expect(failure(await fetchFrom('legacy'))).toBe(
			'the ontology server answered an unrecognised envelope',
		);
	});

	test('a URL that is not EXACTLY a configured master is refused before any socket', async () => {
		const before = received.length;
		const master = masterAt('ok');
		for (const allowed of [
			[],
			[{ url: `${origin}/ok/` }], // a prefix is not the URL
			[{ url: master.url.replace('127.0.0.1', 'localhost') }], // another name for it neither
			[{ url: 'not a url' }],
		]) {
			expect((await refusalOf(fetchOntologyManifest(master, allowed))).code).toBe(
				'internal.invariant',
			);
		}
		expect(received.length).toBe(before); // nothing reached the stand-in
		// normalization: an equal URL in another spelling IS the configured one
		expect(() =>
			assertConfiguredMasterUrl(master.url, [{ url: master.url.replace('http:', 'HTTP:') }]),
		).not.toThrow();
		expect(refusalOfSync(() => assertConfiguredMasterUrl('::', [{ url: '::' }])).code).toBe(
			'internal.invariant',
		);
	});
});

describe('readLocalOntologyManifest / parseOntologyManifest — the offline source', () => {
	const roots: string[] = [];
	afterAll(() => {
		for (const root of roots) rmSync(root, { recursive: true, force: true });
	});

	test('a directory in the server export layout → file:// URLs, matrix_dd split out', () => {
		const dir = mkdtempSync(join(tmpdir(), 'zz_manifest_local_'));
		roots.push(dir);
		for (const [name, bytes] of PACKAGE) writeFileSync(join(dir, name), bytes);
		writeFileSync(join(dir, 'README.txt'), 'not a package file');
		const result = readLocalOntologyManifest(dir);
		if (!result.ok) throw new Error(result.reason);
		expect(result.ontologies.map((entry) => entry.tld)).toEqual(['zzma', 'zzmb', 'zzmf']);
		for (const entry of result.ontologies) {
			expect(entry.url.startsWith('file://')).toBe(true);
			expect(entry.url.endsWith(`/${entry.tld}.copy.gz`)).toBe(true);
		}
		expect(result.matrixDdUrl?.endsWith('/matrix_dd.copy.gz')).toBe(true);
		expect(result.ontologies.find((entry) => entry.tld === 'zzmf')?.dependencies).toBeNull();
	});

	test('a missing directory is a reason, not a throw', () => {
		const result = readLocalOntologyManifest(join(tmpdir(), 'zz_manifest_missing_dir_', 'nope'));
		expect(failure(result)).toMatch(/^the ontology directory cannot be read/);
	});

	test('info null → every file under its bare TLD, warned; a bad shape is a reason', () => {
		const result = parseOntologyManifest({
			info: null,
			files: [{ tld: 'zzmd', section_tipo: 'zzmd0', url: 'https://zz.invalid/zzmd.copy.gz' }],
		});
		if (!result.ok) throw new Error(result.reason);
		expect(result.version).toBeNull();
		expect(result.ontologies).toEqual([
			{
				tld: 'zzmd',
				name: 'zzmd',
				name_data: null,
				typology_id: null,
				typology_name: null,
				dependencies: null,
				url: 'https://zz.invalid/zzmd.copy.gz',
			},
		]);
		expect(result.warnings).toEqual([
			"the manifest lists 'zzmd' without metadata (no active_ontologies entry)",
		]);
		expect(failure(parseOntologyManifest({ files: 'nope' }))).toMatch(
			/^the manifest does not have the expected shape/,
		);
		const notAList = parseOntologyManifest({
			info: { active_ontologies: [{ tld: 'zzmd', dependencies: 'dd' }] },
			files: [{ tld: 'zzmd', section_tipo: 'zzmd0', url: 'https://zz.invalid/zzmd.copy.gz' }],
		});
		if (!notAList.ok) throw new Error(notAList.reason);
		expect(notAList.ontologies[0]?.dependencies).toBeNull();
		expect(notAList.warnings).toEqual([
			"'zzmd' declares dependencies that are not a list — treated as not declared",
		]);
	});
});
