/**
 * User activity statistics (PHP diffusion/class.diffusion_section_stats.php):
 * per-user, per-day aggregates of the matrix_activity audit log stored as
 * dd1521 records in matrix_stats — what (action-code counts keyed by
 * action, labelled by the labels engine), where (section tipos touched), when
 * (hour histogram) and publish (per-section publish counts from dd1223 events).
 *
 * The rebuild flow (maintenance widget database_info.rebuild_user_stats,
 * rebuildUserActivityStats) recomputes every day from the surviving
 * matrix_activity rows, then REPLACES the user's stats rows in one transaction. (!) That is intentionally lossy when the activity log
 * is shorter than the stats history — an admin decision; the differential
 * gate uses a SYNTHETIC user so real aggregates are never touched.
 */

import { USER_ACTIVITY_SECTION_TIPO } from '../concepts/section.ts';
import { encodeForJsonb } from '../db/json_codec.ts';
import { acquireNodeLock, sql, withTransaction } from '../db/postgres.ts';
import { resolveUserName, USERS_SECTION } from '../security/user_identity.ts';

/** dd1521 record components (PHP USER_ACTIVITY_* constants). */
const UA_SECTION = USER_ACTIVITY_SECTION_TIPO; // dd1521
const UA_USER = 'dd1522';
const UA_TYPE = 'dd1531';
const UA_DATE = 'dd1530';
const UA_TOTALS = 'dd1523';

/** matrix_activity components (logger_backend_activity). */
const ACT_WHO = 'dd543';
const ACT_WHAT = 'dd545';
const ACT_WHERE = 'dd546';
const ACT_WHEN = 'dd547';
const ACT_DATA = 'dd551';

/** Freeze the table AND each entry: an exported table is read-only all the way down. */
function freezeWhatActions(
	table: Record<string, WhatAction>,
): Readonly<Record<string, WhatAction>> {
	for (const entry of Object.values(table)) Object.freeze(entry);
	return Object.freeze(table);
}

/** One activity action: the key stored in dd1523 and sent on the wire, and its UI label key. */
export interface WhatAction {
	readonly action: string;
	readonly labelKey: string;
}

/**
 * Activity what-code (dd42 / matrix_activity dd545) → action (PHP build_what
 * $what_map, which mapped to label TIPOS). CLOSED: an unlisted code is dropped.
 * The text comes from the labels engine (src/core/labels/, getLabels) — never
 * from the ontology: the v7 master reuses the tipos of retired model='label'
 * nodes (dd660-669, dd692-699 are AI-usage nodes now), so a label tipo resolved
 * through termByTipo would serve whatever node owns that tipo today.
 * Wire shape: WC-2026-10-12-user-activity-what-labels. Exported READ-ONLY
 * (table and every entry frozen) for the gate that pins every labelKey to a
 * src/core/labels/master.json key (user_stats_merge_native T1-T3).
 */
export const WHAT_ACTIONS: Readonly<Record<string, WhatAction>> = freezeWhatActions({
	'1': { action: 'login', labelKey: 'activity_login' },
	'2': { action: 'logout', labelKey: 'activity_logout' },
	'3': { action: 'new', labelKey: 'new' },
	'4': { action: 'delete', labelKey: 'delete' },
	'5': { action: 'save', labelKey: 'save' },
	'6': { action: 'edit', labelKey: 'edit' },
	'7': { action: 'list', labelKey: 'list' },
	'8': { action: 'search', labelKey: 'search' },
	'9': { action: 'upload', labelKey: 'upload' },
	'10': { action: 'download', labelKey: 'download' },
	'11': { action: 'upload_complete', labelKey: 'activity_upload_complete' },
	'12': { action: 'delete_file', labelKey: 'delete_file' },
	'13': { action: 'recover_section', labelKey: 'activity_recover_section' },
	'14': { action: 'recover_component', labelKey: 'activity_recover_component' },
	'15': { action: 'statistics', labelKey: 'activity_statistics' },
	'16': { action: 'new_file_version', labelKey: 'activity_new_file_version' },
});

/**
 * READ-ONLY legacy map: the label tipo a PHP-era dd1521 row stored as a what
 * item's `tipo` → its action. Used ONLY to fold those stored rows; these tipos
 * are ids in old data, never ontology lookups (see WHAT_ACTIONS). An unlisted
 * legacy tipo is kept under its raw key — never dropped, never resolved.
 * Exported READ-ONLY (frozen) for the same gate: its actions equal
 * WHAT_ACTIONS' action set exactly.
 */
export const LEGACY_WHAT_TIPOS: Readonly<Record<string, string>> = Object.freeze({
	dd696: 'login',
	dd697: 'logout',
	dd695: 'new',
	dd729: 'delete',
	dd700: 'save',
	dd694: 'edit',
	dd693: 'list',
	dd699: 'search',
	dd1090: 'upload',
	dd1080: 'download',
	dd1094: 'upload_complete',
	dd1095: 'delete_file',
	dd1092: 'recover_section',
	dd1091: 'recover_component',
	dd1098: 'statistics',
	dd1081: 'new_file_version',
});

/** action → label key (derived from WHAT_ACTIONS, the one table). */
const WHAT_LABEL_KEYS: ReadonlyMap<string, string> = new Map(
	Object.values(WHAT_ACTIONS).map(({ action, labelKey }) => [action, labelKey]),
);

/**
 * The action key of a stored/raw 'what' item: `key` (v7 rows), else a legacy
 * `tipo` mapped through LEGACY_WHAT_TIPOS (an unknown one stays raw). '' when
 * the item carries neither.
 */
function whatItemKey(item: { key?: unknown; tipo?: unknown }): string {
	if (typeof item.key === 'string' && item.key !== '') return item.key;
	const tipo = typeof item.tipo === 'string' ? item.tipo : '';
	return Object.hasOwn(LEGACY_WHAT_TIPOS, tipo) ? (LEGACY_WHAT_TIPOS[tipo] as string) : tipo;
}

/**
 * The display text of an action key in one lang's label dictionary — the
 * action itself when the key is unknown (a raw legacy tipo) or the lang has
 * no text for it.
 */
function whatLabel(action: string, labels: Record<string, string>): string {
	const labelKey = WHAT_LABEL_KEYS.get(action);
	return (labelKey !== undefined ? labels[labelKey] : undefined) ?? action;
}

/** A what-key → label resolver for one lang, over the labels engine (lazy import: no ontology edge). */
async function whatLabelResolver(lang: string): Promise<(action: string) => Promise<string>> {
	const { getLabels } = await import('../labels/catalog.ts');
	const labels = await getLabels(lang);
	return async (action) => whatLabel(action, labels);
}

/** 'where' keys the aggregation ignores (tool/internal areas). */
const WHERE_SKIP: ReadonlySet<string> = new Set(['dd271', 'dd1224', 'dd1225']);
/** The 'last publish' where-key routed to the publish histogram. */
const WHERE_PUBLISH = 'dd1223';

/**
 * BOTH typed containment payloads for the user's actor locator — jsonb `@>` is
 * type-strict and stored rows carry string-form ids until the int sweep (and
 * int-form after it), so every probe ORs the pair (the dual-form law of
 * core/search/containment.ts; WC-2026-08-10-section-id-int-canonical).
 * json_codec even for the read-side params — one binding discipline for every
 * jsonb param in this module (S2-07).
 */
function userLocatorFilterPair(componentTipo: string, userId: number): [string, string] {
	return [
		encodeForJsonb({
			[componentTipo]: [{ section_tipo: USERS_SECTION, section_id: String(userId) }],
		}),
		encodeForJsonb({
			[componentTipo]: [{ section_tipo: USERS_SECTION, section_id: userId }],
		}),
	];
}

/**
 * The actor predicate for matrix_activity — the WC-056 indexed EXPRESSION pair,
 * NOT `relation @> …` containment.
 *
 * WHY (2026-07-30, the reported `rebuild_user_stats` statement timeout).
 * Containment can only be answered by the relation GIN, which returns the
 * actor's WHOLE history as one bitmap; a `timestamp` bound is then a Filter, so
 * every window — even a single day — pays for the full actor. Measured on the
 * 32.9M-row mdcat log, actor dd128/2 has 8.1M rows: `count(*)` alone took 57 s
 * against a 60 s `DB_STATEMENT_TIMEOUT_MS`, and the rebuild's row fetch (994 B
 * average width, plus a sort) never came close to finishing. `matrix_activity_
 * who_ts_idx` carries the actor AND `("timestamp", id)`, so the same predicate
 * written as an equality on its expressions turns any window into an index
 * RANGE scan: the identical single-day aggregate is 14 ms.
 *
 * THE INVARIANT is builder_relation's (element 0 is the only actor locator —
 * how activity_log.ts writes it, gated by activity_log_single_actor.test.ts).
 * section_tipo is bound explicitly, so a locator into another section can never
 * be a false positive.
 *
 * (!) DELIBERATE DEVIATION from the containment predicate it replaced: `->>` is
 * type-lossy where `@>` was type-strict, so a NUMERIC section_id matches here and
 * would not have before. That is now LOAD-BEARING, not inert: since
 * WC-2026-08-10-section-id-int-canonical the actor address is minted as an INT
 * (activity_log.ts dd543), while the 32.94M pre-sweep mdcat rows are string-typed
 * — one text extraction spans both, where either typed `@>` probe alone would
 * silently miss half the archive. (It read the opposite before that sweep, when
 * both writers stringified.) jsonb_array_length(dd543) = 1 still holds.
 */
function whoScope(userId: number, params: unknown[]): string {
	params.push(String(userId), USERS_SECTION);
	const id = params.length - 1;
	return (
		`a.relation->'${ACT_WHO}'->0->>'section_id' = $${id} ` +
		`AND a.relation->'${ACT_WHO}'->0->>'section_tipo' = $${id + 1}`
	);
}

/**
 * Rows per aggregation statement — the knob that keeps every statement under
 * `DB_STATEMENT_TIMEOUT_MS` (60 s as configured).
 *
 * CALIBRATED, not guessed. The full rebuild window of the 8.1M-row mdcat actor
 * was run at 400k/page: 21 pages, 154 s total, pages ranging 2.8 s → 30.2 s. An
 * isolated EXPLAIN ANALYZE of the same 400k page was 3.4 s, so that spread is
 * cache state and TOAST width, not the plan — the headroom has to absorb an
 * order of magnitude, and 2× is not enough. The same window re-run at 100k has a
 * worst page of 5.3 s (~11× under the ceiling) and finished FASTER end to end —
 * 127 s over ~81 pages — because a narrower page spills less; the extra round
 * trips are noise against heap-read-bound work. Both runs returned identical
 * tallies (1124 keys, 21,643,162 counted dimensions), which is the paging
 * invariant holding at production scale.
 *
 * Pages bound BOTH the statement duration and the CTE tuplestore (19 MB at 400k),
 * so lowering this is always safe; raising it trades away the only margin.
 */
const AGGREGATE_PAGE_ROWS = 100000;

/** The marker `kind` of the paged aggregate's trailing cursor row. */
const CURSOR_KIND = '__cursor__';

/** One (day, dimension, key) count from the paged aggregate. */
interface ActivityTally {
	day: string;
	kind: 'what' | 'where' | 'when' | 'publish';
	/** Dimension-raw: the what CODE (not yet WHAT_ACTIONS-mapped), the where/publish tipo, the hour. */
	key: string;
	n: number;
	/** Lowest contributing matrix_activity id — the first-encounter order carrier. */
	minId: number;
}

/**
 * Aggregate one actor's matrix_activity window IN THE DATABASE, paged.
 *
 * WHY IT IS NOT A ROW LOOP ANY MORE (2026-07-30). The dimensions this reduces to
 * are ~40 keys per day, but the rows behind them are the whole activity log: the
 * previous shape selected every matching row (7 columns, 4 of them jsonb) into
 * the process and folded it in TS. On the 8.1M-row actor that is ~8 GB across
 * the wire for an answer measured in kilobytes — the statement timeout was the
 * first wall it hit, not the last. Counting server-side makes the result size
 * independent of the log size, and the (timestamp, id) keyset page makes every
 * statement bounded by `AGGREGATE_PAGE_ROWS` instead of by the actor's history.
 *
 * Only the two extraction rules that DECIDE which dimension a row lands in live
 * in the SQL — the `where` value's array unwrap, and the dd1223 → publish
 * routing with its top_tipo/section_tipo preference. WHAT_ACTIONS and WHERE_SKIP
 * stay in TS (below), so the mapping tables have exactly one home.
 *
 * `minId` per group is what preserves the totals array ORDER: the payload is
 * ordered by first encounter in id-ascending order, which is a pinned wire shape
 * (widget_request_native + the frozen get_widget_data fixture), so the order can
 * not be re-derived from the aggregate — it has to be carried.
 */
export async function aggregateActivity(
	userId: number,
	from: string | null,
	until: string,
	/**
	 * Page size. A parameter ONLY so the gate can drive the paging path with a
	 * handful of scratch rows (user_stats_paging.test.ts asserts that any page
	 * size yields byte-identical tallies) — production always takes the default.
	 */
	pageRows: number = AGGREGATE_PAGE_ROWS,
): Promise<{ tallies: ActivityTally[]; rows: number }> {
	const limit = Math.max(1, Math.trunc(pageRows));
	const tallies: ActivityTally[] = [];
	let rows = 0;
	let cursor: { ts: string; id: number } | null = null;

	for (;;) {
		const params: unknown[] = [];
		const scope = [whoScope(userId, params)];
		params.push(until);
		scope.push(`a."timestamp" < date($${params.length})`);
		if (from !== null) {
			params.push(from);
			scope.push(`a."timestamp" >= date($${params.length})`);
		}
		if (cursor !== null) {
			params.push(cursor.ts, cursor.id);
			scope.push(
				`(a."timestamp", a.id) > ($${params.length - 1}::timestamp, $${params.length}::int)`,
			);
		}

		const page = (await sql.unsafe(
			`WITH page AS (
				SELECT a.id, a."timestamp",
				       a.relation->'${ACT_WHAT}'->0->>'section_id' AS what_key,
				       a.date->'${ACT_WHEN}'->0->'start'->>'hour' AS hour_key,
				       CASE jsonb_typeof(a.string->'${ACT_WHERE}'->0->'value')
				            WHEN 'array' THEN
				                 CASE WHEN jsonb_typeof(a.string->'${ACT_WHERE}'->0->'value'->0) = 'string'
				                      THEN a.string->'${ACT_WHERE}'->0->'value'->>0 END
				            WHEN 'string' THEN a.string->'${ACT_WHERE}'->0->'value'#>>'{}'
				       END AS where_key,
				       CASE WHEN a.misc->'${ACT_DATA}'->0->'value'->'top_tipo' IS NULL
				              OR jsonb_typeof(a.misc->'${ACT_DATA}'->0->'value'->'top_tipo') = 'null'
				            THEN a.misc->'${ACT_DATA}'->0->'value'->'section_tipo'
				            ELSE a.misc->'${ACT_DATA}'->0->'value'->'top_tipo'
				       END AS publish_raw
				FROM matrix_activity a
				WHERE ${scope.join(' AND ')}
				ORDER BY a."timestamp", a.id
				LIMIT ${limit}
			)
			SELECT to_char(p."timestamp", 'YYYY-MM-DD') AS day, v.kind, v.key,
			       count(*)::bigint AS n, min(p.id)::bigint AS min_id
			FROM page p
			CROSS JOIN LATERAL (VALUES
				('what', p.what_key),
				('when', p.hour_key),
				(CASE WHEN p.where_key = '${WHERE_PUBLISH}' THEN 'publish' ELSE 'where' END,
				 CASE WHEN p.where_key = '${WHERE_PUBLISH}'
				      THEN CASE WHEN p.publish_raw IS NULL
				                  OR p.publish_raw IN ('null'::jsonb, 'false'::jsonb)
				                THEN NULL ELSE p.publish_raw#>>'{}' END
				      ELSE p.where_key END)
			) AS v(kind, key)
			-- (!) The empty-string guard below is DELIBERATELY blanket over all four
			-- dimensions; the row loop applied it to the where value only. Do not
			-- "restore parity" here: an empty key is unreachable (no writer emits
			-- one, 0 hits in 36.5M rows), and where it would have differed the old
			-- output was garbage anyway (Number of '' is 0, so an empty hour became
			-- a duplicate hour-0 entry).
			WHERE v.key IS NOT NULL AND v.key <> ''
			GROUP BY 1, 2, 3
			UNION ALL
			-- The keyset cursor + the page's row count, as one trailing row: the
			-- page CTE cannot be reached from a second statement, and re-deriving
			-- either would mean scanning the window twice.
			(SELECT to_char(p."timestamp", 'YYYY-MM-DD HH24:MI:SS.US'), '${CURSOR_KIND}', NULL,
			        (SELECT count(*)::bigint FROM page), p.id::bigint
			 FROM page p ORDER BY p."timestamp" DESC, p.id DESC LIMIT 1)`,
			params as (string | number)[],
		)) as { day: string; kind: string; key: string | null; n: string; min_id: string }[];

		let next: { ts: string; id: number } | null = null;
		let pageCount = 0;
		for (const row of page) {
			if (row.kind === CURSOR_KIND) {
				pageCount = Number(row.n);
				next = { ts: row.day, id: Number(row.min_id) };
				continue;
			}
			tallies.push({
				day: row.day,
				kind: row.kind as ActivityTally['kind'],
				key: String(row.key),
				n: Number(row.n),
				minId: Number(row.min_id),
			});
		}
		rows += pageCount;
		// A short page (or an empty one — no cursor row at all) is the last.
		if (next === null || pageCount < limit) break;
		cursor = next;
	}

	return { tallies, rows };
}

/**
 * Fold tallies into ONE dimension set, applying the two TS-side mapping tables:
 * WHAT_ACTIONS (an unmapped action code is dropped, as PHP build_what drops it) and
 * WHERE_SKIP (tool areas leave the `where` histogram but still count in `what`
 * and `when` — the same asymmetry the row loop had).
 *
 * Insertion order is `minId` ascending, so a key's position is where it was
 * FIRST seen; a key split across pages accumulates at its earliest position.
 */
function foldTallies(tallies: ActivityTally[]): DayGroup {
	const group: DayGroup = {
		what: new Map(),
		where: new Map(),
		when: new Map(),
		publish: new Map(),
	};
	const add = (target: Map<string, number>, key: string, n: number): void => {
		target.set(key, (target.get(key) ?? 0) + n);
	};
	for (const tally of [...tallies].sort((a, b) => a.minId - b.minId)) {
		if (tally.kind === 'what') {
			if (Object.hasOwn(WHAT_ACTIONS, tally.key)) {
				add(group.what, (WHAT_ACTIONS[tally.key] as WhatAction).action, tally.n);
			}
		} else if (tally.kind === 'where') {
			if (!WHERE_SKIP.has(tally.key)) add(group.where, tally.key, tally.n);
		} else if (tally.kind === 'when') {
			add(group.when, tally.key, tally.n);
		} else {
			add(group.publish, tally.key, tally.n);
		}
	}
	return group;
}

/**
 * THE ONE LOCK every writer of ONE user's dd1521 aggregates takes, transaction-scoped
 * (pg_advisory_xact_lock), BEFORE it reads what is there: the rebuild (delete + save
 * every day) and the incremental update (per day: "already saved?" + save). Without
 * it two rebuilds of the same user each deleted only the rows committed before they
 * started and both saved every day — every day's aggregate duplicated — and an
 * update racing either one saved a day the other was saving.
 */
async function lockUserStats(userId: number): Promise<void> {
	await acquireNodeLock(UA_SECTION, `user_${userId}`);
}

/** PHP delete_user_activity_stats: drop every dd1521 row of one user. */
export async function deleteUserActivityStats(userId: number): Promise<boolean> {
	await sql.unsafe(
		'DELETE FROM matrix_stats WHERE section_tipo = $1 AND (relation @> $2::text::jsonb OR relation @> $3::text::jsonb)',
		[UA_SECTION, ...userLocatorFilterPair(UA_USER, userId)],
	);
	return true;
}

interface DayGroup {
	what: Map<string, number>;
	where: Map<string, number>;
	when: Map<string, number>;
	publish: Map<string, number>;
}

/**
 * The aggregate-rebuild OUTCOME — an INTERNAL shape (never a wire body):
 * `ok` says whether the run completed, `value` carries what it produced
 * (the updated-day list, `0` for "already updated", `[]` for "no activity").
 */
export interface UpdateStatsResponse {
	ok: boolean;
	value: unknown;
	msg: string;
	errors: string[];
	[extra: string]: unknown;
}

/**
 * PHP update_user_activity_stats: aggregate the user's matrix_activity rows
 * from the day after the last saved stats day (or from the beginning) up to
 * YESTERDAY inclusive, one dd1521 record per day with data.
 */
export async function updateUserActivityStats(
	userId: number,
	maxDays = 0,
	/**
	 * Aggregation page size — a TEST SEAM only (production always takes the
	 * default). It exists so a gate can drive the SAVED dd1521 totals array, the
	 * artifact the wire contract actually pins, across a page boundary: without it
	 * that array is only ever produced from a single page.
	 */
	pageRows: number = AGGREGATE_PAGE_ROWS,
): Promise<UpdateStatsResponse> {
	const response: UpdateStatsResponse = {
		ok: false,
		value: false,
		msg: 'Error. Request failed. ',
		errors: [],
	};

	// last aggregated day (newest stats row of the user)
	const lastRows = (await sql.unsafe(
		'SELECT date FROM matrix_stats WHERE (relation @> $1::text::jsonb OR relation @> $2::text::jsonb) ORDER BY id DESC LIMIT 1',
		[...userLocatorFilterPair(UA_USER, userId)],
	)) as {
		date: Record<string, { start?: { year?: number; month?: number; day?: number } }[]> | null;
	}[];
	const lastStart = lastRows[0]?.date?.[UA_DATE]?.[0]?.start;
	let lastAggregated: Date | null = null;
	if (lastStart?.year && lastStart.month && lastStart.day) {
		lastAggregated = new Date(lastStart.year, lastStart.month - 1, lastStart.day);
	}

	// LEDGER — coverage plan §4.4 D5, CLOCK INCONSISTENCY, KNOWN-OPEN AND UNGATED.
	// today/yesterday are derived from the PROCESS-LOCAL clock, while the widget
	// that reads these aggregates (widgets/user_activity.ts activityWindow, and
	// its comment at :54-62) deliberately uses dbTimestamp()'s DEDALO_TIMEZONE
	// wall clock — the S1-03 lesson, re-learned in get_widget_data_differential
	// on 2026-07-11 just after midnight. On a UTC-hosted install in a non-UTC
	// zone the rebuild's "yesterday" and the widget's "yesterday" disagree for
	// part of every day. No gate: pinning either clock would freeze the
	// divergence as a contract. Fixing it is a behaviour change and needs a
	// wire-contract entry.
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today.getTime() - 24 * 3600 * 1000);
	if (lastAggregated !== null && lastAggregated.getTime() >= yesterday.getTime()) {
		response.ok = true;
		response.value = 0;
		response.msg = 'Stats are already updated';
		return response;
	}

	const isoDate = (date: Date): string =>
		`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
			date.getDate(),
		).padStart(2, '0')}`;

	// activity scan: [day after last, today)
	const from =
		lastAggregated !== null ? isoDate(new Date(lastAggregated.getTime() + 24 * 3600 * 1000)) : null;
	const { tallies, rows: rowCount } = await aggregateActivity(
		userId,
		from,
		isoDate(today),
		pageRows,
	);

	const dayGroups = groupTalliesByDay(tallies);

	if (rowCount === 0) {
		response.ok = true;
		response.msg = 'No activity records found';
		response.value = [];
		return response;
	}

	const updatedDays: { user: number; date: string }[] = [];
	for (const day of [...dayGroups.keys()].sort()) {
		if (maxDays > 0 && updatedDays.length >= maxDays) break;
		const [year, month, dayNum] = day.split('-').map(Number) as [number, number, number];
		const totals = dayTotals(dayGroups.get(day) as DayGroup);
		if (totals.length === 0) continue;

		// "already saved?" and the save, ONE unit under the user's stats lock (lockUserStats).
		const saved = await withTransaction(async () => {
			await lockUserStats(userId);
			return saveDayUnlessPresent(totals, userId, year, month, dayNum);
		});
		if (saved) updatedDays.push({ user: userId, date: day });
	}

	response.ok = true;
	response.value = updatedDays;
	response.msg =
		response.errors.length === 0 ? 'OK. Request done.' : 'Warning! Request done with errors';
	return response;
}

/** Save one day's aggregate unless the user already has it; true when it was saved. */
async function saveDayUnlessPresent(
	totals: Record<string, unknown>[],
	userId: number,
	year: number,
	month: number,
	dayNum: number,
): Promise<boolean> {
	const exists = (await sql.unsafe(
		`SELECT 1 FROM matrix_stats
		 WHERE (relation @> $1::text::jsonb OR relation @> $2::text::jsonb)
		   AND ("date"->'${UA_DATE}'->0->'start'->>'year')::int = $3
		   AND ("date"->'${UA_DATE}'->0->'start'->>'month')::int = $4
		   AND ("date"->'${UA_DATE}'->0->'start'->>'day')::int = $5
		 LIMIT 1`,
		[...userLocatorFilterPair(UA_USER, userId), year, month, dayNum],
	)) as unknown[];
	if (exists.length > 0) return false;
	await saveUserActivity(totals, userId, 'day', year, month, dayNum);
	return true;
}

/** The tallies folded per day (insertion order = first-seen day). */
function groupTalliesByDay(tallies: ActivityTally[]): Map<string, DayGroup> {
	const byDay = new Map<string, ActivityTally[]>();
	for (const tally of tallies) {
		const list = byDay.get(tally.day);
		if (list === undefined) byDay.set(tally.day, [tally]);
		else list.push(tally);
	}
	const dayGroups = new Map<string, DayGroup>();
	for (const [day, list] of byDay) dayGroups.set(day, foldTallies(list));
	return dayGroups;
}

/**
 * One day's dd1523 totals payload — what, where, when, publish, in that order.
 * A what item stores its action `key` only: no tipo, no baked label (the text
 * is resolved per reader lang from the labels engine at read time).
 */
function dayTotals(group: DayGroup): Record<string, unknown>[] {
	const totals: Record<string, unknown>[] = [];
	for (const [key, value] of group.what) {
		totals.push({ type: 'what', key, value });
	}
	for (const [tipo, value] of group.where) {
		totals.push({ type: 'where', tipo, value });
	}
	for (const [hour, value] of group.when) {
		totals.push({ type: 'when', hour: Number(hour), value });
	}
	for (const [tipo, value] of group.publish) {
		totals.push({ type: 'publish', tipo, value });
	}
	return totals;
}

/**
 * THE REBUILD of one user's dd1521 aggregates (database_info.rebuild_user_stats)
 * — ONE ATOMIC UNIT (OPS-6/PERF-11 review). It used to be a DELETE (autocommit)
 * followed by updateUserActivityStats' per-day saves (each its own autocommit
 * create + update), so any failure after the DELETE — a save that threw, a
 * statement cut by a lock bound or a shutdown, a crash — left the user's
 * statistics deleted or half rebuilt, and a day whose record could not be
 * created was skipped silently.
 *
 * Now the long part — the paged aggregation of the user's WHOLE activity log up
 * to yesterday and the day-totals planning — runs first, read-only and outside any
 * transaction (it may take minutes on a multi-million-row actor; a transaction
 * held open that long would pin the vacuum horizon). Then ONE short transaction
 * DELETEs the user's aggregates and saves every day; a failure rolls the whole
 * user back — the previous aggregates stand — and escapes typed. (!) Still
 * intentionally lossy when it SUCCEEDS and the activity log is shorter than the
 * stats history — an admin decision. Gate:
 * test/unit/user_stats_rebuild_atomic_native.test.ts.
 */
export async function rebuildUserActivityStats(
	userId: number,
	/** Aggregation page size — a TEST SEAM only (see updateUserActivityStats). */
	pageRows: number = AGGREGATE_PAGE_ROWS,
): Promise<UpdateStatsResponse> {
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const isoDate = (date: Date): string =>
		`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
			date.getDate(),
		).padStart(2, '0')}`;
	const { tallies, rows: rowCount } = await aggregateActivity(
		userId,
		null,
		isoDate(today),
		pageRows,
	);
	const dayGroups = groupTalliesByDay(tallies);
	const planned: { day: string; totals: Record<string, unknown>[] }[] = [];
	for (const day of [...dayGroups.keys()].sort()) {
		const totals = dayTotals(dayGroups.get(day) as DayGroup);
		if (totals.length > 0) planned.push({ day, totals });
	}

	const updatedDays = await withTransaction(async () => {
		// Serialized per user (lockUserStats): a second rebuild waits, then deletes
		// THIS one's committed rows and replaces them — never a duplicate day.
		await lockUserStats(userId);
		await deleteUserActivityStats(userId);
		const saved: { user: number; date: string }[] = [];
		for (const { day, totals } of planned) {
			const [year, month, dayNum] = day.split('-').map(Number) as [number, number, number];
			await saveUserActivity(totals, userId, 'day', year, month, dayNum);
			saved.push({ user: userId, date: day });
		}
		return saved;
	});

	return {
		ok: true,
		value: updatedDays,
		msg: rowCount === 0 ? 'No activity records found' : 'OK. Request done.',
		errors: [],
	};
}

/** One canonical stats dimension entry (PHP cross_users_range_data shape). */
export interface CanonicalEntry {
	key: string | number;
	label: string | null;
	value: number;
}

/** The canonical totals object {who, what, where, when, publish}. */
export interface CanonicalTotals {
	who: CanonicalEntry[];
	what: CanonicalEntry[];
	where: CanonicalEntry[];
	when: CanonicalEntry[];
	publish: CanonicalEntry[];
}

/**
 * One verticalized raw activity item (PHP get_interval_raw_activity_data). A
 * what item carries the action KEY (WHAT_ACTIONS) — never a label tipo.
 */
export type RawActivityItem =
	| { type: 'what'; key: string; value: number; label: string | null }
	| { type: 'where' | 'publish'; tipo: string; value: number }
	| { type: 'when'; hour: string | number; value: number };

const pad2 = (hour: number): string => String(hour).padStart(2, '0');

/** PHP dd_date::convert_date_to_seconds — the virtual 372-day-year calendar. */
export function virtualDateSeconds(year: number, month: number, day: number): number {
	return (year * 372 + (month - 1) * 31 + (day - 1)) * 86400;
}

/**
 * PHP get_interval_raw_activity_data: one flat pass over the user's
 * matrix_activity rows in [dateIn, dateOut) (exclusive upper bound),
 * verticalized to {type, key|tipo|hour, value} items — the same what-map /
 * where-skip / dd1223→publish routing as the per-day aggregation above.
 */
export async function getIntervalRawActivityData(
	userId: number,
	dateIn: string,
	dateOut: string,
): Promise<RawActivityItem[] | null> {
	// Day-keyed tallies folded into ONE set: the same paged, index-served
	// aggregation as the rebuild (its doc carries the why), flattened over the
	// whole interval. First-encounter order survives the flattening because
	// foldTallies orders by the global minimum id, not by day.
	const { tallies } = await aggregateActivity(userId, dateIn, dateOut);
	const { what, where, when, publish } = foldTallies(tallies);

	const { currentApplicationLang } = await import('../resolve/request_lang.ts');
	const labelOf = await whatLabelResolver(currentApplicationLang());
	const items: RawActivityItem[] = [];
	for (const [key, value] of what) {
		items.push({ type: 'what', key, value, label: await labelOf(key) });
	}
	for (const [tipo, value] of where) items.push({ type: 'where', tipo, value });
	for (const [hour, value] of when) items.push({ type: 'when', hour, value });
	for (const [tipo, value] of publish) items.push({ type: 'publish', tipo, value });
	return items;
}

/** A fresh 24-slot hour histogram (PHP pre-fill, keys 0..23, labels '00'..'23'). */
function emptyWhen(): CanonicalEntry[] {
	return Array.from({ length: 24 }, (_, hour) => ({
		key: hour,
		label: pad2(hour),
		value: 0,
	}));
}

/**
 * PHP cross_users_range_data: aggregate the saved dd1521 matrix_stats rows of
 * one user over [dateIn, dateOut] (inclusive day bounds) into the canonical
 * {who, what, where, when, publish}. Null when no stats rows exist in range.
 * Day-granular date compare over the stored dd1530 start triple (equivalent
 * to PHP's virtual-seconds bounds for the day records this section holds).
 *
 * ONE ROW PER DAY, LAST WRITTEN WINS (`DISTINCT ON (day) … ORDER BY day, id
 * DESC`). A stats row IS that day's totals, so two rows for one day are two
 * aggregation RUNS, not two facts: the writer resumes from its newest row and
 * only ever appends, so re-aggregating a user who still has old rows leaves
 * byte-identical twins behind. Measured on the oral-history archive: user 2 has
 * 191 duplicated days out of 416, which summed to 41,051 events over a log
 * holding 35,123. Folding both is not a bigger number, it is a wrong one — and
 * it only became visible when the widget started reading the whole history
 * (WC-2026-08-12-user-activity-full-history) instead of the last 365 days.
 * Highest `id` is the most recent run for that day.
 * (The duplicate ROWS are a separate, writer-side defect; this read refuses to
 * report them as activity.)
 *
 * LEDGER — TWO KNOWN-OPEN, UNGATED DEFECTS IN THE `make_date` PREDICATE BELOW
 * (coverage plan §4.4 D15 and D16; the gate
 * test/unit/user_stats_range_native.test.ts deliberately pins NEITHER, because
 * pinning a defect retires it):
 *  - D15 (a.k.a. L3) NARROWING: a stats row stored at YEAR- or MONTH-only
 *    granularity has a NULL month/day, so `make_date` yields NULL, `BETWEEN` is
 *    false, and the row is SILENTLY EXCLUDED. PHP compared the dd1530 virtual
 *    seconds and included it. An undocumented wire divergence: closing it means
 *    either widening the predicate or an engineering/wire_contract/ entry.
 *  - D16 (a.k.a. L2) HARD FAILURE: a MALFORMED stored date (month 0, day 32)
 *    makes `make_date` raise `date field value out of range`, which takes the
 *    ENTIRE query down — the activity widget then 500s for that user forever,
 *    with no per-row fail-soft.
 */
export async function crossUsersRangeData(
	dateIn: string,
	dateOut: string,
	userId: number,
	lang: string,
): Promise<CanonicalTotals | null> {
	const rows = (await sql.unsafe(
		`SELECT day.relation, day.totals
		 FROM (
		   SELECT DISTINCT ON (
		            make_date(
		              ("date"->'${UA_DATE}'->0->'start'->>'year')::int,
		              ("date"->'${UA_DATE}'->0->'start'->>'month')::int,
		              ("date"->'${UA_DATE}'->0->'start'->>'day')::int
		            )
		          )
		          relation, misc->$5 AS totals, id,
		          make_date(
		            ("date"->'${UA_DATE}'->0->'start'->>'year')::int,
		            ("date"->'${UA_DATE}'->0->'start'->>'month')::int,
		            ("date"->'${UA_DATE}'->0->'start'->>'day')::int
		          ) AS day_key
		   FROM matrix_stats
		   WHERE section_tipo = $6
		     AND (relation @> $1::text::jsonb OR relation @> $2::text::jsonb)
		     AND make_date(
		           ("date"->'${UA_DATE}'->0->'start'->>'year')::int,
		           ("date"->'${UA_DATE}'->0->'start'->>'month')::int,
		           ("date"->'${UA_DATE}'->0->'start'->>'day')::int
		         ) BETWEEN date($3) AND date($4)
		   ORDER BY day_key ASC, id DESC
		 ) day
		 ORDER BY day.day_key ASC, day.id ASC`,
		[...userLocatorFilterPair(UA_USER, userId), dateIn, dateOut, UA_TOTALS, UA_SECTION],
	)) as StatsRow[];
	// (!) NULL-VS-EMPTY, AND WHY IT CANNOT MOVE INTO THE PURE HALF.
	// `null` here does not describe the folded CONTENT — it is a statement about
	// the STORE: this user has no dd1521 row in the range, i.e. the history has
	// not been built yet, and the widget (user_activity.resolveActivityTotals)
	// branches on exactly that to decide whether tier 3 runs. `foldStatsRows` is
	// a total function over rows it is HANDED; it cannot tell "the query found
	// nothing" from "the caller chose to fold nothing", and making it nullable
	// would push a second, meaningless null into every other caller. So the
	// decision stays with the statement that produced the rows.
	if (rows.length === 0) return null;

	// termByTipo resolves where/publish SECTION tipos only (real nodes), in the
	// data lang; what keys go to the labels engine (see WHAT_ACTIONS) in the
	// APPLICATION lang — the same lang the raw tail uses, so one chart never
	// mixes two languages.
	const { termByTipo } = await import('../ontology/labels.ts');
	const { currentApplicationLang } = await import('../resolve/request_lang.ts');
	return foldStatsRows(
		rows,
		(tipo) => termByTipo(tipo, lang),
		(userKey) => resolveUserName(userKey, lang),
		await whatLabelResolver(currentApplicationLang()),
	);
}

/** The first and last calendar day this user has a saved dd1521 stats row for. */
export interface SavedStatsBounds {
	firstDay: string;
	lastDay: string;
}

/**
 * The SAVED span of one user's activity history: the min/max dd1530 day over
 * their dd1521 rows, or null when the store holds none.
 *
 * This is what makes the user_activity widget show the WHOLE history instead of
 * a fixed window (WC-2026-08-12-user-activity-full-history): the widget reads
 * the saved range this returns, and aggregates the raw log only for the tail
 * AFTER `lastDay` — so the cost of "everything" is the pre-aggregated rows,
 * which is what the nightly catch-up built them for.
 *
 * Same `make_date` triple as `crossUsersRangeData` deliberately — one date
 * expression, one exposure: the ledgered D15 (year/month-only rows excluded)
 * and D16 (malformed date raises) apply to both identically, so the bounds can
 * never disagree with the range read they bound.
 */
export async function savedStatsDayBounds(userId: number): Promise<SavedStatsBounds | null> {
	const rows = (await sql.unsafe(
		`SELECT to_char(min(day), 'YYYY-MM-DD') AS first_day,
		        to_char(max(day), 'YYYY-MM-DD') AS last_day
		 FROM (
		   SELECT make_date(
		            ("date"->'${UA_DATE}'->0->'start'->>'year')::int,
		            ("date"->'${UA_DATE}'->0->'start'->>'month')::int,
		            ("date"->'${UA_DATE}'->0->'start'->>'day')::int
		          ) AS day
		   FROM matrix_stats
		   WHERE section_tipo = $3
		     AND (relation @> $1::text::jsonb OR relation @> $2::text::jsonb)
		 ) days
		 WHERE day IS NOT NULL`,
		[...userLocatorFilterPair(UA_USER, userId), UA_SECTION],
	)) as { first_day: string | null; last_day: string | null }[];
	const first = rows[0]?.first_day ?? null;
	const last = rows[0]?.last_day ?? null;
	if (first === null || last === null) return null;
	return { firstDay: first, lastDay: last };
}

/** One `crossUsersRangeData` row as the SQL hands it over. */
export interface StatsRow {
	/**
	 * The `relation` COLUMN as stored — a per-tipo object (`{dd1522:[locator]}`),
	 * which is why `who` is permanently empty in production (see below). A flat
	 * locator ARRAY is tolerated and IS matched.
	 */
	relation: unknown;
	/** `misc->dd1523`: the component_json wrapper, a bare object, or null. */
	totals: { value?: unknown }[] | { value?: unknown } | null;
}

/**
 * The reduction half of `crossUsersRangeData` — TEST SEAM (precedent in this
 * file: `aggregateActivity`'s `pageRows`). Takes the already-fetched stats rows
 * plus the three label resolvers as injected functions, so the whole fold is
 * reachable without a database; the SQL stays in `crossUsersRangeData` because
 * `user_stats.ts` is the sole declared owner of LITERAL `matrix_stats` SQL
 * (sql_confinement_tripwire). The table is shared: the AI spend ledger
 * (security/ai_spend.ts, section dd660) reaches it through the ontology-resolved
 * name, every statement there scoped to `section_tipo = dd660`; every statement
 * here to `section_tipo = dd1521` or to a `relation @>` on the dd1521 user key
 * (UA_USER), which no dd660 row carries — disjoint rows.
 *
 * `resolveTerm` labels where/publish SECTION tipos; `resolveWhat` labels what
 * ACTION keys (the labels engine — never the ontology, see WHAT_ACTIONS). A
 * what item is read by `key` (v7 rows) or by its legacy `tipo` (PHP-era rows,
 * mapped through LEGACY_WHAT_TIPOS), so both generations fold into one entry.
 *
 * Memoisation of ALL resolvers lives here, not in the injected functions: a
 * key repeated across a year of rows must cost one lookup, not one per row.
 */
export async function foldStatsRows(
	rows: StatsRow[],
	resolveTerm: (tipo: string) => Promise<string | null>,
	resolveUser: (userKey: string) => Promise<string | null>,
	resolveWhat: (action: string) => Promise<string | null>,
): Promise<CanonicalTotals> {
	const memo = (resolve: (key: string) => Promise<string | null>) => {
		const cache = new Map<string, string | null>();
		return async (key: string): Promise<string | null> => {
			let label = cache.get(key);
			if (label === undefined) {
				label = await resolve(key);
				cache.set(key, label);
			}
			return label;
		};
	};
	const cachedTerm = memo(resolveTerm);
	const cachedWhat = memo(resolveWhat);

	const who = new Map<string, CanonicalEntry>();
	const what = new Map<string, CanonicalEntry>();
	const where = new Map<string, CanonicalEntry>();
	const publish = new Map<string, CanonicalEntry>();
	const when = new Map<number, CanonicalEntry>();
	for (const entry of emptyWhen()) when.set(Number(entry.key), entry);
	const userLabelCache = new Map<string, string | null>();

	for (const row of rows) {
		// unwrap component_json [{value, lang}] → the flattened totals array
		const rawTotals = row.totals;
		const wrapped = Array.isArray(rawTotals) ? rawTotals[0]?.value : rawTotals?.value;
		const totals = (Array.isArray(wrapped) ? wrapped.flat() : []) as {
			type?: string;
			key?: unknown;
			tipo?: string;
			hour?: unknown;
			value?: unknown;
		}[];
		if (totals.length === 0) continue;

		// the row's user — (!) PHP LIVE DEFECT, mirrored: array_find iterates
		// the relation COLUMN's first-level values (per-tipo ARRAYS, never
		// locator objects), so no user ever matches and the `who` dimension is
		// permanently EMPTY on live PHP (oracle-verified 2026-07-10; pinned in
		// get_widget_data_differential). When PHP fixes it, scan the flattened
		// locators for from_component_tipo === dd1522 here and reconcile.
		const relationColumn = row.relation as unknown as Record<string, unknown[]> | null;
		const relations = (
			Array.isArray(relationColumn) ? relationColumn : Object.values(relationColumn ?? {})
		) as { from_component_tipo?: string; section_tipo?: string; section_id?: unknown }[];
		const user = relations.find(
			(item) => item?.from_component_tipo === UA_USER && item?.section_tipo === USERS_SECTION,
		);
		const userKey = user !== undefined ? String(user.section_id) : null;

		let whereActionsTotal = 0;
		for (const item of totals) {
			const type = item?.type;
			// LEDGER — coverage plan §4.4 D4, second site (see mergeRawIntoCanonical
			// above for the full statement): a non-numeric stored value becomes NaN
			// and poisons the folded entry. KNOWN-OPEN; the fold's shape tolerance is
			// gated by test/unit/user_stats_range_native.test.ts, the NaN law itself
			// only by that file's merge twin (M11) — repairing it is a wire edit.
			const value = Number(item?.value ?? 0);
			if (type === 'what' || type === 'where' || type === 'publish') {
				if (type === 'where') whereActionsTotal += value;
				const key = type === 'what' ? whatItemKey(item) : String(item.tipo ?? '');
				const target = type === 'what' ? what : type === 'where' ? where : publish;
				const existing = target.get(key);
				if (existing !== undefined) {
					existing.value += value;
				} else {
					const label = type === 'what' ? await cachedWhat(key) : await cachedTerm(key);
					target.set(key, { key, label, value });
				}
			} else if (type === 'when') {
				const hourKey = Number(item.hour);
				const existing = when.get(hourKey);
				if (existing !== undefined) {
					existing.value += value;
				} else {
					when.set(hourKey, { key: hourKey, label: pad2(hourKey), value });
				}
			}
		}

		if (userKey !== null && whereActionsTotal > 0) {
			const existing = who.get(userKey);
			if (existing !== undefined) {
				existing.value += whereActionsTotal;
			} else {
				let label = userLabelCache.get(userKey);
				if (label === undefined) {
					label = await resolveUser(userKey);
					userLabelCache.set(userKey, label);
				}
				who.set(userKey, { key: userKey, label, value: whereActionsTotal });
			}
		}
	}

	const whenList = [...when.values()].sort((a, b) =>
		String(a.label) < String(b.label) ? -1 : String(a.label) > String(b.label) ? 1 : 0,
	);
	return {
		who: [...who.values()],
		what: [...what.values()],
		where: [...where.values()],
		when: whenList,
		publish: [...publish.values()],
	};
}

/**
 * The index key of a raw what/where/publish item — a what item's action
 * (whatItemKey), a where/publish item's tipo; '' (skip) when it has none.
 */
function rawItemKey(item: RawActivityItem): string {
	if (item.type === 'what') return whatItemKey(item as { key?: unknown; tipo?: unknown });
	const tipo = (item as { tipo?: unknown }).tipo;
	return typeof tipo === 'string' ? tipo : '';
}

/**
 * PHP merge_raw_into_canonical: fold raw items into the canonical totals —
 * fresh empty structure when canonical is null; `when` re-densified to the
 * 24-slot hour histogram; new keys resolve labels (raw `label` wins) — what
 * action keys through the labels engine (a legacy `tipo` is mapped via
 * LEGACY_WHAT_TIPOS, never resolved), where/publish tipos through termByTipo.
 */
export async function mergeRawIntoCanonical(
	canonical: CanonicalTotals | null,
	rawItems: RawActivityItem[],
	lang: string,
): Promise<CanonicalTotals> {
	const base: CanonicalTotals = canonical ?? {
		who: [],
		what: [],
		where: [],
		when: [],
		publish: [],
	};
	for (const dim of ['who', 'what', 'where', 'when', 'publish'] as const) {
		if (!Array.isArray(base[dim])) base[dim] = [];
	}

	const whenByHour = new Map<number, CanonicalEntry>();
	for (const entry of base.when) {
		if (entry !== null && typeof entry === 'object' && entry.key !== undefined) {
			whenByHour.set(Number(entry.key), entry);
		}
	}
	for (let hour = 0; hour < 24; hour++) {
		if (!whenByHour.has(hour)) {
			whenByHour.set(hour, { key: hour, label: pad2(hour), value: 0 });
		}
	}

	const index: Record<'what' | 'where' | 'publish', Map<string, CanonicalEntry>> = {
		what: new Map(),
		where: new Map(),
		publish: new Map(),
	};
	for (const dim of ['what', 'where', 'publish'] as const) {
		for (const entry of base[dim]) {
			if (entry !== null && typeof entry === 'object' && entry.key !== undefined) {
				index[dim].set(String(entry.key), entry);
			}
		}
	}

	// what labels in the APPLICATION lang (= the raw tail's, getIntervalRawActivityData);
	// `lang` (data lang) stays for the where/publish section terms.
	const { termByTipo } = await import('../ontology/labels.ts');
	const { currentApplicationLang } = await import('../resolve/request_lang.ts');
	const resolveWhat = await whatLabelResolver(currentApplicationLang());
	const labelCache: Record<'what' | 'where' | 'publish', Map<string, string | null>> = {
		what: new Map(),
		where: new Map(),
		publish: new Map(),
	};
	/** A new key's label: the raw `label` wins, else the dimension's resolver (memoised per dimension). */
	const labelOf = async (
		dim: 'what' | 'where' | 'publish',
		key: string,
		item: RawActivityItem,
	): Promise<string | null> => {
		const cache = labelCache[dim];
		let label = cache.get(key);
		if (label === undefined) {
			label =
				'label' in item && typeof item.label === 'string'
					? item.label
					: dim === 'what'
						? await resolveWhat(key)
						: await termByTipo(key, lang);
			cache.set(key, label);
		}
		return label;
	};

	for (const item of rawItems) {
		if (item === null || typeof item !== 'object') continue;
		// LEDGER — coverage plan §4.4 D4 (a.k.a. L4), NaN POISONING, KNOWN-OPEN.
		// A non-numeric stored value yields NaN; `NaN === 0` is false, so the
		// zero-guard below passes it through, `existing.value += NaN` poisons the
		// key, and JSON.stringify emits `null` on the wire. Present in
		// `foldStatsRows` too. GATED as CURRENT BEHAVIOUR (not as desirable) by
		// test/unit/user_stats_merge_native.test.ts case M11 — repairing it is a
		// wire edit and needs an engineering/wire_contract/ entry, not a silent fix.
		const value = Number((item as { value?: unknown }).value ?? 0);
		if (value === 0) continue;

		if (item.type === 'when') {
			const hour = Number(item.hour);
			if (hour < 0 || hour > 23 || Number.isNaN(hour)) continue;
			const slot = whenByHour.get(hour) as CanonicalEntry;
			slot.value += value;
			continue;
		}
		if (item.type === 'what' || item.type === 'where' || item.type === 'publish') {
			const key = rawItemKey(item);
			if (key === '') continue;
			const existing = index[item.type].get(key);
			if (existing !== undefined) {
				existing.value += value;
			} else {
				const entry: CanonicalEntry = { key, label: await labelOf(item.type, key, item), value };
				index[item.type].set(key, entry);
				base[item.type].push(entry);
			}
		}
	}

	base.when = [...whenByHour.entries()].sort((a, b) => a[0] - b[0]).map(([, entry]) => entry);
	return base;
}

/**
 * PHP save_user_activity: one dd1521 record per aggregated day — the user
 * locator, the granularity type, the dd_date and the totals payload, plus the
 * per-component meta counters and the standard creation metadata.
 */
async function saveUserActivity(
	totals: Record<string, unknown>[],
	userId: number,
	type: string,
	year: number,
	month: number | null,
	day: number | null,
): Promise<number> {
	const { createSectionRecord } = await import('../section/record/create_record.ts');
	// createSectionRecord answers a minted id or THROWS — a day is never skipped
	// silently (it used to be `if (!sectionId) return false` → `continue`).
	const sectionId = await createSectionRecord(UA_SECTION, -1);

	const start: Record<string, number> = { year };
	if (month !== null) start.month = month;
	if (day !== null) start.day = day;
	// dd_date virtual-calendar seconds (372-day years / 31-day months) — PHP
	// save_user_activity stores it and the PHP date-range search MATCHES ON IT:
	// a row without `time` is invisible to the PHP reader (coexistence).
	start.time = virtualDateSeconds(year, month ?? 1, day ?? 1);

	const userLocator = {
		id: 1,
		type: 'dd151',
		// int-canonical (WC-2026-08-10-section-id-int-canonical); the read
		// probes above OR both typed forms, so pre-sweep rows still match.
		section_id: userId,
		section_tipo: USERS_SECTION,
		from_component_tipo: UA_USER,
	};
	const counter = [{ count: 1 }];

	await sql.unsafe(
		`UPDATE matrix_stats
		 SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object($2::text, $3::text::jsonb),
		     string = COALESCE(string, '{}'::jsonb) || jsonb_build_object($4::text, $5::text::jsonb),
		     date = COALESCE(date, '{}'::jsonb) || jsonb_build_object($6::text, $7::text::jsonb),
		     misc = COALESCE(misc, '{}'::jsonb) || jsonb_build_object($8::text, $9::text::jsonb),
		     meta = COALESCE(meta, '{}'::jsonb) || $10::text::jsonb
		 WHERE section_tipo = $11 AND section_id = $1`,
		[
			sectionId,
			UA_USER,
			encodeForJsonb([userLocator]),
			UA_TYPE,
			encodeForJsonb([{ value: type, lang: 'lg-nolan', id: 1 }]),
			UA_DATE,
			encodeForJsonb([{ start, id: 1 }]),
			UA_TOTALS,
			encodeForJsonb([{ value: totals, lang: 'lg-nolan', id: 1 }]),
			encodeForJsonb({
				[UA_USER]: counter,
				[UA_TYPE]: counter,
				[UA_DATE]: counter,
				[UA_TOTALS]: counter,
			}),
			UA_SECTION,
		],
	);
	return sectionId;
}
