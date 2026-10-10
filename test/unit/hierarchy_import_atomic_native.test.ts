/**
 * A HIERARCHY IMPORT APPLIES WHOLE OR NOT AT ALL (OPS-6/PERF-11 review follow-up).
 *
 * THE DEFECT. `installHierarchies` (the install wizard's hierarchy step, and the
 * add_hierarchy "Reset to seed" action with `replace: true`) ran each step of a
 * tld's import as its OWN psql call — its own transaction:
 *   1. `DELETE FROM matrix_hierarchy WHERE section_tipo ~ '^<tld>[0-9]+$'`;
 *   2. `\copy` of `<tld>1.copy.gz` (the terms);
 *   3. `\copy` of `<tld>2.copy.gz` (the models) — its failure IGNORED;
 *   4. the counter consolidation — its failure SWALLOWED (`.catch(() => {})`).
 * A terms file that failed to load (a corrupt seed, a constraint, a dropped
 * connection) therefore left the hierarchy DELETED — every operator edit and
 * addition gone, the seed not restored — and a failed models file left a
 * half-imported hierarchy reported as success.
 *
 * THE LAW (measured here, on a scratch tld `zzhia` in the lane SUITE database,
 * through the REAL psql path, `importHierarchyRows`):
 *  (a) replace with a corrupt TERMS file → refused, and the existing rows —
 *      the operator's edit and addition — are intact;
 *  (b) replace with valid terms but a corrupt MODELS file → refused (not a
 *      success), existing rows intact, no seed row landed;
 *  (c) replace with valid files → the seed replaces the rows, models included,
 *      and the counter is raised to the high-water mark in the same unit;
 *  (d) without replace, a present tld is skipped untouched;
 *  (e) a listed file that is not gzip → a deliberate sentence, nothing written;
 *  (j)/(k) (2026-10-10 review) "already imported" is judged on the sections the
 *      entry LISTS — a models-only entry imports and then skips; a section that
 *      holds only the root an empty activation minted is refused naming Reset;
 *  (f) VERIFIED BEFORE WRITTEN (2026-10-10, WC-2026-10-10-hierarchy-json-manifest):
 *      a listed file whose bytes do not hash to the manifest's sha256, a listed
 *      file that is missing, or an empty list → refused, nothing written (the
 *      operator's rows intact even under replace).
 *
 * SURFACES. assertTestDatabase first; rows of `zzhia1`/`zzhia2` in
 * matrix_hierarchy and their matrix_counter rows, swept before and after; the
 * seed files live in a mkdtemp dir.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { MATRIX_COPY_COLUMNS } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	classifyListedSections,
	importHierarchyRows,
} from '../../src/core/install/hierarchy_import.ts';
import { connFromConfig, runPsql } from '../../src/core/install/pg_exec.ts';
import {
	type HierarchyDataFile,
	sha256Hex,
} from '../../src/core/ontology/hierarchy_manifest_format.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

const TLD = 'zzhia';
const conn = connFromConfig();
let importDir = '';
let seedTerms = '';
let seedModels = '';

async function sweep(): Promise<void> {
	await sql.unsafe(`DELETE FROM matrix_hierarchy WHERE section_tipo ~ '^${TLD}[0-9]+$'`, []);
	await sql.unsafe(`DELETE FROM matrix_counter WHERE tipo ~ '^${TLD}[0-9]+$'`, []);
}

async function insertRow(sectionTipo: string, sectionId: number, marker: string): Promise<void> {
	await sql.unsafe(
		'INSERT INTO matrix_hierarchy (section_id, section_tipo, data) VALUES ($1, $2, $3::text::jsonb)',
		[sectionId, sectionTipo, encodeForJsonb({ marker })],
	);
}

/** The COPY text (MATRIX_COPY_COLUMNS order) of one section's rows, through psql. */
async function copyText(sectionTipo: string): Promise<string> {
	const res = await runPsql(conn, [
		'-v',
		'ON_ERROR_STOP=1',
		'-c',
		`\\copy (SELECT ${MATRIX_COPY_COLUMNS.join(', ')} FROM matrix_hierarchy WHERE section_tipo = '${sectionTipo}' ORDER BY section_id) TO STDOUT`,
	]);
	expect(res.exitCode, res.stderr).toBe(0);
	return `${res.stdout}\n`;
}

/** Write the seed files and answer the manifest's `data_files` for them (real digests). */
function writeSeed(terms: string, models: string | null): HierarchyDataFile[] {
	const termsBytes = gzipSync(Buffer.from(terms));
	writeFileSync(join(importDir, `${TLD}1.copy.gz`), termsBytes);
	const listed: HierarchyDataFile[] = [{ file: `${TLD}1.copy.gz`, sha256: sha256Hex(termsBytes) }];
	const modelsPath = join(importDir, `${TLD}2.copy.gz`);
	rmSync(modelsPath, { force: true });
	if (models !== null) {
		const modelsBytes = gzipSync(Buffer.from(models));
		writeFileSync(modelsPath, modelsBytes);
		listed.push({ file: `${TLD}2.copy.gz`, sha256: sha256Hex(modelsBytes) });
	}
	return listed;
}

async function rows(): Promise<string[]> {
	const found = (await sql.unsafe(
		`SELECT section_tipo, section_id, data->>'marker' AS marker FROM matrix_hierarchy
		  WHERE section_tipo ~ '^${TLD}[0-9]+$' ORDER BY section_tipo, section_id`,
		[],
	)) as { section_tipo: string; section_id: number; marker: string }[];
	return found.map((row) => `${row.section_tipo}/${row.section_id}:${row.marker}`);
}

beforeAll(async () => {
	await assertTestDatabase('hierarchy_import_atomic_native');
	const [db] = (await sql.unsafe('SELECT current_database() AS name', [])) as { name: string }[];
	// The psql channel and the engine pool must name the SAME (lane) database.
	expect(conn.database).toBe(db?.name ?? '');
	importDir = mkdtempSync(join(tmpdir(), 'dedalo-hierarchy-import-'));
	await sweep();
	// The SEED: two terms and one model, rendered as COPY text by psql itself.
	await insertRow(`${TLD}1`, 1, 'seed');
	await insertRow(`${TLD}1`, 2, 'seed');
	await insertRow(`${TLD}2`, 1, 'seed-model');
	seedTerms = await copyText(`${TLD}1`);
	seedModels = await copyText(`${TLD}2`);
	await sweep();
});

afterAll(async () => {
	await sweep();
	rmSync(importDir, { recursive: true, force: true });
});

/** The operator's state before a reset: an EDITED seed term and an ADDED term. */
beforeEach(async () => {
	await sweep();
	await insertRow(`${TLD}1`, 1, 'edited');
	await insertRow(`${TLD}1`, 7, 'added');
});

const OPERATOR_STATE = [`${TLD}1/1:edited`, `${TLD}1/7:added`];
const CORRUPT_LINE = 'not-an-integer\tzzhia1\n';

describe('importHierarchyRows: one tld = one atomic unit', () => {
	test("(a) replace with a corrupt TERMS file is refused and leaves the operator's rows intact", async () => {
		const dataFiles = writeSeed(seedTerms + CORRUPT_LINE, seedModels);
		const result = await importHierarchyRows(conn, TLD, { replace: true, importDir, dataFiles });
		expect(result.ok).toBe(false);
		expect(await rows()).toEqual(OPERATOR_STATE);
	});

	test('(b) replace with a corrupt MODELS file is refused (never a success) and lands nothing', async () => {
		const dataFiles = writeSeed(seedTerms, seedModels + CORRUPT_LINE);
		const result = await importHierarchyRows(conn, TLD, { replace: true, importDir, dataFiles });
		expect(result.ok).toBe(false);
		expect(await rows()).toEqual(OPERATOR_STATE);
	});

	test('(c) replace with valid files: the seed replaces the rows, models included, and the counter is raised in the same unit', async () => {
		const dataFiles = writeSeed(seedTerms, seedModels);
		const result = await importHierarchyRows(conn, TLD, { replace: true, importDir, dataFiles });
		expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
		expect(await rows()).toEqual([`${TLD}1/1:seed`, `${TLD}1/2:seed`, `${TLD}2/1:seed-model`]);
		const counters = (await sql.unsafe(
			`SELECT tipo, value FROM matrix_counter WHERE tipo ~ '^${TLD}[0-9]+$' ORDER BY tipo`,
			[],
		)) as { tipo: string; value: number }[];
		expect(counters.map((row) => `${row.tipo}=${Number(row.value)}`)).toEqual([
			`${TLD}1=2`,
			`${TLD}2=1`,
		]);
	});

	test('(d) without replace a present tld is skipped, untouched', async () => {
		const dataFiles = writeSeed(seedTerms, seedModels);
		const result = await importHierarchyRows(conn, TLD, { importDir, dataFiles });
		expect(result).toMatchObject({ ok: true, skipped: true });
		expect(await rows()).toEqual(OPERATOR_STATE);
	});

	test('(e) a seed that is not gzip is refused with a DELIBERATE sentence — never the raw zlib/fs text (SEC-17), nothing written', async () => {
		const notGzip = Buffer.from('plain text, not gzip');
		writeFileSync(join(importDir, `${TLD}1.copy.gz`), notGzip);
		rmSync(join(importDir, `${TLD}2.copy.gz`), { force: true });
		const dataFiles = [{ file: `${TLD}1.copy.gz`, sha256: sha256Hex(notGzip) }];
		const errorLog = spyOn(console, 'error').mockImplementation(() => {});
		try {
			const result = await importHierarchyRows(conn, TLD, { replace: true, importDir, dataFiles });
			expect(result.ok).toBe(false);
			expect(result.msg).toBe(
				`decompress failed (${TLD}1.copy.gz): the file could not be read as a gzip archive — see the server log`,
			);
			// The raw exception text goes to the LOG, not the report.
			expect(result.msg).not.toContain(importDir);
			expect(result.msg).not.toContain('header');
			expect(errorLog).toHaveBeenCalledTimes(1);
		} finally {
			errorLog.mockRestore();
		}
		expect(await rows()).toEqual(OPERATOR_STATE);
	});

	test('(f) a CHECKSUM MISMATCH is refused before any write — the operator rows intact, even under replace', async () => {
		const dataFiles = writeSeed(seedTerms, seedModels);
		// One byte of the digest differs: the file on disk is not the release's file.
		const tampered = dataFiles.map((item, index) =>
			index === 1
				? { ...item, sha256: `${item.sha256.slice(0, -1)}${item.sha256.endsWith('0') ? '1' : '0'}` }
				: item,
		);
		const result = await importHierarchyRows(conn, TLD, {
			replace: true,
			importDir,
			dataFiles: tampered,
		});
		expect(result.ok).toBe(false);
		expect(result.msg).toBe(
			`checksum mismatch for ${TLD}2.copy.gz: its sha256 is not the one hierarchy.json lists — nothing imported`,
		);
		expect(await rows()).toEqual(OPERATOR_STATE);
	});

	test('(g) a LISTED file that is missing is refused before any write', async () => {
		const dataFiles = writeSeed(seedTerms, seedModels);
		rmSync(join(importDir, `${TLD}2.copy.gz`), { force: true });
		const result = await importHierarchyRows(conn, TLD, { replace: true, importDir, dataFiles });
		expect(result.ok).toBe(false);
		expect(result.msg).toBe(
			`missing data file ${TLD}2.copy.gz (listed in hierarchy.json) — nothing imported`,
		);
		expect(await rows()).toEqual(OPERATOR_STATE);
	});

	test('(h) an EMPTY data-file list imports nothing (an empty thesaurus is activation-only)', async () => {
		writeSeed(seedTerms, seedModels);
		const result = await importHierarchyRows(conn, TLD, {
			replace: true,
			importDir,
			dataFiles: [],
		});
		expect(result).toEqual({ ok: false, msg: 'no data files listed — nothing to import' });
		expect(await rows()).toEqual(OPERATOR_STATE);
	});

	test('(i) only the LISTED files are imported — a models file on disk the entry omits is not', async () => {
		const [termsOnly] = writeSeed(seedTerms, seedModels);
		const result = await importHierarchyRows(conn, TLD, {
			replace: true,
			importDir,
			dataFiles: [termsOnly as HierarchyDataFile],
		});
		expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
		expect(await rows()).toEqual([`${TLD}1/1:seed`, `${TLD}1/2:seed`]);
	});
});

describe('importHierarchyRows: "already imported" is judged on the LISTED sections', () => {
	test('(j) an entry listing ONLY its models file imports it, and a re-run skips it (never re-copies into a PK violation)', async () => {
		// The operator state has `<tld>1` rows; the entry lists only `<tld>2`. The probe
		// used to look at `<tld>1` alone: this run was "already installed" (the models
		// never landed), and with the models present a re-run re-copied them.
		const [, modelsOnly] = writeSeed(seedTerms, seedModels);
		const dataFiles = [modelsOnly as HierarchyDataFile];
		const first = await importHierarchyRows(conn, TLD, { importDir, dataFiles });
		expect(first).toEqual({ ok: true, msg: 'copied' });
		expect(await rows()).toEqual([...OPERATOR_STATE, `${TLD}2/1:seed-model`]);
		const again = await importHierarchyRows(conn, TLD, { importDir, dataFiles });
		expect(again).toEqual({ ok: true, msg: 'already installed — import skipped', skipped: true });
		expect(await rows()).toEqual([...OPERATOR_STATE, `${TLD}2/1:seed-model`]);
	});

	test('(k) a listed section holding ONLY a minted root while its file carries more is refused naming Reset — never a silent skip', async () => {
		// An empty thesaurus activated earlier: the activation minted its General Term root.
		await sweep();
		await insertRow(`${TLD}1`, 1, 'minted-root');
		const dataFiles = writeSeed(seedTerms, null);
		const result = await importHierarchyRows(conn, TLD, { importDir, dataFiles });
		expect(result.ok).toBe(false);
		expect(result.skipped).toBeUndefined();
		expect(result.msg).toStartWith(`data available, not imported: ${TLD}1 hold(s) only the root`);
		expect(result.msg).toContain('Reset to seed');
		expect(await rows()).toEqual([`${TLD}1/1:minted-root`]);
		// The destructive, confirmed door still imports it.
		const reset = await importHierarchyRows(conn, TLD, { replace: true, importDir, dataFiles });
		expect(reset).toEqual({ ok: true, msg: 'copied' });
		expect(await rows()).toEqual([`${TLD}1/1:seed`, `${TLD}1/2:seed`]);
	});
});

describe('classifyListedSections (pure)', () => {
	const of = (pairs: [string, number][]) => new Map(pairs);
	test('nothing present → absent; data present → imported; a lone root under a bigger file → root_only', () => {
		const data = of([
			['xx1', 50],
			['xx2', 1],
		]);
		expect(
			classifyListedSections(
				of([
					['xx1', 0],
					['xx2', 0],
				]),
				data,
			),
		).toEqual({ kind: 'absent' });
		expect(
			classifyListedSections(
				of([
					['xx1', 50],
					['xx2', 0],
				]),
				data,
			),
		).toEqual({ kind: 'imported' });
		// An operator who deleted terms still has more than the root: imported.
		expect(
			classifyListedSections(
				of([
					['xx1', 2],
					['xx2', 1],
				]),
				data,
			),
		).toEqual({ kind: 'imported' });
		expect(
			classifyListedSections(
				of([
					['xx1', 1],
					['xx2', 1],
				]),
				data,
			),
		).toEqual({
			kind: 'root_only',
			sections: ['xx1'],
		});
		// A ONE-row file is indistinguishable from its own root: imported.
		expect(classifyListedSections(of([['xx2', 1]]), of([['xx2', 1]]))).toEqual({
			kind: 'imported',
		});
	});
});
