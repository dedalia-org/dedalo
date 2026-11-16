/**
 * `resolveCellValue` + `resolveRelationTargetValues` — the per-FAMILY branch
 * inventory of the relation_list / export cell resolver
 * (src/core/resolve/relation_list.ts:302 and :121).
 *
 * The existing gate `relation_list_cell_value.test.ts` covers three cells on
 * an rsc197 fixture that does NOT exist on this install (two of its three
 * cases die on "fixture missing"). This file is the test3-playground twin: it
 * reaches every flat-value family the resolver dispatches on, plus the
 * early-return and seam contracts of the per-target half.
 *
 * WHAT IS PINNED (each line is a distinct branch of the two functions):
 *   - the DERIVED-family early returns (unknown model / unknown section);
 *   - family 'section_id'  → the record's own id, fail-CLOSED on a missing row;
 *   - family 'string'      → lang slice, multi-item join by the CALLER's
 *                            itemSeparator (the export-atoms ' | ' → ', ' flip);
 *   - family 'date'        → the ONE formatter (component_date/date_value.ts)
 *                            on the node's date_mode; the shape corpus itself
 *                            lives in date_flat_value_native.test.ts;
 *   - family 'iri'         → the bare iri (the stored `title` must NOT leak);
 *   - family 'media'       → exportBase + the default-quality file_path (pdf
 *                            and 3d; exportBase unset → ledgered);
 *   - family 'datalist'    → the two halves of resolveRelationTargetValues:
 *                            the CONFIG-CHILDREN branch (skips invalid
 *                            locators, joins by the component's
 *                            fields_separator, stored order — test80, and
 *                            test101 component_filter → dd156 since T0-9) and
 *                            the no-children DATALIST branch (keeps every
 *                            locator slot, labels via resolveLocatorLabels —
 *                            test70, a filter_master with no config and no
 *                            relations, the one playground relation left
 *                            without children);
 *   - an uncovered model   → null + a LEDGERED `unresolved` entry, never a
 *                            guessed string;
 *   - the `loadRecord` seam, including the parity keystone that it is
 *                            consulted only AFTER the null-table early return.
 *
 * Scratch surfaces (this item's namespace): test3 / 925020-925029 in
 * matrix_test, created and deleted here. Read-only fixtures: the canonical
 * test3 records 1 and 27, which the preload re-seeds every run.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { exportConfigChildren } from '../../src/core/relations/config_children.ts';
import {
	resolveCellValue,
	resolveRelationTargetValues,
} from '../../src/core/resolve/relation_list.ts';

const SECTION = 'test3';
/** Every scratch id this file writes — the sweep list and the cleanup proof. */
const IDS = {
	/** test52 = 'Alpha' (single lg-eng item). */
	alpha: 925020,
	/** test52 = 'Beta'. */
	beta: 925021,
	/** test52 = two lg-eng items (the multi-item join fixture). */
	twoItems: 925022,
	/** date only: a YEAR-ONLY test145 item (no string column at all). */
	yearOnly: 925023,
	/** date only: a start+end test145 item (the range fixture). */
	range: 925024,
	/** relation: test80 → [beta, alpha]; test101 → [invalid, valid]. */
	owner: 925025,
};
const SCRATCH_IDS = Object.values(IDS);

async function sweep(): Promise<number> {
	let deleted = 0;
	for (const id of SCRATCH_IDS) {
		const rows = (await sql.unsafe(
			'DELETE FROM matrix_test WHERE section_tipo = $1 AND section_id = $2 RETURNING section_id',
			[SECTION, id],
		)) as unknown[];
		deleted += rows.length;
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[SECTION, id],
		);
	}
	return deleted;
}

beforeAll(async () => {
	await sweep(); // pre-clean a crashed prior run

	// PRECONDITION: never write over a coordinate this gate did not create.
	const occupied: number[] = [];
	for (const id of SCRATCH_IDS) {
		const rows = (await sql.unsafe(
			'SELECT section_id FROM matrix_test WHERE section_tipo = $1 AND section_id = $2',
			[SECTION, id],
		)) as unknown[];
		if (rows.length > 0) occupied.push(id);
	}
	if (occupied.length > 0) {
		throw new Error(
			`relation_list cell gate: scratch ids ${SCRATCH_IDS.join(',')} are not free after the sweep — refusing to write over records this gate did not create.`,
		);
	}

	const seedString = async (id: number, tipo: string, items: unknown[]): Promise<void> => {
		await sql.unsafe(
			`INSERT INTO matrix_test (section_id, section_tipo, string)
			 VALUES ($1, $2, jsonb_build_object($3::text, $4::text::jsonb))`,
			[id, SECTION, tipo, JSON.stringify(items)],
		);
	};
	const seedDate = async (id: number, items: unknown[]): Promise<void> => {
		await sql.unsafe(
			`INSERT INTO matrix_test (section_id, section_tipo, date)
			 VALUES ($1, $2, jsonb_build_object('test145', $3::text::jsonb))`,
			[id, SECTION, JSON.stringify(items)],
		);
	};

	await seedString(IDS.alpha, 'test52', [{ id: 1, lang: 'lg-eng', value: 'Alpha' }]);
	await seedString(IDS.beta, 'test52', [{ id: 1, lang: 'lg-eng', value: 'Beta' }]);
	await seedString(IDS.twoItems, 'test52', [
		{ id: 1, lang: 'lg-eng', value: 'Alpha' },
		{ id: 2, lang: 'lg-eng', value: 'Beta' },
	]);
	await seedDate(IDS.yearOnly, [{ id: 1, lang: 'lg-nolan', start: { year: 1975 } }]);
	await seedDate(IDS.range, [
		{
			id: 1,
			lang: 'lg-nolan',
			start: { year: 1628, month: 6, day: 9 },
			end: { year: 2024, month: 6, day: 25 },
		},
	]);

	// The relation owner. test80 is a component_portal whose ontology config
	// declares ONE child (test52) — the config-children branch. test101 is a
	// component_filter (children dd156 since T0-9 — the children branch too).
	// test70 is a component_filter_master with NO `relations` and no config —
	// NO children at all, the DATALIST branch. test101 and test70 carry a
	// deliberately INVALID first locator.
	const projectSlots = (from: string) =>
		JSON.stringify([
			// no section_tipo — a corrupt/half-written locator slot
			{ id: 1, type: 'dd675', section_id: '1' },
			{ id: 2, type: 'dd675', section_id: '1', section_tipo: 'dd153', from_component_tipo: from },
		]);
	await sql.unsafe(
		`INSERT INTO matrix_test (section_id, section_tipo, relation)
		 VALUES ($1, $2, jsonb_build_object('test80', $3::text::jsonb, 'test101', $4::text::jsonb, 'test70', $5::text::jsonb))`,
		[
			IDS.owner,
			SECTION,
			JSON.stringify([
				// STORED order is beta-then-alpha on purpose: the resolver must not sort.
				{
					id: 1,
					type: 'dd151',
					section_id: String(IDS.beta),
					section_tipo: SECTION,
					from_component_tipo: 'test80',
				},
				{
					id: 2,
					type: 'dd151',
					section_id: String(IDS.alpha),
					section_tipo: SECTION,
					from_component_tipo: 'test80',
				},
			]),
			projectSlots('test101'),
			projectSlots('test70'),
		],
	);
}, 60000);

afterAll(async () => {
	const deleted = await sweep();
	if (deleted !== SCRATCH_IDS.length) {
		throw new Error(
			`relation_list cell gate cleanup deleted ${deleted} of ${SCRATCH_IDS.length} scratch rows in matrix_test — a seeded row vanished mid-run or was never created.`,
		);
	}
});

describe('resolveCellValue — per-family dispatch', () => {
	test('unknown model and unknown section return null before any read', async () => {
		const unresolved: string[] = [];
		// getModelByTipo → null: no dd_ontology node at all.
		expect(await resolveCellValue(SECTION, 1, 'zzz_no_such_tipo', 'lg-eng', unresolved)).toBeNull();
		// getMatrixTableFromTipo → null: no section.
		expect(
			await resolveCellValue('zzz_no_such_section', 1, 'test52', 'lg-eng', unresolved),
		).toBeNull();
		// Neither is an "uncovered model" — nothing may be ledgered.
		expect(unresolved).toEqual([]);
	});

	test('the loadRecord seam is consulted only AFTER the null-table early return', async () => {
		// Parity keystone (the function's own comment): a cached loader must
		// never resolve what the default loader could not reach.
		let calls = 0;
		const loadRecord = async (): Promise<never> => {
			calls++;
			throw new Error('loadRecord must not be called for an unknown section');
		};
		const unresolved: string[] = [];
		expect(
			await resolveCellValue('zzz_no_such_section', 1, 'test52', 'lg-eng', unresolved, ' | ', {
				loadRecord,
			}),
		).toBeNull();
		expect(calls).toBe(0);

		// …and on a REAL section it IS the loader that supplies the record.
		const seen: [string, string, number][] = [];
		const value = await resolveCellValue(SECTION, 1, 'test52', 'lg-eng', unresolved, ' | ', {
			loadRecord: async (table, sectionTipo, sectionId) => {
				seen.push([table, sectionTipo, sectionId]);
				return null; // a loader that resolves nothing ⇒ the cell is null
			},
		});
		expect(value).toBeNull();
		expect(seen).toEqual([['matrix_test', SECTION, 1]]);
	});

	test("family 'section_id' echoes the record id, and fails CLOSED on a missing record", async () => {
		const unresolved: string[] = [];
		// test102 is the test3 component_section_id.
		expect(await resolveCellValue(SECTION, 1, 'test102', 'lg-eng', unresolved)).toBe('1');
		expect(await resolveCellValue(SECTION, IDS.alpha, 'test102', 'lg-eng', unresolved)).toBe(
			String(IDS.alpha),
		);
		// A nonexistent record must NOT get its id echoed back.
		expect(
			await resolveCellValue(SECTION, 999_999_999, 'test102', 'lg-eng', unresolved),
		).toBeNull();
		expect(unresolved).toEqual([]);
	});

	test("family 'string' joins the lang slice with the CALLER's separator", async () => {
		const unresolved: string[] = [];
		// The canonical playground value (preload-restored, also pinned by the
		// info-widget golden).
		expect(await resolveCellValue(SECTION, 1, 'test52', 'lg-eng', unresolved)).toBe(
			'input text content of one',
		);
		// Default separator = the export-atoms depth-0 records separator.
		expect(await resolveCellValue(SECTION, IDS.twoItems, 'test52', 'lg-eng', unresolved)).toBe(
			'Alpha | Beta',
		);
		// Deeper export-atom levels pass ', ' — the join must follow the ARGUMENT.
		expect(
			await resolveCellValue(SECTION, IDS.twoItems, 'test52', 'lg-eng', unresolved, ', '),
		).toBe('Alpha, Beta');
		// A record with no data for the component is null, not ''.
		expect(
			await resolveCellValue(SECTION, IDS.yearOnly, 'test52', 'lg-eng', unresolved),
		).toBeNull();
		expect(unresolved).toEqual([]);
	});

	test("family 'date' formats through the ONE formatter, on the node's date_mode", async () => {
		// REBASED 2026-08-09 (audit §5.6). This case used to pin 'd-m-Y' joined
		// with '-' and an unconditional 'start <> end' — the divergent formatter
		// this branch carried, which also dropped the month on a day-less date.
		// The branch now calls the single `dateItemToValue`
		// (components/component_date/date_value.ts), i.e. PHP
		// component_date::data_item_to_value: 'Y/m/d', and 'test145' declares NO
		// date_mode, so PHP's default 'date' renders the START only.
		// Contract + corpus: test/unit/date_flat_value_native.test.ts.
		const unresolved: string[] = [];
		// Canonical: two single-date items → the multi-item join.
		expect(await resolveCellValue(SECTION, 1, 'test145', 'lg-nolan', unresolved)).toBe(
			'1628/06/09 | 2024/06/25',
		);
		// Year without month/day → the bare year (unpadded, PHP padding=false).
		expect(await resolveCellValue(SECTION, IDS.yearOnly, 'test145', 'lg-nolan', unresolved)).toBe(
			'1975',
		);
		// start + end on a date_mode 'date' node → the start; the range separator
		// belongs to date_mode 'range' and is asserted in the date gate.
		expect(await resolveCellValue(SECTION, IDS.range, 'test145', 'lg-nolan', unresolved)).toBe(
			'1628/06/09',
		);
		// No date items at all → null.
		expect(
			await resolveCellValue(SECTION, IDS.alpha, 'test145', 'lg-nolan', unresolved),
		).toBeNull();
		expect(unresolved).toEqual([]);
	});

	test("family 'iri' emits the iri itself, never the stored title", async () => {
		const unresolved: string[] = [];
		// test3/1's test140 item carries title 'Title or IRI'; the flat cell is
		// the iri plus (only) its paired dd560 label frame — and there is none.
		const value = await resolveCellValue(SECTION, 1, 'test140', 'lg-nolan', unresolved);
		expect(value).toBe('http://elraspa.com');
		expect(value).not.toContain('Title or IRI');
		expect(unresolved).toEqual([]);
	});

	test("family 'media' composes exportBase + the default-quality file_path", async () => {
		const unresolved: string[] = [];
		// test85 is the test3 component_pdf; its stored files_info holds the
		// model's default quality. The expected URL is COMPUTED from config +
		// the stored path, never hardcoded — the contract is the composition.
		const rows = (await sql.unsafe(
			`SELECT media->'test85' AS items FROM matrix_test WHERE section_tipo = $1 AND section_id = 1`,
			[SECTION],
		)) as { items: { files_info?: { quality?: string; file_path?: string }[] }[] | null }[];
		const filesInfo = rows[0]?.items?.[0]?.files_info ?? [];
		if (filesInfo.length === 0) {
			throw new Error('fixture missing: test3/1 test85 has no files_info — gate cannot assert');
		}
		const value = await resolveCellValue(SECTION, 1, 'test85', 'lg-eng', unresolved);
		const exportBase = config.media.exportBase;
		if (exportBase === undefined || exportBase === '') {
			// exportBase unset ⇒ LEDGERED, never a guessed relative URL. (The
			// in-process flip of this key is impossible: config freezes at import.)
			expect(value).toBeNull();
			expect(unresolved).toContain('component_pdf');
		} else {
			// The quality is the model CONTRACT's default, never the first
			// files_info entry (the stored bag also holds 'original' first).
			const { mediaTypeOf } = await import('../../src/core/concepts/media.ts');
			const quality = mediaTypeOf('component_pdf')?.defaultQuality;
			expect(quality).toBeDefined();
			const path = filesInfo.find((info) => info?.quality === quality)?.file_path ?? '';
			expect(path).not.toBe('');
			expect(value).toBe(`${exportBase}${path}`);
			expect(unresolved).toEqual([]);
		}
	});

	test("component_3d is family 'media': exportBase + its default-quality file_path", async () => {
		// test26 is the test3 component_3d. Until 2026-11-11 it declared NO
		// flatValue, so it fell through to the generic "uncovered model" ledger
		// (null) — this gate then claimed the media contract has no default
		// quality for 3d, which was never true (DEDALO_3D_QUALITY_DEFAULT). Every
		// media model declares one, so the cell composes like any media model.
		const { mediaTypeOf } = await import('../../src/core/concepts/media.ts');
		const quality = mediaTypeOf('component_3d')?.defaultQuality;
		expect(quality).toBeDefined();
		const rows = (await sql.unsafe(
			`SELECT media->'test26' AS items FROM matrix_test WHERE section_tipo = $1 AND section_id = 1`,
			[SECTION],
		)) as { items: { files_info?: { quality?: string; file_path?: string }[] }[] | null }[];
		const path =
			(rows[0]?.items?.[0]?.files_info ?? []).find((info) => info?.quality === quality)
				?.file_path ?? '';
		if (path === '') {
			throw new Error(
				`fixture missing: test3/1 test26 has no '${quality}' files_info — gate cannot assert`,
			);
		}
		const unresolved: string[] = [];
		const value = await resolveCellValue(SECTION, 1, 'test26', 'lg-eng', unresolved);
		const exportBase = config.media.exportBase;
		if (exportBase === undefined || exportBase === '') {
			expect(value).toBeNull();
			expect(unresolved).toContain('component_3d');
		} else {
			expect(value).toBe(`${exportBase}${path}`);
			expect(unresolved).toEqual([]);
		}
	});

	test('an uncovered model is LEDGERED (null + unresolved), and ledgered ONCE', async () => {
		// Anti-vacuity: prove the record exists, so null cannot be "no record".
		const exists = (await sql.unsafe(
			'SELECT 1 FROM matrix_test WHERE section_tipo = $1 AND section_id = 1',
			[SECTION],
		)) as unknown[];
		if (exists.length === 0) {
			throw new Error('fixture missing: test3/1 does not exist — gate cannot assert');
		}
		const unresolved: string[] = [];
		// test152 is a component_password — never a value (a secret; the
		// descriptor tripwire's NO_FLAT_VALUE_LEAF_EXEMPT). component_json was
		// the probe until T1-39 gave it the 'json' family.
		expect(await resolveCellValue(SECTION, 1, 'test152', 'lg-eng', unresolved)).toBeNull();
		expect(unresolved).toEqual(['component_password']);
		// Second call on the same array must not duplicate the ledger entry.
		expect(await resolveCellValue(SECTION, 1, 'test152', 'lg-eng', unresolved)).toBeNull();
		expect(unresolved).toEqual(['component_password']);
	});

	test("family 'datalist' joins the target parts in STORED order", async () => {
		const unresolved: string[] = [];
		// test80 stores [→beta, →alpha]; the cell must not sort.
		expect(await resolveCellValue(SECTION, IDS.owner, 'test80', 'lg-eng', unresolved)).toBe(
			'Beta | Alpha',
		);
		expect(unresolved).toEqual([]);
	});
});

describe('resolveRelationTargetValues — per-target halves', () => {
	test('early returns: unknown model, unknown section, missing record, empty slot', async () => {
		const unresolved: string[] = [];
		expect(
			await resolveRelationTargetValues(SECTION, 1, 'zzz_no_such_tipo', 'lg-eng', unresolved),
		).toEqual([]);
		expect(
			await resolveRelationTargetValues('zzz_no_such_section', 1, 'test80', 'lg-eng', unresolved),
		).toEqual([]);
		expect(
			await resolveRelationTargetValues(SECTION, 999_999_999, 'test80', 'lg-eng', unresolved),
		).toEqual([]);
		// test54 exists on test3/1 with an EMPTY locator array.
		expect(await resolveRelationTargetValues(SECTION, 1, 'test54', 'lg-eng', unresolved)).toEqual(
			[],
		);
		expect(unresolved).toEqual([]);
	});

	test('the loadRecord seam is consulted only AFTER the null-table early return', async () => {
		let calls = 0;
		const unresolved: string[] = [];
		expect(
			await resolveRelationTargetValues('zzz_no_such_section', 1, 'test80', 'lg-eng', unresolved, {
				loadRecord: async () => {
					calls++;
					throw new Error('loadRecord must not be called for an unknown section');
				},
			}),
		).toEqual([]);
		expect(calls).toBe(0);

		// On a real section the loader IS the record source: returning null ⇒ [].
		const seen: [string, string, number][] = [];
		expect(
			await resolveRelationTargetValues(SECTION, IDS.owner, 'test80', 'lg-eng', unresolved, {
				loadRecord: async (table, sectionTipo, sectionId) => {
					seen.push([table, sectionTipo, sectionId]);
					return null;
				},
			}),
		).toEqual([]);
		expect(seen).toEqual([['matrix_test', SECTION, IDS.owner]]);
	});

	test('CONFIG-CHILDREN branch: stored order, RAW index, child values per target', async () => {
		const unresolved: string[] = [];
		const targets = await resolveRelationTargetValues(
			SECTION,
			IDS.owner,
			'test80',
			'lg-eng',
			unresolved,
		);
		expect(targets).toEqual([
			{ index: 0, sectionTipo: SECTION, sectionId: String(IDS.beta), parts: ['Beta'] },
			{ index: 1, sectionTipo: SECTION, sectionId: String(IDS.alpha), parts: ['Alpha'] },
		]);
		expect(unresolved).toEqual([]);
	});

	test('CONFIG-CHILDREN branch: an invalid locator is SKIPPED but still consumes its index', async () => {
		// Rewrite the test80 slot in place: [invalid, →beta]. The invalid entry
		// (no section_tipo) must produce no target, and the surviving one must
		// keep its RAW stored position 1 — the index is the export's addressing.
		await sql.unsafe(
			`UPDATE matrix_test SET relation = jsonb_set(relation, '{test80}', $2::text::jsonb)
			 WHERE section_tipo = $1 AND section_id = $3`,
			[
				SECTION,
				JSON.stringify([
					{ id: 1, type: 'dd151', section_id: String(IDS.alpha) },
					{
						id: 2,
						type: 'dd151',
						section_id: String(IDS.beta),
						section_tipo: SECTION,
						from_component_tipo: 'test80',
					},
				]),
				IDS.owner,
			],
		);
		try {
			const unresolved: string[] = [];
			const targets = await resolveRelationTargetValues(
				SECTION,
				IDS.owner,
				'test80',
				'lg-eng',
				unresolved,
			);
			expect(targets.length).toBe(1);
			expect(targets[0]?.index).toBe(1);
			expect(targets[0]?.sectionId).toBe(String(IDS.beta));
			expect(targets[0]?.parts).toEqual(['Beta']);
		} finally {
			// Restore the seeded slot for any later reader.
			await sql.unsafe(
				`UPDATE matrix_test SET relation = jsonb_set(relation, '{test80}', $2::text::jsonb)
				 WHERE section_tipo = $1 AND section_id = $3`,
				[
					SECTION,
					JSON.stringify([
						{
							id: 1,
							type: 'dd151',
							section_id: String(IDS.beta),
							section_tipo: SECTION,
							from_component_tipo: 'test80',
						},
						{
							id: 2,
							type: 'dd151',
							section_id: String(IDS.alpha),
							section_tipo: SECTION,
							from_component_tipo: 'test80',
						},
					]),
					IDS.owner,
				],
			);
		}
	});

	test('component_filter: children dd156, invalid slot skipped, the cell resolves (T0-9)', async () => {
		// T0-9 D2/D5 (owner, 2026-11-11): a config-less component_filter's
		// children are the edit form's own — dd156 (the project name at dd153,
		// relations/config_children.ts) — so test101 takes the CHILDREN branch:
		// a target per VALID slot (the invalid first locator is skipped, its
		// index consumed), and component_filter IS a flat-value family now
		// ('datalist'): resolveCellValue resolves the cell instead of ledgering it.
		// (Until T0-9 test101 had no children and took the label branch, which
		// pushes a target for every stored slot.)
		const unresolved: string[] = [];
		const targets = await resolveRelationTargetValues(
			SECTION,
			IDS.owner,
			'test101',
			'lg-eng',
			unresolved,
		);
		expect(targets).toEqual([
			{ index: 1, sectionTipo: 'dd153', sectionId: '1', parts: ['General project'] },
		]);
		expect(unresolved).toEqual([]);
		const cellUnresolved: string[] = [];
		expect(await resolveCellValue(SECTION, IDS.owner, 'test101', 'lg-eng', cellUnresolved)).toBe(
			'General project',
		);
		expect(cellUnresolved).toEqual([]);
	});

	test('DATALIST branch (no children: test70 filter_master): every locator slot survives, labelled', async () => {
		// precondition, measured: the derivation gives test70 NO children (no
		// config, no `relations` — D2 reads only its own relations), so this IS
		// the no-children branch and not the children one
		expect(await exportConfigChildren('test70')).toEqual([]);
		// Unlike the children branch, this half pushes a target for EVERY stored
		// slot — the invalid first locator keeps index 0 with a null sectionTipo
		// and no parts.
		const unresolved: string[] = [];
		const targets = await resolveRelationTargetValues(
			SECTION,
			IDS.owner,
			'test70',
			'lg-eng',
			unresolved,
		);
		expect(targets.length).toBe(2);
		expect(targets[0]).toEqual({ index: 0, sectionTipo: null, sectionId: '1', parts: [] });
		// the valid slot is kept too; its label is EMPTY — resolveLocatorLabels
		// has nothing to show for a node with no config and no relations (the
		// slot, not the label, is what this branch pins)
		expect(targets[1]).toEqual({ index: 1, sectionTipo: 'dd153', sectionId: '1', parts: [] });
		expect(unresolved).toEqual([]);
	});

	test('DATALIST branch: the canonical playground record resolves its label', async () => {
		// test3/1's test101 points at dd153/1 — a read-only canonical fixture,
		// so the branch is proven against data this file did not write.
		const unresolved: string[] = [];
		const targets = await resolveRelationTargetValues(SECTION, 1, 'test101', 'lg-eng', unresolved);
		expect(targets).toEqual([
			{ index: 0, sectionTipo: 'dd153', sectionId: '1', parts: ['General project'] },
		]);
	});
});
