/**
 * THE `referenced_by` FILTER LEAF — native gate
 * (WC-2026-10-30-search-referenced-by-leaf; core: concepts/sqo.ts
 * referencedBySourceSchema, search/builders/builder_referenced_by.ts,
 * search/sql_assembler.ts buildScopedRowSetSql).
 *
 *   { "referenced_by": { "section_tipo": [S], "filter": …, "filter_by_locators": …,
 *                        "from_component_tipo": … } }
 *
 * inside T's filter = the T rows that are the TARGET of a locator STORED (the
 * source row's own `relation` column — never the derived matrix_relation_index)
 * by a record of the source found set. The leaf replaced "Open relationships"'
 * old read_raw harvest, which ran on the source's FIRST PAGE only (clamped to
 * CLIENT_MAX_LIMIT) and so silently lost every target past it. This gate BUILDS
 * the situation that bug needs and asserts the outcome, never a spelling:
 *
 *   (1) a source set LARGER than one page (PAGE = CLIENT_MAX_LIMIT read from
 *       config, never hardcoded, capped at MAX_PAGE so a large configured
 *       ceiling cannot inflate the fixture) → every distinct target, and full_count == the page walk ==
 *       the independently-derived expected set (built by construction);
 *   (2) PARITY with read_raw `target_section` (the harvest the leaf replaced,
 *       walked page by page so nothing is clamped): leaf ids == the harvest's
 *       distinct ids ∩ the T rows the same principal may list — internal,
 *       superuser and a project-scoped persona with a hidden component. The ∩
 *       is the one honest difference: read_raw returns raw locators (a dangling
 *       one, a target outside the reader's projects), the leaf returns T ROWS;
 *       each side of that difference is asserted to be non-empty;
 *   (3) from_component_tipo narrows to that component's locators;
 *   (4) a REAL four-level chain (CHAIN → SOURCE → TARGET_A → TARGET_B →
 *       TERMINAL) answers exactly its rows at depth MAX_REFERENCED_BY_DEPTH
 *       (and every intermediate depth); one deeper throws request.invalid_options;
 *   (5) a malformed leaf THROWS (client door AND server door) — it never falls
 *       through to the pathless-leaf drop, which would widen T to the section;
 *   (6) a project-scoped persona: out-of-scope sources contribute nothing, a
 *       hidden component's locators are excluded and perm.out_of_scope is noted;
 *   (7) no read on a source section → perm.denied;
 *   (8) a LOG-TABLE source (dd542 in matrix_activity, which the relation index
 *       never covered) is legal and answers read_raw's harvest;
 *   (9) INDEX INDEPENDENCE: inside a rolled-back transaction, the situation's
 *       matrix_relation_index rows are deleted and a bogus one inserted — the
 *       leaf, the depth-4 chain and the census answer exactly as before.
 *
 * Structure: a zz situation (zzrefby*), torn down after with zero residue — the
 * matrix_relation_index rows its records produced included. Persona: the
 * crawl persona fixture (test3 grants, projects A/B, hidden test91) plus six
 * test3 records this file MINTS through the allocator (no reserved id range
 * exists), swept by exactly those (tipo, id) pairs with zero residue asserted.
 * The log-table source is one dd542 row minted through the activity table's
 * own sequence door and swept by its exact id.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { buildGatedSqo, runGatedCount, runLocatorPage } from '../../src/ai/mcp/tools/search.ts';
import { config } from '../../src/config/config.ts';
import { utilsApiActions } from '../../src/core/api/handlers/dd_utils_api.ts';
import { readRaw } from '../../src/core/api/handlers/read_raw.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import {
	CLIENT_MAX_LIMIT,
	MAX_REFERENCED_BY_DEPTH,
	type Sqo,
	sanitizeClientSqo,
} from '../../src/core/concepts/sqo.ts';
import {
	deleteMatrixRecord,
	insertMatrixRecordWithCounter,
	insertMatrixRowSequenceId,
} from '../../src/core/db/matrix_write.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { countRelationTargets } from '../../src/core/search/relation_targets.ts';
import {
	createSearchStatement,
	REFERENCED_BY_SEARCH_BUDGET_MS,
	runSearch,
	searchStatementText,
	withSearchBudgetOverride,
} from '../../src/core/search/search_statement.ts';
import { buildSearchSql } from '../../src/core/search/sql_assembler.ts';
import { matrixReadSource } from '../../src/core/section/read_source.ts';
import {
	currentFrontierRefusals,
	frontierRefusalNotice,
} from '../../src/core/security/frontier_scope.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import {
	dropSituation,
	ensureSituation,
	type SituationRecord,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { openSelectionCursor } from '../../src/diffusion/export/selection_cursor.ts';
import { selectRecordBatches } from '../../src/diffusion/resolve/selection.ts';
import {
	CRAWL_ADMIN_USER_ID,
	CRAWL_CREATE_FILTER,
	CRAWL_CREATE_SECTION,
	CRAWL_DENIED_SECTION,
	CRAWL_EDITOR_USER_ID,
	CRAWL_FILTER_COMPONENT,
	CRAWL_HIDDEN_COMPONENT,
	CRAWL_PROJECT_A,
	CRAWL_PROJECT_B,
	installCrawlPersonaFixture,
	removeCrawlPersonaFixture,
} from '../helpers/crawl_persona_fixture.ts';
import { DB_READY } from '../helpers/db_ready.ts';

const SLOW = 120_000;

// --- the zz situation (internal searches: no principal) ----------------------

/** Source section: N records, each owning locators through two portals. */
const SOURCE = 'zzrefby1';
/** Source portal → TARGET_A (every source: its own target + the shared #1). */
const PORTAL_A = 'zzrefby2';
/** Source portal → TARGET_B (every 10th source only). */
const PORTAL_B = 'zzrefby4';
const TARGET_A = 'zzrefby3';
const TARGET_B = 'zzrefby5';
/** The chain's head: a few records pointing at SOME source records. */
const CHAIN = 'zzrefby6';
const CHAIN_PORTAL = 'zzrefby7';

/**
 * The page size every walk uses: the client clamp (CLIENT_MAX_LIMIT, from
 * config), capped at MAX_PAGE — a large configured ceiling must not inflate the
 * fixture (N records are minted per run). At the default ceiling (1000) PAGE ==
 * CLIENT_MAX_LIMIT, so the source set also exceeds the clamp the old
 * first-page harvest applied (asserted in the gate whenever that holds).
 */
const MAX_PAGE = 1000;
const PAGE = Math.min(CLIENT_MAX_LIMIT, MAX_PAGE);
/** Strictly more source records (and distinct targets) than one page. */
const N = PAGE + 37;
/** TARGET_B records: source i (i % 10 === 0) → TARGET_B/(i/10). */
const B_COUNT = Math.floor(N / 10);
/** A dangling locator target (no record): the index holds it, T must not. */
const DANGLING_ID = N + 100_000;
/** A TARGET_A record nobody references: proves T is never widened. */
const UNREFERENCED_A = N + 1;
/** The source records the chain points at. */
const CHAIN_SOURCES = [3, 7, 20, 40];
/** TARGET_A portal → TARGET_B (the chain's third hop). */
const A_PORTAL = 'zzrefby8';
/** TARGET_B portal → TERMINAL (the chain's fourth hop). */
const B_PORTAL = 'zzrefby9';
/** The chain's terminal section (the depth-4 leaf's T). */
const TERMINAL = 'zzrefby10';
/**
 * The off-chain ids, DERIVED from the situation's size (never hardcoded): the
 * last source's own TARGET_A record (referenced by SOURCE/N, outside the
 * chain's TARGET_A {1, ...CHAIN_SOURCES}), and the last TARGET_B record
 * (outside the chain's TARGET_B {2, 4, 7} and OFF_CHAIN_B_VIA_A).
 */
const OFF_CHAIN_A = N;
const OFF_CHAIN_B_VIA_A = 5;
const OFF_CHAIN_B_LONE = B_COUNT;
/**
 * The smallest N for which the derived ids above are distinct from the chain:
 * N > max(CHAIN_SOURCES) keeps OFF_CHAIN_A off the chain, B_COUNT > 7 keeps
 * OFF_CHAIN_B_LONE apart from {2, 4, 5, 7}. Asserted in the gate (PAGE >= 1
 * gives N >= 38, so a tiny configured ceiling would fail loudly, not vacuously).
 */
const MIN_N = 80;
/**
 * TARGET_A/j → TARGET_B ids. The chain reaches TARGET_A {1,3,7,20,40};
 * OFF_CHAIN_A is outside it (its target must NOT appear), so the hop narrows
 * for real.
 */
const A_TO_B: Record<number, number[]> = {
	1: [7],
	3: [2],
	40: [4, 2],
	[OFF_CHAIN_A]: [OFF_CHAIN_B_VIA_A],
};
/** TARGET_B/k → TERMINAL ids (TERMINAL_DANGLING has no record). The OFF_CHAIN_B_* ones are off-chain. */
const TERMINAL_DANGLING = 99;
const B_TO_TERMINAL: Record<number, number[]> = {
	2: [11, 12],
	4: [12, TERMINAL_DANGLING],
	7: [15],
	[OFF_CHAIN_B_VIA_A]: [13],
	[OFF_CHAIN_B_LONE]: [14],
};
const TERMINAL_COUNT = 20;

function loc(from: string, sectionTipo: string, sectionId: number, id = 1) {
	return {
		id,
		type: 'dd151',
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: from,
	};
}

function range(from: number, to: number): number[] {
	return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** Expected TARGET_A ids for a set of source ids (own target + shared #1; dangling never exists). */
function expectedA(sources: readonly number[]): number[] {
	return [...new Set([1, ...sources])].sort((a, b) => a - b);
}
/** Expected TARGET_B ids: source i (i % 10 === 0) → TARGET_B/(i/10). */
function expectedB(sources: readonly number[]): number[] {
	return [...new Set(sources.filter((i) => i % 10 === 0).map((i) => i / 10))].sort((a, b) => a - b);
}

const ALL_SOURCES = range(1, N);

function buildRecords(): SituationRecord[] {
	const records: SituationRecord[] = [];
	for (const i of ALL_SOURCES) {
		const relation: Record<string, unknown[]> = {
			[PORTAL_A]: [loc(PORTAL_A, TARGET_A, i, 1), loc(PORTAL_A, TARGET_A, 1, 2)],
		};
		if (i === 1) relation[PORTAL_A]?.push(loc(PORTAL_A, TARGET_A, DANGLING_ID, 3));
		if (i % 10 === 0) relation[PORTAL_B] = [loc(PORTAL_B, TARGET_B, i / 10)];
		records.push({ section_tipo: SOURCE, section_id: i, columns: { relation } });
	}
	for (const i of range(1, UNREFERENCED_A)) {
		const toB = A_TO_B[i];
		records.push(
			toB === undefined
				? { section_tipo: TARGET_A, section_id: i }
				: {
						section_tipo: TARGET_A,
						section_id: i,
						columns: {
							relation: { [A_PORTAL]: toB.map((b, k) => loc(A_PORTAL, TARGET_B, b, k + 1)) },
						},
					},
		);
	}
	for (const i of range(1, B_COUNT + 1)) {
		const toTerminal = B_TO_TERMINAL[i];
		records.push(
			toTerminal === undefined
				? { section_tipo: TARGET_B, section_id: i }
				: {
						section_tipo: TARGET_B,
						section_id: i,
						columns: {
							relation: {
								[B_PORTAL]: toTerminal.map((t, k) => loc(B_PORTAL, TERMINAL, t, k + 1)),
							},
						},
					},
		);
	}
	for (const i of range(1, TERMINAL_COUNT)) records.push({ section_tipo: TERMINAL, section_id: i });
	records.push({
		section_tipo: CHAIN,
		section_id: 1,
		columns: {
			relation: {
				[CHAIN_PORTAL]: CHAIN_SOURCES.map((s, k) => loc(CHAIN_PORTAL, SOURCE, s, k + 1)),
			},
		},
	});
	return records;
}

const SITUATION = situation({
	tld: 'zzrefby',
	name: 'referenced_by_filter_native',
	nodes: [
		{ tipo: SOURCE, model: 'section' },
		{ tipo: PORTAL_A, model: 'component_portal', parent: SOURCE },
		{ tipo: PORTAL_B, model: 'component_portal', parent: SOURCE, order_number: 2 },
		{ tipo: TARGET_A, model: 'section' },
		{ tipo: TARGET_B, model: 'section' },
		{ tipo: CHAIN, model: 'section' },
		{ tipo: CHAIN_PORTAL, model: 'component_portal', parent: CHAIN },
		{ tipo: A_PORTAL, model: 'component_portal', parent: TARGET_A },
		{ tipo: B_PORTAL, model: 'component_portal', parent: TARGET_B },
		{ tipo: TERMINAL, model: 'section' },
	],
	records: buildRecords(),
});

// --- helpers -----------------------------------------------------------------

type Leaf = { referenced_by: Record<string, unknown> };

function targetSqo(target: string, leaf: Leaf, extra: Record<string, unknown> = {}): Sqo {
	return { section_tipo: [target], filter: { $and: [leaf] }, ...extra } as unknown as Sqo;
}

async function fullCount(sqo: Sqo, principal?: Principal): Promise<number> {
	const rows = await runSearch<{ full_count: unknown }>(
		await buildSearchSql(
			{ ...sqo, full_count: true } as Sqo,
			principal === undefined ? {} : { principal },
		),
	);
	return Number(rows[0]?.full_count);
}

async function idsOf(sqo: Sqo, principal?: Principal): Promise<number[]> {
	const rows = await runSearch<{ section_id: unknown }>(
		await buildSearchSql(sqo, {
			idsOnly: true,
			...(principal === undefined ? {} : { principal }),
		}),
	);
	return rows.map((r) => Number(r.section_id));
}

/** Walk every page (page size PAGE) — the opened window's pagination. */
async function walkPages(
	sqo: Sqo,
	principal?: Principal,
): Promise<{ ids: number[]; pages: number }> {
	const ids: number[] = [];
	let pages = 0;
	for (let offset = 0; ; offset += PAGE) {
		const page = await idsOf({ ...sqo, limit: PAGE, offset } as Sqo, principal);
		if (page.length === 0) break;
		pages += 1;
		ids.push(...page);
		if (page.length < PAGE) break;
		if (pages > 50) throw new Error('walkPages: runaway pagination');
	}
	return { ids, pages };
}

const sorted = (ids: readonly number[]) => [...ids].sort((a, b) => a - b);

async function codeOf(fn: () => unknown): Promise<string> {
	try {
		await fn();
	} catch (error) {
		return String((error as { code?: unknown }).code ?? `untyped: ${(error as Error).message}`);
	}
	return 'NO THROW';
}

/** The typed error a call throws (null = no throw; an untyped throw is rethrown). */
async function errorOf(
	fn: () => unknown,
): Promise<{ code: string; coordinates?: Record<string, unknown> } | null> {
	try {
		await fn();
	} catch (error) {
		if (typeof (error as { code?: unknown }).code !== 'string') throw error;
		return error as { code: string; coordinates?: Record<string, unknown> };
	}
	return null;
}

/** The leaf nested `depth` deep (depth 1 = a plain leaf) over the zz chain head. */
function nestedLeaf(depth: number): Leaf {
	let leaf: Leaf = { referenced_by: { section_tipo: [CHAIN] } };
	for (let d = 2; d <= depth; d++) {
		leaf = { referenced_by: { section_tipo: [SOURCE], filter: { $and: [leaf] } } };
	}
	return leaf;
}

/**
 * The leaf over a REAL chain: `sources[0]` is the innermost source (unfiltered),
 * each next one is filtered by the previous leaf. Depth = sources.length.
 */
function chainLeaf(sources: readonly string[]): Leaf {
	let leaf: Leaf | null = null;
	for (const sectionTipo of sources) {
		leaf = {
			referenced_by: {
				section_tipo: [sectionTipo],
				...(leaf === null ? {} : { filter: { $and: [leaf] } }),
			},
		};
	}
	if (leaf === null) throw new Error('chainLeaf: no source');
	return leaf;
}

/** The four-level chain whose T is TERMINAL, and its expected rows by construction. */
const CHAIN_LEVELS = [CHAIN, SOURCE, TARGET_A, TARGET_B] as const;
const CHAIN_EXPECTED: Record<string, number[]> = {
	[SOURCE]: CHAIN_SOURCES,
	[TARGET_A]: expectedA(CHAIN_SOURCES),
	[TARGET_B]: [2, 4, 7],
	[TERMINAL]: [11, 12, 15],
};

/**
 * read_raw's `target_section` harvest of a source SQO, WALKED page by page
 * (page = PAGE <= CLIENT_MAX_LIMIT, the clamp it applies) so nothing is lost to the
 * clamp: the distinct target ids, plus the source ids the walk covered (each
 * exactly once, or the walk is refused — the paging must be deterministic).
 */
async function harvestIds(
	sourceSection: string,
	targetTipo: string,
	sourceSqo: Record<string, unknown>,
	principal?: Principal,
): Promise<{ targetIds: number[]; sourceIds: number[] }> {
	const targets = new Set<number>();
	const sourceIds: number[] = [];
	for (let offset = 0; ; offset += PAGE) {
		const page = { ...sourceSqo, limit: PAGE, offset } as unknown as Sqo;
		const rows = await idsOf(page, principal);
		const raw = await readRaw(
			{ sectionTipo: sourceSection, tipo: targetTipo, type: 'target_section', sqo: page },
			principal,
		);
		for (const locator of raw.result as { section_id: unknown; section_tipo: unknown }[]) {
			expect(locator.section_tipo).toBe(targetTipo);
			targets.add(Number(locator.section_id));
		}
		sourceIds.push(...rows);
		if (rows.length < PAGE) break;
		if (offset > 50 * PAGE) throw new Error('harvestIds: runaway pagination');
	}
	expect(new Set(sourceIds).size).toBe(sourceIds.length);
	return { targetIds: sorted([...targets]), sourceIds: sorted(sourceIds) };
}

/**
 * Which of `candidates` are T rows the principal may list (the outer query's
 * own scope: existence, section pin, records ACL) — asked through a plain
 * search pinned to those ids, never a section-global walk (test3 is shared).
 */
async function visibleAmong(
	target: string,
	candidates: readonly number[],
	principal?: Principal,
): Promise<Set<number>> {
	const visible = new Set<number>();
	for (let start = 0; start < candidates.length; start += 500) {
		const chunk = candidates.slice(start, start + 500);
		const page = await idsOf(
			{
				section_tipo: [target],
				filter_by_locators: chunk.map((id) => ({ section_tipo: target, section_id: id })),
				limit: chunk.length,
				offset: 0,
			} as unknown as Sqo,
			principal,
		);
		for (const id of page) visible.add(id);
	}
	return visible;
}

/**
 * The parity law against read_raw: leaf ids == harvest ∩ visible T rows.
 * Returns the harvest's ids NOT answered (raw locators that name no visible T
 * row) so a caller can assert the difference is real where it built one.
 */
async function assertReadRawParity(
	sourceSection: string,
	target: string,
	sourceSqo: Record<string, unknown>,
	principal?: Principal,
): Promise<{ answered: number[]; unanswered: number[] }> {
	const harvest = await harvestIds(sourceSection, target, sourceSqo, principal);
	const visible = await visibleAmong(target, harvest.targetIds, principal);
	const expected = harvest.targetIds.filter((id) => visible.has(id));
	const leaf: Leaf = {
		referenced_by: Object.fromEntries(
			Object.entries(sourceSqo).filter(([key]) =>
				['section_tipo', 'filter', 'filter_by_locators'].includes(key),
			),
		),
	};
	const ids = sorted(await walkPages(targetSqo(target, leaf), principal).then((w) => w.ids));
	expect({ target, ids }).toEqual({ target, ids: expected });
	expect(await fullCount(targetSqo(target, leaf), principal)).toBe(expected.length);
	return {
		answered: ids,
		unanswered: harvest.targetIds.filter((id) => !visible.has(id)),
	};
}

// --- the gate ----------------------------------------------------------------

describe.if(DB_READY)('referenced_by leaf — internal searches over a built situation', () => {
	beforeAll(async () => {
		await assertTestDatabase('referenced_by_filter_native');
		expect(CLIENT_MAX_LIMIT).toBeGreaterThan(0);
		// The derived off-chain ids are apart from the chain only from MIN_N on
		// (see MIN_N); a tiny configured ceiling fails here, never vacuously.
		expect(N).toBeGreaterThanOrEqual(MIN_N);
		expect(N).toBeLessThanOrEqual(MAX_PAGE + 37);
		expect(new Set([2, 4, 7, OFF_CHAIN_B_VIA_A, OFF_CHAIN_B_LONE]).size).toBe(5);
		expect([1, ...CHAIN_SOURCES]).not.toContain(OFF_CHAIN_A);
		await dropSituation(SITUATION); // a crashed previous run
		await ensureSituation(SITUATION);
	}, SLOW);

	afterAll(async () => {
		expect(await dropSituation(SITUATION)).toBe(0);
		const index = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM matrix_relation_index
			 WHERE section_tipo LIKE 'zzrefby%' OR target_section_tipo LIKE 'zzrefby%'`,
		)) as { n: number }[];
		expect(index[0]?.n).toBe(0);
	}, SLOW);

	// Not a claim about the leaf (which reads the stored relation column): the
	// precondition of the INDEX INDEPENDENCE test below — the trigger did build
	// the index, so deleting it there is real damage, not a no-op.
	test('the situation is real: the trigger-built index holds every source locator (independence precondition)', async () => {
		const rows = (await sql.unsafe(
			`SELECT count(DISTINCT section_id)::int AS owners, count(DISTINCT target_section_id)::int AS targets
			 FROM matrix_relation_index WHERE section_tipo = $1 AND target_section_tipo = $2`,
			[SOURCE, TARGET_A],
		)) as { owners: number; targets: number }[];
		expect(rows[0]?.owners).toBe(N);
		// N own targets (1 included) + the dangling one.
		expect(rows[0]?.targets).toBe(N + 1);
		expect(N).toBeGreaterThan(PAGE);
		// At a ceiling <= MAX_PAGE (the default 1000) the source set also exceeds
		// the clamp the old first-page harvest applied; above it PAGE is capped
		// so the fixture stays bounded and the multi-page claim is made at PAGE.
		if (CLIENT_MAX_LIMIT <= MAX_PAGE) expect(N).toBeGreaterThan(CLIENT_MAX_LIMIT);
	});

	test(
		'source > one client page → every distinct target; full_count == page walk == expected',
		async () => {
			const leaf: Leaf = { referenced_by: { section_tipo: [SOURCE] } };
			const expected = expectedA(ALL_SOURCES);
			expect(expected.length).toBe(N);
			expect(expected.length).toBeGreaterThan(PAGE);

			const count = await fullCount(targetSqo(TARGET_A, leaf));
			const walk = await walkPages(targetSqo(TARGET_A, leaf));
			expect(walk.pages).toBeGreaterThan(1);
			expect(new Set(walk.ids).size).toBe(walk.ids.length); // no duplicate across pages
			expect(sorted(walk.ids)).toEqual(expected);
			expect(count).toBe(expected.length);
			// T is never widened: the unreferenced record and the dangling id are absent.
			expect(walk.ids).not.toContain(UNREFERENCED_A);
			expect(walk.ids).not.toContain(DANGLING_ID);

			// The CLIENT door keeps the leaf (sanitizeClientSqo), and the sanitized
			// SQO answers the same count — the opened window's actual path.
			const clientSqo = sanitizeClientSqo({
				section_tipo: [TARGET_A],
				filter: { $and: [leaf] },
				limit: PAGE,
				offset: 0,
			});
			expect(JSON.stringify(clientSqo.filter)).toContain('referenced_by');
			expect(await fullCount(clientSqo)).toBe(expected.length);
		},
		SLOW,
	);

	test('the source filter scopes the source set (filter_by_locators)', async () => {
		const leaf: Leaf = {
			referenced_by: {
				section_tipo: [SOURCE],
				filter_by_locators: [
					{ section_tipo: SOURCE, section_id: 5 },
					{ section_tipo: SOURCE, section_id: 30 },
				],
			},
		};
		expect(sorted(await idsOf(targetSqo(TARGET_A, leaf)))).toEqual(expectedA([5, 30]));
		expect(sorted(await idsOf(targetSqo(TARGET_B, leaf)))).toEqual([3]);
	});

	test('from_component_tipo narrows to that component’s locators', async () => {
		const viaA: Leaf = { referenced_by: { section_tipo: [SOURCE], from_component_tipo: PORTAL_A } };
		const viaB: Leaf = { referenced_by: { section_tipo: [SOURCE], from_component_tipo: PORTAL_B } };
		const anyComponent: Leaf = { referenced_by: { section_tipo: [SOURCE] } };
		const allB = expectedB(ALL_SOURCES);
		expect(allB.length).toBe(B_COUNT);
		expect(B_COUNT).toBeGreaterThan(0);

		expect(await fullCount(targetSqo(TARGET_A, viaA))).toBe(N);
		expect(await fullCount(targetSqo(TARGET_A, viaB))).toBe(0);
		expect(sorted(await idsOf(targetSqo(TARGET_B, viaB)))).toEqual(allB);
		expect(await fullCount(targetSqo(TARGET_B, viaA))).toBe(0);
		expect(sorted(await idsOf(targetSqo(TARGET_B, anyComponent)))).toEqual(allB);
		// The unreferenced TARGET_B record (B_COUNT + 1) never shows.
		expect(await idsOf(targetSqo(TARGET_B, anyComponent))).not.toContain(B_COUNT + 1);
	});

	test('a nested chain answers the composed relation', async () => {
		// TARGET_A rows referenced by SOURCE rows that are themselves referenced by CHAIN rows.
		const nested = nestedLeaf(2);
		expect(sorted(await idsOf(targetSqo(TARGET_A, nested)))).toEqual(expectedA(CHAIN_SOURCES));
		expect(await fullCount(targetSqo(TARGET_A, nested))).toBe(expectedA(CHAIN_SOURCES).length);
		expect(sorted(await idsOf(targetSqo(TARGET_B, nested)))).toEqual(expectedB(CHAIN_SOURCES));
		// …and the middle hop alone is exactly the chain's sources (sanity of the composition).
		expect(sorted(await idsOf(targetSqo(SOURCE, nestedLeaf(1))))).toEqual(CHAIN_SOURCES);
		// The same nested leaf survives the client door unchanged in meaning.
		const clientSqo = sanitizeClientSqo(
			targetSqo(TARGET_A, nested) as unknown as Record<string, unknown>,
		);
		expect(await fullCount(clientSqo)).toBe(expectedA(CHAIN_SOURCES).length);
	});

	test(`a REAL ${MAX_REFERENCED_BY_DEPTH}-level chain answers exactly its rows at every depth (both doors)`, async () => {
		// The chain is built to be exactly the maximum depth.
		expect(CHAIN_LEVELS.length).toBe(MAX_REFERENCED_BY_DEPTH);
		const targets = [SOURCE, TARGET_A, TARGET_B, TERMINAL];
		for (const [index, target] of targets.entries()) {
			const leaf = chainLeaf(CHAIN_LEVELS.slice(0, index + 1));
			const expected = CHAIN_EXPECTED[target] as number[];
			expect(expected.length).toBeGreaterThan(0);
			expect({ depth: index + 1, ids: sorted(await idsOf(targetSqo(target, leaf))) }).toEqual({
				depth: index + 1,
				ids: expected,
			});
			expect(await fullCount(targetSqo(target, leaf))).toBe(expected.length);
			const clientSqo = sanitizeClientSqo(
				targetSqo(target, leaf) as unknown as Record<string, unknown>,
			);
			expect(sorted(await idsOf(clientSqo))).toEqual(expected);
		}
		// The off-chain hops are real (so the narrowing above is not vacuous):
		// TARGET_A/OFF_CHAIN_A → TARGET_B/OFF_CHAIN_B_VIA_A → TERMINAL/13 exist,
		// yet that TARGET_B and TERMINAL/13 are absent.
		const allTerminal = await idsOf(
			targetSqo(TERMINAL, { referenced_by: { section_tipo: [TARGET_B] } }),
		);
		expect(sorted(allTerminal)).toEqual([11, 12, 13, 14, 15]);
	});

	test(`depth ${MAX_REFERENCED_BY_DEPTH + 1} → request.invalid_options (both doors)`, async () => {
		const ok = targetSqo(TARGET_A, nestedLeaf(MAX_REFERENCED_BY_DEPTH));
		expect(() => sanitizeClientSqo(ok as unknown as Record<string, unknown>)).not.toThrow();

		const tooDeep = targetSqo(TARGET_A, nestedLeaf(MAX_REFERENCED_BY_DEPTH + 1));
		expect(
			await codeOf(() => sanitizeClientSqo(tooDeep as unknown as Record<string, unknown>)),
		).toBe('request.invalid_options');
		expect(await codeOf(() => buildSearchSql(tooDeep))).toBe('request.invalid_options');
	});

	const MALFORMED: [string, unknown][] = [
		['limit in the source', { referenced_by: { section_tipo: [SOURCE], limit: 5 } }],
		['offset in the source', { referenced_by: { section_tipo: [SOURCE], offset: 0 } }],
		['order in the source', { referenced_by: { section_tipo: [SOURCE], order: [] } }],
		['an unknown source key', { referenced_by: { section_tipo: [SOURCE], mode: 'list' } }],
		['empty section_tipo', { referenced_by: { section_tipo: [] } }],
		['missing section_tipo', { referenced_by: { filter: null } }],
		['a string source', { referenced_by: SOURCE }],
		['a null source', { referenced_by: null }],
		['a path beside referenced_by', { referenced_by: { section_tipo: [SOURCE] }, path: [] }],
		['a q beside referenced_by', { referenced_by: { section_tipo: [SOURCE] }, q: '1' }],
		[
			'filter_by_locators_op AND',
			{ referenced_by: { section_tipo: [SOURCE], filter_by_locators_op: 'AND' } },
		],
		[
			'a malformed NESTED leaf',
			{
				referenced_by: {
					section_tipo: [SOURCE],
					filter: { $and: [{ referenced_by: { section_tipo: [CHAIN], limit: 1 } }] },
				},
			},
		],
	];

	for (const [name, leaf] of MALFORMED) {
		test(`malformed leaf (${name}) throws request.invalid_options at both doors — T never widened`, async () => {
			const sqo = { section_tipo: [TARGET_A], filter: { $and: [leaf] } };
			expect(await codeOf(() => sanitizeClientSqo(structuredClone(sqo)))).toBe(
				'request.invalid_options',
			);
			// The server door (a server-built SQO reaches conform unsanitized).
			expect(await codeOf(() => buildSearchSql(structuredClone(sqo) as unknown as Sqo))).toBe(
				'request.invalid_options',
			);
		});
	}

	test('control: the widening the refusal prevents is real (an unfiltered T lists the unreferenced row)', async () => {
		const all = await idsOf({ section_tipo: [TARGET_A], limit: N + 10, offset: 0 } as Sqo);
		expect(all).toContain(UNREFERENCED_A);
		expect(all.length).toBe(UNREFERENCED_A);
	});

	test(
		'PARITY with read_raw target_section over the WHOLE source (> one page, walked) — internal and superuser',
		async () => {
			const superuser = await resolvePrincipal(-1);
			for (const principal of [undefined, superuser]) {
				const whole = { section_tipo: [SOURCE] };
				const a = await assertReadRawParity(SOURCE, TARGET_A, whole, principal);
				// The walk really covered every source row (more than one clamp's worth).
				const walked = await harvestIds(SOURCE, TARGET_A, whole, principal);
				expect(walked.sourceIds).toEqual(ALL_SOURCES);
				// The honest difference: read_raw names the dangling locator, the leaf
				// (which answers T ROWS) cannot.
				expect(a.unanswered).toEqual([DANGLING_ID]);
				expect(a.answered).toEqual(expectedA(ALL_SOURCES));
				const b = await assertReadRawParity(SOURCE, TARGET_B, whole, principal);
				expect(b.answered).toEqual(expectedB(ALL_SOURCES));
				// A pinned source set (<= CLIENT_MAX_LIMIT, so read_raw is unclamped).
				const pinnedIds = [3, 40, OFF_CHAIN_A];
				const pinned = {
					section_tipo: [SOURCE],
					filter_by_locators: pinnedIds.map((id) => ({ section_tipo: SOURCE, section_id: id })),
				};
				expect((await assertReadRawParity(SOURCE, TARGET_A, pinned, principal)).answered).toEqual(
					expectedA(pinnedIds),
				);
				// A filtered source (the chain hop): TARGET_A rows referenced by CHAIN.
				const filtered = {
					section_tipo: [TARGET_A],
					filter: { $and: [chainLeaf([CHAIN, SOURCE])] },
				};
				expect(
					(await assertReadRawParity(TARGET_A, TARGET_B, filtered, principal)).answered,
				).toEqual(CHAIN_EXPECTED[TARGET_B] as number[]);
			}
		},
		SLOW,
	);

	// THE SEARCH BOUND (search/search_statement.ts, the one executor): the opened
	// window's page and full_count run through matrixReadSource → runSearch, which
	// bounds a statement the leaf rendered into and leaves every other as it was.
	test('the bound is the READ PATH’s: page and count of a leaf search refuse past it; a plain search is unaffected', async () => {
		const leafSqo = targetSqo(
			TARGET_A,
			{ referenced_by: { section_tipo: [SOURCE] } },
			{ limit: PAGE, offset: 0 },
		);
		const plainSqo = { section_tipo: [TARGET_A], limit: PAGE, offset: 0 } as Sqo;
		// Unforced, the bound does not change the answer.
		expect(await matrixReadSource.count(leafSqo)).toBe(N);
		expect((await matrixReadSource.getRows(leafSqo)).length).toBe(PAGE);
		// Forced (< 1 ms: no whole ms left), both statements of the leaf search refuse, typed.
		const forced = { budgetMs: 0.001 };
		for (const run of [
			() => matrixReadSource.count(leafSqo, undefined, undefined, forced),
			() => matrixReadSource.getRows(leafSqo, undefined, undefined, forced),
		]) {
			const error = await errorOf(run);
			expect(error?.code).toBe('db.statement_timeout');
			expect(error?.coordinates?.door).toBe('referenced_by_search');
		}
		// The same override on a plain search changes nothing: it is never bounded.
		expect(await matrixReadSource.count(plainSqo, undefined, undefined, forced)).toBe(
			UNREFERENCED_A,
		);
		expect((await matrixReadSource.getRows(plainSqo, undefined, undefined, forced)).length).toBe(
			PAGE,
		);
	});

	// THE CHILDREN_RECURSIVE ROOTS PASS (sql_assembler searchChildrenRecursiveRoots):
	// a descendant-expanding search runs the caller's WHOLE filter — leaf included,
	// unpaginated — DURING the build. That is the only statement the build sends
	// through runSearch, so a build refused under a forced budget IS the roots pass
	// cut; the same build without the leaf is not bounded and completes.
	test('the children_recursive ROOTS PASS is bounded: a leaf search refuses at build past the budget; without the leaf it builds', async () => {
		const leaf = { referenced_by: { section_tipo: [SOURCE] } };
		const recursiveLeaf = { ...targetSqo(TARGET_A, leaf), children_recursive: true } as Sqo;
		const recursivePlain = { section_tipo: [TARGET_A], children_recursive: true } as Sqo;
		// Unforced, the recursive leaf search answers like the plain leaf search
		// (TARGET_A has no descendants: the roots ARE the answer).
		expect(await fullCount(recursiveLeaf)).toBe(N);
		const cut = await errorOf(() =>
			withSearchBudgetOverride(0.001, () => buildSearchSql(recursiveLeaf)),
		);
		expect(cut?.code).toBe('db.statement_timeout');
		expect(cut?.coordinates?.door).toBe('referenced_by_search');
		// Control: the same forced build without the leaf is never bounded.
		const plain = await withSearchBudgetOverride(0.001, () => buildSearchSql(recursivePlain));
		expect(searchStatementText(plain).carriesReferencedBy).toBe(false);
	});

	test('the flag is what the BUILD rendered: a leaf statement carries it, a plain one does not', async () => {
		const leaf = { referenced_by: { section_tipo: [SOURCE] } };
		const leafBuilt = searchStatementText(await buildSearchSql(targetSqo(TARGET_A, leaf)));
		expect(leafBuilt.carriesReferencedBy).toBe(true);
		const plainBuilt = searchStatementText(
			await buildSearchSql({ section_tipo: [TARGET_A] } as Sqo),
		);
		expect(plainBuilt.carriesReferencedBy).toBe(false);
		// Nested (a leaf inside a leaf's source) and under a boolean group: still carried.
		const nested = searchStatementText(
			await buildSearchSql(
				targetSqo(TARGET_A, {
					referenced_by: { section_tipo: [SOURCE], filter: { $and: [chainLeaf([CHAIN])] } },
				}),
			),
		);
		expect(nested.carriesReferencedBy).toBe(true);
		// The count statement of a leaf search carries it too.
		const count = searchStatementText(
			await buildSearchSql({ ...targetSqo(TARGET_A, leaf), full_count: true } as Sqo),
		);
		expect(count.carriesReferencedBy).toBe(true);
	});

	test('the bound is a REAL statement_timeout: in force for a leaf statement, a slow one is cut, a plain one is not', async () => {
		const poolCeilingMs = config.ops.dbStatementTimeoutMs;
		// Precondition: the pool ceiling does not itself cut a 300 ms plain statement.
		expect(poolCeilingMs === 0 || poolCeilingMs > 1_000).toBe(true);
		const timeoutSql =
			"SELECT (EXTRACT(epoch FROM current_setting('statement_timeout')::interval) * 1000)::int AS ms";
		const [leafSetting] = await runSearch<{ ms: number }>(
			createSearchStatement(timeoutSql, [], true),
		);
		expect(leafSetting?.ms).toBe(
			poolCeilingMs > 0
				? Math.min(poolCeilingMs, REFERENCED_BY_SEARCH_BUDGET_MS)
				: REFERENCED_BY_SEARCH_BUDGET_MS,
		);
		const [plainSetting] = await runSearch<{ ms: number }>(
			createSearchStatement(timeoutSql, [], false),
		);
		expect(plainSetting?.ms).toBe(poolCeilingMs);

		const startedAt = performance.now();
		const cut = await errorOf(() =>
			runSearch(createSearchStatement('SELECT pg_sleep(3)', [], true), { budgetMs: 200 }),
		);
		expect(cut?.code).toBe('db.statement_timeout');
		expect(cut?.coordinates).toEqual({ door: 'referenced_by_search', ceiling_ms: 200 });
		expect(performance.now() - startedAt).toBeLessThan(2_500);
		// The same slow statement and override without the flag runs to completion.
		const [done] = await runSearch<{ ok: number }>(
			createSearchStatement('SELECT pg_sleep(0.3), 1 AS ok', [], false),
			{ budgetMs: 200 },
		);
		expect(done?.ok).toBe(1);
	});

	test('INSIDE a caller transaction the bound still applies, then the caller ceiling is restored and the transaction goes on', async () => {
		const timeoutSql =
			"SELECT (EXTRACT(epoch FROM current_setting('statement_timeout')::interval) * 1000)::int AS ms";
		const poolCeilingMs = config.ops.dbStatementTimeoutMs;
		await withTransaction(async () => {
			const before = (await sql.unsafe(timeoutSql, [])) as { ms: number }[];
			expect(before[0]?.ms).toBe(poolCeilingMs);
			const [inside] = await runSearch<{ ms: number }>(
				createSearchStatement(timeoutSql, [], true),
				{
					budgetMs: 700,
				},
			);
			expect(inside?.ms).toBe(poolCeilingMs > 0 ? Math.min(poolCeilingMs, 700) : 700);
			const after = (await sql.unsafe(timeoutSql, [])) as { ms: number }[];
			expect(after[0]?.ms).toBe(poolCeilingMs);
			// A cut inside the caller's transaction: typed, and the transaction is usable after.
			const cut = await errorOf(() =>
				runSearch(createSearchStatement('SELECT pg_sleep(3)', [], true), { budgetMs: 200 }),
			);
			expect(cut?.code).toBe('db.statement_timeout');
			expect(cut?.coordinates).toEqual({ door: 'referenced_by_search', ceiling_ms: 200 });
			const alive = (await sql.unsafe('SELECT 1 AS ok', [])) as { ok: number }[];
			expect(alive[0]?.ok).toBe(1);
			const restored = (await sql.unsafe(timeoutSql, [])) as { ms: number }[];
			expect(restored[0]?.ms).toBe(poolCeilingMs);
			// A real leaf search inside the transaction answers as outside it.
			expect(
				await fullCount(targetSqo(TARGET_A, { referenced_by: { section_tipo: [SOURCE] } })),
			).toBe(N);
		});
	});

	test('EVERY door routes through the bound: read_raw, the MCP search, the SQL console, the diffusion keyset and the export cursor refuse a leaf past it; without the leaf they answer', async () => {
		const superuser = await resolvePrincipal(-1);
		const leaf = { referenced_by: { section_tipo: [SOURCE] } };
		const leafSqo = targetSqo(TARGET_A, leaf, { limit: PAGE, offset: 0 });
		const plainSqo = { section_tipo: [TARGET_A], limit: PAGE, offset: 0 } as Sqo;
		// Forced (< 1 ms: no whole ms left) — refused by the bound before sending.
		const forced = <T>(work: () => Promise<T>) => withSearchBudgetOverride(0.001, work);
		const doors: [string, (sqo: Sqo) => Promise<unknown>][] = [
			[
				'read_raw',
				(sqo) =>
					readRaw({ sectionTipo: TARGET_A, tipo: TARGET_A, type: 'section', sqo }, superuser),
			],
			[
				'mcp runLocatorPage',
				async (sqo) => {
					const gated = await buildGatedSqo(
						superuser,
						{ section_tipo: TARGET_A, raw_sqo: { filter: sqo.filter ?? undefined } },
						'test.mcp',
					);
					return runLocatorPage(superuser, gated.sqo);
				},
			],
			[
				'mcp runGatedCount',
				async (sqo) => {
					const gated = await buildGatedSqo(
						superuser,
						{ section_tipo: TARGET_A, raw_sqo: { filter: sqo.filter ?? undefined } },
						'test.mcp',
					);
					return runGatedCount(superuser, gated.sqo);
				},
			],
			[
				'diffusion selectRecordBatches',
				async (sqo) => {
					const batches: number[] = [];
					for await (const batch of selectRecordBatches(sqo, TARGET_A, PAGE)) {
						batches.push(...batch.sectionIds);
					}
					return batches;
				},
			],
			[
				// The admin SQL console: its catch must let the TYPED 503 through,
				// never re-wrap it into a 500 search.failed.
				'dd_utils_api convert_search_object_to_sql_query',
				async (sqo) => {
					const console = utilsApiActions.convert_search_object_to_sql_query;
					if (console === undefined) throw new Error('console action is not registered');
					return console(
						{
							dd_api: 'dd_utils_api',
							action: 'convert_search_object_to_sql_query',
							options: { ...sqo },
						} as unknown as Rqo,
						{
							requestId: 'referenced_by_console',
							clientIp: '127.0.0.1',
							session: null,
							csrfCandidate: null,
							principal: superuser,
						},
					);
				},
			],
			[
				'export openSelectionCursor',
				async (sqo) => {
					const cursor = await openSelectionCursor(
						await buildSearchSql({ ...sqo, limit: null } as unknown as Sqo, { idsOnly: true }),
						{ pageRows: PAGE },
					);
					const total = cursor.total;
					await cursor.close();
					return total;
				},
			],
		];
		for (const [door, run] of doors) {
			const refused = await errorOf(() => forced(() => run(leafSqo)));
			expect({ door, code: refused?.code, by: refused?.coordinates?.door }).toEqual({
				door,
				code: 'db.statement_timeout',
				by: 'referenced_by_search',
			});
			// The same override without the leaf changes nothing: never bounded.
			expect({ door, error: await errorOf(() => forced(() => run(plainSqo))) }).toEqual({
				door,
				error: null,
			});
			// Unforced, the leaf search answers through the same door.
			expect({ door, error: await errorOf(() => run(leafSqo)) }).toEqual({ door, error: null });
		}
	});

	test('the export cursor arms the leaf budget as its transaction_timeout: a slow leaf selection is cut, typed; a plain one is not', async () => {
		const sleepy =
			"SELECT 'zzrefby3' AS section_tipo, g AS section_id FROM generate_series(1, 30) AS g WHERE pg_sleep(0.1) IS NOT NULL ORDER BY g";
		const startedAt = performance.now();
		const cut = await errorOf(() =>
			withSearchBudgetOverride(300, async () => {
				const cursor = await openSelectionCursor(createSearchStatement(sleepy, [], true), {
					pageRows: PAGE,
				});
				await cursor.close();
			}),
		);
		expect(cut?.code).toBe('db.statement_timeout');
		expect(cut?.coordinates).toEqual({ door: 'referenced_by_search', ceiling_ms: 300 });
		expect(performance.now() - startedAt).toBeLessThan(2_500);
		const quick =
			"SELECT 'zzrefby3' AS section_tipo, g AS section_id FROM generate_series(1, 5) AS g WHERE pg_sleep(0.1) IS NOT NULL ORDER BY g";
		const total = await withSearchBudgetOverride(300, async () => {
			const cursor = await openSelectionCursor(createSearchStatement(quick, [], false), {
				pageRows: PAGE,
			});
			await cursor.close();
			return cursor.total;
		});
		expect(total).toBe(5);
	});

	test('the census at scale: every target section, exact total == the opened window’s full_count', async () => {
		const source = { section_tipo: [SOURCE] };
		const census = await countRelationTargets(source as never);
		expect(Object.fromEntries(census.map((c) => [c.tipo, c.total]))).toEqual({
			[TARGET_A]: N,
			[TARGET_B]: B_COUNT,
		});
		for (const { tipo, total } of census) {
			expect({ tipo, total: await fullCount(targetSqo(tipo, { referenced_by: source })) }).toEqual({
				tipo,
				total,
			});
		}
		// The grouped bound counts the dangling TARGET_A locator (N + 1): exact is a narrowing.
		const bound = await countRelationTargets(source as never, { exact: false });
		expect(bound.find((c) => c.tipo === TARGET_A)?.total).toBe(N + 1);
	});

	test(
		'INDEX INDEPENDENCE: with the situation’s matrix_relation_index rows deleted and a bogus one added, every answer is unchanged',
		async () => {
			const whole: Leaf = { referenced_by: { section_tipo: [SOURCE] } };
			const depth4 = chainLeaf(CHAIN_LEVELS);
			const before = {
				a: sorted((await walkPages(targetSqo(TARGET_A, whole))).ids),
				terminal: sorted(await idsOf(targetSqo(TERMINAL, depth4))),
				census: await countRelationTargets({ section_tipo: [SOURCE] } as never),
			};
			expect(before.a).toEqual(expectedA(ALL_SOURCES));
			expect(before.terminal).toEqual(CHAIN_EXPECTED[TERMINAL] as number[]);

			const ROLLBACK = new Error('referenced_by gate: roll the index damage back');
			let inside: typeof before | null = null;
			await assertTestDatabase('referenced_by_filter_native index independence');
			try {
				await withTransaction(async () => {
					const removed = (await sql.unsafe(
						`DELETE FROM matrix_relation_index
						 WHERE section_tipo LIKE 'zzrefby%' OR target_section_tipo LIKE 'zzrefby%'
						 RETURNING 1`,
					)) as unknown[];
					// The damage is real: every situation locator was indexed (N*2 + 1 + B…).
					expect(removed.length).toBeGreaterThan(2 * N);
					// …and a bogus index row claims SOURCE/1 points at the unreferenced record.
					await sql.unsafe(
						`INSERT INTO matrix_relation_index
						 (section_tipo, section_id, from_component_tipo, type, target_section_tipo, target_section_id)
						 VALUES ($1, 1, $2, 'dd151', $3, $4)`,
						[SOURCE, PORTAL_A, TARGET_A, UNREFERENCED_A],
					);
					const left = (await sql.unsafe(
						`SELECT count(*)::int AS n FROM matrix_relation_index WHERE section_tipo LIKE 'zzrefby%'`,
					)) as { n: number }[];
					expect(left[0]?.n).toBe(1);
					inside = {
						a: sorted((await walkPages(targetSqo(TARGET_A, whole))).ids),
						terminal: sorted(await idsOf(targetSqo(TERMINAL, depth4))),
						census: await countRelationTargets({ section_tipo: [SOURCE] } as never),
					};
					throw ROLLBACK;
				});
			} catch (error) {
				if (error !== ROLLBACK) throw error;
			}
			expect(inside as unknown).toEqual(before);
			expect((inside as unknown as typeof before).a).not.toContain(UNREFERENCED_A);
			// Rolled back: the trigger-built index is whole again.
			const restored = (await sql.unsafe(
				`SELECT count(DISTINCT section_id)::int AS owners FROM matrix_relation_index
				 WHERE section_tipo = $1 AND target_section_tipo = $2`,
				[SOURCE, TARGET_A],
			)) as { owners: number }[];
			expect(restored[0]?.owners).toBe(N);
		},
		SLOW,
	);

	test('a LOG-TABLE source (dd542, matrix_activity) is legal and answers read_raw’s harvest', async () => {
		// The relation index never covered matrix_activity; the stored relation
		// column is read like any other table's. One activity row minted through
		// the table's own sequence door, swept by its exact id.
		await assertTestDatabase('referenced_by_filter_native log table');
		const superuser = await resolvePrincipal(-1);
		const activityId = await insertMatrixRowSequenceId('matrix_activity', 'dd542', {
			relation: {
				dd543: [
					{ type: 'dd151', section_id: -1, section_tipo: 'dd128', from_component_tipo: 'dd543' },
				],
				dd545: [
					loc('dd545', TARGET_A, 2, 1),
					loc('dd545', TARGET_A, 4, 2),
					loc('dd545', TARGET_A, DANGLING_ID, 3),
					loc('dd545', TARGET_B, 3, 4),
				],
			},
			string: { dd546: [{ lang: 'lg-nolan', value: SOURCE }] },
		});
		try {
			const pinned = {
				section_tipo: ['dd542'],
				filter_by_locators: [{ section_tipo: 'dd542', section_id: activityId }],
			};
			for (const principal of [undefined, superuser]) {
				const a = await assertReadRawParity('dd542', TARGET_A, pinned, principal);
				expect(a.answered).toEqual([2, 4]);
				expect(a.unanswered).toEqual([DANGLING_ID]);
				expect((await assertReadRawParity('dd542', TARGET_B, pinned, principal)).answered).toEqual([
					3,
				]);
			}
			const census = await countRelationTargets(pinned as never, { principal: superuser });
			expect(Object.fromEntries(census.map((c) => [c.tipo, c.total]))).toMatchObject({
				[TARGET_A]: 2,
				[TARGET_B]: 1,
			});
		} finally {
			expect(await deleteMatrixRecord('matrix_activity', 'dd542', activityId)).toBe(1);
		}
		const residue = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM matrix_activity WHERE section_tipo = 'dd542' AND section_id = $1`,
			[activityId],
		)) as { n: number }[];
		expect(residue[0]?.n).toBe(0);
	});
});

// --- the persona half (principal-scoped) -------------------------------------

/** test3 records this file owns (minted in beforeAll, swept by (tipo, id)). */
const T3 = 'test3';
const T3_TABLE = 'matrix_test';
/** The test3 portal → test3 (granted to the editor). */
const T3_PORTAL = 'test80';
let SOURCE_IN_A: number;
let SOURCE_IN_B: number;
let TARGET_VIA_A: number;
let TARGET_VIA_B: number;
let TARGET_VIA_HIDDEN: number;
/** A target OUTSIDE the editor's projects, reached through the granted portal of SOURCE_IN_A. */
let TARGET_OUT_OF_SCOPE: number;
/**
 * THE NESTED HALF (depth 2 under a non-admin): TARGET_VIA_A → HOP2_FROM_A,
 * TARGET_OUT_OF_SCOPE (project B) → HOP2_FROM_OOS and TARGET_VIA_B →
 * HOP2_FROM_B, every hop-2 row in project A. The editor's middle set holds
 * TARGET_VIA_A only, so two witnesses: HOP2_FROM_OOS (a depth-1 row set that
 * lost the principal answers it — its middle row is project B) and HOP2_FROM_B
 * (a depth-2 row set that lost it answers it — its middle row is reached only
 * from the project-B source SOURCE_IN_B).
 */
let HOP2_FROM_A: number;
let HOP2_FROM_OOS: number;
let HOP2_FROM_B: number;
/**
 * THE SOURCE-FILTER HALF (hop-ACL tokens at depth 1): S_X → {HOP_IN_A, TX},
 * S_Y → {HOP_IN_B, TY}; the source filter is a TWO-HOP path (test80 → test52)
 * whose hop record is HOP_IN_A (project A) for S_X and HOP_IN_B (project B) for
 * S_Y. The editor's hop ACL refuses HOP_IN_B, so S_Y is not in her source set
 * and TY (project A, listable) is the witness.
 */
let HOP_IN_A: number;
let HOP_IN_B: number;
let TX: number;
let TY: number;
let S_X: number;
let S_Y: number;
/** The string component the two-hop source filter reads (granted to the editor). */
const T3_TEXT = 'test52';
const HOP_VALUE = 'zzrefbyhop';
/**
 * THE UNDECLARED-KEY HALF (SEC-1 owner key, nothing hidden): a CRAWL_CREATE_SECTION
 * record (every relation component granted to the editor, so "nothing hidden")
 * storing a test3 locator under its DECLARED filter key → TARGET_DECLARED and
 * one under a key that is no node of the section → TARGET_UNDECLARED.
 */
const UNDECLARED_RELATION_TIPO = 'zzrefbyorphan1';
let TARGET_DECLARED: number;
let TARGET_UNDECLARED: number;
let SOURCE_CREATE: number;
/** Every test3 id minted here, live or already swept (the residue check's set). */
const MINTED_T3: number[] = [];
/** The minted test3 ids not yet swept. */
const OWNED_T3: number[] = [];
/** The CRAWL_CREATE_SECTION ids minted here (same table), swept by exact id. */
const MINTED_CREATE: number[] = [];
const OWNED_CREATE: number[] = [];

function projectRelation(project: number) {
	return {
		[CRAWL_FILTER_COMPONENT]: [{ ...loc(CRAWL_FILTER_COMPONENT, 'dd153', project), type: 'dd675' }],
	};
}

/** Mint a test3 record through the allocator; returns (and owns) its id. */
async function mintT3(relation: Record<string, unknown>): Promise<number> {
	return mintT3Columns({ relation });
}

/** mintT3 with any jsonb columns (relation + string). */
async function mintT3Columns(columns: { relation: unknown; string?: unknown }): Promise<number> {
	const sectionId = await insertMatrixRecordWithCounter(T3_TABLE, T3, columns);
	MINTED_T3.push(sectionId);
	OWNED_T3.push(sectionId);
	return sectionId;
}

/** Mint a CRAWL_CREATE_SECTION record (matrix_test, like test3); returns (and owns) its id. */
async function mintCreate(relation: Record<string, unknown>): Promise<number> {
	const sectionId = await insertMatrixRecordWithCounter(T3_TABLE, CRAWL_CREATE_SECTION, {
		relation,
	});
	MINTED_CREATE.push(sectionId);
	OWNED_CREATE.push(sectionId);
	return sectionId;
}

/** Sweep exactly the test3 / create-section ids this file minted — never a range. */
async function sweepT3(): Promise<void> {
	const missing: string[] = [];
	const owned: [string, number][] = [
		...OWNED_T3.splice(0).map((id): [string, number] => [T3, id]),
		...OWNED_CREATE.splice(0).map((id): [string, number] => [CRAWL_CREATE_SECTION, id]),
	];
	for (const [tipo, id] of owned) {
		if ((await deleteMatrixRecord(T3_TABLE, tipo, id)) === 0) missing.push(`${tipo}/${id}`);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[tipo, id],
		);
	}
	if (missing.length > 0) {
		throw new Error(`referenced_by gate: the sweep removed nothing for ${missing.join(', ')}`);
	}
}

/** The two persona sources, pinned so no ambient test3 record contributes. */
function personaLeaf(extra: Record<string, unknown> = {}): Leaf {
	return {
		referenced_by: {
			section_tipo: [T3],
			filter_by_locators: [
				{ section_tipo: T3, section_id: SOURCE_IN_A },
				{ section_tipo: T3, section_id: SOURCE_IN_B },
			],
			...extra,
		},
	};
}

/** Run inside a request scope; returns the ids and whether perm.out_of_scope was noted. */
async function scoped(
	principal: Principal,
	leaf: Leaf,
): Promise<{ ids: number[]; count: number; notice: string | undefined; refusals: number }> {
	return runWithRequestContext(
		{ session: null, requestId: 'zzrefby-persona', clientIp: '', principal },
		async () => {
			expect(currentFrontierRefusals()).toEqual([]);
			const ids = sorted(await idsOf(targetSqo(T3, leaf), principal));
			const count = await fullCount(targetSqo(T3, leaf), principal);
			return {
				ids,
				count,
				notice: frontierRefusalNotice()?.code,
				refusals: currentFrontierRefusals().length,
			};
		},
	);
}

describe.if(DB_READY)('referenced_by leaf — a project-scoped persona', () => {
	let editor: Principal;
	let admin: Principal;

	beforeAll(async () => {
		await assertTestDatabase('referenced_by_filter_native persona');
		await installCrawlPersonaFixture();
		// Hop-2 rows (project A): what the middle set of a depth-2 leaf points at.
		HOP2_FROM_A = await mintT3(projectRelation(CRAWL_PROJECT_A));
		HOP2_FROM_OOS = await mintT3(projectRelation(CRAWL_PROJECT_A));
		HOP2_FROM_B = await mintT3(projectRelation(CRAWL_PROJECT_A));
		// Targets: all in project A (the editor may list every one of them as T)
		// but the out-of-scope one; two of them point one hop further.
		TARGET_VIA_A = await mintT3({
			...projectRelation(CRAWL_PROJECT_A),
			[T3_PORTAL]: [loc(T3_PORTAL, T3, HOP2_FROM_A)],
		});
		TARGET_VIA_B = await mintT3({
			...projectRelation(CRAWL_PROJECT_A),
			[T3_PORTAL]: [loc(T3_PORTAL, T3, HOP2_FROM_B)],
		});
		TARGET_VIA_HIDDEN = await mintT3(projectRelation(CRAWL_PROJECT_A));
		TARGET_OUT_OF_SCOPE = await mintT3({
			...projectRelation(CRAWL_PROJECT_B),
			[T3_PORTAL]: [loc(T3_PORTAL, T3, HOP2_FROM_OOS)],
		});
		// Source in A: a granted portal locator AND a hidden-component locator.
		SOURCE_IN_A = await mintT3({
			...projectRelation(CRAWL_PROJECT_A),
			[T3_PORTAL]: [
				loc(T3_PORTAL, T3, TARGET_VIA_A, 1),
				loc(T3_PORTAL, T3, TARGET_OUT_OF_SCOPE, 2),
			],
			[CRAWL_HIDDEN_COMPONENT]: [loc(CRAWL_HIDDEN_COMPONENT, T3, TARGET_VIA_HIDDEN)],
		});
		// Source in B (out of the editor's scope): a granted portal locator.
		SOURCE_IN_B = await mintT3({
			...projectRelation(CRAWL_PROJECT_B),
			[T3_PORTAL]: [loc(T3_PORTAL, T3, TARGET_VIA_B)],
		});
		// The source-filter half: hop records carry the searched string.
		const hopText = (project: number) => ({
			relation: projectRelation(project),
			string: { [T3_TEXT]: [{ id: 1, lang: 'lg-eng', value: `${HOP_VALUE} ${project}` }] },
		});
		HOP_IN_A = await mintT3Columns(hopText(CRAWL_PROJECT_A));
		HOP_IN_B = await mintT3Columns(hopText(CRAWL_PROJECT_B));
		TX = await mintT3(projectRelation(CRAWL_PROJECT_A));
		TY = await mintT3(projectRelation(CRAWL_PROJECT_A));
		S_X = await mintT3({
			...projectRelation(CRAWL_PROJECT_A),
			[T3_PORTAL]: [loc(T3_PORTAL, T3, HOP_IN_A, 1), loc(T3_PORTAL, T3, TX, 2)],
		});
		S_Y = await mintT3({
			...projectRelation(CRAWL_PROJECT_A),
			[T3_PORTAL]: [loc(T3_PORTAL, T3, HOP_IN_B, 1), loc(T3_PORTAL, T3, TY, 2)],
		});
		// The undeclared-key half.
		TARGET_DECLARED = await mintT3(projectRelation(CRAWL_PROJECT_A));
		TARGET_UNDECLARED = await mintT3(projectRelation(CRAWL_PROJECT_A));
		SOURCE_CREATE = await mintCreate({
			[CRAWL_CREATE_FILTER]: [
				{ ...loc(CRAWL_CREATE_FILTER, 'dd153', CRAWL_PROJECT_A, 1), type: 'dd675' },
				loc(CRAWL_CREATE_FILTER, T3, TARGET_DECLARED, 2),
			],
			[UNDECLARED_RELATION_TIPO]: [loc(UNDECLARED_RELATION_TIPO, T3, TARGET_UNDECLARED)],
		});
		editor = await resolvePrincipal(CRAWL_EDITOR_USER_ID);
		admin = await resolvePrincipal(CRAWL_ADMIN_USER_ID);
	}, SLOW);

	afterAll(async () => {
		try {
			await sweepT3();
		} finally {
			await removeCrawlPersonaFixture();
		}
		// Zero residue on exactly the minted ids: no row, no index entry owned by
		// or pointing at any of them.
		expect(MINTED_T3.length).toBe(17);
		expect(MINTED_CREATE.length).toBe(1);
		const residue = (await sql.unsafe(
			`SELECT
			   (SELECT count(*)::int FROM "${T3_TABLE}"
			     WHERE (section_tipo = $1 AND section_id = ANY($2::int[]))
			        OR (section_tipo = $3 AND section_id = ANY($4::int[])))
			 + (SELECT count(*)::int FROM matrix_relation_index
			     WHERE (section_tipo = $1 AND section_id = ANY($2::int[]))
			        OR (target_section_tipo = $1 AND target_section_id = ANY($2::int[]))
			        OR (section_tipo = $3 AND section_id = ANY($4::int[]))) AS n`,
			[T3, `{${MINTED_T3.join(',')}}`, CRAWL_CREATE_SECTION, `{${MINTED_CREATE.join(',')}}`],
		)) as { n: number }[];
		expect(residue[0]?.n).toBe(0);
	}, SLOW);

	test('the personas are what the gate assumes (read through the real doors)', () => {
		expect(editor.isGlobalAdmin).toBe(false);
		expect(admin.isGlobalAdmin).toBe(true);
	});

	test('control: internal and admin searches see every target (the contrast is non-degenerate)', async () => {
		const all = sorted([TARGET_VIA_A, TARGET_VIA_B, TARGET_VIA_HIDDEN, TARGET_OUT_OF_SCOPE]);
		expect(sorted(await idsOf(targetSqo(T3, personaLeaf())))).toEqual(all);
		const asAdmin = await scoped(admin, personaLeaf());
		expect(asAdmin.ids).toEqual(all);
		expect(asAdmin.count).toBe(4);
	});

	test('editor: out-of-scope sources contribute nothing, hidden-component locators are excluded, notice noted', async () => {
		const asEditor = await scoped(editor, personaLeaf());
		expect(asEditor.ids).toEqual([TARGET_VIA_A]);
		expect(asEditor.count).toBe(1);
		expect(asEditor.notice).toBe('perm.out_of_scope');
	});

	test('PARITY with read_raw target_section per principal: leaf == harvest ∩ visible T rows', async () => {
		const sourceSqo = {
			section_tipo: [T3],
			filter_by_locators: [
				{ section_tipo: T3, section_id: SOURCE_IN_A },
				{ section_tipo: T3, section_id: SOURCE_IN_B },
			],
		};
		const superuser = await resolvePrincipal(-1);
		const inScope = (principal: Principal) =>
			runWithRequestContext(
				{ session: null, requestId: 'zzrefby-parity', clientIp: '', principal },
				() => assertReadRawParity(T3, T3, sourceSqo, principal),
			);
		// Editor: SOURCE_IN_B is out of scope (no harvest), test91 is hidden (its
		// locator is not harvested), and the out-of-project target IS harvested
		// (read_raw returns the raw locator) but is no T row the editor may list.
		const asEditor = await inScope(editor);
		expect(asEditor.answered).toEqual([TARGET_VIA_A]);
		expect(asEditor.unanswered).toEqual([TARGET_OUT_OF_SCOPE]);
		// The admin and the superuser reach everything: the narrowing above is the
		// principal, not the data.
		const all = sorted([TARGET_VIA_A, TARGET_VIA_B, TARGET_VIA_HIDDEN, TARGET_OUT_OF_SCOPE]);
		for (const principal of [admin, superuser]) {
			const answer = await inScope(principal);
			expect(answer.answered).toEqual(all);
			expect(answer.unanswered).toEqual([]);
		}
		expect((await assertReadRawParity(T3, T3, sourceSqo)).answered).toEqual(all);
	});

	test('editor: the project scope alone excludes the out-of-scope source (granted component pinned)', async () => {
		const asEditor = await scoped(editor, personaLeaf({ from_component_tipo: T3_PORTAL }));
		expect(asEditor.ids).toEqual([TARGET_VIA_A]);
		const asAdmin = await scoped(admin, personaLeaf({ from_component_tipo: T3_PORTAL }));
		expect(asAdmin.ids).toEqual(sorted([TARGET_VIA_A, TARGET_VIA_B, TARGET_OUT_OF_SCOPE]));
	});

	test('editor: an explicit HIDDEN from_component_tipo answers nothing, with the notice', async () => {
		const asEditor = await scoped(
			editor,
			personaLeaf({ from_component_tipo: CRAWL_HIDDEN_COMPONENT }),
		);
		expect(asEditor.ids).toEqual([]);
		expect(asEditor.count).toBe(0);
		expect(asEditor.notice).toBe('perm.out_of_scope');
		expect(asEditor.refusals).toBeGreaterThan(0);
		// Control: the admin reaches the same locator, so "nothing" is the key, not the data.
		const asAdmin = await scoped(
			admin,
			personaLeaf({ from_component_tipo: CRAWL_HIDDEN_COMPONENT }),
		);
		expect(asAdmin.ids).toEqual([TARGET_VIA_HIDDEN]);
	});

	test('editor: no read grant on a source section → perm.denied', async () => {
		expect(
			await codeOf(() =>
				buildSearchSql(targetSqo(T3, { referenced_by: { section_tipo: [CRAWL_DENIED_SECTION] } }), {
					principal: editor,
				}),
			),
		).toBe('perm.denied');
		// EVERY source section is checked: one granted section does not carry a denied one.
		expect(
			await codeOf(() =>
				buildSearchSql(
					targetSqo(T3, { referenced_by: { section_tipo: [T3, CRAWL_DENIED_SECTION] } }),
					{ principal: editor },
				),
			),
		).toBe('perm.denied');
		// Control: the same leaf over a granted section compiles for the editor.
		expect(
			await codeOf(() => buildSearchSql(targetSqo(T3, personaLeaf()), { principal: editor })),
		).toBe('NO THROW');
	});

	// --- nested leaves and source filters under a NON-ADMIN principal ---------
	// (the depth >= 1 row-set records ACL, and the depth-tagged hop-ACL tokens
	// `_ACLr<d>n…_` of a source filter: built only for a non-admin, so a gate
	// run as internal / superuser never reaches them)

	/** depth 2: rows referenced by the rows personaLeaf's sources reference. */
	const depth2Leaf = (): Leaf => ({
		referenced_by: { section_tipo: [T3], filter: { $and: [personaLeaf()] } },
	});

	/** depth 1 with a TWO-HOP source filter (test80 → test52 begins with HOP_VALUE). */
	const hopFilteredSource = () => ({
		section_tipo: [T3],
		filter_by_locators: [
			{ section_tipo: T3, section_id: S_X },
			{ section_tipo: T3, section_id: S_Y },
		],
		filter: {
			$and: [
				{
					q: `${HOP_VALUE}*`,
					path: [
						{ section_tipo: T3, component_tipo: T3_PORTAL },
						{ section_tipo: T3, component_tipo: T3_TEXT },
					],
				},
			],
		},
	});
	const hopLeaf = (): Leaf => ({ referenced_by: hopFilteredSource() });

	test('editor, depth 2: the NESTED row set keeps the principal (an out-of-scope middle row contributes nothing)', async () => {
		const asEditor = await scoped(editor, depth2Leaf());
		expect(asEditor.ids).toEqual([HOP2_FROM_A]);
		expect(asEditor.count).toBe(1);
		// Controls: the admin and the internal search reach every hop-2 row, so
		// the witnesses' absence above is the nested records ACL (depth 1 and
		// depth 2), not the data.
		const all = sorted([HOP2_FROM_A, HOP2_FROM_OOS, HOP2_FROM_B]);
		expect((await scoped(admin, depth2Leaf())).ids).toEqual(all);
		expect(sorted(await idsOf(targetSqo(T3, depth2Leaf())))).toEqual(all);
	});

	test('editor, source FILTER with a two-hop path: the depth-1 hop ACL refuses a project-B hop record', async () => {
		const asEditor = await scoped(editor, hopLeaf());
		expect(asEditor.ids).toEqual(sorted([HOP_IN_A, TX]));
		expect(asEditor.count).toBe(2);
		// TY is a project-A row the editor may list; only S_Y's hop into project B
		// (refused by the hop ACL) keeps it out. The admin and the internal search
		// match S_Y through HOP_IN_B, so the difference is the principal.
		const all = sorted([HOP_IN_A, TX, HOP_IN_B, TY]);
		expect((await scoped(admin, hopLeaf())).ids).toEqual(all);
		expect(sorted(await idsOf(targetSqo(T3, hopLeaf())))).toEqual(all);
	});

	test('editor, SIBLING leaves at the same depth: their tokens never collide ($or unions, $and intersects)', async () => {
		const orSqo = {
			section_tipo: [T3],
			filter: { $or: [depth2Leaf(), hopLeaf()] },
		} as unknown as Sqo;
		const pinX: Leaf = {
			referenced_by: {
				section_tipo: [T3],
				filter_by_locators: [{ section_tipo: T3, section_id: S_X }],
			},
		};
		const andSqo = {
			section_tipo: [T3],
			filter: { $and: [hopLeaf(), pinX, depth2Leaf()] },
		} as unknown as Sqo;
		const run = (principal: Principal, sqo: Sqo) =>
			runWithRequestContext(
				{ session: null, requestId: 'zzrefby-siblings', clientIp: '', principal },
				async () => sorted(await idsOf(sqo, principal)),
			);
		expect(await run(editor, orSqo)).toEqual(sorted([HOP2_FROM_A, HOP_IN_A, TX]));
		expect(await run(admin, orSqo)).toEqual(
			sorted([HOP2_FROM_A, HOP2_FROM_OOS, HOP2_FROM_B, HOP_IN_A, TX, HOP_IN_B, TY]),
		);
		// hop ∩ pinX = {HOP_IN_A, TX}; ∩ depth 2 = {} — and without the depth-2
		// sibling the intersection is exactly the pin's targets.
		expect(await run(editor, andSqo)).toEqual([]);
		expect(
			await run(editor, {
				section_tipo: [T3],
				filter: { $and: [hopLeaf(), pinX] },
			} as unknown as Sqo),
		).toEqual(sorted([HOP_IN_A, TX]));
		// An OUTER (depth 0) two-hop clause beside the leaf whose source filter
		// carries the same two-hop clause at depth 1: both build hop-ACL tokens in
		// one statement (`_ACL…_` and `_ACLr1n…_`).
		const outerHop = (hopFilteredSource().filter as { $and: unknown[] }).$and[0];
		const mixedSqo = {
			section_tipo: [T3],
			filter: { $or: [outerHop, hopLeaf()] },
		} as unknown as Sqo;
		expect(await run(editor, mixedSqo)).toEqual(sorted([S_X, HOP_IN_A, TX]));
		expect(await run(admin, mixedSqo)).toEqual(sorted([S_X, S_Y, HOP_IN_A, TX, HOP_IN_B, TY]));
	});

	test('census with a source FILTER as the editor: the same hop ACL (reader vs control)', async () => {
		const census = async (principal: Principal) =>
			runWithRequestContext(
				{ session: null, requestId: 'zzrefby-census-filter', clientIp: '', principal },
				async () =>
					Object.fromEntries(
						(await countRelationTargets(hopFilteredSource() as never, { principal })).map((c) => [
							c.tipo,
							c.total,
						]),
					),
			);
		expect((await census(editor))[T3]).toBe(2);
		expect((await census(admin))[T3]).toBe(4);
	});

	// --- the SEC-1 owner key when NOTHING is hidden --------------------------

	test('editor, nothing hidden on the source section: an UNDECLARED stored key is never followed (read_raw parity)', async () => {
		const leaf: Leaf = {
			referenced_by: {
				section_tipo: [CRAWL_CREATE_SECTION],
				filter_by_locators: [{ section_tipo: CRAWL_CREATE_SECTION, section_id: SOURCE_CREATE }],
			},
		};
		// Precondition: the editor holds every relation component of the section,
		// so this is the "nothing hidden" arm (no notice), not the hidden one.
		const asEditor = await scoped(editor, leaf);
		expect(asEditor.notice).toBeUndefined();
		expect(asEditor.ids).toEqual([TARGET_DECLARED]);
		expect(asEditor.count).toBe(1);
		// Control: the admin follows every stored key (as read_raw does for it).
		expect((await scoped(admin, leaf)).ids).toEqual(sorted([TARGET_DECLARED, TARGET_UNDECLARED]));
		// read_raw's per-key harvest, the semantics the leaf claims: the editor
		// never harvests the undeclared key's locator.
		const harvest = await runWithRequestContext(
			{ session: null, requestId: 'zzrefby-orphan-raw', clientIp: '', principal: editor },
			() =>
				harvestIds(CRAWL_CREATE_SECTION, T3, leaf.referenced_by, editor).then((h) => h.targetIds),
		);
		expect(harvest).toEqual([TARGET_DECLARED]);
		// The census asks the same scope.
		const census = async (principal: Principal) =>
			runWithRequestContext(
				{ session: null, requestId: 'zzrefby-orphan-census', clientIp: '', principal },
				async () =>
					Object.fromEntries(
						(await countRelationTargets(leaf.referenced_by as never, { principal })).map((c) => [
							c.tipo,
							c.total,
						]),
					),
			);
		expect((await census(editor))[T3]).toBe(1);
		expect((await census(admin))[T3]).toBe(2);
	});
});
