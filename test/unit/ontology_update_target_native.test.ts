/**
 * TS-native gate for the two reachable halves of the ontology UPDATE_PROCESS
 * Phase 2 orchestrator (`src/core/ontology/ontology_update.ts` updateOntology),
 * extracted to `src/core/ontology/ontology_update_target.ts`:
 *
 *   - resolveUpdateTarget  — WC-023 D5: the target is re-resolved from the
 *     CONFIG catalog by url origin; an unlisted client url is refused.
 *   - stageOntologyFiles   — Phase A staging, whose load-bearing guard is that
 *     `section_tipo` is RECOMPUTED from the tld (the options schema still
 *     accepts a client `section_tipo`, so honouring it would aim an `es`
 *     package's scoped DELETE at `dd0`).
 *
 * Everything here is filesystem/HTTP only — no DB surface is touched.
 * The staging/IO dirs are per-test mkdtemp dirs under the OS temp root.
 *
 * The last describe block is the anti-revert guard required by the extraction
 * rules: it reads the production orchestrator and asserts the inline code is
 * GONE and the extraction is actually called.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { MATRIX_COPY_COLUMNS } from '../../src/core/db/matrix_write.ts';
import { updateOntologyOptionsSchema } from '../../src/core/ontology/ontology_update.ts';
import {
	type OntologyUpdateFile,
	resolveUpdateTarget,
	stageOntologyFiles,
} from '../../src/core/ontology/ontology_update_target.ts';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];

function makeDirs(): { ioPath: string; stagingDir: string } {
	const root = mkdtempSync(join(tmpdir(), 'ont_upd_943_'));
	tempRoots.push(root);
	// confinedPath rejects any resolved path carrying whitespace — a temp root
	// with a space would make every case fail; assert it loudly rather than let
	// the suite read as a staging refusal.
	expect(/[\s'"\\]/.test(root)).toBe(false);
	const ioPath = join(root, 'io');
	const stagingDir = join(root, 'io', '.staging');
	Bun.spawnSync(['mkdir', '-p', stagingDir]);
	return { ioPath, stagingDir };
}

/** One well-formed COPY text line: 13 columns → 12 tabs. */
function copyPayload(rows = 2): Buffer {
	const line = Array.from({ length: MATRIX_COPY_COLUMNS.length }, (_, i) => `c${i}`).join('\t');
	return Buffer.from(`${Array.from({ length: rows }, () => line).join('\n')}\n`, 'utf8');
}

function writeLocalPackage(ioPath: string, tld: string, payload: Buffer = copyPayload()): void {
	writeFileSync(join(ioPath, `${tld}.copy.gz`), gzipSync(payload));
}

function fileEntry(over: Partial<OntologyUpdateFile> & { tld: string }): OntologyUpdateFile {
	return { url: `https://master.example/${over.tld}.copy.gz`, ...over };
}

afterAll(() => {
	for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. resolveUpdateTarget — WC-023 D5
// ---------------------------------------------------------------------------

describe('resolveUpdateTarget', () => {
	const catalog = {
		servers: [
			{ code: 'master', url: 'https://master.example/dedalo/lib/dedalo/' },
			{ code: 'other', url: 'https://other.example:8443/x' },
		],
		isOntologyServer: false,
	};

	test('an unconfigured origin is refused with the operator-facing msg', () => {
		const out = resolveUpdateTarget(
			{ name: 'zz', url: 'https://zz.example/', code: 'master' },
			catalog,
		);
		expect(out).toEqual({
			error: 'unknown ontology server: https://zz.example',
			msg: 'Error. The selected server is not configured on this instance',
		});
	});

	test('a hostile client url is refused even with a configured code — never reached', () => {
		const out = resolveUpdateTarget(
			{ name: 'master', url: 'https://evil.attacker.example/es.copy.gz', code: 'master' },
			catalog,
		);
		expect(out).toEqual({
			error: 'unknown ontology server: https://evil.attacker.example',
			msg: 'Error. The selected server is not configured on this instance',
		});
	});

	test('an unparseable client url is refused', () => {
		const out = resolveUpdateTarget({ name: 'm', url: 'not a url', code: 'master' }, catalog);
		expect(out).toEqual({
			error: 'unknown ontology server: not a url',
			msg: 'Error. The selected server is not configured on this instance',
		});
	});

	test('the configured origin keeps a non-default port and drops the path', () => {
		const out = resolveUpdateTarget(
			{ name: 'o', url: 'https://other.example:8443/y/z', code: 'other' },
			catalog,
		);
		expect(out).toEqual({ isLocal: false, configuredOrigin: 'https://other.example:8443' });
	});

	test('masters SHARING one code resolve to the SELECTED one, not the first listed', () => {
		const shared = {
			servers: [
				{ code: 'shared', url: 'https://official.example/dedalo/core/api/v1/json/' },
				{ code: 'shared', url: 'http://192.0.2.10:4000/dedalo/core/api/v1/json/' },
			],
			isOntologyServer: false,
		};
		const second = resolveUpdateTarget(
			{ name: 'local', url: 'http://192.0.2.10:4000/dedalo/core/api/v1/json/', code: 'shared' },
			shared,
		);
		expect(second).toEqual({ isLocal: false, configuredOrigin: 'http://192.0.2.10:4000' });
		const first = resolveUpdateTarget(
			{
				name: 'official',
				url: 'https://official.example/dedalo/core/api/v1/json/',
				code: 'shared',
			},
			shared,
		);
		expect(first).toEqual({ isLocal: false, configuredOrigin: 'https://official.example' });
	});

	test("'localhost' + isOntologyServer true resolves LOCAL (no origin)", () => {
		const out = resolveUpdateTarget(
			{ name: 'Local files', url: 'https://ignored.example/', code: 'localhost' },
			{ servers: [], isOntologyServer: true },
		);
		expect(out).toEqual({ isLocal: true, configuredOrigin: null });
	});

	test("'localhost' + isOntologyServer false falls through to the unknown-server refusal", () => {
		const out = resolveUpdateTarget(
			{ name: 'Local files', url: 'https://ignored.example/', code: 'localhost' },
			{ servers: [], isOntologyServer: false },
		);
		expect(out).toEqual({
			error: 'unknown ontology server: https://ignored.example',
			msg: 'Error. The selected server is not configured on this instance',
		});
	});
});

// ---------------------------------------------------------------------------
// 2. stageOntologyFiles — local-package branch
// ---------------------------------------------------------------------------

describe('stageOntologyFiles (local master)', () => {
	const local = { isLocal: true, configuredOrigin: null };

	test('section_tipo is RECOMPUTED from the tld — the client value is ignored', async () => {
		const dirs = makeDirs();
		writeLocalPackage(dirs.ioPath, 'es');
		writeLocalPackage(dirs.ioPath, 'matrix_dd');
		const out = await stageOntologyFiles(
			[
				// the client asks for dd0; an es package DELETEing dd0 would wipe
				// the core ontology — the recompute is what prevents it.
				fileEntry({ tld: 'es', section_tipo: 'dd0' }),
				fileEntry({ tld: 'matrix_dd', section_tipo: 'dd0' }),
			],
			local,
			dirs,
		);
		if ('errors' in out) throw new Error(`unexpected staging failure: ${out.errors.join('; ')}`);
		expect(out.staged.map((file) => file.sectionTipo)).toEqual(['es0', 'matrix_dd']);
		expect(out.staged.map((file) => file.stagedPath)).toEqual([
			join(dirs.stagingDir, 'es.copy'),
			join(dirs.stagingDir, 'matrix_dd.copy'),
		]);
		// the gunzipped payload really landed, and no remote message was produced
		expect(readFileSync(out.staged[0]?.stagedPath as string, 'utf8')).toBe(
			copyPayload().toString('utf8'),
		);
		expect(out.messages).toEqual([]);
	});

	test('typology_id / name_data pass through, absent ones become null', async () => {
		const dirs = makeDirs();
		writeLocalPackage(dirs.ioPath, 'es');
		writeLocalPackage(dirs.ioPath, 'fr');
		const out = await stageOntologyFiles(
			[
				fileEntry({ tld: 'es', typology_id: 7, name_data: { lg_spa: 'Español' } }),
				fileEntry({ tld: 'fr' }),
			],
			local,
			dirs,
		);
		if ('errors' in out) throw new Error(`unexpected staging failure: ${out.errors.join('; ')}`);
		expect(out.staged[0]).toMatchObject({ typologyId: 7, nameData: { lg_spa: 'Español' } });
		expect(out.staged[1]).toMatchObject({ typologyId: null, nameData: null });
	});

	test('declared dependencies are carried normalized; absent stays NOT declared (null)', async () => {
		const dirs = makeDirs();
		for (const tld of ['es', 'fr', 'pt', 'matrix_dd']) writeLocalPackage(dirs.ioPath, tld);
		// what the update panel posts: the manifest's own field, through the options schema
		const options = updateOntologyOptionsSchema.parse({
			server: { name: 'zz', url: 'https://zz.invalid/api/', code: 'zz' },
			files: [
				fileEntry({ tld: 'matrix_dd' }),
				{
					...fileEntry({ tld: 'es' }),
					dependencies: [
						{ tld: ' DD ', main: 'ontology35', mandatory: true }, // trimmed + lowercased
						{ tld: 'es', main: 'ontology35', mandatory: true }, // ontology self-reference: dropped
						{ tld: 'es', main: 'hierarchy1', mandatory: false }, // own thesaurus: kept
						{ tld: 'fr', main: 'ontology35', mandatory: false },
						{ tld: 'dd', main: 'ontology35', mandatory: false }, // duplicate (tld, main): first wins
						7, // not an object
					],
				},
				{ ...fileEntry({ tld: 'fr' }), dependencies: [] }, // declared: needs nothing
				fileEntry({ tld: 'pt' }),
			],
		});
		const out = await stageOntologyFiles(options.files, local, dirs);
		if ('errors' in out) throw new Error(`unexpected staging failure: ${out.errors.join('; ')}`);
		expect(out.staged.map((file) => [file.tld, file.dependencies])).toEqual([
			['matrix_dd', null],
			[
				'es',
				[
					{ tld: 'dd', main: 'ontology35', mandatory: true },
					{ tld: 'es', main: 'hierarchy1', mandatory: false },
					{ tld: 'fr', main: 'ontology35', mandatory: false },
				],
			],
			['fr', []],
			['pt', null], // absent: NOT declared — never mistaken for "needs nothing"
		]);
		expect(out.messages).toEqual([
			"'es' declares its own ontology as a dependency — ignored",
			"'es' declares 'dd' (ontology35) more than once — the first declaration wins",
			"'es' declares a dependency that is not an object (7) — ignored",
		]);
	});

	test('a missing local package refuses with its own msg and stages nothing', async () => {
		const dirs = makeDirs();
		writeLocalPackage(dirs.ioPath, 'es');
		const out = await stageOntologyFiles(
			[fileEntry({ tld: 'es' }), fileEntry({ tld: 'fr' })],
			local,
			dirs,
		);
		expect(out).toEqual({
			errors: ['local ontology file missing: fr.copy.gz'],
			msg: 'Error. Local ontology file missing: fr.copy.gz',
		});
		expect('staged' in out).toBe(false);
	});

	test('a payload with the wrong column arity is refused by the copy sanity check', async () => {
		const dirs = makeDirs();
		writeLocalPackage(dirs.ioPath, 'es', Buffer.from('a\tb\nc\td\ne\tf\n', 'utf8'));
		const out = await stageOntologyFiles([fileEntry({ tld: 'es' })], local, dirs);
		if (!('errors' in out)) throw new Error('expected a sanity refusal');
		expect(out.msg).toBe('Error. Staged file failed validation: es.copy.gz');
		expect(out.errors[0]).toBe(
			`es.copy.gz: line arity mismatch: expected ${MATRIX_COPY_COLUMNS.length - 1} tabs, found 1`,
		);
	});

	test('a tld that escapes the staging dir is refused before any filesystem work', async () => {
		const dirs = makeDirs();
		const out = await stageOntologyFiles(
			// the zod schema would reject this tld upstream; the staging guard is
			// the second door and must hold on its own.
			[fileEntry({ tld: '../../etc/passwd' })],
			local,
			dirs,
		);
		expect(out).toEqual({ errors: ['unconfined staging name: ../../etc/passwd.copy.gz'] });
		// no msg key: the caller keeps its generic failure message
		expect((out as { msg?: string }).msg).toBeUndefined();
		expect(readdirSync(dirs.stagingDir)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 3. stageOntologyFiles — remote branch (a real loopback HTTP fixture)
// ---------------------------------------------------------------------------

describe('stageOntologyFiles (remote master)', () => {
	let requests: string[] = [];
	let payload: Buffer = copyPayload();
	let status = 200;

	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch(request) {
			requests.push(new URL(request.url).pathname);
			if (status !== 200) return new Response('nope', { status });
			return new Response(gzipSync(payload));
		},
	});
	const origin = `http://127.0.0.1:${server.port}`;
	const remote = { isLocal: false, configuredOrigin: origin };

	beforeEach(() => {
		requests = [];
		payload = copyPayload();
		status = 200;
	});

	afterAll(() => {
		server.stop(true);
	});

	test('each file is downloaded once and staged, with the download msg carried out', async () => {
		const dirs = makeDirs();
		const out = await stageOntologyFiles(
			[
				{ tld: 'es', url: `${origin}/es.copy.gz` },
				{ tld: 'fr', url: `${origin}/fr.copy.gz` },
			],
			remote,
			dirs,
		);
		if ('errors' in out) throw new Error(`unexpected staging failure: ${out.errors.join('; ')}`);
		expect(requests).toEqual(['/es.copy.gz', '/fr.copy.gz']);
		expect(out.staged.map((file) => file.sectionTipo)).toEqual(['es0', 'fr0']);
		expect(out.messages).toHaveLength(2);
	});

	test('a duplicate tld aborts on the SECOND entry — exactly one request was made', async () => {
		const dirs = makeDirs();
		const out = await stageOntologyFiles(
			[
				{ tld: 'dd', url: `${origin}/dd.copy.gz` },
				{ tld: 'dd', url: `${origin}/dd.copy.gz` },
			],
			remote,
			dirs,
		);
		expect(out).toEqual({ errors: ['duplicate tld in file list: dd'] });
		expect('staged' in out).toBe(false);
		expect(requests).toEqual(['/dd.copy.gz']);
	});

	test('a url whose origin is not the CONFIGURED one is refused (no request leaves)', async () => {
		const dirs = makeDirs();
		const out = await stageOntologyFiles(
			[{ tld: 'es', url: 'http://127.0.0.2:1/es.copy.gz' }],
			remote,
			dirs,
		);
		if (!('errors' in out)) throw new Error('expected an origin refusal');
		expect(out.msg).toBe('Error. Download failed for es.copy.gz');
		expect(out.errors[0]).toContain('origin mismatch');
		expect(requests).toEqual([]);
	});

	test('a url whose basename does not match the tld is refused', async () => {
		const dirs = makeDirs();
		const out = await stageOntologyFiles(
			[{ tld: 'es', url: `${origin}/dd.copy.gz` }],
			remote,
			dirs,
		);
		if (!('errors' in out)) throw new Error('expected a basename refusal');
		expect(out.msg).toBe('Error. Download failed for es.copy.gz');
		expect(out.errors[0]).toBe('basename mismatch: dd.copy.gz');
		expect(requests).toEqual([]);
	});

	test('a non-200 response aborts staging with the download msg', async () => {
		const dirs = makeDirs();
		status = 500;
		const out = await stageOntologyFiles(
			[{ tld: 'es', url: `${origin}/es.copy.gz` }],
			remote,
			dirs,
		);
		expect(out).toEqual({
			errors: ['bad server response code: 500'],
			msg: 'Error. Download failed for es.copy.gz',
		});
		expect(requests).toEqual(['/es.copy.gz']);
	});
});

// ---------------------------------------------------------------------------
// 4. anti-revert: the orchestrator must CALL the extraction, not re-inline it
// ---------------------------------------------------------------------------

describe('updateOntology is rewired to the extraction', () => {
	const source = readFileSync(
		join(import.meta.dir, '../../src/core/ontology/ontology_update.ts'),
		'utf8',
	);

	test('the inline target-resolution and staging code is gone', () => {
		for (const marker of [
			'unknown ontology server code',
			'The selected server is not configured',
			'duplicate tld in file list',
			'unconfined staging name',
			'local ontology file missing',
			'Error. Download failed for',
			'Error. Staged file failed validation',
			"file.tld === 'matrix_dd' ? 'matrix_dd'",
			'downloadRemoteOntologyFile',
			'copySanityCheck',
			'gunzipWithCaps',
		]) {
			expect(source).not.toContain(marker);
		}
	});

	test('the extraction is the code path actually taken', () => {
		expect(source).toContain("from './ontology_update_target.ts'");
		// The catalog rides the UpdateOntologyDeps seam (added for the shell gate
		// `ontology_update_shell_native.test.ts`), and STILL defaults to the
		// config catalog — the client-supplied `server.url` is never consulted.
		expect(source).toContain('resolveUpdateTarget(options.server, catalog)');
		expect(source).toContain('catalog: deps.catalog ?? config.ontologyIo');
		expect(source).not.toContain('options.server.url');
		expect(source).toContain('stageOntologyFiles(options.files, target, { ioPath, stagingDir })');
	});
});
