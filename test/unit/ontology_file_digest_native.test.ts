/**
 * TS-native gate for U-41 §4 — per-file sha256 of the ontology update files,
 * END TO END: the master's export records the digest of every served
 * `<name>.copy.gz` in ontology.json (`files_sha256`, data_io.ts
 * exportedFileDigests/withFileDigests); the manifest parser carries it onto
 * each file (ontology_manifest.ts → ontology_update_source.ts
 * filesFromManifest); the stager verifies the bytes BEFORE extract
 * (data_io_import.ts downloadRemoteOntologyFile `expectedSha256`, and the local
 * copy in ontology_update_target.ts stageOntologyFiles).
 *
 * Hermetic: mkdtemp scratch dirs under the OS temp root, a Bun.serve on
 * 127.0.0.1 for the download leg (loopback http passes isSecureUpdateSource),
 * the manifest planted through the `readManifest` seam. No database. TLDs are
 * `zz*` scratch names.
 *
 * Mutations: drop the digest check in downloadRemoteOntologyFile → the
 * mismatch leg is red; drop the rm on mismatch → "file removed" red; drop
 * `...withSha256` in filesFromManifest → the carry leg red; hash before the
 * manifest's final bytes / skip matrix_dd → the export leg red; skip the local
 * check → the local leg red. Anti-vacuity: the SAME bytes without a digest are
 * accepted (the refusal is the digest's), and each digest is checked against an
 * independent createHash of the bytes.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { MATRIX_COPY_COLUMNS } from '../../src/core/db/matrix_write.ts';
import {
	exportedFileDigests,
	fileSha256,
	withFileDigests,
} from '../../src/core/ontology/data_io.ts';
import { downloadRemoteOntologyFile } from '../../src/core/ontology/data_io_import.ts';
import { parseOntologyManifest } from '../../src/core/ontology/ontology_manifest.ts';
import { resolveOntologySource } from '../../src/core/ontology/ontology_update_source.ts';
import { stageOntologyFiles } from '../../src/core/ontology/ontology_update_target.ts';
import { DEDALO_DATA_VERSION, formatVersion } from '../../src/core/update/version.ts';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** One valid COPY row (MATRIX_COPY_COLUMNS arity), gzipped — passes the stager's shape check. */
const COPY_GZ = gzipSync(`${Array.from(MATRIX_COPY_COLUMNS, () => '\\N').join('\t')}\n`);
const COPY_SHA = sha(COPY_GZ);
const OTHER_SHA = sha('not the exported bytes');

const roots: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), 'dd_digest_'));
	roots.push(dir);
	return dir;
}

let server: ReturnType<typeof Bun.serve>;
let origin = '';

beforeAll(() => {
	server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () => new Response(COPY_GZ),
	});
	origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server.stop(true);
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function download(targetDir: string, expectedSha256?: string) {
	return downloadRemoteOntologyFile({
		url: `${origin}/zzdig.copy.gz`,
		configuredOrigin: origin,
		expectedBasename: 'zzdig.copy.gz',
		targetDir,
		allowHttp: false,
		expectedSha256,
	});
}

describe('U-41 download leg — verified before it is reported ok', () => {
	test('a matching digest is accepted', async () => {
		const dir = scratch();
		const result = await download(dir, COPY_SHA);
		expect(result.ok).toBe(true);
		expect(await fileSha256(join(dir, 'zzdig.copy.gz'))).toBe(COPY_SHA);
	});

	test('a mismatching digest is REFUSED and the file removed', async () => {
		const dir = scratch();
		const result = await download(dir, OTHER_SHA);
		expect(result.ok).toBe(false);
		expect(result.msg).toBe('Error. Ontology file does not match the master manifest');
		expect(result.errors).toEqual(['sha256 mismatch: zzdig.copy.gz']);
		expect(existsSync(join(dir, 'zzdig.copy.gz'))).toBe(false);
	});

	test('anti-vacuity: the SAME bytes with no digest are accepted (older master)', async () => {
		const dir = scratch();
		const result = await download(dir);
		expect(result.ok).toBe(true);
		expect(existsSync(join(dir, 'zzdig.copy.gz'))).toBe(true);
	});
});

describe('U-41 local leg — a local master copy is verified too', () => {
	function localDirs() {
		const ioPath = scratch();
		const stagingDir = scratch();
		writeFileSync(join(ioPath, 'zzdig.copy.gz'), COPY_GZ);
		return { ioPath, stagingDir };
	}
	const LOCAL = { isLocal: true, configuredOrigin: null };
	const file = (sha256?: string) => ({ tld: 'zzdig', url: 'file:///unused', sha256 });

	test('mismatch → refused, staged copy removed', async () => {
		const dirs = localDirs();
		const staging = await stageOntologyFiles([file(OTHER_SHA)], LOCAL, dirs);
		expect(staging).toEqual({
			errors: ['sha256 mismatch: zzdig.copy.gz'],
			msg: 'Error. Ontology file does not match the master manifest',
		});
		expect(existsSync(join(dirs.stagingDir, 'zzdig.copy.gz'))).toBe(false);
	});

	test('match, and absent (control), both stage', async () => {
		for (const sha256 of [COPY_SHA, undefined]) {
			const staging = await stageOntologyFiles([file(sha256)], LOCAL, localDirs());
			expect('staged' in staging && staging.staged.map((entry) => entry.tld)).toEqual(['zzdig']);
		}
	});
});

describe('U-41 manifest leg — the digest rides from files_sha256 to each file', () => {
	const version = formatVersion(DEDALO_DATA_VERSION);
	const target = { isLocal: false, configuredOrigin: 'http://127.0.0.1:9' };
	const catalog = {
		servers: [{ code: 'fixture_master', url: 'http://127.0.0.1:9/api/' }],
		isOntologyServer: false,
	};
	function rawManifest(filesSha256?: Record<string, string>) {
		return {
			info: {
				version,
				active_ontologies: [{ tld: 'zzdig', name: 'zz digest' }],
				...(filesSha256 === undefined ? {} : { files_sha256: filesSha256 }),
			},
			files: [
				{ tld: 'zzdig', section_tipo: 'zzdig0', url: 'http://127.0.0.1:9/zzdig.copy.gz' },
				{
					tld: 'matrix_dd',
					section_tipo: 'matrix_dd',
					url: 'http://127.0.0.1:9/matrix_dd.copy.gz',
				},
			],
		};
	}
	const request = [
		{ tld: 'zzdig', url: 'http://127.0.0.1:9/zzdig.copy.gz' },
		{ tld: 'matrix_dd', url: 'http://127.0.0.1:9/matrix_dd.copy.gz' },
	];
	function resolveWith(raw: unknown) {
		// The client's own sha256 rides along — it must never survive.
		const forged = request.map((entry) => ({ ...entry, sha256: OTHER_SHA }));
		return resolveOntologySource(forged, target, catalog, {
			readManifest: async () => parseOntologyManifest(raw),
			installedDataVersion: async () => [...DEDALO_DATA_VERSION],
		});
	}

	test('filesFromManifest carries each sha256 (matrix_dd included); a client sha256 is never honoured', async () => {
		const forged = request.map((entry) => ({ ...entry, sha256: OTHER_SHA }));
		const resolved = await resolveOntologySource(forged, target, catalog, {
			readManifest: async () =>
				parseOntologyManifest(
					rawManifest({ 'zzdig.copy.gz': COPY_SHA, 'matrix_dd.copy.gz': sha('dd') }),
				),
			installedDataVersion: async () => [...DEDALO_DATA_VERSION],
		});
		expect(resolved.map((file) => [file.tld, file.sha256])).toEqual([
			['zzdig', COPY_SHA],
			['matrix_dd', sha('dd')],
		]);
	});

	test('no files_sha256 → accepted unverified, ONE warning naming the master', async () => {
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const resolved = await resolveWith(rawManifest());
			expect(resolved.every((file) => file.sha256 === undefined)).toBe(true);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0])).toContain('http://127.0.0.1:9');
		} finally {
			warn.mockRestore();
		}
	});

	test('a malformed digest map refuses the manifest', () => {
		const parsed = parseOntologyManifest(rawManifest({ 'zzdig.copy.gz': 'NOT-HEX' }));
		expect(parsed.ok).toBe(false);
	});
});

describe('U-41 export leg — digests of the bytes ON DISK', () => {
	test('every served <name>.copy.gz (matrix_dd too), nothing else, each = sha256 of its bytes', async () => {
		const io = scratch();
		writeFileSync(join(io, 'zzdig.copy.gz'), COPY_GZ);
		writeFileSync(join(io, 'matrix_dd.copy.gz'), 'private lists');
		writeFileSync(join(io, 'zzdig.copy.gz.tmp-abc123'), 'in-flight export');
		writeFileSync(join(io, 'ontology.json'), '{}');
		mkdirSync(join(io, 'sub'));
		const digests = await exportedFileDigests(io);
		expect(digests).toEqual({
			'matrix_dd.copy.gz': sha('private lists'),
			'zzdig.copy.gz': COPY_SHA,
		});
		// Anti-vacuity: rewriting the bytes moves the digest.
		writeFileSync(join(io, 'zzdig.copy.gz'), 'republished');
		expect((await exportedFileDigests(io))['zzdig.copy.gz']).toBe(sha('republished'));
	});

	test('withFileDigests adds files_sha256 to the manifest value, keeps the rest; null stays null', () => {
		const info = { version: '7.0.0', active_ontologies: [{ tld: 'zzdig' }] };
		expect(withFileDigests(info, { 'zzdig.copy.gz': COPY_SHA })).toEqual({
			...info,
			files_sha256: { 'zzdig.copy.gz': COPY_SHA },
		});
		expect(withFileDigests(null, { 'zzdig.copy.gz': COPY_SHA })).toBeNull();
	});
});
