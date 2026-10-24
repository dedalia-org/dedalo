/**
 * Ontology UPDATE ingest (UPDATE_PROCESS Phase 2, WC-023) — the hardened
 * transport branches (origin pin, basename allowlist, redirect refusal, size
 * declaration, empty body), the decompression/sanity guards, the manifest
 * builder, and the DESTRUCTIVE copy-file import exercised on a THROWAWAY
 * scratch DATABASE (the install-suite pattern: CREATE DATABASE + seed +
 * DbConnDescriptor seam — never the shared dev DB). The orchestrator's
 * refusal paths run against the real (closed) ownership gate.
 *
 * CRASH TEARDOWN: `afterAll` is not a guarantee — a killed process runs no
 * code — so every DROP here is `WITH (FORCE)` and `beforeAll` first sweeps
 * this gate's own orphaned `<prefix><dead pid>` scratch databases through the
 * SHARED helper (test/helpers/scratch_database.ts — ONE implementation; its
 * header carries the measured incident, `dedalo_install_p4_48373`, 218 MB, the
 * refusal grammar, and what the sweep does NOT prove).
 * It also says nothing about the scratch DIRECTORY this gate makes under the
 * system temp dir, which has its own teardown and its own leak.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { config } from '../../src/config/config.ts';
import { MATRIX_COPY_COLUMNS } from '../../src/core/db/matrix_write.ts';
import { installDbFromSeed } from '../../src/core/install/db_restore.ts';
import type { DbConnDescriptor } from '../../src/core/install/pg_exec.ts';
import { runPsql } from '../../src/core/install/pg_exec.ts';
import {
	buildOntologyUpdateInfo,
	checkRemoteServer,
	confinedPath,
	consolidateSectionCounter,
	copySanityCheck,
	downloadRemoteOntologyFile,
	getOntologyIoPath,
	gunzipWithCaps,
	importFromCopyFile,
} from '../../src/core/ontology/data_io_import.ts';
import {
	saveSimpleSchemaFile,
	snapshotTableRows,
	updateOntology,
} from '../../src/core/ontology/ontology_update.ts';
import { sweepOrphanScratchDatabases } from '../helpers/scratch_database.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const SCRATCH_ROOT = scratchDir('ontology_ingest');
const VENDORED = join(process.cwd(), 'install', 'import', 'ontology', '7.0');

beforeAll(() => {
	mkdirSync(SCRATCH_ROOT, { recursive: true });
});
afterAll(() => {
	rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// path confinement + sanity + gunzip guards (pure)
// ---------------------------------------------------------------------------

describe('confinement + COPY sanity + gunzip guards', () => {
	test('confinedPath refuses traversal, separators, NUL and shell bytes', () => {
		expect(confinedPath(SCRATCH_ROOT, '../evil')).toBeNull();
		expect(confinedPath(SCRATCH_ROOT, 'a/b')).toBeNull();
		expect(confinedPath(SCRATCH_ROOT, 'a\0b')).toBeNull();
		expect(confinedPath(SCRATCH_ROOT, "a'b")).toBeNull();
		expect(confinedPath(SCRATCH_ROOT, 'dd.copy.gz')).toBe(join(SCRATCH_ROOT, 'dd.copy.gz'));
	});

	test('copySanityCheck: empty ok, NUL rejected, arity enforced', () => {
		const arity = MATRIX_COPY_COLUMNS.length;
		const good = join(SCRATCH_ROOT, 'good.copy');
		writeFileSync(good, `${Array(arity).fill('x').join('\t')}\n`);
		expect(copySanityCheck(good, arity)).toBeNull();

		const empty = join(SCRATCH_ROOT, 'empty.copy');
		writeFileSync(empty, '');
		expect(copySanityCheck(empty, arity)).toBeNull();

		const nul = join(SCRATCH_ROOT, 'nul.copy');
		writeFileSync(nul, 'a\tb\0c\n');
		expect(copySanityCheck(nul, arity)).toContain('NUL');

		const short = join(SCRATCH_ROOT, 'short.copy');
		writeFileSync(short, 'only\tthree\tcols\nx\ty\tz\n');
		expect(copySanityCheck(short, arity)).toContain('arity');
	});

	test('gunzipWithCaps round-trips real gzip and throws on corrupt input', async () => {
		const payload = Buffer.from('hello\tworld\n');
		const gz = join(SCRATCH_ROOT, 'roundtrip.gz');
		writeFileSync(gz, gzipSync(payload));
		const out = join(SCRATCH_ROOT, 'roundtrip.txt');
		const bytes = await gunzipWithCaps(gz, out);
		expect(bytes).toBe(payload.byteLength);
		expect(readFileSync(out, 'utf8')).toBe('hello\tworld\n');

		const corrupt = join(SCRATCH_ROOT, 'corrupt.gz');
		writeFileSync(corrupt, Buffer.from('not gzip at all'));
		expect(gunzipWithCaps(corrupt, join(SCRATCH_ROOT, 'corrupt.out'))).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// hardened download (local Bun.serve fixture)
// ---------------------------------------------------------------------------

describe('downloadRemoteOntologyFile hardening', () => {
	const dir = join(SCRATCH_ROOT, 'downloads');

	async function withServer(
		handler: (req: Request) => Response,
		run: (origin: string) => Promise<void>,
	) {
		const server = Bun.serve({ port: 0, fetch: handler });
		try {
			await run(`http://localhost:${server.port}`);
		} finally {
			server.stop(true);
		}
	}

	test('happy path stores the constructed basename under the target dir', async () => {
		await withServer(
			() => new Response(gzipSync(Buffer.from('data'))),
			async (origin) => {
				const out = await downloadRemoteOntologyFile({
					url: `${origin}/io/7.0/dd.copy.gz`,
					configuredOrigin: origin,
					expectedBasename: 'dd.copy.gz',
					targetDir: dir,
				});
				expect(out.ok).toBe(true);
				expect(existsSync(join(dir, 'dd.copy.gz'))).toBe(true);
			},
		);
	});

	test('origin mismatch is refused (manifest URLs never choose the target)', async () => {
		const out = await downloadRemoteOntologyFile({
			url: 'http://evil.example.com/dd.copy.gz',
			configuredOrigin: 'http://localhost:9',
			expectedBasename: 'dd.copy.gz',
			targetDir: dir,
		});
		expect(out.ok).toBe(false);
		expect(out.errors[0]).toContain('origin mismatch');
	});

	test('basename mismatch and disallowed names are refused', async () => {
		const out = await downloadRemoteOntologyFile({
			url: 'http://localhost:9/other.copy.gz',
			configuredOrigin: 'http://localhost:9',
			expectedBasename: 'dd.copy.gz',
			targetDir: dir,
		});
		expect(out.ok).toBe(false);
		expect(out.errors[0]).toContain('basename mismatch');
	});

	test('redirects are a hard failure', async () => {
		await withServer(
			() => new Response(null, { status: 302, headers: { Location: 'http://x/' } }),
			async (origin) => {
				const out = await downloadRemoteOntologyFile({
					url: `${origin}/dd.copy.gz`,
					configuredOrigin: origin,
					expectedBasename: 'dd.copy.gz',
					targetDir: dir,
				});
				expect(out.ok).toBe(false);
			},
		);
	});

	test('a lying oversize Content-Length is rejected before reading', async () => {
		// Bun.serve normalizes Content-Length, so the lying header needs a raw
		// TCP fixture that hand-writes the response head.
		const raw = Bun.listen({
			hostname: '127.0.0.1',
			port: 0,
			socket: {
				data(socket) {
					socket.write(
						`HTTP/1.1 200 OK\r\nContent-Length: ${1024 * 1024 * 1024}\r\nConnection: close\r\n\r\n`,
					);
					socket.flush();
				},
			},
		});
		try {
			const origin = `http://127.0.0.1:${raw.port}`;
			const out = await downloadRemoteOntologyFile({
				url: `${origin}/dd.copy.gz`,
				configuredOrigin: origin,
				expectedBasename: 'dd.copy.gz',
				targetDir: dir,
			});
			expect(out.ok).toBe(false);
			expect(out.msg).toContain('size cap');
		} finally {
			raw.stop(true);
		}
	});

	test('an empty body is refused (PHP empty-data parity)', async () => {
		await withServer(
			() => new Response(''),
			async (origin) => {
				const out = await downloadRemoteOntologyFile({
					url: `${origin}/dd.copy.gz`,
					configuredOrigin: origin,
					expectedBasename: 'dd.copy.gz',
					targetDir: dir,
				});
				expect(out.ok).toBe(false);
				expect(out.errors).toContain('empty data');
			},
		);
	});
});

// ---------------------------------------------------------------------------
// manifest builder (server side)
// ---------------------------------------------------------------------------

describe('buildOntologyUpdateInfo (manifest from a local IO dir)', () => {
	test('info + per-tld files with constructed URLs; junk ignored; matrix special-case', () => {
		const io = join(SCRATCH_ROOT, 'io', '9.9');
		mkdirSync(io, { recursive: true });
		writeFileSync(join(io, 'ontology.json'), JSON.stringify({ version: '9.9.0' }));
		writeFileSync(join(io, 'es.copy.gz'), 'x');
		writeFileSync(join(io, 'matrix.copy.gz'), 'x');
		writeFileSync(join(io, 'junk.txt'), 'x');
		writeFileSync(join(io, 'UPPER.copy.gz'), 'x');

		expect(getOntologyIoPath(join(SCRATCH_ROOT, 'io'), [9, 9])).toBe(io);
		expect(getOntologyIoPath(join(SCRATCH_ROOT, 'io'), [1, 2])).toBe(false);

		const manifest = buildOntologyUpdateInfo(
			io,
			'http://master.example/dedalo/install/import/ontology/9.9',
		);
		expect(manifest.msg).toBe('OK. request done');
		expect((manifest.data.info as { version: string }).version).toBe('9.9.0');
		expect(manifest.data.files).toEqual([
			{
				tld: 'es',
				section_tipo: 'es0',
				url: 'http://master.example/dedalo/install/import/ontology/9.9/es.copy.gz',
			},
			{
				tld: 'matrix',
				section_tipo: 'matrix',
				url: 'http://master.example/dedalo/install/import/ontology/9.9/matrix.copy.gz',
			},
		]);
	});
});

// ---------------------------------------------------------------------------
// schema-changes diff (pure)
// ---------------------------------------------------------------------------

describe('saveSimpleSchemaFile (additions-only diff, PHP bytes)', () => {
	test('writes only added children; filesystem success shape', () => {
		const dir = join(SCRATCH_ROOT, 'changes');
		const out = saveSimpleSchemaFile(
			{ dd6: ['a', 'b'], es0: [] },
			{ dd6: ['a', 'b', 'c'], es0: [], zz0: ['q'] },
			dir,
		);
		expect(out.ok).toBe(true);
		expect(out.msg).toBe('OK. Request successfully processed');
		const written = JSON.parse(readFileSync(out.filepath as string, 'utf8'));
		expect(written).toEqual([
			{ tipo: 'dd6', children_added: ['c'] },
			{ tipo: 'zz0', children_added: ['q'] },
		]);
	});
});

// ---------------------------------------------------------------------------
// orchestrator refusal paths (no DB writes). The ownership refusal retired at
// the 2026-07-11 cutover (engineOwnsInstall() collapsed to true); the
// config-catalog server allowlist (WC-023 D5) is the surviving first guard.
// ---------------------------------------------------------------------------

describe('updateOntology refusals', () => {
	test('refuses a server missing from the config catalog (WC-023 D5)', async () => {
		const out = await updateOntology(
			{
				server: { name: 'x', url: 'http://localhost:9/', code: 'zz' },
				files: [{ tld: 'dd', url: 'http://localhost:9/dd.copy.gz' }],
			},
			-1,
		);
		expect(out.ok).toBe(false);
		expect(out.errors).toContain('unknown ontology server: http://localhost:9');
	});
});

// ---------------------------------------------------------------------------
// checkRemoteServer must speak the TS API wire (JSON body), not PHP's
// `rqo=`-form-encoded. The TS endpoint parses request.json() and 400s on a form
// body, so a form-encoded probe made EVERY TS ontology/code master read back
// "Invalid JSON body" — and the update panel disabled that server's radio
// (render_update_ontology.js: check only on HTTP 200 + result.result===true).
// ---------------------------------------------------------------------------

describe('checkRemoteServer posts a JSON body (TS API wire)', () => {
	// A fixture that behaves like the real TS API: JSON body -> ready; anything
	// else (a form body) -> 400 "Invalid JSON body", exactly like server.ts.
	async function withJsonOnlyApi(
		run: (origin: string) => Promise<void>,
	): Promise<{ contentType: string | null }> {
		let contentType: string | null = null;
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				contentType = req.headers.get('content-type');
				try {
					if (!(contentType ?? '').includes('application/json')) throw new Error('not json');
					const body = (await req.json()) as { action?: string };
					if (body.action !== 'get_server_ready_status') throw new Error('unexpected action');
				} catch {
					return Response.json({ result: false, msg: 'Invalid JSON body' }, { status: 400 });
				}
				return Response.json({ result: true, msg: 'OK. Ontology server is ready', errors: [] });
			},
		});
		try {
			await run(`http://localhost:${server.port}`);
		} finally {
			server.stop(true);
		}
		return { contentType };
	}

	test('a JSON-only master answers ready (was 400 with the form body)', async () => {
		let probe: Awaited<ReturnType<typeof checkRemoteServer>> | undefined;
		const { contentType } = await withJsonOnlyApi(async (origin) => {
			probe = await checkRemoteServer({ name: 'm', url: `${origin}/`, code: 'demo' });
		});
		expect(contentType).toContain('application/json');
		expect(probe?.code).toBe(200);
		expect((probe?.data as { result?: unknown })?.result).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// DESTRUCTIVE copy-file import — throwaway scratch DATABASE only
// ---------------------------------------------------------------------------

const SCRATCH_PREFIX = 'dedalo_ontology_ingest_';
const SCRATCH_DB = `${SCRATCH_PREFIX}${process.pid}`;
const admin: DbConnDescriptor = {
	database: 'postgres',
	host: config.db.host,
	port: config.db.port,
	user: config.db.user,
	password: config.db.password,
	socket: config.db.socket,
};
const scratch: DbConnDescriptor = { ...admin, database: SCRATCH_DB };
let scratchAvailable = false;

// Crash teardown: the sweep lives ONCE in test/helpers/scratch_database.ts —
// its header carries the measured incident, the refusal grammar, and what the
// sweep does not prove.
beforeAll(async () => {
	const probe = await runPsql(admin, ['-tAc', 'SELECT 1']);
	if (probe.exitCode !== 0) return;
	// Reclaim what a killed predecessor could not (see the header).
	await sweepOrphanScratchDatabases(admin, SCRATCH_PREFIX);
	await runPsql(admin, ['-c', `DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`]);
	const created = await runPsql(admin, ['-c', `CREATE DATABASE "${SCRATCH_DB}"`]);
	scratchAvailable = created.exitCode === 0;
	if (scratchAvailable) await installDbFromSeed(scratch);
}, 120000);

afterAll(async () => {
	if (scratchAvailable)
		await runPsql(admin, ['-c', `DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`]);
});

async function scratchCount(table: string, where = ''): Promise<number> {
	const out = await runPsql(scratch, ['-tAc', `SELECT count(*) FROM "${table}"${where}`]);
	return Number(out.stdout.trim());
}

describe('importFromCopyFile on the scratch database', () => {
	test('vendored dd.copy.gz loads into matrix_ontology (scoped delete + copy + txn)', async () => {
		if (!scratchAvailable) {
			console.warn('[UNCOVERED] no admin Postgres connection — scratch ingest skipped');
			return;
		}
		// stage a private copy — never gunzip next to the vendored package
		const work = join(SCRATCH_ROOT, 'stage');
		mkdirSync(work, { recursive: true });
		const gz = join(work, 'dd.copy.gz');
		writeFileSync(gz, readFileSync(join(VENDORED, 'dd.copy.gz')));

		const before = await scratchCount('matrix_ontology', ` WHERE section_tipo = 'dd0'`);
		const out = await importFromCopyFile({
			sectionTipo: 'dd0',
			filePath: gz,
			matrixTable: 'matrix_ontology',
			conn: scratch,
		});
		expect(out.ok).toBe(true);
		expect(out.msg).toStartWith('OK. Request done successfully [import_from_copy_file] dd.copy.gz');
		const after = await scratchCount('matrix_ontology', ` WHERE section_tipo = 'dd0'`);
		expect(after).toBeGreaterThan(0);
		// idempotent replace: importing again lands the same count (DELETE+COPY)
		const again = await importFromCopyFile({
			sectionTipo: 'dd0',
			filePath: gz,
			matrixTable: 'matrix_ontology',
			conn: scratch,
		});
		expect(again.ok).toBe(true);
		expect(await scratchCount('matrix_ontology', ` WHERE section_tipo = 'dd0'`)).toBe(after);
		// the seed had rows too — replace must not be smaller than fresh-load
		expect(after).toBeGreaterThanOrEqual(before > 0 ? 1 : 0);
	}, 120000);

	test('a payload that breaks mid-COPY rolls the DELETE back (single txn)', async () => {
		if (!scratchAvailable) return;
		const work = join(SCRATCH_ROOT, 'stage2');
		mkdirSync(work, { recursive: true });
		// arity-valid first lines (passes the sanity window) then a broken tail
		const arity = MATRIX_COPY_COLUMNS.length;
		const goodLine = ['1', 'dd0', ...Array(arity - 2).fill('\\N')].join('\t');
		const lines = Array(60).fill(goodLine);
		lines[55] = 'broken\tline';
		const gz = join(work, 'dd.copy.gz');
		writeFileSync(gz, gzipSync(Buffer.from(`${lines.join('\n')}\n`)));

		const before = await scratchCount('matrix_ontology', ` WHERE section_tipo = 'dd0'`);
		expect(before).toBeGreaterThan(0); // loaded by the previous test
		const out = await importFromCopyFile({
			sectionTipo: 'dd0',
			filePath: gz,
			matrixTable: 'matrix_ontology',
			conn: scratch,
		});
		expect(out.ok).toBe(false);
		expect(out.msg).toBe('Error. Failed to copy data from file');
		// the scoped DELETE was rolled back with the failed COPY
		expect(await scratchCount('matrix_ontology', ` WHERE section_tipo = 'dd0'`)).toBe(before);
	}, 60000);

	test('empty export short-circuits without touching the table (PHP bytes)', async () => {
		if (!scratchAvailable) return;
		const work = join(SCRATCH_ROOT, 'stage3');
		mkdirSync(work, { recursive: true });
		const gz = join(work, 'zz.copy.gz');
		writeFileSync(gz, gzipSync(Buffer.alloc(0)));
		const before = await scratchCount('matrix_ontology');
		const out = await importFromCopyFile({
			sectionTipo: 'zz0',
			filePath: gz,
			matrixTable: 'matrix_ontology',
			conn: scratch,
		});
		expect(out.ok).toBe(true);
		expect(out.msg).toBe('OK. Empty export, nothing to import [import_from_copy_file] zz.copy.gz');
		expect(await scratchCount('matrix_ontology')).toBe(before);
	});

	test('matrix_dd whole-table replace via the vendored private lists', async () => {
		if (!scratchAvailable) return;
		const work = join(SCRATCH_ROOT, 'stage4');
		mkdirSync(work, { recursive: true });
		const gz = join(work, 'matrix_dd.copy.gz');
		writeFileSync(gz, readFileSync(join(VENDORED, 'matrix_dd.copy.gz')));
		const out = await importFromCopyFile({
			filePath: gz,
			matrixTable: 'matrix_dd',
			deleteTable: true,
			conn: scratch,
		});
		expect(out.ok).toBe(true);
		expect(await scratchCount('matrix_dd')).toBeGreaterThan(0);
	}, 60000);
});

// ---------------------------------------------------------------------------
// Recovery-snapshot + counter — the psql :'var' interpolation regression.
//
// Two same-root-cause defects the full updateOntology happy path never
// exercised (the suite only covered importFromCopyFile + the refusal paths):
// psql performs :'var' interpolation ONLY via -f / interactively — NEVER inside
// \copy arguments (snapshotTableRows, Phase-B recovery) and NEVER with -c
// (consolidateSectionCounter). Both reached the server literally and failed
// with "syntax error at or near :". The fix inlines the already-validated tipo,
// mirroring data_io.ts exportToFile.
// ---------------------------------------------------------------------------

describe("recovery snapshot + counter (psql :'var' interpolation)", () => {
	test('tipo-scoped \\copy snapshot writes exactly the section rows', async () => {
		if (!scratchAvailable) {
			console.warn(
				'[UNCOVERED] no admin Postgres connection — snapshot/counter regression skipped',
			);
			return;
		}
		// guarantee dd0 rows regardless of test order (idempotent load)
		const gz = join(SCRATCH_ROOT, 'snap_dd.copy.gz');
		writeFileSync(gz, readFileSync(join(VENDORED, 'dd.copy.gz')));
		await importFromCopyFile({
			sectionTipo: 'dd0',
			filePath: gz,
			matrixTable: 'matrix_ontology',
			conn: scratch,
		});
		const rows = await scratchCount('matrix_ontology', ` WHERE section_tipo = 'dd0'`);
		expect(rows).toBeGreaterThan(0);

		const snapFile = join(SCRATCH_ROOT, 'dd0.copy');
		// was false pre-fix: :'tipo' inside \copy → "syntax error at or near :"
		const ok = await snapshotTableRows('matrix_ontology', 'dd0', snapFile, scratch);
		expect(ok).toBe(true);
		const lines = readFileSync(snapFile, 'utf8')
			.split('\n')
			.filter((line) => line !== '').length;
		expect(lines).toBe(rows);
	}, 120000);

	test('whole-table (null tipo) snapshot still works', async () => {
		if (!scratchAvailable) return;
		const snapFile = join(SCRATCH_ROOT, 'matrix_dd.copy');
		const ok = await snapshotTableRows('matrix_dd', null, snapFile, scratch);
		expect(ok).toBe(true);
	});

	test('consolidateSectionCounter seeds matrix_counter at the HIGH-WATER MARK', async () => {
		if (!scratchAvailable) return;
		await runPsql(scratch, ['-c', `DELETE FROM matrix_counter WHERE tipo = 'dd0'`]);
		// was false pre-fix: :'tipo' with -c is not interpolated
		const ok = await consolidateSectionCounter('dd0', 'matrix_ontology', scratch);
		expect(ok).toBe(true);
		const maxOut = await runPsql(scratch, [
			'-tAc',
			`SELECT MAX(section_id) FROM matrix_ontology WHERE section_tipo = 'dd0'`,
		]);
		const counterOut = await runPsql(scratch, [
			'-tAc',
			`SELECT value FROM matrix_counter WHERE tipo = 'dd0'`,
		]);
		expect(counterOut.stdout.trim()).toBe(maxOut.stdout.trim());

		// P0-14 — and the seed is the high-water mark, NOT MAX(live section_id).
		// A record deleted before the re-import leaves its time-machine rows
		// behind; seeding below them re-mints its section_id on the next create.
		const liveMax = Number(maxOut.stdout.trim());
		const ghostId = liveMax + 137;
		try {
			await runPsql(scratch, [
				'-c',
				`INSERT INTO matrix_time_machine (section_id, section_tipo, tipo, lang, "timestamp", user_id, data)
				 VALUES (${ghostId}, 'dd0', 'dd0', 'lg-nolan', '2026-08-30 12:00:00', '1', '{}'::jsonb)`,
			]);
			await runPsql(scratch, ['-c', `DELETE FROM matrix_counter WHERE tipo = 'dd0'`]);
			expect(await consolidateSectionCounter('dd0', 'matrix_ontology', scratch)).toBe(true);
			const widened = await runPsql(scratch, [
				'-tAc',
				`SELECT value FROM matrix_counter WHERE tipo = 'dd0'`,
			]);
			expect(Number(widened.stdout.trim())).toBe(ghostId);
		} finally {
			await runPsql(scratch, [
				'-c',
				`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd0' AND section_id = ${ghostId}`,
			]);
		}
	}, 60000);
});
