/**
 * component_relation_index CONFIGURABLE inverse question — TS-native gate
 * (DEC-14b; no PHP oracle survives to differential this).
 *
 * The contract (PHP class.component_relation_index get_filter_locator :872 +
 * get_target_section :839 + component_relation_common __construct :217):
 * - relation TYPE = properties.config_relation.relation_type ?? dd96;
 * - pointing sections = the request_config sqo targets when a config exists,
 *   else 'all';
 * - the computed page ALSO serves the edit read (the client renders it on
 *   open, not only after the reload button's get_data).
 * Live-corpus shape this pins (dc1 §2 "Materia"): tch60/tchi59 declare dd151
 * over specific thesaurus sections; hierarchy40 declares nothing.
 *
 * Everything here is SCRATCH inside the suite database's test3 playground:
 * two dd_ontology relation_index twins (test990 = dd151 over test3,
 * test991 = dd151 over dd153 — the exclusion case) and two matrix_test
 * pointing rows (a dd151 ref + a dd96 ref, both → test3 §1). The
 * matrix_test_relation_index_sync trigger keeps the inverse index coherent
 * for direct INSERTs. Deltas are asserted against baselines measured in
 * beforeAll; swept in afterAll, pre-cleaned for crashed runs.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	readRelationIndexData,
	relationIndexResolver,
} from '../../src/core/relations/models/relation_index.ts';
import type { DataItem } from '../../src/core/resolve/component_data.ts';
import { EmissionContext } from '../../src/core/resolve/component_data.ts';
import { countInverseReferences } from '../../src/core/search/search_related.ts';
import { emitDdoData } from '../../src/core/section/read.ts';

const TARGET = { section_tipo: 'test3', section_id: 1 };
const SCRATCH_DD151_ID = 91003; // pointing rows, clear of the canonical playground ids
const SCRATCH_DD96_ID = 91004;
const FILTERED_TIPO = 'test990'; // dd151 over ['test3']
const EXCLUDED_TIPO = 'test991'; // dd151 over ['dd153'] — must NOT see test3 pointers

function indexProperties(targetSection: string): string {
	return JSON.stringify({
		config_relation: { relation_type: 'dd151' },
		source: {
			mode: 'external',
			request_config: [
				{
					sqo: { section_tipo: [{ value: [targetSection], source: 'section' }] },
					show: { ddo_map: [], sqo_config: { limit: 10 } },
				},
			],
		},
	});
}

async function sweepScratch(): Promise<void> {
	await sql.unsafe('DELETE FROM matrix_test WHERE section_id IN ($1, $2)', [
		SCRATCH_DD151_ID,
		SCRATCH_DD96_ID,
	]);
	await sql.unsafe('DELETE FROM dd_ontology WHERE tipo IN ($1, $2)', [
		FILTERED_TIPO,
		EXCLUDED_TIPO,
	]);
}

async function countFor(sections: string[] | 'all', type: string): Promise<number> {
	const counted = await countInverseReferences([{ type, ...TARGET }], {
		sectionTipos: sections,
	});
	return counted.total;
}

let baseFiltered = 0; // dd151 → test3 §1 from test3 rows
let baseExcluded = 0; // dd151 → test3 §1 from dd153 rows
let baseDefault = 0; // dd96 → test3 §1 from anywhere

beforeAll(async () => {
	await sweepScratch(); // crashed-run belt and braces

	baseFiltered = await countFor(['test3'], 'dd151');
	baseExcluded = await countFor(['dd153'], 'dd151');
	baseDefault = await countFor('all', 'dd96');

	// Scratch ontology twins (id has no default — allocate above the ceiling).
	for (const [offset, tipo, targetSection] of [
		[1, FILTERED_TIPO, 'test3'],
		[2, EXCLUDED_TIPO, 'dd153'],
	] as const) {
		await sql.unsafe(
			`INSERT INTO dd_ontology (id, tipo, parent, model, tld, properties)
			 VALUES ((SELECT COALESCE(MAX(id), 0) + 1000 + $1 FROM dd_ontology), $2, 'test45', 'component_relation_index', 'test', $3::text::jsonb)`,
			[offset, tipo, indexProperties(targetSection)],
		);
	}

	// A dd151 "who references me" pointer and a dd96 indexation pointer,
	// both from scratch test3 rows → test3 §1.
	for (const [id, slot, type] of [
		[SCRATCH_DD151_ID, 'test70', 'dd151'],
		[SCRATCH_DD96_ID, 'test54', 'dd96'],
	] as const) {
		await sql.unsafe(
			`INSERT INTO matrix_test (section_id, section_tipo, relation) VALUES ($1, 'test3', $2::text::jsonb)`,
			[
				id,
				JSON.stringify({
					[slot]: [
						{
							id: 1,
							type,
							section_id: String(TARGET.section_id),
							section_tipo: TARGET.section_tipo,
							from_component_tipo: slot,
						},
					],
				}),
			],
		);
	}
});

afterAll(async () => {
	await sweepScratch();
});

async function readIndex(tipo: string, mode = 'edit'): Promise<DataItem[]> {
	return readRelationIndexData(
		tipo,
		TARGET.section_tipo,
		String(TARGET.section_id),
		10,
		0,
		'lg-eng',
		emitDdoData,
		mode,
	);
}

function mainItem(items: DataItem[], tipo: string): DataItem | undefined {
	return items.find((item) => item.tipo === tipo);
}

describe('relation_index configurable inverse question (get_data)', () => {
	test('config_relation.relation_type + request_config targets drive the page', async () => {
		const items = await readIndex(FILTERED_TIPO);
		const item = mainItem(items, FILTERED_TIPO);
		expect(item).toBeDefined();
		const entries = (item?.entries ?? []) as Record<string, unknown>[];
		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) {
			expect(entry.type).toBe('dd151'); // NEVER the dd96 default
			expect(entry.section_tipo).toBe('test3');
		}
		// entries carry the int-canonical section_id (WC-2026-08-10-section-id-int-canonical)
		expect(entries.some((entry) => entry.section_id === SCRATCH_DD151_ID)).toBe(true);
		// The dd96 scratch pointer is invisible to a dd151 component.
		expect(entries.some((entry) => entry.section_id === SCRATCH_DD96_ID)).toBe(false);
		expect((item?.pagination as { total: number }).total).toBe(baseFiltered + 1);
	});

	test('target-section filter excludes pointers from other sections', async () => {
		expect(await countFor(['dd153'], 'dd151')).toBe(baseExcluded); // scratch ref is in test3
		const items = await readIndex(EXCLUDED_TIPO);
		const entries = (mainItem(items, EXCLUDED_TIPO)?.entries ?? []) as Record<string, unknown>[];
		for (const entry of entries) {
			expect(entry.section_tipo).toBe('dd153');
		}
		expect(entries.some((entry) => entry.section_id === SCRATCH_DD151_ID)).toBe(false);
	});

	test('no config → the dd96/all-sections defaults (test25)', async () => {
		const items = await readIndex('test25');
		const item = mainItem(items, 'test25');
		expect(item).toBeDefined();
		const entries = (item?.entries ?? []) as Record<string, unknown>[];
		for (const entry of entries) {
			expect(entry.type).toBe('dd96');
		}
		expect(entries.some((entry) => entry.section_id === SCRATCH_DD96_ID)).toBe(true);
		expect((item?.pagination as { total: number }).total).toBe(baseDefault + 1);
	});
});

describe('thesaurus tree badge count honors the inverse question', () => {
	// PHP ts_object get_count_data_group_by → component count_data_group_by,
	// which applies get_target_section: a dd151 pointer from test3 must count
	// for the ['test3']-targeted twin and NOT for the ['dd153'] one (the
	// TCHI:1-on-a-TCH-pointer tree-icon bug).
	test('counts only pointers of the declared type + target sections', async () => {
		const { getCountDataGroupBy } = await import('../../src/core/ts_object/ts_object.ts');
		const filtered = await getCountDataGroupBy(
			TARGET.section_tipo,
			TARGET.section_id,
			FILTERED_TIPO,
			{} as never,
		);
		expect(filtered.total).toBe(baseFiltered + 1);
		const excluded = await getCountDataGroupBy(
			TARGET.section_tipo,
			TARGET.section_id,
			EXCLUDED_TIPO,
			{} as never,
		);
		expect(excluded.total).toBe(baseExcluded); // scratch pointer filtered out
	});

	// T2 THES-06: a group label is the pointing section's label in the REQUEST
	// application lang (labelByTipo's request-scoped default) — never the install
	// structure lang. test3 is labelled differently in lg-eng and lg-spa.
	test('group labels follow the request application lang', async () => {
		const { getCountDataGroupBy } = await import('../../src/core/ts_object/ts_object.ts');
		const { runWithRequestLangs } = await import('../../src/core/resolve/request_lang.ts');
		const { clearLabelCache } = await import('../../src/core/ontology/labels.ts');
		const labelIn = async (applicationLang: string): Promise<string | null | undefined> => {
			const counted = await runWithRequestLangs({ applicationLang, dataLang: 'lg-eng' }, () =>
				getCountDataGroupBy(TARGET.section_tipo, TARGET.section_id, FILTERED_TIPO, {} as never),
			);
			return counted.totals_group.find((group) => group.key === 'test3')?.label;
		};
		const rows = (await sql.unsafe(`SELECT term FROM dd_ontology WHERE tipo = 'test3'`)) as {
			term: Record<string, string>;
		}[];
		const english = rows[0]?.term['lg-eng'];
		const spanish = rows[0]?.term['lg-spa'];
		expect(typeof english).toBe('string');
		expect(english).not.toBe(spanish);
		clearLabelCache();
		expect(await labelIn('lg-eng')).toBe(english);
		expect(await labelIn('lg-spa')).toBe(spanish);
	});
});

describe('relation_index resolver computes in EDIT mode', () => {
	test('edit read emits the filtered inverse page (nothing-on-open bug)', async () => {
		const record = await readMatrixRecord('matrix_test', TARGET.section_tipo, TARGET.section_id);
		expect(record).not.toBeNull();
		if (record === null) return;
		const emission = new EmissionContext();
		await relationIndexResolver.emitDdoItems({
			ddo: { tipo: FILTERED_TIPO, section_tipo: TARGET.section_tipo, mode: 'edit' } as never,
			ddoMap: [],
			record,
			row: TARGET,
			model: 'component_relation_index',
			dataTipo: FILTERED_TIPO,
			ddoMode: 'edit',
			ddoLang: 'lg-nolan',
			defaultMode: 'edit',
			defaultLang: 'lg-eng',
			callerTipo: TARGET.section_tipo,
			emission,
			allowOwnConfigChildren: true,
			depth: 0,
			emitDdo: emitDdoData,
		});
		const item = mainItem(emission.items as DataItem[], FILTERED_TIPO);
		expect(item).toBeDefined();
		const entries = (item?.entries ?? []) as Record<string, unknown>[];
		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) {
			expect(entry.type).toBe('dd151');
			expect(entry.section_tipo).toBe('test3');
		}
		// The component's own sqo_config.limit (10) drives the edit page.
		expect((item?.pagination as { limit: number }).limit).toBe(10);
	});
});
