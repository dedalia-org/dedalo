/**
 * Ontology recover door (src/core/ontology/ontology_recover.ts) + its swap
 * primitive (src/core/db/dd_ontology.ts swapRecoverySliceIntoDdOntology) —
 * the offline replacement of the retired recovery mode
 * (WC-2026-11-12-recovery-mode-retired).
 *
 * Scratch surfaces: dd_ontology rows of the `zzorc` tld, the dd_ontology_recovery
 * slice table, a mkdtemp() dir. Swept and asserted gone in afterAll.
 * Mutations: drop the per-tld DELETE → the swap leg red (zzorc3 survives);
 * drop the leftover DROP before the restore → the leftover leg red (CREATE TABLE fails);
 * drop the `finally` DROP → the failed-swap leg red (slice survives);
 * drop the quiesce check → the writers_active leg red.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
	createRecoverySlice,
	deleteTldNodes,
	swapRecoverySliceIntoDdOntology,
	upsertDdOntologyNode,
} from '../../src/core/db/dd_ontology.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { runOntologyRecover } from '../../src/core/ontology/ontology_recover.ts';
import { restoreAndSwapRecoverySlice } from '../../src/core/ontology/recovery_file.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

const TLD = 'zzorc';
let workDir = '';

async function scratchRows(): Promise<{ tipo: string; model: string | null }[]> {
	return (await sql.unsafe('SELECT tipo, model FROM dd_ontology WHERE tld = $1 ORDER BY tipo', [
		TLD,
	])) as { tipo: string; model: string | null }[];
}

async function sliceTable(): Promise<string | null> {
	const rows = (await sql.unsafe("SELECT to_regclass('dd_ontology_recovery')::text AS t", [])) as {
		t: string | null;
	}[];
	return rows[0]?.t ?? null;
}

/** A recovery file the way psql replays one: plain SQL, gzipped. */
function recoveryFile(name: string, sqlText: string): string {
	const file = join(workDir, name);
	writeFileSync(file, gzipSync(sqlText));
	return file;
}

async function refusal(work: Promise<unknown>): Promise<DedaloError> {
	try {
		await work;
	} catch (error) {
		if (error instanceof DedaloError) return error;
		throw error;
	}
	throw new Error('expected a DedaloError refusal, the call resolved');
}

beforeAll(async () => {
	await assertTestDatabase('ontology_recover_native');
	workDir = mkdtempSync(join(tmpdir(), 'zzorc-'));
	await deleteTldNodes(TLD);
});

afterAll(async () => {
	rmSync(workDir, { recursive: true, force: true });
	await sql.unsafe('DROP TABLE IF EXISTS "dd_ontology_recovery" CASCADE', []);
	await deleteTldNodes(TLD);
	expect((await scratchRows()).length).toBe(0);
});

describe('swapRecoverySliceIntoDdOntology', () => {
	test('replaces the slice tlds rows (damaged, missing, orphaned) and drops the slice', async () => {
		await upsertDdOntologyNode({
			tipo: 'zzorc1',
			model: 'section',
			tld: TLD,
			term: { 'lg-eng': 'A' },
		});
		await upsertDdOntologyNode({
			tipo: 'zzorc2',
			model: 'component_input_text',
			parent: 'zzorc1',
			tld: TLD,
			term: { 'lg-eng': 'B' },
		});
		const sliced = await createRecoverySlice([TLD]);
		expect(sliced.created).toBe(true);
		const otherBefore = (await sql.unsafe(
			'SELECT count(*)::int AS n FROM dd_ontology WHERE tld <> $1',
			[TLD],
		)) as { n: number }[];

		// damage the live projection: one row wrong, one missing, one that should not exist
		await upsertDdOntologyNode({
			tipo: 'zzorc1',
			model: 'area',
			tld: TLD,
			term: { 'lg-eng': 'A' },
		});
		await sql.unsafe("DELETE FROM dd_ontology WHERE tipo = 'zzorc2'", []);
		await upsertDdOntologyNode({
			tipo: 'zzorc3',
			model: 'section',
			tld: TLD,
			term: { 'lg-eng': 'C' },
		});

		const swap = await swapRecoverySliceIntoDdOntology();
		expect(swap).toEqual({ tlds: [TLD], rows: 2 });
		expect(await scratchRows()).toEqual([
			{ tipo: 'zzorc1', model: 'section' },
			{ tipo: 'zzorc2', model: 'component_input_text' },
		]);
		const otherAfter = (await sql.unsafe(
			'SELECT count(*)::int AS n FROM dd_ontology WHERE tld <> $1',
			[TLD],
		)) as { n: number }[];
		expect(otherAfter[0]?.n).toBe(otherBefore[0]?.n);
		const slice = (await sql.unsafe(
			"SELECT to_regclass('dd_ontology_recovery')::text AS t",
			[],
		)) as {
			t: string | null;
		}[];
		expect(slice[0]?.t).toBeNull();
	});
});

describe('restoreAndSwapRecoverySlice (one lock across restore → swap)', () => {
	test('a leftover slice from a crashed run does not block the restore', async () => {
		await createRecoverySlice([TLD]); // the leftover: the plain dump's CREATE TABLE would fail on it
		const file = recoveryFile(
			'good.sql.gz',
			`CREATE TABLE dd_ontology_recovery (LIKE dd_ontology INCLUDING ALL);
			 INSERT INTO dd_ontology_recovery (tipo, tld, model, term)
			 VALUES ('zzorc1', 'zzorc', 'section', '{"lg-eng":"From file"}');`,
		);
		const restored = await restoreAndSwapRecoverySlice(undefined, file);
		expect(restored.ok).toBe(true);
		expect(restored.swap).toEqual({ tlds: [TLD], rows: 1 });
		expect(await scratchRows()).toEqual([{ tipo: 'zzorc1', model: 'section' }]);
		expect(await sliceTable()).toBeNull();
	});

	test('a swap the live CHECKs refuse rolls back and still drops the slice', async () => {
		const before = await scratchRows();
		// no LIKE: the slice carries no CHECKs, so the bad tipo reaches the swap's INSERT
		const file = recoveryFile(
			'bad.sql.gz',
			`CREATE TABLE dd_ontology_recovery (tipo varchar(32), tld varchar(32), model text);
			 INSERT INTO dd_ontology_recovery VALUES ('zz orc 9', 'zzorc', 'section');`,
		);
		await expect(restoreAndSwapRecoverySlice(undefined, file)).rejects.toThrow();
		expect(await scratchRows()).toEqual(before);
		expect(await sliceTable()).toBeNull();
	});
});

describe('runOntologyRecover', () => {
	test('asking for no phase is refused', async () => {
		const error = await refusal(
			runOntologyRecover({ snapshot: false, rebuild: false, apply: false }),
		);
		expect(error.code).toBe('internal.invariant');
	});

	test('a missing recovery file: a dry run reports it, an apply refuses before the quiesce check', async () => {
		const snapshotFile = join(workDir, 'absent.sql.gz');
		const dry = await runOntologyRecover({
			snapshot: true,
			rebuild: false,
			apply: false,
			snapshotFile,
		});
		expect(dry.snapshot).toMatchObject({ file: snapshotFile, exists: false, swapped: null });
		// this process holds connections: reaching quiesce would answer writers_active instead
		await sql.unsafe('SELECT 1', []);
		const error = await refusal(
			runOntologyRecover({ snapshot: true, rebuild: false, apply: true, snapshotFile }),
		);
		expect(error.code).toBe('recovery.artifact_unusable');
	});

	test('a dry run reports the file and swaps nothing', async () => {
		const file = join(workDir, 'present.sql.gz');
		writeFileSync(file, 'not read on a dry run');
		const before = await scratchRows();
		const report = await runOntologyRecover({
			snapshot: true,
			rebuild: false,
			apply: false,
			snapshotFile: file,
		});
		expect(report.snapshot?.file).toBe(file);
		expect(report.snapshot?.exists).toBe(true);
		expect(report.snapshot?.swapped).toBeNull();
		expect(report.rebuild).toBeNull();
		expect(await scratchRows()).toEqual(before);
	});

	test('an apply refuses while a client holds the database (this test process does)', async () => {
		await sql.unsafe('SELECT 1', []);
		const file = join(workDir, 'present.sql.gz');
		writeFileSync(file, 'never restored: the quiesce check refuses first');
		const before = await scratchRows();
		const error = await refusal(
			runOntologyRecover({ snapshot: true, rebuild: true, apply: true, snapshotFile: file }),
		);
		expect(error.code).toBe('recovery.writers_active');
		expect(await scratchRows()).toEqual(before);
	});
});
