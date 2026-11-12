/**
 * THE INSTALLER VERIFIES EVERY ONTOLOGY FILE AGAINST ITS SOURCE'S DIGEST (T1-26 /
 * S15) — the U-41 law of WC-2026-10-30-ontology-file-digests, which the update's
 * stager already obeyed, now held by the installer's stage_ontologies too
 * (src/core/install/ontology_install.ts, ontology_catalog.ts, ontology_choice.ts).
 *
 * THE SITUATION IS BUILT: scratch `zzk*` packages from
 * src/core/test_data/ontology_package_fixture.ts (files_sha256 stamped as a current
 * master publishes it), served by a loopback Bun.serve STAND-IN or written to a
 * mkdtemp directory. DB-FREE: staging never touches the database — every write lands
 * in the gate's own scratch dirs, removed after.
 *
 * WHAT IS MEASURED (outcomes):
 *  D1 a manifest's digests reach the catalog (every entry + matrix_dd);
 *  D2 …and the install request (items + matrix_dd);
 *  D3 server: served bytes that are not the manifest's → refused `install.step_failed`
 *     naming the sha256 mismatch, nothing staged (no staged.json, no file);
 *  D4 local directory: a replaced package → the same refusal;
 *  D5 local matrix_dd replaced → refused;
 *  D6 vendored: a wrong digest for a vendored package → refused; a MALFORMED vendored
 *     map offers nothing (one warning);
 *  D7 the vendored release carries a digest for every offered entry, equal to its bytes;
 *  D8 control: matching digests stage (server + local, matrix_dd included), no warning;
 *  D9 a source without files_sha256 stages UNVERIFIED with ONE warning naming every
 *     unverified file (matrix_dd included).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { isDedaloError } from '../../src/core/errors/index.ts';
import {
	manifestCatalog,
	resolveOntologyCatalog,
} from '../../src/core/install/ontology_catalog.ts';
import {
	type OntologyCatalog,
	type OntologySource,
	ontologyInstallRequest,
	vendoredInfoFrom,
	vendoredOntologyCatalog,
} from '../../src/core/install/ontology_choice.ts';
import { stageOntologies } from '../../src/core/install/ontology_install.ts';
import { VENDORED_ONTOLOGY_DIR } from '../../src/core/install/paths.ts';
import { parseOntologyManifest } from '../../src/core/ontology/ontology_manifest.ts';
import {
	buildOntologyPackage,
	type FixtureOntologyTld,
} from '../../src/core/test_data/ontology_package_fixture.ts';
import { DEDALO_VERSION_MAJOR_MINOR } from '../../src/core/update/version.ts';

const roots: string[] = [];
const servers: { stop: () => void }[] = [];

afterAll(() => {
	for (const server of servers) server.stop();
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratchDir(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), `zzk_${name}_`));
	roots.push(dir);
	return dir;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function zzka(): FixtureOntologyTld {
	return {
		tld: 'zzka',
		name: 'zz digest a',
		typologyId: 8,
		dependencies: [{ tld: 'dd', main: 'ontology35', mandatory: true }],
		nodes: [{ id: 1, parent: 'zzka0', model: 'dd6', term: 'zz digest root' }],
	};
}

function zzkb(): FixtureOntologyTld {
	return {
		tld: 'zzkb',
		name: 'zz digest b',
		typologyId: 8,
		dependencies: [{ tld: 'dd', main: 'ontology35', mandatory: true }],
		nodes: [{ id: 1, parent: 'zzkb0', model: 'dd6', term: 'zz digest other' }],
	};
}

/** A whole, well-formed matrix_dd line set (the stager shape-checks it like any package). */
const MATRIX_DD_LINES = [oneCopyLine()];
function oneCopyLine(): string {
	// one record of the fixture's own encoder: the right arity, a scratch section tipo
	const files = buildOntologyPackage([zzka()], { digests: false });
	const gz = files.get('zzka.copy.gz') as Uint8Array;
	return gunzipSync(gz).toString('utf8').split('\n')[0] as string;
}

/** Valid gzip, valid arity — but NOT the bytes the manifest names. */
function forgedPackage(): Uint8Array {
	return gzipSync(Buffer.from(`${MATRIX_DD_LINES[0]}\n${MATRIX_DD_LINES[0]}\n`));
}

function writePackage(files: Map<string, Uint8Array>, name: string): string {
	const dir = join(scratchDir(name), 'ontology');
	mkdirSync(dir, { recursive: true });
	for (const [file, bytes] of files) writeFileSync(join(dir, file), bytes);
	return dir;
}

/** A loopback stand-in master: the manifest from `manifestFiles`, the bytes from `served`. */
function standIn(
	manifestFiles: Map<string, Uint8Array>,
	served: Map<string, Uint8Array> = manifestFiles,
): OntologySource {
	let origin = '';
	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch(request) {
			const url = new URL(request.url);
			if (request.method === 'POST' && url.pathname === '/api/') {
				const info = JSON.parse(
					Buffer.from(manifestFiles.get('ontology.json') as Uint8Array).toString(),
				);
				const list = [...manifestFiles.keys()]
					.filter((name) => name.endsWith('.copy.gz'))
					.map((name) => {
						const tld = name.slice(0, -'.copy.gz'.length);
						return { tld, section_tipo: `${tld}0`, url: `${origin}/files/${name}` };
					});
				return Response.json({ ok: true, request_id: 'zzk', data: { info, files: list } });
			}
			const body = served.get(url.pathname.split('/').pop() ?? '');
			return body === undefined
				? new Response('nope', { status: 404 })
				: new Response(new Blob([Buffer.from(body)]));
		},
	});
	origin = `http://127.0.0.1:${server.port}`;
	servers.push({ stop: () => server.stop(true) });
	return { kind: 'server', server: { name: 'zzk stand-in', url: `${origin}/api/`, code: 'zzk' } };
}

async function catalogOf(source: OntologySource): Promise<OntologyCatalog> {
	const url = source.kind === 'server' ? source.server.url : '';
	return (await resolveOntologyCatalog(source, { allowedServers: [{ url }] })).catalog;
}

async function refusalOf(work: () => Promise<unknown>): Promise<{ code: string; message: string }> {
	try {
		await work();
	} catch (error) {
		if (isDedaloError(error)) return { code: error.code, message: error.message };
		throw error;
	}
	throw new Error('expected a refusal');
}

/**
 * Stage `order` from `catalog`; on a refusal NOTHING is staged (no staged.json — the
 * install step refuses without it) and the REFUSED file is gone from every stage dir.
 */
async function stageRefusal(
	catalog: OntologyCatalog,
	order: string[],
	name: string,
	refused: string = order[0] as string,
) {
	const stagingDir = scratchDir(name);
	const refusal = await refusalOf(() =>
		stageOntologies(ontologyInstallRequest(order, catalog), { stagingDir }),
	);
	expect(existsSync(join(stagingDir, 'staged.json'))).toBe(false);
	expect(existsSync(join(stagingDir, DEDALO_VERSION_MAJOR_MINOR, `${refused}.copy.gz`))).toBe(
		false,
	);
	expect(existsSync(join(stagingDir, '.incoming', `${refused}.copy.gz`))).toBe(false);
	return refusal;
}

describe('the installer verifies ontology files against the source digests (T1-26)', () => {
	test('D1/D2: a manifest’s digests reach the catalog and the install request', () => {
		const files = buildOntologyPackage([zzka(), zzkb()], { matrixDdLines: MATRIX_DD_LINES });
		const dir = writePackage(files, 'd1');
		const raw = JSON.parse(Buffer.from(files.get('ontology.json') as Uint8Array).toString());
		const manifest = parseOntologyManifest({
			info: raw,
			files: ['zzka', 'zzkb', 'matrix_dd'].map((tld) => ({
				tld,
				section_tipo: `${tld}0`,
				url: `file://${dir}/${tld}.copy.gz`,
			})),
		});
		if (!manifest.ok) throw new Error(manifest.reason);
		const catalog = manifestCatalog(manifest, { kind: 'local', path: dir }, 'local');
		for (const entry of catalog.entries) {
			expect(entry.sha256, entry.tld).toBe(sha256(files.get(`${entry.tld}.copy.gz`) as Uint8Array));
		}
		expect(catalog.matrixDd?.sha256).toBe(sha256(files.get('matrix_dd.copy.gz') as Uint8Array));
		const request = ontologyInstallRequest(['zzka', 'zzkb'], catalog);
		expect(request.items.map((item) => item.sha256)).toEqual(
			['zzka', 'zzkb'].map((tld) => sha256(files.get(`${tld}.copy.gz`) as Uint8Array)),
		);
		expect(request.matrixDd?.sha256).toBe(sha256(files.get('matrix_dd.copy.gz') as Uint8Array));
	});

	test('D3: server — served bytes that are not the manifest’s are refused, nothing staged', async () => {
		const files = buildOntologyPackage([zzka()]);
		const served = new Map(files);
		served.set('zzka.copy.gz', forgedPackage());
		const catalog = await catalogOf(standIn(files, served));
		const refusal = await stageRefusal(catalog, ['zzka'], 'd3');
		expect(refusal.code).toBe('install.step_failed');
		expect(refusal.message).toContain('zzka.copy.gz: sha256 mismatch');
		expect(refusal.message).toContain('nothing was installed');
	});

	test('D4: local directory — a replaced package is refused, nothing staged', async () => {
		const files = buildOntologyPackage([zzka()]);
		files.set('zzka.copy.gz', forgedPackage());
		const catalog = await catalogOf({ kind: 'local', path: writePackage(files, 'd4') });
		const refusal = await stageRefusal(catalog, ['zzka'], 'd4_stage');
		expect(refusal.code).toBe('install.step_failed');
		expect(refusal.message).toContain('zzka.copy.gz: sha256 mismatch');
	});

	test('D5: local matrix_dd replaced — refused', async () => {
		const files = buildOntologyPackage([zzka()], { matrixDdLines: MATRIX_DD_LINES });
		files.set('matrix_dd.copy.gz', forgedPackage());
		const catalog = await catalogOf({ kind: 'local', path: writePackage(files, 'd5') });
		expect(catalog.matrixDd).not.toBeNull();
		const refusal = await stageRefusal(catalog, ['zzka'], 'd5_stage', 'matrix_dd');
		expect(refusal.code).toBe('install.step_failed');
		expect(refusal.message).toContain('matrix_dd.copy.gz: sha256 mismatch');
	});

	test('D6: vendored — a wrong digest is refused; a malformed map offers nothing', async () => {
		const info = vendoredInfoFrom(
			JSON.parse(readFileSync(join(VENDORED_ONTOLOGY_DIR, 'ontology.json'), 'utf8')),
		);
		const honest = vendoredOntologyCatalog(info);
		const tld = honest.entries[0]?.tld as string;
		expect(tld).toBeDefined();
		const wrong = vendoredOntologyCatalog(info, {
			ok: true,
			digests: { [`${tld}.copy.gz`]: '0'.repeat(64) },
		});
		const refusal = await stageRefusal(wrong, [tld], 'd6');
		expect(refusal.code).toBe('install.step_failed');
		expect(refusal.message).toContain(`${tld}.copy.gz: sha256 mismatch`);
		const malformed = vendoredOntologyCatalog(info, { ok: false, reason: 'files_sha256 broken' });
		expect(malformed.entries).toEqual([]);
		expect(malformed.warnings).toEqual([
			'the built-in ontology.json: files_sha256 broken — no built-in ontology is offered (a damaged release: reinstall it)',
		]);
	});

	test('D7: the vendored release names a digest for every offered entry, equal to its bytes', () => {
		const catalog = vendoredOntologyCatalog();
		expect(catalog.entries.length).toBeGreaterThan(0);
		expect(catalog.warnings).toEqual([]);
		for (const entry of catalog.entries) {
			expect(entry.sha256, entry.tld).toBe(sha256(readFileSync(entry.file)));
		}
	});

	test('D8 control: matching digests stage (server and local, matrix_dd included), no warning', async () => {
		const files = buildOntologyPackage([zzka(), zzkb()], { matrixDdLines: MATRIX_DD_LINES });
		for (const [name, source] of [
			['d8_server', standIn(files)],
			['d8_local', { kind: 'local', path: writePackage(files, 'd8') }],
		] as const) {
			const catalog = await catalogOf(source);
			const stagingDir = scratchDir(name);
			const staged = await stageOntologies(ontologyInstallRequest(['zzka', 'zzkb'], catalog), {
				stagingDir,
			});
			expect(
				staged.staged.map((item) => item.tld),
				name,
			).toEqual(['zzka', 'zzkb']);
			expect(staged.warnings, name).toEqual([]);
			const manifest = JSON.parse(readFileSync(join(stagingDir, 'staged.json'), 'utf8'));
			expect(manifest.matrix_dd?.sha256, name).toBe(
				sha256(files.get('matrix_dd.copy.gz') as Uint8Array),
			);
		}
	});

	test('D9: a source without files_sha256 stages UNVERIFIED, one warning naming every file', async () => {
		const files = buildOntologyPackage([zzka(), zzkb()], {
			matrixDdLines: MATRIX_DD_LINES,
			digests: false,
		});
		const source = standIn(files);
		const catalog = await catalogOf(source);
		const staged = await stageOntologies(ontologyInstallRequest(['zzka', 'zzkb'], catalog), {
			stagingDir: scratchDir('d9'),
		});
		expect(staged.warnings).toEqual([
			"the ontology server 'zzk stand-in' publishes no sha256 for zzka, zzkb, matrix_dd: staged UNVERIFIED (shape-checked only — re-export the source with a current Dédalo to publish digests)",
		]);
	});
});
