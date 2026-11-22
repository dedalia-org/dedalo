/**
 * tool_update_cache — the NON-MEDIA re-save is a LOCKED read-modify-write
 * (WC-2026-10-21-update-cache-locked-resave; dedalo-ts-write-path §3).
 *
 * The regenerate of a literal re-saves "the current value". The value it
 * re-saves must be the one stored UNDER THE ROW LOCK the write takes, never the
 * run's per-row snapshot: a cataloguer's edit committed after the snapshot (the
 * sweep may spend minutes on a media rebuild of the same row first) would
 * otherwise be replaced by the pre-edit bytes, silently.
 *
 * OUTCOME, measured with a REAL concurrent writer (no seam): a second
 * transaction holds the row's FOR UPDATE lock; the sweep starts, takes its
 * snapshot (an unlocked read passes a row lock), and blocks on the row; the
 * holder then commits a new value — or deletes the record — and releases.
 *   L1 the committed edit SURVIVES the sweep (the re-save re-reads it), and the
 *      sweep writes no undo-log pair for it (re-saving the stored value is a no-op);
 *   L2 a record deleted while the sweep waited is NOT recreated, and is counted
 *      `vanished` (nothing written);
 *   L3 a row held past the per-record lock-wait bound is that record's `locked`
 *      (nothing written) — the sweep's wait is bounded, never the holder's whim.
 *
 * SITUATION: runtime-created `test3` playground records (generic `test` TLD),
 * `test52` (translatable component_input_text). Records, TM rows, activity rows
 * and the dd800 runs are swept. assertTestDatabase first.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { perRecordLockWaitMs } from '../../src/core/media/tools/files_info_persist.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { mustGet } from '../helpers/assert.ts';

const SECTION = 'test3';
const TEXT = 'test52'; // component_input_text, translatable
const USER_ID = -1;

const records: number[] = [];
const bulkIds: number[] = [];
let table = '';
let bulkTable = '';

async function newRecord(): Promise<number> {
	const id = await createSectionRecord(SECTION, USER_ID);
	records.push(id);
	return id;
}

async function seed(id: number, value: unknown): Promise<void> {
	await sql.unsafe(
		`UPDATE "${table}" SET string = COALESCE(string, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
		  WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, id, TEXT, JSON.stringify(value)],
	);
}

async function stored(id: number): Promise<unknown> {
	const rows = (await sql.unsafe(
		`SELECT string->$3 AS v FROM "${table}" WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, id, TEXT],
	)) as { v: unknown }[];
	return rows.length === 0 ? 'NO-RECORD' : (rows[0]?.v ?? null);
}

async function runRowCount(id: number, bulk: number): Promise<number> {
	const [row] = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id = $2 AND bulk_process_id = $3`,
		[SECTION, id, bulk],
	)) as { n: number }[];
	return Number(row?.n ?? 0);
}

/** Wait until some backend is blocked BY `holderPid` (the sweep, queued on the row lock). */
async function waitUntilBlockedBy(holderPid: number): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const [row] = (await sql.unsafe(
			'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))',
			[holderPid],
		)) as { n: number }[];
		if (Number(row?.n ?? 0) > 0) return;
		await Bun.sleep(25);
	}
	throw new Error(`no backend ever queued behind the row-lock holder (pid ${holderPid})`);
}

interface SweepResult {
	bulk_process_id: number;
	regenerated: number;
	vanished: number;
	locked: number;
	errors: string[];
}

async function runSweep(id: number, tipo: string = TEXT): Promise<SweepResult> {
	const loaded = await getLoadedTool('tool_update_cache');
	const handler = mustGet(loaded?.module.apiActions.update_cache, 'update_cache').handler;
	const response = await handler({
		principal: await resolvePrincipal(USER_ID),
		userId: USER_ID,
		background: false,
		options: {
			section_tipo: SECTION,
			components_selection: [{ tipo }],
			sqo: {
				section_tipo: [SECTION],
				filter_by_locators: [{ section_tipo: SECTION, section_id: String(id) }],
			},
		},
	});
	const data = response.data as SweepResult;
	bulkIds.push(Number(data.bulk_process_id));
	return data;
}

/**
 * Run the sweep while another transaction holds the row lock; once the sweep is
 * queued behind it, `whileHeld` runs IN the holder's transaction, which then commits.
 */
async function sweepAgainstConcurrentWriter(
	id: number,
	whileHeld: () => Promise<void>,
): Promise<SweepResult> {
	let signalLocked: (pid: number) => void = () => {};
	const locked = new Promise<number>((resolve) => {
		signalLocked = resolve;
	});
	let releaseHolder: () => void = () => {};
	const queued = new Promise<void>((resolve) => {
		releaseHolder = resolve;
	});
	const holder = withTransaction(async () => {
		const [me] = (await sql.unsafe('SELECT pg_backend_pid()::int AS pid', [])) as {
			pid: number;
		}[];
		await sql.unsafe(
			`SELECT 1 FROM "${table}" WHERE section_tipo = $1 AND section_id = $2 FOR UPDATE`,
			[SECTION, id],
		);
		signalLocked(Number(me?.pid));
		await queued;
		await whileHeld();
	});
	const holderPid = await locked;
	// Started OUTSIDE the holder's transaction context: the sweep is another session.
	const sweep = runSweep(id);
	try {
		await waitUntilBlockedBy(holderPid);
	} finally {
		releaseHolder();
	}
	await holder;
	return await sweep;
}

beforeAll(async () => {
	await assertTestDatabase('update_cache_locked_resave_native');
	table = mustGet(await getMatrixTableFromTipo(SECTION), 'test3 table');
	bulkTable = mustGet(await getMatrixTableFromTipo('dd800'), 'dd800 table');
}, 60_000);

afterAll(async () => {
	for (const id of records) {
		await sql.unsafe(`DELETE FROM "${table}" WHERE section_tipo = $1 AND section_id = $2`, [
			SECTION,
			id,
		]);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[SECTION, id],
		);
		await sql.unsafe(
			`DELETE FROM matrix_activity WHERE data->>'section_tipo' = $1 AND data->>'section_id' = $2`,
			[SECTION, String(id)],
		);
	}
	for (const id of bulkIds) {
		await sql.unsafe(
			`DELETE FROM "${bulkTable}" WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
	}
});

describe('update_cache re-saves the value stored under the row lock, never its snapshot', () => {
	test('L1 an edit committed while the sweep waited SURVIVES it (no lost update, no undo pair)', async () => {
		const id = await newRecord();
		await seed(id, [{ id: 1, lang: 'lg-spa', value: 'before the edit' }]);
		const edited = [{ id: 1, lang: 'lg-spa', value: 'the cataloguer edit' }];
		const result = await sweepAgainstConcurrentWriter(id, () => seed(id, edited));
		expect(await stored(id)).toEqual(edited);
		expect(await runRowCount(id, result.bulk_process_id)).toBe(0);
		// FLOOR: the sweep really re-saved the row (an empty `errors` of a sweep that
		// processed nothing would prove nothing).
		expect(result.regenerated).toBeGreaterThan(0);
		expect(result.errors).toEqual([]);
	}, 90_000);

	test('L2 a record deleted while the sweep waited is NOT recreated and counts `vanished`', async () => {
		const id = await newRecord();
		await seed(id, [{ id: 1, lang: 'lg-spa', value: 'about to be deleted' }]);
		const result = await sweepAgainstConcurrentWriter(id, async () => {
			await sql.unsafe(`DELETE FROM "${table}" WHERE section_tipo = $1 AND section_id = $2`, [
				SECTION,
				id,
			]);
		});
		expect(await stored(id)).toBe('NO-RECORD');
		expect(result.vanished).toBe(1);
		expect(result.regenerated).toBe(0);
	}, 90_000);

	test('L3 a row held past the per-record lock-wait bound is `locked`, nothing written', async () => {
		const id = await newRecord();
		// No item id: a re-save WOULD change the value (stamps one) — so "nothing
		// written" is measured, not a no-op in disguise.
		const seeded = [{ lang: 'lg-spa', value: 'held' }];
		await seed(id, seeded);
		const result = await sweepAgainstConcurrentWriter(id, () =>
			Bun.sleep(perRecordLockWaitMs() + 2_000),
		);
		expect(result.locked).toBe(1);
		expect(result.regenerated).toBe(0);
		expect(await stored(id)).toEqual(seeded);
		expect(await runRowCount(id, result.bulk_process_id)).toBe(0);
	}, 90_000);
});

// --- T2-LIF-1/2: the model's regenerate facet, applied UNDER THE LOCK ----------

const TEXT_AREA = 'test17'; // component_text_area (string column)
const JSON_TIPO = 'test18'; // component_json (misc column)

async function seedKey(id: number, column: string, tipo: string, value: unknown): Promise<void> {
	await sql.unsafe(
		`UPDATE "${table}" SET "${column}" = COALESCE("${column}", '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
		  WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, id, tipo, JSON.stringify(value)],
	);
}

async function storedKey(id: number, column: string, tipo: string): Promise<unknown> {
	const rows = (await sql.unsafe(
		`SELECT "${column}"->$3 AS v FROM "${table}" WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, id, tipo],
	)) as { v: unknown }[];
	return rows[0]?.v ?? null;
}

describe('T2-LIF-1/2: update_cache applies the model regenerate facet under the row lock', () => {
	test('text_area: an old [TC_00:00:01_TC] is stored as [TC_00:00:01.000_TC] (one undo pair)', async () => {
		const id = await newRecord();
		await seedKey(id, 'string', TEXT_AREA, [
			{ id: 1, lang: 'lg-spa', value: '<p>[TC_00:00:01_TC] hola</p>' },
		]);
		const result = await runSweep(id, TEXT_AREA);
		expect(result.errors).toEqual([]);
		expect(result.regenerated).toBe(1);
		const items = (await storedKey(id, 'string', TEXT_AREA)) as { value?: string }[];
		expect(items[0]?.value).toContain('[TC_00:00:01.000_TC]');
		expect(items[0]?.value).not.toContain('[TC_00:00:01_TC]');
		expect(await runRowCount(id, result.bulk_process_id)).toBeGreaterThan(0);
	}, 90_000);

	test('json: {value:\'{"a":1}\'} is stored DECODED as {value:{a:1}}', async () => {
		const id = await newRecord();
		await seedKey(id, 'misc', JSON_TIPO, [{ id: 1, lang: 'lg-nolan', value: '{"a":1}' }]);
		const result = await runSweep(id, JSON_TIPO);
		expect(result.errors).toEqual([]);
		expect(result.regenerated).toBe(1);
		const items = (await storedKey(id, 'misc', JSON_TIPO)) as { value?: unknown }[];
		expect(items[0]?.value).toEqual({ a: 1 });
	}, 90_000);

	test('json: a string that is not JSON REFUSES that record — reported, stored value untouched, no undo pair', async () => {
		const id = await newRecord();
		const seeded = [{ id: 1, lang: 'lg-nolan', value: '{not json' }];
		await seedKey(id, 'misc', JSON_TIPO, seeded);
		const result = await runSweep(id, JSON_TIPO);
		expect(result.regenerated).toBe(0);
		expect(result.errors.some((line) => line.includes(`#${id}`) && line.includes('not JSON'))).toBe(
			true,
		);
		expect(await storedKey(id, 'misc', JSON_TIPO)).toEqual(seeded);
		expect(await runRowCount(id, result.bulk_process_id)).toBe(0);
	}, 90_000);

	test('a text_area with nothing to normalise writes NOTHING (no undo pair)', async () => {
		const id = await newRecord();
		const first = await runSweep(id, TEXT_AREA).catch(() => null); // empty record: nothing stored → nothing to regenerate
		expect(first?.regenerated ?? 0).toBe(0);
		await seedKey(id, 'string', TEXT_AREA, [
			{ id: 1, lang: 'lg-spa', value: '<p>[TC_00:00:01.000_TC] already current</p>' },
		]);
		const before = await storedKey(id, 'string', TEXT_AREA);
		const result = await runSweep(id, TEXT_AREA);
		expect(result.errors).toEqual([]);
		expect(await storedKey(id, 'string', TEXT_AREA)).toEqual(before);
		expect(await runRowCount(id, result.bulk_process_id)).toBe(0);
	}, 90_000);
});

describe('T2-OX7-1a: the run label is resolved in the REQUEST application lang', () => {
	test('a sweep under lg-spa labels its dd800 run with the lg-spa section term (not the install default, not a client `lang`)', async () => {
		const id = await newRecord();
		await seed(id, [{ id: 1, lang: 'lg-spa', value: 'label lang probe' }]);
		const result = await runWithRequestLangs(
			{ applicationLang: 'lg-spa', dataLang: 'lg-spa' },
			() => runSweep(id),
		);
		const rows = (await sql.unsafe(
			`SELECT string->'dd796' AS v FROM "${bulkTable}" WHERE section_tipo = 'dd800' AND section_id = $1`,
			[result.bulk_process_id],
		)) as { v: { value?: string }[] | null }[];
		const label = rows[0]?.v?.[0]?.value ?? '';
		expect(label).toContain('Unit Test Section');
		expect(label).not.toContain('Test Unit (data on matrix_test)');
	}, 90_000);
});
