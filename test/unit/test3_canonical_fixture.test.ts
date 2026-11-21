/**
 * TRIPWIRE: the canonical test3 fixture (src/core/test_data/) is the SINGLE
 * VERIFIED SOURCE of the playground test data. Four contracts:
 *
 *  1. fixture ↔ manifest (no DB) — the record set matches (live-captured base +
 *     the per-suite isolation CLONES of record 1), every REQUIRED_SHAPES
 *     predicate holds, no null/'' holes anywhere, the ledgered-empty list is
 *     not stale (a populated tipo must leave it), and each clone is a true copy
 *     of record 1 (same shapes, own data.section_id).
 *  2. ontology coverage (DB) — every data-bearing component of the test3
 *     subtree is populated on record 1 OR consciously ledgered; no fixture
 *     key is an orphan (subtree tipo, box-parked tipo or declared extra). The
 *     subtree is the SECTION subtree (the containment law, T2-SL-3a): the
 *     components parked under the `box elements` container test115 are not
 *     in it — they are listed apart (OUTSIDE_SECTION_TIPOS) and the gate
 *     proves each one is box-parked, i.e. outside by the law, not by mistake.
 *  3. restore round-trip (DB) — restoreCanonicalTest3() reproduces the
 *     fixture exactly (parsed deep-equality via canonicalTest3Drift) and the
 *     engine READS every populated record-1 component (entries non-empty).
 *  4. reset semantics (DB, snapshot-protected) — resetTestSection() leaves
 *     exactly the canonical records, serial ids 1..N, exact-set counter.
 *
 * The DB blocks write ONLY the test3 rows of matrix_test (block 4 snapshots
 * and restores the whole table + counter + sequence). Healing is a feature:
 * a green run leaves the live playground canonical.
 */

import { describe, expect, test } from 'bun:test';
import { MATRIX_JSONB_COLUMNS } from '../../src/core/db/matrix.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { ddDateToSeconds } from '../../src/core/media/file_date.ts';
import {
	getColumnNameByModel,
	getContainingSectionTipo,
	getOrderedSubtree,
} from '../../src/core/ontology/resolver.ts';
import { readComponentData } from '../../src/core/section/read.ts';
import {
	BASE_RECORD_IDS,
	CANONICAL_RECORD_IDS,
	CANONICAL_SECTION_TIPO,
	CANONICAL_TABLE,
	CLONE_RECORD_IDS,
	CLONE_SOURCE_ID,
	COMPONENT_DATA_COLUMNS,
	EXTRA_COMPONENT_TIPOS,
	LEDGERED_EMPTY_TIPOS,
	OUTSIDE_SECTION_TIPOS,
	REQUIRED_SHAPES,
	SUITE_ISOLATION_RECORDS,
} from '../../src/core/test_data/manifest.ts';
import {
	type CanonicalRecord,
	canonicalTest3Drift,
	loadCanonicalTest3Fixture,
	resetTestSection,
	restoreCanonicalTest3,
} from '../../src/core/test_data/seed.ts';

const fixture = await loadCanonicalTest3Fixture();

function record(sectionId: number): CanonicalRecord {
	const found = fixture.records.find((entry) => entry.section_id === sectionId);
	if (!found) throw new Error(`fixture record ${sectionId} missing`);
	return found;
}

function componentItems(rec: CanonicalRecord, column: string, tipo: string): unknown[] {
	const columnValue = rec[column as keyof CanonicalRecord];
	if (columnValue === null || typeof columnValue !== 'object') return [];
	const items = (columnValue as Record<string, unknown>)[tipo];
	return Array.isArray(items) ? items : [];
}

function populatedAnywhere(rec: CanonicalRecord, tipo: string): boolean {
	return COMPONENT_DATA_COLUMNS.some((column) => componentItems(rec, column, tipo).length > 0);
}

describe('1. fixture ↔ manifest (no DB)', () => {
	test('record set matches the manifest', () => {
		expect(fixture.section_tipo).toBe(CANONICAL_SECTION_TIPO);
		expect(fixture.records.map((entry) => entry.section_id).sort((a, b) => a - b)).toEqual([
			...CANONICAL_RECORD_IDS,
		]);
		// The canonical set = live-captured base + per-suite isolation clones.
		expect([...CANONICAL_RECORD_IDS]).toEqual(
			[...BASE_RECORD_IDS, ...CLONE_RECORD_IDS].sort((a, b) => a - b),
		);
		// No base id doubles as a clone id (a clone would shadow a captured record).
		for (const cloneId of CLONE_RECORD_IDS) {
			expect(BASE_RECORD_IDS as readonly number[]).not.toContain(cloneId);
		}
	});

	test('per-suite isolation clones are true copies of record 1', () => {
		// The isolation map and the clone-id list are the same set (no drift).
		expect(
			Object.keys(SUITE_ISOLATION_RECORDS)
				.map(Number)
				.sort((a, b) => a - b),
		).toEqual([...CLONE_RECORD_IDS]);
		const source = record(CLONE_SOURCE_ID);
		for (const cloneId of CLONE_RECORD_IDS) {
			const clone = record(cloneId);
			// Same component shapes on every jsonb column EXCEPT the self-identity
			// metadata blob (`data.section_id` is rewritten to the clone id).
			for (const column of MATRIX_JSONB_COLUMNS) {
				if (column === 'data') continue;
				expect(clone[column], `clone test3/${cloneId} column ${column} != record 1`).toEqual(
					source[column],
				);
			}
			const data = clone.data as Record<string, unknown> | null;
			expect(data?.section_id, `clone test3/${cloneId} data.section_id`).toBe(cloneId);
		}
	});

	test('every REQUIRED_SHAPES predicate holds', () => {
		for (const shape of REQUIRED_SHAPES) {
			const items = componentItems(record(shape.sectionId), shape.column, shape.tipo);
			expect(
				items.length,
				`${shape.tipo} on test3/${shape.sectionId} (${shape.why})`,
			).toBeGreaterThan(0);
			if (shape.langs) {
				const langs = new Set(
					items.map((item) => (item as { lang?: string } | null)?.lang ?? '<no lang>'),
				);
				expect([...langs].sort(), `${shape.tipo} on test3/${shape.sectionId} langs`).toEqual(
					[...shape.langs].sort(),
				);
			}
		}
	});

	test('no null/empty-string holes in any component item array', () => {
		for (const rec of fixture.records) {
			for (const column of COMPONENT_DATA_COLUMNS) {
				const columnValue = rec[column];
				if (columnValue === null || typeof columnValue !== 'object') continue;
				for (const [tipo, items] of Object.entries(columnValue as Record<string, unknown>)) {
					if (!Array.isArray(items)) continue;
					for (const item of items) {
						expect(item, `hole in ${column}.${tipo} on test3/${rec.section_id}`).not.toBeNull();
						expect(item, `hole in ${column}.${tipo} on test3/${rec.section_id}`).not.toBe('');
					}
				}
			}
		}
	});

	test('ledgered-empty list is not stale (no ledgered tipo is populated)', () => {
		const rec1 = record(1);
		for (const tipo of Object.keys(LEDGERED_EMPTY_TIPOS)) {
			expect(populatedAnywhere(rec1, tipo), `${tipo} is populated — remove its ledger entry`).toBe(
				false,
			);
		}
	});

	test('every declared extra tipo is actually used by the fixture', () => {
		for (const tipo of Object.keys(EXTRA_COMPONENT_TIPOS)) {
			const used = fixture.records.some((rec) => populatedAnywhere(rec, tipo));
			expect(used, `extra tipo ${tipo} unused — remove its entry`).toBe(true);
		}
	});

	/**
	 * A date item stores BOTH its fields and a precomputed ordinal `time`, and the
	 * search engine compares only the ordinal (builder_date emits
	 * `@.start.time <op> t`). So a stamp that disagrees with its own fields makes a
	 * record unfindable by the date it displays, and findable by a date it does
	 * not: this fixture used to carry year 1628 stamped on the year-628 scale, and
	 * an exact search for 1628-06-09 returned nothing while 0628-06-09 returned it.
	 *
	 * The interactive save path re-stamps every date item, so real records heal
	 * themselves on the next edit — but the seed re-injects this fixture verbatim
	 * on every suite reset, so nothing here heals. Hence a gate rather than a fix.
	 */
	test('every date stamp agrees with its own fields', () => {
		const disagreements: string[] = [];
		const check = (label: string, part: unknown): void => {
			if (part === null || typeof part !== 'object') return;
			const date = part as { time?: unknown; year?: unknown };
			if (typeof date.time !== 'number' || typeof date.year !== 'number') return;
			const expected = ddDateToSeconds(date as Parameters<typeof ddDateToSeconds>[0]);
			if (date.time !== expected) {
				disagreements.push(`${label}: stored ${date.time}, fields give ${expected}`);
			}
		};

		for (const rec of fixture.records) {
			const dateColumn = (rec as Record<string, unknown>).date;
			if (dateColumn === null || typeof dateColumn !== 'object') continue;
			for (const [tipo, items] of Object.entries(dateColumn as Record<string, unknown>)) {
				for (const [index, item] of (Array.isArray(items) ? items : []).entries()) {
					if (item === null || typeof item !== 'object') continue;
					for (const container of ['start', 'end', 'period'] as const) {
						check(
							`${(rec as { section_id?: unknown }).section_id}/${tipo}[${index}].${container}`,
							(item as Record<string, unknown>)[container],
						);
					}
				}
			}
		}

		expect(disagreements, disagreements.join('\n')).toEqual([]);
	});
});

describe('2. ontology coverage (DB)', () => {
	test('every data-bearing test3 component is populated on record 1 or ledgered', async () => {
		const subtree = await getOrderedSubtree(CANONICAL_SECTION_TIPO);
		const components = subtree.filter(
			(node) => typeof node.model === 'string' && node.model.startsWith('component_'),
		);
		expect(components.length).toBeGreaterThan(30); // the playground census floor
		const rec1 = record(1);
		const undecided: string[] = [];
		for (const node of components) {
			const column = getColumnNameByModel(node.model as string);
			if (column === null || !(COMPONENT_DATA_COLUMNS as readonly string[]).includes(column)) {
				continue; // no jsonb data slot (section_id, html_text, …)
			}
			const covered = componentItems(rec1, column, node.tipo as string).length > 0;
			if (!covered && LEDGERED_EMPTY_TIPOS[node.tipo as string] === undefined) {
				undecided.push(`${node.tipo} (${node.model} → ${column})`);
			}
		}
		// A new test3 component forces a fixture decision: populate it via
		// scripts/capture_test3_fixture.ts or ledger it in manifest.ts.
		expect(undecided).toEqual([]);
	});

	test('no orphan fixture keys (subtree tipo or declared extra)', async () => {
		const subtree = await getOrderedSubtree(CANONICAL_SECTION_TIPO);
		const subtreeTipos = new Set(subtree.map((node) => node.tipo as string));
		const orphans: string[] = [];
		for (const rec of fixture.records) {
			for (const column of COMPONENT_DATA_COLUMNS) {
				const columnValue = rec[column];
				if (columnValue === null || typeof columnValue !== 'object') continue;
				for (const tipo of Object.keys(columnValue as Record<string, unknown>)) {
					const admitted =
						subtreeTipos.has(tipo) ||
						EXTRA_COMPONENT_TIPOS[tipo] !== undefined ||
						OUTSIDE_SECTION_TIPOS[tipo] !== undefined;
					if (!admitted) {
						orphans.push(`${tipo} (${column} on test3/${rec.section_id})`);
					}
				}
			}
		}
		expect(orphans).toEqual([]);

		// Ledger hygiene: every ledgered tipo is a real subtree component.
		for (const tipo of Object.keys(LEDGERED_EMPTY_TIPOS)) {
			expect(subtreeTipos.has(tipo), `ledgered tipo ${tipo} left the section`).toBe(true);
		}
	});

	test('box-parked tipos: exactly the data-bearing components the containment law puts outside test3', async () => {
		// The law (T2-SL-3a, owner ruling (b)): a component under a `box elements`
		// container (test115) is not of the section. The STRUCTURAL walk still
		// reaches it; the SECTION walk and the upward law do not.
		const sectionTipos = new Set(
			(await getOrderedSubtree(CANONICAL_SECTION_TIPO)).map((node) => node.tipo as string),
		);
		const parked: string[] = [];
		for (const node of await getOrderedSubtree(CANONICAL_SECTION_TIPO, { crossSections: true })) {
			const model = node.model;
			if (typeof model !== 'string' || !model.startsWith('component_')) continue;
			const column = getColumnNameByModel(model);
			if (column === null || !(COMPONENT_DATA_COLUMNS as readonly string[]).includes(column)) {
				continue;
			}
			if (sectionTipos.has(node.tipo)) continue;
			if ((await getContainingSectionTipo(node.tipo)) !== null) continue; // a nested section's
			parked.push(node.tipo);
		}
		expect(parked.length).toBeGreaterThan(0); // test115 is populated: not vacuous
		expect([...parked].sort()).toEqual(Object.keys(OUTSIDE_SECTION_TIPOS).sort());
	});
});

describe('3. restore round-trip (DB)', () => {
	test('restoreCanonicalTest3 reproduces the fixture exactly', async () => {
		const { restored } = await restoreCanonicalTest3();
		expect(restored).toBe(fixture.records.length);
		expect(await canonicalTest3Drift()).toEqual([]);
		const counter = (await sql.unsafe('SELECT value FROM matrix_counter WHERE tipo = $1', [
			CANONICAL_SECTION_TIPO,
		])) as { value: number }[];
		const maxCanonicalId = Math.max(...fixture.records.map((entry) => entry.section_id));
		expect(Number(counter[0]?.value)).toBeGreaterThanOrEqual(maxCanonicalId);
	});

	test('the engine reads every populated record-1 component (entries non-empty)', async () => {
		const rec1 = record(1);
		for (const column of COMPONENT_DATA_COLUMNS) {
			const columnValue = rec1[column];
			if (columnValue === null || typeof columnValue !== 'object') continue;
			for (const [tipo, items] of Object.entries(columnValue as Record<string, unknown>)) {
				if (!Array.isArray(items) || items.length === 0) continue;
				// Translatable components slice by lang: read with the stored lang.
				const lang = (items[0] as { lang?: string } | null)?.lang ?? 'lg-eng';
				const emitted = await readComponentData({
					action: 'read',
					source: {
						tipo,
						section_tipo: CANONICAL_SECTION_TIPO,
						section_id: '1',
						mode: 'edit',
						lang,
					},
				} as never);
				const own = emitted.find((item) => item.tipo === tipo);
				expect(
					Array.isArray(own?.entries) && (own?.entries as unknown[]).length > 0,
					`${tipo} (${column}, lang ${lang}) emitted no entries`,
				).toBe(true);
			}
		}
	}, 60000);
});

describe('4. reset semantics (DB, snapshot-protected)', () => {
	test('resetTestSection leaves exactly the canonical records', async () => {
		const snapshot = (await sql.unsafe(
			`SELECT * FROM "${CANONICAL_TABLE}" ORDER BY id`,
			[],
		)) as Record<string, unknown>[];
		const counterBefore = (await sql.unsafe('SELECT value FROM matrix_counter WHERE tipo = $1', [
			CANONICAL_SECTION_TIPO,
		])) as { value: number }[];
		const maxCanonicalIdSeed = Math.max(...fixture.records.map((entry) => entry.section_id));
		try {
			// FALSIFIABILITY: raise-only is only observable from BELOW. Force the
			// counter under the canonical max first, so the reset has somewhere to
			// raise it TO and the exact landing value is asserted, not just a bound.
			await sql.unsafe('UPDATE matrix_counter SET value = 1 WHERE tipo = $1', [
				CANONICAL_SECTION_TIPO,
			]);
			const seeded = await resetTestSection();
			expect(seeded.records).toBe(fixture.records.length);
			const raised = (await sql.unsafe('SELECT value FROM matrix_counter WHERE tipo = $1', [
				CANONICAL_SECTION_TIPO,
			])) as { value: number }[];
			expect(Number(raised[0]?.value)).toBe(maxCanonicalIdSeed);

			// Now the raise-only half, from ABOVE.
			await sql.unsafe('UPDATE matrix_counter SET value = $2 WHERE tipo = $1', [
				CANONICAL_SECTION_TIPO,
				maxCanonicalIdSeed + 777,
			]);
			const { records } = await resetTestSection();
			expect(records).toBe(fixture.records.length);

			const rows = (await sql.unsafe(
				`SELECT id, section_id, section_tipo FROM "${CANONICAL_TABLE}" ORDER BY section_id`,
				[],
			)) as { id: number; section_id: number; section_tipo: string }[];
			expect(rows.length).toBe(fixture.records.length);
			expect(rows.map((row) => Number(row.section_id))).toEqual([...CANONICAL_RECORD_IDS]);
			expect(rows.every((row) => row.section_tipo === CANONICAL_SECTION_TIPO)).toBe(true);
			// serial ids restart at 1 (ascending insert order)
			expect(rows.map((row) => Number(row.id))).toEqual(
				fixture.records.map((_, index) => index + 1),
			);
			expect(await canonicalTest3Drift()).toEqual([]);

			const counter = (await sql.unsafe('SELECT value FROM matrix_counter WHERE tipo = $1', [
				CANONICAL_SECTION_TIPO,
			])) as { value: number }[];
			const maxCanonicalId = Math.max(...fixture.records.map((entry) => entry.section_id));
			// RAISE-ONLY (P0-14, changed 2026-08-30). This asserted equality until the
			// section-id counter was established as a high-water mark: the TRUNCATE
			// does not remove matrix_time_machine rows, so lowering the counter to the
			// fixture's max re-issues section_ids that still have TM history — and this
			// door runs on REAL databases (the installer, the unit_test widget), not
			// only the suite DB. The reset must restore the RECORDS, never rewind the
			// id space. Asserted EXACTLY: the counter was seeded above, so a body that
			// lowered it would land on maxCanonicalId and fail here.
			expect(Number(counter[0]?.value)).toBe(maxCanonicalId + 777);
		} finally {
			// restore the snapshot verbatim (columns + ids + sequence + counter)
			await sql.unsafe(`TRUNCATE TABLE "${CANONICAL_TABLE}"`, []);
			for (const row of snapshot) {
				const columns = Object.keys(row);
				const placeholders = columns.map((column, position) =>
					['id', 'section_id', 'section_tipo'].includes(column)
						? `$${position + 1}`
						: `$${position + 1}::text::jsonb`,
				);
				await sql.unsafe(
					`INSERT INTO "${CANONICAL_TABLE}" (${columns.map((c) => `"${c}"`).join(', ')})
					 VALUES (${placeholders.join(', ')})`,
					columns.map((column) =>
						row[column] === null || ['id', 'section_id', 'section_tipo'].includes(column)
							? (row[column] as string | number | null)
							: JSON.stringify(row[column]),
					) as (string | number | null)[],
				);
			}
			await sql.unsafe(
				`SELECT setval('${CANONICAL_TABLE}_id_seq', (SELECT COALESCE(MAX(id), 1) FROM "${CANONICAL_TABLE}"))`,
				[],
			);
			if (counterBefore.length > 0) {
				await sql.unsafe('UPDATE matrix_counter SET value = $1 WHERE tipo = $2', [
					Number(counterBefore[0]?.value),
					CANONICAL_SECTION_TIPO,
				]);
			}
		}
	}, 60000);
});
