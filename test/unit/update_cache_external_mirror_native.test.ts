/**
 * tool_update_cache RECOMPUTES an external portal by its law — it never
 * re-saves the stored mirror (T1-38 / OX3, OX7;
 * WC-2026-11-12-update-cache-external-mirror-refresh).
 *
 * PHP component_portal::regenerate_component (frozen v7 and v6 alike): a
 * component whose `properties.source.mode === 'external'` regenerates through
 * `set_data_external({save:true})` — the mirror is DERIVED, so "regenerate"
 * means "recompute from the data it mirrors". The TS sweep used to re-save the
 * STORED value: a stale mirror stayed stale (a canonical no-op), an absent slot
 * was `empty`, and the run still answered "OK, regenerated N" — a false success.
 *
 * Driven through the real update_cache handler (filter_by_locators sqo), each
 * mirror first made STALE by a RAW source write (no propagation), so only the
 * sweep can fix it:
 *   E1 a source_overwrite mirror (testcoincatalog1019 ← test6105 via the
 *      testcoincatalog1004 pointer) is recomputed: one TM row, counted
 *      `regenerated` + `external_refreshed`;
 *   E2 an ABSENT mirror slot is computed (the re-save answered `empty`);
 *   E3 law (c) (test6157, component_to_search test6230): a referencer added
 *      RAW is appended;
 *   E4 the ALIAS door: sweeping a component_alias of test6157 (the `zzucx`
 *      scratch situation — the suite's own aliases of it, test6271/test6406,
 *      still carry a retired v5 key) refreshes the TARGET's slot and never
 *      stores the alias key; a broken alias (test6271) refuses the run BEFORE
 *      anything is written — no dd800 record, no row touched;
 *   E5 a REFUSED law (testimmovable1000, mode external with no
 *      component_to_search): the stored slot is untouched, reported
 *      `external_withheld` + an error line naming `law_refused`, never counted
 *      `regenerated`;
 *   E6 a second sweep over a fresh mirror writes nothing (no-drift);
 *   E7 a row held FOR UPDATE past the per-record bound is that record's
 *      `locked` — nothing written, the mirror stays stale;
 *   E8 a record whose section does not HOST the observer: withheld
 *      `target_not_host`, no slot born;
 *   E9 a record deleted while the sweep waited on its lock: `vanished`,
 *      nothing written, the record is not recreated;
 *   E10 attribution (owner decision D1 open, default (a)): the refresh write
 *      carries no `bulk_process_id` — the mirror is a calculation (owner
 *      ruling 2026-10-30, no origin tag on a refresh).
 *
 * SITUATION: repo-owned `test`/`testcoincatalog`/`testimmovable` nodes (the
 * suite ontology) plus the `zzucx` scratch situation (one section holding one
 * alias, dropped after with its residue asserted); every record created at runtime and swept in afterAll
 * (records, TM rows, activity rows, the dd800 runs). assertTestDatabase first.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { perRecordLockWaitMs } from '../../src/core/media/tools/files_info_persist.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { countActivityRows, sweepActivityRows } from '../helpers/activity_rows.ts';
import { mustGet } from '../helpers/assert.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const USER_ID = -1;

/** source_overwrite: the catalog term, its pointer, the mirror, the type and its source bag. */
const TERM_SECTION = 'testcoincatalog1';
const POINTER = 'testcoincatalog1004';
const MIRROR = 'testcoincatalog1019';
const TYPE_SECTION = 'test6099';
const TYPE_ORDERED = 'test6105';
const ORDERED_SECTION = 'test6310';

/** law (c): the coins-of-a-type mirror on the type, its referencing component, its alias. */
const TYPE_COINS = 'test6157';
const COIN_SECTION = 'test6100';
const COIN_TYPE = 'test6230';
/** A suite alias of test6157 that still carries a retired v5 key (WC-020 refuses it). */
const BROKEN_ALIAS = 'test6271';

/** The scratch alias of test6157 (a valid v7 alias node). */
const ALIAS_TLD = 'zzucx';
const TYPE_COINS_ALIAS = `${ALIAS_TLD}2`;
const aliasSituation = situation({
	tld: ALIAS_TLD,
	name: 'update_cache_external_alias',
	nodes: [
		{ tipo: `${ALIAS_TLD}1`, parent: 'test1', model: 'section', term: { 'lg-eng': 'Alias host' } },
		{
			tipo: TYPE_COINS_ALIAS,
			parent: `${ALIAS_TLD}1`,
			model: 'component_alias',
			term: { 'lg-eng': 'Coins of the type (alias)' },
			properties: { alias_of: TYPE_COINS },
		},
	],
});

/** A mode-external node whose law is REFUSED (no component_to_search). */
const IMMOVABLE_SECTION = 'testimmovable1';
const REFUSED_MIRROR = 'testimmovable1000';

type Item = Record<string, unknown>;

const created: { sectionTipo: string; sectionId: number }[] = [];
const runs: number[] = [];
const tables = new Map<string, string>();

async function tableOf(sectionTipo: string): Promise<string> {
	const known = tables.get(sectionTipo);
	if (known !== undefined) return known;
	const table = mustGet(await getMatrixTableFromTipo(sectionTipo), `${sectionTipo} table`);
	tables.set(sectionTipo, table);
	return table;
}

async function born(sectionTipo: string): Promise<number> {
	const sectionId = await createSectionRecord(sectionTipo, USER_ID);
	created.push({ sectionTipo, sectionId });
	return sectionId;
}

const locator = (from: string, sectionTipo: string, sectionId: number) => ({
	type: 'dd151',
	section_tipo: sectionTipo,
	section_id: sectionId,
	from_component_tipo: from,
});

/** The stored relation key, or the string 'ABSENT' when the key is not there. */
async function relationKey(
	sectionTipo: string,
	sectionId: number,
	key: string,
): Promise<Item[] | 'ABSENT'> {
	const rows = (await sql.unsafe(
		`SELECT relation ? $3 AS has, relation->$3 AS value FROM "${await tableOf(sectionTipo)}" WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId, key],
	)) as { has: boolean | null; value: unknown }[];
	if (rows[0]?.has !== true) return 'ABSENT';
	const value = rows[0]?.value;
	return Array.isArray(value) ? (value as Item[]) : [];
}

const ids = (items: Item[] | 'ABSENT'): number[] | 'ABSENT' =>
	items === 'ABSENT' ? items : items.map((item) => Number(item.section_id));

/** Store one relation key RAW — no door, no propagation (makes a mirror stale). */
async function storeRelationKey(
	sectionTipo: string,
	sectionId: number,
	key: string,
	value: unknown[],
): Promise<void> {
	await assertTestDatabase('update_cache_external_mirror_native.storeRelationKey');
	await sql.unsafe(
		`UPDATE "${await tableOf(sectionTipo)}" SET relation = jsonb_set(COALESCE(relation, '{}'::jsonb), ARRAY[$3::text], $4::text::jsonb)
		 WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId, key, JSON.stringify(value)],
	);
}

/** Drop one relation key RAW (an absent mirror slot). */
async function dropRelationKey(sectionTipo: string, sectionId: number, key: string): Promise<void> {
	await assertTestDatabase('update_cache_external_mirror_native.dropRelationKey');
	await sql.unsafe(
		`UPDATE "${await tableOf(sectionTipo)}" SET relation = relation - $3::text WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId, key],
	);
}

/** Every TM row of one (section, record, tipo), with its bulk id. */
async function tmRows(
	sectionTipo: string,
	sectionId: number,
	tipo: string,
): Promise<{ bulk_process_id: number | null }[]> {
	return (await sql.unsafe(
		'SELECT bulk_process_id FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 ORDER BY id',
		[sectionTipo, sectionId, tipo],
	)) as { bulk_process_id: number | null }[];
}

interface SweepResult {
	bulk_process_id: number;
	records: number;
	regenerated: number;
	vanished: number;
	locked: number;
	refused: number;
	external_refreshed?: number;
	external_withheld?: number;
	errors: string[];
	summary: string;
}

async function sweep(sectionTipo: string, sectionId: number, tipo: string): Promise<SweepResult> {
	const loaded = await getLoadedTool('tool_update_cache');
	const handler = mustGet(loaded?.module.apiActions.update_cache, 'update_cache').handler;
	const response = await handler({
		principal: await resolvePrincipal(USER_ID),
		userId: USER_ID,
		background: false,
		options: {
			section_tipo: sectionTipo,
			components_selection: [{ tipo }],
			sqo: {
				section_tipo: [sectionTipo],
				filter_by_locators: [{ section_tipo: sectionTipo, section_id: String(sectionId) }],
			},
		},
	});
	const data = response.data as SweepResult;
	runs.push(Number(data.bulk_process_id));
	return data;
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

/**
 * Sweep the term while another transaction holds its row FOR UPDATE; once the
 * sweep is queued behind it, `whileHeld` runs IN the holder's transaction.
 */
async function sweepAgainstHolder(
	sectionId: number,
	whileHeld: () => Promise<void>,
): Promise<SweepResult> {
	const table = await tableOf(TERM_SECTION);
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
			[TERM_SECTION, sectionId],
		);
		signalLocked(Number(me?.pid));
		await queued;
		await whileHeld();
	});
	const holderPid = await locked;
	const run = sweep(TERM_SECTION, sectionId, MIRROR);
	try {
		await waitUntilBlockedBy(holderPid);
	} finally {
		releaseHolder();
	}
	await holder;
	return await run;
}

let typeA = 0;
const ordered: number[] = [];

/** The type's ordered coins, stored RAW: every term pointing at it goes stale. */
async function setSourceRaw(count: number): Promise<number[]> {
	const chosen = ordered.slice(0, count);
	await storeRelationKey(
		TYPE_SECTION,
		typeA,
		TYPE_ORDERED,
		chosen.map((id, at) => ({ id: at + 1, ...locator(TYPE_ORDERED, ORDERED_SECTION, id) })),
	);
	return chosen;
}

/** A catalog term whose pointer names typeA — the pointer saved through the door. */
async function bornTerm(): Promise<number> {
	const term = await born(TERM_SECTION);
	const saved = await saveComponentData({
		componentTipo: POINTER,
		sectionTipo: TERM_SECTION,
		sectionId: term,
		lang: 'lg-nolan',
		changedData: [
			{ action: 'set_data', id: null, value: [locator(POINTER, TYPE_SECTION, typeA)] },
		] as never,
		userId: USER_ID,
	});
	expect(saved.ok, saved.message).toBe(true);
	return term;
}

beforeAll(async () => {
	await assertTestDatabase('update_cache_external_mirror_native');
	await ensureSituation(aliasSituation);
	typeA = await born(TYPE_SECTION);
	for (let n = 0; n < 4; n++) ordered.push(await born(ORDERED_SECTION));
	await setSourceRaw(1);
}, 120_000);

afterAll(async () => {
	for (const { sectionTipo, sectionId } of [...created].reverse()) {
		await cleanScratchRecord(sectionTipo, sectionId, await tableOf(sectionTipo));
	}
	for (const id of runs) await cleanScratchRecord('dd800', id, await tableOf('dd800'));
	const activityIds = new Map<string, number[]>([['dd800', [...runs]]]);
	for (const { sectionTipo, sectionId } of created) {
		activityIds.set(sectionTipo, [...(activityIds.get(sectionTipo) ?? []), sectionId]);
	}
	for (const [sectionTipo, list] of activityIds) {
		await sweepActivityRows(sectionTipo, list);
		expect(await countActivityRows(sectionTipo, list), `${sectionTipo} activity residue`).toBe(0);
	}
	expect(await dropSituation(aliasSituation)).toBe(0);
}, 120_000);

describe('update_cache recomputes an external mirror by its law', () => {
	test('E1 a stale source_overwrite mirror is recomputed (one TM row, counted)', async () => {
		const term = await bornTerm();
		expect(ids(await relationKey(TERM_SECTION, term, MIRROR)), 'FLOOR: born fresh').toEqual([
			ordered[0] as number,
		]);
		const want = await setSourceRaw(3);
		expect(ids(await relationKey(TERM_SECTION, term, MIRROR)), 'FLOOR: stale').not.toEqual(want);
		const before = (await tmRows(TERM_SECTION, term, MIRROR)).length;
		const result = await sweep(TERM_SECTION, term, MIRROR);
		// FLOOR: the run really processed the row (an empty `errors` of a sweep
		// that matched nothing would prove nothing).
		expect(result.records, 'FLOOR: the sqo matched the term').toBeGreaterThan(0);
		expect(result.errors).toEqual([]);
		expect(ids(await relationKey(TERM_SECTION, term, MIRROR))).toEqual(want);
		expect((await tmRows(TERM_SECTION, term, MIRROR)).length).toBe(before + 1);
		expect(result.regenerated).toBe(1);
		expect(result.external_refreshed).toBe(1);
		expect(result.external_withheld).toBe(0);

		// E6 — converged: a second sweep writes nothing.
		const settled = await tmRows(TERM_SECTION, term, MIRROR);
		const again = await sweep(TERM_SECTION, term, MIRROR);
		expect(again.errors).toEqual([]);
		expect(again.regenerated).toBe(1);
		expect(await tmRows(TERM_SECTION, term, MIRROR)).toEqual(settled);

		// E10 — attribution (D1 default (a)): no refresh row carries a run's bulk id.
		const bulkIds = (await tmRows(TERM_SECTION, term, MIRROR)).map((row) => row.bulk_process_id);
		expect(bulkIds.filter((id) => id !== null && runs.includes(Number(id)))).toEqual([]);
	}, 120_000);

	test('E2 an ABSENT mirror slot is computed', async () => {
		await setSourceRaw(2);
		const term = await bornTerm();
		await dropRelationKey(TERM_SECTION, term, MIRROR);
		expect(await relationKey(TERM_SECTION, term, MIRROR), 'FLOOR: absent').toBe('ABSENT');
		const result = await sweep(TERM_SECTION, term, MIRROR);
		expect(result.errors).toEqual([]);
		expect(ids(await relationKey(TERM_SECTION, term, MIRROR))).toEqual(ordered.slice(0, 2));
		expect(result.external_refreshed).toBe(1);
	}, 120_000);

	test('E3 law (c): a referencer added RAW is appended', async () => {
		const coin = await born(COIN_SECTION);
		await storeRelationKey(COIN_SECTION, coin, COIN_TYPE, [
			{ id: 1, ...locator(COIN_TYPE, TYPE_SECTION, typeA) },
		]);
		const stale = ids(await relationKey(TYPE_SECTION, typeA, TYPE_COINS));
		expect(
			stale === 'ABSENT' ? [] : stale,
			'FLOOR: the raw referencer did not propagate',
		).not.toContain(coin);
		const result = await sweep(TYPE_SECTION, typeA, TYPE_COINS);
		expect(result.errors).toEqual([]);
		expect(ids(await relationKey(TYPE_SECTION, typeA, TYPE_COINS))).toContain(coin);
		expect(result.external_refreshed).toBe(1);
	}, 120_000);

	test('E4 the alias door refreshes the TARGET slot, never an alias key', async () => {
		const coin = await born(COIN_SECTION);
		await storeRelationKey(COIN_SECTION, coin, COIN_TYPE, [
			{ id: 1, ...locator(COIN_TYPE, TYPE_SECTION, typeA) },
		]);
		const result = await sweep(TYPE_SECTION, typeA, TYPE_COINS_ALIAS);
		expect(result.errors).toEqual([]);
		expect(ids(await relationKey(TYPE_SECTION, typeA, TYPE_COINS))).toContain(coin);
		expect(await relationKey(TYPE_SECTION, typeA, TYPE_COINS_ALIAS)).toBe('ABSENT');
		expect(result.external_refreshed).toBe(1);
	}, 120_000);

	test('E4b a broken alias refuses the run before anything is written', async () => {
		const [before] = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM "${await tableOf('dd800')}" WHERE section_tipo = 'dd800'`,
			[],
		)) as { n: number }[];
		await expect(sweep(TYPE_SECTION, typeA, BROKEN_ALIAS)).rejects.toMatchObject({
			code: 'ontology.invalid_node',
		});
		const [after] = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM "${await tableOf('dd800')}" WHERE section_tipo = 'dd800'`,
			[],
		)) as { n: number }[];
		expect(after?.n, 'a dd800 run record was minted for a refused run').toBe(before?.n);
	}, 120_000);

	test('E5 a REFUSED law is reported withheld, the slot untouched, never `regenerated`', async () => {
		const record = await born(IMMOVABLE_SECTION);
		const coin = await born(COIN_SECTION);
		const seeded = [{ id: 1, ...locator(REFUSED_MIRROR, COIN_SECTION, coin) }];
		await storeRelationKey(IMMOVABLE_SECTION, record, REFUSED_MIRROR, seeded);
		const before = (await tmRows(IMMOVABLE_SECTION, record, REFUSED_MIRROR)).length;
		const result = await sweep(IMMOVABLE_SECTION, record, REFUSED_MIRROR);
		expect(await relationKey(IMMOVABLE_SECTION, record, REFUSED_MIRROR)).toEqual(seeded);
		expect((await tmRows(IMMOVABLE_SECTION, record, REFUSED_MIRROR)).length).toBe(before);
		expect(result.regenerated).toBe(0);
		expect(result.external_withheld).toBe(1);
		expect(result.errors).toEqual([
			`${REFUSED_MIRROR}#${record}: external mirror not refreshed (law_refused) — nothing written`,
		]);
	}, 120_000);

	test('E8 a section that does not HOST the observer: withheld target_not_host', async () => {
		const result = await sweep(TYPE_SECTION, typeA, MIRROR);
		expect(await relationKey(TYPE_SECTION, typeA, MIRROR)).toBe('ABSENT');
		expect(result.regenerated).toBe(0);
		expect(result.external_withheld).toBe(1);
		expect(result.errors).toEqual([
			`${MIRROR}#${typeA}: external mirror not refreshed (target_not_host) — nothing written`,
		]);
	}, 120_000);

	test('E7 a row held past the per-record bound is `locked`, nothing written', async () => {
		await setSourceRaw(1);
		const term = await bornTerm();
		await setSourceRaw(4);
		const stale = await relationKey(TERM_SECTION, term, MIRROR);
		const before = (await tmRows(TERM_SECTION, term, MIRROR)).length;
		const result = await sweepAgainstHolder(term, () => Bun.sleep(perRecordLockWaitMs() + 2_000));
		expect(result.locked).toBe(1);
		expect(result.regenerated).toBe(0);
		expect(await relationKey(TERM_SECTION, term, MIRROR)).toEqual(stale);
		expect((await tmRows(TERM_SECTION, term, MIRROR)).length).toBe(before);
	}, 120_000);

	test('E9 a record deleted while the sweep waited: `vanished`, not recreated', async () => {
		await setSourceRaw(1);
		const term = await bornTerm();
		await setSourceRaw(3);
		const table = await tableOf(TERM_SECTION);
		const result = await sweepAgainstHolder(term, async () => {
			await sql.unsafe(`DELETE FROM "${table}" WHERE section_tipo = $1 AND section_id = $2`, [
				TERM_SECTION,
				term,
			]);
		});
		const rows = (await sql.unsafe(
			`SELECT 1 FROM "${table}" WHERE section_tipo = $1 AND section_id = $2`,
			[TERM_SECTION, term],
		)) as unknown[];
		expect(rows.length, 'the record was recreated').toBe(0);
		expect(result.vanished).toBe(1);
		expect(result.regenerated).toBe(0);
		expect(result.errors).toEqual([
			`${MIRROR}#${term}: record deleted during the run — nothing written`,
		]);
	}, 120_000);
});
