/**
 * RECONCILE `wiped_filter_projects` — repair of the records a PRE-T0-5 data
 * wipe moved out of their project (audit OX3; owner decision D1 = report +
 * operator apply through Maintenance › Reconcile, D1.1 = any global admin).
 *
 * THE DAMAGE. From the cutover (2026-07-11) until T0-5, `delete_data`
 * (delete_record.ts deleteSectionData) reset every component_filter to ONE
 * id-less `dd151` locator on DEDALO_DEFAULT_PROJECT, whoever wiped. A
 * project-scoped curator's record left their scope: invisible, un-openable,
 * un-revertable by them. The fixed wipe writes the user's default projects
 * (the birth cascade, with an allocated item id) — this module only repairs
 * what the old one left.
 *
 * THE PAIR.
 *   store A  the live component_filter key of every record (matrix relation);
 *   store B  the record's Time Machine history of that key — the value it held
 *            BEFORE the wipe.
 * Drift = a key still holding EXACTLY the legacy wipe value: one item, no `id`
 * key, type `dd151`, the filter section, DEDALO_DEFAULT_PROJECT (int or string
 * form), `from_component_tipo` = the key. No other door writes an id-less
 * filter item (set_data and the birth door always stamp one), so the
 * signature does not catch a curator's own value. A key edited after the wipe
 * no longer matches and is never touched.
 *
 * THE PRE-WIPE VALUE. The key's visible TM rows, newest first: the newest row
 * holding the wipe value is the wipe's own row; the first OLDER row holding a
 * different value is what the wipe replaced (both wipe generations wrote that
 * pair — a backfill row at NOW-60s when the key had no history, then the wipe
 * row). None, or an empty one → `unrecoverable`: reported, never written — a
 * project is never guessed.
 *
 * DRY (the default) reports every match with its pre-wipe filter and status.
 * APPLY (operator-run only: it moves records between ACL scopes — never
 * hygiene, never scheduled) restores each recoverable key in its own
 * transaction: the row is locked and the signature RE-CHECKED behind the lock
 * (a concurrent edit is never overwritten), then the past value is written
 * through the COMPONENT-RESTORE entry (section_record persistRestoredKeys — the
 * Time Machine apply_value's door: modified stamps, relation_search, observer
 * obligations) and audited by the ONE history writer (recordMainHistory), as
 * apply_value does. A pre-wipe project that no longer exists is
 * `project_missing` and STILL restored — it is the record's history; the
 * report names it so the operator can re-file it.
 *
 * WRITE ACTOR. The registry's doors carry no principal (same posture as
 * portal_declared_order): the TM actor and the modified stamp are the system
 * user (-1).
 */

import { config } from '../../../config/config.ts';
import { canonicalizeStoredSectionId } from '../../concepts/section_id.ts';
import { MATRIX_TABLE_ALLOWLIST, type MatrixJsonbColumn } from '../../db/matrix.ts';
import { absorbComponentItemIds, readMatrixKeyForUpdate } from '../../db/matrix_write.ts';
import { sql, withTransaction } from '../../db/postgres.ts';
import { readTimeMachineHistory } from '../../db/time_machine.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import {
	getComponentFilterTipo,
	getMatrixTableFromTipo,
	listSectionNodes,
} from '../../ontology/resolver.ts';
import type {
	ReconcileDefinition,
	ReconcileReport,
	ReconcileRunOptions,
} from '../../reconcile/registry.ts';
import {
	historyStamp,
	mainIdentity,
	mainStorage,
	readMainState,
	recordMainHistory,
	splitComposed,
} from '../../relations/dataframe_slots.ts';
import { NOLAN } from '../../relations/main_lanes.ts';
import { persistRestoredKeys, type RecordWriteTarget } from '../../section_record/index.ts';
import { SUPERUSER_ID } from '../../security/permissions.ts';

/** The reconcile's registry name (REGISTERED_NAMES, the widget row). */
export const WIPED_FILTER_PROJECTS = 'wiped_filter_projects';

/** The type the pre-fix wipe stamped (DEDALO_RELATION_TYPE_LINK) — the signature's own. */
const LEGACY_WIPE_TYPE = 'dd151';

/**
 * TM rows read per key. The wipe row is the newest row equal to the live
 * value (nothing different was written since — else no match), so it sits
 * at the head; the bound only caps a pathological history.
 */
const HISTORY_LIMIT = 500;

/** How many matches the report LISTS; the counts stay exact past it. */
const REPORT_SAMPLE = 200;

/** What one legacy-wiped key is. */
export type WipedFilterStatus =
	/** The pre-wipe filter is known and its projects exist. */
	| 'restorable'
	/** The pre-wipe filter is known; a project it names has no record. Restored anyway. */
	| 'project_missing'
	/** No pre-wipe value in the key's history: reported, never written. */
	| 'unrecoverable'
	/** APPLY: the signature was gone behind the row lock (written since the scan). */
	| 'changed'
	/** APPLY: the restore threw (its code is in `error`); the run went on. */
	| 'failed';

export interface WipedFilterMatch {
	section_tipo: string;
	section_id: number;
	filter_tipo: string;
	pre_wipe_filter: unknown[] | null;
	status: WipedFilterStatus;
	/** Written by THIS run (always false on a dry run). */
	restored: boolean;
	/** The DedaloError code of a `failed` restore. */
	error?: string;
}

export interface WipedFilterSummary {
	/** (table, section, filter) groups scanned. */
	scanned: number;
	/** Legacy-wiped keys found (exact). */
	drift: number;
	/** Keys restored by this run. */
	applied: number;
	unrecoverable: number;
	project_missing: number;
	failed: number;
	/** Up to REPORT_SAMPLE matches, in scan order. */
	matches: WipedFilterMatch[];
}

/** One place a filter key lives: a section's records in its matrix table. */
interface FilterSite {
	table: string;
	sectionTipo: string;
	filterTipo: string;
	column: MatrixJsonbColumn;
}

/**
 * The ONE item of a single-item array value when it is an object WITHOUT an
 * `id` key — the shape the pre-fix wipe left — else null.
 */
function soleIdlessItem(value: unknown): Record<string, unknown> | null {
	if (!Array.isArray(value) || value.length !== 1) return null;
	const item = value[0] as Record<string, unknown> | null;
	if (item === null || typeof item !== 'object') return null;
	return 'id' in item ? null : item;
}

/** Whether `value` is EXACTLY what the pre-fix wipe wrote into `filterTipo`. */
export function isLegacyWipedFilter(value: unknown, filterTipo: string): boolean {
	const item = soleIdlessItem(value);
	if (item === null) return false;
	return (
		item.type === LEGACY_WIPE_TYPE &&
		item.section_tipo === config.features.filterSectionTipo &&
		canonicalizeStoredSectionId(item.section_id as never) === config.features.defaultProject &&
		item.from_component_tipo === filterTipo
	);
}

/** The run's section scope as a set, or null when unscoped (every section). */
function scopeSet(scope: readonly string[] | undefined): ReadonlySet<string> | null {
	return scope === undefined || scope.length === 0 ? null : new Set(scope);
}

/**
 * Where one section's filter key lives, or null when it has none the scan can
 * reach: no component_filter, no matrix table / storage, or a table outside
 * the allowlist (the SQL below interpolates it).
 */
async function siteOf(sectionTipo: string): Promise<FilterSite | null> {
	const filterTipo = await getComponentFilterTipo(sectionTipo);
	if (filterTipo === null) return null;
	const table = await getMatrixTableFromTipo(sectionTipo);
	const storage = await mainStorage(filterTipo);
	if (table === null || storage === null || !MATRIX_TABLE_ALLOWLIST.includes(table)) return null;
	return { table, sectionTipo, filterTipo, column: storage.column };
}

/** Every section (in scope) with a filter key in an allowlisted matrix table. */
async function filterSites(scope: readonly string[] | undefined): Promise<FilterSite[]> {
	const wanted = scopeSet(scope);
	const sites: FilterSite[] = [];
	for (const section of await listSectionNodes()) {
		if (wanted !== null && !wanted.has(section.tipo)) continue;
		const site = await siteOf(section.tipo);
		if (site !== null) sites.push(site);
	}
	return sites;
}

/**
 * The candidate record ids of one site: the coarse SQL probe (first item's
 * type/section/project, dual-form section_id via ->>), judged exactly by
 * isLegacyWipedFilter afterwards. `->0` on a non-array is NULL, never an error.
 */
async function candidates(site: FilterSite): Promise<number[]> {
	// table and column are allowlisted (filterSites, §7.6 pattern); the rest is bound.
	const rows = (await sql.unsafe(
		`SELECT section_id AS id, "${site.column}"->$2 AS value
		 FROM "${site.table}"
		 WHERE section_tipo = $1
		   AND "${site.column}"->$2->0->>'type' = $3
		   AND "${site.column}"->$2->0->>'section_tipo' = $4
		   AND "${site.column}"->$2->0->>'section_id' = $5
		 ORDER BY section_id`,
		[
			site.sectionTipo,
			site.filterTipo,
			LEGACY_WIPE_TYPE,
			config.features.filterSectionTipo,
			String(config.features.defaultProject),
		],
	)) as { id: number; value: unknown }[];
	return rows
		.filter((row) => isLegacyWipedFilter(row.value, site.filterTipo))
		.map((row) => Number(row.id));
}

/** The main part of a TM image (a filter has no frames; splitComposed is the one split). */
function tmMain(data: unknown): unknown {
	return splitComposed(data).main;
}

function isEmptyValue(value: unknown): boolean {
	return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}

/** The value the wipe replaced (see the module header), or null when the history cannot say. */
async function preWipeFilter(site: FilterSite, sectionId: number): Promise<unknown[] | null> {
	const history = await readTimeMachineHistory(
		site.sectionTipo,
		sectionId,
		site.filterTipo,
		HISTORY_LIMIT,
	);
	let seenWipe = false;
	for (const row of history) {
		const main = tmMain(row.data);
		// Skip EVERY legacy-wiped image by signature, not by bytes: two legacy
		// wipes straddling WC-2026-08-10 differ only in section_id form.
		if (isLegacyWipedFilter(main, site.filterTipo)) {
			seenWipe = true;
			continue;
		}
		if (!seenWipe) continue;
		return isEmptyValue(main) || !Array.isArray(main) ? null : (main as unknown[]);
	}
	return null;
}

/**
 * Whether one filter item's project has a record. An item that does not
 * address the projects section names no project — nothing to prove (true);
 * a non-integer project id can address no record (false).
 */
async function namedProjectExists(
	table: string,
	projectsTipo: string,
	item: unknown,
): Promise<boolean> {
	const locator = item as Record<string, unknown> | null;
	if (locator?.section_tipo !== projectsTipo) return true;
	const id = Number(canonicalizeStoredSectionId(locator.section_id as never));
	if (!Number.isInteger(id)) return false;
	// table allowlisted by the caller; tipo/id bound.
	const rows = (await sql.unsafe(
		`SELECT 1 FROM "${table}" WHERE section_tipo = $1 AND section_id = $2 LIMIT 1`,
		[projectsTipo, id],
	)) as unknown[];
	return rows.length > 0;
}

/** Whether every project a filter value names has a record. */
async function projectsExist(value: readonly unknown[]): Promise<boolean> {
	const projectsTipo = config.features.filterSectionTipo;
	const table = await getMatrixTableFromTipo(projectsTipo);
	if (table === null || !MATRIX_TABLE_ALLOWLIST.includes(table)) return false;
	for (const item of value) {
		if (!(await namedProjectExists(table, projectsTipo, item))) return false;
	}
	return true;
}

/**
 * APPLY one key, in its own transaction: lock, re-check the signature, write
 * the past value through the component-restore entry, absorb its item ids,
 * audit it (apply_value's shape — tool_time_machine.ts toolTimeMachineApplyValue).
 * Returns whether it wrote.
 */
async function restoreWipedFilterKey(
	site: FilterSite,
	sectionId: number,
	value: unknown[],
): Promise<boolean> {
	return withTransaction(async () => {
		const locked = await readMatrixKeyForUpdate(
			site.table,
			site.sectionTipo,
			sectionId,
			site.column,
			site.filterTipo,
		);
		if (locked === null || !isLegacyWipedFilter(locked, site.filterTipo)) return false;
		const target: RecordWriteTarget = {
			table: site.table,
			sectionTipo: site.sectionTipo,
			sectionId,
		};
		const identity = await mainIdentity(site.filterTipo, NOLAN);
		const before = await readMainState(target, identity);
		await persistRestoredKeys(
			target,
			[{ column: site.column, key: site.filterTipo, value }],
			{ userId: SUPERUSER_ID },
			{ actor: SUPERUSER_ID },
		);
		// Restored items carry explicit ids: raise the counter so a later insert
		// cannot mint a duplicate (as apply_value does).
		await absorbComponentItemIds(site.table, site.sectionTipo, sectionId, site.filterTipo, value);
		const after = await readMainState(target, identity);
		await recordMainHistory(target, identity, { before, after }, historyStamp(SUPERUSER_ID, null));
		return true;
	});
}

/** Throw the run's abort reason (the SIGTERM drain, or the caller job's stop). */
function checkAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted !== true) return;
	throw new DedaloError('update.failed', {
		message: `${WIPED_FILTER_PROJECTS}: aborted (${String(signal.reason ?? 'signal')})`,
		publicMessage: 'The wiped-filter reconcile was stopped',
	});
}

/** A thrown failure's CODE only — the report is a payload (ERRORS_SPEC disclosure ladder). */
function failureCode(error: unknown): string {
	return error instanceof DedaloError ? error.code : 'internal.unexpected';
}

/** The DRY status of a matched key, from its pre-wipe value. */
async function dryStatusOf(preWipe: unknown[] | null): Promise<WipedFilterStatus> {
	if (preWipe === null) return 'unrecoverable';
	return (await projectsExist(preWipe)) ? 'restorable' : 'project_missing';
}

/**
 * APPLY the restore of one recoverable match, updating it in place: `restored`
 * on a write, `changed` when the signature was gone behind the lock, `failed`
 * (with its code) when the restore threw — the run goes on either way.
 */
async function applyRestore(
	site: FilterSite,
	match: WipedFilterMatch,
	preWipe: unknown[],
): Promise<void> {
	try {
		match.restored = await restoreWipedFilterKey(site, match.section_id, preWipe);
		if (!match.restored) match.status = 'changed';
	} catch (error) {
		console.error(
			`${WIPED_FILTER_PROJECTS}: restore of ${site.sectionTipo}/${match.section_id} ${site.filterTipo} failed:`,
			error,
		);
		match.status = 'failed';
		match.error = failureCode(error);
	}
}

/** Judge (and on apply, restore) one matched key. */
async function reconcileKey(
	site: FilterSite,
	sectionId: number,
	apply: boolean,
): Promise<WipedFilterMatch> {
	const preWipe = await preWipeFilter(site, sectionId);
	const match: WipedFilterMatch = {
		section_tipo: site.sectionTipo,
		section_id: sectionId,
		filter_tipo: site.filterTipo,
		pre_wipe_filter: preWipe,
		status: await dryStatusOf(preWipe),
		restored: false,
	};
	if (!apply || preWipe === null) return match;
	await applyRestore(site, match, preWipe);
	return match;
}

/** Count one judged match into the run's summary (and list it, up to REPORT_SAMPLE). */
function tally(summary: WipedFilterSummary, match: WipedFilterMatch): void {
	summary.drift++;
	if (match.restored) summary.applied++;
	if (match.status === 'unrecoverable') summary.unrecoverable++;
	if (match.status === 'project_missing') summary.project_missing++;
	if (match.status === 'failed') summary.failed++;
	if (summary.matches.length < REPORT_SAMPLE) summary.matches.push(match);
}

/** THE RUN: scan every site in scope, judge each match, restore on apply. */
export async function reconcileWipedFilters(
	options: ReconcileRunOptions,
): Promise<WipedFilterSummary> {
	const summary: WipedFilterSummary = {
		scanned: 0,
		drift: 0,
		applied: 0,
		unrecoverable: 0,
		project_missing: 0,
		failed: 0,
		matches: [],
	};
	for (const site of await filterSites(options.scope)) {
		checkAborted(options.signal);
		summary.scanned++;
		for (const sectionId of await candidates(site)) {
			checkAborted(options.signal);
			tally(summary, await reconcileKey(site, sectionId, options.apply));
		}
	}
	return summary;
}

async function runWipedFilters(options: ReconcileRunOptions): Promise<ReconcileReport> {
	const summary = await reconcileWipedFilters(options);
	return {
		drift: summary.drift,
		applied: summary.applied,
		detail: summary as unknown as Record<string, unknown>,
	};
}

export const WIPED_FILTER_PROJECTS_RECONCILE: ReconcileDefinition = {
	name: WIPED_FILTER_PROJECTS,
	stores: [
		'live project filters (component_filter keys in the matrix)',
		'the Time Machine history of those keys (the value before a data wipe)',
	],
	description:
		'Find records an older "delete data" moved out of their project (the filter reset to the default project, type dd151, no item id) and list the projects each held before the wipe. Apply puts those projects back through the Time Machine restore door, re-checking each record under a row lock; a record whose history holds no earlier projects is reported, never guessed.',
	scopeLabel: 'section tipo',
	// It moves records between ACL scopes: an operator decision with the dry
	// report in view — never scheduled, never auto-applied.
	schedule: 'operator',
	sources: ['src/core/section/record/wiped_filter_reconcile.ts'],
	run: runWipedFilters,
};
