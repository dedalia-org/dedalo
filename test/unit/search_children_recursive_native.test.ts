/**
 * `sqo.children_recursive` — the descendant-expanding search
 * (src/core/search/sql_assembler.ts buildChildrenRecursiveSql) and the
 * SHARED-visited batch walk it stands on
 * (src/core/relations/children.ts getChildrenRecursiveBatch).
 *
 * WHY IT EXISTS. A picker that hands the user a THESAURUS BRANCH means the
 * branch's whole subtree, not the branch node. The flag was accepted by the SQO
 * schema (`src/core/concepts/sqo.ts`) and merged into the stored session SQO,
 * but NOTHING read it: a search asking for a branch answered with the branch
 * alone. In the browser that is `tool_numisdata_epigraphy`'s glyph grid opening
 * with one empty cell — the symptom this gate was written from.
 *
 * WHAT IS PINNED (outcomes, never spellings):
 *   1. the flag EXPANDS — root + every descendant at every depth;
 *   2. without the flag the SAME sqo answers with the root alone (so the
 *      assertion above cannot be satisfied by an unrelated widening);
 *   3. `fixed_children_filter` is ANDed over the expanded set, not dropped;
 *   4. a childless root keeps the CALLER's limit/offset (the documented
 *      divergence from PHP, which returned its unbounded parents result —
 *      WC-2026-09-01-children-recursive-search);
 *   5. `full_count` counts the EXPANDED set (the second documented divergence);
 *   6. the batch walk shares ONE visited set across roots, so no subtree is
 *      EXPANDED twice — asserted as an outcome (a grandchild under a two-parent
 *      node comes back once), which is exactly what the per-path by-value walk
 *      gets wrong, exponentially so on a polyhierarchy.
 *
 * FIXTURE. The generic `test` TLD's own hierarchy fixture (AGENTS.md: a test
 * BUILDS its situation): section `test3`, parent component `test71` carrying a
 * `dd47` link — the shape the inverse children probe matches on. Copying the
 * canonical playground's `dd151` links instead makes every probe return zero.
 *
 * The shape built here (D is a DIAMOND — two parents, which a Dédalo
 * polyhierarchy allows and which is the case a per-path visited set explodes on):
 *
 *     R
 *     ├── A ── A1
 *     ├── B ── B1
 *     └── (A and B both parent) D ── D1
 *
 * SCRATCH SURFACE (this file's namespace ONLY — other agents write the same
 * database concurrently, so no table-global count is taken here):
 *   matrix_test / matrix_time_machine rows, section_tipo 'test3',
 *   section_id 926000-926099.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sanitizeClientSqo } from '../../src/core/concepts/sqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getChildrenRecursiveBatch } from '../../src/core/relations/children.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

const SECTION = 'test3';
const PARENT_TIPO = 'test71';
const DESCRIPTOR_TIPO = 'test88';
const ID_MIN = 926000;
const ID_MAX = 926099;

const R = 926000;
const A = 926001;
const B = 926002;
const A1 = 926003;
const B1 = 926004;
const D = 926005; // child of BOTH A and B
const D1 = 926006;
const CHILDLESS = 926010;

const SUBTREE = [A, B, A1, B1, D, D1];

/** A parent link in the exact stored shape the inverse probe matches on. */
function parentLink(parentId: number, idKey: number): Record<string, unknown> {
	return {
		id: idKey,
		type: 'dd47',
		section_id: String(parentId),
		section_tipo: SECTION,
		from_component_tipo: PARENT_TIPO,
	};
}

/** The dd64 is_descriptor locator (1 = descriptor / yes, 2 = non-descriptor / no). */
function descriptorLink(sectionId: 1 | 2): Record<string, unknown> {
	return {
		id: 1,
		type: 'dd151',
		section_id: String(sectionId),
		section_tipo: 'dd64',
		from_component_tipo: DESCRIPTOR_TIPO,
	};
}

async function seedRow(sectionId: number, relation?: Record<string, unknown[]>): Promise<void> {
	await sql.unsafe(
		`INSERT INTO matrix_test (section_id, section_tipo, relation)
		 VALUES ($1, $2, $3::text::jsonb)`,
		[sectionId, SECTION, relation === undefined ? null : JSON.stringify(relation)] as (
			| string
			| number
			| null
		)[],
	);
}

/** A child of one or more parents, optionally flagged non-descriptor. */
async function seedChild(
	sectionId: number,
	parents: number[],
	descriptor: 1 | 2 = 1,
): Promise<void> {
	await seedRow(sectionId, {
		[PARENT_TIPO]: parents.map((parentId, index) => parentLink(parentId, index + 1)),
		[DESCRIPTOR_TIPO]: [descriptorLink(descriptor)],
	});
}

async function scratchRowCount(): Promise<number> {
	let total = 0;
	for (const table of ['matrix_test', 'matrix_time_machine']) {
		const rows = (await sql.unsafe(
			`SELECT count(*)::int AS count FROM "${table}"
			  WHERE section_tipo = $1 AND section_id BETWEEN $2 AND $3`,
			[SECTION, ID_MIN, ID_MAX],
		)) as { count: number }[];
		total += rows[0]?.count ?? 0;
	}
	return total;
}

async function cleanScratch(): Promise<void> {
	for (const table of ['matrix_test', 'matrix_time_machine']) {
		await sql.unsafe(
			`DELETE FROM "${table}" WHERE section_tipo = $1 AND section_id BETWEEN $2 AND $3`,
			[SECTION, ID_MIN, ID_MAX],
		);
	}
}

/** Execute exactly the SQL the assembler emits for this sqo. */
async function runSearch(sqo: Record<string, unknown>): Promise<{ section_id: number }[]> {
	const { sql: builtSql, params } = await buildSearchSql(sqo as never, { idsOnly: true });
	return (await sql.unsafe(builtSql, params as (string | number | null)[])) as {
		section_id: number;
	}[];
}

/** The scratch ids the search returned, sorted — the subject of every assertion. */
async function searchIds(sqo: Record<string, unknown>): Promise<number[]> {
	const rows = await runSearch(sqo);
	return rows
		.map((row) => row.section_id)
		.filter((id) => id >= ID_MIN && id <= ID_MAX)
		.sort((a, b) => a - b);
}

/** The sqo the client sends: pinned to one root, everything else default. */
function rootSqo(rootId: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		section_tipo: [SECTION],
		filter_by_locators: [{ section_tipo: SECTION, section_id: rootId }],
		limit: 200,
		offset: 0,
		...extra,
	};
}

beforeAll(async () => {
	await cleanScratch();
	// A stray row from a crashed run would silently change every result below.
	expect(await scratchRowCount()).toBe(0);

	await seedRow(R);
	await seedChild(A, [R]);
	await seedChild(B, [R]);
	await seedChild(A1, [A]);
	await seedChild(B1, [B], 2); // the only NON-descriptor in the subtree
	await seedChild(D, [A, B]); // the diamond
	await seedChild(D1, [D]);
	await seedRow(CHILDLESS);
});

afterAll(cleanScratch);

test('without the flag the search answers with the root alone', async () => {
	expect(await searchIds(rootSqo(R))).toEqual([R]);
});

test('children_recursive expands the root to its whole subtree, at every depth', async () => {
	expect(await searchIds(rootSqo(R, { children_recursive: true }))).toEqual(
		[R, ...SUBTREE].sort((a, b) => a - b),
	);
});

test('the expansion survives being asked for from a MID-tree root', async () => {
	// A's subtree is A1 and the diamond (D, D1) — never B or B1.
	expect(await searchIds(rootSqo(A, { children_recursive: true }))).toEqual([A, A1, D, D1]);
});

test('fixed_children_filter narrows the EXPANDED set, it is not dropped', async () => {
	const descriptorOnly = {
		q: {
			type: 'dd151',
			section_id: '1',
			section_tipo: 'dd64',
			from_component_tipo: DESCRIPTOR_TIPO,
		},
		path: [
			{
				name: 'Is descriptor',
				model: 'component_radio_button',
				section_tipo: SECTION,
				component_tipo: DESCRIPTOR_TIPO,
			},
		],
		q_operator: null,
	};
	const ids = await searchIds(
		rootSqo(R, { children_recursive: true, fixed_children_filter: descriptorOnly }),
	);

	// B1 is the non-descriptor; R carries no descriptor link at all.
	expect(ids).toEqual([A, B, A1, D, D1]);
	expect(ids).not.toContain(B1);
});

test('a childless root keeps the CALLER pagination (documented PHP divergence)', async () => {
	expect(await searchIds(rootSqo(CHILDLESS, { children_recursive: true }))).toEqual([CHILDLESS]);

	// offset past the single row: the caller's paging still applies, so the page
	// is empty — PHP answered with its own unbounded parents result here.
	expect(
		await searchIds(rootSqo(CHILDLESS, { children_recursive: true, limit: 10, offset: 5 })),
	).toEqual([]);
});

test('full_count counts the EXPANDED set (documented PHP divergence)', async () => {
	const { sql: builtSql, params } = await buildSearchSql(
		rootSqo(R, { children_recursive: true, full_count: true }) as never,
		{},
	);
	const rows = (await sql.unsafe(builtSql, params as (string | number | null)[])) as {
		full_count: number | string;
	}[];
	const total = rows.reduce((sum, row) => sum + Number(row.full_count), 0);

	expect(total).toBe(1 + SUBTREE.length);
});

test('the batch walk shares ONE visited set: a subtree is EXPANDED once', async () => {
	// R already contains A, so a per-root by-value visited set would walk A's
	// subtree a second time under the second root.
	const descendants = await getChildrenRecursiveBatch([
		{ section_id: R, section_tipo: SECTION },
		{ section_id: A, section_tipo: SECTION },
	]);
	const scratch = descendants
		.map((child) => Number(child.section_id))
		.filter((id) => id >= ID_MIN && id <= ID_MAX);

	// Everything, and nothing beyond it.
	expect([...new Set(scratch)].sort((a, b) => a - b)).toEqual(SUBTREE);
	// A1 hangs under A alone: one listing, so one expansion of A's branch.
	expect(scratch.filter((id) => id === A1).length).toBe(1);
});

test('a diamond node is EMITTED once, however many parents list it', async () => {
	// D hangs under BOTH A and B, so both parents' direct-children lists name it.
	// The walk EMITS AND EXPANDS in the same step against the shared visited set,
	// so D appears ONCE and its subtree is walked once — the "already
	// deduplicated by locator" contract this function always documented and did
	// not keep (it pushed the whole direct list before the recursion pruned, so a
	// poly-hierarchy node came back once per parent; the search dedups downstream,
	// which is what masked it). WC-2026-09-05-children-order-one-rule.
	const descendants = await getChildrenRecursiveBatch([{ section_id: R, section_tipo: SECTION }]);
	const count = (id: number): number =>
		descendants.filter((child) => Number(child.section_id) === id).length;

	expect(count(D)).toBe(1); // listed by A and by B, emitted once
	expect(count(D1)).toBe(1); // and expanded exactly once
});

test('the flag survives the CLIENT sanitizer — the door it actually arrives through', async () => {
	// The historical bug was not a wrong expansion, it was an INERT flag: the
	// schema accepted it, the session merged it, nothing read it. Asserting the
	// assembler alone leaves the delivery path unpinned — drop
	// 'children_recursive' from the sanitizer's allowlist (a plausible
	// tightening slip) and every client search loses the expansion while the
	// assembler tests stay green.
	const client = sanitizeClientSqo(
		structuredClone(rootSqo(R, { children_recursive: true })) as Record<string, unknown>,
	);

	expect(client.children_recursive).toBe(true);
	expect(await searchIds(client)).toEqual([R, ...SUBTREE].sort((a, b) => a - b));
});
