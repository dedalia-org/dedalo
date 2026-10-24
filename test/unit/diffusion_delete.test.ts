/**
 * Diffusion unpublish — target resolution (against the SCRATCH `zzd` diffusion
 * ontology, test/helpers/zzd_diffusion_fixture.ts) + the native executor contract: since the 2026-07-11 cutover
 * (DIFFUSION_PLAN P5 step 3) deleteDiffusionRecord routes sql targets ONLY
 * through the registered in-process executor (registerNativeDiffusionSqlDelete)
 * — a stubbed executor here asserts the exact engine-wire target shape
 * {database_name, table_name, section_ids, section_tipo}, the DEC-19
 * no-executor pending posture, and the dd1758 retry queue (retryPendingDiffusion
 * flips pending rows in place once the executor confirms — DIFFU-08).
 */
// Migrated to the generic `test` TLD 2026-08-19: the elements are PROVISIONED by
// the `zzd` situation instead of read off whatever install the database holds, so
// every branch (sql targets, pending, file unlink) is reachable on any machine.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	activityTable,
	deleteDiffusionRecord,
	type NativeSqlDeleteTarget,
	registerNativeDiffusionSqlDelete,
	resetNativeDiffusionSqlDeleteForTests,
} from '../../src/core/diffusion_bridge/diffusion_delete.ts';
import { getSectionDiffusionTargets } from '../../src/core/diffusion_bridge/diffusion_map.ts';
import { ensureDiffusionScratchTables } from '../helpers/diffusion_scratch_tables.ts';
import { markMediaRoot } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';
import {
	countZzdOntology,
	dropZzdOntology,
	FILE_SECTION,
	SQL_KEY_ONE,
	SQL_KEY_TWO,
	SQL_SECTION,
	seedZzdOntology,
} from '../helpers/zzd_diffusion_fixture.ts';

/** A section the fixture gives NO diffusion element — the negative control. */
const NO_DIFFUSION_SECTION = 'test65';

beforeAll(async () => {
	// afterAll's reclaim is raw SQL on the scratch dd1758 table: build it here.
	await ensureDiffusionScratchTables();
	const { preCount } = await seedZzdOntology();
	expect(preCount).toBe(0);
});

// The executor seam is module-level process state shared across test files —
// never leave a stub behind (diffusion_native_delete.test.ts hygiene).
afterEach(() => {
	resetNativeDiffusionSqlDeleteForTests();
});

afterAll(async () => {
	resetNativeDiffusionSqlDeleteForTests();
	// reclaim the dd1758 log rows the synthetic unpublish calls write — on the
	// SCRATCH activity table (the preload seam; never matrix_activity_diffusion)
	const { sql } = await import('../../src/core/db/postgres.ts');
	for (const probeId of ['999998', '999999']) {
		await sql.unsafe(
			`DELETE FROM "${activityTable()}"
			 WHERE section_tipo = 'dd1758'
			   AND relation->'dd1763' @> $1::text::jsonb`,
			[JSON.stringify([{ section_id: Number(probeId), section_tipo: SQL_SECTION }])],
		);
	}
	await dropZzdOntology();
	expect(await countZzdOntology()).toBe(0);
});

describe('diffusion unpublish', () => {
	test('the fixture section resolves its two sql publish targets', async () => {
		const targets = await getSectionDiffusionTargets(SQL_SECTION);
		const sqlTargets = targets.filter((t) => t.type === 'sql');
		expect(sqlTargets.map((t) => `${t.database_name}|${t.table_name}`).sort()).toEqual(
			[SQL_KEY_ONE, SQL_KEY_TWO].sort(),
		);
		// a section no element publishes has NO diffusion.
		expect(await getSectionDiffusionTargets(NO_DIFFUSION_SECTION)).toEqual([]);
	});

	test('the native executor receives the engine-wire shape and confirms deletions', async () => {
		const received: NativeSqlDeleteTarget[][] = [];
		registerNativeDiffusionSqlDelete(async (targets) => {
			received.push(targets);
			return {
				deleted: targets.map((t) => `${t.database_name}|${t.table_name}`),
				errors: [],
			};
		});

		const outcome = await deleteDiffusionRecord(SQL_SECTION, 999999);
		expect(received.length).toBe(1);
		const targets = [...(received[0] ?? [])].sort((a, b) =>
			a.database_name < b.database_name ? -1 : 1,
		);
		expect(targets.length).toBe(2);
		// BOTH targets pinned in full — the exact engine-wire shape.
		expect(targets).toEqual([
			{
				database_name: SQL_KEY_ONE.split('|')[0] as string,
				table_name: SQL_KEY_ONE.split('|')[1] as string,
				section_ids: [999999],
				section_tipo: SQL_SECTION,
			},
			{
				database_name: SQL_KEY_TWO.split('|')[0] as string,
				table_name: SQL_KEY_TWO.split('|')[1] as string,
				section_ids: [999999],
				section_tipo: SQL_SECTION,
			},
		]);
		expect(outcome.deleted.sort()).toEqual([SQL_KEY_ONE, SQL_KEY_TWO].sort());
		expect(outcome.pending).toEqual([]);
	});

	test('no executor registered → sql targets become pending, never throws (DEC-19)', async () => {
		resetNativeDiffusionSqlDeleteForTests();
		// synthetic record id — its dd1758 rows are reclaimed in afterAll
		const outcome = await deleteDiffusionRecord(SQL_SECTION, 999998);
		expect(outcome.deleted).toEqual([]);
		expect(outcome.pending.length).toBeGreaterThan(0);
	});
});

// dd1758 retry queue: a failing unpublish writes unpublish_pending (3) rows
// per element; retryPendingDiffusion re-runs against a now-working native
// executor and flips them IN PLACE to unpublished (2) — the PHP retry_pending
// + DIFFU-08 contract.
describe('diffusion pending retry queue (dd1758)', () => {
	const rowIds: number[] = [];

	afterAll(async () => {
		const { sql } = await import('../../src/core/db/postgres.ts');
		for (const id of rowIds) {
			await sql.unsafe(
				`DELETE FROM "${activityTable()}" WHERE section_tipo = 'dd1758' AND section_id = $1`,
				[id],
			);
		}
	});

	test('fail → pending rows; retry against a working executor → flipped to unpublished', async () => {
		const { sql } = await import('../../src/core/db/postgres.ts');
		const { deleteDiffusionRecord, retryPendingDiffusion } = await import(
			'../../src/core/diffusion_bridge/diffusion_delete.ts'
		);
		const PROBE_ID = 987654; // synthetic record id — never a real record id

		// purge PENDING leftovers previously interrupted runs may have stranded
		// ANYWHERE in the scratch table (this is the per-run test twin — the
		// dedalo_ts_test_ guard means these are never real dd1758 rows): stale
		// pending rows older than our probe rows starve the oldest-first
		// LIMIT in retryPendingDiffusion (the ledgered intermittent).
		await sql.unsafe(
			`DELETE FROM "${activityTable()}"
			 WHERE section_tipo = 'dd1758'
			   AND relation->'dd1767' @> '[{"diffusion_action":3,"section_tipo":"dd1774"}]'`,
		);
		await sql.unsafe(
			`DELETE FROM "${activityTable()}"
			 WHERE section_tipo = 'dd1758' AND relation->'dd1763' @> $1::text::jsonb`,
			[JSON.stringify([{ section_id: PROBE_ID, section_tipo: SQL_SECTION }])],
		);

		// Phase 1: executor that confirms NOTHING → every element goes pending.
		registerNativeDiffusionSqlDelete(async () => ({
			deleted: [],
			errors: ['stub outage'],
		}));
		const first = await deleteDiffusionRecord(SQL_SECTION, PROBE_ID);
		expect(first.deleted).toEqual([]);
		expect(first.pending.length).toBeGreaterThan(0);

		const pendingRows = (await sql.unsafe(
			`SELECT section_id, relation->'dd1766'->0->>'section_tipo' AS element_section,
			        string->'dd1765'->0->>'value' AS where_tipo,
			        number->'dd1764'->0->'value' AS record_id
			 FROM "${activityTable()}"
			 WHERE section_tipo = 'dd1758'
			   AND relation->'dd1767' @> '[{"diffusion_action":3,"section_tipo":"dd1774"}]'
			   AND relation->'dd1763' @> '[{"section_id":987654,"section_tipo":"test3"}]'
			 ORDER BY section_id`,
		)) as Record<string, unknown>[];
		expect(pendingRows.length).toBe(2); // one per sql element (zzd1 + zzd4)
		for (const row of pendingRows) {
			rowIds.push(Number(row.section_id));
			expect(row.element_section).toBe('zzd0'); // ontology-node locator
			expect(row.where_tipo).toBe(SQL_SECTION);
			expect(Number(row.record_id)).toBe(PROBE_ID);
		}

		// Phase 2: executor recovers → retry flips the rows in place.
		registerNativeDiffusionSqlDelete(async (targets) => ({
			deleted: targets.map((t) => `${t.database_name}|${t.table_name}`),
			errors: [],
		}));
		const retry = await retryPendingDiffusion(10);
		expect(retry.retried).toBeGreaterThanOrEqual(2);

		const flipped = (await sql.unsafe(
			`SELECT relation->'dd1767'->0->>'diffusion_action' AS action
			 FROM "${activityTable()}"
			 WHERE section_tipo = 'dd1758' AND section_id = ANY($1::int[])`,
			[`{${rowIds.join(',')}}`],
		)) as { action: string }[];
		expect(flipped.map((row) => row.action)).toEqual(['2', '2']); // unpublished
	}, 30000);
});

// File-element unlinks: the rdf path derives from the element's
// service_name + the section's owl:Class term
// ('nmo:TypeSeriesItem' → 'nmo-typeseriesitem-…​.rdf' after sanitize);
// legacy '{base}_*.rdf' variants unlink too; a missing service_name (the
// fixture's zzd7 rdf element) is unresolvable → pending.
describe('diffusion published-file unlinks', () => {
	// A MARKED scratch root: the producer both sides use (published_files.ts)
	// resolves a root that gets written under, so it asks the test-media guard.
	const FILE_ROOT = markMediaRoot(scratchDir('ts_diffusion_files'));

	afterAll(() => {
		rmSync(FILE_ROOT, { recursive: true, force: true });
	});

	test('rdf element without service_name resolves to TERMINAL (never published — PUB-02)', async () => {
		const { resolvePublishedFilePath, unlinkPublishedFiles } = await import(
			'../../src/core/diffusion_bridge/diffusion_delete.ts'
		);
		// zzd7 (the fixture's rdf element) declares NO service_name.
		expect(await resolvePublishedFilePath('zzd7', 'rdf', FILE_SECTION, 1, FILE_ROOT)).toBe(null);
		const unlinked = await unlinkPublishedFiles('zzd7', 'rdf', FILE_SECTION, 1, FILE_ROOT);
		expect(unlinked.kind).toBe('terminal');
	});

	test('sanitize + unlink flow (canonical + legacy variants, idempotent)', async () => {
		const { sanitizePublishedFileName, unlinkPublishedFiles } = await import(
			'../../src/core/diffusion_bridge/diffusion_delete.ts'
		);
		const { sql } = await import('../../src/core/db/postgres.ts');
		const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');

		expect(sanitizePublishedFileName('nmo:TypeSeriesItem_test6099_15657')).toBe(
			'nmotypeseriesitem-test6099-15657',
		);

		// Provision a synthetic rdf element WITH a service_name + owl:Class.
		await sql.unsafe(
			`INSERT INTO dd_ontology (tipo, parent, model, term, tld, is_model, is_translatable, is_main, order_number, properties)
			 VALUES ('zzr1', 'dd1190', 'diffusion_element', '{"lg-spa":"zzr element"}'::jsonb, 'zzr', false, false, false, 1,
			         '{"diffusion":{"type":"rdf","service_name":"testsvc"}}'::text::jsonb),
			        ('zzr2', 'zzr1', 'owl:Class', '{"lg-spa":"nmo:TestClass"}'::jsonb, 'zzr', false, false, false, 1, NULL)`,
		);
		await sql.unsafe(
			`UPDATE dd_ontology SET relations = '[{"tipo":"test3"}]'::jsonb WHERE tipo = 'zzr2'`,
		);
		try {
			const dir = `${FILE_ROOT}/rdf/testsvc`;
			mkdirSync(dir, { recursive: true });
			writeFileSync(`${dir}/nmotestclass-test3-7.rdf`, 'x'); // canonical
			writeFileSync(`${dir}/nmotestclass-test3-7_2024.rdf`, 'x'); // legacy
			writeFileSync(`${dir}/nmotestclass-test3-8.rdf`, 'x'); // OTHER record

			expect(await unlinkPublishedFiles('zzr1', 'rdf', 'test3', 7, FILE_ROOT)).toEqual({
				kind: 'unpublished',
			});
			expect(existsSync(`${dir}/nmotestclass-test3-7.rdf`)).toBe(false);
			expect(existsSync(`${dir}/nmotestclass-test3-7_2024.rdf`)).toBe(false);
			expect(existsSync(`${dir}/nmotestclass-test3-8.rdf`)).toBe(true); // untouched
			// idempotent second run
			expect(await unlinkPublishedFiles('zzr1', 'rdf', 'test3', 7, FILE_ROOT)).toEqual({
				kind: 'unpublished',
			});
			// xml/markdown scheme
			mkdirSync(`${FILE_ROOT}/markdown/testsvc`, { recursive: true });
			writeFileSync(`${FILE_ROOT}/markdown/testsvc/test3_7.md`, 'x');
			expect(await unlinkPublishedFiles('zzr1', 'markdown', 'test3', 7, FILE_ROOT)).toEqual({
				kind: 'unpublished',
			});
			expect(existsSync(`${FILE_ROOT}/markdown/testsvc/test3_7.md`)).toBe(false);
		} finally {
			await sql.unsafe(`DELETE FROM dd_ontology WHERE tld = 'zzr'`);
		}
	});
});
