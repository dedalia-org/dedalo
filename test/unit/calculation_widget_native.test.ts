/**
 * calculation widget (component_calculation → component_info) — TS-NATIVE
 * gate. Born as the DEC-14b survival twin of
 * test/parity/calculation_widget_differential.test.ts; since T1-1 (2026-11-12)
 * it is the gate of the PORTED widget: the per-model calculation data
 * (descriptor facet `calculationData`, components/calculation_data.ts), the
 * nine registered formulas and the loud refusals.
 *
 * DIVERGES FROM PHP by owner ruling 2026-11-11 +
 * WC-2026-11-12-calculation-widget-port: a NON-EMPTY input is SUMMED (PHP crashed in array_sum on the
 * flat string its base get_calculation_data returned — the old pin here was
 * that crash's effective outcome, `[]`).
 *
 * Contracts (records built at runtime on the `test` twins of the shipped
 * calculation nodes — every situation built here, nothing read from ambient
 * data):
 *  - SAVE: saving a metal number (test6250 = 40.5) persists to the `number`
 *    column while the test6523 calculation output stays NULL in every
 *    candidate column (DEC-06: nothing is computed at save time).
 *  - C1 number sum: test6523 sums the metals (float, precision 2).
 *  - C2 date summarize: start + period → the date in the start's shape;
 *    pre-1970 years; a period with no anchor date → null (test1225, test4473).
 *  - C3 range_to_days, C4 days_correction_manually (test4334: test4346/test4822).
 *  - C5 relation inputs: a portal + ddo_map `get_calculation_data` leaf
 *    (test4627 over test4333 → test4822) and a plain number leaf (test4593 over
 *    test4591 → test4587, v6 dato parity).
 *  - C6 the grant chain on one host: calculate_period, calculate_import_major/
 *    minor, to_euros, subtract (a non-zero difference), final_total (minor +
 *    manual branches). A NEW grant (no day rows) opens through the wire: the
 *    summarized 0 runs the import formula, as PHP's float 0.0 did.
 *  - OD-2 / OD-1 boundaries: an import with no day value at all, and the
 *    contested major-grant callers (options.major_section_tipos, the PHP
 *    hard-coded section), refuse until ruled; an uncontested caller is minor.
 *  - C7 refusals on a scratch zz situation: unknown fn, no process, info
 *    cycle, aggregate scope, filter:true, relation input without ddo_map, a
 *    model without the facet — plus the int summarize over two numbers.
 *  - C9 the dd_date ↔ unix seconds math (years 0–99 are real years).
 *
 * Scratch hygiene: every record this gate creates (rows, TM rows and its
 * activity rows) is swept fail-loud in afterAll; the zz situation is dropped
 * to zero residue.
 *
 * @twin-of      test/parity/calculation_widget_differential.test.ts
 * @twin-status  retired
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rule). Install tipos
// were replaced by their twins from src/core/test_data/test_tld_tipo_map.json; the
// seed-shipped ones (rsc/dd/hierarchy/ontology/lg) have no twin and stay, because they
// ship with every installation.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import {
	CALCULATION_FUNCTIONS,
	PHP_MAJOR_GRANT_SECTION,
} from '../../src/core/components/component_info/widgets/calculation/functions.ts';
import { computeInfoWidgets } from '../../src/core/components/component_info/widgets/registry.ts';
import {
	ddDateFromUnixSeconds,
	ddDateToUnixSeconds,
} from '../../src/core/concepts/dd_date_time.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { sweepActivityRows } from '../helpers/activity_rows.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const SECTION = 'test6247'; // metal analyses
const INPUT = 'test6250'; // 'au' number
const INPUT_AG = 'test6251'; // 'ag' number
const OUTPUT = 'test6523'; // 'total' calculation (summarize float)

// date summarize hosts (twins of dmm262 / mdcat2096)
const DATE_HOST = 'test1030';
const DATE_START = 'test1224';
const DATE_PERIOD = 'test1226';
const DATE_TOTAL = 'test1225';
const DATE_HOST_B = 'test4457';
const DATE_B_START = 'test4471';
const DATE_B_PERIOD = 'test4472';
const DATE_B_TOTAL = 'test4473';

// days (twins of mdcat1957 / mdcat1968 / mdcat1969 / mdcat2918 / mdcat2919)
const DAYS = 'test4334';
const DAYS_RANGE = 'test4345'; // component_date start/end
const DAYS_COUNT = 'test4346'; // range_to_days
const DAYS_MANUAL = 'test4821'; // component_number
const DAYS_TOTAL = 'test4822'; // days_correction_manually

// grant host (twin of the mdcat grant section)
const GRANT = 'test4308';
const GRANT_DAYS_PORTAL = 'test4333'; // → DAYS
const GRANT_EXTRA_DAYS_PORTAL = 'test4354'; // → DAYS (test4686 → test4634 → test4636)
const HEIRS_PORTAL = 'test4591'; // → HEIR
const HEIR = 'test4583';
const HEIR_AMOUNT = 'test4587'; // component_number
const GRANT_IMPORT_MANUAL = 'test4661';
const GRANT_PAID = 'test4663';

type Columns = Record<string, Record<string, unknown>>;

/** Every record this gate creates, for the fail-loud sweep. */
const created: { section: string; id: number }[] = [];

async function rootContext(): Promise<Record<string, unknown>> {
	const token = createSession(-1, 'root', true);
	const session = getSession(token);
	const principal = await resolvePrincipal(-1);
	return {
		requestId: 'calculation_native_test',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal,
	};
}

/** Create a record and write its component columns (merged per column). */
async function record(section: string, columns: Columns = {}): Promise<number> {
	await assertTestDatabase('calculation_widget_native record');
	const id = await createSectionRecord(section, -1);
	created.push({ section, id });
	const table = await getMatrixTableFromTipo(section);
	for (const [column, value] of Object.entries(columns)) {
		await sql.unsafe(
			`UPDATE ${table} SET ${column} = COALESCE(${column}, '{}'::jsonb) || $1::text::jsonb
			 WHERE section_tipo = $2 AND section_id = $3`,
			[JSON.stringify(value), section, id],
		);
	}
	return id;
}

const number = (value: number) => [{ id: 1, value }];
const locator = (from: string, section: string, id: number) => ({
	type: 'dd151',
	section_tipo: section,
	section_id: id,
	from_component_tipo: from,
});

/** The differential's exact SAVE RQO (PHP-verified wire shape). */
function saveRqo(id: number): Record<string, unknown> {
	const item = { id: 1, value: 40.5 };
	return {
		action: 'save',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			typo: 'source',
			type: 'component',
			model: 'component_number',
			tipo: INPUT,
			section_tipo: SECTION,
			section_id: String(id),
			mode: 'edit',
			lang: 'lg-nolan',
			action: null,
		},
		data: {
			section_id: String(id),
			section_tipo: SECTION,
			tipo: INPUT,
			lang: 'lg-nolan',
			from_component_tipo: INPUT,
			value: [item],
			changed_data: [{ action: 'set_data', key: null, value: [item] }],
		},
	};
}

/** A list READ of one component of one record, through the wire. */
function readRqo(section: string, id: number, tipo: string): Record<string, unknown> {
	return {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		options: {},
		source: {
			typo: 'source',
			model: 'section',
			tipo: section,
			section_tipo: section,
			action: 'search',
			mode: 'list',
			lang: 'lg-spa',
		},
		sqo: {
			section_tipo: [section],
			limit: 1,
			offset: 0,
			filter_by_locators: [{ section_tipo: section, section_id: String(id) }],
		},
		show: { ddo_map: [{ tipo, section_tipo: section, parent: section, mode: 'list' }] },
	};
}

/** The differential's stateOf: input column + every candidate output column. */
async function stateOf(id: number): Promise<Record<string, unknown>> {
	const rows = (await sql.unsafe(
		`SELECT number->$2 AS input,
		        COALESCE(data->$3, number->$3, misc->$3) AS output
		 FROM matrix_test WHERE section_tipo = $1 AND section_id = $4`,
		[SECTION, INPUT, OUTPUT, id],
	)) as { input: unknown; output: unknown }[];
	return { input: rows[0]?.input ?? null, output: rows[0]?.output ?? null };
}

/** The served entries of one component (one row), through dispatchRqo. */
async function entriesOf(section: string, id: number, tipo: string): Promise<unknown> {
	const context = await rootContext();
	const response = (
		await dispatchRqo(structuredClone(readRqo(section, id, tipo)) as never, context as never)
	).body as {
		ok?: boolean;
		error?: unknown;
		data?: { data?: { tipo?: string; entries?: unknown }[] };
	};
	if (response.ok === false) throw new Error(`read refused: ${JSON.stringify(response.error)}`);
	return (response.data?.data ?? []).find((item) => item.tipo === tipo)?.entries;
}

/** One `total` item as served (WC-026 dual keys). */
const totalItem = (value: unknown, key = 0) => ({
	widget: 'calculation',
	key,
	id: 'total',
	widget_id: 'total',
	value,
});

/** The served value of the `total` output. */
async function totalOf(section: string, id: number, tipo: string): Promise<unknown> {
	const entries = (await entriesOf(section, id, tipo)) as { id?: string; value?: unknown }[];
	return entries.find((item) => item.id === 'total')?.value;
}

/** The engine compute of one calculation, without the wire (refusal legs). */
function compute(tipo: string, sectionTipo: string, sectionId: number) {
	return computeInfoWidgets(tipo, { sectionTipo, sectionId, mode: 'list', lang: 'lg-nolan' });
}

/** One registered process fn (a pure call, no record). */
function formula(name: string) {
	const fn = CALCULATION_FUNCTIONS[name];
	if (fn === undefined) throw new Error(`calculation fn '${name}' is not registered`);
	return fn;
}

/** The DedaloError code a compute rejects with (fails loud when it resolves). */
async function refusalOf(
	promise: Promise<unknown>,
): Promise<{ code: string; coordinates: unknown }> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof DedaloError) return { code: error.code, coordinates: error.coordinates };
		throw error;
	}
	throw new Error('expected a refusal, the compute resolved');
}

// --- refusal / int situation (scratch zz TLD) --------------------------------

const ZZ = 'zzcalc';
const ZZ_HOST = 'zzcalc1';
const ZZ_NUM_A = 'zzcalc2';
const ZZ_NUM_B = 'zzcalc3';
const ZZ_TEXT = 'zzcalc4';
const ZZ_PORTAL = 'zzcalc5';
const ZZ_INT_SUM = 'zzcalc6';
const ZZ_UNKNOWN_FN = 'zzcalc7';
const ZZ_NO_PROCESS = 'zzcalc8';
const ZZ_CYCLE_A = 'zzcalc9';
const ZZ_CYCLE_B = 'zzcalc10';
const ZZ_SCOPE_ALL = 'zzcalc11';
const ZZ_FILTER = 'zzcalc12';
const ZZ_NO_DDO_MAP = 'zzcalc13';
const ZZ_NO_FACET = 'zzcalc14';
const ZZ_SUM_A = 'zzcalc15';
const ZZ_SUBTRACT = 'zzcalc16';
const ZZ_FINAL_MINOR = 'zzcalc17';
const ZZ_FINAL_MAJOR_OPTION = 'zzcalc18';
const ZZ_ID = 1;

/** A component_info node with ONE calculation ipo block. */
function calcNode(tipo: string, block: Record<string, unknown>) {
	return {
		tipo,
		parent: ZZ_HOST,
		model: 'component_info',
		properties: {
			widgets: [
				{
					widget_name: 'calculation',
					path: '/calculation',
					ipo: [{ output: [{ id: 'total' }], ...block }],
				},
			],
		},
	};
}

const summarize = (components: unknown[], extra: Record<string, unknown> = {}) => ({
	input: { section_tipo: 'current', section_id: 'current', filter: false, components, ...extra },
	process: { fn: 'summarize', options: { type: 'int' } },
});

const finalTotal = (options?: Record<string, unknown>) => ({
	input: summarize([
		{ tipo: ZZ_NUM_A, var_name: 'total_major' },
		{ tipo: ZZ_NUM_B, var_name: 'total_minor' },
	]).input,
	process: options === undefined ? { fn: 'final_total' } : { fn: 'final_total', options },
});

const S = situation({
	name: 'calculation widget refusals',
	tld: ZZ,
	nodes: [
		{ tipo: ZZ_HOST, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{ tipo: ZZ_NUM_A, parent: ZZ_HOST, model: 'component_number' },
		{ tipo: ZZ_NUM_B, parent: ZZ_HOST, model: 'component_number' },
		{ tipo: ZZ_TEXT, parent: ZZ_HOST, model: 'component_input_text' },
		{ tipo: ZZ_PORTAL, parent: ZZ_HOST, model: 'component_portal' },
		calcNode(
			ZZ_INT_SUM,
			summarize([
				{ tipo: ZZ_NUM_A, var_name: 'a' },
				{ tipo: ZZ_NUM_B, var_name: 'b' },
			]),
		),
		calcNode(ZZ_UNKNOWN_FN, {
			...summarize([{ tipo: ZZ_NUM_A, var_name: 'a' }]),
			process: { fn: 'nope' },
		}),
		calcNode(ZZ_NO_PROCESS, { input: summarize([{ tipo: ZZ_NUM_A, var_name: 'a' }]).input }),
		calcNode(ZZ_CYCLE_A, summarize([{ tipo: ZZ_CYCLE_B, var_name: 'b' }])),
		calcNode(ZZ_CYCLE_B, summarize([{ tipo: ZZ_CYCLE_A, var_name: 'a' }])),
		calcNode(ZZ_SCOPE_ALL, summarize([{ tipo: ZZ_NUM_A, var_name: 'a' }], { section_id: 'all' })),
		calcNode(ZZ_FILTER, summarize([{ tipo: ZZ_NUM_A, var_name: 'a' }], { filter: true })),
		calcNode(ZZ_NO_DDO_MAP, summarize([{ tipo: ZZ_PORTAL, var_name: 'p' }])),
		calcNode(ZZ_NO_FACET, summarize([{ tipo: ZZ_TEXT, var_name: 't' }])),
		// subtract over two INFO inputs (bare scalars): 6 − 2.
		calcNode(ZZ_SUM_A, summarize([{ tipo: ZZ_NUM_A, var_name: 'a' }])),
		calcNode(ZZ_SUBTRACT, {
			input: summarize([
				{ tipo: ZZ_INT_SUM, var_name: 'total' },
				{ tipo: ZZ_SUM_A, var_name: 'total_period' },
			]).input,
			process: { fn: 'subtract' },
		}),
		// final_total: major 2.4 > 0 — the minor branch (3.3) unless OD-1 contests the caller.
		calcNode(ZZ_FINAL_MINOR, finalTotal()),
		calcNode(ZZ_FINAL_MAJOR_OPTION, finalTotal({ major_section_tipos: [ZZ_HOST] })),
	],
	records: [
		{
			section_tipo: ZZ_HOST,
			section_id: ZZ_ID,
			columns: {
				number: { [ZZ_NUM_A]: number(2.4), [ZZ_NUM_B]: number(3.3) },
				string: { [ZZ_TEXT]: [{ id: 1, lang: 'lg-nolan', value: '7' }] },
			},
		},
	],
});

// --- fixture records ---------------------------------------------------------

let savedId = 0;
let emptyId = 0;
let twoMetalsId = 0;
let savedState: Record<string, unknown> = {};
const ids = {
	date: 0,
	dateYear: 0,
	periodOnly: 0,
	dateB: 0,
	days: 0,
	daysManual: 0,
	daysStartOnly: 0,
	heirA: 0,
	heirB: 0,
	grant: 0,
	grantManual: 0,
	grantNoDays: 0,
	grantPeriod: 0,
	daysExtra: 0,
};

beforeAll(async () => {
	await ensureSituation(S);

	savedId = await record(SECTION);
	emptyId = await record(SECTION);
	twoMetalsId = await record(SECTION, {
		number: { [INPUT]: number(40.5), [INPUT_AG]: number(2.25) },
	});
	const context = await rootContext();
	await dispatchRqo(structuredClone(saveRqo(savedId)) as never, context as never);
	savedState = await stateOf(savedId);

	// C2 dates
	ids.date = await record(DATE_HOST, {
		date: {
			[DATE_START]: [{ id: 1, start: { year: 2020, month: 1, day: 15 } }],
			[DATE_PERIOD]: [{ id: 1, period: { month: 5 } }],
		},
	});
	ids.dateYear = await record(DATE_HOST, {
		date: {
			[DATE_START]: [{ id: 1, start: { year: 1936 } }],
			[DATE_PERIOD]: [{ id: 1, period: { year: 2 } }],
		},
	});
	ids.periodOnly = await record(DATE_HOST, {
		date: { [DATE_PERIOD]: [{ id: 1, period: { month: 5 } }] },
	});
	ids.dateB = await record(DATE_HOST_B, {
		date: {
			[DATE_B_START]: [{ id: 1, start: { year: 2020, month: 1, day: 15 } }],
			[DATE_B_PERIOD]: [{ id: 1, period: { day: 20 } }],
		},
	});

	// C3 / C4 days
	const range = [
		{ id: 1, start: { year: 2020, month: 1, day: 1 }, end: { year: 2020, month: 3, day: 1 } },
	];
	ids.days = await record(DAYS, { date: { [DAYS_RANGE]: range } });
	ids.daysManual = await record(DAYS, {
		date: { [DAYS_RANGE]: range },
		number: { [DAYS_MANUAL]: number(45) },
	});
	ids.daysStartOnly = await record(DAYS, {
		date: { [DAYS_RANGE]: [{ id: 1, start: { year: 2020, month: 1, day: 1 } }] },
	});

	// C5 / C6 grant hosts
	ids.heirA = await record(HEIR, { number: { [HEIR_AMOUNT]: number(7) } });
	ids.heirB = await record(HEIR, { number: { [HEIR_AMOUNT]: number(5) } });
	const daysLocators = [
		locator(GRANT_DAYS_PORTAL, DAYS, ids.days),
		locator(GRANT_DAYS_PORTAL, DAYS, ids.daysManual),
	];
	ids.grant = await record(GRANT, {
		relation: {
			[GRANT_DAYS_PORTAL]: daysLocators,
			[HEIRS_PORTAL]: [
				locator(HEIRS_PORTAL, HEIR, ids.heirA),
				locator(HEIRS_PORTAL, HEIR, ids.heirB),
			],
		},
		number: { [GRANT_PAID]: number(100) },
	});
	ids.grantManual = await record(GRANT, {
		relation: { [GRANT_DAYS_PORTAL]: daysLocators },
		number: { [GRANT_PAID]: number(100), [GRANT_IMPORT_MANUAL]: number(1000) },
	});
	ids.grantNoDays = await record(GRANT);
	// total (test4636, over 105 + 100 days = 7 months) ≠ total_period (test4629, 105 days).
	ids.daysExtra = await record(DAYS, {
		date: { [DAYS_RANGE]: range },
		number: { [DAYS_MANUAL]: number(100) },
	});
	ids.grantPeriod = await record(GRANT, {
		relation: {
			[GRANT_DAYS_PORTAL]: daysLocators,
			[GRANT_EXTRA_DAYS_PORTAL]: [locator(GRANT_EXTRA_DAYS_PORTAL, DAYS, ids.daysExtra)],
		},
	});
}, 120000);

afterAll(async () => {
	const leaked: string[] = [];
	const bySection = new Map<string, number[]>();
	for (const { section, id } of created) {
		const table = await getMatrixTableFromTipo(section);
		const deleted = (await sql.unsafe(
			`DELETE FROM ${table} WHERE section_tipo = $1 AND section_id = $2 RETURNING id`,
			[section, id],
		)) as unknown[];
		if (deleted.length === 0) leaked.push(`${section}/${id}`);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[section, id],
		);
		bySection.set(section, [...(bySection.get(section) ?? []), id]);
	}
	for (const [section, sectionIds] of bySection) await sweepActivityRows(section, sectionIds);
	const residue = await dropSituation(S);
	if (leaked.length > 0) throw new Error(`cleanup leaked scratch rows: ${leaked.join(', ')}`);
	expect(residue).toBe(0);
});

describe('calculation widget — SAVE computes nothing (DEC-06)', () => {
	test('SAVE persists the number; the calculation output stays null', () => {
		expect(savedState).toEqual({ input: [{ id: 1, value: 40.5 }], output: null });
	});
});

describe('C1 summarize over component_number (owner ruling 2026-11-11)', () => {
	test('EMPTY inputs emit the total:0 golden (WC-026 keys)', async () => {
		expect(await entriesOf(SECTION, emptyId, OUTPUT)).toEqual([totalItem(0)]);
	});

	test('a non-empty input is SUMMED — the PHP crash is not ported', async () => {
		expect(await entriesOf(SECTION, savedId, OUTPUT)).toEqual([totalItem(40.5)]);
		expect(await entriesOf(SECTION, twoMetalsId, OUTPUT)).toEqual([totalItem(42.75)]);
	});

	test('type int rounds the sum to 0 decimals', async () => {
		expect(await compute(ZZ_INT_SUM, ZZ_HOST, ZZ_ID)).toEqual([
			{ widget: 'calculation', key: 0, id: 'total', value: 6 },
		]);
	});
});

describe('C2 summarize type date', () => {
	test('start + period month → the date in the start shape', async () => {
		expect(await totalOf(DATE_HOST, ids.date, DATE_TOTAL)).toEqual({
			year: 2020,
			month: 6,
			day: 15,
		});
		expect(await totalOf(DATE_HOST_B, ids.dateB, DATE_B_TOTAL)).toEqual({
			year: 2020,
			month: 2,
			day: 4,
		});
	});

	test('a year-only pre-1970 start stays year-only', async () => {
		expect(await totalOf(DATE_HOST, ids.dateYear, DATE_TOTAL)).toEqual({ year: 1938 });
	});

	test('a period with no anchor date → value null', async () => {
		expect(await entriesOf(DATE_HOST, ids.periodOnly, DATE_TOTAL)).toEqual([totalItem(null)]);
	});
});

describe('C3 range_to_days / C4 days_correction_manually', () => {
	test('a two-month range is 60 days; a range without end is 1', async () => {
		expect(await totalOf(DAYS, ids.days, DAYS_COUNT)).toBe(60);
		expect(await totalOf(DAYS, ids.daysStartOnly, DAYS_COUNT)).toBe(1);
	});

	test('the manual day count wins when set', async () => {
		expect(await totalOf(DAYS, ids.days, DAYS_TOTAL)).toBe(60);
		expect(await totalOf(DAYS, ids.daysManual, DAYS_TOTAL)).toBe(45);
	});
});

describe('C5 relation inputs walk the ddo_map', () => {
	test('portal → get_calculation_data leaf sums each target info', async () => {
		expect(await totalOf(GRANT, ids.grant, 'test4627')).toBe(105);
	});

	test('portal → plain number leaf sums the item values (v6 parity)', async () => {
		expect(await totalOf(GRANT, ids.grant, 'test4593')).toBe(12);
	});
});

describe('C6 the grant chain', () => {
	test('calculate_period buckets the 105 days', async () => {
		expect(await entriesOf(GRANT, ids.grant, 'test4628')).toEqual([
			{ widget: 'calculation', key: 0, id: 'months', widget_id: 'months', value: 3 },
			{ widget: 'calculation', key: 0, id: 'days', widget_id: 'days', value: 13 },
		]);
	});

	test('import major / minor, to_euros, subtract', async () => {
		expect(await totalOf(GRANT, ids.grant, 'test4629')).toBe(150000);
		expect(await totalOf(GRANT, ids.grant, 'test4655')).toBe(900);
		expect(await totalOf(GRANT, ids.grant, 'test4630')).toBe(901.52);
		expect(await totalOf(GRANT, ids.grant, 'test4634')).toBe(105);
		expect(await totalOf(GRANT, ids.grant, 'test4688')).toBe(0);
	});

	test('final_total: minor − paid; a manual import wins', async () => {
		expect(await totalOf(GRANT, ids.grant, 'test4664')).toBe(800);
		expect(await totalOf(GRANT, ids.grantManual, 'test4664')).toBe(900);
	});

	test('subtract: total − total_period over info inputs (a non-zero difference)', async () => {
		expect(await totalOf(GRANT, ids.grantPeriod, 'test4634')).toBe(205);
		expect(await totalOf(GRANT, ids.grantPeriod, 'test4636')).toBe(178000);
		expect(await totalOf(GRANT, ids.grantPeriod, 'test4629')).toBe(150000);
		expect(await totalOf(GRANT, ids.grantPeriod, 'test4688')).toBe(28000);
		expect(await compute(ZZ_SUBTRACT, ZZ_HOST, ZZ_ID)).toEqual([
			{ widget: 'calculation', key: 0, id: 'total', value: 4 },
		]);
	});

	test('a NEW grant (no day rows) opens: the summarized 0 runs the formula (PHP 0.0)', async () => {
		// PHP summarize ends in round() → float; array_sum([0.0]) === 0 is false, so
		// the import formula served its minimum — the record read never failed.
		expect(await totalOf(GRANT, ids.grantNoDays, 'test4627')).toBe(0);
		expect(await totalOf(GRANT, ids.grantNoDays, 'test4629')).toBe(150000);
		expect(await totalOf(GRANT, ids.grantNoDays, 'test4655')).toBe(900);
		expect(await totalOf(GRANT, ids.grantNoDays, 'test4664')).toBe(900);
	});

	test('OD-2: an import with NO day value at all (PHP int 0 → crash) refuses', async () => {
		const args = { options: {}, callerSectionTipo: ZZ_HOST };
		for (const totalDays of [undefined, null, []]) {
			let refusal: unknown = null;
			try {
				formula('calculate_import_minor')({ ...args, dataMap: { total_days: totalDays } });
			} catch (error) {
				refusal = error instanceof DedaloError ? [error.code, error.coordinates] : error;
			}
			expect(refusal).toEqual(['engine.uncovered_scope', { fn: 'calculate_import_minor' }]);
		}
		expect(formula('calculate_import_major')({ ...args, dataMap: { total_days: [0] } })).toEqual([
			{ id: 'total', value: 150000 },
		]);
	});

	test('OD-1: a caller nobody contests takes the minor branch', async () => {
		expect(await compute(ZZ_FINAL_MINOR, ZZ_HOST, ZZ_ID)).toEqual([
			{ widget: 'calculation', key: 0, id: 'total', value: 3.3 },
		]);
	});

	test('OD-1: options.major_section_tipos and the PHP-hard-coded section refuse', async () => {
		expect(await refusalOf(compute(ZZ_FINAL_MAJOR_OPTION, ZZ_HOST, ZZ_ID))).toEqual({
			code: 'engine.uncovered_scope',
			coordinates: { fn: 'final_total', section_tipo: ZZ_HOST },
		});
		const dataMap = { total_major: [2.4], total_minor: [3.3] };
		let refusal: unknown = null;
		try {
			formula('final_total')({
				dataMap,
				options: {},
				callerSectionTipo: PHP_MAJOR_GRANT_SECTION,
			});
		} catch (error) {
			refusal = error instanceof DedaloError ? error.code : error;
		}
		expect(refusal).toBe('engine.uncovered_scope');
		// No major amount → no contest: the minor branch, even for that section.
		expect(
			formula('final_total')({
				dataMap: { total_major: [0], total_minor: [3.3] },
				options: {},
				callerSectionTipo: PHP_MAJOR_GRANT_SECTION,
			}),
		).toEqual([{ id: 'total', value: 3.3 }]);
	});
});

describe('C7 loud refusals (never a silently blank value)', () => {
	test('an unregistered process fn', async () => {
		const refusal = await refusalOf(compute(ZZ_UNKNOWN_FN, ZZ_HOST, ZZ_ID));
		expect(refusal).toEqual({
			code: 'ontology.invalid_node',
			coordinates: { ipo_key: 0, fn: 'nope' },
		});
	});

	test('a block without process', async () => {
		expect((await refusalOf(compute(ZZ_NO_PROCESS, ZZ_HOST, ZZ_ID))).code).toBe(
			'ontology.invalid_node',
		);
	});

	test('an info ↔ info cycle', async () => {
		const refusal = await refusalOf(compute(ZZ_CYCLE_A, ZZ_HOST, ZZ_ID));
		expect(refusal.code).toBe('ontology.invalid_node');
		expect(String((refusal.coordinates as { chain?: unknown }).chain)).toContain(
			`${ZZ_CYCLE_B}@${ZZ_HOST}/${ZZ_ID}`,
		);
	});

	test("the aggregate scope 'all' and filter:true are uncovered", async () => {
		expect((await refusalOf(compute(ZZ_SCOPE_ALL, ZZ_HOST, ZZ_ID))).code).toBe(
			'engine.uncovered_scope',
		);
		expect((await refusalOf(compute(ZZ_FILTER, ZZ_HOST, ZZ_ID))).code).toBe(
			'engine.uncovered_scope',
		);
	});

	test('a relation input without ddo_map; a model without the facet', async () => {
		expect((await refusalOf(compute(ZZ_NO_DDO_MAP, ZZ_HOST, ZZ_ID))).code).toBe(
			'ontology.invalid_node',
		);
		const noFacet = await refusalOf(compute(ZZ_NO_FACET, ZZ_HOST, ZZ_ID));
		expect(noFacet).toEqual({
			code: 'engine.uncovered_scope',
			coordinates: { tipo: ZZ_TEXT, model: 'component_input_text' },
		});
	});
});

describe('C9 dd_date ↔ unix seconds (one home: concepts/dd_date_time.ts)', () => {
	test('years 0–99 are real years, not 1900+year', () => {
		expect(ddDateToUnixSeconds({ year: 50, month: 1, day: 1 })).toBe(-60589296000);
	});

	test('a pre-1970 date round-trips', () => {
		const seconds = ddDateToUnixSeconds({ year: 1936, month: 7, day: 18 });
		expect(seconds).toBe(-1055808000);
		expect(ddDateFromUnixSeconds(seconds)).toEqual({
			year: 1936,
			month: 7,
			day: 18,
			hour: 0,
			minute: 0,
			second: 0,
		});
	});
});
