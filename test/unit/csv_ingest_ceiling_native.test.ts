/**
 * T1-S18 gate: the CSV size ceiling holds at EVERY CSV door, counted in BYTES on
 * disk and enforced BEFORE the bytes are read.
 *
 * Before: the only check lived in `analyzeCsv` (the get_csv_files preview
 * worker), compared DECODED code units against "bytes", and ran only after the
 * whole file had been buffered and decoded on the serving loop. validate_import
 * and import_files read, parsed and cloned any size (measured: 64 MB → ~2.2 GB in
 * the worker + the same again cloned into the main thread), and
 * process_uploaded_file staged any size into the import dir.
 *
 * The oversized fixture is a SPARSE file (no disk cost) whose content is NULs: a
 * door that READ it would answer the NUL refusal, so asserting the size sentence
 * AND the absence of `NUL` proves the refusal happened before the read.
 *
 * Scratch surfaces only: a disposable user's import + staging dirs under the
 * suite media root, removed in afterAll. The import refusal happens before the
 * dd800 run record exists — MEASURED in C by counting the dd800 rows the scratch
 * user created before and after (the catch's `bulk_process_id: null` alone
 * cannot tell), with a positive control proving the count sees a real mint. The
 * control's row (and any a regression leaked) is swept by creator in afterAll,
 * on the marked suite DB only.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { CSV_INGEST_MAX_BYTES } from '../../src/core/tools/import_csv.ts';
import { createBulkProcessRecord } from '../../src/core/tools/import_execute.ts';
import type { ImportFileReport } from '../../src/core/tools/import_wire.ts';
import { readIngestTextFile } from '../../src/core/tools/ingest_encoding.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { ToolActionContext, ToolResponse } from '../../src/core/tools/module.ts';
import { mustGet } from '../helpers/assert.ts';

const SCRATCH_USER = 987661;
const root = config.media.rootPath ?? '';
const userDir = resolve(root, 'import/files', String(SCRATCH_USER));
const stagingDir = resolve(root, config.media.upload.tmpSubdir, String(SCRATCH_USER));
const scratchDir = resolve(root, 'import/csv_ceiling_scratch');
const BIG = 'oversized.csv';
const LIMIT_MB = `${Math.round(CSV_INGEST_MAX_BYTES / 1024 / 1024)} MB`;

const BULK_SECTION = 'dd800';
let bulkTable = '';

/** dd800 rows the scratch user created — the only ones an import as that user can mint. */
async function scratchBulkIds(): Promise<number[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id::int AS id FROM "${bulkTable}"
		 WHERE section_tipo = $1 AND (data->>'created_by_user_id')::int = $2 ORDER BY section_id`,
		[BULK_SECTION, SCRATCH_USER],
	)) as { id: number }[];
	return rows.map((row) => row.id);
}

/** Sweep the scratch user's dd800 rows (+ their TM rows) — marked suite DB only. */
async function sweepScratchBulk(): Promise<void> {
	const ids = await scratchBulkIds();
	if (ids.length === 0) return;
	await assertTestDatabase('csv_ingest_ceiling_native sweep');
	await sql.unsafe(
		`DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = ANY($2::int[])`,
		[BULK_SECTION, ids],
	);
	await sql.unsafe(
		`DELETE FROM "${bulkTable}" WHERE section_tipo = $1 AND section_id = ANY($2::int[])`,
		[BULK_SECTION, ids],
	);
}

/** A sparse file of `size` bytes (all NUL) — no disk cost. */
function sparse(path: string, size: number): void {
	writeFileSync(path, '');
	truncateSync(path, size);
}

async function run(action: string, options: Record<string, unknown>): Promise<ToolResponse> {
	const loaded = await getLoadedTool('tool_import_dedalo_csv');
	const spec = mustGet(loaded?.module.apiActions[action], action);
	return spec.handler({
		principal: await resolvePrincipal(-1),
		userId: SCRATCH_USER,
		background: false,
		options,
	} as ToolActionContext);
}

/** The size sentence names the file and the limit, and no read happened. */
function expectSizeSentence(sentence: string | undefined): void {
	expect(sentence).toBeString();
	expect(sentence).toContain(BIG);
	expect(sentence).toContain(LIMIT_MB);
	expect(sentence).not.toContain('NUL');
}

beforeAll(async () => {
	const resolvedBulkTable = await getMatrixTableFromTipo(BULK_SECTION);
	expect(resolvedBulkTable).toBeString();
	bulkTable = resolvedBulkTable as string;
	await sweepScratchBulk();
	mkdirSync(userDir, { recursive: true });
	mkdirSync(scratchDir, { recursive: true });
	sparse(resolve(userDir, BIG), CSV_INGEST_MAX_BYTES + 1);
});
afterAll(async () => {
	await sweepScratchBulk();
	rmSync(userDir, { recursive: true, force: true });
	rmSync(stagingDir, { recursive: true, force: true });
	rmSync(scratchDir, { recursive: true, force: true });
});

describe('the CSV size ceiling holds at every door, before the read', () => {
	test('A get_csv_files: the oversized file is reported in errors AND listed as a read_error entry (C51: a delete-only card)', async () => {
		const res = await run('get_csv_files', {});
		const data = res.data as {
			files: { name: string; read_error?: string; ar_columns_map?: unknown }[];
			errors: string[];
		};
		const mine = data.errors.filter((line) => line.includes(BIG));
		expect(mine.length).toBe(1);
		expectSizeSentence(mine[0]);
		// WC-2026-11-13-csv-staged-file-read-error-card: the unreadable file IS in
		// `files`, with the sentence and NO column analysis — the panel renders a
		// card the operator can delete from (before: absent, no card, no delete).
		const listed = data.files.filter((file) => file.name === BIG);
		expect(listed.length).toBe(1);
		expectSizeSentence(listed[0]?.read_error);
		expect(listed[0]?.ar_columns_map).toBeUndefined();
		expect(Object.keys(listed[0] ?? {}).sort()).toEqual(['dir', 'name', 'read_error']);
	});

	test('B validate_import: refused with the size sentence, not ready', async () => {
		const res = await run('validate_import', {
			files: [{ file: BIG, section_tipo: 'test3', ar_columns_map: [] }],
		});
		const data = res.data as { ready: boolean; files: { ok: boolean; errors: string[] }[] };
		expect(data.ready).toBe(false);
		expect(data.files[0]?.ok).toBe(false);
		expectSizeSentence(data.files[0]?.errors[0]);
	});

	test('C0 positive control: a dd800 minted as the scratch user IS counted', async () => {
		await assertTestDatabase('csv_ingest_ceiling_native C0');
		const before = await scratchBulkIds();
		const minted = await createBulkProcessRecord('test3', SCRATCH_USER, { sourceFile: BIG });
		expect(minted).toBeGreaterThan(0);
		// The census SEES a real mint — C's "no new row" is not a blind count.
		expect(await scratchBulkIds()).toEqual([...before, minted]);
		await sweepScratchBulk();
		expect(await scratchBulkIds()).toEqual([]);
	});

	test('C import_files: refused with the size sentence, before any dd800 run exists', async () => {
		const bulkBefore = await scratchBulkIds();
		const res = await run('import_files', {
			files: [{ file: BIG, section_tipo: 'test3', ar_columns_map: [] }],
		});
		const report = (res.data as { files: ImportFileReport[] }).files[0] as ImportFileReport;
		expect(report.ok).toBe(false);
		expect(report.bulk_process_id).toBeNull();
		expect(report.created).toEqual([]);
		expectSizeSentence(report.errors[0]);
		// MEASURED, not inferred from the report: no dd800 run record was minted.
		expect(await scratchBulkIds()).toEqual(bulkBefore);
	});

	test('D process_uploaded_file: an oversized staged file is refused and stays staged', async () => {
		const staged = resolve(stagingDir, 'kd', 'big_staged.csv');
		mkdirSync(resolve(stagingDir, 'kd'), { recursive: true });
		sparse(staged, CSV_INGEST_MAX_BYTES + 1);
		let caught: unknown = null;
		try {
			await run('process_uploaded_file', {
				file_data: {
					key_dir: 'kd',
					tmp_name: 'big_staged.csv',
					file_name: BIG.replace('.csv', '_2.csv'),
				},
			});
		} catch (error) {
			caught = error;
		}
		expect(isDedaloError(caught)).toBe(true);
		if (!isDedaloError(caught)) return;
		expect(caught.code).toBe('media.too_large');
		expect(caught.publicMessage).toContain(LIMIT_MB);
		expect(existsSync(staged)).toBe(true);
		expect(existsSync(resolve(userDir, BIG.replace('.csv', '_2.csv')))).toBe(false);
	});

	test('E the door itself: bounded in BYTES, refused before decoding', async () => {
		const exact = resolve(scratchDir, 'exact.csv');
		const over = resolve(scratchDir, 'over.csv');
		const utf16 = resolve(scratchDir, 'utf16.csv');
		writeFileSync(exact, 'section_id;a\n1;b'); // 16 bytes
		writeFileSync(over, 'section_id;a\n1;bc'); // 17 bytes
		// UTF-16LE BOM + 8 chars = 2 + 8×2 = 18 bytes, but only 8 decoded code units.
		writeFileSync(
			utf16,
			Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a;b\n1;cd', 'utf16le')]),
		);

		expect((await readIngestTextFile(exact, 'exact.csv', 16)).text).toBe('section_id;a\n1;b');
		for (const [path, label] of [
			[over, 'over.csv'],
			[utf16, 'utf16.csv'],
		] as const) {
			let caught: unknown = null;
			try {
				await readIngestTextFile(path, label, 16);
			} catch (error) {
				caught = error;
			}
			expect(isDedaloError(caught)).toBe(true);
			if (!isDedaloError(caught)) return;
			expect(caught.code).toBe('media.too_large');
			expect(caught.publicMessage).toContain(label);
		}
	});
});
