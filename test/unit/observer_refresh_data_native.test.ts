/**
 * THE `refresh_data` OBSERVER PERFORM — native gate (owner ruling 2026-11-13 A4,
 * T1-U05 option A, WC-2026-11-13-observer-refresh-data).
 *
 * THE DEFECT: the one shipped edge, rsc1214 (`component_select`, a biographical
 * milestone picked from the milestones of the person chosen in rsc1156)
 * observing rsc1156 (`component_autocomplete`, `data_limit: 1`), declares
 * `perform: {function: refresh_data, params: {actions: [{condition: on_empty,
 * action: empty_data}]}}`. Until 2026-11-13 TS refused it as a NAMED exemption
 * (counted `observers_server_shape_not_covered`): changing the person left the
 * previous person's milestone stored — a value outside the field's own
 * `fixed_filter`, still published and searchable. PHP's effective behaviour for
 * 20 years: `on_empty` was ALWAYS true (the fresh observer instance never had
 * an observable value), so every save of the person cleared the milestone.
 *
 * THE SITUATION this file BUILDS (reserved scratch TLD `zzrfd`, torn down after):
 * a host section (the rsc1152 role), a person section (rsc197), a milestone
 * section (rsc420), the person autocomplete (rsc1156) and the milestone select
 * (rsc1214) with rsc1214's observe block copied field for field — plus a
 * second-order observer of the select (the hop case) and a select whose params
 * are OUTSIDE the closed grammar (the refusal case). Every record is created at
 * runtime through the engine's doors; the saves go through saveComponentData,
 * so the propagation is the obligation ledger's — never a hand-built call.
 *
 * Cases (the plan's a–h): a person A→B clears the select on the host, one TM
 * pair by the saver; b person → empty clears; c the person record (a foreign
 * section) gets no select key and no TM row — the not-host count ticks; d an
 * already-empty select is not written (zero TM rows); e malformed params:
 * refused + counted, nothing written (the pure grammar is pinned too); f
 * `observers_server_shape_not_covered` does not tick; g an UNCHANGED re-save of
 * the person keeps the select; h the clear HOPS — a second-order refresh_data
 * observer of the select is cleared by the same save.
 *
 * THE DOOR (review 2026-11-13 — the clear is destructive, so WHERE it fires
 * from matters): i a DUPLICATE keeps the copied select (the birth declares the
 * person, but a whole-record write never fires the clear — counted
 * `observers_refresh_data_skipped`); j ONE transaction saving the person AND
 * the select (a CSV import row) keeps the select in either column order (the
 * guard's `written` set); k the Time Machine's whole-record replace that
 * changes the person keeps the select it restores.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getCounters } from '../../src/core/api/counters.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { duplicateSectionRecord } from '../../src/core/section/record/duplicate_record.ts';
import { getObserverSubscriptions } from '../../src/core/section/record/observer_subscriptions.ts';
import {
	applyRefreshDataClear,
	MAX_CASCADE_DEPTH,
} from '../../src/core/section/record/observers.ts';
import {
	isObservedChangeOrigin,
	OBSERVED_CHANGE_ORIGINS,
	observedValueChanged,
	type ParsedRefreshData,
	parseRefreshDataParams,
	refreshDataTrigger,
} from '../../src/core/section/record/refresh_data.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { DECLARATION_KINDS } from '../../src/core/section_record/obligation_ledger.ts';
import { persistRecordColumns } from '../../src/core/section_record/record_write.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';

const USER_ID = -7; // the saver: every TM row the clear writes names this actor

/** The host section (the rsc1152 role): declares the person and the milestone select. */
const HOST = 'zzrfd1';
/** The person section (rsc197): the observable's foreign section — never a host. */
const PERSON = 'zzrfd2';
/** The milestone section (rsc420): what the select points at. */
const MILESTONE = 'zzrfd3';
/** component_autocomplete, data_limit 1 — the observed (rsc1156). */
const PERSON_FIELD = 'zzrfd4';
/** component_select — the refresh_data observer (rsc1214). */
const MILESTONE_FIELD = 'zzrfd5';
/** component_select observing the milestone select with the same block — the hop case. */
const SECOND_ORDER = 'zzrfd6';
/** component_select observing the person with params OUTSIDE the closed grammar. */
const MALFORMED = 'zzrfd7';

/** rsc1214's observe block, field for field, re-pointed at the scratch tipos. */
function refreshDataObserve(observedTipo: string, condition = 'on_empty') {
	return [
		{
			info: 'Fired when Person is saved',
			client: { event: 'update_value', perform: { function: 'refresh' } },
			server: {
				config: { use_self_section: true, use_observable_dato: true },
				perform: {
					params: { actions: [{ action: 'empty_data', condition }] },
					function: 'refresh_data',
				},
			},
			component_tipo: observedTipo,
		},
	];
}

const SITUATION = situation({
	tld: 'zzrfd',
	name: 'observer refresh_data perform',
	nodes: [
		{ tipo: HOST, model: 'section', parent: 'dd14' },
		{ tipo: PERSON, model: 'section', parent: 'dd14' },
		{ tipo: MILESTONE, model: 'section', parent: 'dd14' },
		{
			tipo: PERSON_FIELD,
			model: 'component_autocomplete',
			parent: HOST,
			properties: {
				source: {
					mode: 'autocomplete',
					request_config: [{ sqo: { section_tipo: [{ value: [PERSON], source: 'section' }] } }],
				},
				// rsc1156's forward spec — legacy, kept as shipped (the observe half decides).
				observers: [{ info: 'Update milestone', component_tipo: MILESTONE_FIELD }],
				data_limit: 1,
			},
		},
		{
			tipo: MILESTONE_FIELD,
			model: 'component_select',
			parent: HOST,
			properties: {
				source: {
					mode: 'autocomplete',
					request_config: [{ sqo: { section_tipo: [{ value: [MILESTONE], source: 'section' }] } }],
				},
				observe: refreshDataObserve(PERSON_FIELD),
			},
		},
		{
			tipo: SECOND_ORDER,
			model: 'component_select',
			parent: HOST,
			properties: {
				source: {
					mode: 'autocomplete',
					request_config: [{ sqo: { section_tipo: [{ value: [MILESTONE], source: 'section' }] } }],
				},
				observe: refreshDataObserve(MILESTONE_FIELD),
			},
		},
		{
			tipo: MALFORMED,
			model: 'component_select',
			parent: HOST,
			properties: {
				source: {
					mode: 'autocomplete',
					request_config: [{ sqo: { section_tipo: [{ value: [MILESTONE], source: 'section' }] } }],
				},
				// `on_change` is NOT in the closed grammar (PHP: a silent no-op).
				observe: refreshDataObserve(PERSON_FIELD, 'on_change'),
			},
		},
	],
});

const tables = new Map<string, string>();
async function tableOf(sectionTipo: string): Promise<string> {
	const known = tables.get(sectionTipo);
	if (known !== undefined) return known;
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) throw new Error(`no matrix table for ${sectionTipo}`);
	tables.set(sectionTipo, table);
	return table;
}

let host = 0;
let personA = 0;
let personB = 0;
let milestone1 = 0;
let milestone2 = 0;

const locator = (from: string, sectionTipo: string, sectionId: number) => ({
	type: 'dd151',
	section_tipo: sectionTipo,
	section_id: String(sectionId),
	from_component_tipo: from,
});

/** A relation save through THE door (the obligation ledger drains after COMMIT). */
async function save(componentTipo: string, sectionId: number, value: unknown[]): Promise<void> {
	const saved = await saveComponentData({
		componentTipo,
		sectionTipo: HOST,
		sectionId,
		lang: 'lg-nolan',
		changedData: [{ action: 'set_data', id: null, value }] as never,
		userId: USER_ID,
	});
	expect(saved.ok, saved.message).toBe(true);
}

const savePerson = (value: unknown[]) => save(PERSON_FIELD, host, value);
const setMilestone = (id: number) =>
	save(MILESTONE_FIELD, host, [locator(MILESTONE_FIELD, MILESTONE, id)]);

/** The stored relation key, or `null` when the key is absent. */
async function relationKey(sectionTipo: string, sectionId: number, key: string): Promise<unknown> {
	const rows = (await sql.unsafe(
		`SELECT relation->$3 AS value FROM "${await tableOf(sectionTipo)}" WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId, key],
	)) as { value: unknown }[];
	return rows[0]?.value ?? null;
}

const milestoneOnHost = () => relationKey(HOST, host, MILESTONE_FIELD);

interface TmRow {
	user_id: number;
	data: unknown;
}

/** The TM rows of one component on one record, newest first. */
async function tmRows(sectionTipo: string, sectionId: number, tipo: string): Promise<TmRow[]> {
	return (await sql.unsafe(
		`SELECT user_id::int AS user_id, data FROM matrix_time_machine
		 WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 ORDER BY id DESC`,
		[sectionTipo, sectionId, tipo],
	)) as TmRow[];
}

const counter = (name: string): number => getCounters()[name] ?? 0;

const WATCHED = [
	'observers_server_shape_not_covered',
	'observers_refresh_data_refused',
	'observers_refresh_data_unchanged',
	'observers_refresh_data_skipped',
	'observers_target_not_host',
	'observers_propagation_failed',
	'observers_cascade_hop_failed',
	'observers_cascade_cycle_refused',
] as const;
type Snapshot = Record<(typeof WATCHED)[number], number>;
function snapshot(): Snapshot {
	const out = {} as Snapshot;
	for (const name of WATCHED) out[name] = counter(name);
	return out;
}
function delta(before: Snapshot): Snapshot {
	const out = {} as Snapshot;
	for (const name of WATCHED) out[name] = counter(name) - before[name];
	return out;
}

beforeAll(async () => {
	await ensureSituation(SITUATION);
	host = await createSectionRecord(HOST, USER_ID);
	personA = await createSectionRecord(PERSON, USER_ID);
	personB = await createSectionRecord(PERSON, USER_ID);
	milestone1 = await createSectionRecord(MILESTONE, USER_ID);
	milestone2 = await createSectionRecord(MILESTONE, USER_ID);
}, 120_000);

afterAll(async () => {
	// Residue asserted, not trusted (records + TM + counters + the TLD's nodes).
	expect(await dropSituation(SITUATION)).toBe(0);
}, 120_000);

describe('FLOOR — the edge is registered the way the shipped milestone edge is', () => {
	test('the select subscribes to the person with a server block; the second-order and malformed edges too', async () => {
		const observers = (await getObserverSubscriptions(PERSON_FIELD)).map((sub) => sub.observerTipo);
		expect(observers).toContain(MILESTONE_FIELD);
		expect(observers).toContain(MALFORMED);
		expect(
			(await getObserverSubscriptions(MILESTONE_FIELD)).map((sub) => sub.observerTipo),
		).toEqual([SECOND_ORDER]);
		expect(MAX_CASCADE_DEPTH).toBeGreaterThan(2); // the hop case needs depth 2
	});
});

describe('the closed grammar (pure)', () => {
	test('the shipped edge’s params parse, as the object and as the one-item array PHP also accepted', () => {
		const params = { actions: [{ action: 'empty_data', condition: 'on_empty' }] };
		const expected: ParsedRefreshData = {
			actions: [{ condition: 'on_empty', action: 'empty_data' }],
		};
		expect(parseRefreshDataParams(params)).toEqual(expected);
		expect(parseRefreshDataParams([params])).toEqual(expected);
		expect(
			parseRefreshDataParams({
				actions: [{ condition: 'on_empty', action: 'empty_data', arguments: [] }],
			}),
		).toEqual(expected);
	});

	test('anything outside on_empty / empty_data is a NAMED refusal — never a silent no-op, never a called function', () => {
		const cases: [unknown, string][] = [
			[{ actions: [{ condition: 'on_change', action: 'empty_data' }] }, 'condition_unknown'],
			[{ actions: [{ condition: 'on_empty', action: 'drop_table' }] }, 'action_unknown'],
			[{ actions: [{ condition: 'on_empty', action: 'x::y' }] }, 'action_unknown'],
			[
				{ actions: [{ condition: 'on_empty', action: 'empty_data', arguments: [1] }] },
				'arguments_not_empty',
			],
			[
				// biome-ignore lint/suspicious/noThenProperty: the malformed-params case ON PURPOSE — a `then` key is exactly the kind of foreign key the closed grammar must refuse
				{ actions: [{ condition: 'on_empty', action: 'empty_data', then: 'save' }] },
				'action_key_unknown',
			],
			[{ actions: [] }, 'actions_empty'],
			[{ actions: 'empty_data' }, 'actions_malformed'],
			[{ actions: ['empty_data'] }, 'actions_malformed'],
			[
				{ actions: [{ condition: 'on_empty', action: 'empty_data' }], save: true },
				'params_malformed',
			],
			[null, 'params_malformed'],
			[undefined, 'params_malformed'],
			['on_empty', 'params_malformed'],
			[[{ actions: [] }, { actions: [] }], 'params_malformed'],
		];
		for (const [params, reason] of cases) {
			const parsed = parseRefreshDataParams(params);
			expect(parsed, JSON.stringify(params)).toMatchObject({ refused: true, reason });
			expect(('detail' in parsed ? parsed.detail : '').length).toBeGreaterThan(20);
		}
	});

	test('the trigger: a locator added or removed is a change; the same set in another order or with other ids is not; a hop (no before-image) always is', () => {
		const a = locator(PERSON_FIELD, PERSON, 1);
		const b = locator(PERSON_FIELD, PERSON, 2);
		expect(observedValueChanged({ saved: [b], removed: [a], before: [a] })).toBe(true);
		expect(observedValueChanged({ saved: [a, b], removed: [], before: [a] })).toBe(true);
		expect(observedValueChanged({ saved: [], removed: [a], before: [a] })).toBe(true);
		expect(observedValueChanged({ saved: [a], removed: [], before: [a] })).toBe(false);
		expect(observedValueChanged({ saved: [{ ...b, id: 9 }, a], removed: [], before: [a, b] })).toBe(
			false,
		);
		expect(observedValueChanged({ saved: [], removed: [], before: [] })).toBe(false);
		// a literal observed value: canonical comparison
		expect(observedValueChanged({ saved: ['x'], removed: [], before: ['x'] })).toBe(false);
		expect(observedValueChanged({ saved: ['y'], removed: [], before: ['x'] })).toBe(true);
		// no before-image = a cascade hop: the hop is the change
		expect(observedValueChanged({ saved: [a], removed: [] })).toBe(true);
	});

	test('the door: a component save (keys) and a hop fire; a birth, a replace, a death and a recompute never do (origin REQUIRED — no absent case, A4 Q3)', () => {
		const a = locator(PERSON_FIELD, PERSON, 1);
		const b = locator(PERSON_FIELD, PERSON, 2);
		const changed = { saved: [b], removed: [a], before: [a] };
		expect(refreshDataTrigger({ ...changed, origin: 'keys' })).toBe('changed');
		// Every origin is adjudicated; nothing outside the closed set is read as a save.
		expect(isObservedChangeOrigin(undefined)).toBe(false);
		expect(isObservedChangeOrigin('save')).toBe(false);
		// THE SET IS COMPLETE — judged against the ledger's OWN exhaustive kind table
		// (obligation_ledger.ts DECLARATION_KINDS, a Record over the declaration
		// union), never against itself: every kind that reaches propagation (all but
		// `none` and `cascade-owned`, which never enqueue) plus the cascade 'hop'. A
		// kind added to the ledger and left out of the kernel's set would make the
		// kernel refuse every drain of it (counted observers_propagation_failed,
		// every observer of it stale) with tsc and every gate green — RED here.
		const ledgerOrigins = Object.keys(DECLARATION_KINDS).filter(
			(kind) => kind !== 'none' && kind !== 'cascade-owned',
		);
		expect(ledgerOrigins.length).toBeGreaterThanOrEqual(5);
		const kernelOrigins: string[] = [...OBSERVED_CHANGE_ORIGINS];
		expect(kernelOrigins.sort()).toEqual([...ledgerOrigins, 'hop'].sort());
		for (const origin of ledgerOrigins) expect(isObservedChangeOrigin(origin)).toBe(true);
		expect(isObservedChangeOrigin('none')).toBe(false);
		expect(isObservedChangeOrigin('cascade-owned')).toBe(false);
		expect(refreshDataTrigger({ saved: [b], removed: [], origin: 'hop' })).toBe('changed');
		expect(refreshDataTrigger({ saved: [a], removed: [], before: [a], origin: 'keys' })).toBe(
			'unchanged',
		);
		for (const origin of ['birth', 'replace', 'death', 'recompute'] as const) {
			expect(refreshDataTrigger({ ...changed, origin }), origin).toBe('skipped_origin');
		}
	});
});

describe('the clear, end to end through the save door', () => {
	test('a) person A → B clears the milestone on the HOST: [] stored, one TM pair by the saver; f) not counted as "not covered"', async () => {
		await savePerson([locator(PERSON_FIELD, PERSON, personA)]);
		await setMilestone(milestone1);
		expect(await milestoneOnHost()).toEqual([
			expect.objectContaining({ section_tipo: MILESTONE, section_id: milestone1 }),
		]);
		const tmBefore = (await tmRows(HOST, host, MILESTONE_FIELD)).length;
		const before = snapshot();

		await savePerson([locator(PERSON_FIELD, PERSON, personB)]);

		expect(await milestoneOnHost()).toEqual([]);
		const rows = await tmRows(HOST, host, MILESTONE_FIELD);
		expect(rows.length - tmBefore).toBeGreaterThanOrEqual(1);
		// the newest row is the clear, by the saver, holding nothing
		expect(rows[0]?.user_id).toBe(USER_ID);
		expect(
			rows[0]?.data === null || (Array.isArray(rows[0]?.data) && rows[0]?.data.length === 0),
		).toBe(true);
		const d = delta(before);
		expect(d.observers_server_shape_not_covered).toBe(0);
		expect(d.observers_propagation_failed).toBe(0);
		expect(d.observers_cascade_hop_failed).toBe(0);
		expect(d.observers_cascade_cycle_refused).toBe(0);
		expect(d.observers_refresh_data_unchanged).toBe(0);
		// e) the malformed sibling edge refused exactly once for this save
		expect(d.observers_refresh_data_refused).toBe(1);
		// c) the two person records (B saved, A removed) are not hosts
		expect(d.observers_target_not_host).toBeGreaterThanOrEqual(2);
	}, 60_000);

	test('c) the person records (a foreign section) hold no milestone key and no TM row — PHP’s foreign write is NOT ported', async () => {
		for (const person of [personA, personB]) {
			expect(await relationKey(PERSON, person, MILESTONE_FIELD)).toBeNull();
			expect(await tmRows(PERSON, person, MILESTONE_FIELD)).toEqual([]);
		}
	});

	test('b) person → empty clears the milestone', async () => {
		await setMilestone(milestone2);
		expect(await milestoneOnHost()).toEqual([expect.objectContaining({ section_id: milestone2 })]);
		await savePerson([]);
		expect(await milestoneOnHost()).toEqual([]);
	}, 60_000);

	test('d) a milestone already empty is not written: zero TM rows, no stamp noise', async () => {
		expect(await milestoneOnHost()).toEqual([]);
		const tmBefore = (await tmRows(HOST, host, MILESTONE_FIELD)).length;
		await savePerson([locator(PERSON_FIELD, PERSON, personA)]);
		expect(await milestoneOnHost()).toEqual([]);
		expect((await tmRows(HOST, host, MILESTONE_FIELD)).length).toBe(tmBefore);
	}, 60_000);

	test('g) an UNCHANGED re-save of the person keeps the milestone (counted unchanged, nothing cleared)', async () => {
		// person is A (case d); set a milestone, then re-save the SAME person
		await setMilestone(milestone1);
		expect(await milestoneOnHost()).toEqual([expect.objectContaining({ section_id: milestone1 })]);
		const tmBefore = (await tmRows(HOST, host, MILESTONE_FIELD)).length;
		const before = snapshot();
		await savePerson([locator(PERSON_FIELD, PERSON, personA)]);
		expect(await milestoneOnHost()).toEqual([expect.objectContaining({ section_id: milestone1 })]);
		expect((await tmRows(HOST, host, MILESTONE_FIELD)).length).toBe(tmBefore);
		const d = delta(before);
		expect(d.observers_refresh_data_unchanged).toBeGreaterThanOrEqual(1);
		expect(d.observers_propagation_failed).toBe(0);
	}, 60_000);

	test('e) the malformed edge never writes: its select keeps its value across every person save', async () => {
		await save(MALFORMED, host, [locator(MALFORMED, MILESTONE, milestone2)]);
		const before = snapshot();
		await savePerson([locator(PERSON_FIELD, PERSON, personB)]);
		expect(await relationKey(HOST, host, MALFORMED)).toEqual([
			expect.objectContaining({ section_id: milestone2 }),
		]);
		expect(delta(before).observers_refresh_data_refused).toBe(1);
		// … while the well-formed sibling cleared on the same save (person A → B)
		expect(await milestoneOnHost()).toEqual([]);
	}, 60_000);

	test('h) the clear HOPS: a second-order refresh_data observer of the milestone is cleared by the same person save', async () => {
		// Order matters: setting the milestone propagates to the second-order
		// select (it observes the milestone), so the second-order value is set LAST.
		await setMilestone(milestone1);
		await save(SECOND_ORDER, host, [locator(SECOND_ORDER, MILESTONE, milestone2)]);
		expect(await relationKey(HOST, host, SECOND_ORDER)).toEqual([
			expect.objectContaining({ section_id: milestone2 }),
		]);
		const before = snapshot();

		await savePerson([locator(PERSON_FIELD, PERSON, personA)]);

		expect(await milestoneOnHost()).toEqual([]);
		expect(await relationKey(HOST, host, SECOND_ORDER)).toEqual([]);
		const rows = await tmRows(HOST, host, SECOND_ORDER);
		expect(rows[0]?.user_id).toBe(USER_ID);
		const d = delta(before);
		expect(d.observers_cascade_hop_failed).toBe(0);
		expect(d.observers_cascade_cycle_refused).toBe(0);
		expect(d.observers_propagation_failed).toBe(0);
	}, 60_000);

	test('i) a DUPLICATE keeps the copied milestone: the birth declares the person, but a whole-record write never fires the clear', async () => {
		// host: person A (case h); set the milestone, then clone the record
		await setMilestone(milestone1);
		expect(await milestoneOnHost()).toEqual([expect.objectContaining({ section_id: milestone1 })]);
		const before = snapshot();

		const copy = await duplicateSectionRecord(HOST, host, USER_ID);

		expect(await relationKey(HOST, copy, PERSON_FIELD)).toEqual([
			expect.objectContaining({ section_tipo: PERSON, section_id: personA }),
		]);
		expect(await relationKey(HOST, copy, MILESTONE_FIELD)).toEqual([
			expect.objectContaining({ section_tipo: MILESTONE, section_id: milestone1 }),
		]);
		// no clear row on the copy: nothing in its history holds an emptied milestone
		const emptied = (await tmRows(HOST, copy, MILESTONE_FIELD)).filter(
			(row) => row.data === null || (Array.isArray(row.data) && row.data.length === 0),
		);
		expect(emptied).toEqual([]);
		// the source is untouched too
		expect(await milestoneOnHost()).toEqual([expect.objectContaining({ section_id: milestone1 })]);
		const d = delta(before);
		expect(d.observers_refresh_data_skipped).toBeGreaterThanOrEqual(1);
		expect(d.observers_propagation_failed).toBe(0);
		expect(d.observers_cascade_hop_failed).toBe(0);
	}, 60_000);

	test('j) ONE transaction saving the person and the milestone (a CSV import row) keeps the milestone — in either column order', async () => {
		// host: person A, milestone 1 (case i). Person first, milestone second:
		const before = snapshot();
		await withTransaction(async () => {
			await savePerson([locator(PERSON_FIELD, PERSON, personB)]);
			await setMilestone(milestone2);
		});
		expect(await milestoneOnHost()).toEqual([expect.objectContaining({ section_id: milestone2 })]);
		// Milestone first, person second (PHP cleared it in this order):
		await withTransaction(async () => {
			await setMilestone(milestone1);
			await savePerson([locator(PERSON_FIELD, PERSON, personA)]);
		});
		expect(await milestoneOnHost()).toEqual([expect.objectContaining({ section_id: milestone1 })]);
		const d = delta(before);
		expect(d.observers_refresh_data_skipped).toBeGreaterThanOrEqual(2);
		expect(d.observers_propagation_failed).toBe(0);
		// The SAME person change in its own transaction clears: the shield is the
		// operation's own write, never the column order.
		await savePerson([locator(PERSON_FIELD, PERSON, personB)]);
		expect(await milestoneOnHost()).toEqual([]);
	}, 60_000);

	test('k) a WHOLE-RECORD replace (the Time Machine’s restore door) that changes the person keeps the milestone it restores', async () => {
		// host: person B, milestone [] (case j); "restore" the version (A, milestone 1)
		const stored = (from: string, sectionTipo: string, sectionId: number) => ({
			type: 'dd151',
			section_tipo: sectionTipo,
			section_id: sectionId,
			from_component_tipo: from,
		});
		const before = snapshot();
		expect(
			await persistRecordColumns(
				{ table: await tableOf(HOST), sectionTipo: HOST, sectionId: host },
				{
					relation: {
						[PERSON_FIELD]: [stored(PERSON_FIELD, PERSON, personA)],
						[MILESTONE_FIELD]: [stored(MILESTONE_FIELD, MILESTONE, milestone1)],
					},
				},
				{ userId: USER_ID },
				{ actor: USER_ID },
			),
		).toBe('updated');
		expect(await relationKey(HOST, host, PERSON_FIELD)).toEqual([
			expect.objectContaining({ section_id: personA }),
		]);
		expect(await milestoneOnHost()).toEqual([expect.objectContaining({ section_id: milestone1 })]);
		const d = delta(before);
		expect(d.observers_refresh_data_skipped).toBeGreaterThanOrEqual(1);
		expect(d.observers_propagation_failed).toBe(0);
	}, 60_000);

	test('the clear unit: a slot the operation wrote itself is skipped before any read (the guard’s written set), counted', async () => {
		const guard = {
			depth: 0,
			maxDepth: MAX_CASCADE_DEPTH,
			visited: new Set<string>(),
			recomputed: new Set<string>(),
			resaved: new Set<string>(),
			written: new Set<string>([`${MILESTONE_FIELD}|${HOST}|${String(host)}`]),
			chain: ['gate'],
		};
		const skippedBefore = counter('observers_refresh_data_skipped');
		expect(
			await applyRefreshDataClear(
				MILESTONE_FIELD,
				{ section_tipo: HOST, section_id: host },
				USER_ID,
				new Date(),
				guard,
			),
		).toEqual({ kind: 'self_written' });
		expect(counter('observers_refresh_data_skipped') - skippedBefore).toBe(1);
		// the milestone (case k) stands
		expect(await milestoneOnHost()).toEqual([expect.objectContaining({ section_id: milestone1 })]);
	});

	test('the clear unit: not-host is a counted no-op, an absent slot and an empty slot write nothing, a dedup is a dedup', async () => {
		// clear the milestone first (case k left it set) so the empty-slot leg holds
		await savePerson([locator(PERSON_FIELD, PERSON, personB)]);
		expect(await milestoneOnHost()).toEqual([]);
		const guard = {
			depth: 0,
			maxDepth: MAX_CASCADE_DEPTH,
			visited: new Set<string>(),
			recomputed: new Set<string>(),
			resaved: new Set<string>(),
			chain: ['gate'],
		};
		const now = new Date();
		const notHostBefore = counter('observers_target_not_host');
		expect(
			await applyRefreshDataClear(
				MILESTONE_FIELD,
				{ section_tipo: PERSON, section_id: personA },
				USER_ID,
				now,
				guard,
			),
		).toEqual({ kind: 'not_host' });
		expect(counter('observers_target_not_host') - notHostBefore).toBe(1);
		expect(
			await applyRefreshDataClear(
				MILESTONE_FIELD,
				{ section_tipo: HOST, section_id: host },
				USER_ID,
				now,
				guard,
			),
		).toEqual({ kind: 'already_empty' });
		// the same slot again on the same guard: deduped before any read
		expect(
			await applyRefreshDataClear(
				MILESTONE_FIELD,
				{ section_tipo: HOST, section_id: host },
				USER_ID,
				now,
				guard,
			),
		).toEqual({ kind: 'deduped' });
		expect(
			await applyRefreshDataClear(
				MILESTONE_FIELD,
				{ section_tipo: HOST, section_id: 987654321 },
				USER_ID,
				now,
				guard,
			),
		).toEqual({ kind: 'absent' });
	});
});
