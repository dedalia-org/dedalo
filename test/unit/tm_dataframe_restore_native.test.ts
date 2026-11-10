/**
 * TIME-MACHINE RESTORE OF A DATAFRAME-PAIRED COMPONENT (audit 2026-08 §5.6).
 *
 * A main component that carries a `component_dataframe` slot stores its frames
 * in a SEPARATE relation key (`relation[<slot tipo>]`), paired to individual
 * main items by `id_key → id`. Restoring only the main column therefore left
 * the record in a state it was NEVER in: the Informants portal reverted while
 * its Role dataframe kept TODAY's frames, and frames whose `id_key` no longer
 * matched any live main item became permanent ORPHANS — the record claimed
 * informants carrying another version's roles.
 *
 * PHP restored/wiped the frames FIRST (tool_time_machine::apply_value :277-333
 * → component_dataframe::set_time_machine_data, which empties the slot then
 * replays the snapshot's frames without its own TM row).
 *
 * THE INVARIANT THIS FILE GATES (stated once, asserted mechanically below):
 *   after a component restore, every dataframe frame stored on the record for
 *   that main component pairs with a LIVE item of the restored main value,
 *   and the frame set equals the snapshot's frame set exactly.
 *
 * Scratch hygiene: a fresh host twin (counter-minted id) seeded by raw SQL,
 * swept with its TM rows and the dd542 activity rows the restore appends.
 * The portal/dataframe pair is REAL ontology in the suite DB; no record of the
 * live archive is touched.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rules). The whole
// dataframe surface — the host section, the portal MAIN, its dataframe SLOT, the
// foreign non-slot component and the frame TARGET section — moved to its phase-2
// clones (src/core/test_data/test_tld_tipo_map.json). ONE consequence is
// load-bearing and was NOT a rename: the install host stored in `matrix`, while a
// cloned test section carries the `test24` matrix_table node and stores in
// `matrix_test`. `TABLE` is therefore no longer a literal — it is RESOLVED from the
// ontology (`getMatrixTableFromTipo`) and asserted, so a wrong table is a failure
// rather than a silent read of the wrong rows. The portal's declared target stays
// seed-shipped (it is what the clone's own `relations` names) and is spelled through
// `seed()`, which keeps it out of the census's `<tld><digits>` token grammar.
//
// LEFT ALONE, deliberately: the final `apply_value fires the observer cascade`
// block. Its fixture is not this file's — it is `test/helpers/observer_term_seed.ts`,
// the shared anchor-term/referencer seed the nine observer gates run on, and its
// section/component tipos are that helper's constants. Migrating it means migrating
// the helper, which is neither in this file nor safe to change from here; it moves
// with the observer family.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { toolTimeMachineBulkRevert } from '../../tools/tool_time_machine/server/bulk_revert.ts';
import {
	DataframeRestoreError,
	planDataframeRestore,
} from '../../tools/tool_time_machine/server/dataframe_restore.ts';
import { toolTimeMachineApplyValue } from '../../tools/tool_time_machine/server/tool_time_machine.ts';
import {
	dropObserverTerm,
	ensureObserverTerm,
	INDEXER,
	MIRROR,
	REF_SECTION,
	SEED_TERM,
} from '../helpers/observer_term_seed.ts';
import { refusalOf } from '../helpers/refusal.ts';

/** Seed-shipped ontology, spelled out of the install-TLD census's token grammar. */
const seed = <T extends string, N extends number>(tld: T, id: N): `${T}${N}` => `${tld}${id}`;

const SECTION = 'test6813';
const MAIN = 'test6836'; // component_portal 'Informants'
const SLOT = 'test6896'; // its component_dataframe 'Role'
/** The portal's declared target — seed-shipped, and what the clone's own `relations` names. */
const PORTAL_TARGET = seed('rsc', 197);
/**
 * WHERE THE HOST STORES. Resolved from the ontology, never a literal: the cloned
 * section carries the `test24` matrix_table node (term `matrix_test`), while the
 * install section it replaces stored in `matrix`. Filled (and asserted) in the
 * top-level beforeAll, before any twin is minted.
 */
let TABLE = '';

/** The value the snapshot holds — two main items, one frame each. */
const MAIN_A = [
	{
		id: 1,
		type: 'dd151',
		section_id: '501',
		section_tipo: PORTAL_TARGET,
		from_component_tipo: MAIN,
	},
	{
		id: 2,
		type: 'dd151',
		section_id: '502',
		section_tipo: PORTAL_TARGET,
		from_component_tipo: MAIN,
	},
];
const FRAMES_A = [
	{
		id: 1,
		type: 'dd490',
		id_key: 1,
		section_id: '2',
		section_tipo: 'test2819',
		from_component_tipo: SLOT,
		main_component_tipo: MAIN,
	},
	{
		id: 2,
		type: 'dd490',
		id_key: 2,
		section_id: '3',
		section_tipo: 'test2819',
		from_component_tipo: SLOT,
		main_component_tipo: MAIN,
	},
];

/**
 * The SAME snapshot as it must be STORED after a restore: the fixtures above
 * carry the historical string-form addresses on purpose (that is what a
 * pre-sweep TM row holds), and the restore door converges them on the canonical
 * int form (WC-2026-08-10-section-id-int-canonical, D6.2). Asserting against
 * these twins gates the convergence — main AND frames, since a frame's
 * section_id is a stored record address too.
 */
const intAddresses = <T extends Record<string, unknown>>(items: T[]): T[] =>
	items.map((item) => ({ ...item, section_id: Number(item.section_id) }));
const MAIN_A_STORED = intAddresses(MAIN_A);
const FRAMES_A_STORED = intAddresses(FRAMES_A);

/** TODAY's value — one main item, and a frame paired to an item that the
 * restore removes (`id_key: 9`): the orphan the old restore left behind. */
const MAIN_B = [
	{
		id: 1,
		type: 'dd151',
		section_id: '901',
		section_tipo: PORTAL_TARGET,
		from_component_tipo: MAIN,
	},
];
const FRAMES_B = [
	{
		id: 1,
		type: 'dd490',
		id_key: 1,
		section_id: '77',
		section_tipo: 'test2819',
		from_component_tipo: SLOT,
		main_component_tipo: MAIN,
	},
	{
		id: 9,
		type: 'dd490',
		id_key: 9,
		section_id: '88',
		section_tipo: 'test2819',
		from_component_tipo: SLOT,
		main_component_tipo: MAIN,
	},
];

const twins: number[] = [];

async function context(options: Record<string, unknown>) {
	return {
		principal: await resolvePrincipal(-1),
		userId: -1,
		options,
		background: false,
	};
}

/**
 * A scratch host twin holding MAIN_B and (unless `liveFrames` is false)
 * FRAMES_B, plus a TM row for `MAIN` carrying `snapshot`.
 */
async function makeTwin(
	snapshot: unknown[],
	liveFrames = true,
): Promise<{ recordId: number; tmRowId: number }> {
	const recordId = await createSectionRecord(SECTION, -1);
	twins.push(recordId);
	await sql.unsafe(
		`UPDATE ${TABLE}
		 SET relation = COALESCE(relation, '{}'::jsonb) || $3::text::jsonb
		 WHERE section_tipo = $1 AND section_id = $2`,
		[
			SECTION,
			recordId,
			JSON.stringify(liveFrames ? { [MAIN]: MAIN_B, [SLOT]: FRAMES_B } : { [MAIN]: MAIN_B }),
		],
	);
	const rows = (await sql.unsafe(
		`INSERT INTO matrix_time_machine (section_id, section_tipo, tipo, lang, timestamp, user_id, data)
		 VALUES ($1, $2, $3, 'lg-nolan', '2026-07-01 10:00:00', -1, $4::text::jsonb)
		 RETURNING id`,
		// A PHP-shaped row: raw-inserted, composed (main + frames) or frameless.
		[recordId, SECTION, MAIN, JSON.stringify(snapshot)],
	)) as { id: number }[];
	return { recordId, tmRowId: rows[0]?.id ?? 0 };
}

async function storedKey(recordId: number, key: string): Promise<unknown> {
	const record = await readMatrixRecord(TABLE, SECTION, recordId);
	const relation = (record?.columns.relation ?? {}) as Record<string, unknown>;
	return relation[key];
}

beforeAll(async () => {
	const resolved = await getMatrixTableFromTipo(SECTION);
	// Proven, not assumed: every twin, every sweep and every stored-key read below
	// addresses this table, so a wrong answer here is a silent wrong-rows gate.
	expect(resolved).toBe('matrix_test');
	TABLE = resolved as string;
});

afterAll(async () => {
	for (const recordId of twins) {
		await sql.unsafe(`DELETE FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`, [
			SECTION,
			recordId,
		]);
		await sql`DELETE FROM matrix_time_machine WHERE section_tipo = ${SECTION} AND section_id = ${recordId}`;
		await sql.unsafe(
			`DELETE FROM matrix_activity WHERE data->>'section_tipo' = $1 AND data->>'section_id' = $2`,
			[SECTION, String(recordId)],
		);
	}
});

describe('apply_value restores the paired dataframe frames', () => {
	let recordId = 0;
	let tmRowId = 0;

	beforeAll(async () => {
		({ recordId, tmRowId } = await makeTwin([...MAIN_A, ...FRAMES_A]));
	});

	test('the main value reverts WITHOUT frames leaking into its column', async () => {
		const response = await toolTimeMachineApplyValue(
			await context({
				section_tipo: SECTION,
				section_id: recordId,
				tipo: MAIN,
				lang: 'lg-nolan',
				matrix_id: tmRowId,
			}),
		);
		expect(response.ok).toBe(true);
		expect(await storedKey(recordId, MAIN)).toEqual(MAIN_A_STORED);
	});

	test('the frame slot equals the snapshot frames — no survivors from today', async () => {
		expect(await storedKey(recordId, SLOT)).toEqual(FRAMES_A_STORED);
	});

	test('NO orphan frame survives: every id_key pairs with a live main item', async () => {
		const mainItems = (await storedKey(recordId, MAIN)) as { id?: number }[];
		const frames = ((await storedKey(recordId, SLOT)) ?? []) as { id_key?: number }[];
		const liveIds = new Set(mainItems.map((item) => Number(item.id)));
		expect(frames.length).toBeGreaterThan(0);
		for (const frame of frames) {
			expect(liveIds.has(Number(frame.id_key))).toBe(true);
		}
	});

	test('the fresh TM audit row carries main + frames, so the restore is revertible', async () => {
		const rows = (await sql.unsafe(
			`SELECT data FROM matrix_time_machine
			 WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 AND id <> $4
			 ORDER BY id DESC LIMIT 1`,
			[SECTION, recordId, MAIN, tmRowId],
		)) as { data: unknown }[];
		expect(rows[0]?.data).toEqual([...MAIN_A_STORED, ...FRAMES_A_STORED]);
	});

	test('the slot itself gets NO TM row (PHP suppresses it — the main row carries it)', async () => {
		const rows = (await sql.unsafe(
			`SELECT id FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3`,
			[SECTION, recordId, SLOT],
		)) as unknown[];
		expect(rows).toEqual([]);
	});
});

describe('apply_value of an UNCHANGED state is a no-op even when its frames are not contiguous', () => {
	// A shared slot [A1, B1, A2]: restoreSlot would regroup A's frames to [A1, A2, B1] —
	// a reorder only, which is no change (frame order is not state).
	const OTHER = { ...FRAMES_A_STORED[0], id: 7, id_key: 7, main_component_tipo: 'test9999' };
	const LIVE_SLOT = [FRAMES_A_STORED[0], OTHER, FRAMES_A_STORED[1]];

	test('slot keeps its order; no TM row is written', async () => {
		const { recordId, tmRowId } = await makeTwin([...MAIN_A_STORED, ...FRAMES_A_STORED]);
		await sql.unsafe(
			`UPDATE ${TABLE} SET relation = relation || $3::text::jsonb
			 WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, recordId, JSON.stringify({ [MAIN]: MAIN_A_STORED, [SLOT]: LIVE_SLOT })],
		);
		const response = await toolTimeMachineApplyValue(
			await context({
				section_tipo: SECTION,
				section_id: recordId,
				tipo: MAIN,
				lang: 'lg-nolan',
				matrix_id: tmRowId,
			}),
		);
		expect(response.ok).toBe(true);
		expect(await storedKey(recordId, SLOT)).toEqual(LIVE_SLOT);
		const rows = (await sql.unsafe(
			`SELECT id, tipo, lang, data FROM matrix_time_machine
			 WHERE section_tipo = $1 AND section_id = $2 AND tipo IN ($3, $4) AND id <> $5`,
			[SECTION, recordId, MAIN, SLOT, tmRowId],
		)) as unknown[];
		expect(rows).toEqual([]);
	});
});

/**
 * A FRAMELESS ROW MEANS "NO FRAMES AT THAT TIME" (decision 2026-09-28).
 *
 * Every supported row of a main is COMPOSED: PHP's `get_time_machine_data_to_save`
 * :1580 always appended every slot's full frames, and TS-era beta rows are not
 * supported history. So a raw PHP-shaped row carrying the main alone recorded
 * EMPTY slots, and restoring it over live frames restores the main and EMPTIES
 * the main's frames — PHP's own "a slot absent from the snapshot is emptied".
 * No refusal (the retired `refuseFramelessWipe` guarded TS-era rows only).
 */
describe('apply_value of a PHP-shaped FRAMELESS row empties the live frames', () => {
	let recordId = 0;
	let tmRowId = 0;

	beforeAll(async () => {
		({ recordId, tmRowId } = await makeTwin([...MAIN_A]));
	});

	test('the main restores and the slot is emptied — the version as it was recorded', async () => {
		expect(await storedKey(recordId, SLOT)).toEqual(FRAMES_B); // FLOOR: live frames to lose
		const response = await toolTimeMachineApplyValue(
			await context({
				section_tipo: SECTION,
				section_id: recordId,
				tipo: MAIN,
				lang: 'lg-nolan',
				matrix_id: tmRowId,
			}),
		);
		expect(response.ok).toBe(true);
		expect(await storedKey(recordId, MAIN)).toEqual(MAIN_A_STORED);
		expect(await storedKey(recordId, SLOT)).toBeUndefined();
	});

	test('the restore’s own row is frameless — exactly the state it wrote', async () => {
		// (Restoring THIS row later empties the slot again.)
		const rows = (await sql.unsafe(
			`SELECT data FROM matrix_time_machine
			 WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 AND id <> $4`,
			[SECTION, recordId, MAIN, tmRowId],
		)) as { data: unknown }[];
		expect(rows.length).toBe(1);
		expect(rows[0]?.data).toEqual(MAIN_A_STORED);
	});
});

describe('apply_value applies a frameless snapshot when the slot is already empty', () => {
	let recordId = 0;
	let tmRowId = 0;

	beforeAll(async () => {
		// No live frames ⇒ the empty slot stays empty (no key written).
		({ recordId, tmRowId } = await makeTwin([...MAIN_A], false));
	});

	test('the main restores and the empty slot stays empty', async () => {
		const response = await toolTimeMachineApplyValue(
			await context({
				section_tipo: SECTION,
				section_id: recordId,
				tipo: MAIN,
				lang: 'lg-nolan',
				matrix_id: tmRowId,
			}),
		);
		expect(response.ok).toBe(true);
		expect(await storedKey(recordId, MAIN)).toEqual(MAIN_A_STORED);
		expect(await storedKey(recordId, SLOT)).toBeUndefined();
	});
});

/**
 * PHP FIDELITY (Law 3's second half — do NOT throw where the oracle handled a
 * case generically). PHP never inspects a frame's `from_component_tipo` on its
 * own: it loops the slots it discovered and filters the snapshot per slot, so a
 * frame naming a tipo that is not a live dataframe slot of this main matches
 * nothing, restores nowhere, and is stripped out of the main data. An earlier
 * revision refused such a restore, which broke the Phase-6 contract gate
 * `tool_request.test.ts` "apply_value strips dataframe frames from the restored
 * main data" — the measured regression this test now pins on the frame-aware
 * door as well.
 */
describe('apply_value drops a frame naming a tipo that is not a live slot', () => {
	let recordId = 0;
	let tmRowId = 0;
	const FOREIGN = 'test6826'; // component_input_text — a real node, never a slot

	beforeAll(async () => {
		({ recordId, tmRowId } = await makeTwin([
			...MAIN_A,
			...FRAMES_A,
			{ ...FRAMES_A[0], id: 3, from_component_tipo: FOREIGN },
		]));
	});

	test('the restore succeeds; the unplaceable frame lands nowhere', async () => {
		const response = await toolTimeMachineApplyValue(
			await context({
				section_tipo: SECTION,
				section_id: recordId,
				tipo: MAIN,
				lang: 'lg-nolan',
				matrix_id: tmRowId,
			}),
		);
		expect(response.ok).toBe(true);
		// Not in the main column (the strip), not in the slot, not in a key of
		// its own — inert, exactly as PHP left it.
		expect(await storedKey(recordId, MAIN)).toEqual(MAIN_A_STORED);
		expect(await storedKey(recordId, SLOT)).toEqual(FRAMES_A_STORED);
		expect(await storedKey(recordId, FOREIGN)).toBeUndefined();
	});
});

/**
 * AN UNSTAMPED FROM-LESS FRAME IS THE MAIN'S OWN (decision D-A) ON EVERY SIDE.
 * A pre-migration frame names neither `main_component_tipo` nor
 * `from_component_tipo`. The preview (snapshotSlotFrames) shows it in the only
 * slot and the apply (restoreSlot) removes its live copy as the main's own —
 * so the plan must claim it by the SAME predicate (isOwnFrame), or the restore
 * deletes a frame the row recorded.
 */
describe('apply_value keeps a recorded unstamped from-less frame (one slot)', () => {
	let recordId = 0;
	let tmRowId = 0;
	const UNSTAMPED = { id: 5, type: 'dd490', id_key: 1, section_id: 4, section_tipo: 'test2819' };

	beforeAll(async () => {
		({ recordId, tmRowId } = await makeTwin([...MAIN_A, ...FRAMES_A, UNSTAMPED]));
		const live = (await storedKey(recordId, SLOT)) as unknown[];
		await sql.unsafe(
			`UPDATE ${TABLE} SET relation = relation || $3::text::jsonb
			 WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, recordId, JSON.stringify({ [SLOT]: [...live, UNSTAMPED] })],
		);
	});

	test('the frame the row recorded is still in the slot after the restore', async () => {
		const response = await toolTimeMachineApplyValue(
			await context({
				section_tipo: SECTION,
				section_id: recordId,
				tipo: MAIN,
				lang: 'lg-nolan',
				matrix_id: tmRowId,
			}),
		);
		expect(response.ok).toBe(true);
		expect(await storedKey(recordId, MAIN)).toEqual(MAIN_A_STORED);
		expect(await storedKey(recordId, SLOT)).toEqual([...FRAMES_A_STORED, UNSTAMPED]);
	});
});

/**
 * THE SLOT SET IS THE ONTOLOGY'S, NEVER THE CLIENT'S. The slot discovery reads
 * the main's ONTOLOGY request_config (core relations/dataframe_slots.ts
 * `resolveDataframeSlotTipos`, since 2026-09-27 — which is also why the tool no
 * longer spells `ddo_map` and action_scope_binding_tripwire needs no exemption
 * for apply_value any more), never a client map. This is the OUTCOME PROOF: a
 * request that smuggles a foreign component_dataframe in every client-map shape
 * leaves every other slot untouched.
 */
describe('apply_value ignores a client-supplied ddo_map', () => {
	let recordId = 0;
	let tmRowId = 0;
	/** A real component_dataframe node of the test TLD that is NOT a slot of MAIN. */
	const FOREIGN_SLOT = 'test60';
	const smuggledDdoMap = [{ tipo: FOREIGN_SLOT, section_tipo: SECTION, parent: MAIN }];

	/**
	 * LIVE frames under the foreign slot. The snapshot names NO frame of it (a
	 * snapshot frame naming a real slot is planned by design — see "a frame
	 * naming an UNDISCOVERED real slot"), and the frame is UNSTAMPED (names no
	 * main), so the live discovery does not make the slot MAIN's either (a live
	 * slot holding a frame NAMING MAIN is one of its slots and IS emptied —
	 * tm_save_order_native "an UNDECLARED live slot"). Only the smuggled map
	 * could put it in the plan; if it did, the restore would rewrite this key
	 * to the snapshot's (empty) share — an unstamped frame is every main's own —
	 * and wipe it.
	 */
	const { main_component_tipo: _main, ...unstampedB } = FRAMES_B[0] as Record<string, unknown>;
	const LIVE_FOREIGN = [{ ...unstampedB, id: 5, from_component_tipo: FOREIGN_SLOT }];

	beforeAll(async () => {
		({ recordId, tmRowId } = await makeTwin([...MAIN_A, ...FRAMES_A]));
		await sql.unsafe(
			`UPDATE ${TABLE} SET relation = relation || $3::text::jsonb
			 WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, recordId, JSON.stringify({ [FOREIGN_SLOT]: LIVE_FOREIGN })],
		);
	});

	test('the smuggled slot is left exactly as it was; the real slot restores', async () => {
		const response = await toolTimeMachineApplyValue(
			await context({
				section_tipo: SECTION,
				section_id: recordId,
				tipo: MAIN,
				lang: 'lg-nolan',
				matrix_id: tmRowId,
				ddo_map: smuggledDdoMap,
				tool_config: { ddo_map: smuggledDdoMap },
				request_config: [{ show: { ddo_map: smuggledDdoMap } }],
			}),
		);
		expect(response.ok).toBe(true);
		expect(await storedKey(recordId, MAIN)).toEqual(MAIN_A_STORED);
		expect(await storedKey(recordId, SLOT)).toEqual(FRAMES_A_STORED);
		expect(await storedKey(recordId, FOREIGN_SLOT)).toEqual(LIVE_FOREIGN);
	});
});

/**
 * The plan primitive on its own — the two shapes the doors cannot stage with
 * real ontology (a main with NO slot at all, and a main with TWO).
 */
describe('planDataframeRestore attribution rules', () => {
	test('with no slots in play every frame is inert — no throw (the Phase-6 shape)', async () => {
		const plan = await planDataframeRestore(
			MAIN,
			[
				{ id: 1, lang: 'lg-spa', value: 'MAIN-ONLY' },
				{ type: 'dd490', section_id: 9, section_tipo: 'test2819', from_component_tipo: 'test6826' },
				{ main_component_tipo: MAIN, section_id_key: 1 },
			],
			[],
		);
		expect(plan).toEqual([]);
	});

	test('a legacy frame with SEVERAL slots in play refuses instead of duplicating', async () => {
		// Both are real `component_dataframe` nodes; no main in this ontology
		// declares two, which is why the plan is exercised directly. PHP handed
		// the frame to every slot it looped over — that duplication IS the
		// corruption, so the entry is unattributable and the restore refuses.
		await expect(
			planDataframeRestore(
				MAIN,
				[{ main_component_tipo: MAIN, section_id_key: 1 }],
				[SLOT, 'dd560'],
			),
		).rejects.toThrow(DataframeRestoreError);
	});

	test('a frame naming an UNDISCOVERED real slot adds that slot to the plan', async () => {
		const plan = await planDataframeRestore(MAIN, [...FRAMES_A], []);
		expect(plan).toEqual([{ slotTipo: SLOT, frames: FRAMES_A }]);
	});
});

describe('apply_value refuses to restore a dataframe SLOT row', () => {
	let recordId = 0;
	let tmRowId = 0;

	beforeAll(async () => {
		const twin = await makeTwin([...FRAMES_A]);
		recordId = twin.recordId;
		// Re-point the TM row at the SLOT itself.
		await sql.unsafe(`UPDATE matrix_time_machine SET tipo = $2 WHERE id = $1`, [
			twin.tmRowId,
			SLOT,
		]);
		tmRowId = twin.tmRowId;
	});

	test('a slot restore is denied instead of silently emptying the slot', async () => {
		const refusal = await refusalOf(
			toolTimeMachineApplyValue(
				await context({
					section_tipo: SECTION,
					section_id: recordId,
					tipo: SLOT,
					lang: 'lg-nolan',
					matrix_id: tmRowId,
				}),
			),
		);
		expect(refusal.code).toBe('engine.uncovered_scope');
		expect(await storedKey(recordId, SLOT)).toEqual(FRAMES_B);
	});
});

describe('bulk_revert_process restores the paired frames too', () => {
	let recordId = 0;
	const BATCH = 987001;
	const mintedBulkIds: number[] = [];

	beforeAll(async () => {
		recordId = await createSectionRecord(SECTION, -1);
		twins.push(recordId);
		await sql.unsafe(
			`UPDATE ${TABLE}
			 SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb, $5::text, $6::text::jsonb)
			 WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, recordId, MAIN, JSON.stringify(MAIN_B), SLOT, JSON.stringify(FRAMES_B)],
		);
		// History (oldest first): the pre-batch value, then the batch write.
		await sql.unsafe(
			`INSERT INTO matrix_time_machine (section_id, section_tipo, tipo, lang, timestamp, user_id, data)
			 VALUES ($1, $2, $3, 'lg-nolan', '2026-07-01 09:00:00', -1, $4::text::jsonb)`,
			[recordId, SECTION, MAIN, JSON.stringify([...MAIN_A, ...FRAMES_A])],
		);
		await sql.unsafe(
			`INSERT INTO matrix_time_machine (section_id, section_tipo, tipo, lang, timestamp, user_id, bulk_process_id, data)
			 VALUES ($1, $2, $3, 'lg-nolan', '2026-07-02 09:00:00', -1, $4, $5::text::jsonb)`,
			[recordId, SECTION, MAIN, BATCH, JSON.stringify([...MAIN_B, ...FRAMES_B])],
		);
	});

	afterAll(async () => {
		for (const bulkId of mintedBulkIds) {
			await sql`DELETE FROM matrix_notes WHERE section_tipo = 'dd800' AND section_id = ${bulkId}`;
		}
	});

	test('the batch revert restores main AND frames — no orphans left behind', async () => {
		const response = await toolTimeMachineBulkRevert(
			await context({ section_tipo: SECTION, bulk_process_id: BATCH }),
		);
		expect(response.ok).toBe(true);
		const batch = response.data as { skipped: string[]; bulk_process_id?: unknown };
		expect(batch.skipped).toEqual([]);
		if (typeof batch.bulk_process_id === 'number') mintedBulkIds.push(batch.bulk_process_id);
		// PHP's bulk_revert fed the raw snapshot to set_data, which writes frame
		// locators into the MAIN column and leaves the slot at today's values.
		expect(await storedKey(recordId, MAIN)).toEqual(MAIN_A_STORED);
		expect(await storedKey(recordId, SLOT)).toEqual(FRAMES_A_STORED);
	});
});

describe('bulk_revert_process of a PHP-era run restores a FRAMELESS pre-batch state: frames emptied', () => {
	let recordId = 0;
	const BATCH = 987002;
	const mintedBulkIds: number[] = [];

	beforeAll(async () => {
		recordId = await createSectionRecord(SECTION, -1);
		twins.push(recordId);
		await sql.unsafe(
			`UPDATE ${TABLE}
			 SET relation = COALESCE(relation, '{}'::jsonb) || $3::text::jsonb
			 WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, recordId, JSON.stringify({ [MAIN]: MAIN_B, [SLOT]: FRAMES_B })],
		);
		// Pre-batch snapshot with NO frames (a PHP row whose slots were empty).
		await sql.unsafe(
			`INSERT INTO matrix_time_machine (section_id, section_tipo, tipo, lang, timestamp, user_id, data)
			 VALUES ($1, $2, $3, 'lg-nolan', '2026-07-01 09:00:00', -1, $4::text::jsonb)`,
			[recordId, SECTION, MAIN, JSON.stringify([...MAIN_A])],
		);
		await sql.unsafe(
			`INSERT INTO matrix_time_machine (section_id, section_tipo, tipo, lang, timestamp, user_id, bulk_process_id, data)
			 VALUES ($1, $2, $3, 'lg-nolan', '2026-07-02 09:00:00', -1, $4, $5::text::jsonb)`,
			[recordId, SECTION, MAIN, BATCH, JSON.stringify([...MAIN_B, ...FRAMES_B])],
		);
	});

	afterAll(async () => {
		for (const bulkId of mintedBulkIds) {
			await sql`DELETE FROM matrix_notes WHERE section_tipo = 'dd800' AND section_id = ${bulkId}`;
		}
	});

	test('the key reverts: main back to the pre-batch value, the main’s frames emptied', async () => {
		const response = await toolTimeMachineBulkRevert(
			await context({ section_tipo: SECTION, bulk_process_id: BATCH }),
		);
		expect(response.ok).toBe(true);
		const batch = response.data as {
			counter: number;
			skipped: { reason: string }[];
			bulk_process_id?: unknown;
		};
		if (typeof batch.bulk_process_id === 'number') mintedBulkIds.push(batch.bulk_process_id);
		expect(batch.skipped).toEqual([]);
		expect(batch.counter).toBe(1);
		expect(await storedKey(recordId, MAIN)).toEqual(MAIN_A_STORED);
		expect(await storedKey(recordId, SLOT)).toBeUndefined();
	});
});

/**
 * THE REMOVED-SET RULE, at the save door. It used to exist twice (the save
 * body's `removedItems` closure and the TM doors' `restore_common.ts` copy) and
 * this test bound the two. The extraction it stood in for has landed
 * (CLOSURE_PLAN Step 2): ONE rule, `section_record/obligation_ledger.ts
 * removedLocators`, which the ledger applies to every write's before-image and
 * the save door reports through. What stays is the rule's OUTCOME on a mixed
 * main column: the dropped locator is removed, the dropped dd490 frame is not
 * (a pairing record, not an edge).
 */
describe('the removed-set rule at the save door (dd490 frames are not edges)', () => {
	let recordId = 0;

	beforeAll(async () => {
		recordId = await createSectionRecord(SECTION, -1);
		twins.push(recordId);
		await sql.unsafe(
			`UPDATE ${TABLE}
			 SET relation = COALESCE(relation, '{}'::jsonb) || $3::text::jsonb
			 WHERE section_tipo = $1 AND section_id = $2`,
			// A MIXED main column (the legacy shape the strip exists for): both
			// halves of the rule then matter — the locator diff AND the dd490
			// exclusion, which only bites on an entry present BEFORE and absent
			// after. A frame-free `before` makes the exclusion unobservable and
			// the gate vacuous; that was checked by mutation, not assumed.
			[SECTION, recordId, JSON.stringify({ [MAIN]: [...MAIN_A, FRAMES_A[0]], [SLOT]: FRAMES_A })],
		);
	});

	test('the same before/after yields the same removal set at both write doors', async () => {
		const before = (await storedKey(recordId, MAIN)) as unknown[];
		expect(before).toHaveLength(3);
		// Drop the second locator AND the frame; keep the first locator.
		const after = [MAIN_A[0]];
		const saved = await saveComponentData({
			componentTipo: MAIN,
			sectionTipo: SECTION,
			sectionId: recordId,
			lang: 'lg-nolan',
			changedData: [{ action: 'set_data', key: null, value: after }],
			userId: -1,
		});
		expect(saved.ok).toBe(true);
		const doorRemoved = Array.isArray(saved.removedItems) ? saved.removedItems : [];
		// Exactly one removal: the dropped locator. The dropped dd490 frame is a
		// pairing record, not an edge, so it is NOT a removed observer target.
		expect(doorRemoved).toEqual([MAIN_A[1]]);
	});
});

/**
 * The observer half (audit P2): PHP restored through `element->save()`, whose
 * last act is `propagate_to_observers()`. The direct-write port skipped it, so
 * a TM restore of an observed component left every mirror at the pre-restore
 * value AND wrote no observer TM audit row.
 *
 * Fixture: the shared observer term (test/helpers/observer_term_seed.ts) — a
 * MIRROR ("who indexes me", on a term) observing an INDEXER slot on a
 * referencer record. BUILT, not an install's pair, and the same fixture every
 * other observer gate drives.
 */
describe('apply_value fires the observer cascade', () => {
	const TERM = SEED_TERM;
	let termTable = 'matrix_test';
	let refTable = 'matrix_test';
	let twin = 0;
	let tmRowId = 0;
	let originalBag: unknown = null;
	let baselineTmId = 0;

	async function termMirror(): Promise<unknown> {
		const rows = (await sql.unsafe(
			`SELECT relation->($3::text) AS bag FROM "${termTable}"
			 WHERE section_tipo = $1 AND section_id = $2`,
			[TERM.section_tipo, TERM.section_id, MIRROR],
		)) as { bag: unknown }[];
		return rows[0]?.bag ?? null;
	}

	beforeAll(async () => {
		await ensureObserverTerm();
		termTable = (await getMatrixTableFromTipo(TERM.section_tipo)) ?? 'matrix_test';
		refTable = (await getMatrixTableFromTipo(REF_SECTION)) ?? 'matrix_test';
		originalBag = await termMirror();
		twin = await createSectionRecord(REF_SECTION, -1);
		const maxRows = (await sql.unsafe(
			`SELECT COALESCE(MAX(id), 0) AS id FROM matrix_time_machine`,
		)) as { id: number }[];
		baselineTmId = Number(maxRows[0]?.id ?? 0);
		const rows = (await sql.unsafe(
			`INSERT INTO matrix_time_machine (section_id, section_tipo, tipo, lang, timestamp, user_id, data)
			 VALUES ($1, $3, $4, 'lg-nolan', '2026-07-01 10:00:00', -1, $2::text::jsonb)
			 RETURNING id`,
			[
				twin,
				JSON.stringify([
					{
						id: 1,
						type: 'dd96',
						section_id: String(TERM.section_id),
						section_tipo: TERM.section_tipo,
						from_component_tipo: INDEXER,
					},
				]),
				REF_SECTION,
				INDEXER,
			],
		)) as { id: number }[];
		tmRowId = rows[0]?.id ?? 0;
	});

	afterAll(async () => {
		// Restore the term's mirror byte-for-byte, then sweep everything seeded.
		await sql.unsafe(
			`UPDATE "${termTable}"
			 SET relation = CASE WHEN $3::text IS NULL
				THEN COALESCE(relation, '{}'::jsonb) - ($4::text)
				ELSE COALESCE(relation, '{}'::jsonb) || jsonb_build_object($4::text, $3::text::jsonb) END
			 WHERE section_tipo = $1 AND section_id = $2`,
			[
				TERM.section_tipo,
				TERM.section_id,
				originalBag === null ? null : JSON.stringify(originalBag),
				MIRROR,
			],
		);
		await sql`DELETE FROM matrix_time_machine WHERE section_tipo = ${TERM.section_tipo} AND section_id = ${TERM.section_id} AND tipo = ${MIRROR} AND id > ${baselineTmId}`;
		await sql.unsafe(`DELETE FROM "${refTable}" WHERE section_tipo = $1 AND section_id = $2`, [
			REF_SECTION,
			twin,
		]);
		await sql`DELETE FROM matrix_time_machine WHERE section_tipo = ${REF_SECTION} AND section_id = ${twin}`;
		// Residue asserted, not trusted.
		expect(await dropObserverTerm()).toBe(0);
	});

	test("the restored locator's target recomputes its mirror and gets a TM audit row", async () => {
		const response = await toolTimeMachineApplyValue(
			await context({
				section_tipo: REF_SECTION,
				section_id: twin,
				tipo: INDEXER,
				lang: 'lg-nolan',
				matrix_id: tmRowId,
			}),
		);
		expect(response.ok).toBe(true);

		const bag = ((await termMirror()) ?? []) as { section_tipo?: string; section_id?: string }[];
		expect(
			bag.some(
				(entry) => entry.section_tipo === REF_SECTION && String(entry.section_id) === String(twin),
			),
		).toBe(true);

		const audit = (await sql.unsafe(
			`SELECT id FROM matrix_time_machine
			 WHERE section_tipo = $1 AND section_id = $2 AND tipo = ($4::text) AND id > $3`,
			[TERM.section_tipo, TERM.section_id, baselineTmId, MIRROR],
		)) as unknown[];
		expect(audit.length).toBeGreaterThan(0);
	});
});
