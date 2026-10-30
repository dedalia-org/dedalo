/**
 * dd_core_api::relation_targets — the "Open relationships" census door
 * (WC-2026-10-30-search-referenced-by-leaf), driven through `dispatchRqo`.
 *
 * WHAT IT PROVES, on a situation this file BUILDS (scratch `test3` / `test2`
 * records in matrix_test, swept after; identities from
 * test/helpers/read_door_identity_fixture.ts):
 *
 *   - grouped totals: the superuser's census names every target section with
 *     its EXACT total (a dangling locator counts in the grouped upper bound,
 *     never in the answer — the bound is asserted beside it so the difference
 *     is real, not assumed);
 *   - from_component_tipo narrows the census to one component's locators;
 *   - target-grant filtering, as a PAIR: the reader holds the relation
 *     component (test54) that points into test2 but no grant on test2, so test2
 *     is ABSENT for it and PRESENT for the control that holds test2;
 *   - the SEC-1 component key, as a PAIR: test80's locators are invisible to the
 *     reader (test80 = 0) and counted for the control, and the reader's answer
 *     carries the `perm.out_of_scope` notice the superuser's does not;
 *   - perm.denied (403) on a source section the caller cannot read;
 *   - the STRICT envelope: an unknown options key, a refused source key, a
 *     `sqo`, a missing source → request.invalid_options (400), never a widened
 *     census;
 *   - labels in the request's application language (labelByTipo);
 *   - PRINCIPAL-LOSS detection: a target outside the readers' project reached
 *     through a granted component — in the reader's grouped bound, out of its
 *     exact total (reader 2 < superuser 4), so an exact step that lost the
 *     principal reddens;
 *   - the FULL_COUNT LAW: every census total, for every scope and principal,
 *     equals the opened window's own `dd_core_api::count` with the leaf;
 *   - INDEX INDEPENDENCE: the census reads the sources' stored `relation`
 *     column — with their matrix_relation_index rows deleted (rolled back) the
 *     answer is unchanged;
 *   - THE BUDGET: an exhausted whole-census budget (the internal `budgetMs`
 *     override; unreachable from the wire — the envelope refuses it) is the
 *     typed `db.statement_timeout`; MEASURED on a statement the server really
 *     runs (a lock wait behind an idle flight holder): the census's own SET
 *     LOCAL cuts it at the remaining ms (the transaction lane types the 57014),
 *     and no statement_timeout is left behind; and
 *     the ORDERING tripwire: RELATION_TARGETS_BUDGET_MS +
 *     RELATION_TARGETS_RESPONSE_MARGIN_MS < the client's
 *     RELATION_TARGETS_TIMEOUT_MS (the client gate test_open_related_data.js
 *     asserts it is the timeout the census request hands data_manager);
 *   - ONE CENSUS PER SESSION: an earlier census of the same session — played by
 *     a reserved connection holding the flight lock — is CANCELLED whether it
 *     is running a statement or waiting on the lock (then it answers the typed
 *     409 resource.conflict), the newer census answers, and the door keys the
 *     flight by the request's own session — every ordering precondition WAITED
 *     FOR in pg_stat_activity / pg_locks, never assumed after a fixed sleep; and
 *     the flight stays inside THIS database: a same-key holder on another
 *     database of the cluster is neither waited for nor cancelled.
 *
 * NEVER a section-global count: test3 is a shared playground and other gates
 * mint into it concurrently — every source set is pinned by
 * `filter_by_locators` to this file's own records.
 *
 * SCRATCH: test3 + test2 records MINTED through the allocator
 * (insertMatrixRecordWithCounter — no reserved id range exists), their ids kept
 * and swept in afterAll by those exact (tipo, id) pairs, with a throw when one
 * was already gone and a zero-residue check (matrix row + relation index) on
 * exactly those ids. The dangling target is an id minted and deleted at once:
 * the counter is a high-water mark, so that address is never re-minted.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { SQL } from 'bun';
import { config } from '../../src/config/config.ts';
import { bunSqlTransportOptions, resolvePgTransport } from '../../src/config/pg_transport.ts';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import type { Sqo } from '../../src/core/concepts/sqo.ts';
import {
	deleteMatrixRecord,
	insertMatrixRecordWithCounter,
} from '../../src/core/db/matrix_write.ts';
import { sql, sqlStateOf, withTransaction } from '../../src/core/db/postgres.ts';
import { labelByTipo } from '../../src/core/ontology/labels.ts';
import {
	countRelationTargets,
	RELATION_TARGETS_BUDGET_MS,
	RELATION_TARGETS_FLIGHT_LOCK_CLASS,
	RELATION_TARGETS_RESPONSE_MARGIN_MS,
	relationTargetsFlightKey,
} from '../../src/core/search/relation_targets.ts';
import {
	getPermissions,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import {
	DOOR_CONTROL_USER_ID,
	DOOR_FILTER,
	DOOR_MEDIA_ONLY_USER_ID,
	DOOR_PORTAL,
	DOOR_READER_USER_ID,
	DOOR_RELATED,
	DOOR_SECTION,
	DOOR_SIBLING_SECTION,
	doorProjectLocator,
	installReadDoorIdentityFixture,
	removeReadDoorIdentityFixture,
} from '../helpers/read_door_identity_fixture.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const TABLE = 'matrix_test';

// Every id below is MINTED in beforeAll (never a constant: there is no
// reserved section_id range a gate may claim).
/** Sources: S1 points through test54 (related), S2 through test80 (portal). */
let SOURCE_RELATED: number;
let SOURCE_PORTAL: number;
/** test3 targets: A (both components), B (test54 only), C (test80 only). */
let TARGET_A: number;
let TARGET_B: number;
let TARGET_C: number;
/**
 * A test3 target OUTSIDE the readers' project (no project locator), reached
 * through test54 — granted to every reader. The PRINCIPAL-LOSS witness: the
 * reader sees the locator, so the grouped bound counts it, and only T's records
 * ACL in the exact step removes it. An exact step that lost the principal would
 * answer it.
 */
let TARGET_OUT_OF_PROJECT: number;
/** The test2 target, reached through test54. */
let TARGET_SIBLING: number;
/** A test3 address minted and deleted at once — the dangling locator's target. */
let TARGET_DANGLING: number;
/** test2's projects filter (component_filter of the sibling section). */
const SIBLING_FILTER = 'test41';
/** The projects section every source's test101 locator points into. */
const PROJECTS_SECTION = 'dd153';

/** The live records this file minted (filled as they are created). */
const OWNED: { sectionTipo: string; sectionId: number }[] = [];
/** Every address this file minted, the dangling one included (residue check). */
const MINTED: { sectionTipo: string; sectionId: number }[] = [];

let reader: Principal;
let control: Principal;
let mediaOnly: Principal;
let superuser: Principal;

function contextFor(principal: Principal): ApiRequestContext {
	const token = createSession(
		principal.userId,
		`zzreltgt_${principal.userId}`,
		principal.isGlobalAdmin,
	);
	const session = getSession(token);
	return {
		requestId: 'relation-targets-gate',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal,
	} as ApiRequestContext;
}

function locator(componentTipo: string, sectionTipo: string, sectionId: number, id = 1) {
	return {
		id,
		type: 'dd151',
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: componentTipo,
	};
}

/** Mint a scratch record through the allocator; returns (and owns) its id. */
async function mintScratch(sectionTipo: string, relation: unknown): Promise<number> {
	const sectionId = await insertMatrixRecordWithCounter(TABLE, sectionTipo, { relation });
	OWNED.push({ sectionTipo, sectionId });
	MINTED.push({ sectionTipo, sectionId });
	return sectionId;
}

/** Mint an address and delete it at once: a target that can never exist again. */
async function mintDanglingAddress(sectionTipo: string): Promise<number> {
	const sectionId = await insertMatrixRecordWithCounter(TABLE, sectionTipo, {});
	MINTED.push({ sectionTipo, sectionId });
	if ((await deleteMatrixRecord(TABLE, sectionTipo, sectionId)) !== 1) {
		throw new Error(`relation_targets gate: dangling ${sectionTipo}/${sectionId} not removed`);
	}
	return sectionId;
}

/** Sweep exactly the (tipo, id) pairs this file minted — never a range. */
async function sweep() {
	const missing: string[] = [];
	for (const { sectionTipo, sectionId } of OWNED.splice(0)) {
		if ((await deleteMatrixRecord(TABLE, sectionTipo, sectionId)) !== 1) {
			missing.push(`${sectionTipo}/${sectionId}`);
		}
	}
	for (const { sectionTipo, sectionId } of MINTED) {
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[sectionTipo, sectionId],
		);
	}
	if (missing.length > 0) {
		throw new Error(`relation_targets gate sweep removed nothing for ${missing.join(', ')}`);
	}
	// Zero residue on exactly the minted addresses: no row, no index entry
	// owned by or pointing at any of them.
	for (const { sectionTipo, sectionId } of MINTED) {
		const residue = (await sql.unsafe(
			`SELECT
			   (SELECT count(*)::int FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2)
			 + (SELECT count(*)::int FROM matrix_relation_index
			     WHERE (section_tipo = $1 AND section_id = $2)
			        OR (target_section_tipo = $1 AND target_section_id = $2)) AS n`,
			[sectionTipo, sectionId],
		)) as { n: number }[];
		expect({ address: `${sectionTipo}/${sectionId}`, residue: residue[0]?.n }).toEqual({
			address: `${sectionTipo}/${sectionId}`,
			residue: 0,
		});
	}
}

/** The source set pinned to this file's two source records. */
function sourceSet(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		section_tipo: [DOOR_SECTION],
		filter_by_locators: [
			{ section_tipo: DOOR_SECTION, section_id: SOURCE_RELATED },
			{ section_tipo: DOOR_SECTION, section_id: SOURCE_PORTAL },
		],
		...extra,
	};
}

interface Envelope {
	ok: boolean;
	data?: { tipo: string; label: string; total: number }[];
	notices?: { code: string }[];
	error?: { code: string };
}

async function census(
	principal: Principal,
	options: Record<string, unknown>,
	extraRqo: Record<string, unknown> = {},
): Promise<{ status: number; body: Envelope }> {
	const result = await dispatchRqo(
		{ dd_api: 'dd_core_api', action: 'relation_targets', options, ...extraRqo } as unknown as Rqo,
		contextFor(principal),
	);
	return { status: result.status, body: result.body as unknown as Envelope };
}

/** tipo → total of a successful census. */
function totals(body: Envelope): Record<string, number> {
	expect(body.ok).toBe(true);
	return Object.fromEntries((body.data ?? []).map((entry) => [entry.tipo, entry.total]));
}

const sorted = (ids: readonly number[]) => [...ids].sort((a, b) => a - b);

/**
 * The rows the opened window lists for `principal`: T = test3 under the leaf
 * over `source` when given, else the plain T search pinned to `ids` (the
 * visibility probe). The window's own assembler, never a re-implementation.
 */
async function windowRows(
	principal: Principal,
	ids?: readonly number[],
	source?: Record<string, unknown>,
): Promise<number[]> {
	const sqo = {
		section_tipo: [DOOR_SECTION],
		...(ids === undefined
			? {}
			: { filter_by_locators: ids.map((id) => ({ section_tipo: DOOR_SECTION, section_id: id })) }),
		...(source === undefined ? {} : { filter: { $and: [{ referenced_by: source }] } }),
		limit: 100,
		offset: 0,
	} as unknown as Sqo;
	const built = await buildSearchSql(sqo, { idsOnly: true, principal });
	const rows = (await sql.unsafe(built.sql, built.params as never[])) as { section_id: unknown }[];
	return sorted(rows.map((row) => Number(row.section_id)));
}

/** The opened window's total: dd_core_api::count with the referenced_by leaf, as `principal`. */
async function windowCount(
	principal: Principal,
	tipo: string,
	source: Record<string, unknown>,
): Promise<number> {
	const result = await dispatchRqo(
		{
			dd_api: 'dd_core_api',
			action: 'count',
			prevent_lock: true,
			sqo: { section_tipo: [tipo], filter: { $and: [{ referenced_by: source }] } },
		} as unknown as Rqo,
		contextFor(principal),
	);
	const body = result.body as unknown as { ok: boolean; data?: { total: number }; error?: unknown };
	expect({ tipo, status: result.status, ok: body.ok }).toEqual({ tipo, status: 200, ok: true });
	return Number(body.data?.total);
}

/** The pool connection's statement_timeout, outside any transaction. */
async function currentStatementTimeout(): Promise<string> {
	const rows = (await sql.unsafe('SHOW statement_timeout')) as { statement_timeout: string }[];
	return String(rows[0]?.statement_timeout);
}

/**
 * Poll `probe` (a real server-state read) until it holds; loud after the
 * deadline. An ordering precondition is MEASURED, never assumed after a sleep.
 */
async function waitUntil(what: string, probe: () => Promise<boolean>, deadlineMs = 10_000) {
	const until = Date.now() + deadlineMs;
	while (!(await probe())) {
		if (Date.now() > until) throw new Error(`relation_targets gate: timed out waiting for ${what}`);
		await Bun.sleep(20);
	}
}

/** Is backend `pid` running `SELECT pg_sleep…` right now? */
async function backendSleeping(pid: number): Promise<boolean> {
	const [row] = (await sql.unsafe(
		"SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND state = 'active' " +
			"AND query LIKE 'SELECT pg_sleep%') AS on",
		[pid],
	)) as { on: boolean }[];
	return row?.on === true;
}

/** A dedicated one-connection pool on another database of the SAME cluster. */
function connectToDatabase(database: string): SQL {
	const { user, password, sslMode } = config.db;
	return new SQL({
		database,
		username: user,
		password: password || undefined,
		// the pool's own sslmode vocabulary (postgres.ts PostgresSslMode)
		tls: sslMode as 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full',
		max: 1,
		...bunSqlTransportOptions(resolvePgTransport(config.db)),
	});
}

/** The client file whose census request carries RELATION_TARGETS_TIMEOUT_MS. */
const CLIENT_CENSUS_FILE = join(
	import.meta.dir,
	'..',
	'..',
	'client',
	'dedalo',
	'core',
	'section',
	'js',
	'render_open_list_with_direct_relations.js',
);

/**
 * The client module's ONE top-level `export const NAME = <a product of integer
 * literals>` declaration, evaluated (e.g. `35 * 1000`). A missing, repeated or
 * non-literal declaration throws — the gate never guesses a value. (That the
 * constant is what the transport uses is the client gate's outcome check.)
 */
function clientConstantMs(source: string, name: string): number {
	const declarations = source.match(new RegExp(`\\bconst\\s+${name}\\b`, 'g')) ?? [];
	if (declarations.length !== 1) {
		throw new Error(
			`client constant ${name}: expected one declaration, found ${declarations.length}`,
		);
	}
	const match = source.match(new RegExp(`^export const ${name} = ([0-9_ *]+?)\\s*;?\\s*$`, 'm'));
	if (match === null)
		throw new Error(`client constant ${name} not found as an exported product of integers`);
	const factors = (match[1] as string)
		.split('*')
		.map((factor) => Number(factor.trim().replaceAll('_', '')));
	if (factors.some((factor) => !Number.isInteger(factor) || factor <= 0)) {
		throw new Error(`client constant ${name}: unreadable value '${match[1]}'`);
	}
	return factors.reduce((product, factor) => product * factor, 1);
}

describe.if(DB_READY)('dd_core_api::relation_targets', () => {
	beforeAll(async () => {
		await installReadDoorIdentityFixture();
		await assertTestDatabase('relation_targets_native');
		const project = doorProjectLocator();
		TARGET_A = await mintScratch(DOOR_SECTION, { [DOOR_FILTER]: [project] });
		TARGET_B = await mintScratch(DOOR_SECTION, { [DOOR_FILTER]: [project] });
		TARGET_C = await mintScratch(DOOR_SECTION, { [DOOR_FILTER]: [project] });
		TARGET_OUT_OF_PROJECT = await mintScratch(DOOR_SECTION, {});
		TARGET_SIBLING = await mintScratch(DOOR_SIBLING_SECTION, {
			[SIBLING_FILTER]: [{ ...project, from_component_tipo: SIBLING_FILTER }],
		});
		TARGET_DANGLING = await mintDanglingAddress(DOOR_SECTION);
		SOURCE_RELATED = await mintScratch(DOOR_SECTION, {
			[DOOR_FILTER]: [project],
			[DOOR_RELATED]: [
				locator(DOOR_RELATED, DOOR_SECTION, TARGET_A, 1),
				locator(DOOR_RELATED, DOOR_SECTION, TARGET_B, 2),
				locator(DOOR_RELATED, DOOR_SIBLING_SECTION, TARGET_SIBLING, 3),
				locator(DOOR_RELATED, DOOR_SECTION, TARGET_DANGLING, 4),
				locator(DOOR_RELATED, DOOR_SECTION, TARGET_OUT_OF_PROJECT, 5),
			],
		});
		SOURCE_PORTAL = await mintScratch(DOOR_SECTION, {
			[DOOR_FILTER]: [project],
			[DOOR_PORTAL]: [
				locator(DOOR_PORTAL, DOOR_SECTION, TARGET_C, 1),
				locator(DOOR_PORTAL, DOOR_SECTION, TARGET_A, 2),
			],
		});
		reader = await resolvePrincipal(DOOR_READER_USER_ID);
		control = await resolvePrincipal(DOOR_CONTROL_USER_ID);
		mediaOnly = await resolvePrincipal(DOOR_MEDIA_ONLY_USER_ID);
		superuser = await resolvePrincipal(-1);
	});

	afterAll(async () => {
		try {
			await sweep();
		} finally {
			await removeReadDoorIdentityFixture();
		}
	});

	test('the contrast is live (guards every pair below)', async () => {
		expect(reader.isGlobalAdmin).toBe(false);
		expect(control.isGlobalAdmin).toBe(false);
		for (const identity of [reader, control]) {
			expect(await getPermissions(identity, DOOR_SECTION, DOOR_SECTION)).toBeGreaterThanOrEqual(1);
			expect(await getPermissions(identity, DOOR_SECTION, DOOR_RELATED)).toBe(1);
			expect(await getPermissions(identity, PROJECTS_SECTION, PROJECTS_SECTION)).toBe(0);
			// The principal-loss witness is no T row either reader may list; the
			// superuser lists it (read through the real search door).
			expect(await windowRows(identity, [TARGET_OUT_OF_PROJECT, TARGET_A])).toEqual([TARGET_A]);
		}
		expect(await windowRows(superuser, [TARGET_OUT_OF_PROJECT])).toEqual([TARGET_OUT_OF_PROJECT]);
		expect(await getPermissions(reader, DOOR_SECTION, DOOR_PORTAL)).toBe(0);
		expect(await getPermissions(control, DOOR_SECTION, DOOR_PORTAL)).toBe(1);
		expect(await getPermissions(reader, DOOR_SIBLING_SECTION, DOOR_SIBLING_SECTION)).toBe(0);
		expect(await getPermissions(control, DOOR_SIBLING_SECTION, DOOR_SIBLING_SECTION)).toBe(1);
		expect(await getPermissions(mediaOnly, DOOR_SECTION, DOOR_SECTION)).toBe(0);
		// The trigger-built index holds the situation (5 + 2 relation locators plus
		// the two sources' project locators) — the precondition of the index-
		// independence test, NOT what the census reads.
		const indexed = (await sql.unsafe(
			'SELECT count(*)::int AS n FROM matrix_relation_index WHERE section_tipo = $1 AND section_id IN ($2, $3)',
			[DOOR_SECTION, SOURCE_RELATED, SOURCE_PORTAL],
		)) as { n: number }[];
		expect(indexed[0]?.n).toBe(9);
	});

	test('grouped totals: exact per target, the dangling locator only in the bound', async () => {
		const { status, body } = await census(superuser, { source: sourceSet() });
		expect(status).toBe(200);
		expect(totals(body)).toEqual({
			[PROJECTS_SECTION]: 1,
			[DOOR_SIBLING_SECTION]: 1,
			[DOOR_SECTION]: 4,
		});
		// Ordered by tipo.
		const tipos = (body.data ?? []).map((entry) => entry.tipo);
		expect(tipos).toEqual([...tipos].sort());
		expect(body.notices).toBeUndefined();
		// The grouped upper bound counts the dangling test3 locator (5, not 4):
		// the exact answer is a real narrowing, not the same number twice.
		const bound = await countRelationTargets(sourceSet() as never, {
			principal: superuser,
			exact: false,
		});
		expect(Object.fromEntries(bound.map((entry) => [entry.tipo, entry.total]))).toEqual({
			[PROJECTS_SECTION]: 1,
			[DOOR_SIBLING_SECTION]: 1,
			[DOOR_SECTION]: 5,
		});
	});

	test('labels resolve in the request application language', async () => {
		const { body } = await census(superuser, { source: sourceSet() });
		for (const entry of body.data ?? []) {
			const expected = await labelByTipo(entry.tipo);
			expect(expected).not.toBeNull();
			expect(entry.label).toBe(expected as string);
			expect(entry.label).not.toBe(entry.tipo);
		}
		expect((body.data ?? []).length).toBe(3);
	});

	test('from_component_tipo narrows to one component’s locators', async () => {
		const portal = await census(superuser, {
			source: sourceSet({ from_component_tipo: DOOR_PORTAL }),
		});
		expect(totals(portal.body)).toEqual({ [DOOR_SECTION]: 2 });
		const related = await census(superuser, {
			source: sourceSet({ from_component_tipo: DOOR_RELATED }),
		});
		expect(totals(related.body)).toEqual({ [DOOR_SIBLING_SECTION]: 1, [DOOR_SECTION]: 3 });
	});

	test('target-grant filtering + the component key: reader vs control on one call', async () => {
		const asControl = await census(control, { source: sourceSet() });
		expect(asControl.status).toBe(200);
		// test2 readable, test80 granted → C and test2 counted; dd153 unreadable;
		// the out-of-project target is no row the control may list.
		expect(totals(asControl.body)).toEqual({ [DOOR_SIBLING_SECTION]: 1, [DOOR_SECTION]: 3 });
		const asReader = await census(reader, { source: sourceSet() });
		expect(asReader.status).toBe(200);
		// test2 unreadable → dropped although test54 is granted; test80 hidden →
		// C invisible (A still reached through test54).
		expect(totals(asReader.body)).toEqual({ [DOOR_SECTION]: 2 });
		expect(asReader.body.notices?.map((notice) => notice.code)).toContain('perm.out_of_scope');
	});

	test('PRINCIPAL-LOSS detection: the reader’s exact total < its own bound and < the superuser’s', async () => {
		// The reader's grouped bound sees the out-of-project locator (A, B,
		// out-of-project, dangling = 4): only the exact step's T records ACL —
		// which needs the principal — brings it to 2. An exact step that dropped
		// the principal from T's row set would answer 3 (A, B, out-of-project); one
		// that dropped it everywhere would answer the superuser's 4.
		const bound = await countRelationTargets(sourceSet() as never, {
			principal: reader,
			exact: false,
		});
		expect(bound.find((entry) => entry.tipo === DOOR_SECTION)?.total).toBe(4);
		const exact = await countRelationTargets(sourceSet() as never, { principal: reader });
		const readerTotal = exact.find((entry) => entry.tipo === DOOR_SECTION)?.total;
		const superTotal = (
			await countRelationTargets(sourceSet() as never, { principal: superuser })
		).find((entry) => entry.tipo === DOOR_SECTION)?.total;
		expect(readerTotal).toBe(2);
		expect(superTotal).toBe(4);
		expect(readerTotal as number).toBeLessThan(superTotal as number);
		// The reader's window lists exactly A and B (the census's number is the page's).
		expect(await windowRows(reader, undefined, sourceSet())).toEqual(sorted([TARGET_A, TARGET_B]));
	});

	test('full_count law: every census total == the opened window’s dd_core_api count, for every scope and principal', async () => {
		const scopes: Record<string, unknown>[] = [
			sourceSet(),
			sourceSet({ from_component_tipo: DOOR_PORTAL }),
			sourceSet({ from_component_tipo: DOOR_RELATED }),
		];
		let checked = 0;
		for (const principal of [superuser, control, reader]) {
			for (const source of scopes) {
				const { body } = await census(principal, { source });
				for (const entry of body.data ?? []) {
					const window = await windowCount(principal, entry.tipo, source);
					expect({ user: principal.userId, source, tipo: entry.tipo, total: window }).toEqual({
						user: principal.userId,
						source,
						tipo: entry.tipo,
						total: entry.total,
					});
					checked += 1;
				}
			}
		}
		// Not vacuous: superuser 3 + 1 + 2, control 2 + 1 + 2, reader 1 + 0 + 1.
		expect(checked).toBe(13);
	});

	test('INDEX INDEPENDENCE: the census reads stored locators — deleting the sources’ index rows changes nothing', async () => {
		const before = {
			superuser: await countRelationTargets(sourceSet() as never, { principal: superuser }),
			reader: await countRelationTargets(sourceSet() as never, { principal: reader }),
		};
		const ROLLBACK = new Error('relation_targets gate: roll the index damage back');
		let inside: typeof before | null = null;
		await assertTestDatabase('relation_targets_native index independence');
		try {
			await withTransaction(async () => {
				const removed = (await sql.unsafe(
					'DELETE FROM matrix_relation_index WHERE section_tipo = $1 AND section_id IN ($2, $3) RETURNING 1',
					[DOOR_SECTION, SOURCE_RELATED, SOURCE_PORTAL],
				)) as unknown[];
				expect(removed.length).toBe(9);
				inside = {
					superuser: await countRelationTargets(sourceSet() as never, { principal: superuser }),
					reader: await countRelationTargets(sourceSet() as never, { principal: reader }),
				};
				throw ROLLBACK;
			});
		} catch (error) {
			if (error !== ROLLBACK) throw error;
		}
		expect(inside as unknown).toEqual(before);
		expect(before.superuser.length).toBe(3);
		const restored = (await sql.unsafe(
			'SELECT count(*)::int AS n FROM matrix_relation_index WHERE section_tipo = $1 AND section_id IN ($2, $3)',
			[DOOR_SECTION, SOURCE_RELATED, SOURCE_PORTAL],
		)) as { n: number }[];
		expect(restored[0]?.n).toBe(9);
	});

	test('an explicitly hidden from_component_tipo answers no target, never an error', async () => {
		const hidden = await census(reader, {
			source: sourceSet({ from_component_tipo: DOOR_PORTAL }),
		});
		expect(hidden.status).toBe(200);
		expect(hidden.body.data).toEqual([]);
		expect(hidden.body.notices?.map((notice) => notice.code)).toContain('perm.out_of_scope');
		const granted = await census(control, {
			source: sourceSet({ from_component_tipo: DOOR_PORTAL }),
		});
		expect(totals(granted.body)).toEqual({ [DOOR_SECTION]: 2 });
	});

	test('no read on a source section → perm.denied (403)', async () => {
		const denied = await census(mediaOnly, { source: sourceSet() });
		expect(denied.status).toBe(403);
		expect(denied.body.ok).toBe(false);
		expect(denied.body.error?.code).toBe('perm.denied');
		expect(denied.body.data).toBeUndefined();
	});

	test('a malformed source section name is request.invalid_tipo, never perm.denied', async () => {
		const refused = await census(mediaOnly, { source: { section_tipo: ['not_a_tipo'] } });
		expect(refused.status).toBe(400);
		expect(refused.body.error?.code).toBe('request.invalid_tipo');
	});

	test('the envelope is strict: every malformed request is request.invalid_options', async () => {
		const malformed: { options: Record<string, unknown>; extra?: Record<string, unknown> }[] = [
			{ options: {} },
			{ options: { source: sourceSet(), limit: 10 } },
			{ options: { source: sourceSet({ limit: 10 }) } },
			{ options: { source: sourceSet({ filter_by_locators_op: 'AND' }) } },
			{ options: { source: { section_tipo: [] } } },
			{ options: { source: 'test3' } },
			{ options: { source: sourceSet(), budgetMs: 0.001 } },
			// a found set expanded to recursive children is refused BY NAME, never
			// narrowed to its matched terms (the leaf has no descendant pre-pass)
			{ options: { source: sourceSet({ children_recursive: true }) } },
			{ options: { source: sourceSet({ fixed_children_filter: { $and: [] } }) } },
			{
				options: { source: sourceSet() },
				extra: { sqo: { section_tipo: [DOOR_SECTION] } },
			},
		];
		for (const { options, extra } of malformed) {
			const refused = await census(superuser, options, extra);
			expect({ request: options, status: refused.status, code: refused.body.error?.code }).toEqual({
				request: options,
				status: 400,
				code: 'request.invalid_options',
			});
		}
	});

	test('THE BUDGET: an exhausted whole-census budget is the typed db.statement_timeout, and leaves no timeout behind', async () => {
		const ambientTimeout = await currentStatementTimeout();
		let caught: unknown;
		try {
			await countRelationTargets(sourceSet() as never, { principal: superuser, budgetMs: 0.001 });
		} catch (error) {
			caught = error;
		}
		expect((caught as { code?: string } | undefined)?.code).toBe('db.statement_timeout');
		expect((caught as { coordinates?: { door?: string } }).coordinates?.door).toBe(
			'relation_targets',
		);
		// The SET LOCAL died with the census's transaction: the pool's connections
		// are back at their own ceiling.
		expect(await currentStatementTimeout()).toBe(ambientTimeout);
		// Control: the same census under the default budget answers.
		expect(
			(await countRelationTargets(sourceSet() as never, { principal: superuser })).length,
		).toBe(3);
		// The override is validated, never silently ignored.
		for (const budgetMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			let invariant: unknown;
			try {
				await countRelationTargets(sourceSet() as never, { principal: superuser, budgetMs });
			} catch (error) {
				invariant = error;
			}
			expect({ budgetMs, code: (invariant as { code?: string } | undefined)?.code }).toEqual({
				budgetMs,
				code: 'internal.invariant',
			});
		}
	});

	test('the children_recursive refusal is NAMED (the public message says why, never just an unknown key)', async () => {
		const refused = await census(superuser, {
			source: sourceSet({ children_recursive: true }),
		});
		expect(refused.status).toBe(400);
		expect(refused.body.error?.code).toBe('request.invalid_options');
		expect(JSON.stringify(refused.body.error)).toContain('children_recursive');
	});

	test('THE BUDGET, MEASURED: a census statement the server runs past the budget is cut at the remaining ms, typed, and leaves no timeout behind', async () => {
		const key = `zzreltgt-budget-${process.pid}`;
		const ambientTimeout = await currentStatementTimeout();
		const budgetMs = 400;
		const poolCeilingMs = config.ops.dbStatementTimeoutMs;
		const effectiveMs = poolCeilingMs > 0 ? Math.min(poolCeilingMs, budgetMs) : budgetMs;
		// An IDLE holder of the flight: the census's cancel reaches no statement of
		// it, so the census's lock wait is a statement only its own SET LOCAL
		// statement_timeout can end (without it, it waits for the holder).
		const holder = await playEarlierCensus(key, false);
		const startedAt = Date.now();
		let outcome: unknown;
		try {
			outcome = await Promise.race([
				countRelationTargets(sourceSet() as never, {
					principal: superuser,
					supersessionKey: key,
					budgetMs,
				}).then(
					() => 'answered',
					(error: unknown) => error,
				),
				Bun.sleep(15_000).then(() => 'still waiting after 15s'),
			]);
		} finally {
			await holder.release();
		}
		const elapsedMs = Date.now() - startedAt;
		const error = outcome as {
			code?: string;
			coordinates?: Record<string, unknown>;
			cause?: { code?: string; coordinates?: { lane?: string; ceiling_ms?: number } };
		};
		expect(error.code).toBe('db.statement_timeout');
		expect(error.coordinates).toEqual({ door: 'relation_targets', ceiling_ms: effectiveMs });
		// The SERVER stopped it: the transaction lane typed a 57014 at the ceiling
		// the census's SET LOCAL recorded — the time LEFT, never above the budget
		// (the pre-send refusal carries no such cause).
		expect(error.cause?.code).toBe('db.statement_timeout');
		expect(error.cause?.coordinates?.lane).toBe('transaction');
		expect(error.cause?.coordinates?.ceiling_ms).toBeGreaterThan(0);
		expect(error.cause?.coordinates?.ceiling_ms).toBeLessThanOrEqual(effectiveMs);
		expect(elapsedMs).toBeLessThan(5_000);
		// The SET LOCAL died with the census's transaction: every pooled connection
		// sampled is back at its own ceiling.
		for (let sample = 0; sample < 4; sample++) {
			expect(await currentStatementTimeout()).toBe(ambientTimeout);
		}
	}, 60_000);

	/**
	 * Play an EARLIER census of flight `key` on a reserved connection: BEGIN, take
	 * the flight lock, then (when `running`) a long statement — returned only once
	 * pg_stat_activity shows it running. `settled` resolves with the statement's
	 * SQLSTATE once it ends (rolled back at once, as the census's own transaction
	 * would be); `release` rolls back whatever is left; `pid` is its backend.
	 */
	async function playEarlierCensus(key: string, running: boolean) {
		const connection = await sql.reserve();
		const [backend] = (await connection.unsafe('SELECT pg_backend_pid() AS pid')) as {
			pid: number;
		}[];
		const pid = Number(backend?.pid);
		await connection.unsafe('BEGIN');
		await connection.unsafe('SELECT pg_advisory_xact_lock($1::int, $2::int)', [
			RELATION_TARGETS_FLIGHT_LOCK_CLASS,
			relationTargetsFlightKey(key),
		]);
		let open = true;
		const rollback = async () => {
			if (!open) return;
			open = false;
			await connection.unsafe('ROLLBACK').catch(() => undefined);
			connection.release();
		};
		const settled = running
			? connection.unsafe('SELECT pg_sleep(25)').then(
					async () => {
						await rollback();
						return 'finished';
					},
					async (error: unknown) => {
						await rollback();
						return sqlStateOf(error) ?? 'untyped';
					},
				)
			: Promise.resolve('idle');
		if (running) await waitUntil(`backend ${pid} running pg_sleep`, () => backendSleeping(pid));
		return { settled, release: rollback, pid };
	}

	test('ONE CENSUS PER SESSION: a newer census cancels the session’s RUNNING earlier one and answers', async () => {
		const key = `zzreltgt-flight-running-${process.pid}`;
		const expected = await countRelationTargets(sourceSet() as never, { principal: superuser });
		const earlier = await playEarlierCensus(key, true);
		try {
			const startedAt = Date.now();
			const answer = await countRelationTargets(sourceSet() as never, {
				principal: superuser,
				supersessionKey: key,
			});
			// The earlier one was cancelled (57014), not waited for to its end.
			expect(await earlier.settled).toBe('57014');
			expect(Date.now() - startedAt).toBeLessThan(15_000);
			expect(answer).toEqual(expected);
		} finally {
			await earlier.release();
		}
		// Control: another session's key is a different flight — never cancelled.
		const other = await playEarlierCensus(`${key}-other-session`, true);
		try {
			const quick = await countRelationTargets(sourceSet() as never, {
				principal: superuser,
				supersessionKey: key,
			});
			expect(quick).toEqual(expected);
			expect(await Promise.race([other.settled, Bun.sleep(500).then(() => 'still running')])).toBe(
				'still running',
			);
		} finally {
			await other.release();
		}
	}, 60_000);

	test('ONE CENSUS PER SESSION: a census WAITING for the flight is superseded → typed 409 resource.conflict', async () => {
		const key = `zzreltgt-flight-waiting-${process.pid}`;
		// An idle holder: a cancel reaches no statement of it, so census A waits.
		const holder = await playEarlierCensus(key, false);
		let first: Promise<unknown> | undefined;
		try {
			first = countRelationTargets(sourceSet() as never, {
				principal: superuser,
				supersessionKey: key,
			}).then(
				() => 'answered',
				(error: unknown) => error,
			);
			// A is QUEUED on the flight lock (an ungranted row of another backend
			// than the holder) — measured, so B's claim really finds A to cancel.
			await waitUntil('census A queued on the flight lock', async () => {
				const [row] = (await sql.unsafe(
					"SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 " +
						'AND objid = $2 AND objsubid = 2 AND NOT granted AND pid <> $3) AS queued',
					[RELATION_TARGETS_FLIGHT_LOCK_CLASS, relationTargetsFlightKey(key), holder.pid],
				)) as { queued: boolean }[];
				return row?.queued === true;
			});
			const second = countRelationTargets(sourceSet() as never, {
				principal: superuser,
				supersessionKey: key,
			});
			const refused = (await first) as { code?: string; coordinates?: { reason?: string } };
			expect(refused.code).toBe('resource.conflict');
			expect(refused.coordinates?.reason).toBe('superseded');
			await holder.release(); // the holder ends: B takes the flight and answers
			expect((await second).length).toBe(3);
		} finally {
			await holder.release();
			await first;
		}
	}, 60_000);

	test('ONE CENSUS PER SESSION through the door: the flight is keyed by the request’s own session', async () => {
		const context = contextFor(superuser);
		const tokenHash = context.session?.tokenHash;
		expect(typeof tokenHash).toBe('string');
		const earlier = await playEarlierCensus(tokenHash as string, true);
		try {
			const result = await dispatchRqo(
				{
					dd_api: 'dd_core_api',
					action: 'relation_targets',
					options: { source: sourceSet() },
				} as unknown as Rqo,
				context,
			);
			expect(result.status).toBe(200);
			expect(await earlier.settled).toBe('57014');
		} finally {
			await earlier.release();
		}
	}, 60_000);

	test('ONE CENSUS PER SESSION stays inside THIS database: a same-key flight on another database of the cluster is neither waited for nor cancelled', async () => {
		const key = `zzreltgt-flight-foreign-db-${process.pid}`;
		const foreign = connectToDatabase('postgres');
		let pid = 0;
		let running: Promise<string> | undefined;
		try {
			await foreign.unsafe('BEGIN', []);
			await foreign.unsafe('SELECT pg_advisory_xact_lock($1::int, $2::int)', [
				RELATION_TARGETS_FLIGHT_LOCK_CLASS,
				relationTargetsFlightKey(key),
			]);
			const [backend] = (await foreign.unsafe('SELECT pg_backend_pid() AS pid', [])) as {
				pid: number;
			}[];
			pid = Number(backend?.pid);
			running = foreign.unsafe('SELECT pg_sleep(20)', []).then(
				() => 'finished',
				(error: unknown) => sqlStateOf(error) ?? 'untyped',
			);
			// Non-vacuity: the foreign holder really holds the same class + key, and runs.
			await waitUntil(`foreign backend ${pid} running pg_sleep`, () => backendSleeping(pid));
			const [held] = (await sql.unsafe(
				"SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 " +
					'AND objid = $2 AND objsubid = 2 AND granted AND pid = $3) AS held',
				[RELATION_TARGETS_FLIGHT_LOCK_CLASS, relationTargetsFlightKey(key), pid],
			)) as { held: boolean }[];
			expect(held?.held).toBe(true);
			const startedAt = Date.now();
			const answer = await countRelationTargets(sourceSet() as never, {
				principal: superuser,
				supersessionKey: key,
			});
			expect(answer.length).toBe(3);
			expect(Date.now() - startedAt).toBeLessThan(10_000);
			// Give a wrongly-sent cancel time to land before reading the survivor.
			expect(await Promise.race([running, Bun.sleep(500).then(() => 'still running')])).toBe(
				'still running',
			);
		} finally {
			if (pid > 0) await sql.unsafe('SELECT pg_cancel_backend($1)', [pid]);
			await running;
			await foreign.unsafe('ROLLBACK', []).catch(() => undefined);
			await foreign.close();
		}
	}, 60_000);

	test('THE BUDGET ORDERING: server budget + response margin < the client’s census timeout', async () => {
		const source = await Bun.file(CLIENT_CENSUS_FILE).text();
		const clientTimeoutMs = clientConstantMs(source, 'RELATION_TARGETS_TIMEOUT_MS');
		expect(RELATION_TARGETS_BUDGET_MS).toBeGreaterThan(0);
		expect(RELATION_TARGETS_RESPONSE_MARGIN_MS).toBeGreaterThan(0);
		expect(RELATION_TARGETS_BUDGET_MS + RELATION_TARGETS_RESPONSE_MARGIN_MS).toBeLessThan(
			clientTimeoutMs,
		);
		// That the constant IS the census request's transport timeout (a constant
		// nothing uses would satisfy the inequality and protect nothing) is an
		// outcome the client gate measures: test_open_related_data.js asserts the
		// timeout data_manager.request receives for every relation_targets request
		// equals this exported constant.
	});
});
