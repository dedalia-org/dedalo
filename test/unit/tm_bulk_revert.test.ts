/**
 * R5 gate: tool_time_machine.bulk_revert_process.
 *
 * The module registers both actions. (The row-per-row `preBulkState` unit
 * cases left with the function, 2026-09-27: the legacy inference is per KEY
 * now — bulk_revert_legacy.ts, pinned by bulk_revert_undo_native.)
 *
 * Plus (2026-07-28) the DB DRIVE — the ledgered gap: a seeded two-record batch
 * is reverted for real and the live matrix values, the fresh bulk-tagged TM
 * rows and the per-row authorization skip are asserted against the database.
 * The seeded batch is a LEGACY run (visible rows only, no undo-log BEFORE), so
 * the drive pins the §2.6 inference path of WC-2026-09-27-bulk-revert-undo-log:
 * reverted and reported per KEY, every write `inexact`, the revert's own writes
 * an exact undo-log pair. The exact path is bulk_revert_undo_native's.
 *
 * Plus the SKIP CHANNEL's disclosure law (SEC-16,
 * WC-2026-09-03-bulk-revert-skipped-typed-entries): `data.skipped[]` is typed
 * entries, and a row's
 * coordinates ride one ONLY once the row passed the scope gate — a denied row
 * is counted, never located; a throw from before the gate (planted through
 * `getModelByTipo`, carrying a path-shaped sentinel) yields a `failed` entry
 * with neither coordinates nor the exception text; a throw from AFTER it
 * (planted at `getMatrixTableFromTipo`) yields EXACTLY `{reason:'failed',
 * section_tipo, tipo, section_id}` — located, still wordless; and the positive
 * control, an in-scope row with no pre-batch state, DOES carry its coordinates.
 * DB tier: seeds matrix_time_machine batches + scratch records on the suite
 * database and mocks record_scope / the resolver.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rules). The DB
// drive's component became the phase-2 clone of the install component it used
// (a component_input_text, so the `string` column the revert reads back is
// unchanged). The section carrier was already the generic `test2`, whose test24
// matrix_table relation puts every record in `matrix_test` — which is why
// `liveValues()` reads that table and not `matrix`.

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import * as realResolver from '../../src/core/ontology/resolver.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import * as realRecordScope from '../../src/core/security/record_scope.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { ToolActionContext, ToolResponse } from '../../src/core/tools/module.ts';
import {
	type BulkRevertSkipped,
	toolTimeMachineBulkRevert,
} from '../../tools/tool_time_machine/server/bulk_revert.ts';
import { mustGet } from '../helpers/assert.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { cleanScratchRecord, createScratchRecord } from '../helpers/test_data.ts';

const REAL_RECORD_SCOPE = { ...realRecordScope };
const REAL_RESOLVER = { ...realResolver };

describe('tool_time_machine module', () => {
	test('registers apply_value + bulk_revert_process with the right gates', async () => {
		const loaded = await getLoadedTool('tool_time_machine');
		expect(loaded).not.toBeNull();
		const actions = loaded!.module.apiActions;
		expect(Object.keys(actions).sort()).toEqual(['apply_value', 'bulk_revert_process']);
		const bulkRevert = mustGet(actions.bulk_revert_process, 'bulk_revert_process');
		expect(bulkRevert.permission).toBe('section');
		expect(bulkRevert.minLevel).toBe(2);
	});
});

/* ------------------------------------------------------------------ DB drive */

const SECTION_TIPO = 'test2';
const COMPONENT_TIPO = 'testmint1002'; // component_input_text (string column)
const LANG = 'lg-spa';
const IDS = [905201, 905202];
/** A third record whose WHOLE history belongs to the batch: no pre-batch state. */
const NO_PRE_ID = 905203;
const BATCH_BULK_ID = 9905201; // synthetic bulk id — no dd800 record needed to READ it
const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };

const mintedBulkIds: number[] = [];

const contextOf = (options: Record<string, unknown>, principal = SUPERUSER): ToolActionContext =>
	({ principal, userId: -1, options, background: false }) as ToolActionContext;

async function insertTm(
	sectionId: number,
	value: string,
	bulkProcessId: number | null,
	stamp: string,
): Promise<void> {
	await sql.unsafe(
		`INSERT INTO matrix_time_machine
			(section_id, section_tipo, tipo, lang, timestamp, user_id, bulk_process_id, data)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text::jsonb)`,
		[
			sectionId,
			SECTION_TIPO,
			COMPONENT_TIPO,
			LANG,
			stamp,
			-1,
			bulkProcessId,
			JSON.stringify([{ id: 1, lang: LANG, value }]),
		],
	);
}

async function liveValues(): Promise<Record<number, unknown>> {
	const rows = (await sql.unsafe(
		`SELECT section_id, string->'${COMPONENT_TIPO}' AS items FROM matrix_test
		 WHERE section_tipo = $1 AND section_id IN (${IDS.join(',')})`,
		[SECTION_TIPO],
	)) as { section_id: number; items: unknown }[];
	const out: Record<number, unknown> = {};
	for (const row of rows) out[Number(row.section_id)] = row.items;
	return out;
}

describe('bulk_revert_process — DB drive', () => {
	beforeAll(async () => {
		for (const id of IDS) {
			// Live value = what the batch wrote.
			await createScratchRecord(SECTION_TIPO, id, {
				string: { [COMPONENT_TIPO]: [{ id: 1, lang: LANG, value: `BATCH-${id}` }] },
			});
			// History, oldest first: the pre-batch value, then the batch write.
			await insertTm(id, `PRE-${id}`, null, '2026-01-01 00:00:00');
			await insertTm(id, `BATCH-${id}`, BATCH_BULK_ID, '2026-01-02 00:00:00');
		}
		// The positive control: two batch rows and NOTHING older (the legacy
		// inference finds no pre-run row) — skipped with coordinates, never written.
		await createScratchRecord(SECTION_TIPO, NO_PRE_ID, {
			string: { [COMPONENT_TIPO]: [{ id: 1, lang: LANG, value: `BATCH-${NO_PRE_ID}` }] },
		});
		await insertTm(NO_PRE_ID, `BATCH-A-${NO_PRE_ID}`, BATCH_BULK_ID, '2026-01-02 00:00:00');
		await insertTm(NO_PRE_ID, `BATCH-B-${NO_PRE_ID}`, BATCH_BULK_ID, '2026-01-02 00:00:01');
	});
	/**
	 * The batch is a LEGACY run (visible rows, no undo-log BEFORE — the shape
	 * every pre-2026-09-27 run left), reverted per KEY, never per row
	 * (WC-2026-09-27-bulk-revert-undo-log §2.5 step 3): one key per record —
	 * the control record's two rows are ONE key, reported once.
	 */
	const BATCH_KEYS = IDS.length + 1;

	afterAll(async () => {
		mock.module('../../src/core/security/record_scope.ts', () => REAL_RECORD_SCOPE);
		mock.module('../../src/core/ontology/resolver.ts', () => REAL_RESOLVER);
		for (const id of [...IDS, NO_PRE_ID]) await cleanScratchRecord(SECTION_TIPO, id);
		for (const bulkId of mintedBulkIds) {
			await sql`DELETE FROM matrix_notes WHERE section_tipo = 'dd800' AND section_id = ${bulkId}`;
		}
	});

	test('an unknown bulk_process_id is a loud not_found, never a silent success', async () => {
		const refusal = await refusalOf(
			toolTimeMachineBulkRevert(
				contextOf({ section_tipo: SECTION_TIPO, bulk_process_id: 987654321 }),
			),
		);
		expect(refusal.code).toBe('tool.target_not_found');
	});

	test('a missing/invalid bulk_process_id is refused', async () => {
		for (const bad of [{}, { bulk_process_id: 0 }, { bulk_process_id: 'x' }]) {
			const refusal = await refusalOf(
				toolTimeMachineBulkRevert(contextOf({ section_tipo: SECTION_TIPO, ...bad })),
			);
			expect(refusal.code).toBe('request.invalid_options');
		}
	});

	test('an out-of-scope record is SKIPPED with an error, never reverted (SEC-024 §9.4)', async () => {
		// The TM batch search applies no projects filter, so the per-row record
		// gate is the only thing standing between a bulk id and another tenant's
		// records. Deny it and assert nothing moved.
		mock.module('../../src/core/security/record_scope.ts', () => ({
			...REAL_RECORD_SCOPE,
			principalCanAccessRecord: async () => false,
		}));
		try {
			const before = await liveValues();
			const response = await toolTimeMachineBulkRevert(
				contextOf({ section_tipo: SECTION_TIPO, bulk_process_id: BATCH_BULK_ID }),
			);
			const batch = response.data as {
				counter: number;
				bulk_process_id: number;
				skipped: BulkRevertSkipped[];
			};
			mintedBulkIds.push(batch.bulk_process_id);
			expect(batch.counter).toBe(0);
			// The per-row refusals are PAYLOAD (`data.skipped`), never the
			// envelope's failure channel — the batch itself did not fail.
			expect(batch.skipped.length).toBe(BATCH_KEYS);
			// SEC-16: a denied row is COUNTED, never LOCATED. The batch row set
			// comes from a TM search with no projects filter and the bulk id is a
			// small integer: the coordinates of records outside the caller's
			// scope are exactly what this channel used to echo.
			for (const entry of batch.skipped) expect(entry).toEqual({ reason: 'out_of_scope' });
			const wire = JSON.stringify(response);
			for (const id of [...IDS, NO_PRE_ID]) expect(wire).not.toContain(String(id));
			expect(wire).not.toContain(COMPONENT_TIPO);
			expect(wire).not.toContain(`"${SECTION_TIPO}"`);
			expect(await liveValues()).toEqual(before);
		} finally {
			mock.module('../../src/core/security/record_scope.ts', () => REAL_RECORD_SCOPE);
		}
	});

	test('a throw from INSIDE the scope gate is a `failed` entry and nothing else: no coordinates, no code, no exception text', async () => {
		// The unit's record verdict itself throws: no verdict over the record has
		// passed, so the entry is the reason alone (owner ruling 2026-11-18, TM Q3)
		// — neither which record nor why.
		const sentinel = 'SENTINEL-/srv/secret/relation "matrix_private" does not exist';
		let thrown = 0;
		mock.module('../../src/core/security/record_scope.ts', () => ({
			...REAL_RECORD_SCOPE,
			principalCanAccessRecord: async () => {
				thrown += 1;
				throw new Error(sentinel);
			},
		}));
		const quiet = console.error;
		console.error = () => {};
		try {
			const before = await liveValues();
			const response = await toolTimeMachineBulkRevert(
				contextOf({ section_tipo: SECTION_TIPO, bulk_process_id: BATCH_BULK_ID }),
			);
			const batch = response.data as {
				counter: number;
				bulk_process_id: number;
				skipped: BulkRevertSkipped[];
			};
			mintedBulkIds.push(batch.bulk_process_id);
			expect(batch.counter).toBe(0);
			expect(batch.skipped.length).toBe(BATCH_KEYS);
			expect(thrown).toBeGreaterThanOrEqual(BATCH_KEYS);
			for (const entry of batch.skipped) expect(entry).toEqual({ reason: 'failed' });
			const wire = JSON.stringify(response);
			expect(wire).not.toContain('SENTINEL-');
			expect(wire).not.toContain('internal.');
			for (const id of [...IDS, NO_PRE_ID]) expect(wire).not.toContain(String(id));
			expect(await liveValues()).toEqual(before);
		} finally {
			console.error = quiet;
			mock.module('../../src/core/security/record_scope.ts', () => REAL_RECORD_SCOPE);
		}
	});

	test('a throw from BEFORE the scope gate is a `failed` entry with neither coordinates, nor a code, nor the exception text', async () => {
		// getModelByTipo runs first in the loop, ahead of the gate: a throw there
		// must locate nothing (the row may be another tenant's) and must not
		// carry what threw (Postgres/fs text — here a path-shaped sentinel).
		const sentinel = 'SENTINEL-/srv/secret/relation "matrix_private" does not exist';
		mock.module('../../src/core/ontology/resolver.ts', () => ({
			...REAL_RESOLVER,
			getModelByTipo: async (tipo: string) => {
				if (tipo === COMPONENT_TIPO) throw new Error(sentinel);
				return REAL_RESOLVER.getModelByTipo(tipo);
			},
		}));
		const quiet = console.error;
		console.error = () => {};
		try {
			const before = await liveValues();
			const response = await toolTimeMachineBulkRevert(
				contextOf({ section_tipo: SECTION_TIPO, bulk_process_id: BATCH_BULK_ID }),
			);
			const batch = response.data as {
				counter: number;
				bulk_process_id: number;
				skipped: BulkRevertSkipped[];
			};
			mintedBulkIds.push(batch.bulk_process_id);
			expect(batch.counter).toBe(0);
			expect(batch.skipped.length).toBe(BATCH_KEYS);
			// The plan runs before any scope gate: no verdict has passed, so the entry
			// is the reason ALONE — no coordinates and no code (owner ruling
			// 2026-11-18, TM Q3: the code rides only after the verdict passed).
			for (const entry of batch.skipped) expect(entry).toEqual({ reason: 'failed' });
			const wire = JSON.stringify(response);
			expect(wire).not.toContain('internal.');
			expect(wire).not.toContain('SENTINEL-');
			expect(wire).not.toContain('/srv/secret');
			for (const id of [...IDS, NO_PRE_ID]) expect(wire).not.toContain(String(id));
			expect(await liveValues()).toEqual(before);
		} finally {
			console.error = quiet;
			mock.module('../../src/core/ontology/resolver.ts', () => REAL_RESOLVER);
		}
	});

	test('a throw from AFTER the scope gate is a `failed` entry WITH coordinates and STILL without the exception text', async () => {
		// The other half of the law: an in-scope row that fails (Postgres/fs text
		// from persistRecordKeys, the transaction, the frame restore…) is located
		// — it is the caller's to see — and STILL carries nothing of what threw.
		// Planted at `getMatrixTableFromTipo`, which runs after both gate halves
		// and after the legacy inference (so the no-pre-state control keeps its own
		// reason); the entry is asserted EXACTLY, so a `detail` smuggled onto it
		// through skip()'s log parameter is a red, not a limit.
		const sentinel = 'SENTINEL-/srv/secret/relation "matrix_private" does not exist';
		mock.module('../../src/core/ontology/resolver.ts', () => ({
			...REAL_RESOLVER,
			getMatrixTableFromTipo: async (tipo: string) => {
				if (tipo === SECTION_TIPO) throw new Error(sentinel);
				return REAL_RESOLVER.getMatrixTableFromTipo(tipo);
			},
		}));
		const quiet = console.error;
		console.error = () => {};
		try {
			const before = await liveValues();
			const response = await toolTimeMachineBulkRevert(
				contextOf({ section_tipo: SECTION_TIPO, bulk_process_id: BATCH_BULK_ID }),
			);
			const batch = response.data as {
				counter: number;
				bulk_process_id: number;
				skipped: BulkRevertSkipped[];
			};
			mintedBulkIds.push(batch.bulk_process_id);
			expect(batch.counter).toBe(0);
			expect(batch.skipped.length).toBe(BATCH_KEYS);
			// Every key resolves its storage (the planted throw) before anything
			// else behind the gate, so the control record fails here too.
			const failed = batch.skipped.filter((entry) => entry.reason === 'failed');
			expect(failed.length).toBe(BATCH_KEYS);
			for (const id of [...IDS, NO_PRE_ID]) {
				const entry = failed.find((candidate) => candidate.section_id === id);
				expect(entry).toStrictEqual({
					reason: 'failed',
					section_tipo: SECTION_TIPO,
					tipo: COMPONENT_TIPO,
					section_id: id,
					lang: LANG,
					// the converter's code of the planted UNTYPED throw — a code, never its words
					code: 'internal.unexpected',
				});
			}
			const wire = JSON.stringify(response);
			expect(wire).not.toContain('SENTINEL-');
			expect(wire).not.toContain('/srv/secret');
			expect(wire).not.toContain('matrix_private');
			expect(await liveValues()).toEqual(before);
		} finally {
			console.error = quiet;
			mock.module('../../src/core/ontology/resolver.ts', () => REAL_RESOLVER);
		}
	});

	test('reverts every component of the batch to its pre-batch value under a NEW bulk id', async () => {
		const response: ToolResponse = await toolTimeMachineBulkRevert(
			contextOf({
				section_tipo: SECTION_TIPO,
				bulk_process_id: BATCH_BULK_ID,
				bulk_revert_process_label: 'gate revert',
			}),
		);
		expect(response.ok).toBe(true);
		const batch = response.data as {
			counter: number;
			bulk_process_id: number | null;
			exact: string;
			skipped: BulkRevertSkipped[];
			inexact: { basis: string; section_id: number }[];
		};
		expect(batch.counter).toBe(IDS.length);
		// A legacy key's pre-run value is INFERRED: every write is reported
		// inexact, and nothing was reverted exactly.
		expect(batch.exact).toBe('none');
		expect(batch.inexact.map((entry) => [entry.basis, entry.section_id]).sort()).toEqual(
			IDS.map((id) => ['legacy_inference', id]),
		);
		const newBulkId = batch.bulk_process_id;
		if (typeof newBulkId === 'number') mintedBulkIds.push(newBulkId);
		// POSITIVE CONTROL for the disclosure law: an IN-SCOPE row that could not
		// be reverted DOES carry its coordinates — the omission above is the
		// gate's doing, not a channel that never locates anything. (One entry
		// per KEY: the control record's two batch rows are one key.)
		const located: BulkRevertSkipped = {
			reason: 'no_pre_batch_state',
			section_tipo: SECTION_TIPO,
			tipo: COMPONENT_TIPO,
			section_id: NO_PRE_ID,
			lang: LANG,
		};
		expect(batch.skipped).toEqual([located]);

		const values = await liveValues();
		for (const id of IDS) {
			expect(values[id]).toEqual([{ id: 1, lang: LANG, value: `PRE-${id}` }]);
		}

		// The revert is itself revertible — EXACTLY, though the run it undid was
		// legacy: one undo-log pair per component (hidden BEFORE = the batch
		// value it replaced, visible after = the restored value), all carrying
		// the NEW bulk id (never the reverted one).
		const fresh = (await sql.unsafe(
			`SELECT section_id, tm_role, data FROM matrix_time_machine
			 WHERE section_tipo = $1 AND tipo = $2 AND section_id IN (${IDS.join(',')})
			   AND bulk_process_id IS NOT DISTINCT FROM $3
			 ORDER BY section_id, id`,
			[SECTION_TIPO, COMPONENT_TIPO, newBulkId],
		)) as { section_id: number; tm_role: number | null; data: unknown }[];
		expect(fresh.length).toBe(IDS.length * 2);
		for (const id of IDS) {
			const own = fresh.filter((row) => Number(row.section_id) === id);
			expect(own.map((row) => row.tm_role)).toEqual([1, null]);
			expect(own[0]?.data).toEqual([{ id: 1, lang: LANG, value: `BATCH-${id}` }]);
			expect(own[1]?.data).toEqual([{ id: 1, lang: LANG, value: `PRE-${id}` }]);
		}
	});
});
