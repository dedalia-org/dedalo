/**
 * PERF-1 — THE EXPORT SELECTION IS PAGED OUT OF ONE SNAPSHOT, NEVER LOADED WHOLE.
 *
 * `openExportGrid` (src/diffusion/export/grid.ts) used to fetch the WHOLE
 * selection — every (section_tipo, section_id) of the filtered SQO — with ONE
 * `sql.unsafe` before the first line was produced, and `meta.total` was that
 * array's length. A million-record export held a million rows in the process
 * before hydrating the first one; the buffered `get_export_grid` envelope then
 * drained the whole grid into memory as well.
 *
 * THE OUTCOMES PINNED (situation `zzsc`: 25 records over two sections on ONE
 * table whose section_ids OVERLAP, an order with ties AND nulls,
 * `selectionPage` 4, `hydrateBatch` 2):
 *   1. ORDER — against ONE direct `buildSearchSql` (limit null, same principal)
 *      run through `sql.unsafe`, for the global admin AND a non-admin whose
 *      projects narrow the selection: the emitted records follow the same
 *      sort-key sequence, and each TIE GROUP holds the same set of records.
 *      A record is compared by its IDENTITY — section_id AND its own section's
 *      cell (`identityOf`: a MAIN record carries its A value, a SIDE record
 *      none), never `rec` alone: the sections share section_ids, so a walk that
 *      hydrated SIDE 900811 as MAIN 900811 (or emitted one twice and dropped
 *      the other) keeps every `rec` sequence and total, and only the cells tell
 *      (two statements may legitimately break a tie differently until the
 *      selection ORDER BY ends in `(section_tipo, section_id)` — integrator
 *      request 6a; then this leg tightens to exact order everywhere). On a
 *      TIE-FREE sort the order is exact already;
 *   2. PAGING — the selection reaches the process in pages: at least
 *      ⌈25/4⌉ selection statements, and (once the query tap records rows per
 *      statement) none of them returns more than one page;
 *   3. TOTAL — `meta.total` = the 'end' line's `records` = the records emitted;
 *   4. SNAPSHOT — a matching record inserted mid-iteration is NOT emitted and
 *      does not move the total (one snapshot, taken at open);
 *   5. RELEASE — grids returned unread (before the first pull), a consumer
 *      that THROWS mid-stream and a grid aborted mid-run give back every
 *      connection and every slot (the pool's in-use gauge and the slot gauge
 *      return to baseline; no `export.busy`, no `db.pool_exhausted`); 13 adds
 *      the paths no pull reaches: an open whose DECLARE FAILS, a consumer
 *      ABORTED while it holds control (released by the abort alone, no further
 *      pull), and a cursor NEVER pulled (the idle window is armed at open);
 *      5b — a PRODUCER that fails mid-run (a hydration statement cancelled
 *      while it waits on a table lock) releases at once in BOTH consumer shapes
 *      that never call return() on a producer error: a for-await drain (the
 *      buffered envelope's) and an NDJSON body (ndjsonStream errors the
 *      controller) — with the idle window left at its 15-minute default, so
 *      only the producer's own release can pass; 5c — a FETCH that fails (the
 *      cursor's backend terminated) releases the slot inside the cursor itself;
 *   6. ADMISSION — with every selection slot held the next REQUEST-path open
 *      is refused EAGERLY with `export.busy` (503, retryable), never queued on
 *      the pool; 6b — NO RESERVED SLOT (owner decision D4): the BACKGROUND
 *      admission may take every slot, none is kept back for the request path,
 *      which is then refused just the same; 12 — a BACKGROUND build (toolExportBuildArtifact, lane
 *      'export') is never refused for it: it waits for the slot (FIFO, the freed
 *      slot HANDED to it — never back to the free count while it waits) and
 *      completes, and a waiting build's signal ends the wait as
 *      `export.cancelled` with no job written; 12c — a queued open whose signal
 *      fired BEFORE it queued is refused at once (`export.cancelled`), never
 *      enqueued behind a held slot it would wait hours for; 14 — a process booted with
 *      DB_POOL_MAX=1 admits no cursor in EITHER admission (`export.busy` at
 *      once — a queued open never waits for a slot that cannot exist);
 *   7. BUFFERED CAP — the buffered envelope of a selection above
 *      CLIENT_MAX_LIMIT is refused with `export.format_limit` (400,
 *      `{format: 'json_envelope', limit}` — the same code the other format
 *      ceilings use) BEFORE any hydration statement; the stream form of the
 *      same SQO succeeds — and, under the same tap, DOES issue hydration
 *      statements (the positive control that keeps the empty match meaningful);
 *  16. A PRE-ABORTED OPEN (refuse admission) answers its total and releases
 *      as it returns — nothing held, no page;
 *  17. A STOP CUTS THE SELECTION WHILE IT IS BUILT — the signal that fires
 *      during the open (Stop, the lane deadline, a shutdown) is the user's
 *      `export.cancelled`, at once: 17a — fired WHILE the hold cursor's commit
 *      materializes a 3 s selection, the running statement is cancelled on the
 *      server (pg_cancel_backend, guarded by the transaction's start —
 *      postgres.ts cancelBackendStatement), so the open rejects well before the
 *      selection could finish and NO backend of this database is left running
 *      it; 17b — fired while the open still WAITS for a pooled connection, the
 *      open sends nothing once it gets one (a cancel landing between two
 *      statements reaches nothing — the abort is sticky at the open's statement
 *      door). Both give back the slot and the connection, the pool fresh;
 *      17c — the cancel is GUARDED by the transaction it was read in: once
 *      that transaction ended, a cancel naming it leaves the backend's next
 *      statement alone (a late Stop never cuts the cursor's MOVE/FETCH, nor
 *      whatever a pooled connection runs next); the same cancel inside the
 *      transaction does cut (the control);
 *  15. THE CEILING — the hold cursor's commit-time materialization runs under
 *      the connection's statement ceiling (a process booted with a 300 ms
 *      ceiling refuses a 3 s selection with `db.statement_timeout`), and every
 *      exit leaves each pooled connection fresh (no transaction, no
 *      transaction_timeout);
 *  11. PAGE SIZE — `openSelectionCursor` refuses a pageRows that is not an
 *      integer in [1, SELECTION_PAGE_ROWS_MAX] (`internal.invariant`) before
 *      any slot is taken: a page past it would bring back the whole-selection
 *      load the cursor exists to remove;
 *   8. THE TOTAL'S ONE SOURCE — the driver's MOVE command-tag count. The
 *      fact the cursor rests on is pinned on THIS driver (a raw `MOVE FORWARD
 *      ALL` answers a numeric `count` equal to the rows a FETCH then moves);
 *      there is no second counting path to keep honest (selection_cursor.ts
 *      refuses a count-less driver loudly), and the cursor's total equals the
 *      rows it serves, (section_tipo, section_id) in the one-statement order;
 *   9. IDLE IS THE CONSUMER'S — with the idle window seam-shortened
 *      (`selectionIdleMs`): an export whose consumer keeps pulling COMPLETES
 *      even when the producer's own work on a page outlasts the window (its
 *      hydration held behind a table lock for 4 windows — on the FIRST chunk
 *      after a page pull AND on a LATER chunk of the same page, which no page
 *      pull precedes: 19 of every 20 production chunks) and when the whole run
 *      does (a consumer pausing 40 ms per line under a 200 ms window); a consumer that
 *      holds control past the window is closed out — its slot and connection
 *      come back, and its next pull throws `export.consumer_idle`, never
 *      `export.cancelled` (a stalled reader is not the user's Stop);
 *  10. CANCEL AWAITS RELEASE — a cancelled NDJSON body resolves only once the
 *      cursor's slot is back (no window in which a cancelled stream still holds
 *      a pooled connection), and the pull in flight at cancel settles silently
 *      (no "ndjson stream aborted" log — a reader that left is not an abort);
 *      10b drives that deterministically on ndjsonStream itself (the held
 *      next() settles after cancel with a line, then with the end).
 *
 * Runs as an ISOLATED GATE (test/helpers/isolated_gate.ts ISOLATED_GATE_ENV):
 * the child boots with DB_POOL_MAX=4 (⇒ max(1, floor(4/4)) = 1 selection slot)
 * and DEDALO_SEARCH_CLIENT_MAX_LIMIT=3, both read once at module load.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isIsolatedGateChild, mirrorIsolatedGate } from '../helpers/isolated_gate.ts';

// ISOLATED GATE (test/helpers/isolated_gate.ts): this file needs CONFIG values
// pinned at boot (ISOLATED_GATE_ENV) — in the tier's process it only MIRRORS a
// child run of itself; its body below registers in that child alone.
if (!isIsolatedGateChild(import.meta.path)) mirrorIsolatedGate(import.meta.path);
else {
	const { config } = await import('../../src/config/config.ts');
	const { CLIENT_MAX_LIMIT, sanitizeClientSqo } = await import('../../src/core/concepts/sqo.ts');
	const { getPoolStats, sql, withTransaction } = await import('../../src/core/db/postgres.ts');
	const { runWithQueryTap } = await import('../../src/core/db/query_tap.ts');
	const { DedaloError } = await import('../../src/core/errors/index.ts');
	const { buildSearchSql } = await import('../../src/core/search/sql_assembler.ts');
	const { createSearchStatement, searchStatementText } = await import(
		'../../src/core/search/search_statement.ts'
	);
	/** A probe selection (no referenced_by leaf) as the cursor's input type. */
	const probe = (text: string, params: unknown[] = []) =>
		createSearchStatement(text, params, false);
	const { resolvePrincipal } = await import('../../src/core/security/permissions.ts');
	const { dropSituation, ensureSituation, situation } = await import(
		'../../src/core/test_data/situations/situation.ts'
	);
	const { exportGridUnified, openExportGrid } = await import('../../src/diffusion/export/index.ts');
	const { ndjsonStream } = await import('../../src/diffusion/export/ndjson_stream.ts');
	const { toolExportBuildArtifact } = await import('../../tools/tool_export/server/export_job.ts');
	const { openArtifactStore } = await import('../../tools/tool_export/server/artifact_store.ts');
	const { readdirSync, rmdirSync } = await import('node:fs');
	const { join } = await import('node:path');
	// The cursor module is the fix's own file: loaded tolerantly, so a tree
	// without it reddens the legs that need it (never the whole file, setup).
	type CursorModule = typeof import('../../src/diffusion/export/selection_cursor.ts');
	const cursorModule = (await import('../../src/diffusion/export/selection_cursor.ts').catch(
		() => ({}),
	)) as Partial<CursorModule>;
	const exportSelectionSlots = (): { slots: number; inUse: number; waiting: number } =>
		cursorModule.exportSelectionSlots?.() ?? {
			slots: Number.NaN,
			inUse: Number.NaN,
			waiting: Number.NaN,
		};
	const openSelectionCursor = ((...args: Parameters<CursorModule['openSelectionCursor']>) => {
		if (cursorModule.openSelectionCursor === undefined) {
			throw new Error('src/diffusion/export/selection_cursor.ts: openSelectionCursor is missing');
		}
		return cursorModule.openSelectionCursor(...args);
	}) as CursorModule['openSelectionCursor'];
	const { ensureSuiteProjectsFixture, removeSuiteProjectsFixture, SUITE_SECOND_PROJECT_ID } =
		await import('../../src/core/test_data/projects_fixture.ts');
	const {
		ACL_NON_ADMIN_PROFILE_ID,
		ACL_NON_ADMIN_USER_ID,
		ACL_PROJECT_ID,
		clearAclIdentityCaches,
		installAclIdentityFixture,
		removeAclIdentityFixture,
	} = await import('../helpers/acl_identity_fixture.ts');
	const { DB_READY } = await import('../helpers/db_ready.ts');
	type Principal = Awaited<ReturnType<typeof resolvePrincipal>>;

	/** The pinned boot values (ISOLATED_GATE_ENV). */
	const POOL_MAX = 4;
	const CEILING = 3;
	/** The admission bound the design derives: max(1, floor(DB_POOL_MAX / 4)). */
	const SLOTS = Math.max(1, Math.floor(POOL_MAX / 4));
	const SELECTION_PAGE = 4;
	const HYDRATE_BATCH = 2;

	const MAIN = 'zzsc1';
	const SIDE = 'zzsc4';
	const A = 'zzsc2';
	const B = 'zzsc3';
	const FILTER = 'zzsc9';
	const MAIN_IDS = Array.from({ length: 15 }, (_, i) => 900811 + i);
	// OVERLAPPING ids: the side section reuses ten of the main section's
	// section_ids on the SAME table — a selection keyed by section_id alone
	// would conflate them.
	const SIDE_IDS = MAIN_IDS.slice(0, 10);
	const TOTAL = MAIN_IDS.length + SIDE_IDS.length;
	/** Inserted mid-iteration by the snapshot leg (swept with the situation). */
	const LATE_ID = 900850;

	const A_VALUES = ['b', 'a', 'c', null];
	const literal = (value: string) => [{ id: 1, lang: 'lg-nolan', value }];

	const S = situation({
		name: 'zzsc export selection cursor',
		tld: 'zzsc',
		nodes: [
			{
				tipo: MAIN,
				parent: 'test1',
				model: 'section',
				term: { 'lg-spa': 'Selección principal', 'lg-eng': 'Selection main' },
				relations: [{ tipo: 'test24' }],
			},
			{ tipo: A, parent: MAIN, model: 'component_input_text', term: { 'lg-eng': 'A' } },
			{
				tipo: B,
				parent: MAIN,
				model: 'component_input_text',
				order_number: 2,
				term: { 'lg-eng': 'B' },
			},
			{
				tipo: FILTER,
				parent: MAIN,
				model: 'component_filter',
				order_number: 3,
				term: { 'lg-eng': 'Projects' },
				relations: [{ tipo: 'dd153' }],
			},
			{
				tipo: SIDE,
				parent: 'test1',
				model: 'section',
				term: { 'lg-spa': 'Selección lateral', 'lg-eng': 'Selection side' },
				relations: [{ tipo: 'test24' }],
			},
			{ tipo: 'zzsc5', parent: SIDE, model: 'component_input_text', term: { 'lg-eng': 'Side' } },
		],
		records: [
			...MAIN_IDS.map((id, i) => {
				const a = A_VALUES[i % A_VALUES.length] ?? null;
				const string: Record<string, unknown> = { [B]: literal(String((i * 7) % 5)) };
				if (a !== null) string[A] = literal(a);
				return {
					section_tipo: MAIN,
					section_id: id,
					columns: {
						string,
						relation: {
							[FILTER]: [
								{
									id: 1,
									type: 'dd151',
									section_tipo: 'dd153',
									section_id: i % 2 === 0 ? ACL_PROJECT_ID : SUITE_SECOND_PROJECT_ID,
									from_component_tipo: FILTER,
								},
							],
						},
					},
				};
			}),
			...SIDE_IDS.map((id) => ({
				section_tipo: SIDE,
				section_id: id,
				columns: { string: { zzsc5: literal(`side ${id}`) } },
			})),
		],
	});

	const SQO = {
		section_tipo: [MAIN, SIDE],
		offset: 0,
		order: [
			{ direction: 'DESC', path: [{ section_tipo: MAIN, component_tipo: A }] },
			{ direction: 'ASC', path: [{ section_tipo: MAIN, component_tipo: B }] },
		],
	};

	const exportOptions = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
		section_tipo: MAIN,
		model: 'section',
		data_format: 'value',
		breakdown: 'default',
		lang: 'lg-eng',
		ar_ddo_to_export: [{ path: [{ section_tipo: MAIN, component_tipo: A, name: A }] }],
		sqo: structuredClone(SQO),
		...extra,
	});

	const runOptions = (extra: Record<string, unknown> = {}) =>
		({ hydrateBatch: HYDRATE_BATCH, selectionPage: SELECTION_PAGE, ...extra }) as never;

	type Line = Record<string, unknown>;

	async function drain(lines: AsyncGenerator<Line>): Promise<Line[]> {
		const out: Line[] = [];
		for await (const line of lines) out.push(line);
		return out;
	}

	/** A row line's cell values, joined (the export has one column: A). */
	function cellText(line: Line): string {
		const cells = line.c;
		const values =
			cells === null || typeof cells !== 'object' ? [] : Object.values(cells as object);
		return values
			.map((value) => (value === null || value === undefined ? '' : String(value)))
			.filter((value) => value !== '')
			.join(',');
	}

	/**
	 * Emitted record IDENTITIES, in order: `<section_id>|<its cells>`, one per
	 * record, at its FIRST row line (`sub: 0`). Never "a change of `rec`": two
	 * sections share section_ids here, and two adjacent records with the same id
	 * are two records. The cells carry the SECTION (identityOf): a MAIN record
	 * shows its A value, a SIDE record (no A) none.
	 */
	function emittedRecords(lines: Line[]): string[] {
		const seen: string[] = [];
		for (const line of lines) {
			if (line.t === 'row' && line.sub === 0) seen.push(`${String(line.rec)}|${cellText(line)}`);
		}
		return seen;
	}

	/** One selected record, as the direct statement names it. */
	type Selected = { tipo: string; id: string };

	/**
	 * The identity a record of the situation MUST be emitted with (the shape of
	 * emittedRecords): its id and its OWN section's cell — the A value this
	 * file wrote for a MAIN record, nothing for a SIDE record.
	 */
	function identityOf(record: Selected): string {
		if (record.tipo === SIDE) return `${record.id}|`;
		const index = MAIN_IDS.indexOf(Number(record.id));
		return `${record.id}|${A_VALUES[index % A_VALUES.length] ?? ''}`;
	}

	/** The sort key the SQO orders by, from the situation's own values. */
	function sortKey(record: Selected): string {
		if (record.tipo === SIDE) return JSON.stringify([null, null]);
		const index = MAIN_IDS.indexOf(Number(record.id));
		const a = A_VALUES[index % A_VALUES.length] ?? null;
		return JSON.stringify([a, String((index * 7) % 5)]);
	}

	/** True when the reference is sorted by the key model: each key is ONE run. */
	function groupedByKey(records: Selected[]): boolean {
		const keys = tieGroups(records).map((group) => group.key);
		return new Set(keys).size === keys.length;
	}

	/**
	 * Maximal runs of equal ORDER key (`orderKey`, default the SQO's sortKey), in
	 * order; members named by `name` (default identityOf).
	 */
	function tieGroups(
		records: Selected[],
		name: (record: Selected) => string = identityOf,
		orderKey: (record: Selected) => string = sortKey,
	): { key: string; ids: string[] }[] {
		const groups: { key: string; ids: string[] }[] = [];
		for (const record of records) {
			const key = orderKey(record);
			const last = groups[groups.length - 1];
			if (last !== undefined && last.key === key) last.ids.push(name(record));
			else groups.push({ key, ids: [name(record)] });
		}
		return groups;
	}

	/**
	 * THE ORDER LAW against the reference: the emitted records (by identity —
	 * `name`, identityOf for grid lines) consumed group by group must hold, in
	 * each group, exactly that group's members. Returns the first violation, or
	 * null.
	 */
	function orderViolation(
		emitted: string[],
		reference: Selected[],
		name: (record: Selected) => string = identityOf,
		orderKey: (record: Selected) => string = sortKey,
	): string | null {
		const groups = tieGroups(reference, name, orderKey);
		if (emitted.length !== reference.length) {
			return `emitted ${emitted.length} records, reference ${reference.length}`;
		}
		let position = 0;
		for (const group of groups) {
			const chunk = emitted.slice(position, position + group.ids.length);
			position += group.ids.length;
			const sortIds = (ids: string[]) => [...ids].sort();
			if (JSON.stringify(sortIds(chunk)) !== JSON.stringify(sortIds(group.ids))) {
				return `tie group ${group.key}: emitted [${chunk.join(',')}], reference [${group.ids.join(',')}]`;
			}
		}
		return null;
	}

	/** The selection as ONE direct statement — the order law's reference. */
	async function directSelection(
		principal: Principal,
		sqoTemplate: Record<string, unknown> = SQO,
	): Promise<Selected[]> {
		const sqo = sanitizeClientSqo(structuredClone(sqoTemplate));
		sqo.limit = null as unknown as number;
		sqo.offset = 0;
		const { sql: text, params } = searchStatementText(
			await buildSearchSql(sqo, {
				principal: principal.isGlobalAdmin ? undefined : principal,
				idsOnly: true,
			}),
		);
		const rows = (await sql.unsafe(text, params as (string | number | null)[])) as {
			section_id: number;
			section_tipo: string;
		}[];
		return rows.map((row) => ({ tipo: String(row.section_tipo), id: String(row.section_id) }));
	}

	/** A TIE-FREE sort: one section, the default (section_id) order. */
	const TIE_FREE_SQO = { section_tipo: [MAIN], offset: 0 };

	const jobContext = (principal: Principal, options: Record<string, unknown>) => ({
		principal,
		options,
		applicationLang: config.menu.applicationLang,
	});

	/** Statements whose FIRST caller frame is the export subsystem (the selection). */
	function exportStatements(report: {
		callers: { frames: string; count: number; maxRows?: number }[];
	}): { count: number; maxRows: number | undefined } {
		let count = 0;
		let maxRows: number | undefined;
		for (const caller of report.callers) {
			const first = caller.frames.split(' <- ')[0] ?? '';
			if (!first.includes('src/diffusion/export/')) continue;
			count += caller.count;
			if (typeof caller.maxRows === 'number') maxRows = Math.max(maxRows ?? 0, caller.maxRows);
		}
		return { count, maxRows };
	}

	/** Grant the fixture reader read on the zzsc sections + components (restored by the fixture sweep). */
	async function grantReader(): Promise<void> {
		const grants = [
			{ tipo: MAIN, section_tipo: MAIN },
			{ tipo: A, section_tipo: MAIN },
			{ tipo: B, section_tipo: MAIN },
			{ tipo: FILTER, section_tipo: MAIN },
			{ tipo: SIDE, section_tipo: SIDE },
			{ tipo: 'zzsc5', section_tipo: SIDE },
		].map((grant, index) => ({ id: 100 + index, ...grant, value: 1 }));
		await sql.unsafe(
			`UPDATE matrix_profiles
			    SET misc = jsonb_set(misc, '{dd774}', (misc->'dd774') || $1::text::jsonb)
			  WHERE section_tipo = 'dd234' AND section_id = $2`,
			[JSON.stringify(grants), ACL_NON_ADMIN_PROFILE_ID],
		);
		clearAclIdentityCaches();
	}

	describe.if(DB_READY)('PERF-1 — export selection cursor', () => {
		let admin!: Principal;
		let reader!: Principal;

		beforeAll(async () => {
			await installAclIdentityFixture();
			await ensureSuiteProjectsFixture();
			await ensureSituation(S);
			await grantReader();
			admin = await resolvePrincipal(-1);
			reader = await resolvePrincipal(ACL_NON_ADMIN_USER_ID);
		});

		afterAll(async () => {
			expect(await dropSituation(S)).toBe(0);
			await removeSuiteProjectsFixture();
			await removeAclIdentityFixture();
		});

		test('the child runs with the pinned pool and ceiling', () => {
			expect(config.ops.dbPoolMax).toBe(POOL_MAX);
			expect(getPoolStats().max).toBe(POOL_MAX);
			expect(CLIENT_MAX_LIMIT).toBe(CEILING);
			expect(TOTAL).toBeGreaterThan(SELECTION_PAGE * 2);
		});

		test('1. order: the one-statement key order, the same set per tie group (admin and narrowed non-admin)', async () => {
			const adminDirect = await directSelection(admin);
			expect(adminDirect.length).toBe(TOTAL);
			// Non-degeneracy: the reference really is the SQO's key order (the key
			// model is right), and the sort really has ties AND the side group.
			expect(groupedByKey(adminDirect)).toBe(true);
			expect(tieGroups(adminDirect).some((group) => group.ids.length > 1)).toBe(true);
			// The identity really tells the sections apart: an overlapping id with
			// an A value is two different identities in MAIN and SIDE.
			expect(identityOf({ tipo: MAIN, id: '900811' })).not.toBe(
				identityOf({ tipo: SIDE, id: '900811' }),
			);
			const adminGrid = await openExportGrid(jobContext(admin, exportOptions()), runOptions());
			expect(orderViolation(emittedRecords(await drain(adminGrid.lines)), adminDirect)).toBeNull();

			// The reader is compared to ITS one-statement reference, run by run.
			// Measured 2026-10-11: for this non-admin the direct selection is NOT in
			// the SQO's key order — it comes back in section_id order (the sort entry
			// is dropped for the principal; most likely the SEC-1 root-order-step
			// refusal, the path naming a MAIN component over a two-section
			// selection). So `groupedByKey` is asserted for the admin only, and the
			// reader's tie groups are its ACTUAL order key, section_id: MAIN and SIDE
			// records sharing an id are tied there, and two statements may break that
			// tie differently (seen once the identities, not bare ids, are compared).
			const readerDirect = await directSelection(reader);
			// Non-degenerate narrowing: the reader sees some, not all.
			expect(readerDirect.length).toBeGreaterThan(SIDE_IDS.length);
			expect(readerDirect.length).toBeLessThan(TOTAL);
			const readerGrid = await openExportGrid(jobContext(reader, exportOptions()), runOptions());
			expect(
				orderViolation(
					emittedRecords(await drain(readerGrid.lines)),
					readerDirect,
					identityOf,
					(record) => record.id,
				),
			).toBeNull();
			// The reference really IS section_id order (else this grouping is wrong).
			const readerIds = readerDirect.map((record) => Number(record.id));
			expect(readerIds).toEqual([...readerIds].sort((a, b) => a - b));
		});

		test('1b. order: on a tie-free sort the emitted order is EXACTLY the one-statement order', async () => {
			const direct = (await directSelection(admin, TIE_FREE_SQO)).map(identityOf);
			expect(direct.length).toBe(MAIN_IDS.length);
			const grid = await openExportGrid(
				jobContext(admin, exportOptions({ sqo: structuredClone(TIE_FREE_SQO) })),
				runOptions(),
			);
			expect(emittedRecords(await drain(grid.lines))).toEqual(direct);
		});

		test('2. paging: the selection arrives in pages, never as one statement', async () => {
			const { result, report } = await runWithQueryTap('export selection paging', async () => {
				const grid = await openExportGrid(jobContext(admin, exportOptions()), runOptions());
				return drain(grid.lines);
			});
			expect(emittedRecords(result).length).toBe(TOTAL);
			const selection = exportStatements(report);
			expect(selection.count).toBeGreaterThanOrEqual(Math.ceil(TOTAL / SELECTION_PAGE));
			// Rows per statement come from the query tap (integrator request 5).
			expect(selection.maxRows).toBeDefined();
			expect(selection.maxRows as number).toBeLessThanOrEqual(SELECTION_PAGE);
		});

		test('3. total: meta.total = end.records = the records emitted', async () => {
			const grid = await openExportGrid(jobContext(admin, exportOptions()), runOptions());
			const lines = await drain(grid.lines);
			const end = lines[lines.length - 1] as Line;
			expect(end.t).toBe('end');
			expect(grid.meta.total).toBe(TOTAL);
			expect(end.records).toBe(TOTAL);
			expect(emittedRecords(lines).length).toBe(TOTAL);
		});

		test('4. snapshot: a record inserted mid-iteration is neither emitted nor counted', async () => {
			const grid = await openExportGrid(jobContext(admin, exportOptions()), runOptions());
			const lines: Line[] = [];
			let inserted = false;
			try {
				for await (const line of grid.lines) {
					lines.push(line);
					if (!inserted && line.t === 'row') {
						inserted = true;
						await sql.unsafe(
							`INSERT INTO matrix_test (section_tipo, section_id, string) VALUES ($1, $2, $3::text::jsonb)`,
							[MAIN, LATE_ID, JSON.stringify({ [A]: literal('z') })],
						);
					}
				}
			} finally {
				await sql.unsafe('DELETE FROM matrix_test WHERE section_tipo = $1 AND section_id = $2', [
					MAIN,
					LATE_ID,
				]);
			}
			expect(inserted).toBe(true);
			expect(emittedRecords(lines).filter((id) => id.startsWith(`${LATE_ID}|`))).toEqual([]);
			expect(emittedRecords(lines).length).toBe(TOTAL);
			expect(grid.meta.total).toBe(TOTAL);
		});

		test('5. release: unread and aborted grids give every connection back', async () => {
			const baseline = getPoolStats().inUse;
			for (let i = 0; i < SLOTS + 1; i++) {
				const grid = await openExportGrid(jobContext(admin, exportOptions()), runOptions());
				await grid.lines.return(undefined);
			}
			const controller = new AbortController();
			const aborted = await openExportGrid(
				jobContext(admin, exportOptions()),
				runOptions({ signal: controller.signal }),
			);
			let rows = 0;
			for await (const line of aborted.lines) {
				if (line.t === 'row' && ++rows === 3) controller.abort();
			}
			expect(rows).toBeGreaterThanOrEqual(3);
			// A consumer that THROWS mid-stream (for-await calls return()).
			const thrown = await openExportGrid(jobContext(admin, exportOptions()), runOptions());
			let consumerError: unknown = null;
			try {
				for await (const line of thrown.lines) {
					if (line.t === 'row') throw new Error('consumer failed mid-stream');
				}
			} catch (error) {
				consumerError = error;
			}
			expect(String((consumerError as Error | null)?.message)).toBe('consumer failed mid-stream');
			expect(exportSelectionSlots().inUse).toBe(0);
			// One more open after all of the above: a leaked slot would refuse it.
			const after = await openExportGrid(jobContext(admin, exportOptions()), runOptions());
			expect(emittedRecords(await drain(after.lines)).length).toBe(TOTAL);
			await sql`SELECT 1`;
			expect(getPoolStats().inUse).toBe(baseline);
			expect(exportSelectionSlots().inUse).toBe(0);
		});

		/**
		 * Hold matrix_test under ACCESS EXCLUSIVE on another connection, CANCEL the
		 * statement that queues behind it (the export's hydration — nothing else
		 * runs in this child), then release. Resolves with how many were cancelled.
		 */
		function failNextHydration(): { locked: Promise<void>; done: Promise<number> } {
			let signalLocked: () => void = () => {};
			const locked = new Promise<void>((resolve) => {
				signalLocked = resolve;
			});
			const done = withTransaction(async () => {
				await sql.unsafe('LOCK TABLE matrix_test IN ACCESS EXCLUSIVE MODE', []);
				signalLocked();
				const deadline = performance.now() + 10_000;
				for (;;) {
					const cancelled = (await sql.unsafe(
						`SELECT pg_cancel_backend(l.pid) AS cancelled
						   FROM pg_locks l
						   JOIN pg_class c ON c.oid = l.relation
						  WHERE c.relname = 'matrix_test' AND NOT l.granted
						    AND l.pid <> pg_backend_pid()
						    AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
					)) as { cancelled: boolean }[];
					if (cancelled.length > 0) return cancelled.length;
					if (performance.now() > deadline) throw new Error('no statement queued behind the lock');
					await Bun.sleep(5);
				}
			});
			return { locked, done };
		}

		test('5b. release on a PRODUCER failure: a for-await drain and an NDJSON body, no return(), give everything back at once', async () => {
			const baseline = getPoolStats().inUse;
			// (a) The buffered envelope's consumer shape: a for-await drain. When
			// next() THROWS, for-await does not call return() — only the producer's
			// own release can free the cursor (the idle window is the default 15 min).
			{
				const grid = await openExportGrid(jobContext(admin, exportOptions()), runOptions());
				const fault = failNextHydration();
				await fault.locked;
				let failure: unknown = null;
				let inUseAtFailure = Number.NaN;
				try {
					for await (const _line of grid.lines) {
						// drain
					}
				} catch (error) {
					failure = error;
					inUseAtFailure = exportSelectionSlots().inUse;
				}
				expect(await fault.done).toBeGreaterThan(0);
				expect(failure).not.toBeNull();
				expect(inUseAtFailure).toBe(0);
			}
			// (b) The NDJSON body: ndjsonStream errors the controller, never return().
			{
				const grid = await openExportGrid(jobContext(admin, exportOptions()), runOptions());
				const fault = failNextHydration();
				await fault.locked;
				const reader = ndjsonStream(grid.lines, 'leg5b').getReader();
				const consoleError = console.error;
				console.error = () => {};
				let failure: unknown = null;
				let inUseAtFailure = Number.NaN;
				try {
					for (;;) {
						const chunk = await reader.read();
						if (chunk.done === true) break;
					}
				} catch (error) {
					failure = error;
					inUseAtFailure = exportSelectionSlots().inUse;
				} finally {
					console.error = consoleError;
				}
				expect(await fault.done).toBeGreaterThan(0);
				expect(failure).not.toBeNull();
				expect(inUseAtFailure).toBe(0);
			}
			await sql`SELECT 1`;
			expect(getPoolStats().inUse).toBe(baseline);
			expect(exportSelectionSlots().inUse).toBe(0);
		});

		test('5c. a FETCH that fails releases the slot inside the cursor itself (no close() from the caller)', async () => {
			const baseline = getPoolStats().inUse;
			const sqo = sanitizeClientSqo(structuredClone(SQO));
			sqo.limit = null as unknown as number;
			sqo.offset = 0;
			const built = await buildSearchSql(sqo, { idsOnly: true });
			const cursor = await openSelectionCursor<{ section_id: number; section_tipo: string }>(
				built,
				{ pageRows: SELECTION_PAGE },
			);
			const first = await cursor.pages.next();
			expect(first.done).toBe(false);
			// Terminate the cursor's own backend: its last statement was that FETCH.
			const terminated = (await sql.unsafe(
				`SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
				  WHERE datname = current_database() AND pid <> pg_backend_pid()
				    AND query LIKE 'FETCH FORWARD % FROM export_sel_%'`,
			)) as { terminated: boolean }[];
			expect(terminated.length).toBe(1);
			let failure: unknown = null;
			let inUseAtFailure = Number.NaN;
			try {
				await cursor.pages.next();
			} catch (error) {
				failure = error;
				inUseAtFailure = exportSelectionSlots().inUse;
			}
			expect(failure).not.toBeNull();
			expect(inUseAtFailure).toBe(0);
			await cursor.close();
			await sql`SELECT 1`;
			expect(getPoolStats().inUse).toBe(baseline);
		});

		test('6. admission: with every selection slot held, the next open is refused eagerly (export.busy)', async () => {
			const held: Awaited<ReturnType<typeof openExportGrid>>[] = [];
			try {
				for (let i = 0; i < SLOTS; i++) {
					held.push(await openExportGrid(jobContext(admin, exportOptions()), runOptions()));
				}
				let refusal: unknown = null;
				try {
					const extra = await openExportGrid(jobContext(admin, exportOptions()), runOptions());
					await extra.lines.return(undefined);
				} catch (error) {
					refusal = error;
				}
				expect(refusal).toBeInstanceOf(DedaloError);
				expect((refusal as { code?: string }).code).toBe('export.busy');
				expect((refusal as InstanceType<typeof DedaloError>).spec.status).toBe(503);
				expect((refusal as InstanceType<typeof DedaloError>).spec.retryable).toBe(true);
			} finally {
				for (const grid of held) await grid.lines.return(undefined);
			}
		});

		test('6b. NO RESERVED SLOT (D4): background cursors may take EVERY slot; a request-path open is then refused (export.busy)', async () => {
			// The owner decision (2026-10-21): one shared pool, no slot reserved for
			// either lane. Leg 6 holds every slot from the REQUEST path and leg 12 shows
			// the background lane then waits; here the BACKGROUND admission takes them
			// all — none is kept back for the request path — and the request path is
			// refused eagerly, exactly as when it holds them itself.
			const sqo = sanitizeClientSqo(structuredClone(SQO));
			sqo.limit = null as unknown as number;
			sqo.offset = 0;
			const built = await buildSearchSql(sqo, { idsOnly: true });
			const held: { close(): Promise<void> }[] = [];
			try {
				for (let i = 0; i < SLOTS; i++) {
					// Bounded: a slot kept back from the background lane would leave
					// this open waiting for a slot that never frees.
					const open = openSelectionCursor(built, {
						pageRows: SELECTION_PAGE,
						admission: 'queue',
					});
					const outcome = await Promise.race([open, Bun.sleep(2_000).then(() => null)]);
					if (outcome === null) {
						void open.then((cursor) => cursor.close()).catch(() => undefined);
						throw new Error(
							`background open ${i + 1}/${SLOTS} was kept waiting: a slot is reserved`,
						);
					}
					held.push(outcome);
				}
				expect(exportSelectionSlots()).toEqual({ slots: SLOTS, inUse: SLOTS, waiting: 0 });
				let refusal: unknown = null;
				try {
					const extra = await openExportGrid(jobContext(admin, exportOptions()), runOptions());
					await extra.lines.return(undefined);
				} catch (error) {
					refusal = error;
				}
				expect((refusal as { code?: string } | null)?.code).toBe('export.busy');
			} finally {
				for (const cursor of held) await cursor.close();
			}
			expect(exportSelectionSlots()).toEqual({ slots: SLOTS, inUse: 0, waiting: 0 });
		});

		test('11. page size: a pageRows outside [1, the grid page] is internal.invariant before any slot is taken', async () => {
			const sqo = sanitizeClientSqo(structuredClone(SQO));
			sqo.limit = null as unknown as number;
			sqo.offset = 0;
			const built = await buildSearchSql(sqo, { idsOnly: true });
			const seen: Record<string, string> = {};
			const max = cursorModule.SELECTION_PAGE_ROWS_MAX ?? Number.NaN;
			expect(Number.isSafeInteger(max)).toBe(true);
			// Control: the bound itself is admitted.
			const atMax = await openSelectionCursor(built, { pageRows: max });
			await atMax.close();
			for (const pageRows of [0, -1, 1.5, Number.NaN, max + 1, 1e9]) {
				try {
					const cursor = await openSelectionCursor(built, { pageRows });
					await cursor.close();
					seen[String(pageRows)] = 'admitted';
				} catch (error) {
					seen[String(pageRows)] = String((error as { code?: string }).code ?? 'raw');
				}
			}
			expect(seen).toEqual({
				'0': 'internal.invariant',
				'-1': 'internal.invariant',
				'1.5': 'internal.invariant',
				NaN: 'internal.invariant',
				[String(max + 1)]: 'internal.invariant',
				'1000000000': 'internal.invariant',
			});
			expect(exportSelectionSlots().inUse).toBe(0);
		});

		test('7. buffered cap: above the ceiling the envelope is refused before any hydration; the stream serves', async () => {
			const toolContext = (options: Record<string, unknown>) =>
				({ principal: admin, userId: -1, options, background: false }) as never;
			const { result, report } = await runWithQueryTap('export buffered cap', async () => {
				try {
					await exportGridUnified(toolContext(exportOptions()));
					return null;
				} catch (error) {
					return error;
				}
			});
			expect(result).toBeInstanceOf(DedaloError);
			expect((result as { code?: string }).code).toBe('export.format_limit');
			expect((result as InstanceType<typeof DedaloError>).spec.status).toBe(400);
			expect((result as InstanceType<typeof DedaloError>).spec.retryable).toBe(false);
			expect((result as { details?: Record<string, unknown> }).details).toEqual({
				format: 'json_envelope',
				limit: CEILING,
			});
			const hydration = report.callers.filter((caller) =>
				caller.frames.includes('src/diffusion/resolve/'),
			);
			expect(hydration).toEqual([]);

			// POSITIVE CONTROL under the SAME tap and the SAME filter: the stream
			// form does hydrate, and the filter sees it — so the empty match above
			// is "no hydration", never "a filter that matches nothing" (a renamed
			// hydration path, or caller frames that stop reaching it).
			const served = await runWithQueryTap('export buffered cap control', async () => {
				const streamed = await exportGridUnified(
					toolContext(exportOptions({ ndjson_stream: true })),
				);
				return new Response(
					(streamed as { stream?: ReadableStream<Uint8Array> })
						.stream as ReadableStream<Uint8Array>,
				).text();
			});
			const lines = served.result
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line) as Line);
			expect(emittedRecords(lines).length).toBe(TOTAL);
			const controlHydration = served.report.callers.filter((caller) =>
				caller.frames.includes('src/diffusion/resolve/'),
			);
			expect(controlHydration.length).toBeGreaterThan(0);
		});

		test('9a. idle: the producer work never counts — a page hydration stalled past the window completes', async () => {
			// The producer is made SLOW deterministically: after the selection is
			// materialized (open), another connection holds ACCESS EXCLUSIVE on the
			// records' table for 4 windows, so the next page's hydration waits on
			// it. The consumer pulls at once every time: only the producer's time
			// exceeds the window.
			// The window must exceed the CONSUMER's own setup between the meta pull
			// and the drain (taking the table lock below — measured past 100 ms on a
			// loaded runner), or the leg times the test, not the engine.
			const windowMs = 400;
			const grid = await openExportGrid(
				jobContext(admin, exportOptions()),
				runOptions({ selectionIdleMs: windowMs }),
			);
			const lines: Line[] = [(await grid.lines.next()).value as Line];
			expect(lines[0]?.t).toBe('meta');
			let signalLocked: () => void = () => {};
			const locked = new Promise<void>((resolve) => {
				signalLocked = resolve;
			});
			const released = withTransaction(async () => {
				await sql.unsafe('LOCK TABLE matrix_test IN ACCESS EXCLUSIVE MODE', []);
				signalLocked();
				await Bun.sleep(windowMs * 4);
			});
			await locked;
			// The setup stayed inside the window: the cursor is still open.
			expect(exportSelectionSlots().inUse).toBe(1);
			const started = performance.now();
			try {
				lines.push(...(await drain(grid.lines)));
			} finally {
				await released;
			}
			// Non-degeneracy: the producer really waited past the window.
			expect(performance.now() - started).toBeGreaterThan(windowMs * 2);
			expect(emittedRecords(lines).length).toBe(TOTAL);
			expect(exportSelectionSlots().inUse).toBe(0);
		});

		test('9a2. idle: a LATER chunk of a page (no page pull before it) stalled past the window completes', async () => {
			// Production cuts a 10,000-row page into 20 chunks of 500: only the
			// first follows a page pull (which stops the window by itself). This
			// leg stalls the SECOND chunk of a page — selectionPage 4, hydrateBatch
			// 2: chunk 2 is cut from the page already fetched, so only the grid's
			// own stop while the producer works (closingLines) can hold the window.
			const windowMs = 400;
			const grid = await openExportGrid(
				jobContext(admin, exportOptions()),
				runOptions({ selectionIdleMs: windowMs }),
			);
			const lines: Line[] = [];
			// Consume chunk 1 (meta + the first HYDRATE_BATCH records' lines) — no further.
			while (emittedRecords(lines).length < HYDRATE_BATCH) {
				const next = await grid.lines.next();
				expect(next.done).toBe(false);
				lines.push(next.value as Line);
			}
			expect(HYDRATE_BATCH).toBeLessThan(SELECTION_PAGE);
			let signalLocked: () => void = () => {};
			const locked = new Promise<void>((resolve) => {
				signalLocked = resolve;
			});
			const released = withTransaction(async () => {
				await sql.unsafe('LOCK TABLE matrix_test IN ACCESS EXCLUSIVE MODE', []);
				signalLocked();
				await Bun.sleep(windowMs * 4);
			});
			await locked;
			expect(exportSelectionSlots().inUse).toBe(1);
			const started = performance.now();
			try {
				lines.push(...(await drain(grid.lines)));
			} finally {
				await released;
			}
			// Non-degeneracy: the producer really waited past the window.
			expect(performance.now() - started).toBeGreaterThan(windowMs * 2);
			expect(emittedRecords(lines).length).toBe(TOTAL);
			expect(exportSelectionSlots().inUse).toBe(0);
		});

		test('9b. idle: a slow consumer that keeps pulling within the window completes', async () => {
			const windowMs = 200;
			const started = performance.now();
			const grid = await openExportGrid(
				jobContext(admin, exportOptions()),
				runOptions({ selectionIdleMs: windowMs }),
			);
			const lines: Line[] = [];
			for await (const line of grid.lines) {
				lines.push(line);
				await Bun.sleep(40);
			}
			expect(emittedRecords(lines).length).toBe(TOTAL);
			// Non-degeneracy: the run outlasted the window several times over.
			expect(performance.now() - started).toBeGreaterThan(windowMs * 3);
			expect(exportSelectionSlots().inUse).toBe(0);
		});

		test('9c. idle: a consumer holding control past the window is closed out (export.consumer_idle)', async () => {
			const baseline = getPoolStats().inUse;
			const grid = await openExportGrid(
				jobContext(admin, exportOptions()),
				runOptions({ selectionIdleMs: 50 }),
			);
			const first = await grid.lines.next();
			expect((first.value as Line).t).toBe('meta');
			const second = await grid.lines.next();
			expect(second.done).toBe(false);
			expect(exportSelectionSlots().inUse).toBe(1);
			await Bun.sleep(300);
			// Released while the consumer stalled — before any further pull.
			expect(exportSelectionSlots().inUse).toBe(0);
			let refusal: unknown = null;
			try {
				for (;;) {
					const next = await grid.lines.next();
					if (next.done === true) break;
				}
			} catch (error) {
				refusal = error;
			}
			expect((refusal as { code?: string } | null)?.code).toBe('export.consumer_idle');
			await sql`SELECT 1`;
			expect(getPoolStats().inUse).toBe(baseline);
		});

		test('10. a cancelled NDJSON body resolves only once the cursor is released, and logs no abort', async () => {
			// A reader that went away is not an aborted export: the pull in flight
			// at cancel() must settle silently (no "ndjson stream aborted" line,
			// no error on a controller that is already closed).
			const logged: string[] = [];
			const consoleError = console.error;
			console.error = (...args: unknown[]) => {
				logged.push(args.map(String).join(' '));
			};
			try {
				await cancelMidStream();
				await Bun.sleep(50);
			} finally {
				console.error = consoleError;
			}
			expect(logged.filter((line) => line.includes('ndjson stream aborted'))).toEqual([]);
		});

		test('10b. ndjsonStream: the pull in flight at cancel settles silently, whether it yields a line or ends', async () => {
			// Deterministic twin of leg 10: the producer's next() is held open
			// until AFTER cancel(), then settles with a line or with the end —
			// the two ways a real in-flight pull resumes into a closed stream.
			for (const settle of ['line', 'end'] as const) {
				let resolveNext: ((result: IteratorResult<Line>) => void) | undefined;
				let returned = 0;
				const lines = {
					next: () =>
						new Promise<IteratorResult<Line>>((resolve) => {
							resolveNext = resolve;
						}),
					return: async () => {
						returned++;
						return { done: true as const, value: undefined };
					},
					throw: async (error: unknown) => {
						throw error;
					},
					[Symbol.asyncIterator]() {
						return this;
					},
				} as unknown as AsyncGenerator<Line>;
				const logged: string[] = [];
				const consoleError = console.error;
				console.error = (...args: unknown[]) => {
					logged.push(args.map(String).join(' '));
				};
				try {
					const reader = ndjsonStream(lines, 'leg10b').getReader();
					const pending = reader.read();
					await Bun.sleep(5);
					expect(resolveNext).toBeDefined();
					await reader.cancel();
					resolveNext?.(
						settle === 'line'
							? { done: false, value: { t: 'row' } }
							: { done: true, value: undefined },
					);
					await Bun.sleep(20);
					expect(await pending).toEqual({ done: true, value: undefined });
				} finally {
					console.error = consoleError;
				}
				expect({ settle, returned, logged }).toEqual({ settle, returned: 1, logged: [] });
			}
		});

		/** Poll until `condition` holds (bounded — a stuck wait reddens, never hangs). */
		async function until(condition: () => boolean, what: string, boundMs = 10_000): Promise<void> {
			const deadline = performance.now() + boundMs;
			while (!condition()) {
				if (performance.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
				await Bun.sleep(5);
			}
		}

		/** The reader's export jobs on disk (the store's owner directory). */
		function readerJobDirs(): string[] {
			try {
				return readdirSync(join(openArtifactStore().root, String(ACL_NON_ADMIN_USER_ID)));
			} catch {
				return [];
			}
		}

		/** A background build of the zzsc export as the reader (lane 'export', called as the job runner calls it). */
		function backgroundBuild(signal: AbortSignal) {
			return toolExportBuildArtifact({
				principal: reader,
				userId: ACL_NON_ADMIN_USER_ID,
				background: true,
				options: { ...exportOptions(), background_running: true },
				publishProgress: () => {},
				signal,
			} as never);
		}

		test('12. queued admission: a background build WAITS for the held slot (never export.busy) and completes once it frees', async () => {
			const before = readerJobDirs();
			const held = await openExportGrid(jobContext(admin, exportOptions()), runOptions());
			let settled = false;
			const build = backgroundBuild(new AbortController().signal).then(
				(response) => {
					settled = true;
					return response;
				},
				(error: unknown) => {
					settled = true;
					return error;
				},
			);
			try {
				await until(() => exportSelectionSlots().waiting === 1, 'the build queued for a slot');
				await Bun.sleep(50);
				// Waiting, not failed: before the lane fix this rejected with export.busy here.
				expect(settled).toBe(false);
				expect(exportSelectionSlots()).toEqual({ slots: SLOTS, inUse: SLOTS, waiting: 1 });
				// The request path stays eager while a build waits.
				let refusal: unknown = null;
				try {
					const extra = await openExportGrid(jobContext(admin, exportOptions()), runOptions());
					await extra.lines.return(undefined);
				} catch (error) {
					refusal = error;
				}
				expect((refusal as { code?: string } | null)?.code).toBe('export.busy');
			} finally {
				await held.lines.return(undefined);
			}
			// HANDED OVER, never freed: the waiter holds the slot the grid gave back.
			expect(exportSelectionSlots()).toEqual({ slots: SLOTS, inUse: SLOTS, waiting: 0 });
			const response = (await build) as {
				ok?: boolean;
				data?: { job_id: string; status: string; records: number };
			};
			expect(response.ok).toBe(true);
			const jobId = response.data?.job_id as string;
			try {
				expect(response.data?.status).toBe('ended');
				expect(response.data?.records).toBe((await directSelection(reader)).length);
			} finally {
				const store = openArtifactStore();
				await store.deleteJob(store.jobRef(ACL_NON_ADMIN_USER_ID, jobId));
				if (before.length === 0) {
					try {
						rmdirSync(join(store.root, String(ACL_NON_ADMIN_USER_ID)));
					} catch {
						// not empty (another run's job) or already gone — never forced
					}
				}
			}
			expect(exportSelectionSlots()).toEqual({ slots: SLOTS, inUse: 0, waiting: 0 });
		});

		test('12b. queued admission: the job signal ends the wait (export.cancelled), no job written, nothing held', async () => {
			const before = readerJobDirs();
			const held = await openExportGrid(jobContext(admin, exportOptions()), runOptions());
			const controller = new AbortController();
			try {
				const build = backgroundBuild(controller.signal).catch((error: unknown) => error);
				await until(() => exportSelectionSlots().waiting === 1, 'the build queued for a slot');
				controller.abort();
				const outcome = await build;
				expect((outcome as { code?: string }).code).toBe('export.cancelled');
				expect(exportSelectionSlots()).toEqual({ slots: SLOTS, inUse: SLOTS, waiting: 0 });
				expect(readerJobDirs()).toEqual(before);
			} finally {
				await held.lines.return(undefined);
			}
			expect(exportSelectionSlots()).toEqual({ slots: SLOTS, inUse: 0, waiting: 0 });
		});

		test('12c. queued admission: a signal that fired BEFORE the open queues is refused at once, never enqueued', async () => {
			const held = await openExportGrid(jobContext(admin, exportOptions()), runOptions());
			const controller = new AbortController();
			controller.abort();
			const sqo = sanitizeClientSqo(structuredClone(SQO));
			sqo.limit = null as unknown as number;
			sqo.offset = 0;
			const built = await buildSearchSql(sqo, { idsOnly: true });
			const open = openSelectionCursor(built, {
				pageRows: SELECTION_PAGE,
				admission: 'queue',
				signal: controller.signal,
			}).then(
				async (cursor) => {
					await cursor.close();
					return 'opened' as const;
				},
				(error: unknown) => error,
			);
			try {
				// Bounded: an abort listener added to an ALREADY-aborted signal never
				// fires, so a waiter enqueued here would wait for the held slot.
				const outcome = await Promise.race([open, Bun.sleep(2_000).then(() => 'still waiting')]);
				const code =
					typeof outcome === 'object' && outcome !== null
						? (outcome as { code?: string }).code
						: outcome;
				expect(code).toBe('export.cancelled');
				expect(exportSelectionSlots()).toEqual({ slots: SLOTS, inUse: SLOTS, waiting: 0 });
			} finally {
				await held.lines.return(undefined);
				await open;
			}
			expect(exportSelectionSlots()).toEqual({ slots: SLOTS, inUse: 0, waiting: 0 });
		});

		test('13. release without a pull: a failing DECLARE, an abort while the consumer holds control, a cursor never pulled', async () => {
			const baseline = getPoolStats().inUse;
			// (a) The DECLARE fails (a parameter the selection cannot bind): refused,
			// and the slot and the reserved connection are back.
			let declareError: unknown = null;
			try {
				const cursor = await openSelectionCursor(
					probe('SELECT section_tipo, section_id FROM matrix_test WHERE section_id = $1::int', [
						'not-an-integer',
					]),
					{ pageRows: SELECTION_PAGE },
				);
				await cursor.close();
			} catch (error) {
				declareError = error;
			}
			expect(declareError).not.toBeNull();
			expect(exportSelectionSlots().inUse).toBe(0);
			await sql`SELECT 1`;
			expect(getPoolStats().inUse).toBe(baseline);

			// (b) Aborted while control sits with the consumer: the abort ALONE
			// releases — the consumer never pulls again.
			const controller = new AbortController();
			const aborted = await openExportGrid(
				jobContext(admin, exportOptions()),
				runOptions({ signal: controller.signal }),
			);
			expect(((await aborted.lines.next()).value as Line).t).toBe('meta');
			expect((await aborted.lines.next()).done).toBe(false);
			expect(exportSelectionSlots().inUse).toBe(1);
			controller.abort();
			await until(() => exportSelectionSlots().inUse === 0, 'the abort released the cursor', 2_000);
			await sql`SELECT 1`;
			expect(getPoolStats().inUse).toBe(baseline);
			await aborted.lines.return(undefined);

			// (c) Never pulled at all: the idle window is armed at OPEN.
			const unread = await openExportGrid(
				jobContext(admin, exportOptions()),
				runOptions({ selectionIdleMs: 50 }),
			);
			expect(exportSelectionSlots().inUse).toBe(1);
			await until(
				() => exportSelectionSlots().inUse === 0,
				'the idle window freed an unpulled cursor',
				2_000,
			);
			await sql`SELECT 1`;
			expect(getPoolStats().inUse).toBe(baseline);
			await unread.lines.return(undefined);
		});

		test('14. DB_POOL_MAX=1 admits no cursor in either admission (export.busy at once, never a wait)', async () => {
			// A process BOOTED with a pool of one (the slots are derived at module
			// load): both admissions answer at once; a queued open that waited for
			// a slot that can never exist would hang past the bound and redden.
			const cursorPath = join(
				import.meta.dir,
				'..',
				'..',
				'src/diffusion/export/selection_cursor.ts',
			);
			const script = `
				const m = await import(${JSON.stringify(cursorPath)});
				const st = await import(${JSON.stringify(join(import.meta.dir, '..', '..', 'src/core/search/search_statement.ts'))});
				const out = { slots: m.EXPORT_SELECTION_SLOTS };
				for (const admission of ['refuse', 'queue']) {
					try {
						const c = await m.openSelectionCursor(st.createSearchStatement('SELECT 1 AS section_id', [], false), { pageRows: 1, admission });
						await c.close();
						out[admission] = 'admitted';
					} catch (error) {
						out[admission] = error?.code ?? String(error);
					}
				}
				console.log('POOL_ONE ' + JSON.stringify(out));
				process.exit(0);
			`;
			const child = Bun.spawn([process.execPath, '-e', script], {
				env: { ...process.env, DB_POOL_MAX: '1' },
				stdout: 'pipe',
				stderr: 'pipe',
			});
			const killer = setTimeout(() => child.kill(), 20_000);
			const [stdout, stderr] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			await child.exited;
			clearTimeout(killer);
			const line = stdout.split('\n').find((entry) => entry.startsWith('POOL_ONE '));
			expect({ line: line ?? null, stderr: line === undefined ? stderr.slice(-2000) : '' }).toEqual(
				{
					line: `POOL_ONE ${JSON.stringify({ slots: 0, refuse: 'export.busy', queue: 'export.busy' })}`,
					stderr: '',
				},
			);
		}, 30_000);

		test("15. the materialization runs under the connection's statement ceiling (db.statement_timeout); every exit leaves the pool clean", async () => {
			// A WITH HOLD cursor is computed IN FULL when its transaction commits,
			// and PostgreSQL disarms statement_timeout before that commit: an
			// autocommit DECLARE ran the whole selection with NO ceiling (measured:
			// 300 ms ceiling, 2343 ms selection served). A process BOOTED with a
			// 300 ms ceiling and a pool of two (one selection slot): a selection that
			// sleeps 3 s is refused with the typed ceiling code well before it could
			// finish, holding nothing; a quick one under the same ceiling still
			// serves (the bound is the ceiling, not a refusal of cursors); and after
			// the refusal AND after a DECLARE that fails inside the bounded
			// transaction, EVERY pooled connection is fresh — no transaction left
			// open or aborted, no transaction_timeout left behind.
			const cursorPath = join(
				import.meta.dir,
				'..',
				'..',
				'src/diffusion/export/selection_cursor.ts',
			);
			const postgresPath = join(import.meta.dir, '..', '..', 'src/core/db/postgres.ts');
			const script = `
				const m = await import(${JSON.stringify(cursorPath)});
				const st = await import(${JSON.stringify(join(import.meta.dir, '..', '..', 'src/core/search/search_statement.ts'))});
				const pg = await import(${JSON.stringify(postgresPath)});
				const out = { slots: m.EXPORT_SELECTION_SLOTS };
				const sleepy = "SELECT 'zzsc1' AS section_tipo, g AS section_id FROM generate_series(1, 30) AS g WHERE pg_sleep(0.1) IS NOT NULL ORDER BY g";
				const started = performance.now();
				try {
					const c = await m.openSelectionCursor(st.createSearchStatement(sleepy, [], false), { pageRows: 5 });
					out.slow = 'admitted ' + c.total;
					await c.close();
				} catch (error) {
					out.slow = error?.code ?? String(error);
				}
				out.slowWithinBound = performance.now() - started < 1500;
				out.slotsAfterSlow = m.exportSelectionSlots().inUse;
				const quick = await m.openSelectionCursor(
					st.createSearchStatement("SELECT 'zzsc1' AS section_tipo, g AS section_id FROM generate_series(1, 7) AS g ORDER BY g", [], false),
					{ pageRows: 5 },
				);
				let served = 0;
				for await (const page of quick.pages) served += page.length;
				out.quick = quick.total + '/' + served;
				try {
					const c = await m.openSelectionCursor(
						st.createSearchStatement('SELECT section_tipo, section_id FROM matrix_test WHERE section_id = $1::int', ['not-an-integer'], false),
						{ pageRows: 1 },
					);
					await c.close();
					out.failing = 'admitted';
				} catch (error) {
					out.failing = 'refused';
				}
				out.slotsAfterFailing = m.exportSelectionSlots().inUse;
				// As many concurrent probes as the pool has connections: each lands on
				// its own connection, so a connection left in a transaction (open or
				// aborted) or with a transaction_timeout is seen.
				try {
					const probes = await Promise.all(
						Array.from({ length: pg.getPoolStats().max }, () =>
							pg.sql.unsafe(
								"SELECT now() = statement_timestamp() AS fresh, current_setting('transaction_timeout') AS bound FROM pg_sleep(0.2)",
								[],
							),
						),
					);
					out.pool = probes.map((rows) => (rows[0].fresh ? 'fresh' : 'in-transaction') + ' ' + rows[0].bound);
				} catch (error) {
					out.pool = 'probe failed: ' + (error?.message ?? String(error));
				}
				console.log('CEILING ' + JSON.stringify(out));
				process.exit(0);
			`;
			const child = Bun.spawn([process.execPath, '-e', script], {
				env: { ...process.env, DB_POOL_MAX: '2', DB_STATEMENT_TIMEOUT_MS: '300' },
				stdout: 'pipe',
				stderr: 'pipe',
			});
			const killer = setTimeout(() => child.kill(), 30_000);
			const [stdout, stderr] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			await child.exited;
			clearTimeout(killer);
			const line = stdout.split('\n').find((entry) => entry.startsWith('CEILING '));
			expect({ line: line ?? null, stderr: line === undefined ? stderr.slice(-2000) : '' }).toEqual(
				{
					line: `CEILING ${JSON.stringify({
						slots: 1,
						slow: 'db.statement_timeout',
						slowWithinBound: true,
						slotsAfterSlow: 0,
						quick: '7/7',
						failing: 'refused',
						slotsAfterFailing: 0,
						pool: ['fresh 0', 'fresh 0'],
					})}`,
					stderr: '',
				},
			);
		}, 40_000);

		async function cancelMidStream(): Promise<void> {
			const streamed = await exportGridUnified({
				principal: admin,
				userId: -1,
				options: exportOptions({ ndjson_stream: true }),
				background: false,
			} as never);
			const reader = (
				(streamed as { stream?: ReadableStream<Uint8Array> }).stream as ReadableStream<Uint8Array>
			).getReader();
			const chunk = await reader.read();
			expect(chunk.done).toBe(false);
			expect(exportSelectionSlots().inUse).toBe(1);
			await reader.cancel();
			expect(exportSelectionSlots().inUse).toBe(0);
		}

		test("8. the total has ONE source: the driver's MOVE command-tag count, pinned; total = rows served, in order", async () => {
			const sqo = sanitizeClientSqo(structuredClone(SQO));
			sqo.limit = null as unknown as number;
			sqo.offset = 0;
			const built = await buildSearchSql(sqo, { idsOnly: true });
			const shown = searchStatementText(built);
			// THE DRIVER FACT (raw, on a reserved connection like the cursor's): a
			// MOVE answers its command tag as a numeric `count`, equal to the rows.
			const connection = await sql.reserve();
			try {
				const name = 'export_sel_leg8_pin';
				await connection.unsafe(
					`DECLARE ${name} SCROLL CURSOR WITH HOLD FOR ${shown.sql.replace(/;\s*$/, '')}`,
					[...shown.params] as never,
				);
				try {
					const moved = (await connection.unsafe(`MOVE FORWARD ALL IN ${name}`)) as {
						count?: unknown;
					};
					expect(typeof moved.count).toBe('number');
					expect(moved.count).toBe(TOTAL);
				} finally {
					await connection.unsafe(`CLOSE ${name}`);
				}
			} finally {
				connection.release();
			}
			// The cursor's total is that count, and equals what it serves.
			const cursor = await openSelectionCursor<{ section_id: number; section_tipo: string }>(
				built,
				{ pageRows: SELECTION_PAGE },
			);
			const ids: string[] = [];
			for await (const page of cursor.pages) {
				for (const row of page) ids.push(`${row.section_tipo}/${row.section_id}`);
			}
			expect(cursor.total).toBe(TOTAL);
			expect(ids.length).toBe(cursor.total);
			// (section_tipo, section_id): the overlapping ids stay two records each.
			expect(new Set(ids).size).toBe(TOTAL);
			const tipoId = (record: Selected) => `${record.tipo}/${record.id}`;
			expect(orderViolation(ids, await directSelection(admin), tipoId)).toBeNull();
			expect(exportSelectionSlots().inUse).toBe(0);
		});

		/** A selection that materializes in ~3 s (30 rows, 0.1 s each) — what a Stop must cut. */
		const SLEEPY_SELECTION =
			"SELECT 'zzsc1' AS section_tipo, g AS section_id FROM generate_series(1, 30) AS g WHERE pg_sleep(0.1) IS NOT NULL ORDER BY g";

		/** The backends of THIS database still running a statement, other than the asker. */
		async function activeBackends(): Promise<string[]> {
			const rows = (await sql.unsafe(
				`SELECT query FROM pg_stat_activity
				  WHERE datname = current_database() AND state = 'active'
				    AND backend_type = 'client backend' AND pid <> pg_backend_pid()`,
				[],
			)) as { query: string }[];
			return rows.map((row) => row.query);
		}

		/** How an open ended: its code (or 'admitted <total>'), and how long it took. */
		async function openOutcome(
			signal: AbortSignal,
		): Promise<{ outcome: string; settledAt: number }> {
			try {
				const cursor = await openSelectionCursor<{ section_id: number; section_tipo: string }>(
					probe(SLEEPY_SELECTION),
					{ pageRows: SELECTION_PAGE, signal },
				);
				await cursor.close();
				return { outcome: `admitted ${cursor.total}`, settledAt: performance.now() };
			} catch (error) {
				return {
					outcome: (error as { code?: string })?.code ?? String(error),
					settledAt: performance.now(),
				};
			}
		}

		test('17a. a Stop WHILE the selection materializes cancels it on the server: export.cancelled at once, nothing left running', async () => {
			const baseline = getPoolStats().inUse;
			const controller = new AbortController();
			const started = performance.now();
			const settled = openOutcome(controller.signal);
			await Bun.sleep(400);
			// The open is inside its COMMIT (the materialization) by now.
			controller.abort();
			const { outcome, settledAt } = await settled;
			const running = await activeBackends();
			await sql`SELECT 1`;
			expect({
				outcome,
				// well before the 3 s the selection needs (the abort lands at 400 ms)
				withinBound: settledAt - started < 1500,
				running,
				slotsInUse: exportSelectionSlots().inUse,
				poolInUse: getPoolStats().inUse,
			}).toEqual({
				outcome: 'export.cancelled',
				withinBound: true,
				running: [],
				slotsInUse: 0,
				poolInUse: baseline,
			});
			// Every pooled connection is fresh: no transaction left open or aborted.
			const probes = await Promise.all(
				Array.from({ length: POOL_MAX }, () =>
					sql.unsafe(
						"SELECT now() = statement_timestamp() AS fresh, current_setting('transaction_timeout') AS bound FROM pg_sleep(0.1)",
						[],
					),
				),
			);
			expect(
				probes.map((rows) => {
					const row = (rows as { fresh: boolean; bound: string }[])[0];
					return `${row?.fresh ? 'fresh' : 'in-transaction'} ${row?.bound}`;
				}),
			).toEqual(Array.from({ length: POOL_MAX }, () => 'fresh 0'));
		}, 20_000);

		test('17b. a Stop while the open WAITS for a pooled connection: once it gets one it sends nothing (export.cancelled), nothing held', async () => {
			const baseline = getPoolStats().inUse;
			// Saturate the pool: the open takes its selection slot, then queues for a
			// connection behind these.
			const held = await Promise.all(
				Array.from({ length: POOL_MAX - baseline }, () => sql.reserve()),
			);
			const controller = new AbortController();
			let releasedAt = Number.NaN;
			try {
				const settled = openOutcome(controller.signal);
				await Bun.sleep(150);
				// The abort lands while the open still has no connection: no backend to
				// cancel, nothing running — only the open's own door can refuse.
				controller.abort();
				await Bun.sleep(150);
				releasedAt = performance.now();
				for (const connection of held.splice(0)) connection.release();
				const { outcome, settledAt } = await settled;
				const running = await activeBackends();
				expect({
					outcome,
					// the open does not BEGIN the 3 s selection it was stopped for
					withinBound: settledAt - releasedAt < 1000,
					running,
					slotsInUse: exportSelectionSlots().inUse,
				}).toEqual({
					outcome: 'export.cancelled',
					withinBound: true,
					running: [],
					slotsInUse: 0,
				});
			} finally {
				for (const connection of held) connection.release();
			}
			await sql`SELECT 1`;
			expect(getPoolStats().inUse).toBe(baseline);
		}, 20_000);

		test("17c. the cancel is guarded by its transaction: once it ended, the backend's next statement is untouched (control: inside, it cuts)", async () => {
			const { cancelBackendStatement, readCancelTarget } = await import(
				'../../src/core/db/postgres.ts'
			);
			/** Run a 0.6 s statement on `connection` while `target` is cancelled 100 ms in. */
			const sleepUnderCancel = async (
				connection: Awaited<ReturnType<typeof sql.reserve>>,
				target: Awaited<ReturnType<typeof readCancelTarget>>,
			): Promise<string> => {
				const running = connection.unsafe('SELECT pg_sleep(0.6)', []);
				await Bun.sleep(100);
				if (target !== undefined) await cancelBackendStatement(target, 'leg 17c');
				try {
					await running;
					return 'completed';
				} catch (error) {
					return String((error as { errno?: unknown })?.errno ?? error);
				}
			};
			const connection = await sql.reserve();
			try {
				await connection.unsafe('BEGIN', []);
				const ended = await readCancelTarget(connection);
				await connection.unsafe('COMMIT', []);
				// The SAME backend, a LATER statement: the guard must spare it.
				const afterEnd = await sleepUnderCancel(connection, ended);
				// Control: the target of the transaction the statement runs in.
				await connection.unsafe('BEGIN', []);
				const live = await readCancelTarget(connection);
				const inside = await sleepUnderCancel(connection, live);
				await connection.unsafe('ROLLBACK', []).catch(() => undefined);
				expect({ read: ended !== undefined, afterEnd, inside }).toEqual({
					read: true,
					afterEnd: 'completed',
					inside: '57014',
				});
			} finally {
				connection.release();
			}
		}, 20_000);

		test('16. an open whose signal fired BEFORE it (refuse admission) answers its total and releases at once', async () => {
			// The protocol still owes the meta line (the total), but no page: the
			// cursor must give its slot and connection back as the open returns —
			// the abort listener can never fire for a signal that already fired,
			// and the idle window would hold the slot for 15 minutes.
			const sqo = sanitizeClientSqo(structuredClone(SQO));
			sqo.limit = null as unknown as number;
			sqo.offset = 0;
			const built = await buildSearchSql(sqo, { idsOnly: true });
			const baseline = getPoolStats().inUse;
			const controller = new AbortController();
			controller.abort();
			const cursor = await openSelectionCursor<{ section_id: number; section_tipo: string }>(
				built,
				{ pageRows: SELECTION_PAGE, signal: controller.signal },
			);
			expect({ total: cursor.total, slotsInUse: exportSelectionSlots().inUse }).toEqual({
				total: TOTAL,
				slotsInUse: 0,
			});
			expect((await cursor.pages.next()).done).toBe(true);
			await sql`SELECT 1`;
			expect(getPoolStats().inUse).toBe(baseline);
		});
	});
}
