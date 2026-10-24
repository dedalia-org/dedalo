/**
 * Time Machine read — SQO mode 'tm' (PHP search_tm + tm_record +
 * section::get_tm_context). Lists a record's change history from
 * matrix_time_machine (flat columns, NOT the jsonb matrix shape) as the
 * standard read wire contract: a dd15 sections envelope whose entries carry
 * matrix_id/timestamp/caller/user facts, plus per-row component items.
 *
 * ONE PIPELINE (WC-2026-08-14-tm-cells-obey-list-emit-policy). This module owns
 * ROW ACQUISITION — the WHERE, the ORDER, the count, the envelope — and nothing
 * else. Every CELL is emitted by the shared `emitDdoData` in LIST mode over the
 * virtual dd15 record that `tm_record.ts` materializes per row, so the dd15 meta
 * columns and the caller section's own columns render through exactly the same
 * component emit hooks as they do in a section's own list: text_area truncation
 * and tag resolution, `fallback_value`, original-language forcing, the portal
 * subdatum. There is no second cell policy here any more; the flat columns are
 * transformed into component-shaped values ONCE, in `buildTmSectionRecord`.
 *
 * The only cell knowledge left in this file is `TM_CELL_DECORATORS` (the rsc329
 * note-navigation keys, which are not properties of any value) and the
 * superuser display name — both named, both small, both enumerable.
 *
 * FILTERS: filter_by_locators and/or conformed sqo.filter columns (the _tm
 * builder twins; the inspector/tool record-history cases —
 * section_tipo/section_id columns, optional tipo/lang narrowing). The
 * deleted-sections listing (sqo.filter with format:'column') is uncovered
 * scope and denies loudly. ORDER: the TM id column only (PHP default).
 *
 * PERMISSIONS: the dispatch read gates apply per SQO target (the CALLER
 * section, level >= 1). dd15's own columns resolve through the ordinary per-ddo
 * authz loop, floored by the §7.4 `time_machine_list` grant on the caller
 * section (WC-2026-08-14-tm-permission-floor); the unscoped browse is
 * global-admin only. The §7.4 grant IS the record scope of a non-admin's
 * history (owner decision 2026-10-22, WC-2026-10-22-tm-scope-whole-request):
 * the rows are the record's changes, so the projects filter does not confine
 * them — the TM tool's own rule. Only the per-(section, component) column check
 * narrows what a grant holder reads.
 */

import { config } from '../../config/config.ts';
import { isLangSlicedModel } from '../components/registry.ts';
import type { Ddo } from '../concepts/ddo.ts';
import type { EmitRow } from '../concepts/emit_row.ts';
import { compareLocators, type StoredSectionId } from '../concepts/locator.ts';
import type { Rqo } from '../concepts/rqo.ts';
import type { Sqo } from '../concepts/sqo.ts';
import { MATRIX_JSONB_COLUMNS, type MatrixJsonbColumn, type MatrixRecord } from '../db/matrix.ts';
import { sql } from '../db/postgres.ts';
import {
	ensureTmHistoryReady,
	tmHiddenPredicate,
	withTmEpoch,
	withTmHistory,
} from '../db/record_generation.ts';
import type { TimeMachineRow } from '../db/time_machine.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { resolveDataTipo } from '../ontology/alias.ts';
import { createDataCache } from '../ontology/cache_factory.ts';
import { termByTipo } from '../ontology/labels.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
	getTranslatableByTipo,
	savesInRequestLang,
	tipoBelongsToSection,
} from '../ontology/resolver.ts';
import { resolveDataframeSlotTipos, splitComposed } from '../relations/dataframe_slots.ts';
import { laneLaw, NOLAN } from '../relations/main_lanes.ts';
import { currentTimeMachineScopeSection } from '../section/list_definitions/tm_scope_context.ts';
import type {
	EmitDdo,
	EmitRowContext,
	SectionReadSource,
	SectionRow,
} from '../section/read_source.ts';
import { loadRecordCached } from '../section/record_loader.ts';
import { injectComponentData } from '../section_record/index.ts';
import { ddoIsAuthorized, type Principal, SUPERUSER_ID } from '../security/permissions.ts';
import { readLaneValueAt } from '../tm_record/lane_state.ts';
import { MALFORMED_RELATION_VALUE_ERROR } from '../tm_record/relation_snapshot_shape.ts';
import {
	buildTmSectionRecordWithRefusal,
	TM_COLUMN_BULK_PROCESS_ID as TIPO_BULK_PROCESS,
	TM_COLUMN_TIPO as TIPO_COMPONENT,
	TM_COLUMN_DATA as TIPO_DATA,
	TM_COLUMN_MATRIX_ID as TIPO_MATRIX_ID,
	TM_NOTES_TEXT as TIPO_NOTES,
	TM_COLUMN_SECTION_ID as TIPO_SECTION_ID,
	TM_COLUMN_SECTION_TIPO as TIPO_SECTION_TIPO,
	TM_COLUMN_TIMESTAMP as TIPO_TIMESTAMP,
	TM_COLUMN_USER_ID as TIPO_USER,
	TM_NOTES_SECTION_TIPO,
	type TmRecordRefusal,
} from '../tm_record/tm_record.ts';
import { EmissionContext } from './component_data.ts';
import { currentDataLang } from './request_lang.ts';
import type { StructureContextEntry } from './structure_context.ts';
import { conformTmFilter, type ParamSink } from './tm_filter.ts';

/**
 * The section-record TM list filters by a `tipo` COLUMN filter whose value is the
 * caller SECTION tipo (matrix_time_machine stores one record-level snapshot per
 * save with tipo = section_tipo, plus per-component rows). PHP scopes by it
 * (WHERE tipo = q); extract that value. Returns null when no such filter is set.
 */
function tipoColumnFilter(sqo: Record<string, unknown>): string | null {
	const filter = sqo.filter as { $and?: { q?: unknown; column_name?: unknown }[] } | undefined;
	const clause = filter?.$and?.find((c) => c?.column_name === 'tipo');
	return clause !== undefined && typeof clause.q === 'string' && clause.q !== '' ? clause.q : null;
}

/** TM virtual section + the users section (the rest come from tm_record.ts). */
const TM_SECTION_TIPO = 'dd15';

/** The two properties that ADDRESS a record — the locator pair, nothing else. */
const LOCATOR_ADDRESS_PROPERTIES = ['section_tipo', 'section_id'] as const;

/**
 * dd15 list-column tipo → the matrix_time_machine FLAT COLUMN its header-click
 * sorts by. dd15's columns ARE the table's own columns, so each maps 1:1 (PHP
 * search_tm orders over the same columns); the raw 'id'/'section_id'
 * pseudo-columns are the service defaults and pass through. A tipo that is not
 * here is uncovered scope and throws loudly in queryTmRows.
 *
 * (!) THIS MAP IS dd15-ONLY. In an ORDINARY section the record's id IS
 * `section_id`, and order_path.ts encodes that for every component_section_id
 * column — untouched by this map. dd15 is the exception: its rows have their own
 * PK (`id`, surfaced as matrix_id), so it has TWO id-ish columns that must not
 * be conflated —
 *   dd1573 "Id"         → `id`          the TM ROW's own id
 *   dd1212 "Section id" → `section_id`  the CALLER record's id (lg-spa term is
 *                                       literally "section_id")
 * dd1573 was absent here while tm_filter already resolved it to `id`, so the Id
 * column could be FILTERED but not SORTED — its header click fell through to the
 * uncovered-scope throw, leaving dd1212 as the only id-ish column that sorted.
 * Exported so tm_sort_policy.test.ts can pin the pair without a DB round-trip.
 */
export const TM_ORDER_COLUMN: Readonly<Record<string, string>> = {
	id: 'id',
	// The client's built-in leading "Id" column sends the `section_id`
	// PSEUDO-column — its descriptor means "the record's OWN id", not the literal
	// column name (view_default_list_section.rebuild_columns_map: `tipo:
	// 'section_id' // used to sort only`, path component_tipo 'section_id'). In an
	// ordinary section those coincide. In dd15 they DO NOT: the envelope addresses
	// each snapshot by the TM row PK (`section_id: row.id`, tmReadSource.getRows),
	// so the Id box DISPLAYS `id` — mapping its sort to the `section_id` column
	// made the column sort by something it does not show (the caller record's id),
	// which is why clicking Id returned 61468923, 4, 38, 28, … . Resolve the
	// pseudo-column to what dd15 actually displays: `id`.
	section_id: 'id',
	[TIPO_MATRIX_ID]: 'id', // dd1573 Id — the PK, the cheapest sort on the table
	// dd1212 is the CALLER record's id — a real, separate column, shown in its own
	// "Section id" column. It keeps ordering by `section_id`.
	[TIPO_SECTION_ID]: 'section_id', // dd1212 Section id — the caller record's id
	[TIPO_SECTION_TIPO]: 'section_tipo', // dd1772 Section tipo
	[TIPO_TIMESTAMP]: 'timestamp', // dd559 When
	[TIPO_COMPONENT]: 'tipo', // dd577 What (section tipo)
	[TIPO_USER]: 'user_id', // dd578 Who
	[TIPO_BULK_PROCESS]: 'bulk_process_id', // dd1371 Process
	[TIPO_DATA]: 'data', // dd1574 record snapshot (jsonb — total-ordered by PG)
};

/**
 * Bare-browse COUNT(*) cache (see tmReadSource.count). Data-event wired: ANY
 * record save/delete may append TM rows, so any section write clears it; the
 * TTL stamp bounds staleness against out-of-band (non-engine) inserts.
 */
const tmBareCountCache = createDataCache<string, { value: number; at: number }>((cache) =>
	cache.clear(),
);
const USERS_SECTION_TIPO = 'dd128';

// The dd128 component shown as the dd578 username SUBDATUM is no longer resolved
// here. It used to be read by hand off dd578's `source.request_config[0].show
// .ddo_map[0].tipo` because the cell was hand-built; hardcoding it as 'dd132' had
// previously reddened three TM gates when the shared ontology moved the ddo to
// dd452 (S2-43 channel 2). The generic portal emission reads that same
// request_config, so the ontology is once again the only place the answer lives.

/**
 * The row shape this reader selects (a superset of the shared TimeMachineRow:
 * it also pulls the record-level snapshot `data` for the list view). The fields
 * consumed by buildTmSectionRecord are exactly TimeMachineRow's.
 */
interface TmRow {
	id: number;
	section_id: number;
	section_tipo: string;
	tipo: string;
	lang: string;
	timestamp: string;
	user_id: number;
	bulk_process_id: number | null;
	/** The record-level snapshot (a full matrix-record jsonb) for the list view. */
	data: Record<string, unknown> | null;
}

/**
 * THE HISTORY OF ONE LANGUAGE of a main (two lanes — relations/main_lanes.ts,
 * WC-2026-09-27-bulk-revert-undo-log addendum "two lanes"): a main records its
 * frames (and its lg-nolan value) in the shared lg-nolan lane, so its timeline
 * in language X is the rows of lane X AND of lane lg-nolan —
 * `lang IN (X, 'lg-nolan')` — for EVERY locator. No slot lookup decides it:
 * the writer files an lg-nolan frame row for any slot holding the main's
 * frames, a declared one or an undeclared live one (dataframe_slots.ts
 * readMainSlots), and a main with no frame lane simply has no lg-nolan row of
 * it to add. An UNSLICED main never reaches this clause: its one lane is every
 * row whatever the tag (timelineScope drops the lang).
 */
function laneClause(param: string): string {
	return `lang IN (${param}, 'lg-nolan')`;
}

/**
 * THE TIMELINE OF A TRANSLITERABLE MAIN (`with_lang_versions`, e.g. rsc85 in
 * rsc197; and a non-translatable component_iri — every main whose saves keep
 * the request lang without being translatable, resolver.ts
 * savesInRequestLang): the tool asks for it in `lg-nolan` (its context lang),
 * but its versions live in their language lanes (Augustus lg-nolan, Αύγουστος
 * lg-ell). Such a locator is read in the request's DATA language — lang IN
 * (data lang, 'lg-nolan'): the base, the frames and the version of the
 * language the curator works in. A COPY of the scope; the caller's SQO is
 * never mutated.
 */
async function timelineScope(sqo: Record<string, unknown>): Promise<Record<string, unknown>> {
	if (!Array.isArray(sqo.filter_by_locators)) return sqo;
	const dataLang = currentDataLang();
	const locators: unknown[] = [];
	for (const locator of sqo.filter_by_locators as Record<string, unknown>[]) {
		if (await isUnslicedMainLocator(locator)) {
			locators.push(withoutLang(locator));
		} else {
			locators.push((await readsInDataLang(locator)) ? { ...locator, lang: dataLang } : locator);
		}
	}
	return { ...sqo, filter_by_locators: locators };
}

/**
 * Whether a locator names a main whose data is NOT lang-sliced (every relation
 * model, decision 2026-09-29): its history is ONE lane whatever the row tag —
 * a PHP save of a relation flagged translatable was tagged with the data lang
 * and held the WHOLE value, exactly like an lg-nolan row (readRowLaneState
 * reads it so) — so every language's timeline lists ALL its rows: no lang
 * clause at all.
 */
async function isUnslicedMainLocator(locator: Record<string, unknown>): Promise<boolean> {
	const { tipo, lang } = locator;
	if (typeof lang !== 'string' || lang === '' || typeof tipo !== 'string' || tipo === '')
		return false;
	return isUnslicedMain(tipo);
}

/** A main whose data is not lang-sliced: its history is ONE lane, whatever tag or request lang. */
async function isUnslicedMain(tipo: string): Promise<boolean> {
	const model = await getModelByTipo(tipo);
	return model !== null && isMainValueModel(model) && !isLangSlicedModel(model);
}

/** A copy of a locator without its lang (the caller's SQO is never mutated). */
function withoutLang(locator: Record<string, unknown>): Record<string, unknown> {
	const { lang: _lang, ...rest } = locator;
	return rest;
}

/**
 * Whether a locator asks, in lg-nolan, for a non-translatable LANG-SLICED main
 * that keeps language versions (an unsliced main's one lane is lg-nolan).
 */
async function readsInDataLang(locator: Record<string, unknown>): Promise<boolean> {
	const { tipo, lang } = locator;
	if (lang !== 'lg-nolan' || typeof tipo !== 'string' || tipo === '') return false;
	if (await getTranslatableByTipo(tipo)) return false;
	return keepsLangVersions(tipo);
}

/** A LANG-SLICED main whose saves keep the request lang (resolver.ts savesInRequestLang). */
async function keepsLangVersions(tipo: string): Promise<boolean> {
	const model = await getModelByTipo(tipo);
	return model !== null && isLangSlicedModel(model) && (await savesInRequestLang(tipo, model));
}

/**
 * Build the WHERE for a TM query. `filter_by_locators` → per-component history
 * (OR of locator groups). Else a `tipo` column filter → the record-snapshot LIST
 * (WHERE tipo = q, matching PHP). Returns whether it is the record-list surface
 * (its rows carry a full-record snapshot whose component columns are the display).
 *
 * NO scope at all — a bare dd15 list (`section_tipo:['dd15']`, no
 * filter_by_locators, no tipo filter), which the client sends when the Time
 * Machine section is opened directly — matches PHP `search_tm` whose
 * build_main_where() is intentionally EMPTY: it returns ALL matrix_time_machine
 * rows (newest-first, paginated), NOT an error and NOT empty. So the where is
 * `true` and it renders as the who/when/where/what history (isRecordList=false).
 */
function buildTmWhere(sqo: Record<string, unknown>): {
	whereSql: string;
	params: unknown[];
	isRecordList: boolean;
	/** The where carries a RANGE predicate — see ParamSink.rangePredicate and the
	 * PLANNER BARRIER note in queryTmRows. Only the conformed component filter can
	 * produce one; locator and tipo scopes are pure equality. */
	rangeFilter: boolean;
} {
	const params: unknown[] = [];
	const locators = Array.isArray(sqo.filter_by_locators)
		? (sqo.filter_by_locators as Record<string, unknown>[])
		: [];
	if (locators.length > 0) {
		const groups = locators.map((locator) => {
			const clauses: string[] = [];
			params.push(String(locator.section_tipo ?? ''));
			clauses.push(`section_tipo = $${params.length}`);
			params.push(Number(locator.section_id ?? 0));
			clauses.push(`section_id = $${params.length}`);
			if (typeof locator.tipo === 'string' && locator.tipo !== '') {
				params.push(locator.tipo);
				clauses.push(`tipo = $${params.length}`);
			}
			if (typeof locator.lang === 'string' && locator.lang !== '') {
				params.push(locator.lang);
				clauses.push(laneClause(`$${params.length}`));
			}
			return `(${clauses.join(' AND ')})`;
		});
		return {
			whereSql: `(${groups.join(' OR ')})`,
			params,
			isRecordList: false,
			rangeFilter: false,
		};
	}
	const tipoFilter = tipoColumnFilter(sqo);
	if (tipoFilter !== null) {
		params.push(tipoFilter);
		return { whereSql: `tipo = $${params.length}`, params, isRecordList: true, rangeFilter: false };
	}
	// The standalone dd15 list search: conform component clauses to the flat
	// matrix_time_machine columns (PHP search_tm + the _tm traits). Absent this,
	// every component filter was silently ignored (the whole list came back).
	const sink: ParamSink = { params };
	const componentSql = conformTmFilter(sqo.filter, sink);
	if (componentSql !== null && componentSql !== '') {
		return {
			whereSql: componentSql,
			params,
			isRecordList: false,
			rangeFilter: sink.rangePredicate === true,
		};
	}
	// No scope → the bare dd15 list: ALL TM rows (PHP search_tm empty where).
	return { whereSql: 'true', params, isRecordList: false, rangeFilter: false };
}

/**
 * The ORDER BY clause for the plain TM page query, TABLE-QUALIFIED ALWAYS.
 *
 * The select list aliases `timestamp::text AS timestamp`, and in SQL a BARE
 * `ORDER BY timestamp` binds to the OUTPUT COLUMN, not the table column — so the
 * sort silently became "order by this computed text expression", which no index
 * can serve. The planner's only option was a parallel seq scan + top-N sort of
 * all 50.5M rows: the When header click measured 17 863 ms (19 583 ms live).
 * Qualifying as `tm."timestamp"` binds to the COLUMN, and the (timestamp, id
 * DESC) index serves it at 0.359 ms — the SAME rows in the same order, because
 * text and timestamp ordering coincide here (PG renders ISO with trimmed
 * trailing zeros, so fraction digits compare lexicographically exactly as they
 * compare numerically; verified identical over the first 2000 rows despite
 * 49.6M rows carrying fractional seconds).
 *
 * `timestamp` is the ONLY aliased field in that select — id/tipo/data/section_id
 * are emitted unaliased — which is why only the When sort was affected. Every
 * column is qualified anyway so a future alias cannot reintroduce this silently.
 * Extracted + exported so tm_sort_policy.test.ts can pin the qualification.
 */
export function buildTmOrderSql(orderColumn: string, direction: 'ASC' | 'DESC'): string {
	const col = `tm."${orderColumn}"`;
	// Stable ORDER BY: the non-unique sort columns (bulk saves share a timestamp,
	// bulk_process_id, section_tipo, …) get the PK `id` as tiebreaker so OFFSET
	// pages don't shuffle under ties. 'id'/'section_id' keep their exact prior
	// single-column SQL (section_id's tie behaviour is byte-gated — don't perturb).
	return orderColumn === 'id' || orderColumn === 'section_id'
		? `${col} ${direction}`
		: `${col} ${direction}, tm."id" ${direction}`;
}

export interface TmReadData {
	data: Record<string, unknown>[];
	/** Ledger of requested ddos this reader does not model. */
	unhandled: string[];
}

/**
 * The SUPERUSER display name in a history Who column (PHP
 * component_input_text::get_list_value, the 'tm' branch).
 *
 * The superuser row (-1) typically stores no display name, so the generic portal
 * emission resolves an empty username slice and the Who column renders blank —
 * on installs where most history was written by root, that is most of the
 * column. PHP hard-resolves it to 'Root'; this keeps that, applied to whichever
 * nested subdatum item the portal emitted rather than to a hand-built cell.
 *
 * Kept as an explicit named step (not folded into a component hook): it is a
 * property of the USERS section's superuser row, not of any component model.
 */
function applySuperuserDisplayName(slice: Record<string, unknown>[], userId: number): void {
	if (Number(userId) !== SUPERUSER_ID) return;
	// The item is ADDRESSED by a locator pair, so it is compared as one: the
	// locator law owns section_id equality (loose-numeric — a stored '-1' matches
	// -1, which an inline === would miss), and S2-04/DEC-21 forbids re-deriving
	// that rule inline anywhere but concepts/locator.ts.
	const superuserLocator = { section_tipo: USERS_SECTION_TIPO, section_id: SUPERUSER_ID };
	for (const item of slice) {
		if (!compareLocators(item as never, superuserLocator as never, LOCATOR_ADDRESS_PROPERTIES)) {
			continue;
		}
		const entries = item.entries;
		const empty =
			entries === null ||
			entries === undefined ||
			(Array.isArray(entries) &&
				(entries.length === 0 ||
					entries.every(
						(entry) =>
							entry === null ||
							typeof entry !== 'object' ||
							(entry as { value?: unknown }).value === undefined ||
							(entry as { value?: unknown }).value === '',
					)));
		if (empty) item.entries = [{ value: 'Root', lang: 'lg-nolan' }];
	}
}

/** The TM row-plus that a SectionRow carries in `raw` for emitTmRow. */
interface TmRawRow {
	row: TmRow;
	isRecordList: boolean;
}

/**
 * COUNT(*) for a TM where-shape, with the bare-browse cache. The BARE browse (no
 * scope, whereSql 'true') is a full-table COUNT(*) on the append-only TM table —
 * the only expensive count surface (the scoped ones are index-served). Serve it
 * from the data-event cache: every save this engine performs clears it (saves are
 * exactly when TM grows), with TM_COUNT_CACHE_TTL_MS as the freshness backstop for
 * out-of-band inserts. 0 disables (exact every time — the parity-environment
 * setting). Shared by the count surface (tmReadSource.count) AND the deep-page
 * ORDER-FLIP in queryTmRows, which needs the row total to fetch a far page from
 * the opposite end.
 */
async function tmCount(whereSql: string, params: unknown[]): Promise<number> {
	await ensureTmHistoryReady();
	const ttl = config.ops.tmCountCacheTtlMs;
	const bare = whereSql === 'true';
	if (bare && ttl > 0) {
		const hit = tmBareCountCache.get('bare');
		if (hit !== undefined && Date.now() - hit.at < ttl) return hit.value;
	}
	const rows = (await sql.unsafe(tmHistoryCountSql(whereSql), params)) as { c: number }[];
	const value = Number(rows[0]?.c ?? 0);
	if (bare && ttl > 0) {
		tmBareCountCache.set('bare', { value, at: Date.now() });
	}
	return value;
}

/**
 * The VISIBLE-history COUNT of a TM where-shape, as TOTAL − HIDDEN in ONE
 * statement (one snapshot, so the two halves can never disagree about a
 * concurrent insert).
 *
 * WHY NOT ONE COUNT UNDER withTmHistory. `tm_role` is in no full index, so
 * the `tm_role IS NULL` half forces the count onto the heap: the bare dd15 count
 * measured 15,020 ms (Parallel Seq Scan + Nested Loop Anti Join) against
 * 3,072 ms index-only before the column existed (29.45M rows, dedalo_mib_v7,
 * TM count TTL 0 = every list open pays it). Here the TOTAL keeps the
 * epoch-narrowed index-only count it always had, and the HIDDEN half
 * (`tm_role IS NOT NULL`) is index-only on the partial
 * matrix_time_machine_tm_role_hidden_idx (migration 0011), which holds only the
 * undo-log rows. Exact: every row is either visible (NULL) or hidden, and both
 * halves carry the same scope and epoch. Plan shape pinned by
 * tm_count_index_only_plan_native.
 *
 * EXPORTED for that gate, which EXPLAINs the exact emitted statement.
 */
export function tmHistoryCountSql(whereSql: string): string {
	return `SELECT ((SELECT COUNT(*) FROM matrix_time_machine WHERE ${withTmEpoch(whereSql)})
	              - (SELECT COUNT(*) FROM matrix_time_machine
	                  WHERE ${withTmEpoch(whereSql)} AND ${tmHiddenPredicate()}))::int AS c`;
}

/**
 * THE ROW BACKSTOP: inside a Time Machine read scope opened for section S (the
 * §7.4 gate admitted S), the SQO this WHERE is built from must address S and
 * only S. The gate and the scope judge the SQO the client SENT; anything that
 * rewrites it later (the session read-back, a future server-side merge) could
 * otherwise point the WHERE at another section's history — or at the bare
 * browse — under S's admission. Principal-agnostic and fail-closed: a mismatch
 * is refused (`perm.denied`), never narrowed. An unscoped open (bare browse,
 * mixed pins) is already admin-only at the gate and the floor; no open at all
 * is a direct server caller (no request principal to judge).
 * WC-2026-10-22-tm-scope-whole-request (review r1 addendum).
 */
async function assertTmWhereInOpenedScope(sqo: Record<string, unknown>): Promise<void> {
	const opened = currentTimeMachineScopeSection();
	if (opened === undefined) return;
	const { resolveTimeMachineScopeSection } = await import(
		'../section/list_definitions/time_machine_list.ts'
	);
	const addressed = resolveTimeMachineScopeSection(sqo);
	if (!addressed.mixed && addressed.sectionTipo === opened) return;
	throw new DedaloError('perm.denied', {
		message: 'Time machine read addresses a section other than the one its access was granted for',
		coordinates: { section_tipo: opened },
	});
}

/**
 * Query matrix_time_machine for one request (the two scoping surfaces of
 * buildTmWhere) and return the ordered/paginated rows plus which surface it is.
 * The sqo may be raw (direct readTimeMachineData) or sanitized (via the generic
 * readSectionRows) — both carry filter/filter_by_locators/order/limit/offset.
 */
async function queryTmRows(
	sqo: Record<string, unknown>,
): Promise<{ rows: TmRow[]; isRecordList: boolean }> {
	// Every shape below is narrowed by withTmHistory: the generation epoch AND
	// `tm_role IS NULL`, so a bulk run's undo-log rows (hidden BEFORE images,
	// birth markers, cascade snapshots) never reach the list, the count, the
	// component history or the dd1371 filters. The epoch half names the
	// generation store; ensure it exists first (see record_generation.ts).
	await ensureTmHistoryReady();
	await assertTmWhereInOpenedScope(sqo);
	// TWO scoping surfaces (see buildTmWhere): the per-record component HISTORY
	// (filter_by_locators) and the section-record LIST (the tool_time_machine
	// browse: one row per record-level snapshot, tipo = caller section_tipo — PHP
	// applies the tipo column filter, WHERE tipo = q). A dd578 USER relation filter
	// is still IGNORED (PHP ignores it; tm_relation_filter_differential pins that).
	const {
		whereSql,
		params: scopeParams,
		isRecordList,
		rangeFilter,
	} = buildTmWhere(await timelineScope(sqo));

	// Order: dd15's list columns ARE matrix_time_machine's own flat columns, so a
	// header-click sort maps 1:1 to a real column (PHP search_tm orders over the
	// same columns). The client sends the column's component_tipo — map it to its
	// flat column; the raw 'id' (service default) and 'section_id' pseudo-columns
	// pass through. An unmapped tipo is still uncovered scope and throws loudly.
	const order = Array.isArray(sqo.order) ? (sqo.order as Record<string, unknown>[]) : [];
	const orderPath = (order[0]?.path as Record<string, unknown>[] | undefined)?.[0];
	const orderCol = orderPath?.component_tipo;
	const orderColumn = orderCol === undefined ? 'id' : TM_ORDER_COLUMN[String(orderCol)];
	if (orderColumn === undefined) {
		throw new DedaloError('engine.uncovered_scope', {
			message: `TM read: order by '${orderCol}' is uncovered scope`,
			coordinates: { order_column: String(orderCol) },
		});
	}
	const direction = String(order[0]?.direction ?? 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
	// TABLE-QUALIFIED, ALWAYS. The select list aliases `timestamp::text AS
	// timestamp`, and in SQL a BARE `ORDER BY timestamp` binds to the OUTPUT
	// COLUMN, not the table column — so the sort silently became "order by this
	// computed text expression", which no index can serve. The planner's only
	// option was a parallel seq scan + top-N sort of all 50.5M rows: the When
	// header click measured 17 863 ms (reported at 19 583 ms live). Qualifying it
	// as `tm."timestamp"` binds to the COLUMN and the (timestamp, id DESC) index
	// serves it — 0.359 ms, the same rows in the same order (text and timestamp
	// ordering are identical here: PG renders ISO with trimmed trailing zeros, so
	// the fraction digits compare lexicographically exactly as they compare
	// numerically; verified equal over the first 2000 rows despite 49.6M rows
	// carrying fractional seconds). `timestamp` is the ONLY aliased field in that
	// select — id/tipo/data/section_id are emitted unaliased, which is why only
	// the When sort was affected — but every column is qualified now so a future
	// alias cannot reintroduce this silently.
	const orderSql = buildTmOrderSql(orderColumn, direction);

	const limit = Number(sqo.limit ?? 10);
	const offset = Number(sqo.offset ?? 0);
	const params = [...scopeParams, limit, offset];

	// Deep-page acquisition on the unique `id` order (bare browse + record-snapshot
	// list, both PK/(tipo,id)-index-served). A plain OFFSET makes Postgres walk and
	// discard every skipped row — ≈3.7 s at offset 50 M on a 50 M-row table, even on
	// an index-only scan. Two compounding rewrites, both EXACT because `id` is the
	// unique, monotonic PK:
	//   1. ORDER-FLIP: a page in the far half is the SAME set of rows fetched from
	//      the OTHER end with a small offset, then reversed in memory. The last page
	//      ("navigate to the last records") becomes OFFSET 0 (≈0.1 ms, ~35000×).
	//      Needs the row total N (cached for the bare browse); paid only once we are
	//      already deep. No worse under concurrent inserts than plain OFFSET already
	//      is (TM is append-only; the count cache clears on every engine save).
	//   2. LATE ROW LOOKUP: find the page of ids on a narrow index scan first, then
	//      join back for the wide `data` jsonb — never reads a skipped row's snapshot.
	// The section_id order path keeps the plain query below: its sort key has ties,
	// and page membership under ties must not be perturbed (byte-gated reads).
	// PLANNER BARRIER (2026-07-26). A RANGE predicate combined with the `id` sort
	// has NO index that carries both — `("timestamp", id DESC)` orders by timestamp
	// across a range, the PK orders by id but cannot scope. The planner resolves
	// that by walking the `id` PK and filtering inline, betting that LIMIT lets it
	// stop early. On this APPEND-ONLY log the bet is exactly backwards: the filtered
	// column correlates with `id`, so every match sits at the far end and the walk
	// discards the whole prefix — a 2026 When-search discarded 45,992,453 PK entries
	// to return 10 rows (48.9 s at offset 1000, and 51.2 s at offset 30 — this is
	// NOT a deep-page problem). `OFFSET 0` in the innermost select is an
	// optimisation barrier: it blocks the LIMIT pushdown, so the range is scanned
	// index-only and top-N sorted — 440 ms / 770 ms, same rows, same order, no
	// correlation assumption. Applied ONLY for (range filter × id order): an
	// EQUALITY filter is served outright by its `(col, id DESC)` index at 2.6 ms and
	// barriering it would make it ~170x slower. Same family as the WC-046 rewrite
	// below, which is about page DEPTH and does not address this.
	const useBarrier = rangeFilter && orderColumn === 'id';
	if (useBarrier) {
		const barrierParams = [...scopeParams, limit, offset];
		const rows = (await sql.unsafe(
			`SELECT tm.id, tm.section_id, tm.section_tipo, tm.tipo, tm.lang, tm.timestamp::text AS timestamp, tm.user_id, tm.bulk_process_id, tm.data
			 FROM matrix_time_machine tm
			 JOIN (SELECT id FROM (SELECT id FROM matrix_time_machine
			                       WHERE ${withTmHistory(whereSql)}
			                       OFFSET 0) scoped
			       ORDER BY id ${direction}
			       LIMIT $${barrierParams.length - 1} OFFSET $${barrierParams.length}) page ON page.id = tm.id
			 ORDER BY tm.id ${direction}`,
			barrierParams,
		)) as TmRow[];
		return { rows, isRecordList };
	}

	const lateThreshold = config.ops.searchLateRowLookupOffset;
	if (lateThreshold >= 0 && offset >= lateThreshold && orderColumn === 'id') {
		let effDirection = direction;
		let effOffset = offset;
		let effLimit = limit;
		let reverse = false;
		const total = await tmCount(whereSql, scopeParams);
		// ascOffset = rows to skip from the opposite end for the same page. Flip only
		// when it strictly shortens the walk (offset in the far half) and a page exists.
		const ascOffset = total - offset - limit;
		if (total > offset && ascOffset < offset) {
			effDirection = direction === 'ASC' ? 'DESC' : 'ASC';
			effOffset = Math.max(0, ascOffset); // clamp: last partial page skips 0 from the end
			effLimit = Math.min(limit, total - offset); // last partial page has < limit rows
			reverse = true;
		}
		const lateParams = [...scopeParams, effLimit, effOffset];
		const rows = (await sql.unsafe(
			tmLatePageSql(whereSql, effDirection, lateParams.length),
			lateParams,
		)) as TmRow[];
		// The flip fetched the page in the opposite order; restore the requested one.
		if (reverse) rows.reverse();
		return { rows, isRecordList };
	}

	const rows = (await sql.unsafe(
		`SELECT id, section_id, section_tipo, tipo, lang, timestamp::text AS timestamp, user_id, bulk_process_id, data
		 FROM matrix_time_machine tm
		 WHERE ${withTmHistory(whereSql, 'tm')}
		 ORDER BY ${orderSql}
		 LIMIT $${params.length - 1} OFFSET $${params.length}`,
		params,
	)) as TmRow[];
	return { rows, isRecordList };
}

/**
 * THE DEEP-PAGE LATE ROW LOOKUP (see queryTmRows): the page of ids found on a
 * narrow index walk, joined back for the wide `data`. `paramCount` is the bind
 * list's length: its last two are LIMIT and OFFSET.
 *
 * The id walk carries `withTmHistory` (`tm_role IS NULL`), which no FULL index
 * holds — it stays index-only on the PARTIAL
 * `matrix_time_machine_history_visible_idx` (migration 0012), whose predicate
 * it implies. Without it the walk read the heap: 8.9-10.0 s vs 4.1 s at OFFSET
 * 5M on 29.06M rows. Pinned by tm_count_index_only_plan_native.
 */
export function tmLatePageSql(whereSql: string, direction: string, paramCount: number): string {
	return `SELECT tm.id, tm.section_id, tm.section_tipo, tm.tipo, tm.lang, tm.timestamp::text AS timestamp, tm.user_id, tm.bulk_process_id, tm.data
			 FROM matrix_time_machine tm
			 JOIN (SELECT id FROM matrix_time_machine
			       WHERE ${withTmHistory(whereSql)}
			       ORDER BY id ${direction}
			       LIMIT $${paramCount - 1} OFFSET $${paramCount}) page ON page.id = tm.id
			 ORDER BY tm.id ${direction}`;
}

/** The envelope-entry extras every dd15 row carries (client-consumed; byte-gated). */
function tmEnvelopeExtra(row: TmRow): Record<string, unknown> {
	return {
		matrix_id: row.id,
		timestamp: row.timestamp,
		caller_section_tipo: row.section_tipo,
		caller_section_id: row.section_id,
		bulk_process_id: row.bulk_process_id ?? 0,
		user_id: Number(row.user_id),
	};
}

/**
 * Per-cell decorations that are NOT derivable from the virtual record — the one
 * place dd15 still needs hand-written cell knowledge after the unification
 * (WC-2026-08-14-tm-cells-obey-list-emit-policy).
 *
 * Exactly one member, and it earns its place: the rsc329 annotation item carries
 * the note-record NAVIGATION keys the client note view consumes
 * (view_note_text_area.js) — `matrix_id` (the TM row id; note creation aborts
 * without it), `parent_section_tipo`/`parent_section_id` (the notes section
 * rsc832 + the existing note record, or null) and `created_by_user_id`. None of
 * those are properties of the VALUE, so no emit hook could produce them.
 *
 * `parent_section_id` is lifted OFF the first entry, where tm_record.ts's
 * `tmNoteValue` parked it (PHP component_text_area_json's 'tm' branch did the
 * same lift). The rest of the entry array is ADOPTED STORED TM DATA and is never
 * rewritten — a snapshot must keep the bytes the engine of the day wrote.
 *
 * A dd15 column with no decorator is simply generic. That is the point: the
 * default is the shared pipeline, and every deviation is enumerable here.
 */
const TM_CELL_DECORATORS: Readonly<
	Record<string, (item: Record<string, unknown>, row: TmRow) => void>
> = {
	[TIPO_NOTES]: (item, row) => {
		const entries = Array.isArray(item.entries) ? (item.entries as Record<string, unknown>[]) : [];
		const first = entries[0];
		const parentSectionId =
			first !== undefined && first !== null && typeof first === 'object'
				? ((first.parent_section_id ?? null) as StoredSectionId | null)
				: null;
		if (first !== undefined && first !== null && typeof first === 'object') {
			const { parent_section_id: _lifted, ...rest } = first;
			item.entries = [rest, ...entries.slice(1)];
		}
		item.parent_section_id = parentSectionId;
		item.parent_section_tipo = TM_NOTES_SECTION_TIPO;
		item.created_by_user_id = Number(row.user_id);
		item.matrix_id = row.id;
	},
};

/**
 * The dataframe slots of a per-component row's main, for the COMPOSED-row
 * split in buildTmSectionRecord (the main's items under its tipo, each slot's
 * frames under the slot). Only an ARRAY snapshot can carry frames; a
 * whole-record snapshot (an object) has none to attribute.
 */
async function snapshotDeclaredSlots(row: TmRow): Promise<string[]> {
	return Array.isArray(row.data) ? await resolveDataframeSlotTipos(row.tipo) : [];
}

/**
 * THE FRAME CELLS OF A LISTED ROW == ITS PREVIEW'S FRAMES
 * (WC-2026-09-29-tm-preview-frame-children-as-of, "the history list"): a row
 * of a main with declared slots gets, under each slot, the frame state AT the
 * row (frame_as_of.ts rowFrameState — the preview graft's one source), not
 * only the frames its own snapshot carries: a LANGUAGE row carries none, and
 * its list cell showed no frame while its preview showed the frames it stood
 * with. The returned emission carries the row's bound ROOTED at the virtual
 * dd15 record (rootedAt), so the frame emission reads the frame children and a
 * sibling bag as of it, addressed by the row's record (never the dd15 id).
 * Any other row (no declared slot, a row filed under a slot's own tipo —
 * unsupported, previews empty) keeps `emission` untouched; a whole-record
 * snapshot never reaches here (rowCellEmissions: one bound per framed cell).
 */
async function graftRowFrameState(
	record: MatrixRecord,
	row: TmRow,
	viewLang: string,
	declaredSlots: readonly string[],
	emission: EmissionContext,
): Promise<EmissionContext> {
	const model = declaredSlots.length === 0 ? null : await getModelByTipo(row.tipo);
	if (model === null || !isMainValueModel(model)) return emission;
	const { rootedAt, rowFrameState, tmAsOfRow } = await import('../tm_record/frame_as_of.ts');
	const live = { sectionTipo: row.section_tipo, sectionId: Number(row.section_id) };
	const { slots } = await rowFrameState(row, model, live, viewLang);
	for (const [slot, frames] of slots ?? []) {
		injectComponentData(record, slot, 'component_dataframe', frames);
	}
	// ROOTED at the virtual dd15 record: it alone stands for the subject
	// (frame_as_of.ts subjectRowOf, by identity) — the subject's live record met
	// as a portal target inside the row's cells stays live.
	const tmAsOf = rootedAt(await tmAsOfRow({ ...row, section_id: live.sectionId }), record);
	return new EmissionContext(emission.items, { tmAsOf });
}

/** One cell's emission: the row's shared one, or a per-cell bound (a whole-record snapshot row). */
type CellEmission = (cellTipo: string) => Promise<EmissionContext>;

/**
 * THE EMISSION EACH CELL OF A LISTED ROW EMITS UNDER. A per-component row has
 * ONE subject (its main): graftRowFrameState, one emission for every cell. A
 * WHOLE-RECORD snapshot row (tipo = section_tipo: a delete, an archive
 * restore — the deleted-records / record-snapshot list) stands for EVERY main
 * of the record at once, so each framed cell gets its own (snapshotCellEmission).
 */
async function rowCellEmissions(
	record: MatrixRecord,
	row: TmRow,
	viewLang: string,
	declaredSlots: readonly string[],
	emission: EmissionContext,
): Promise<CellEmission> {
	if (await isWholeRecordRow(row)) {
		return (cellTipo) => snapshotCellEmission(record, row, cellTipo, emission);
	}
	const shared = await graftRowFrameState(record, row, viewLang, declaredSlots, emission);
	return async () => shared;
}

/** A whole-record snapshot row: filed under the section tipo, its data a full record object. */
async function isWholeRecordRow(row: TmRow): Promise<boolean> {
	if (row.data === null || typeof row.data !== 'object' || Array.isArray(row.data)) return false;
	return (await getModelByTipo(row.tipo)) === 'section';
}

/**
 * THE FRAME CELL OF A WHOLE-RECORD SNAPSHOT ROW
 * (WC-2026-09-29-tm-preview-frame-children-as-of, "whole-record rows"): the
 * SAME law as a per-component row, one main at a time. The subject is the
 * snapshot's record (its section + id — never the dd15 row id); the frame bag
 * is the snapshot's own `relation.<slot>` frames, already adopted by
 * buildTmSectionRecord onto the virtual record; the frame children read as of
 * the cell main's bound at the row (frame_as_of.ts tmAsOfWholeRow: a DELETE
 * snapshot ends at the row — its delete_target wipes lie above it; an archive
 * RESTORE holds until the main key's next row or the record's next
 * section-level row, tmAsOfRow, the preview's one bound). Rooted at the
 * virtual dd15 record, so only the root's frames read as of it (confinement).
 * A cell of a main with no declared slot keeps the shared emission.
 */
async function snapshotCellEmission(
	record: MatrixRecord,
	row: TmRow,
	cellTipo: string,
	emission: EmissionContext,
): Promise<EmissionContext> {
	const model = await getModelByTipo(cellTipo);
	if (model === null || !isMainValueModel(model)) return emission;
	if ((await resolveDataframeSlotTipos(cellTipo)).length === 0) return emission;
	const { rootedAt, tmAsOfWholeRow } = await import('../tm_record/frame_as_of.ts');
	const subject = {
		id: row.id,
		section_tipo: row.section_tipo,
		section_id: Number(row.section_id),
	};
	const bound = await tmAsOfWholeRow(
		subject,
		await resolveDataTipo(cellTipo),
		(await loadSubjectRecord(emission, subject)) !== null,
	);
	return new EmissionContext(emission.items, { tmAsOf: rootedAt(bound, record) });
}

/** The snapshot's record as it lives now (null: gone, or its section has no matrix table). */
async function loadSubjectRecord(
	emission: EmissionContext,
	subject: { section_tipo: string; section_id: number },
): Promise<MatrixRecord | null> {
	const table = await getMatrixTableFromTipo(subject.section_tipo);
	return table === null
		? null
		: loadRecordCached(emission, table, subject.section_tipo, subject.section_id);
}

/**
 * THE VALUE CELL OF A FRAME ROW (two lanes): a per-component lg-nolan row of a
 * main whose value lives in LANGUAGE lanes (savesInRequestLang — translatable,
 * transliterable, component_iri) and that holds no lg-nolan item carries only
 * frames, so a list read straight from it shows every frame edit as "value
 * emptied". Its value cell is the view lane AS OF the row (readLaneValueAt,
 * under the main's real lane law), the same state the preview shows. Every
 * other row keeps its own snapshot (a transliterable main's lg-nolan base shows
 * as recorded).
 */
async function graftFrameRowValue(
	record: MatrixRecord,
	row: TmRow,
	viewLang: string,
): Promise<void> {
	const model = await frameRowModel(row, viewLang);
	if (model === null) return;
	const law = laneLaw(isLangSlicedModel(model), await getTranslatableByTipo(row.tipo));
	const coords = {
		sectionTipo: row.section_tipo,
		sectionId: row.section_id,
		componentTipo: row.tipo,
	};
	const asOf = await readLaneValueAt(coords, viewLang, row.id, law);
	if (asOf.recorded) injectComponentData(record, row.tipo, model, asOf.value ?? emptyKeyOf(law));
}

/**
 * The model of a language-lane main whose frames-only lg-nolan row is viewed
 * in a language; null otherwise. Never an unsliced model: its lg-nolan row IS
 * its whole value (main_lanes.ts laneLaw — a relation is never translatable).
 */
async function frameRowModel(row: TmRow, viewLang: string): Promise<string | null> {
	if (!isFrameRowView(row, viewLang) || holdsNolanItem(row.data)) return null;
	const model = await getModelByTipo(row.tipo);
	if (model === null || !isLaneValueModel(model)) return null;
	return (await savesInRequestLang(row.tipo, model)) ? model : null;
}

/** Whether a row's main part holds an item tagged lg-nolan (a value of the lg-nolan lane). */
function holdsNolanItem(data: unknown): boolean {
	const { main } = splitComposed(data);
	return (
		Array.isArray(main) && main.some((item) => (item as { lang?: unknown } | null)?.lang === NOLAN)
	);
}

/**
 * THE CELL LANG OF A LANGUAGE-LANE LITERAL THAT IS NOT TRANSLATABLE: a
 * component_iri keeps its value in the request language's lane whatever its
 * flag (savesInRequestLang; component_data.ts resolveComponentValue honours the
 * requested lang for it), but emitDdoData nolan-forces a non-translatable ddo
 * — and the client echoes the column context's lg-nolan — so its cell would
 * read the (empty) lg-nolan slice of every row. Its cell is pinned to the
 * audit lang. Every other model keeps the ddo's own lang (a non-translatable
 * string is nolan-forced by its reader anyway).
 */
function laneCellLang(model: string, cellLang: string): { lang?: string } {
	return model === 'component_iri' ? { lang: cellLang } : {};
}

/** A per-component (array snapshot) lg-nolan row, read in a language lane. */
function isFrameRowView(row: TmRow, viewLang: string): boolean {
	return row.lang === NOLAN && viewLang !== NOLAN && viewLang !== '' && Array.isArray(row.data);
}

/** A LANG-SLICED main model: its value can live in language lanes (isMainValueModel ∧ isLangSlicedModel). */
function isLaneValueModel(model: string): boolean {
	return isMainValueModel(model) && isLangSlicedModel(model);
}

/** A main model whose value lands in a jsonb column (never a dataframe slot, never section_id). */
function isMainValueModel(model: string): boolean {
	return model !== 'component_dataframe' && hasJsonbColumn(model);
}

/** The value an emptied key shows with: `[]` for a sliced model, `null` otherwise. */
function emptyKeyOf(law: { sliced: boolean }): unknown {
	return law.sliced ? [] : null;
}

/** Whether a model stores into a matrix jsonb column (component_section_id does not). */
function hasJsonbColumn(model: string): boolean {
	const column = getColumnNameByModel(model);
	return column !== null && MATRIX_JSONB_COLUMNS.includes(column as MatrixJsonbColumn);
}

/**
 * The section a dd15 COLUMN's request_config resolves against: the subject
 * section when the column is one of its components, else none (a dd15 meta
 * column — who/when/where — is dd15's own and resolves there). dd15 lists a
 * record's components as its columns; their 'self' / `field_value` / datalist
 * sources describe THAT section, and dd15's table holds no records of it
 * (`field_value` once read `matrix_time_machine` and died on a missing column).
 * Context and data sides both ask this, so a column cannot resolve against two
 * different owners.
 */
async function tmColumnConfigSection(
	tipo: string,
	subjectSectionTipo: string | null,
): Promise<string | undefined> {
	if (subjectSectionTipo === null) return undefined;
	return (await tipoBelongsToSection(tipo, subjectSectionTipo)) ? subjectSectionTipo : undefined;
}

/**
 * The row a dd15 cell is emitted for: it BINDS to the dd15 row, and its
 * component's config resolves against the snapshot's own record when the
 * column is one of that record's components (concepts/emit_row.ts).
 */
async function tmCellRow(row: TmRow, tipo: string): Promise<EmitRow> {
	const binding = { section_tipo: TM_SECTION_TIPO, section_id: row.id };
	const configSection = await tmColumnConfigSection(tipo, row.section_tipo);
	if (configSection === undefined) return binding;
	return {
		...binding,
		config_owner: { section_tipo: configSection, section_id: Number(row.section_id) },
	};
}

/**
 * THE RAW CELL OF A ROW IS ITS COMPONENT'S VALUE (review r2,
 * WC-2026-10-22-tm-scope-whole-request). The dd1574 column is one of dd15's
 * own, so the floor admits it to every §7.4 grant holder — but each CELL holds
 * the snapshot of the ONE component the row recorded (`row.tipo`), a different
 * one per row. A principal who cannot read that component on the live record
 * (canReadTimeMachineValue: the (section, component) pair) gets the cell EMPTY:
 * the row still shows who/when/what, never the value. A whole-record row
 * injects no raw copy (its components land under their own columns, each
 * judged by the floor). No principal = an internal resolution, unfiltered.
 * A credential row's raw cell is never its stored value whatever the principal:
 * tm_record.ts masks a `secretValue` snapshot before it lands here.
 */
async function withholdUnreadableRawValue(
	record: MatrixRecord,
	row: TmRow,
	principal: Principal | undefined,
): Promise<void> {
	if (principal === undefined) return;
	const { canReadTimeMachineValue } = await import(
		'../section/list_definitions/time_machine_list.ts'
	);
	if (await canReadTimeMachineValue(principal, row.section_tipo, row.tipo)) return;
	const model = await getModelByTipo(TIPO_DATA);
	if (model !== null) injectComponentData(record, TIPO_DATA, model, null);
}

/**
 * The flagged cell of a column emitTmRow cannot render, or null when it can.
 * TWO NAMED EXEMPTIONS, both decade-scale TM facts on a long-lived install:
 *
 * - `unresolved_component_tipo` — the column's ontology node no longer
 *   resolves a model (emitDdoData THROWS on one where the old emitScalarCell
 *   silently emitted nothing; a removed node must not 500 the history browse);
 * - `malformed_relation_value` — the dd15 builder refused the row's own
 *   relation value (tm_record/relation_snapshot_shape.ts): not a locator array
 *   (a pre-v6 bare id, label strings, a foreign object). Converting such data
 *   is the v6→v7 upgrade's job, not this reader's. Through the relation readers
 *   it 500'd the read (a bare value reached compareLocators); dropped, it would
 *   hide history. The raw bytes stay in the dd1574 column.
 *
 * Either cell announces itself (error + reason, the reason lives HERE rather
 * than in a ledger only); `entries: []` keeps the client's array contract.
 */
function flaggedTmCell(
	row: TmRow,
	tipo: string,
	model: string | null,
	refusal: TmRecordRefusal | null,
): Record<string, unknown> | null {
	if (model === null || getColumnNameByModel(model) === null) {
		return flaggedCellShape(
			row,
			tipo,
			'unresolved_component_tipo',
			'This Time Machine row references a component whose ontology node no longer resolves a model. The snapshot is kept; the column cannot be rendered.',
		);
	}
	if (refusal === null || refusal.tipo !== tipo) return null;
	return flaggedCellShape(
		row,
		tipo,
		MALFORMED_RELATION_VALUE_ERROR,
		`This Time Machine row stores a malformed relation value that cannot be shown as a record link: ${refusal.reason}. The snapshot is kept unchanged.`,
	);
}

function flaggedCellShape(
	row: TmRow,
	tipo: string,
	error: string,
	reason: string,
): Record<string, unknown> {
	return {
		section_id: row.id,
		section_tipo: TM_SECTION_TIPO,
		tipo,
		mode: 'list',
		lang: 'lg-nolan',
		parent_tipo: TM_SECTION_TIPO,
		row_section_id: row.id,
		entries: [],
		fallback_value: null,
		error,
		reason,
	};
}

/**
 * Emit ONE dd15 row's data items — one generic cell per requested ddo, resolved
 * from the virtual dd15 record that `tm_record.ts` materializes for the row.
 *
 * THE UNIFICATION (WC-2026-08-14-tm-cells-obey-list-emit-policy): every cell goes
 * through the shared `emitDdoData` in LIST mode, so every component emit hook
 * fires here exactly as it does in the section's own list — text_area truncation
 * (130 chars) with `addTagImgOnTheFly` and the DOS-01 source cap, the
 * `fallback_value` key, original-language forcing. The old private
 * `emitScalarCell` pushed `readComponentItems()` straight onto `emission.items`
 * and therefore skipped all of it, which is why a transcript column rendered
 * hundreds of characters of raw `[TC_…]` / `[index-…]` markup into a list cell.
 *
 * `emitDdo` is the shared emitDdoData, passed in (read_source.ts seam).
 */
async function emitTmRow(
	row: TmRow,
	ddoMap: Ddo[],
	lang: string,
	emission: EmissionContext,
	emitDdo: EmitDdo,
	principal: Principal | undefined,
): Promise<void> {
	const requestedTipos = ddoMap
		.map((ddo) => ddo.tipo)
		.filter((tipo): tipo is string => typeof tipo === 'string');
	const ddoByTipo = new Map<string, unknown>();
	for (const ddo of ddoMap) {
		if (typeof ddo.tipo === 'string') ddoByTipo.set(ddo.tipo, ddo);
	}
	const clientDdoMap = ddoMap as unknown[];

	// Every cell resolves from the virtual dd15 record materialized by the SINGLE
	// dd15 builder (tm_record.ts) — the meta columns (who/when/where/what/process/
	// note) AND the section's own components in the record-snapshot list. It is
	// built once per row now rather than lazily: every branch needs it.
	// TmRow is TimeMachineRow minus the parity `dataText` twin (unused here).
	const declaredSlots = await snapshotDeclaredSlots(row);
	const { record: tmRecord, refusal } = await buildTmSectionRecordWithRefusal(
		row as unknown as TimeMachineRow,
		lang,
		declaredSlots,
	);
	await graftFrameRowValue(tmRecord, row, lang);
	await withholdUnreadableRawValue(tmRecord, row, principal);
	// A framed main's cells read the row's frames AS THE PREVIEW DOES (the frame
	// state at the row, its frame children and sibling bag as of its bound):
	// one bound per row, so its own emission over the SAME items array.
	const cellEmission = await rowCellEmissions(tmRecord, row, lang, declaredSlots, emission);

	// THE AUDIT-LANG RULE. A snapshot renders in the language it was RECORDED in,
	// never the language the menu happens to be on — `matrix_time_machine` carries
	// its own `lang` column precisely so a historical value can be shown as it was
	// stored. The old emitter applied no lang filter at all ("shows the stored
	// value verbatim"), which was this rule stated as an absence.
	//
	// A row whose lang is lg-nolan is NOT a data lang: whole-record snapshots
	// (delete/duplicate/section saves) are recorded that way and their snapshot
	// holds every language, so those follow the request lang like any list. Using
	// lg-nolan as a filter there would slice a translatable column to nothing and
	// turn this fix from "too much text" into "no text" — on the surface a user
	// reads to decide whether to restore.
	const snapshotLang =
		typeof row.lang === 'string' && row.lang !== '' && row.lang !== 'lg-nolan' ? row.lang : lang;

	const { SELECT_FAMILY_MODELS } = await import('../relations/models/select_family.ts');

	for (const tipo of requestedTipos) {
		const model = await getModelByTipo(tipo);

		// The two NAMED EXEMPTIONS (flaggedTmCell): a column that cannot be
		// rendered emits an explicitly flagged empty cell instead of 500ing the
		// whole history browse — never a silent narrowing.
		const flagged = flaggedTmCell(row, tipo, model, refusal);
		if (flagged !== null || model === null) {
			emission.items.push(flagged as never);
			continue;
		}

		// The NOTE column follows the REQUEST lang, not the snapshot lang: its
		// context lang seeds the note modal's editor, so a note must be written in
		// the same language the read filters by or a saved note never shows again
		// (grey icon over existing text). Every other column follows the audit-lang
		// rule. Non-translatable columns are nolan-forced by emitDdoData regardless.
		const cellLang = tipo === TIPO_NOTES ? lang : snapshotLang;
		const clientDdo = (ddoByTipo.get(tipo) ?? { tipo }) as Record<string, unknown>;
		// LIST mode is the whole point: it is what makes every emit hook fire.
		const cellDdo = { ...clientDdo, tipo, mode: 'list', ...laneCellLang(model, cellLang) };

		const rowEmission = await cellEmission(tipo);
		const before = rowEmission.items.length;
		await emitDdo(
			cellDdo as never,
			clientDdoMap as never,
			tmRecord as never,
			await tmCellRow(row, tipo),
			'list',
			cellLang,
			TM_SECTION_TIPO,
			rowEmission,
		);

		// PORTAL family pins each nested block's parent to its own record; SELECT
		// family (a flat resolved label) has no nested blocks to pin.
		const isPortalFamily =
			getColumnNameByModel(model) === 'relation' && !SELECT_FAMILY_MODELS.has(model);
		for (let i = before; i < rowEmission.items.length; i++) {
			const item = rowEmission.items[i] as Record<string, unknown>;
			if (item.tipo === tipo) {
				// No mode restamp: the cell stays in the LIST mode it was emitted in,
				// matching the column ddo the context now declares
				// (WC-2026-08-14-tm-ddo-mode-retired). Context and data flipped
				// together — the byte-identical client binds a cell to its context by
				// an EXACT (tipo, mode, section_tipo) match and drops the column if the
				// two ever disagree. Nested SUBDATUM items keep their own mode for the
				// same reason (forcing them to 'tm' is what once blanked the dd578 Who
				// column); they need no special handling now that nothing is restamped.
				item.from_component_tipo ??= tipo;
				item.parent_section_id ??= row.id;
				TM_CELL_DECORATORS[tipo]?.(item, row);
			} else if (isPortalFamily && item.parent_section_id === undefined) {
				item.parent_section_id = item.section_id;
			}
		}

		if (tipo === TIPO_USER) {
			applySuperuserDisplayName(
				rowEmission.items.slice(before) as unknown as Record<string, unknown>[],
				row.user_id,
			);
		}
	}
}

/**
 * The dd15 Time Machine read source (PHP search_tm + the per-row
 * tm_record::get_section_record materialization). Plugged into the generic
 * readSectionRows via section/read_source.ts so dd15 is served as a normal
 * section — same envelope/context/count, only row acquisition + cell policy differ.
 */
export const tmReadSource: SectionReadSource = {
	async getRows(sqo: Sqo): Promise<SectionRow[]> {
		const { rows, isRecordList } = await queryTmRows(sqo as Record<string, unknown>);
		return rows.map((row) => ({
			// dd15 addresses each snapshot by the TM row PK (its own `id`).
			section_tipo: TM_SECTION_TIPO,
			section_id: row.id,
			envelopeExtra: tmEnvelopeExtra(row),
			raw: { row, isRecordList } satisfies TmRawRow,
		}));
	},

	async count(sqo: Sqo): Promise<number> {
		const scope = sqo as Record<string, unknown>;
		await assertTmWhereInOpenedScope(scope);
		const where = buildTmWhere(await timelineScope(scope));
		return tmCount(where.whereSql, where.params);
	},

	async emitRow(context: EmitRowContext): Promise<void> {
		const { row } = context.row.raw as TmRawRow;
		await emitTmRow(
			row,
			context.ddoMap,
			context.lang,
			context.emission,
			context.emitDdo,
			context.principal,
		);
	},

	buildContext: buildTmContext,
};

/**
 * THE LANE LAW of a one-component history (decision 2026-09-29), stamped on
 * the dd15 context so the tool never re-derives it: `lang_sliced` false ⇒ the
 * main's history is ONE lane (every relation model, whatever its ontology
 * `translatable` flag) — no language to choose, and a restore replaces the
 * whole value and its frames.
 */
async function tmMainLaneLaw(tipo: string): Promise<{ tipo: string; lang_sliced: boolean }> {
	return { tipo, lang_sliced: !(await isUnslicedMain(tipo)) };
}

/**
 * Build the dd15 structure-context for a TM read (PHP section::get_json context
 * over the virtual dd15 record). dd15's LIST columns are the CLIENT's chosen
 * components (the caller section's fields shown as history columns), so — unlike
 * an ordinary section — its request_config.show.ddo_map is mirrored from
 * rqo.show.ddo_map (with ontology-term labels), NOT derived from the ontology.
 * The generic readSection context builder can't produce this, so the TM source
 * owns it (formerly the dispatch mode:'tm' branch).
 */
async function buildTmContext(rqo: Rqo, principal: Principal): Promise<StructureContextEntry[]> {
	const source = (rqo.source ?? {}) as Record<string, unknown>;
	// The Time Machine (dd15) is consultation-only — cap at read (1) even for
	// admins so no TM column/subdatum renders editable (reverts go through
	// tool_time_machine, never inline edit). buildStructureContext caps the dd15
	// section by section_tipo too; this caps the value threaded to the columns.
	const permissions = 1;
	const { buildStructureContext } = await import('./structure_context.ts');

	// dd15's LIST columns are DERIVED FROM THE AUTHORISED SCOPE
	// (WC-2026-08-14-tm-scope-server-owned). The scope comes from the SQO the read
	// is executed against, so the columns and the WHERE cannot disagree.
	//
	// The client's own show.ddo_map is still honoured when it sends one, and that
	// is not laziness: a section instance sends the ddo_map the SERVER gave it in
	// the previous context read, so the two agree by construction, and a browser
	// holding a pre-unification client keeps working (tool JS ships with no
	// cachebust). Server-derived wins when the client sends nothing.
	//
	// Nothing renders without one of these: the bare browse falls through to
	// dd15's OWN ontology section_list, exactly like any other section.
	const clientColumns = rqo.show?.ddo_map ?? [];
	let columns: { tipo?: unknown; label?: unknown; view?: unknown; column_id?: unknown }[] =
		clientColumns;
	const { resolveTimeMachineScope, tmListColumns } = await import(
		'../section/list_definitions/time_machine_list.ts'
	);
	const scope = resolveTimeMachineScope(rqo.sqo as Record<string, unknown> | undefined, {
		surface: source.tm_surface,
	});
	if (clientColumns.length === 0) {
		const derived = await tmListColumns(scope);
		if (derived !== null) {
			columns = derived as never;
		} else {
			const { deriveSectionDdoMap } = await import('../section/read.ts');
			columns = (await deriveSectionDdoMap(TM_SECTION_TIPO, TM_SECTION_TIPO, 'list')) as never;
		}
	}
	// The SAME per-column gate the data side runs (readSectionRows → the dd15
	// floor, which judges a replayed component on its (caller section,
	// component) pair): a column whose cells are dropped is not advertised.
	columns = await authorizedTmColumns(columns, principal);

	const tmContext: StructureContextEntry[] = [];
	const sectionCtx = await buildStructureContext({
		tipo: TM_SECTION_TIPO,
		sectionTipo: TM_SECTION_TIPO,
		mode: 'list',
		lang: typeof source.lang === 'string' ? source.lang : currentDataLang(),
		permissions,
	});
	if (sectionCtx !== null) {
		// Mirror the client's show.ddo_map into the section's request_config so the
		// client renders the chosen columns (PHP parity — dd15 columns are client-driven).
		const requestConfig = (sectionCtx as { request_config?: { show?: { ddo_map?: unknown } }[] })
			.request_config?.[0];
		if (requestConfig?.show !== undefined) {
			const headerLang = typeof source.lang === 'string' ? source.lang : currentDataLang();
			requestConfig.show.ddo_map = await Promise.all(
				columns.map(async (d) => {
					const ddo = d as Record<string, unknown>;
					// PHP fills the column label from the ontology TERM when the client
					// didn't send one (dd1371→Proceso, dd559→Cuándo, …).
					const label =
						typeof ddo.label === 'string' && ddo.label !== ''
							? ddo.label
							: await termByTipo(String(ddo.tipo), headerLang);
					return {
						typo: 'ddo',
						tipo: ddo.tipo,
						section_tipo: TM_SECTION_TIPO,
						parent: TM_SECTION_TIPO,
						// LIST, not 'tm' (WC-2026-08-14-tm-ddo-mode-retired). The client
						// binds a cell to its context by an EXACT (tipo, mode, section_tipo)
						// match, so this and the data half flip together or the column
						// silently disappears.
						mode: 'list',
						view: ddo.view ?? null,
						label,
						...(ddo.column_id !== undefined ? { column_id: ddo.column_id } : {}),
					};
				}),
			);
		}
		if (scope.tipo !== undefined) sectionCtx.tm_main = await tmMainLaneLaw(scope.tipo);
		tmContext.push(sectionCtx);
	}
	for (const ddo of columns) {
		if (typeof ddo.tipo !== 'string') continue;
		// Per-column lang follows PHP's component lang rule: a TRANSLATABLE column
		// gets the data lang, a non-translatable one lg-nolan. The dd15 meta
		// columns are all non-translatable; rsc329 (the TM annotation) is NOT —
		// its context lang seeds the note modal's editor, so notes must WRITE in
		// the same lang the TM read lang-filters by, or a saved note never shows
		// (grey icon over existing text).
		const columnLang = (await getTranslatableByTipo(ddo.tipo))
			? typeof source.lang === 'string'
				? source.lang
				: currentDataLang()
			: 'lg-nolan';
		const configSectionTipo = await tmColumnConfigSection(ddo.tipo, scope.sectionTipo);
		const entry = await buildStructureContext({
			tipo: ddo.tipo,
			sectionTipo: TM_SECTION_TIPO,
			mode: 'list',
			lang: columnLang,
			permissions,
			parent: TM_SECTION_TIPO,
			view: (ddo as { view?: string }).view ?? null,
			...(configSectionTipo !== undefined ? { configSectionTipo } : {}),
		});
		if (entry !== null) tmContext.push(entry);
	}
	return tmContext;
}

/** The columns the principal may read, judged as the data side judges them (dd15 floor). */
async function authorizedTmColumns<T extends { tipo?: unknown }>(
	columns: readonly T[],
	principal: Principal,
): Promise<T[]> {
	const kept: T[] = [];
	for (const column of columns) {
		if (typeof column.tipo !== 'string') continue;
		if (await ddoIsAuthorized(principal, TM_SECTION_TIPO, column.tipo)) kept.push(column);
	}
	return kept;
}

/**
 * Count TM rows for a request (pagination parity with the read). Thin wrapper
 * over the read source's count — kept for the count dispatch path / callers.
 */
export async function countTimeMachineData(rqo: Rqo): Promise<number> {
	return tmReadSource.count((rqo.sqo ?? {}) as Sqo);
}

/**
 * Adapter kept for direct callers/tests: run the TM query + build the standard
 * {sections envelope, per-row data} shape by composing the read source with the
 * shared emitDdoData. (The generic readSectionRows path does the same assembly.)
 */
export async function readTimeMachineData(rqo: Rqo): Promise<TmReadData> {
	const sqo = (rqo.sqo ?? {}) as Record<string, unknown>;
	const source = (rqo.source ?? {}) as Record<string, unknown>;
	// Request-scoped data lang backstop (S2-28), never a hardcoded lg-spa.
	const lang = typeof source.lang === 'string' ? source.lang : currentDataLang();
	const ddoMap = (rqo.show?.ddo_map ?? []) as Ddo[];
	const offset = Number(sqo.offset ?? 0);

	const { rows, isRecordList } = await queryTmRows(sqo);

	// The sections envelope (dd15; section_id = the TM row PK = matrix_id).
	const data: Record<string, unknown>[] = [
		{
			typo: 'sections',
			tipo: TM_SECTION_TIPO,
			section_tipo: [],
			entries: rows.map((row, index) => ({
				section_tipo: TM_SECTION_TIPO,
				section_id: row.id,
				paginated_key: index + offset,
				...tmEnvelopeExtra(row),
			})),
		},
	];

	// Requested column components (client ddo_map tipos, dd15-scoped only).
	const requestedTipos = ddoMap
		.map((ddo) => ddo.tipo)
		.filter((tipo): tipo is string => typeof tipo === 'string');
	const handled = new Set([TIPO_BULK_PROCESS, TIPO_TIMESTAMP, TIPO_USER, TIPO_COMPONENT]);
	// In the record-snapshot list, the section's own components ARE resolved (from
	// each snapshot's data), so only the per-component history reports metadata
	// misses as unhandled.
	const unhandled = isRecordList ? [] : requestedTipos.filter((tipo) => !handled.has(tipo));

	// Compose the shared per-row emission (identical to the generic readSectionRows
	// path — the source's emitRow over emitDdoData).
	const { emitDdoData } = await import('../section/read.ts');
	const emission = new EmissionContext(data as never);
	for (const row of rows) {
		// No principal: this adapter is an internal resolution (its query is
		// unscoped too), the ddoIsAuthorized posture.
		await emitTmRow(row, ddoMap, lang, emission, emitDdoData as EmitDdo, undefined);
	}

	return { data, unhandled };
}
