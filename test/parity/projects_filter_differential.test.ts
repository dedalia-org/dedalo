/**
 * Phase 5c gate: projects filter (per-record ACL) differential.
 *
 * `testmint1` is gated by its component_filter `testmint1013`; each record may
 * reference one or more projects (`dd153`). A non-admin principal must see
 * EXACTLY the records referencing one of THEIR projects — the same set a direct
 * EXISTS query returns. Admins and internal (no principal) searches see
 * everything.
 *
 * @twinned-by   test/unit/search_projects_filter_multisection.test.ts
 */
// GENERIC-TLD MIGRATED 2026-08-19 (WC-2026-08-19-test-tld-replay-search-group).
// This gate never had a PHP oracle: it compares the TS search engine with a
// DIRECT SQL ground truth over the SAME rows, so migrating it is a matter of
// building the situation instead of borrowing an install's. It now does:
//  - the gated/virtual/second-gated sections and the non-admin USER come from
//    the committed test corpus (`ensureTestCorpus`, dropped after);
//  - the UNGATED case builds its own records, because NO corpus section is
//    ungated (measured 2026-08-19: every one resolves a component_filter,
//    thesaurus clones through the virtual→real fallback) — `test183` is a
//    generic `test` section with no component_filter, and this gate writes and
//    removes the two records it needs there;
//  - the project ids are READ from the non-admin's own user record instead of
//    being a hand-copied install constant.
// The scale-bound page assertions ('a 200-row page of a 15k section comes back
// full') are restated as what they were actually pinning: an unfiltered search
// returns the section's WHOLE record set, which is a stronger statement over a
// situation whose size the gate knows.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sanitizeClientSqo } from '../../src/core/concepts/sqo.ts';
import {
	deleteMatrixRecord,
	insertMatrixRecordWithExplicitId,
} from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getComponentFilterTipo } from '../../src/core/ontology/resolver.ts';
import { matrixReadSource } from '../../src/core/section/read_source.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { getUserProjects } from '../../src/core/security/permissions.ts';
import { dropTestCorpus, ensureTestCorpus } from '../../src/core/test_data/test_corpus/ensure.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

/** Every `test` section stores here (test_corpus/ensure.ts, plan decision 1). */
const TEST_TABLE = 'matrix_test';

/** The project-gated section under test, and its component_filter. */
const GATED_SECTION = 'testmint1';
const GATED_FILTER = 'testmint1013';

/**
 * A SECOND gated section with a DIFFERENT filter tipo — the multi-section ACL
 * is only meaningful when the two predicates cannot be confused.
 */
const OTHER_GATED_SECTION = 'test6100';
const OTHER_GATED_FILTER = 'test6254';

/**
 * A VIRTUAL section: `test6101`'s ontology relations name `testplace1`, whose
 * model is `section`, so its component_filter is resolved through the REAL
 * section (`testplace1014`). Until 2026-07-19 the TS lookup was strict
 * own-subtree and FAILED OPEN here.
 */
const VIRTUAL_SECTION = 'test6101';

/** A generic `test` section with NO component_filter — records built below. */
const UNGATED_SECTION = 'test183';
/** Scratch ids for the two ungated records (reserved ≥ 900000 band). */
const UNGATED_IDS = [940101, 940102] as const;

/**
 * The non-admin: corpus user `dd128`/2, whose `dd170` names real projects. The
 * ids are never hard-coded — `getUserProjects` reads them the way the engine
 * does, so a corpus change cannot leave this gate asserting against a project
 * nobody holds.
 */
const NON_ADMIN_USER_ID = 2;
/** A user with NO `dd170` at all: every gated section must be empty for them. */
const PROJECTLESS_USER_ID = 999999;

const CORPUS_SECTIONS = [GATED_SECTION, OTHER_GATED_SECTION, VIRTUAL_SECTION, 'dd128'] as const;

/** The non-admin's projects, read once from the provisioned corpus. */
let projects: number[] = [];

/** A synthetic non-admin principal (admin-ness is forced; projects are read). */
function nonAdmin(userId: number): Principal {
	return { userId, isGlobalAdmin: false, isDeveloper: false };
}

const admin: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };

async function runSearchIds(
	sqoInput: Record<string, unknown>,
	principal?: Principal,
): Promise<Set<number>> {
	const sqo = sanitizeClientSqo(structuredClone(sqoInput));
	const { sql: builtSql, params } = await buildSearchSql(sqo, { principal });
	const rows = (await sql.unsafe(builtSql, params as (string | number | null)[])) as {
		section_id: number;
	}[];
	return new Set(rows.map((row) => Number(row.section_id)));
}

/** Every record of a section, straight from its table. */
async function allIds(sectionTipo: string): Promise<Set<number>> {
	const rows = (await sql.unsafe(
		`SELECT DISTINCT section_id FROM ${TEST_TABLE} WHERE section_tipo = $1`,
		[sectionTipo],
	)) as { section_id: number }[];
	return new Set(rows.map((row) => Number(row.section_id)));
}

/** The records a user holding `projects` may see on a gated section. */
async function gatedTruth(sectionTipo: string, filterTipo: string): Promise<Set<number>> {
	const rows = (await sql.unsafe(
		`SELECT DISTINCT section_id FROM ${TEST_TABLE}
		 WHERE section_tipo = $1
		   AND EXISTS (
			SELECT 1 FROM jsonb_array_elements(relation -> $2) e
			WHERE (e->>'section_id') = ANY($3::text[])
		)`,
		[sectionTipo, filterTipo, `{${projects.join(',')}}`],
	)) as { section_id: number }[];
	return new Set(rows.map((row) => Number(row.section_id)));
}

beforeAll(async () => {
	await ensureTestCorpus([...CORPUS_SECTIONS]);
	projects = await getUserProjects(NON_ADMIN_USER_ID);
	// Fixture guard: a projects-less "non-admin" would make every gated
	// assertion below satisfiable at zero versus zero.
	expect(projects.length).toBeGreaterThan(0);

	// The ungated situation, built (no corpus section is ungated).
	expect(await getComponentFilterTipo(UNGATED_SECTION)).toBe(null);
	for (const id of UNGATED_IDS) {
		await deleteMatrixRecord(TEST_TABLE, UNGATED_SECTION, id);
		await insertMatrixRecordWithExplicitId(TEST_TABLE, UNGATED_SECTION, id, {
			data: { section_id: id, section_tipo: UNGATED_SECTION },
		});
	}
}, 120000);

afterAll(async () => {
	for (const id of UNGATED_IDS) {
		expect(await deleteMatrixRecord(TEST_TABLE, UNGATED_SECTION, id)).toBe(1);
	}
	expect(await dropTestCorpus([...CORPUS_SECTIONS])).toBe(0);
});

describe('projects filter differential (Phase 5c gate)', () => {
	test('non-admin sees exactly the records in their own projects', async () => {
		const truthIds = await gatedTruth(GATED_SECTION, GATED_FILTER);
		const total = await allIds(GATED_SECTION);
		// Fixture guards: the situation must be genuinely PARTIAL, or a
		// fail-open build would pass this test.
		expect(truthIds.size).toBeGreaterThan(0);
		expect(truthIds.size).toBeLessThan(total.size);

		const searched = await runSearchIds(
			{ section_tipo: [GATED_SECTION], limit: 500, offset: 0 },
			nonAdmin(NON_ADMIN_USER_ID),
		);
		// No over-return…
		for (const id of searched) expect(truthIds.has(id)).toBe(true);
		// …and no under-return (the whole set fits one page).
		expect(searched.size).toBe(truthIds.size);
	});

	test('admin sees everything (filter skipped)', async () => {
		const total = await allIds(GATED_SECTION);
		const adminIds = await runSearchIds(
			{ section_tipo: [GATED_SECTION], limit: 500, offset: 0 },
			admin,
		);
		expect(adminIds).toEqual(total);
		// The contrast is real: the non-admin sees strictly fewer.
		expect((await gatedTruth(GATED_SECTION, GATED_FILTER)).size).toBeLessThan(total.size);
	});

	test('internal search (no principal) skips the filter', async () => {
		const ids = await runSearchIds({ section_tipo: [GATED_SECTION], limit: 500, offset: 0 });
		expect(ids).toEqual(await allIds(GATED_SECTION));
	});

	test('non-admin with NO projects sees nothing on a gated section', async () => {
		expect(await getUserProjects(PROJECTLESS_USER_ID)).toEqual([]);
		const ids = await runSearchIds(
			{ section_tipo: [GATED_SECTION], limit: 50, offset: 0 },
			nonAdmin(PROJECTLESS_USER_ID),
		);
		expect(ids.size).toBe(0);
	});

	test('non-gated section is unaffected by the projects filter', async () => {
		// test183 has NO component_filter (asserted in beforeAll) and is not on a
		// projects-exempt table → a non-admin sees its full record set.
		const ids = await runSearchIds(
			{ section_tipo: [UNGATED_SECTION], limit: 50, offset: 0 },
			nonAdmin(NON_ADMIN_USER_ID),
		);
		expect(ids).toEqual(new Set(UNGATED_IDS));
	});

	test('VIRTUAL section is gated through its REAL section (test6101 → testplace1)', async () => {
		// Records of a virtual section are STORED under the virtual tipo but gated
		// by the REAL section's component_filter — PHP resolve_virtual=true
		// (trait.where.php build_sql_projects_filter). A strict own-subtree lookup
		// FAILS OPEN here: it would return the whole section.
		const truthIds = await gatedTruth(VIRTUAL_SECTION, 'testplace1014');
		const total = await allIds(VIRTUAL_SECTION);
		expect(total.size).toBeGreaterThan(0); // the situation exists…
		const ids = await runSearchIds(
			{ section_tipo: [VIRTUAL_SECTION], limit: 500, offset: 0 },
			nonAdmin(NON_ADMIN_USER_ID),
		);
		expect(ids).toEqual(truthIds);
		// …and it is genuinely gated: the fail-open answer is the full set.
		expect(ids.size).toBeLessThan(total.size);
		expect(await runSearchIds({ section_tipo: [VIRTUAL_SECTION], limit: 500 }, admin)).toEqual(
			total,
		);
	});

	test('a second gated section is scoped by its OWN filter tipo', async () => {
		const truthIds = await gatedTruth(OTHER_GATED_SECTION, OTHER_GATED_FILTER);
		const total = await allIds(OTHER_GATED_SECTION);
		expect(truthIds.size).toBeGreaterThan(0);
		expect(truthIds.size).toBeLessThan(total.size);
		const ids = await runSearchIds(
			{ section_tipo: [OTHER_GATED_SECTION], limit: 500, offset: 0 },
			nonAdmin(NON_ADMIN_USER_ID),
		);
		expect(ids).toEqual(truthIds);
	});
});

/**
 * MULTI-SECTION projects filter (2026-07-09, WC-011) — the autocomplete
 * picker's normal shape. Replaces the Phase 5c fail-closed throw with
 * per-section predicates: each section scoped by its OWN component_filter
 * tipo behind a section_tipo guard. DELIBERATE strictly-safer divergence from
 * PHP, whose filter keys off the FIRST section only (trait.where.php:743-744
 * + the str_replace UNION copy, class.search.php:1048-1065): ungated-first is
 * fail-OPEN there (gated sections leak unfiltered). These cases assert TS
 * ground-truth sets, NOT PHP equality — running them against PHP would (and
 * should) diverge on the fail-open case.
 */
describe('multi-section projects filter (per-section ACL, WC-011)', () => {
	/** Keyed runner: section_ids collide across sections, so key by tipo/id. */
	async function runSearchKeys(
		sqoInput: Record<string, unknown>,
		principal?: Principal,
	): Promise<Set<string>> {
		const sqo = sanitizeClientSqo(structuredClone(sqoInput));
		const { sql: builtSql, params } = await buildSearchSql(sqo, { principal });
		const rows = (await sql.unsafe(builtSql, params as (string | number | null)[])) as {
			section_tipo: string;
			section_id: number;
		}[];
		return new Set(rows.map((row) => `${row.section_tipo}/${row.section_id}`));
	}

	const keyed = (sectionTipo: string, ids: Set<number>) =>
		new Set([...ids].map((id) => `${sectionTipo}/${id}`));

	const countBy = (keys: Set<string>, tipo: string) =>
		[...keys].filter((key) => key.startsWith(`${tipo}/`)).length;

	test('mixed sections: each scoped by its OWN filter (incl. the virtual one)', async () => {
		const truthGated = await gatedTruth(GATED_SECTION, GATED_FILTER);
		const truthVirtual = await gatedTruth(VIRTUAL_SECTION, 'testplace1014');
		expect(truthGated.size).toBeGreaterThan(0); // fixture guard

		const keys = await runSearchKeys(
			{ section_tipo: [GATED_SECTION, VIRTUAL_SECTION], limit: 1000, offset: 0 },
			nonAdmin(NON_ADMIN_USER_ID),
		);
		// No over-return, no under-return, on BOTH sections at once.
		expect(keys).toEqual(
			new Set([...keyed(GATED_SECTION, truthGated), ...keyed(VIRTUAL_SECTION, truthVirtual)]),
		);
	});

	test('other section FIRST still filters the gated one (the PHP fail-open case)', async () => {
		// PHP keys the projects filter off the FIRST section's filter tipo: with a
		// differently-gated section first, the gated one would be scoped by the
		// WRONG tipo (or leak). TS must return the identical set regardless of
		// section_tipo order.
		const truthGated = await gatedTruth(GATED_SECTION, GATED_FILTER);
		const keys = await runSearchKeys(
			{ section_tipo: [VIRTUAL_SECTION, GATED_SECTION], limit: 1000, offset: 0 },
			nonAdmin(NON_ADMIN_USER_ID),
		);
		for (const key of keys) {
			if (key.startsWith(`${GATED_SECTION}/`))
				expect(truthGated.has(Number(key.split('/')[1]))).toBe(true);
		}
		expect(countBy(keys, GATED_SECTION)).toBe(truthGated.size);
	});

	test('two gated sections with DIFFERENT filter tipos are each scoped by their own', async () => {
		const truthGated = await gatedTruth(GATED_SECTION, GATED_FILTER);
		const truthOther = await gatedTruth(OTHER_GATED_SECTION, OTHER_GATED_FILTER);
		const keys = await runSearchKeys(
			{ section_tipo: [GATED_SECTION, OTHER_GATED_SECTION], limit: 1000, offset: 0 },
			nonAdmin(NON_ADMIN_USER_ID),
		);
		expect(keys).toEqual(
			new Set([...keyed(GATED_SECTION, truthGated), ...keyed(OTHER_GATED_SECTION, truthOther)]),
		);
		// The two predicates are not interchangeable: the sets differ.
		expect(truthGated.size).not.toBe(0);
		expect(truthOther.size).not.toBe(0);
	});

	test('admin multi-section bypasses the filter (the whole record set)', async () => {
		const keys = await runSearchKeys(
			{ section_tipo: [GATED_SECTION, VIRTUAL_SECTION], limit: 1000, offset: 0 },
			admin,
		);
		expect(keys).toEqual(
			new Set([
				...keyed(GATED_SECTION, await allIds(GATED_SECTION)),
				...keyed(VIRTUAL_SECTION, await allIds(VIRTUAL_SECTION)),
			]),
		);
	});

	test('projects-less non-admin: both gated sections empty (virtual gates too)', async () => {
		const keys = await runSearchKeys(
			{ section_tipo: [GATED_SECTION, VIRTUAL_SECTION], limit: 1000, offset: 0 },
			nonAdmin(PROJECTLESS_USER_ID),
		);
		expect(countBy(keys, GATED_SECTION)).toBe(0);
		expect(countBy(keys, VIRTUAL_SECTION)).toBe(0);
	});

	test('multi-section count: no throw, total = per-section scoped sum', async () => {
		// The count engine shares buildSearchSql (and shared the removed throw).
		const truthGated = await gatedTruth(GATED_SECTION, GATED_FILTER);
		const truthVirtual = await gatedTruth(VIRTUAL_SECTION, 'testplace1014');
		const sqo = sanitizeClientSqo(
			structuredClone({ section_tipo: [GATED_SECTION, VIRTUAL_SECTION], limit: 10, offset: 0 }),
		);
		const total = await matrixReadSource.count(sqo, nonAdmin(NON_ADMIN_USER_ID));
		expect(total).toBe(truthGated.size + truthVirtual.size);
	});
});
