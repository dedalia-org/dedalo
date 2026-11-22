/**
 * AN INFO OBSERVER'S `server.config` CHOOSES ITS TARGETS (T2-WID-1).
 *
 * The component_info branch of the observer dispatch (component_info and its
 * aliases, no `perform`) read only `server.filter`: an SQO filter searched the
 * host section, anything else recomputed the SAVED record. `server.config` was
 * read in the other branches only — so an info observer declaring
 * `use_observable_dato` (its targets are the records the saved value points at)
 * or `use_inverse_relations` (the records pointing at the saved one) recomputed,
 * and wrote its Time Machine row on, the record that CHANGED — a record that
 * does not even hold the observer. PHP update_observer_data runs ONE config
 * switch after the filter step for every observer, info included.
 *
 * Now the info branch takes its targets through the SAME resolver table as the
 * set_dato_external branch (external_laws/resolvers.ts observerTargetResolverOf):
 * observable → the saved value's locators (+ the removed ones), self+observable
 * → those plus the base set, inverse → the hosts referencing the saved record,
 * self → the base set (filter result or the saved record), unchanged.
 *
 * Outcome: the observer's TM row lands on the TARGET record. RED before: the row
 * landed on the saved record and the target got none.
 *
 * Situation `zzoic` (dropped with residue 0); records built here.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { DB_READY } from '../helpers/db_ready.ts';

const USER_ID = -1;
const SECTION_A = 'zzoic1';
const PORTAL = 'zzoic2'; // A → B
const SECTION_B = 'zzoic3';
const TEXT_B = 'zzoic6'; // a literal of B
/** Info observer IN B, observing A's portal: targets = the records the portal points at. */
const INFO_OBSERVABLE = 'zzoic4';
/** Info observer IN A, observing B's text: targets = the records referencing the saved B. */
const INFO_INVERSE = 'zzoic5';
/** Info observer IN A, observing A's portal, SAME record (filter:false): the self control. */
const INFO_SELF = 'zzoic7';

const SITUATION = situation({
	name: 'zzoic info observer config targets',
	tld: 'zzoic',
	nodes: [
		{ tipo: SECTION_A, model: 'section', parent: 'dd14' },
		{ tipo: PORTAL, model: 'component_portal', parent: SECTION_A },
		{
			tipo: INFO_INVERSE,
			model: 'component_info',
			parent: SECTION_A,
			properties: {
				observe: [{ component_tipo: TEXT_B, server: { config: { use_inverse_relations: true } } }],
			},
		},
		{
			tipo: INFO_SELF,
			model: 'component_info',
			parent: SECTION_A,
			properties: { observe: [{ component_tipo: PORTAL, server: { filter: false } }] },
		},
		{ tipo: SECTION_B, model: 'section', parent: 'dd14' },
		{ tipo: TEXT_B, model: 'component_input_text', parent: SECTION_B },
		{
			tipo: INFO_OBSERVABLE,
			model: 'component_info',
			parent: SECTION_B,
			properties: {
				observe: [
					{
						component_tipo: PORTAL,
						server: { config: { use_observable_dato: true, use_self_section: false } },
					},
				],
			},
		},
	],
	records: [
		{ section_tipo: SECTION_A, section_id: 1, columns: { relation: {} } },
		{ section_tipo: SECTION_B, section_id: 1, columns: { relation: {} } },
		{ section_tipo: SECTION_B, section_id: 2, columns: { relation: {} } },
	],
});

async function historyRows(sectionTipo: string, sectionId: number, tipo: string): Promise<number> {
	const rows = (await sql`
		SELECT count(*)::int AS n FROM matrix_time_machine
		 WHERE section_tipo = ${sectionTipo} AND section_id = ${sectionId} AND tipo = ${tipo}
	`) as { n: number }[];
	return rows[0]?.n ?? 0;
}

async function save(
	componentTipo: string,
	sectionTipo: string,
	sectionId: number,
	value: unknown[],
	lang = 'lg-nolan',
): Promise<void> {
	const result = await saveComponentData({
		componentTipo,
		sectionTipo,
		sectionId,
		lang,
		userId: USER_ID,
		changedData: [{ action: 'set_data', id: null, value }] as never,
	});
	expect(result.ok, result.message).toBe(true);
}

describe.if(DB_READY)('info observer targets follow server.config (T2-WID-1)', () => {
	beforeAll(async () => {
		await assertTestDatabase('observer_info_config_targets_native');
		await dropSituation(SITUATION);
		await ensureSituation(SITUATION);
	}, 60_000);

	afterAll(async () => {
		await assertTestDatabase('observer_info_config_targets_native');
		expect(await dropSituation(SITUATION)).toBe(0);
	}, 60_000);

	test('use_observable_dato (no self): the TM row lands on the records the saved portal points at', async () => {
		const before = {
			b1: await historyRows(SECTION_B, 1, INFO_OBSERVABLE),
			b2: await historyRows(SECTION_B, 2, INFO_OBSERVABLE),
			a1: await historyRows(SECTION_A, 1, INFO_OBSERVABLE),
			self: await historyRows(SECTION_A, 1, INFO_SELF),
		};
		await save(PORTAL, SECTION_A, 1, [
			{ type: 'dd151', section_tipo: SECTION_B, section_id: 1, from_component_tipo: PORTAL },
		]);
		// FLOOR: the save reached the dispatch (the same-record control fired).
		expect(await historyRows(SECTION_A, 1, INFO_SELF)).toBe(before.self + 1);
		expect(
			await historyRows(SECTION_B, 1, INFO_OBSERVABLE),
			'the observable target got no recompute — the info branch ignored server.config',
		).toBe(before.b1 + 1);
		expect(await historyRows(SECTION_B, 2, INFO_OBSERVABLE)).toBe(before.b2);
		expect(
			await historyRows(SECTION_A, 1, INFO_OBSERVABLE),
			'the saved record (not a target, not a host) got the recompute',
		).toBe(before.a1);
	}, 60_000);

	test('the removed target is recomputed too (its widget lost the saved record)', async () => {
		const before = {
			b1: await historyRows(SECTION_B, 1, INFO_OBSERVABLE),
			b2: await historyRows(SECTION_B, 2, INFO_OBSERVABLE),
		};
		await save(PORTAL, SECTION_A, 1, [
			{ type: 'dd151', section_tipo: SECTION_B, section_id: 2, from_component_tipo: PORTAL },
		]);
		expect(await historyRows(SECTION_B, 2, INFO_OBSERVABLE)).toBe(before.b2 + 1);
		expect(await historyRows(SECTION_B, 1, INFO_OBSERVABLE)).toBe(before.b1 + 1);
	}, 60_000);

	test('use_inverse_relations: the TM row lands on the hosts referencing the saved record', async () => {
		// A/1 now points at B/2.
		const before = {
			a1: await historyRows(SECTION_A, 1, INFO_INVERSE),
			b2: await historyRows(SECTION_B, 2, INFO_INVERSE),
		};
		await save(TEXT_B, SECTION_B, 2, [{ value: 'zzoic text' }], 'lg-eng');
		expect(
			await historyRows(SECTION_A, 1, INFO_INVERSE),
			'the referencing host got no recompute — the info branch ignored use_inverse_relations',
		).toBe(before.a1 + 1);
		expect(
			await historyRows(SECTION_B, 2, INFO_INVERSE),
			'the saved record (not a host of the observer) got the recompute',
		).toBe(before.b2);
	}, 60_000);
});
