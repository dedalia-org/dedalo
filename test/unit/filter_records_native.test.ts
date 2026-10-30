/**
 * component_filter_records (dd478) — the TWO halves of the row-level record ACL.
 *
 * 1. THE EDITOR half: the emit hook's datalist rule
 *    (components/component_filter_records/emit.ts). PHP's json builder attaches
 *    `datalist` in edit/search and OMITS the key in list/tm
 *    (component_filter_records_json.php:117-152); both client renders that read
 *    it are UNGUARDED (`datalist.length`), so an edit item without the key
 *    renders zero rows — the component looked empty for every user.
 *
 * 2. THE ENFORCEMENT half: security/filter_records.ts + the assembler predicate
 *    (search/sql_assembler.ts buildUserRecordsFilter). A saved allow-list the
 *    engine ignores is a security ILLUSION, which is what v7 shipped until now
 *    (and what PHP shipped too — see WC-2026-08-12-filter-records-enforced).
 *
 * DB: one scratch dd128 row in the reserved ≥ 900000 band (the scratch-id law of
 * test/helpers/acl_identity_fixture.ts), swept in afterAll.
 */
// Generic-TLD migration 2026-08-20 (AGENTS.md hard rule). Install tipos were replaced
// by their twins (src/core/test_data/test_tld_tipo_map.json); the seed-shipped ones
// (rsc/dd/hierarchy/ontology/lg) ship with every installation and stay, spelled through
// `seed()` so the census can tell a reference from a binding.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { filterRecordsEmitHook } from '../../src/core/components/component_filter_records/emit.ts';
import type { EmitHookContext } from '../../src/core/components/emit_hooks.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { sql } from '../../src/core/db/postgres.ts';
import type { DataItem } from '../../src/core/resolve/component_data.ts';
import {
	clearUserFilterRecordsCache,
	getUserFilterRecords,
} from '../../src/core/security/filter_records.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

/** Seed-shipped tipo, spelled so the census sees a reference, not a binding. */
const seed = <T extends string, N extends number>(tld: T, id: N): `${T}${N}` => `${tld}${id}`;

const USERS_SECTION = 'dd128';
const FILTER_RECORDS = 'dd478';
/** Scratch user, reserved band — never an installed id (see the header). */
const SCRATCH_USER_ID = 930101;
/** A user with NO dd478 datum: the normal case must stay unfiltered. */
const UNFILTERED_USER_ID = 930102;
/** Two real sections of the suite DB — the allow-list names only the first. */
const GATED_SECTION = 'test3';
const OTHER_SECTION = 'dd128';

/** The stored datum, exactly as the editor writes it (id + tipo + int list). */
const STORED_ENTRIES = [
	{ id: 1, tipo: GATED_SECTION, value: [10, 27, 10] }, // the duplicate id is deduped
	{ id: 2, tipo: seed('rsc', 170), value: [] }, // empty ⇒ NOT a lockout, skipped
	{ id: 3, tipo: 'test6099', value: [3, 'x', 0, -2] }, // only the valid int survives
	// The LEGACY malformed shape that real data carries (observed on the client
	// playground record: a nested {tipo,value} under `value` and NO top-level
	// tipo). It names no section, so it can restrict none.
	{ id: 4, value: [{ tipo: seed('rsc', 167), value: [30, 26] }] },
];

function principalFor(userId: number): Principal {
	return { userId, isGlobalAdmin: false, isDeveloper: false };
}

async function deleteScratchUsers(): Promise<void> {
	await sql.unsafe('DELETE FROM matrix_users WHERE section_tipo = $1 AND section_id IN ($2, $3)', [
		USERS_SECTION,
		SCRATCH_USER_ID,
		UNFILTERED_USER_ID,
	]);
}

beforeAll(async () => {
	await deleteScratchUsers(); // idempotent: sweep a crashed run first
	await sql.unsafe(
		'INSERT INTO matrix_users ("section_tipo", "section_id", "misc") VALUES ($1, $2, $3::text::jsonb)',
		[USERS_SECTION, SCRATCH_USER_ID, encodeForJsonb({ [FILTER_RECORDS]: STORED_ENTRIES })],
	);
	await sql.unsafe('INSERT INTO matrix_users ("section_tipo", "section_id") VALUES ($1, $2)', [
		USERS_SECTION,
		UNFILTERED_USER_ID,
	]);
	clearUserFilterRecordsCache();
});

afterAll(async () => {
	await deleteScratchUsers();
	clearUserFilterRecordsCache();
});

describe('component_filter_records — the stored allow-list', () => {
	test('reads as section_tipo → validated ids; empty and invalid entries drop', async () => {
		const allowed = await getUserFilterRecords(SCRATCH_USER_ID);
		expect(allowed.get(GATED_SECTION)).toEqual([10, 27]);
		// An empty list is "no restriction", never "sees nothing" (the editor's
		// remove action is how a row is cleared) — the key must be ABSENT.
		expect(allowed.has(seed('rsc', 170))).toBe(false);
		// Every id reaches SQL as an integer literal: non-ints and non-positives
		// must never survive the reader.
		expect(allowed.get('test6099')).toEqual([3]);
		// The tipo-less legacy entry names no section: it must contribute nothing
		// (and must NOT be read through its nested {tipo,value} payload).
		expect(allowed.has(seed('rsc', 167))).toBe(false);
		expect(allowed.size).toBe(2);
	});

	test('a user with no datum has no restriction at all', async () => {
		expect((await getUserFilterRecords(UNFILTERED_USER_ID)).size).toBe(0);
	});
});

describe('component_filter_records — the search predicate', () => {
	test('restricts the named section to its allowed ids', async () => {
		const built = await buildSearchSql(
			{ section_tipo: [GATED_SECTION], limit: 10 },
			{ principal: principalFor(SCRATCH_USER_ID) },
		);
		expect(built.sql).toContain('.section_id IN (10,27)');
	});

	test('EXECUTED: the restricted search returns only the allowed records', async () => {
		// The predicate is only worth anything if the DATABASE agrees — string
		// matching the SQL proves the clause was built, not that it filters.
		// ADMIN principals: the projects filter would otherwise empty BOTH sides
		// (a projects-less user sees nothing in a gated section) and the contrast
		// would be 0 vs 0 — the green-suite trap. The record ACL applies to admins
		// too, which is exactly what this pair proves.
		const admin = (userId: number) => ({ ...principalFor(userId), isGlobalAdmin: true });
		const unfiltered = await buildSearchSql(
			{ section_tipo: [GATED_SECTION], limit: 100 },
			{ principal: admin(UNFILTERED_USER_ID) },
		);
		const gated = await buildSearchSql(
			{ section_tipo: [GATED_SECTION], limit: 100 },
			{ principal: admin(SCRATCH_USER_ID) },
		);
		const idsOf = async (query: { sql: string; params: unknown[] }) =>
			(
				(await sql.unsafe(query.sql, query.params as (string | number | null)[])) as {
					section_id: number;
				}[]
			).map((row) => Number(row.section_id));

		const all = await idsOf(unfiltered);
		const allowedIds = await idsOf(gated);
		// Non-vacuity: the section really holds records outside the allow-list,
		// so "returns only 10 and 27" is a restriction and not an empty section.
		expect(all.length).toBeGreaterThan(allowedIds.length);
		expect([...allowedIds].sort((a, b) => a - b)).toEqual([10, 27]);
	});

	test('a section the allow-list does not name is untouched', async () => {
		const built = await buildSearchSql(
			{ section_tipo: [OTHER_SECTION], limit: 10 },
			{ principal: principalFor(SCRATCH_USER_ID) },
		);
		expect(built.sql).not.toContain('.section_id IN (');
	});

	test('a user with no allow-list gets the unfiltered query', async () => {
		const built = await buildSearchSql(
			{ section_tipo: [GATED_SECTION], limit: 10 },
			{ principal: principalFor(UNFILTERED_USER_ID) },
		);
		expect(built.sql).not.toContain('.section_id IN (');
	});

	test('an INTERNAL search (no principal) is never gated', async () => {
		const built = await buildSearchSql({ section_tipo: [GATED_SECTION], limit: 10 }, {});
		expect(built.sql).not.toContain('.section_id IN (');
	});

	test('multi-section gates only the named branch, never the siblings', async () => {
		const built = await buildSearchSql(
			{ section_tipo: [GATED_SECTION, OTHER_SECTION], limit: 10 },
			{ principal: principalFor(SCRATCH_USER_ID) },
		);
		// The gated branch carries the id list; the ungated sibling passes on its
		// bare section_tipo guard (a UNION branch must not inherit the list).
		expect(built.sql).toContain('.section_id IN (10,27)');
		const gatedIndex = built.sql.indexOf('.section_id IN (10,27)');
		const otherGuard = built.sql.lastIndexOf('.section_tipo = ');
		expect(otherGuard).toBeGreaterThan(-1);
		expect(gatedIndex).toBeGreaterThan(-1);
	});
});

describe('component_filter_records — the edit datalist', () => {
	/** A minimal hook context: only `ddoMode` drives the datalist rule. */
	function contextFor(mode: string): EmitHookContext {
		return { ddoMode: mode } as unknown as EmitHookContext;
	}

	test('list omits the key entirely (PHP get_list_value branch)', async () => {
		// 'tm' used to be asserted alongside 'list' here. The ddo/display mode is
		// retired (WC-2026-08-14-tm-ddo-mode-retired): a Time Machine cell IS a
		// list cell and reaches this hook as 'list', so the pair collapsed into
		// one case rather than one of them silently going unchecked.
		const item = { tipo: FILTER_RECORDS } as unknown as DataItem;
		await filterRecordsEmitHook.decorateItem?.(item, contextFor('list'));
		expect('datalist' in item).toBe(false);
	});

	test('edit / search ALWAYS carry the key — the client render is unguarded', async () => {
		for (const mode of ['edit', 'search']) {
			const item = { tipo: FILTER_RECORDS } as unknown as DataItem;
			// No request principal here (unit context) ⇒ the fail-closed empty
			// array, never another user's authorized sections.
			await filterRecordsEmitHook.decorateItem?.(item, contextFor(mode));
			expect(item.datalist).toEqual([]);
		}
	});
});
