/**
 * RECONCILE `portal_declared_order` — the BACKFILL / BACKSTOP of the portal
 * order model (owner ruling 2026-10-31; WC-2026-10-31-portal-order-model).
 *
 * THE PAIR. A portal whose ontology declares a per-ddo `order`
 * (`properties.source.request_config[].show.ddo_map[].order`) owns a STORED
 * locator array that must equal its DECLARED order: the record-write chokepoint
 * sorts it on every write (section_record/record_write.ts applyKeySaveRules) and
 * the observer default branch re-sorts it when a target's ordering value changes
 * (section/record/observers.ts resaveObserverThroughSaveRules). Neither reaches
 * an array that nobody writes: every record stored BEFORE the declaration (or
 * before the chokepoint sorted it), a declaration added or changed
 * afterwards, an archive restore (archive/restore.ts, the one accepted raw
 * door), a DB restore. This reconcile compares the two:
 *
 *   store A  the stored relation array of every record holding the portal key;
 *   store B  the same array ranked by the declared order — the ONE ordering
 *            function the chokepoint uses
 *            (relations/order_locators.ts sortByDeclaredOrder).
 *
 * Drift = one record whose stored array differs from its ranked one. A dry run
 * (the default) reports it and writes nothing. APPLY rewrites each drifted array
 * through the NORMAL save door (section/record/save_component.ts
 * saveComponentData → record_write.ts persistRecordKeys): Time Machine row,
 * observer and diffusion obligations, exactly like any save — under a FOR UPDATE
 * re-read of the key inside the record's own transaction, so a concurrent edit
 * between the scan and the write is never overwritten by the scan's stale
 * array (the array written is the LOCKED one, ranked).
 *
 * WHO RUNS IT.
 *  - the operator (`reconcile_status` widget, `scripts/reconcile.ts`), scoped by
 *    portal tipo — schedule `operator`: it walks every holder of every
 *    declared-order portal and its apply writes TM rows at scale;
 *  - the ontology-change point (`queueDeclaredOrderReconcile`): the two
 *    dd_ontology node-write doors — ontology/ontology_state.ts rebuildOntology
 *    (whole tld: the ontology update, the update run's ontology phase) and
 *    section_record/ontology_projection.ts projectOntologyNode (one record: a
 *    local `order` edit) — queue an APPLY scoped to the portals whose `order`
 *    declaration they added or changed, POST-COMMIT (registerCommitAction: the
 *    reconcile must read the committed declaration, and never run for a
 *    rolled-back one) — ONE sweep after a whole ontology update (a batch),
 *    handed to a background job when the write is an HTTP request's
 *    (queueDeclaredOrderReconcile, WHERE IT RUNS);
 *  - the post-restore plan (reconcile/post_restore.ts): DRY only — its drift is
 *    reported as held, the operator applies it.
 * The read path never sorts by the declared order (relation_core.ts
 * expandPortal serves the stored array): drift stays visible until applied.
 *
 * WRITE ACTOR. The registry's doors carry no principal: the TM actor is the
 * system user (-1), and the save is judged as the superuser — a re-persist of
 * locators already stored (relations/save.ts gate 0: every insert gate skips an
 * already-stored locator), never a net-new link.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
	MATRIX_JSONB_COLUMNS,
	MATRIX_TABLE_ALLOWLIST,
	type MatrixJsonbColumn,
} from '../db/matrix.ts';
import { readMatrixKeyForUpdate } from '../db/matrix_write.ts';
import { registerCommitAction, sql, withTransaction } from '../db/postgres.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { currentJobSignal } from '../media/job_scope.ts';
import { mediaJobs } from '../media/jobs.ts';
import { getEffectivePropertiesByTipo } from '../ontology/alias.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
	getNodesWithProperty,
	listSectionNodes,
} from '../ontology/resolver.ts';
import {
	type ReconcileDefinition,
	type ReconcileReport,
	type ReconcileRunOptions,
	registerReconcile,
	runReconcile,
} from '../reconcile/registry.ts';
import { sectionDeclaresComponent } from '../section/record/external_laws/resolvers.ts';
import { saveComponentData } from '../section/record/save_component.ts';
import { type Principal, SUPERUSER_ID } from '../security/permissions.ts';
import { currentPrincipal, currentRequestContext } from '../security/request_context.ts';
import {
	aliasOwnDeclaredOrder,
	hasDeclaredColumnOrder,
	isAliasNode,
	sortByDeclaredOrder,
} from './order_locators.ts';

/** The reconcile's registry name (REGISTERED_NAMES, the update script id, the WC entry). */
export const PORTAL_DECLARED_ORDER = 'portal_declared_order';

/** The actor of a reconcile write: the registry's doors carry none (module header, WRITE ACTOR). */
const RECONCILE_PRINCIPAL: Principal = {
	userId: SUPERUSER_ID,
	isGlobalAdmin: true,
	isDeveloper: true,
};

/**
 * How many drifted / failed addresses one portal's report LISTS. The counts
 * (`drift`, `failedCount`) stay exact past it — the lists are samples.
 */
const REPORT_SAMPLE = 50;

/**
 * Holder rows read per scan page (keyset on section_id): a large host section
 * is judged page by page, never materialised whole with every row's locator
 * array.
 */
const HOLDER_PAGE = 500;

/** One record address. */
interface RecordAddress {
	section_tipo: string;
	section_id: number;
}

/** One portal's verdict. */
export interface DeclaredOrderPortalReport {
	tipo: string;
	/** The host sections whose records may hold the key (they declare the portal). */
	sections: string[];
	/** Records holding the key (scanned). */
	records: number;
	/** Records whose stored array differs from its declared order. */
	drift: number;
	/** Records rewritten by THIS run (0 on a dry run). */
	applied: number;
	/** Up to REPORT_SAMPLE drifted addresses. */
	drifted: RecordAddress[];
	/**
	 * Records whose judging or apply FAILED — the exact count: a save refused
	 * (ok:false), a save that THREW, a stored array the ranking could not judge.
	 * Each is isolated: the run goes on to the next record.
	 */
	failedCount: number;
	/**
	 * Up to REPORT_SAMPLE of them: address + the failure's sentence — a refused
	 * save's own (wire-grade) message, or a thrown failure's CODE (never its raw
	 * text, which is logged: failureSentence).
	 */
	failed: (RecordAddress & { error: string })[];
}

/** A whole run's verdict (the registry report's `detail`, the trigger's log lines). */
export interface DeclaredOrderReconcileSummary {
	apply: boolean;
	portals: DeclaredOrderPortalReport[];
	/** Scope entries that are not declared-order components (named, never silently dropped). */
	skipped: { tipo: string; reason: string }[];
	drift: number;
	applied: number;
	/** Exact: the sum of every portal's `failedCount`. */
	failed: number;
}

export interface DeclaredOrderReconcileOptions {
	/** false (default) = dry run. */
	apply?: boolean;
	/** Portal tipos to narrow to; absent = every declared-order portal. */
	scope?: readonly string[];
	/**
	 * The run's abort, checked between records (and between portals): through
	 * the registry it is runReconcile's composed signal — the SIGTERM drain
	 * (reconcile/registry.ts abortInFlightReconciles, fired by
	 * scheduler.ts stopReconcileScheduler) plus the caller's own (the
	 * ontology-change trigger passes the running job's stop / deadline,
	 * media/job_scope.ts currentJobSignal). An abort throws a typed
	 * `update.failed`, recorded on the `reconcile` gauge; the records already
	 * rewritten stay rewritten (each is its own save), the rest stay drift for
	 * the operator's dry run.
	 */
	signal?: AbortSignal;
}

/**
 * Resolve one ontology node of the census or of the scope, ISOLATING a node the
 * ontology layer REFUSES to resolve (`ontology.invalid_node` — e.g. a
 * component_alias still carrying a retired v5 key, WC-020, or whose `alias_of`
 * target is missing): it is SKIPPED and NAMED, never fatal, and `null` comes
 * back. One malformed node must not abort the run for every other portal —
 * neither the whole-ontology census (an operator run, a post-restore verdict)
 * nor a SCOPED run (the ontology-change trigger always scopes: one rebuilt tld
 * may change a drifted portal and a broken alias together). Nothing is lost —
 * the write chokepoint refuses that same node, so no record can hold a key it
 * would sort. Any other error still throws.
 */
async function resolveIsolated<T>(
	tipo: string,
	skipped: DeclaredOrderReconcileSummary['skipped'],
	resolve: () => Promise<T>,
): Promise<T | null> {
	try {
		return await resolve();
	} catch (error) {
		if (!(error instanceof DedaloError) || error.code !== 'ontology.invalid_node') throw error;
		// The report is a payload (the registry's `detail`): the CODE goes in
		// it, the raw text to the log (ERRORS_SPEC — never exception text in a payload).
		console.warn(`[reconcile] ${PORTAL_DECLARED_ORDER}: skips ${tipo}:`, error);
		skipped.push({ tipo, reason: `unresolvable node (${error.code})` });
		return null;
	}
}

/**
 * Whether `tipo` is a declared-order portal of its own (the raw-gate predicate,
 * effective properties). A component_alias never is: its data lives under its
 * target's key (WC-020), which is judged under its own tipo. An alias whose own
 * `source` declares a DIFFERENT order is NAMED (ignored everywhere —
 * order_locators.ts orderKeyOf). `named` (a scope entry: judged, never
 * silently dropped) also names an alias with nothing to scan and a tipo that
 * declares no order; the census lists only the portals it finds.
 */
async function isDeclaredOrderPortal(
	tipo: string,
	skipped: DeclaredOrderReconcileSummary['skipped'],
	named: boolean,
): Promise<boolean> {
	if (await isAliasNode(tipo)) {
		noteAlias(tipo, await aliasOwnDeclaredOrder(tipo), skipped, named);
		return false;
	}
	if (hasDeclaredColumnOrder(await getEffectivePropertiesByTipo(tipo))) return true;
	if (named) skipped.push({ tipo, reason: 'declares no per-ddo order (nothing to reconcile)' });
	return false;
}

/** Every component tipo that declares a per-ddo `order` (each node isolated: resolveIsolated). */
async function declaredOrderPortals(
	skipped: DeclaredOrderReconcileSummary['skipped'],
): Promise<string[]> {
	const tipos: string[] = [];
	for (const node of await getNodesWithProperty('source')) {
		const portal = await resolveIsolated(node.tipo, skipped, () =>
			isDeclaredOrderPortal(node.tipo, skipped, false),
		);
		if (portal === true) tipos.push(node.tipo);
	}
	return tipos.sort();
}

/**
 * The run's portals: the scope (each entry judged and isolated — a tipo that
 * declares no order, or that the ontology refuses to resolve, is SKIPPED with
 * its reason, never silently and never fatally), or every declared-order portal.
 */
async function portalsInScope(
	scope: readonly string[] | undefined,
	skipped: DeclaredOrderReconcileSummary['skipped'],
): Promise<string[]> {
	if (scope === undefined) return declaredOrderPortals(skipped);
	const portals: string[] = [];
	for (const tipo of [...new Set(scope)].sort()) {
		const portal = await resolveIsolated(tipo, skipped, () =>
			isDeclaredOrderPortal(tipo, skipped, true),
		);
		if (portal === true) portals.push(tipo);
	}
	return portals;
}

/** An alias in scope with no order of its own that differs from its target's. */
const ALIAS_NO_KEY_REASON =
	'component_alias: no record holds an alias key — its target is reconciled under its own tipo';

/**
 * Name an alias whose OWN `source` declares an order its target does not
 * (`target` non-null): that order is ignored everywhere — a declared order is
 * keyed on the data tipo (order_locators.ts orderKeyOf) — so the ontology
 * should drop it or move it to the target. With no such order, a NAMED entry
 * (a scope entry) is reported as having nothing to scan.
 */
function noteAlias(
	tipo: string,
	target: string | null,
	skipped: DeclaredOrderReconcileSummary['skipped'],
	named: boolean,
): void {
	if (target !== null) {
		skipped.push({
			tipo,
			reason: `component_alias declares its own order, ignored: a declared order is keyed on its data tipo '${target}'`,
		});
	} else if (named) {
		skipped.push({ tipo, reason: ALIAS_NO_KEY_REASON });
	}
}

/**
 * Host sections per portal: the sections that DECLARE it (real and virtual —
 * sectionDeclaresComponent, the observer kernel's own host predicate). One pass
 * over the section census for every portal of the run.
 */
async function hostSectionsByPortal(portals: readonly string[]): Promise<Map<string, string[]>> {
	const hosts = new Map<string, string[]>(portals.map((tipo) => [tipo, []]));
	if (portals.length === 0) return hosts;
	for (const section of await listSectionNodes()) {
		for (const portal of portals) {
			if (await sectionDeclaresComponent(section.tipo, portal)) {
				(hosts.get(portal) as string[]).push(section.tipo);
			}
		}
	}
	return hosts;
}

/** Where a portal's key lives on a host section's records, or null when no matrix column holds it. */
async function storageOf(
	portal: string,
	sectionTipo: string,
): Promise<{ table: string; column: MatrixJsonbColumn } | null> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	const model = await getModelByTipo(portal);
	const column = model === null ? null : getColumnNameByModel(model);
	if (
		table === null ||
		!MATRIX_TABLE_ALLOWLIST.includes(table) ||
		column === null ||
		!(MATRIX_JSONB_COLUMNS as readonly string[]).includes(column)
	) {
		return null;
	}
	return { table, column: column as MatrixJsonbColumn };
}

/**
 * Every record of `sectionTipo` holding the key, with its stored array (an
 * unlocked scan), one KEYSET page at a time (HOLDER_PAGE rows after the last
 * section_id seen) — memory is bounded by a page, not by the section.
 */
async function* holders(
	storage: { table: string; column: MatrixJsonbColumn },
	sectionTipo: string,
	portal: string,
): AsyncGenerator<{ id: number; value: unknown }> {
	let after = Number.MIN_SAFE_INTEGER;
	for (;;) {
		// table and column are allowlisted above (§7.6 pattern); tipo/key/cursor are bound.
		const rows = (await sql.unsafe(
			`SELECT section_id AS id, "${storage.column}"->$2 AS value
			 FROM "${storage.table}"
			 WHERE section_tipo = $1 AND "${storage.column}" ? $2 AND section_id > $3
			 ORDER BY section_id
			 LIMIT ${HOLDER_PAGE}`,
			[sectionTipo, portal, after],
		)) as { id: number; value: unknown }[];
		for (const row of rows) yield { id: Number(row.id), value: row.value };
		if (rows.length < HOLDER_PAGE) return;
		after = Number(rows[rows.length - 1]?.id);
	}
}

/** The array ranked by the declared order when it differs from `stored`, else null (in order). */
async function rankedIfDrifted(
	stored: unknown,
	portal: string,
	sectionTipo: string,
): Promise<unknown[] | null> {
	if (!Array.isArray(stored) || stored.length < 2) return null;
	const ranked = await sortByDeclaredOrder(stored, portal, sectionTipo);
	if (ranked === null) return null;
	return JSON.stringify(ranked) === JSON.stringify(stored) ? null : ranked;
}

/**
 * APPLY one record: re-read the key FOR UPDATE inside the record's transaction
 * (joins an ambient one — the update run's), rank the LOCKED array, and save
 * it through the normal door when it is still out of order. Returns null on
 * success / nothing to do, else the failure sentence.
 */
async function applyRecord(
	storage: { table: string; column: MatrixJsonbColumn },
	portal: string,
	address: RecordAddress,
): Promise<{ written: boolean; error: string | null }> {
	return withTransaction(async () => {
		const locked = await readMatrixKeyForUpdate(
			storage.table,
			address.section_tipo,
			address.section_id,
			storage.column,
			portal,
		);
		if (locked === null) return { written: false, error: null };
		const ranked = await rankedIfDrifted(locked, portal, address.section_tipo);
		if (ranked === null) return { written: false, error: null };
		const saved = await saveComponentData({
			componentTipo: portal,
			sectionTipo: address.section_tipo,
			sectionId: address.section_id,
			lang: 'lg-nolan',
			changedData: [{ action: 'set_data', value: ranked }],
			userId: RECONCILE_PRINCIPAL.userId,
			principal: RECONCILE_PRINCIPAL,
		});
		return saved.ok
			? { written: true, error: null }
			: { written: false, error: saved.message || 'save refused' };
	});
}

/** Throw the run's abort reason (the SIGTERM drain, or the caller job's stop / deadline). */
function checkAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted !== true) return;
	throw new DedaloError('update.failed', {
		message: `${PORTAL_DECLARED_ORDER}: aborted (${String(signal.reason ?? 'signal')})`,
		publicMessage: 'The declared-order reconcile was stopped',
	});
}

/**
 * A thrown failure's sentence for the report: its CODE only — the DedaloError
 * code, or `internal.unexpected` for an untyped throw (a Postgres error, a
 * TypeError). The report is a payload (the registry's `detail`, published on the
 * reconcile_status widget), so the raw exception text NEVER enters it (ERRORS_SPEC
 * — the disclosure ladder; error_taxonomy_tripwire A6): it goes to the log, with
 * the record address, here.
 */
function failureSentence(error: unknown, address: RecordAddress): string {
	console.error(
		`[reconcile] ${PORTAL_DECLARED_ORDER}: ${address.section_tipo}/${address.section_id} failed:`,
		error,
	);
	return error instanceof DedaloError ? error.code : 'internal.unexpected';
}

/** Record one record's failure: counted exactly, listed up to REPORT_SAMPLE. */
function noteFailure(
	report: DeclaredOrderPortalReport,
	address: RecordAddress,
	error: string,
): void {
	report.failedCount++;
	if (report.failed.length < REPORT_SAMPLE) report.failed.push({ ...address, error });
}

/**
 * Judge (and, on apply, rewrite) ONE holder. Every failure of THIS record — the
 * ranking refusing its stored array, a save refused (ok:false) or THROWN — is
 * isolated: counted and listed, and the run goes on to the next record (one
 * malformed legacy array must not hide the verdict, nor stop the backfill, for
 * every record after it). Only the run's abort (checkAborted) passes through.
 */
async function reconcileHolder(
	report: DeclaredOrderPortalReport,
	storage: { table: string; column: MatrixJsonbColumn },
	portal: string,
	address: RecordAddress,
	stored: unknown,
	apply: boolean,
): Promise<void> {
	if (!(await judgeHolder(report, portal, address, stored))) return;
	if (apply) await applyHolder(report, storage, portal, address);
}

/** reconcileHolder's verdict half: true when the stored array is drifted (counted and sampled). */
async function judgeHolder(
	report: DeclaredOrderPortalReport,
	portal: string,
	address: RecordAddress,
	stored: unknown,
): Promise<boolean> {
	try {
		if ((await rankedIfDrifted(stored, portal, address.section_tipo)) === null) return false;
	} catch (error) {
		noteFailure(report, address, `not judgeable: ${failureSentence(error, address)}`);
		return false;
	}
	report.drift++;
	if (report.drifted.length < REPORT_SAMPLE) report.drifted.push(address);
	return true;
}

/** reconcileHolder's apply half: one drifted record rewritten, its failure isolated. */
async function applyHolder(
	report: DeclaredOrderPortalReport,
	storage: { table: string; column: MatrixJsonbColumn },
	portal: string,
	address: RecordAddress,
): Promise<void> {
	try {
		const outcome = await applyRecord(storage, portal, address);
		if (outcome.written) report.applied++;
		if (outcome.error !== null) noteFailure(report, address, outcome.error);
	} catch (error) {
		noteFailure(report, address, failureSentence(error, address));
	}
}

/** One portal over every host section: scan, judge, and (apply) rewrite. */
async function reconcilePortal(
	portal: string,
	sections: string[],
	options: DeclaredOrderReconcileOptions,
): Promise<DeclaredOrderPortalReport> {
	const report: DeclaredOrderPortalReport = {
		tipo: portal,
		sections,
		records: 0,
		drift: 0,
		applied: 0,
		drifted: [],
		failedCount: 0,
		failed: [],
	};
	for (const sectionTipo of sections) {
		const storage = await storageOf(portal, sectionTipo);
		if (storage === null) continue;
		for await (const row of holders(storage, sectionTipo, portal)) {
			checkAborted(options.signal);
			report.records++;
			const address = { section_tipo: sectionTipo, section_id: row.id };
			await reconcileHolder(report, storage, portal, address, row.value, options.apply === true);
		}
	}
	return report;
}

/**
 * THE RECONCILE: every declared-order portal (or the scope), every holder of
 * its key, stored vs declared order. Dry by default; `apply` rewrites through
 * the save door (module header).
 */
export async function reconcilePortalDeclaredOrder(
	options: DeclaredOrderReconcileOptions = {},
): Promise<DeclaredOrderReconcileSummary> {
	const skipped: DeclaredOrderReconcileSummary['skipped'] = [];
	const portals = await portalsInScope(options.scope, skipped);
	const hosts = await hostSectionsByPortal(portals);
	const reports: DeclaredOrderPortalReport[] = [];
	for (const portal of portals) {
		checkAborted(options.signal);
		reports.push(await reconcilePortal(portal, hosts.get(portal) ?? [], options));
	}
	return {
		apply: options.apply === true,
		portals: reports,
		skipped,
		drift: reports.reduce((sum, report) => sum + report.drift, 0),
		applied: reports.reduce((sum, report) => sum + report.applied, 0),
		failed: reports.reduce((sum, report) => sum + report.failedCount, 0),
	};
}

/** The operator lines of a summary (the trigger's log, the CLI's report). */
export function declaredOrderReportLines(summary: DeclaredOrderReconcileSummary): string[] {
	const mode = summary.apply ? 'apply' : 'dry';
	const lines = [
		`${PORTAL_DECLARED_ORDER} (${mode}): ${summary.portals.length} declared-order portal(s), ${summary.drift} record(s) out of order, ${summary.applied} rewritten, ${summary.failed} failed`,
	];
	for (const portal of summary.portals) lines.push(...portalReportLines(portal));
	for (const entry of summary.skipped) lines.push(`  skipped ${entry.tipo}: ${entry.reason}`);
	return lines;
}

/** One portal's operator lines: none when it neither drifted nor failed. */
function portalReportLines(portal: DeclaredOrderPortalReport): string[] {
	if (portal.drift === 0 && portal.failedCount === 0) return [];
	return [
		`  ${portal.tipo}: ${portal.records} holder(s), ${portal.drift} out of order, ${portal.applied} rewritten, ${portal.failedCount} failed`,
		...portal.failed.map(
			(failure) => `    failed ${failure.section_tipo}/${failure.section_id}: ${failure.error}`,
		),
	];
}

/** The registry run: the summary as a ReconcileReport. */
async function runDeclaredOrder(options: ReconcileRunOptions): Promise<ReconcileReport> {
	const summary = await reconcilePortalDeclaredOrder({
		apply: options.apply,
		...(options.scope === undefined ? {} : { scope: options.scope }),
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
	return {
		drift: summary.drift,
		applied: summary.applied,
		detail: summary as unknown as Record<string, unknown>,
	};
}

export const PORTAL_DECLARED_ORDER_RECONCILE: ReconcileDefinition = {
	name: PORTAL_DECLARED_ORDER,
	stores: [
		'stored locator arrays of declared-order portals (matrix relation keys)',
		'the declared per-ddo order of those portals (ontology show.ddo_map[].order)',
	],
	description:
		'Find records whose stored portal array is not in the order its ontology declares (records saved before the declaration, a declaration added or changed, a raw restore). Apply re-sorts each one through the normal save (Time Machine row, observer and diffusion obligations), re-reading the array under a row lock so a concurrent edit is never overwritten.',
	scopeLabel: 'portal component tipo',
	// Walks every holder of every declared-order portal and its apply writes a TM row
	// per drifted record: an operator sweep (and the ontology-change trigger),
	// never a boot step.
	schedule: 'operator',
	sources: ['src/core/relations/declared_order_reconcile.ts'],
	run: runDeclaredOrder,
};

/** The background job kind of a hand-off (queueDeclaredOrderReconcile — REQUEST CONTEXT). */
export const DECLARED_ORDER_JOB_KIND = 'reconcile_portal_declared_order';

/**
 * The ontology-change sweeps a running BATCH collects instead of running one
 * per write (withDeclaredOrderReconcileBatch). AsyncLocalStorage, never a
 * module-level collection: two concurrent updates must never share one
 * (engineering/REQUEST_ISOLATION.md).
 */
const batchStore = new AsyncLocalStorage<Set<string>>();

/**
 * Run `work` as ONE ontology-change batch: every sweep the writes inside it
 * queue (each only for a write that COMMITTED — the commit lane adds its scope)
 * is COLLECTED, and ONE scoped sweep over the union runs after `work` settles —
 * also when it throws: the tlds that committed before the failure still owe it.
 *
 * WHY. An ontology update rebuilds and commits one tld after another
 * (ontology_update.ts deriveOntologyPackages, then its cross-package model
 * pass). A sweep run between two tlds ranks against a HALF-APPLIED ontology: a
 * declared order in tld A whose column (or that column's model) is added or
 * changed by tld B, staged later, is ranked on B's OLD definitions and the
 * wrong order is written at scale — and nothing re-queues A's portal when B
 * commits, because only a change to A's own `order` declaration queues one.
 * The batch moves the sweep to after the LAST tld (and the model pass).
 * Nested batches join the outermost one.
 */
export async function withDeclaredOrderReconcileBatch<T>(work: () => Promise<T>): Promise<T> {
	if (batchStore.getStore() !== undefined) return work();
	const collected = new Set<string>();
	try {
		return await batchStore.run(collected, work);
	} finally {
		await queueDeclaredOrderReconcile([...collected]);
	}
}

/**
 * Collect `scope` into the running batch, if any (true), once the writer's
 * transaction COMMITS — a rolled-back write owes nothing.
 */
function collectIntoBatch(scope: readonly string[]): boolean {
	const batch = batchStore.getStore();
	if (batch === undefined) return false;
	const collect = async (): Promise<void> => {
		for (const tipo of scope) batch.add(tipo);
	};
	if (!registerCommitAction(collect)) void collect();
	return true;
}

/** One APPLY sweep through the registry, logged; a failed RUN is logged with its scope, never thrown. */
async function runScopedSweep(scope: readonly string[], signal?: AbortSignal): Promise<void> {
	try {
		// Registered here (idempotent — the same definition object): the
		// trigger may fire before any door ran the catalog assembly.
		registerReconcile(PORTAL_DECLARED_ORDER_RECONCILE);
		const { report } = await runReconcile(PORTAL_DECLARED_ORDER, {
			apply: true,
			scope,
			...(signal === undefined ? {} : { signal }),
		});
		const summary = report.detail as unknown as DeclaredOrderReconcileSummary;
		for (const line of declaredOrderReportLines(summary)) console.log(`[reconcile] ${line}`);
	} catch (error) {
		console.error(
			`[reconcile] ${PORTAL_DECLARED_ORDER} after an ontology change (${scope.join(',')}) failed — re-run it scoped to those portals (Maintenance › Reconcile, or scripts/reconcile.ts):`,
			error,
		);
	}
}

/**
 * Hand the sweep to a tracked BACKGROUND job (media/jobs.ts, lane
 * `maintenance`): its own deadline (the lane's), its stop control
 * (stop_process), its shutdown interrupt, its pfile — and the job's signal
 * reaches runReconcile, so the `reconcile` gauge still records the outcome.
 */
function submitSweepJob(scope: readonly string[]): void {
	const job = mediaJobs.submit(
		DECLARED_ORDER_JOB_KIND,
		async ({ signal }) => {
			await runScopedSweep(scope, signal);
			return { scope };
		},
		{ lane: 'maintenance', userId: currentPrincipal()?.userId ?? SUPERUSER_ID },
	);
	console.log(
		`[reconcile] ${PORTAL_DECLARED_ORDER} after an ontology change (${scope.join(',')}): handed to background job ${job.id}`,
	);
}

/**
 * The ONTOLOGY-CHANGE trigger (module header, WHO RUNS IT): an APPLY scoped to
 * `portalTipos`, queued to run after the ambient transaction COMMITS — the
 * committed declaration is what it must read, and a rolled-back declaration
 * must re-sort nothing. Outside a transaction it is launched now.
 *
 * THROUGH THE REGISTRY (runReconcile), like the operator's run: its outcome —
 * drift, applied, the exact failure count in `detail`, or the thrown code — is
 * what the `reconcile` gauge (GET /api/v1/counters, the reconcile_status
 * widget) shows as this reconcile's last run, so an incomplete backfill is
 * visible where the operator looks, not only in a log line. A record that
 * fails is isolated (reconcileHolder) and the sweep goes on; a failed RUN is
 * logged with the exact scope to re-run, never thrown: the ontology write
 * already committed.
 *
 * WHERE IT RUNS — decided at QUEUE time, inside the writer's own async extent:
 *  - inside a BATCH (withDeclaredOrderReconcileBatch — the ontology update):
 *    collected, ONE sweep after the whole update;
 *  - inside a BACKGROUND JOB (media/job_scope.ts currentJobSignal — an update
 *    run outside a batch, an import): AWAITED in the commit lane
 *    (registerCommitAction), carrying the job's stop / deadline / shutdown
 *    signal. Not detached: a detached sweep would outlive the job that owes it
 *    and die with an update's planned restart unseen;
 *  - inside an HTTP REQUEST (a request context, no job — tool_ontology's
 *    developer `set_records_in_dd_ontology`, a TM undelete of an ontology
 *    record): HANDED OFF to a background job (submitSweepJob). The request
 *    never waits on a sweep over every holder: a proxy timeout would report a
 *    committed ontology write as failed, and the sweep would have no deadline;
 *  - anywhere else (a CLI, a boot task): awaited in the commit lane.
 * runReconcile adds the SIGTERM drain's abort (reconcile/scheduler.ts
 * stopReconcileScheduler → abortInFlightReconciles) to every one, so no
 * shutdown waits out a sweep; it ends at the next record, typed and recorded.
 * What an abort or a process death leaves is drift the operator reconcile's dry
 * run lists (engineering/PRODUCTION.md, the portal_declared_order row): no
 * durable owed-state is kept (OPEN — it needs a store, and an engine store is an
 * owner decision: WC-2026-10-31-portal-order-model).
 */
export async function queueDeclaredOrderReconcile(portalTipos: readonly string[]): Promise<void> {
	if (portalTipos.length === 0) return;
	const scope = [...new Set(portalTipos)].sort();
	if (collectIntoBatch(scope)) return;
	const launch = sweepLauncher(scope);
	if (!registerCommitAction(launch)) await launch();
}

/** The commit action of one queued sweep (queueDeclaredOrderReconcile — WHERE IT RUNS), read at queue time. */
function sweepLauncher(scope: readonly string[]): () => Promise<void> {
	const jobSignal = currentJobSignal();
	if (jobSignal === undefined && currentRequestContext() !== undefined) {
		return async () => submitSweepJob(scope);
	}
	return () => runScopedSweep(scope, jobSignal);
}
