/**
 * GATE (behavioural, suite DB) — the scope-binding fixture is PER INSTANCE
 * (test/helpers/scope_binding_fixture.ts, 2026-10-25).
 *
 * Its ids used to be fixed constants (946001…), so two copies of one gate on ONE
 * suite database swept each other's fixture mid-run. The fix allocates every row
 * through the engine's counter door and hands the ids back in a handle. This gate
 * holds that, the way the defect showed:
 *
 *  - two installs RUNNING AT ONCE get pairwise-disjoint ids (every field, every
 *    written row) and distinct name tokens;
 *  - removing one leaves every row of the other in place, and removes its own;
 *  - an install that fails half-built sweeps what it wrote before rethrowing;
 *  - a caller's slot releases at most once: an afterAll after a failed install, or a
 *    second release, is a no-op — never a sweep of an absent or already-removed handle.
 *
 * Putting the fixed ids back reds the first two (mutation-checked).
 */

import { describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import {
	installScopeBindingFixture,
	type OwnedRecord,
	removeScopeBindingFixture,
	type ScopeBindingFixture,
	scopeBindingSlot,
} from '../helpers/scope_binding_fixture.ts';

const ID_FIELDS = [
	'userA',
	'userB',
	'profileA',
	'profileB',
	'hierarchyId',
	'presetOfA',
	'presetOfB',
	'presetSplit',
	'projectOfA',
] as const;

/** How many of `records` exist now (matrix rows, by table/section_tipo/section_id). */
async function present(records: readonly OwnedRecord[]): Promise<number> {
	let n = 0;
	for (const r of records) {
		const rows = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM "${r.table}" WHERE section_tipo = $1 AND section_id = $2`,
			[r.sectionTipo, r.sectionId],
		)) as { n: number }[];
		n += rows[0]?.n ?? 0;
	}
	return n;
}

const key = (r: OwnedRecord): string => `${r.table}/${r.sectionTipo}/${r.sectionId}`;

describe.if(DB_READY)('scope_binding_fixture — one instance never touches another', () => {
	test('two concurrent installs: disjoint ids and tokens; removing one keeps the other whole', async () => {
		const [first, second] = (await Promise.all([
			installScopeBindingFixture(),
			installScopeBindingFixture(),
		])) as [ScopeBindingFixture, ScopeBindingFixture];
		let firstRemoved = false;
		try {
			expect(first.records).toHaveLength(ID_FIELDS.length);
			expect(second.records).toHaveLength(ID_FIELDS.length);
			// Same section, different row: every handle field differs between the two.
			for (const field of ID_FIELDS) expect(first[field], field).not.toBe(second[field]);
			const a = new Set(first.records.map(key));
			expect(second.records.map(key).filter((k) => a.has(k))).toEqual([]);
			expect(first.token).not.toBe(second.token);
			expect(await present(first.records)).toBe(ID_FIELDS.length);
			expect(await present(second.records)).toBe(ID_FIELDS.length);

			await removeScopeBindingFixture(first);
			firstRemoved = true;
			expect(await present(first.records)).toBe(0);
			expect(await present(second.records), 'removing one instance swept the other').toBe(
				ID_FIELDS.length,
			);
		} finally {
			if (!firstRemoved) await removeScopeBindingFixture(first);
			await removeScopeBindingFixture(second);
		}
		expect(await present([...first.records, ...second.records])).toBe(0);
	});

	test('a half-built install sweeps what it wrote, then rethrows', async () => {
		let written: readonly OwnedRecord[] = [];
		const planted = new Error('planted: abort after the fifth row');
		const outcome = await installScopeBindingFixture([], {
			afterInsert(rows) {
				written = rows;
				if (rows.length === 5) throw planted;
			},
		}).then(
			() => null,
			(error: unknown) => error,
		);
		expect(outcome).toBe(planted);
		expect(written).toHaveLength(5);
		expect(await present(written), 'a half-built instance leaked rows').toBe(0);
	});

	test('a slot: release on an empty slot and a second release are no-ops; ids read only while held', async () => {
		const slot = scopeBindingSlot();
		expect(slot.installed).toBe(false);
		await slot.release(); // a failed install leaves the slot empty: no throw
		expect(() => slot.userA).toThrow('no instance installed');
		await slot.install();
		const records = [slot.userA, slot.userB];
		expect(slot.installed).toBe(true);
		await expect(slot.install()).rejects.toThrow('already holds');
		await slot.release();
		await slot.release(); // the second release sweeps nothing and does not throw
		expect(slot.installed).toBe(false);
		expect(() => slot.projectOfA).toThrow('no instance installed');
		expect(
			await present(
				records.map((sectionId) => ({ table: 'matrix_users', sectionTipo: 'dd128', sectionId })),
			),
		).toBe(0);
	});
});
