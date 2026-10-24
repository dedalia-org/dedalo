/**
 * move_* transform engine (UPDATE_PROCESS Phase 5, WC-025) — pure-logic units
 * (locator rebasing, definition-file confinement, dry-run report), safe
 * DRY-RUN smoke over the real DB with NON-EXISTENT scratch tipos (SELECT-only,
 * zero writes), and a real EXECUTE of changes_in_tipos on the matrix_test
 * scratch table (no live data carries the zzt* tipos, cleaned up after).
 * Portalize/locators EXECUTE against live sections is an operator drill
 * (ledgered) — the dry-run + the recorder logic are the automated surface.
 */
// Migrated off install TLDs 2026-08-20: the locator-rebase fixtures are pure
// in-memory payloads, so their tipos are now synthetic `zzlr*` names, and the
// refusal cases rename into the reserved scratch tld `zzq` — no install is named
// anywhere in this file.

import { afterAll, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from '../../src/core/db/postgres.ts';
import { rebaseLocatorsInValue } from '../../src/core/update/transform/locator_rewrite.ts';
import { TransformRecorder } from '../../src/core/update/transform/report.ts';
import { executeChangesInTipos } from '../../src/core/update/transform/tipos.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const SCRATCH_ROOT = scratchDir('transform');
afterAll(() => rmSync(SCRATCH_ROOT, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// locator rebasing (pure)
// ---------------------------------------------------------------------------

describe('rebaseLocatorsInValue', () => {
	test('rebases matching locators, offsets section_id, preserves shape', () => {
		const value = {
			zzlr9: [
				{ section_tipo: 'zzlr1', section_id: 5, from_component_tipo: 'zzlr9', type: 'dd151' },
				{ section_tipo: 'zzlr3', section_id: 7 }, // unrelated — untouched
			],
			nested: { deep: [{ section_tipo: 'zzlr1', section_id: '12' }] },
		};
		const changed = rebaseLocatorsInValue(value, {
			oldTipo: 'zzlr1',
			newTipo: 'zzlr2',
			baseCounter: 1000,
		});
		expect(changed).toBe(true);
		expect(value.zzlr9[0]).toEqual({
			section_tipo: 'zzlr2',
			section_id: 1005,
			from_component_tipo: 'zzlr9',
			type: 'dd151',
		});
		expect(value.zzlr9[1]).toEqual({ section_tipo: 'zzlr3', section_id: 7 });
		// string section_id stays a string
		expect(value.nested.deep[0]).toEqual({ section_tipo: 'zzlr2', section_id: '1012' });
	});

	test('rebases dataframe key pairs; returns false when nothing matches', () => {
		const df = [
			{ section_tipo_key: 'zzlr1', section_id_key: 3, section_tipo: 'other', section_id: 1 },
		];
		expect(
			rebaseLocatorsInValue(df, { oldTipo: 'zzlr1', newTipo: 'zzlr2', baseCounter: 100 }),
		).toBe(true);
		expect(df[0]).toMatchObject({ section_tipo_key: 'zzlr2', section_id_key: 103 });
		expect(rebaseLocatorsInValue({ a: 1 }, { oldTipo: 'x1', newTipo: 'y1', baseCounter: 5 })).toBe(
			false,
		);
	});
});

// ---------------------------------------------------------------------------
// definition-file confinement (temp dir)
// ---------------------------------------------------------------------------

describe('definition files (confined loading)', () => {
	test('lists + loads json; refuses traversal', async () => {
		const base = join(SCRATCH_ROOT, 'defs');
		mkdirSync(join(base, 'move_tld'), { recursive: true });
		writeFileSync(join(base, 'move_tld', 'a.json'), JSON.stringify([{ old: 'x1', new: 'y1' }]));
		writeFileSync(join(base, 'move_tld', 'bad.txt'), 'ignored');

		// A SNAPSHOT: mock.module rewrites the live namespace in place, so restoring
		// from `await import()` itself would leave the scratch definitions dir in the
		// config of every later file (mock_isolation_tripwire rule 3).
		const realConfig = { ...(await import('../../src/config/config.ts')) };
		mock.module('../../src/config/config.ts', () => ({
			...realConfig,
			config: {
				...realConfig.config,
				ops: { ...realConfig.config.ops, transformDefinitionsDir: base },
			},
		}));
		try {
			const { listDefinitionFiles, loadDefinitionFile } = await import(
				'../../src/core/update/transform/definitions.ts'
			);
			const files = listDefinitionFiles('move_tld');
			expect(files.map((f) => f.file_name)).toEqual(['a.json']);
			expect(loadDefinitionFile('move_tld', 'a.json')).toEqual([{ old: 'x1', new: 'y1' }]);
			expect(loadDefinitionFile('move_tld', '../move_tld/a.json')).toBeNull();
			expect(loadDefinitionFile('move_tld', 'missing.json')).toBeNull();
		} finally {
			mock.module('../../src/config/config.ts', () => realConfig);
			mock.restore();
		}
	});
});

// ---------------------------------------------------------------------------
// dry-run report (pure)
// ---------------------------------------------------------------------------

describe('TransformRecorder', () => {
	test('counts ops, caps the sample, reports dry-run vs execute', () => {
		const rec = new TransformRecorder(true);
		for (let i = 0; i < 5; i++) rec.record({ op: 'update', table: 'matrix', target: `id ${i}` });
		rec.record({ op: 'delete', table: 'matrix_counter', target: 'x1' });
		const report = rec.toReport('move_tld');
		expect(report.dryRun).toBe(true);
		expect(report.ok).toBe(true);
		expect(report.counts).toEqual({ update: 5, delete: 1 });
		expect(report.msg).toContain('DRY RUN');
		expect(report.msg).toContain('6 change(s)');
	});
});

// ---------------------------------------------------------------------------
// safe DRY-RUN smoke over the real DB (SELECT-only, non-existent tipos)
// ---------------------------------------------------------------------------

describe('executor dry-run smoke (no writes; queries must be valid)', () => {
	async function dbUp(): Promise<boolean> {
		try {
			await sql.unsafe('SELECT 1', []);
			return true;
		} catch {
			return false;
		}
	}

	test('changes_in_tipos dry-run over a non-existent tipo touches nothing', async () => {
		if (!(await dbUp())) return;
		const rec = new TransformRecorder(true);
		await executeChangesInTipos(
			[{ old: 'zztnope1', new: 'zztnope2', type: 'section', perform: [] }],
			rec,
		);
		expect(rec.errors).toEqual([]);
		// nothing in the DB carries these tipos → zero recorded deltas
		expect(Object.keys(rec.counts).length).toBe(0);
	}, 60000);

	// -------------------------------------------------------------------------
	// move_tld renames TIPOS, never TLD NAMESPACES (ONT-TLD). Both halves of that
	// boundary are pinned here, because both were reached for by real migrations.
	// -------------------------------------------------------------------------

	test('a BARE-TLD entry is rejected — TIPO_RE is a boundary, not an oversight', async () => {
		if (!(await dbUp())) return;
		const rec = new TransformRecorder(true);
		// The intuitive way to write `objet` → `object`, and the reason TIPO_RE
		// demands digits: a bare tld lives in ontology7 as a plain string, which no
		// tipo rewrite in this executor can reach. Loosening the regex to "support"
		// this would silently half-rename every install that ran it.
		await executeChangesInTipos([{ old: 'zznex', new: 'zzq', type: 'section', perform: [] }], rec);

		expect(rec.errors.join(' | ')).toContain('unsafe old/new tipo');
		expect(Object.keys(rec.counts).length).toBe(0);
	}, 60000);

	test('an ONTOLOGY ROOT section (<tld>0) is REFUSED, pointing at the path that works', async () => {
		if (!(await dbUp())) return;
		const rec = new TransformRecorder(true);
		// `qdp0` → `zzq0` passes TIPO_RE but cannot work: the rows carry their tld in
		// ontology7 (untouchable here), and matrix_ontology's UNIQUE (section_id,
		// section_tipo) makes the bulk UPDATE abort part-way — with no transaction
		// and no rollback in this executor, that is an unrecoverable half-rename.
		await executeChangesInTipos(
			[{ old: 'zznex0', new: 'zzq0', type: 'section', perform: [] }],
			rec,
		);

		const errors = rec.errors.join(' | ');
		expect(errors).toContain('ontology root section');
		expect(errors).toContain('ontology7');
		expect(errors).toContain('ontology master'); // the operation that DOES work
		// Refused means refused: not one statement ran for it.
		expect(Object.keys(rec.counts).length).toBe(0);
	}, 60000);

	test('refusing one entry does not cancel the SAFE entries beside it', async () => {
		if (!(await dbUp())) return;
		const rec = new TransformRecorder(true);
		// The safe entry must MATCH SOMETHING, or this test cannot fail for the reason
		// it exists: with a tipo that hits no row, rec.counts is empty whether the
		// entry survived or was dropped, and asserting only on rec.errors leaves the
		// non-cancellation claim ungated. `ontology5` is a real component tipo embedded
		// in thousands of jsonb rows; the run is DRY, so nothing is written — the
		// recorder only counts the rows the rewrite WOULD touch.
		await executeChangesInTipos(
			[
				{ old: 'dd0', new: 'zztgone0', type: 'section', perform: [] }, // refused (<tld>0)
				{ old: 'ontology5', new: 'zztgone5', type: 'component', perform: [] }, // safe, and real
			],
			rec,
		);

		expect(rec.errors.length).toBe(1);
		expect(rec.errors.join(' ')).toContain('dd0');
		// THE ASSERTION THAT PINS IT: the surviving entry actually ran.
		const recorded = JSON.stringify(rec.counts);
		expect(Object.keys(rec.counts).length).toBeGreaterThan(0);
		expect(recorded).not.toContain('zztgone0'); // …and the refused one did not
	}, 60000);
});

// ---------------------------------------------------------------------------
// real EXECUTE of changes_in_tipos on the matrix_test scratch table
// ---------------------------------------------------------------------------

describe('changes_in_tipos EXECUTE on matrix_test (scratch tipos)', () => {
	const SRC = 'zzttra1';
	const DST = 'zzttrb1';
	// a component tipo referenced inside another row's relation column
	const REFSRC = 'zzttrc1';
	const REFDST = 'zzttrd1';

	async function dbUp(): Promise<boolean> {
		try {
			await sql.unsafe('SELECT 1', []);
			return true;
		} catch {
			return false;
		}
	}

	afterAll(async () => {
		try {
			await sql.unsafe(
				"DELETE FROM matrix_test WHERE section_tipo IN ($1,$2) OR relation::text LIKE '%zzttr%'",
				[SRC, DST],
			);
			// The counter rows too — the rename CARRIES a counter to the destination
			// tipo now (P0-14), so leaving them behind leaks scratch high-water marks
			// into the suite database.
			await sql.unsafe('DELETE FROM matrix_counter WHERE tipo IN ($1,$2)', [SRC, DST]);
		} catch {
			/* best effort */
		}
	});

	test('renames section_tipo + rewrites embedded component tipo, CARRIES the counter', async () => {
		if (!(await dbUp())) {
			console.warn('[UNCOVERED] DB unreachable — changes_in_tipos execute skipped');
			return;
		}
		// seed: one record in the moving section, one record referencing the
		// moving component tipo inside its relation column.
		await sql.unsafe(
			`INSERT INTO matrix_test (section_id, section_tipo, relation)
			 VALUES (9001, $1, '{}'::jsonb), (9002, 'zztother1', $2::text::jsonb)`,
			[
				SRC,
				JSON.stringify({
					zztkeep1: [{ section_tipo: SRC, section_id: 9001, from_component_tipo: REFSRC }],
				}),
			],
		);
		await sql.unsafe(
			'INSERT INTO matrix_counter (tipo, value) VALUES ($1, 9001) ON CONFLICT (tipo) DO UPDATE SET value = 9001',
			[SRC],
		);
		// No counter stands at the destination yet — the carry must create it.
		await sql.unsafe('DELETE FROM matrix_counter WHERE tipo = $1', [DST]);

		const rec = new TransformRecorder(false);
		await executeChangesInTipos(
			[
				{ old: SRC, new: DST, type: 'section', perform: ['replace_tipo'] },
				{ old: REFSRC, new: REFDST, type: 'component', perform: ['replace_tipo'] },
			],
			rec,
		);
		expect(rec.errors).toEqual([]);

		// section_tipo renamed
		const moved = (await sql.unsafe('SELECT section_id FROM matrix_test WHERE section_tipo = $1', [
			DST,
		])) as { section_id: number }[];
		expect(moved.map((r) => r.section_id)).toContain(9001);
		expect(
			(await sql.unsafe('SELECT 1 FROM matrix_test WHERE section_tipo = $1', [SRC])) as unknown[],
		).toEqual([]);

		// embedded locator rewritten: SRC→DST and REFSRC→REFDST inside the referencing row
		const [ref] = (await sql.unsafe(
			'SELECT relation::text AS rel FROM matrix_test WHERE section_id = 9002 AND section_tipo = $1',
			['zztother1'],
		)) as { rel: string }[];
		expect(ref?.rel).toContain(`"${DST}"`);
		expect(ref?.rel).toContain(`"${REFDST}"`);
		expect(ref?.rel).not.toContain(`"${SRC}"`);
		expect(ref?.rel).not.toContain(`"${REFSRC}"`);

		// COUNTER CARRIED, not dropped (P0-14). The rename moves the records and
		// their TM rows without changing a single section_id, so the section's
		// high-water mark has to move with them; PHP dropped it and let the
		// allocator rebuild from live rows, which re-minted deleted records' ids.
		const carried = (await sql.unsafe('SELECT value FROM matrix_counter WHERE tipo = $1', [
			DST,
		])) as { value: number }[];
		expect(carried.length).toBe(1);
		expect(Number(carried[0]?.value)).toBe(9001);
		// and the source row is gone
		expect(
			(await sql.unsafe('SELECT 1 FROM matrix_counter WHERE tipo = $1', [SRC])) as unknown[],
		).toEqual([]);
		// The full-table embedded-tipo sweep across every table×column is
		// inherently O(all rows) (PHP tables_rows_iterator too — the widget
		// warns "a very long process… all the records in all the tables"); the
		// generous budget reflects a real migration on the dev DB volume.
	}, 300000);
});
