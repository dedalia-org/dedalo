/**
 * CHECK `record_missing_defaults` — the records whose default-bearing component
 * holds no value (T2-SL-7; owner ruling Q3 / O14, 2026-11-19).
 *
 * THE LAW. A component's ontology default (`properties.dato_default`) is
 * written when the record is CREATED and never afterwards — a read never
 * writes (WC-2026-08-09-record-birth-defaults; Dédalo v6 seeded when an edit
 * form was first built). So a record that existed before its section declared
 * the default, or a v6 record nobody opened, lacks the value. The engine does
 * not repair that: this check LISTS those records, and the operator fills the
 * ones they mean to with the propagate tool.
 *
 * THE OUTCOMES PINNED (a `zzrmd` scratch TLD on `test1` → matrix_test, built
 * here and dropped):
 *   - the CREATE door seeds both declared defaults (the control: a born record
 *     is never reported);
 *   - a record whose key is absent, null or an empty array is reported per
 *     component, with the full count and its id; a key holding a value — the
 *     default or any other — is not;
 *   - a component with NO declared default is never reported, however empty;
 *   - the project filter is not part of the check;
 *   - opening the record in EDIT writes nothing: the report is unchanged
 *     (the v6 retro-seed is not reproduced);
 *   - the run writes nothing (records and Time Machine rows byte-equal), and an
 *     APPLY is refused at the registry before the check runs;
 *   - the scope narrows the scan to the named sections.
 * assertTestDatabase before the first write.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { registerAllReconciles } from '../../src/core/reconcile/catalog.ts';
import { applyPolicyOf, getReconcile, runReconcile } from '../../src/core/reconcile/registry.ts';
import { readSection } from '../../src/core/section/read.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import {
	type MissingDefaultsSummary,
	RECORD_MISSING_DEFAULTS,
} from '../../src/core/section/record/missing_default_check.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { refusalOf } from '../helpers/refusal.ts';

const TLD = 'zzrmd';
const SECTION = `${TLD}1`;
const TEXT = `${TLD}2`; // component_input_text, default 'seeded'
const FLAG = `${TLD}3`; // component_radio_button, default dd64/2 ("No")
const PLAIN = `${TLD}4`; // component_input_text, NO default
const OTHER_SECTION = `${TLD}5`; // a second section, to prove the scope
const OTHER_TEXT = `${TLD}6`;
const TABLE = 'matrix_test';
/** Records of the other section, all without its default: one past the listed sample of 50. */
const OTHER_RECORDS = 51;

const SITUATION = situation({
	tld: TLD,
	name: 'record_missing_defaults',
	nodes: [
		{ tipo: SECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'Defaults' } },
		{
			tipo: TEXT,
			parent: SECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Text with a default' },
			properties: { dato_default: 'seeded' },
		},
		{
			tipo: FLAG,
			parent: SECTION,
			model: 'component_radio_button',
			term: { 'lg-eng': 'Flag with a default' },
			properties: { dato_default: [{ section_id: 2, section_tipo: 'dd64' }] },
		},
		{
			tipo: PLAIN,
			parent: SECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Text without a default' },
		},
		{ tipo: OTHER_SECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'Other' } },
		{
			tipo: OTHER_TEXT,
			parent: OTHER_SECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Other text with a default' },
			properties: { dato_default: 'other' },
		},
	],
});

/** A record as a door WITHOUT birth defaults left it (a v6 row, an older ontology). */
async function bareRecord(
	sectionTipo: string,
	columns: { string?: Record<string, unknown>; relation?: Record<string, unknown> } = {},
): Promise<number> {
	const id = await createSectionRecord(sectionTipo, -1);
	await sql.unsafe(
		`UPDATE "${TABLE}" SET string = $3::text::jsonb, relation = $4::text::jsonb
		  WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, id, JSON.stringify(columns.string ?? {}), JSON.stringify(columns.relation ?? {})],
	);
	return id;
}

async function report(scope: readonly string[] = [SECTION]): Promise<MissingDefaultsSummary> {
	const { report: run } = await runReconcile(RECORD_MISSING_DEFAULTS, { apply: false, scope });
	return run.detail as unknown as MissingDefaultsSummary;
}

/** Every stored byte the check could have touched, as one string. */
async function storedBytes(): Promise<string> {
	const records = await sql.unsafe(
		`SELECT section_tipo, section_id, string::text AS s, relation::text AS r, data::text AS d
		   FROM "${TABLE}" WHERE section_tipo = ANY(string_to_array($1, ',')) ORDER BY 1, 2`,
		[`${SECTION},${OTHER_SECTION}`],
	);
	const history = await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = ANY(string_to_array($1, ','))`,
		[`${SECTION},${OTHER_SECTION}`],
	);
	return JSON.stringify([records, history]);
}

let born = 0;
let absent = 0;
let emptied = 0;
let filled = 0;

beforeAll(async () => {
	await assertTestDatabase('record_missing_defaults_native');
	await ensureSituation(SITUATION);
	await registerAllReconciles();
	// CONTROL: the create door seeds both defaults.
	born = await createSectionRecord(SECTION, -1);
	// Both keys absent — and PLAIN absent too (no default: never reported).
	absent = await bareRecord(SECTION);
	// The text key an EMPTY ARRAY, the flag key a JSON null.
	emptied = await bareRecord(SECTION, { string: { [TEXT]: [] }, relation: { [FLAG]: null } });
	// Both keys hold a value that is NOT the default: written by someone, not this check's.
	filled = await bareRecord(SECTION, {
		string: { [TEXT]: [{ id: 1, lang: 'lg-nolan', value: 'curated' }] },
		relation: {
			[FLAG]: [
				{ id: 1, type: 'dd151', section_id: 1, section_tipo: 'dd64', from_component_tipo: FLAG },
			],
		},
	});
	// The other section: ONE more record than a finding lists ids for, so the
	// count is proven to be the full count, not the size of the listed sample.
	await sql.unsafe(
		`INSERT INTO "${TABLE}" (section_id, section_tipo)
		 SELECT id, $1 FROM generate_series($2::int, 1, -1) AS id`, // descending: the report's order is its own
		[OTHER_SECTION, OTHER_RECORDS],
	);
}, 60_000);

afterAll(async () => {
	for (const section of [SECTION, OTHER_SECTION]) {
		await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1', [section]);
		await sql.unsafe('DELETE FROM dedalo_ts_record_generation WHERE section_tipo = $1', [section]);
		await sql.unsafe(`DELETE FROM "${TABLE}" WHERE section_tipo = $1`, [section]);
		await sql.unsafe(`DELETE FROM matrix_activity WHERE data->>'section_tipo' = $1`, [section]);
	}
	expect(await dropSituation(SITUATION)).toBe(0);
}, 60_000);

describe('record_missing_defaults — report-only census of records lacking a declared default', () => {
	test('CONTROL: the create door seeded both defaults on the born record', async () => {
		const rows = (await sql.unsafe(
			`SELECT string->$3 AS text, relation->$4 AS flag FROM "${TABLE}"
			  WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, born, TEXT, FLAG],
		)) as { text: { value?: unknown }[] | null; flag: { section_id?: unknown }[] | null }[];
		expect(rows[0]?.text?.map((item) => item.value)).toEqual(['seeded']);
		expect(rows[0]?.flag?.map((item) => Number(item.section_id))).toEqual([2]);
	});

	test('absent, null and empty-array keys are reported per component; a held value and a born record are not', async () => {
		const summary = await report();
		expect(summary.scanned).toBe(1);
		expect(summary.unreadable).toEqual([]);
		expect(summary.findings).toEqual([
			{
				section_tipo: SECTION,
				tipo: TEXT,
				model: 'component_input_text',
				missing: 2,
				section_ids: [absent, emptied],
			},
			{
				section_tipo: SECTION,
				tipo: FLAG,
				model: 'component_radio_button',
				missing: 2,
				section_ids: [absent, emptied],
			},
		]);
		// One unit per (record, component); PLAIN (no default) is never part of it.
		expect(summary.drift).toBe(4);
		expect(JSON.stringify(summary)).not.toContain(PLAIN);
		expect(summary.findings.flatMap((finding) => finding.section_ids)).not.toContain(born);
		expect(summary.findings.flatMap((finding) => finding.section_ids)).not.toContain(filled);
	}, 30_000);

	test('the SCOPE narrows the scan: the other section answers for itself only', async () => {
		const other = await report([OTHER_SECTION]);
		expect(
			other.findings.map((finding) => [finding.section_tipo, finding.tipo, finding.missing]),
		).toEqual([[OTHER_SECTION, OTHER_TEXT, OTHER_RECORDS]]);
		// The ids are a SAMPLE (the first 50, ascending); `missing` and the drift are the count.
		expect(other.findings[0]?.section_ids).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
		expect(other.drift).toBe(OTHER_RECORDS);
		const both = await report([SECTION, OTHER_SECTION]);
		expect(both.drift).toBe(4 + OTHER_RECORDS);
		expect(both.scanned).toBe(2);
	}, 30_000);

	test('a READ never seeds: opening the record in edit leaves it reported, and the run itself writes nothing', async () => {
		const before = await storedBytes();
		const { data } = await readSection({
			action: 'read',
			source: { tipo: SECTION, section_tipo: SECTION, mode: 'edit', lang: 'lg-eng' },
			sqo: {
				section_tipo: [SECTION],
				filter_by_locators: [{ section_tipo: SECTION, section_id: String(absent) }],
				limit: 1,
				offset: 0,
			},
		} as never);
		expect((data as unknown[]).length).toBeGreaterThan(0); // the form really was built
		const summary = await report();
		expect(summary.findings.map((finding) => finding.section_ids)).toEqual([
			[absent, emptied],
			[absent, emptied],
		]);
		expect(await storedBytes()).toBe(before);
	}, 30_000);

	test('registered as an operator-run check whose APPLY is refused before it runs', async () => {
		const definition = getReconcile(RECORD_MISSING_DEFAULTS);
		expect(definition?.schedule).toBe('operator');
		expect(definition?.autoApply).toBeUndefined();
		expect(definition?.scopeLabel).toBe('section tipo');
		expect(definition === null ? null : applyPolicyOf(definition)).toBe('refused');
		const before = await storedBytes();
		const refusal = await refusalOf(
			runReconcile(RECORD_MISSING_DEFAULTS, { apply: true, scope: [SECTION] }),
		);
		expect(refusal.code).toBe('request.invalid');
		expect(await storedBytes()).toBe(before);
	}, 30_000);
});
