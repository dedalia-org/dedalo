/**
 * dedalo_find_or_create — two concurrent calls with the same match create ONE record
 * (review-diff 2026-10-21, correctness S3).
 *
 * The defect: the exact-match search ran outside any lock and the create
 * transaction did not repeat it, so a second call that searched while the first
 * call's record was still uncommitted missed it and created a duplicate — the very
 * thing an entity-dedup primitive exists to prevent.
 *
 * Driven deterministically: the first call runs inside a transaction held OPEN
 * (lock_interleave), the second starts against it. Pinned: ONE record in the
 * section, the second call answers the first call's record with created:false
 * (it waited on the section's find-or-create lock, then found it), and the
 * record carries the match value exactly once.
 *
 * SCRATCH: `zzfoc` situation (section + input_text → matrix_test), swept by
 * dropSituation, zero residue asserted.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { findOrCreate } from '../../src/ai/mcp/tools/fields_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { interleave } from '../helpers/lock_interleave.ts';

const SECTION = 'zzfoc1';
const NAME = 'zzfoc2';

const SITUATION = situation({
	tld: 'zzfoc',
	name: 'mcp find_or_create race',
	nodes: [
		{ tipo: SECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'Zz entities' } },
		{ tipo: NAME, parent: SECTION, model: 'component_input_text', term: { 'lg-eng': 'Zz name' } },
		// The create branch asks the New-button predicate (T0-2): no button_new, no
		// create — the superuser included.
		{ tipo: 'zzfoc3', parent: SECTION, model: 'button_new' },
	],
});

async function sectionIds(): Promise<number[]> {
	const rows = (await sql.unsafe(
		'SELECT section_id FROM matrix_test WHERE section_tipo = $1 ORDER BY section_id',
		[SECTION],
	)) as { section_id: number }[];
	return rows.map((row) => Number(row.section_id));
}

beforeAll(async () => {
	await ensureSituation(SITUATION);
});

afterAll(async () => {
	expect(await dropSituation(SITUATION)).toBe(0);
});

describe('find_or_create under concurrency', () => {
	test('a second call racing an uncommitted create finds it — ONE record, created:false', async () => {
		const principal = await resolvePrincipal(-1);
		const input = { section_tipo: SECTION, match: [{ field: NAME, value: 'Zz Mint of Toledo' }] };
		let first: { section_id: number; created: boolean } | null = null;
		const { blocked, result: second } = await interleave(
			async () => {
				first = await findOrCreate(principal, input);
			},
			() => findOrCreate(principal, input),
		);
		expect(first).not.toBeNull();
		expect((first as unknown as { created: boolean }).created).toBe(true);
		expect(blocked).toBe(true);
		expect(second.created).toBe(false);
		expect(second.section_id).toBe((first as unknown as { section_id: number }).section_id);
		const ids = await sectionIds();
		expect(ids).toHaveLength(1);
		// And a later call (nothing racing) still finds that same record.
		const third = await findOrCreate(principal, input);
		expect(third).toEqual({ section_tipo: SECTION, section_id: ids[0] as number, created: false });
	}, 30000);
});
