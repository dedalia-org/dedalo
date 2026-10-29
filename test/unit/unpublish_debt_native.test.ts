/**
 * UNPUBLISH DEBT — a record unpublished/deleted in the matrix is either removed
 * from the public tier or the debt is REPORTED, never silent (audit
 * 2026-08-26 P1-12: LIFE-07, PUB-02, PUB-03, LIFE-02's reporter half).
 *
 * THE FOUR LAWS, each measured on a situation this file builds (the `zzd`
 * diffusion fixture on the SUITE database, a private dd1758 seam table, a
 * marked scratch files root):
 *
 *   1. TERMINAL, NOT STARVING (PUB-02). Census TOTAL over the never-resolving
 *      producers: every target of the fixture's TERMINAL section (csv
 *      full-export element, sql element without a database node, rdf element
 *      without service_name) is classified terminal, ledgered WITH its
 *      reason, and EXCLUDED from the retry queue — so it can neither be
 *      retried forever nor pretend to be settled.
 *   2. FAIRNESS (PUB-02). Two-row probe: a permanently failing older row and a
 *      settleable newer one, drained with limit 1 — the second run reaches
 *      the newer row, because an attempted row is stamped and the queue is
 *      least-recently-attempted first.
 *   3. DURABLE INTENT (LIFE-07). Target resolution that THROWS inside the
 *      delete transaction still leaves a (record-level) pending row after the
 *      commit; and through the REAL record-delete door, an executor outage
 *      leaves one pending row per element — never zero.
 *   4. THE REPORTER RUNS (LIFE-02). The `public_tier` reconcile, through the
 *      registry door, reports the pending debt of the deleted record and a
 *      seeded GHOST marker; apply removes the ghost and nothing else.
 *   5. A HOLD THAT LEAVES DEBT PAYS IT (closure review 2026-10-22, D5). The
 *      `media_index` apply holds every marker database's target EXCLUSIVELY,
 *      and it runs on a period (boot + every 10 min). A record deleted through
 *      the REAL door while that hold is live is left pending (the request path
 *      never waits — residual R3); the SAME run, once its fence is released,
 *      drains the queue — so the record leaves the live table without a
 *      publish run or an operator, which on a quiet install never come.
 *
 * THE MariaDB ROW LEG (PUB-05, audit 2026-09-26) — a live publication table
 * losing its row. It was a `test.skip` stating that the suite owned no marked
 * MariaDB target. It owns one now: the zzd1 element's plan is COMPILED, a row
 * for a runtime-created test3 record is published through the engine's writer
 * into the zzd situation's target on the lane's suite server (acquired in
 * `beforeAll` through `requireSuiteMariadb`), and the REAL record-delete door,
 * with the REAL executor the server registers at boot, must remove exactly that
 * row — a sibling row survives — and ledger both elements unpublished.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from 'bun:test';
import * as nodeFs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { readEnv } from '../../src/config/env.ts';
import { insertMatrixRecordWithCounter } from '../../src/core/db/matrix_write.ts';
import {
	isInTransaction,
	runDetachedFromTransaction,
	sql,
	withTransaction,
} from '../../src/core/db/postgres.ts';
import { registerAllReconciles } from '../../src/core/reconcile/catalog.ts';
import { runReconcile } from '../../src/core/reconcile/registry.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { compileElementPlan } from '../../src/diffusion/plan/compile.ts';
import type { PublicationPlan } from '../../src/diffusion/plan/types.ts';
import { buildVirtualDiffusionTree } from '../../src/diffusion/plan/virtual_tree.ts';
import { closeAllTargetPools, getTargetPool } from '../../src/diffusion/targets/mariadb/db.ts';
import { executeSqlDeleteTargets } from '../../src/diffusion/targets/mariadb/delete_record.ts';
import { overrideMediaIndexBaseForTests } from '../../src/diffusion/targets/mediastore/media_index.ts';
import { mariadbSqlWriter } from '../../src/diffusion/writers/mariadb_sql.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { ensureDiffusionScratchTables } from '../helpers/diffusion_scratch_tables.ts';
import { requireSuiteMariadb } from '../helpers/suite_mariadb.ts';
import {
	countZzdOntology,
	dropZzdOntology,
	SQL_ELEMENT_ONE,
	SQL_KEY_ONE,
	SQL_KEY_TWO,
	SQL_SECTION,
	seedZzdOntology,
	TERMINAL_KEYS,
	TERMINAL_SECTION,
	zzdTargetDatabases,
} from '../helpers/zzd_diffusion_fixture.ts';

// The dd1758 seam: a table PRIVATE to this file (the guard accepts the prefix;
// the pin is handed back in afterAll so it cannot bleed into later files).
const SCRATCH_ACTIVITY_TABLE = 'dedalo_ts_test_zzd_debt';
const PRELOAD_ACTIVITY_TABLE = process.env.DIFFUSION_ACTIVITY_TABLE;
process.env.DIFFUSION_ACTIVITY_TABLE = SCRATCH_ACTIVITY_TABLE;

import {
	activityTable,
	DIFFUSION_ACTION,
	deleteDiffusionRecord,
	ledgerUnpublishIntent,
	RETRY_STAMP_KEY,
	registerNativeDiffusionSqlDelete,
	resetNativeDiffusionSqlDeleteForTests,
	retryPendingDiffusion,
	settleUnpublishIntent,
} from '../../src/core/diffusion_bridge/diffusion_delete.ts';
import { getSectionDiffusionTargets } from '../../src/core/diffusion_bridge/diffusion_map.ts';

/** This file's scratch record ids (a sub-band of the fixture's 932000-932999). */
const ID_TERMINAL = 932500;
const ID_STARVER = 932501;
const ID_NEWER = 932502;
const ID_THROW = 932503;
const USER_ID = 77;
const TABLE = 'matrix_test';

interface LedgerRow {
	section_id: number;
	target_id: string | null;
	element_id: string | null;
	action: number | null;
	misc: Record<string, unknown> | null;
}

/** dd1758 rows of one processed record, oldest first. */
async function rowsFor(sectionTipo: string, sectionId: number): Promise<LedgerRow[]> {
	return (await sql.unsafe(
		`SELECT section_id,
		        relation->'dd1763'->0->>'section_id' AS target_id,
		        relation->'dd1766'->0->>'section_id' AS element_id,
		        (relation->'dd1767'->0->>'diffusion_action')::int AS action,
		        misc
		 FROM "${SCRATCH_ACTIVITY_TABLE}"
		 WHERE section_tipo = 'dd1758'
		   AND relation->'dd1763'->0->>'section_tipo' = $1
		   AND relation->'dd1763'->0->>'section_id' = $2
		 ORDER BY section_id ASC`,
		[sectionTipo, String(sectionId)],
	)) as LedgerRow[];
}

function stampOf(
	row: LedgerRow,
): { attempts?: number; last_attempt?: string | null; terminal?: string } | null {
	const misc = (typeof row.misc === 'string' ? JSON.parse(row.misc) : row.misc) ?? {};
	return (misc as Record<string, never>)[RETRY_STAMP_KEY] ?? null;
}

async function purgeScratchRows(): Promise<void> {
	await sql.unsafe(
		`DELETE FROM "${SCRATCH_ACTIVITY_TABLE}"
		 WHERE section_tipo = 'dd1758' AND (relation->'dd1763'->0->>'section_id') ~ '^9325[0-9]{2}$'`,
	);
}

/** The executor that confirms every target (the healthy MariaDB posture). */
const confirmAll = async (targets: { database_name: string; table_name: string }[]) => ({
	deleted: targets.map((target) => `${target.database_name}|${target.table_name}`),
	errors: [],
});

function mediaRoot(): string {
	const root = config.media.rootPath;
	if (root === null) throw new Error('suite media root not configured');
	return root;
}

/** Scratch test3 records this file created through the REAL doors (swept). */
const scratchRecords: number[] = [];
/**
 * The publication markers (`.publication/pub/<key>`) the MariaDB writer put in
 * the REAL suite media store for the record and its sibling — swept in afterAll.
 * A sibling is never a matrix record here, so scratchRecords cannot carry it.
 */
const scratchMarkerKeys: string[] = [];
/** The MariaDB table the ROW leg published into (dropped in afterAll). */
let publishedTable: { database: string; table: string } | null = null;

describe.if(DB_READY)('unpublish debt — removed from the public tier, or REPORTED (P1-12)', () => {
	beforeAll(async () => {
		await requireSuiteMariadb(import.meta.path, zzdTargetDatabases());
		expect(activityTable()).toBe(SCRATCH_ACTIVITY_TABLE);
		await ensureDiffusionScratchTables(); // builds the private seam table
		const { preCount } = await seedZzdOntology();
		expect(preCount).toBe(0);
		await registerAllReconciles();
	}, 120_000);

	beforeEach(async () => {
		await purgeScratchRows();
	});

	afterEach(() => {
		resetNativeDiffusionSqlDeleteForTests();
	});

	afterAll(async () => {
		resetNativeDiffusionSqlDeleteForTests();
		await purgeScratchRows();
		for (const id of scratchRecords.splice(0)) {
			await sql.unsafe(`DELETE FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`, [
				SQL_SECTION,
				id,
			]);
			await sql.unsafe(
				'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
				[SQL_SECTION, id],
			);
			await sql.unsafe(
				`DELETE FROM "${SCRATCH_ACTIVITY_TABLE}" WHERE section_tipo = 'dd1758'
				   AND relation->'dd1763'->0->>'section_tipo' = $1 AND relation->'dd1763'->0->>'section_id' = $2`,
				[SQL_SECTION, String(id)],
			);
		}
		for (const key of scratchMarkerKeys.splice(0)) {
			rmSync(join(mediaRoot(), '.publication', 'pub', key), { force: true });
		}
		rmSync(join(mediaRoot(), '.publication', 'dbs', 'zzd_probe_db'), {
			recursive: true,
			force: true,
		});
		if (publishedTable !== null) {
			await getTargetPool(publishedTable.database)
				.unsafe(`DROP TABLE IF EXISTS \`${publishedTable.table}\``, [])
				.catch(() => {});
		}
		await closeAllTargetPools();
		await dropZzdOntology();
		expect(await countZzdOntology()).toBe(0);
		if (PRELOAD_ACTIVITY_TABLE === undefined) delete process.env.DIFFUSION_ACTIVITY_TABLE;
		else process.env.DIFFUSION_ACTIVITY_TABLE = PRELOAD_ACTIVITY_TABLE;
	}, 120_000);

	// ------------------------------------------------------------- law 1

	test('TERMINAL census is TOTAL: every target of the terminal section is ledgered with a reason and EXCLUDED from the retry queue', async () => {
		// The census: EVERY target the fixture declares for the section — not a
		// hand list of the three producers — must come out terminal. A fourth
		// producer added to the fixture, or one that regressed to pending, reds it.
		const targets = await getSectionDiffusionTargets(TERMINAL_SECTION);
		expect(targets.length).toBeGreaterThanOrEqual(3);
		const expectedKeys = [...TERMINAL_KEYS].sort();

		registerNativeDiffusionSqlDelete(confirmAll); // an executor that WOULD confirm — never consulted
		const outcome = await deleteDiffusionRecord(TERMINAL_SECTION, ID_TERMINAL, true, USER_ID);

		expect(outcome.deleted).toEqual([]);
		expect(outcome.pending).toEqual([]);
		expect(outcome.terminal.map((entry) => entry.key).sort()).toEqual(expectedKeys);
		// three DISTINCT producers, three distinct reasons — none is a generic text
		const reasons = new Set(outcome.terminal.map((entry) => entry.reason));
		expect(reasons.size).toBe(outcome.terminal.length);
		for (const entry of outcome.terminal) expect(entry.reason.length).toBeGreaterThan(20);

		// Ledgered: one pending row per element, each born with its terminal stamp.
		const rows = await rowsFor(TERMINAL_SECTION, ID_TERMINAL);
		expect(rows.length).toBe(targets.length);
		for (const row of rows) {
			expect(row.action).toBe(DIFFUSION_ACTION.unpublishPending);
			const stamp = stampOf(row);
			expect(typeof stamp?.terminal).toBe('string');
			expect(stamp?.attempts).toBe(0);
		}

		// EXCLUDED: the retry queue does not select them — total 0, and the
		// executor (which would confirm anything) is never asked.
		let calls = 0;
		registerNativeDiffusionSqlDelete(async (batch) => {
			calls++;
			return confirmAll(batch);
		});
		expect(await retryPendingDiffusion(100)).toEqual({ total: 0, retried: 0, remaining: 0 });
		expect(calls).toBe(0);
		// …and they are still there, still pending, still stamped: reported, not lost.
		const after = await rowsFor(TERMINAL_SECTION, ID_TERMINAL);
		expect(after.map((row) => row.action)).toEqual(rows.map(() => 3));
	});

	// ------------------------------------------------------------- law 2

	test('FAIRNESS two-row probe: a permanently failing older row does not starve a newer settleable one', async () => {
		// Row A (older): both sql elements of SQL_SECTION fail — an outage.
		registerNativeDiffusionSqlDelete(async () => ({ deleted: [], errors: ['zzd outage'] }));
		const older = await deleteDiffusionRecord(SQL_SECTION, ID_STARVER, true, USER_ID);
		expect(older.pending.sort()).toEqual([SQL_KEY_ONE, SQL_KEY_TWO].sort());
		// Row B (newer): the same outage at delete time.
		const newer = await deleteDiffusionRecord(SQL_SECTION, ID_NEWER, true, USER_ID);
		expect(newer.pending.length).toBe(2);
		const olderRows = await rowsFor(SQL_SECTION, ID_STARVER);
		const newerRows = await rowsFor(SQL_SECTION, ID_NEWER);
		expect(olderRows.length).toBe(2);
		expect(newerRows.length).toBe(2);
		for (const row of [...olderRows, ...newerRows]) expect(stampOf(row)).toBeNull();

		// The link comes back — but ONLY for the newer record; the older one's
		// targets keep failing forever (the never-resolving head of the queue).
		const attempted: number[] = [];
		registerNativeDiffusionSqlDelete(async (targets) => {
			const ids = targets.flatMap((target) => target.section_ids.map(Number));
			attempted.push(...ids);
			return ids.includes(ID_NEWER) ? confirmAll(targets) : { deleted: [], errors: ['still down'] };
		});

		// Run 1, limit 1: the OLDEST unattempted row — the starver — is tried and stamped.
		expect(await retryPendingDiffusion(1)).toEqual({ total: 1, retried: 0, remaining: 1 });
		expect(attempted).toEqual([ID_STARVER]);
		const stampedOlder = await rowsFor(SQL_SECTION, ID_STARVER);
		const firstStamp = stampOf(stampedOlder[0] as LedgerRow);
		expect(firstStamp?.attempts).toBe(1);
		expect(typeof firstStamp?.last_attempt).toBe('string');
		expect(firstStamp?.terminal).toBeUndefined(); // transient, NOT terminal

		// Runs 2-4, limit 1: the window moves PAST the attempted row each time —
		// the starver's second row, then the newer record's two rows, which settle.
		// Before the fix (ORDER BY section_id ASC) every run re-selected the same
		// starver row and the newer record never left the public tier.
		expect(await retryPendingDiffusion(1)).toEqual({ total: 1, retried: 0, remaining: 1 });
		expect(await retryPendingDiffusion(1)).toEqual({ total: 1, retried: 1, remaining: 0 });
		expect(await retryPendingDiffusion(1)).toEqual({ total: 1, retried: 1, remaining: 0 });
		expect(attempted).toEqual([ID_STARVER, ID_STARVER, ID_NEWER, ID_NEWER]);
		expect((await rowsFor(SQL_SECTION, ID_NEWER)).map((row) => row.action)).toEqual([2, 2]);
		expect((await rowsFor(SQL_SECTION, ID_STARVER)).map((row) => row.action)).toEqual([3, 3]);
		// Run 5: the queue wraps round to the starver again (least recently attempted) — reported, never dropped.
		expect(await retryPendingDiffusion(1)).toEqual({ total: 1, retried: 0, remaining: 1 });
		expect(attempted.at(-1)).toBe(ID_STARVER);
		expect(stampOf((await rowsFor(SQL_SECTION, ID_STARVER))[0] as LedgerRow)?.attempts).toBe(2);
	});

	// ------------------------------------------------------------- law 3

	test('DURABLE INTENT: target resolution that THROWS inside the delete transaction still leaves a pending row after the commit', async () => {
		// The generic throw case the audit named: the intent is written INSIDE the
		// transaction from a resolver that throws — a record-level row (no
		// element) survives the commit, so the debt is on the ledger before any
		// post-commit step can fail or the process can die.
		const intent = await withTransaction(async () =>
			ledgerUnpublishIntent(SQL_SECTION, ID_THROW, USER_ID, async () => {
				throw new Error('zzd resolver outage');
			}),
		);
		expect(intent.rows.length).toBe(1);
		expect(intent.rows[0]?.elementTipo).toBeNull();
		const rows = await rowsFor(SQL_SECTION, ID_THROW);
		expect(rows.length).toBe(1);
		expect(rows[0]?.action).toBe(DIFFUSION_ACTION.unpublishPending);
		expect(rows[0]?.element_id).toBeNull(); // record-level: the retry runs it unrestricted

		// The settle half: a record-level row runs the WHOLE record and flips
		// only when EVERY element confirmed (the AND law applied to the row —
		// one confirmed sibling must not flip a row that still owes another).
		registerNativeDiffusionSqlDelete(async (targets) => ({
			deleted: targets
				.map((target) => `${target.database_name}|${target.table_name}`)
				.filter((key) => key === SQL_KEY_ONE),
			errors: ['second target down'],
		}));
		expect(await settleUnpublishIntent(intent)).toEqual({ settled: 0, pending: 1 });
		expect((await rowsFor(SQL_SECTION, ID_THROW))[0]?.action).toBe(3);
		expect(stampOf((await rowsFor(SQL_SECTION, ID_THROW))[0] as LedgerRow)?.attempts).toBe(1);
		registerNativeDiffusionSqlDelete(confirmAll);
		expect(await settleUnpublishIntent(intent)).toEqual({ settled: 1, pending: 0 });
		expect((await rowsFor(SQL_SECTION, ID_THROW))[0]?.action).toBe(DIFFUSION_ACTION.unpublished);
	});

	test('DURABLE INTENT through the REAL delete door: an executor outage leaves one pending row per element — never zero', async () => {
		// A real record, created through the allocator, deleted through the
		// section delete (transaction + post-commit settle). The executor is
		// down for the whole delete: the record is GONE from the matrix and the
		// public tier is OWED two unpublishes — both on the ledger.
		const sectionId = await insertMatrixRecordWithCounter(TABLE, SQL_SECTION, {
			data: { label: 'zzd unpublish-debt scratch', section_tipo: SQL_SECTION },
		});
		scratchRecords.push(sectionId);
		registerNativeDiffusionSqlDelete(async () => {
			throw new Error('zzd executor down during the delete');
		});
		const deleted = await deleteSectionRecord(SQL_SECTION, sectionId, USER_ID);
		expect(deleted.removed).toBe(true);
		const gone = (await sql.unsafe(
			`SELECT 1 FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
			[SQL_SECTION, sectionId],
		)) as unknown[];
		expect(gone.length).toBe(0);

		const rows = await rowsFor(SQL_SECTION, sectionId);
		expect(rows.length).toBe(2); // one per sql element of the section
		expect(rows.map((row) => row.action)).toEqual([3, 3]);
		expect(rows.map((row) => row.element_id).sort()).toEqual(['1', '4']); // zzd1, zzd4
		for (const row of rows) expect(stampOf(row)?.attempts).toBe(1); // settled once, failed, stamped

		// ------------------------------------------------------------- law 4
		// THE REPORTER RUNS: the registry door reports this debt, and a seeded
		// ghost marker (the LIFE-02 shape: the tier grants media access to a
		// record the matrix no longer holds).
		const ghostDir = join(mediaRoot(), '.publication', 'dbs', 'zzd_probe_db', 'zzd_probe_table');
		mkdirSync(ghostDir, { recursive: true });
		const ghost = join(ghostDir, `${SQL_SECTION}_${sectionId}`);
		writeFileSync(ghost, '');
		try {
			const { report } = await runReconcile('public_tier', { apply: false, scope: [SQL_SECTION] });
			const detail = report.detail as {
				ghosts: { store: string; section_tipo: string; section_id: number; reason: string }[];
				pending_debt: number;
				unreachable: string[];
			};
			expect(detail.pending_debt).toBeGreaterThanOrEqual(2);
			const reported = detail.ghosts.filter(
				(entry) => entry.section_tipo === SQL_SECTION && entry.section_id === sectionId,
			);
			expect(reported.map((entry) => entry.store)).toContain('marker');
			expect(reported[0]?.reason).toBe('record_absent');
			expect(report.drift).toBeGreaterThanOrEqual(1);
			expect(report.applied).toBe(0);
			expect(existsSync(ghost)).toBe(true); // a dry run writes nothing
			expect(Array.isArray(detail.unreachable)).toBe(true); // an unreachable target is REPORTED, never silent

			// APPLY removes the ghost — and only ghosts (MISSING stays a report).
			const applied = await runReconcile('public_tier', { apply: true, scope: [SQL_SECTION] });
			expect(applied.report.applied).toBeGreaterThanOrEqual(1);
			expect(existsSync(ghost)).toBe(false);
		} finally {
			rmSync(ghost, { force: true });
		}
	}, 60_000);

	test('MariaDB ROW leg: the real delete door, with the real executor, removes the published row from the live table — and only it', async () => {
		// The zzd1 element's plan, COMPILED from the situation (not typed): its
		// target database and table are the fixture's first sql target.
		const tree = await buildVirtualDiffusionTree(readEnv('DEDALO_DIFFUSION_DOMAIN'));
		if (tree === null) throw new Error('the zzd domain did not resolve after seed');
		const plan: PublicationPlan = await compileElementPlan(SQL_ELEMENT_ONE, { tree });
		if (plan.target.kind !== 'table')
			throw new Error(`${SQL_ELEMENT_ONE} compiled to ${plan.target.kind}`);
		const section = plan.sections.find((entry) => entry.sectionTipo === SQL_SECTION);
		if (section === undefined)
			throw new Error(`the ${SQL_ELEMENT_ONE} plan has no ${SQL_SECTION} section`);
		const database = plan.target.database;
		expect(`${database}|${section.tableName}`).toBe(SQL_KEY_ONE);
		expect(zzdTargetDatabases()).toContain(database);
		publishedTable = { database, table: section.tableName };

		// A runtime-created record, published: its row, and a SIBLING row the
		// delete must not touch.
		const sectionId = await insertMatrixRecordWithCounter(TABLE, SQL_SECTION, {
			data: { label: 'zzd unpublish-debt row leg', section_tipo: SQL_SECTION },
		});
		scratchRecords.push(sectionId);
		const sibling = sectionId + 1;
		const pool = getTargetPool(database);
		await pool.unsafe(`DROP TABLE IF EXISTS \`${section.tableName}\``, []);
		const session = await mariadbSqlWriter.open(plan);
		await session.ensureSchema();
		expect(
			await session.writeRows(section, [
				{ sectionId, lang: 'lg-eng', columns: {} },
				{ sectionId: sibling, lang: 'lg-eng', columns: {} },
			]),
		).toEqual({ written: 2, deleted: 0 });
		await session.close();
		const idsIn = async () =>
			(
				(await pool.unsafe(
					`SELECT section_id FROM \`${section.tableName}\` ORDER BY section_id`,
					[],
				)) as { section_id: number }[]
			).map((row) => Number(row.section_id));
		expect(await idsIn()).toEqual([sectionId, sibling]);
		scratchMarkerKeys.push(`${SQL_SECTION}_${sectionId}`, `${SQL_SECTION}_${sibling}`);

		// THE REAL DOOR with THE REAL EXECUTOR (what src/server.ts registers at boot).
		registerNativeDiffusionSqlDelete(executeSqlDeleteTargets);
		const deleted = await deleteSectionRecord(SQL_SECTION, sectionId, USER_ID);
		expect(deleted.removed).toBe(true);

		// The row is gone from the live table; the sibling is not.
		expect(await idsIn()).toEqual([sibling]);
		// Both elements settled: the second target's table was never created, which
		// the executor confirms as an idempotent no-op (errno 1146).
		const rows = await rowsFor(SQL_SECTION, sectionId);
		expect(rows.map((row) => row.element_id).sort()).toEqual(['1', '4']); // zzd1, zzd4
		expect(rows.map((row) => row.action)).toEqual([
			DIFFUSION_ACTION.unpublished,
			DIFFUSION_ACTION.unpublished,
		]);
	}, 60_000);

	// ------------------------------------------------------------- law 5

	test('LAW 5: a record deleted while the media_index apply holds its target is unpublished by THAT run — no publish run, no operator', async () => {
		const tree = await buildVirtualDiffusionTree(readEnv('DEDALO_DIFFUSION_DOMAIN'));
		if (tree === null) throw new Error('the zzd domain did not resolve after seed');
		const plan: PublicationPlan = await compileElementPlan(SQL_ELEMENT_ONE, { tree });
		if (plan.target.kind !== 'table')
			throw new Error(`${SQL_ELEMENT_ONE} compiled to ${plan.target.kind}`);
		const section = plan.sections.find((entry) => entry.sectionTipo === SQL_SECTION);
		if (section === undefined)
			throw new Error(`the ${SQL_ELEMENT_ONE} plan has no ${SQL_SECTION} section`);
		const database = plan.target.database;
		publishedTable = { database, table: section.tableName };

		// A published record (and a sibling the delete must not touch).
		const sectionId = await insertMatrixRecordWithCounter(TABLE, SQL_SECTION, {
			data: { label: 'zzd unpublish-debt media_index hold leg', section_tipo: SQL_SECTION },
		});
		scratchRecords.push(sectionId);
		const sibling = sectionId + 1;
		const pool = getTargetPool(database);
		await pool.unsafe(`DROP TABLE IF EXISTS \`${section.tableName}\``, []);
		const session = await mariadbSqlWriter.open(plan);
		await session.ensureSchema();
		await session.writeRows(section, [
			{ sectionId, lang: 'lg-eng', columns: {} },
			{ sectionId: sibling, lang: 'lg-eng', columns: {} },
		]);
		await session.close();
		const idsIn = async () =>
			(
				(await pool.unsafe(
					`SELECT section_id FROM \`${section.tableName}\` ORDER BY section_id`,
					[],
				)) as { section_id: number }[]
			).map((row) => Number(row.section_id));
		expect(await idsIn()).toEqual([sectionId, sibling]);
		scratchMarkerKeys.push(`${SQL_SECTION}_${sectionId}`, `${SQL_SECTION}_${sibling}`);
		registerNativeDiffusionSqlDelete(executeSqlDeleteTargets);

		// A scratch marker store with real drift IN THIS DATABASE (the sibling's
		// truth marker, no pub/ marker): the apply must fence `sql:<database>`.
		const base = mkdtempSync(join(tmpdir(), 'dedalo_unpublish_debt_media_index_'));
		const truth = join(base, 'dbs', database, section.tableName, `${SQL_SECTION}_${sibling}`);
		mkdirSync(join(truth, '..'), { recursive: true });
		writeFileSync(truth, '');
		overrideMediaIndexBaseForTests(base);

		// THE DELETE LANDS INSIDE THE HOLD: at the fenced diff's pub/ read (inside the
		// fence unit's transaction), the REAL record-delete door runs as a request.
		const realReaddir = nodeFs.promises.readdir;
		let heldOff: LedgerRow[] | null = null;
		const readdirSpy = spyOn(nodeFs.promises, 'readdir').mockImplementation((async (
			dir: nodeFs.PathLike,
			...rest: unknown[]
		) => {
			if (heldOff === null && String(dir) === join(base, 'pub') && isInTransaction()) {
				heldOff = await runDetachedFromTransaction(async () => {
					const deleted = await deleteSectionRecord(SQL_SECTION, sectionId, USER_ID);
					expect(deleted.removed).toBe(true);
					return rowsFor(SQL_SECTION, sectionId);
				});
			}
			return (realReaddir as (...args: unknown[]) => Promise<unknown>)(dir, ...rest);
		}) as typeof nodeFs.promises.readdir);
		let report: Awaited<ReturnType<typeof runReconcile>>['report'];
		try {
			// The registry door — the scheduler's own path for a scheduled run.
			({ report } = await runReconcile('media_index', { apply: true }));
		} finally {
			readdirSpy.mockRestore();
			overrideMediaIndexBaseForTests(null);
			rmSync(base, { recursive: true, force: true });
		}

		// Non-vacuous: the delete ran inside the hold, and the hold left it owed.
		const during = heldOff as LedgerRow[] | null;
		expect(during, 'the delete never ran inside the fence — the leg proves nothing').not.toBeNull();
		const zzd1 = (during as LedgerRow[]).find((row) => row.element_id === '1');
		expect(
			zzd1?.action,
			'the request-path delete was not held off by the fence — the leg proves nothing',
		).toBe(DIFFUSION_ACTION.unpublishPending);
		expect(report.deferred).toBeUndefined();
		expect(report.applied).toBe(1);

		// THE OUTCOME: the record left the live table, the debt is settled.
		expect(
			await idsIn(),
			'the record deleted during the media_index hold is still on the public tier — nothing drains the debt that hold left on a quiet install',
		).toEqual([sibling]);
		const rows = await rowsFor(SQL_SECTION, sectionId);
		expect(rows.map((row) => row.action)).toEqual([
			DIFFUSION_ACTION.unpublished,
			DIFFUSION_ACTION.unpublished,
		]);
		expect(JSON.stringify(report.detail.pending_unpublish)).toContain('pending unpublish queue');
	}, 60_000);
});
