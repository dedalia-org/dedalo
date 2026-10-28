/**
 * A THESAURUS IMPORT STREAMS — the server process never holds the decompressed
 * file (cross-ops:r2 S2).
 *
 * THE DEFECT. `importHierarchyRows` runs INSIDE the server process (Maintenance ›
 * add_hierarchy install / reset). It read each listed file whole, gunzipSync'd it
 * (the largest vendored thesaurus file is 27.9 MB → 1,068,339,452 bytes), held every
 * decompressed file at once, copied each again (Buffer.from) and concatenated them
 * all into one more buffer for psql's stdin: > 2 GB for one tld, in the process
 * that serves every request — an OOM kill on a modest host takes every in-flight
 * request with it.
 *
 * THE LAW (measured): importing a listed file of ~512 MiB decompressed (a scratch
 * tld `zzhim`, the lane SUITE database, the REAL psql path) grows this process's
 * resident set by far less than the file — the digest, the row count and the load
 * are streaming passes — IN THE SERVER'S CONDITION: a large LIVE heap (BALLAST).
 *
 * WHY THE BALLAST (W4 seed-import, measured in the CI image). The collector paces
 * itself on the live heap, so what a pass leaves as garbage piles up in a process
 * that already holds a lot — the server, and the unit tier's one `bun test` process
 * after a few hundred files. This gate was green alone and red in the tier (+975 MB):
 * the codec grew each partial row as a string (`+=` then `lastIndexOf` per chunk
 * flattens it — ~32 MiB of discarded strings per 1 MiB row) and nothing paced the
 * collection of the streamed chunks. Alone, a small heap collected it all in time and
 * hid that. With the ballast the verdict no longer depends on which files ran first:
 * HEAD-before measured +490 MB here, fixed +82 MB. The control leg proves the sampler
 * sees resident growth at all.
 *
 * WHY A CHILD PROCESS (2026-10-29). Measured in the tier's own process, the control leg
 * went red: after thousands of files the allocator reuses pages that were freed but
 * never returned, so a touched 256 MiB buffer grew RSS by ~50 MB — the probe was blind,
 * and the import leg's green proved nothing. Both legs now measure in a fresh process
 * (test/helpers/hierarchy_import_memory_probe.ts), with the same ballast.
 *
 * SURFACES. assertTestDatabase first; `zzhim1` rows of matrix_hierarchy and their
 * matrix_counter row, swept before and after; the file in a mkdtemp dir.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { encodeCopyField } from '../../src/core/db/copy_text.ts';
import { MATRIX_COPY_COLUMNS } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { connFromConfig } from '../../src/core/install/pg_exec.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

const TLD = 'zzhim';
const ROWS = 512;
/** One row's payload: 1 MiB of text (gzip shrinks the file to well under a megabyte). */
const PAYLOAD = 'x'.repeat(1 << 20);
/** The ceiling: a quarter of what one decompressed copy of the file alone would take. */
const CEILING_BYTES = (ROWS << 20) / 4;
const conn = connFromConfig();
let importDir = '';
let file = '';

async function sweep(): Promise<void> {
	await sql.unsafe(`DELETE FROM matrix_hierarchy WHERE section_tipo ~ '^${TLD}[0-9]+$'`, []);
	await sql.unsafe(`DELETE FROM matrix_counter WHERE tipo ~ '^${TLD}[0-9]+$'`, []);
}

/** Write the big listed file through a gzip stream (the test never holds it either). */
async function writeBigFile(path: string): Promise<void> {
	const gzip = createGzip({ level: 1 });
	const sink = createWriteStream(path);
	const done = new Promise<void>((resolve, reject) => {
		sink.on('finish', resolve);
		sink.on('error', reject);
	});
	gzip.pipe(sink);
	for (let sectionId = 1; sectionId <= ROWS; sectionId++) {
		const fields = MATRIX_COPY_COLUMNS.map((column) => {
			if (column === 'section_id') return String(sectionId);
			if (column === 'section_tipo') return `${TLD}1`;
			if (column === 'data') return encodeCopyField(JSON.stringify({ blob: PAYLOAD }));
			return '\\N';
		});
		if (!gzip.write(`${fields.join('\t')}\n`)) {
			await new Promise<void>((resolve) => gzip.once('drain', resolve));
		}
	}
	gzip.end();
	await done;
}

beforeAll(async () => {
	await assertTestDatabase('hierarchy_import_stream_memory_native');
	const [db] = (await sql.unsafe('SELECT current_database() AS name', [])) as { name: string }[];
	expect(conn.database).toBe(db?.name ?? '');
	importDir = mkdtempSync(join(tmpdir(), 'dedalo-hierarchy-memory-'));
	file = join(importDir, `${TLD}1.copy.gz`);
	await sweep();
	await writeBigFile(file);
}, 120_000);

afterAll(async () => {
	await sweep();
	rmSync(importDir, { recursive: true, force: true });
});

const PROBE = join(import.meta.dir, '..', 'helpers', 'hierarchy_import_memory_probe.ts');

/** Run one measurement leg in a fresh process (see the header) and read its JSON line. */
function probe(args: string[]): Record<string, unknown> & { grew: number } {
	const child = Bun.spawnSync([process.execPath, '--no-env-file', PROBE, ...args], {
		env: { ...process.env },
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 280_000,
		killSignal: 'SIGKILL',
	});
	const line = child.stdout.toString().trim().split('\n').at(-1) ?? '';
	if (child.exitCode !== 0 || !line.startsWith('{'))
		throw new Error(
			`memory probe failed (exit ${child.exitCode}): ${child.stderr.toString().slice(-2000)}`,
		);
	return JSON.parse(line);
}

describe('importHierarchyRows never holds a decompressed file', () => {
	test('control: the sampler sees a touched allocation of twice the ceiling', async () => {
		const { grew, value } = probe(['control', String(CEILING_BYTES * 2)]);
		expect(value).toBe(CEILING_BYTES * 2);
		expect(grew, 'the probe measures resident growth').toBeGreaterThan(CEILING_BYTES);
	});

	test('a ~512 MiB thesaurus file imports with the process growing far less than the file', async () => {
		expect(statSync(file).size, 'the fixture is small on disk').toBeLessThan(16 << 20);
		const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
		const measured = probe(['import', TLD, importDir, `${TLD}1.copy.gz`, sha256]);
		const { grew, value: result } = measured;
		// The ballast was held through the measurement (non-vacuity).
		expect(measured.ballast).toBe(measured.expectedBallast);
		expect(measured.ballast).toBeGreaterThan(1_000_000);
		expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
		// Non-vacuity: every row really landed, payload whole.
		const [landed] = (await sql.unsafe(
			`SELECT count(*)::int AS n, min(length(data->>'blob'))::int AS shortest FROM matrix_hierarchy WHERE section_tipo = '${TLD}1'`,
			[],
		)) as { n: number; shortest: number }[];
		expect(landed).toEqual({ n: ROWS, shortest: PAYLOAD.length });
		expect(
			grew,
			`resident set grew ${Math.round(grew / 1e6)} MB importing a ${ROWS} MiB file`,
		).toBeLessThan(CEILING_BYTES);
	}, 300_000);
});
