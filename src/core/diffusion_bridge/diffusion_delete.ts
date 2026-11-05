/**
 * Diffusion unpublish on delete (PHP diffusion_delete::delete_record): a
 * deleted record's published copies leave every diffusion target.
 *
 *   - sql / socrata elements → the NATIVE in-process executor registered at
 *     boot (src/diffusion/targets/mariadb/delete_record.ts) receives
 *     [{database_name, table_name, section_ids:[id], section_tipo}] — the
 *     engine wire shape, kept verbatim across the seam;
 *   - rdf / xml / markdown elements → published-file unlinks under the
 *     published-files root — the ONE producer publish uses too
 *     (./published_files.ts, PUB-03): rdf = /rdf/{service}/
 *     {sanitize(rdfName_st_id)}.rdf (+ the legacy '{base}_*.rdf' variants),
 *     xml/markdown = /{type}/{service}/{st}_{id}.{ext}; nothing published →
 *     idempotent success; no root configured → pending;
 *   - TERMINAL targets (PUB-02): a csv/json full-export element (a record
 *     leaves it only by re-publishing), an element without service_name, an
 *     rdf element with no owl:Class for the section, an sql element with no
 *     database/table — none of these ever published a per-record artifact,
 *     or cannot unpublish one. They are ledgered pending WITH a terminal
 *     reason and EXCLUDED from the retry queue, so they can neither starve
 *     it nor pretend to be settled; the public_tier reconcile reports them;
 *   - per-element outcomes land in the dd1758 diffusion log
 *     (matrix_activity_diffusion): unpublished (2) on success,
 *     unpublish_pending (3) on failure — retryPendingDiffusion() re-runs the
 *     pending rows and flips them in place (PHP retry_pending, DIFFU-08
 *     rule: only flip when the retry actually resolved targets). Every retry
 *     stamps the row (misc.dd1758_retry {attempts,last_attempt}) and the
 *     queue is drained least-recently-attempted first, so one row that fails
 *     forever cannot occupy the head for every run (PUB-02);
 *   - DURABLE INTENT (LIFE-07): the record delete writes its pending rows
 *     INSIDE its transaction (ledgerUnpublishIntent) — when target resolution
 *     itself throws, a record-level row — and settles them post-commit
 *     (settleUnpublishIntent). A committed delete therefore always leaves
 *     the debt it owes on the ledger, whatever happens after the commit.
 *
 * No registered executor → DEC-19 loud warning + pending rows (see
 * deleteDiffusionRecord); no targets → silent no-op, matching a fresh
 * install. The old-engine unix-socket/token transport
 * (DEDALO_DIFFUSION_SOCKET_PATH / DEDALO_DIFFUSION_INTERNAL_TOKEN) was
 * retired at the 2026-07-11 cutover (DIFFUSION_PLAN P5 step 3;
 * rewrite/CUTOVER_RUNBOOK.md §5) — the native paths are primary since S2-31.
 */

import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { readEnv } from '../../config/env.ts';
import { canonicalizeStoredSectionId } from '../concepts/section_id.ts';
import { sql } from '../db/postgres.ts';
import { DedaloError } from '../errors/index.ts';
import { fsyncDirectory } from '../files/durable.ts';
import { assertTestMediaRoot } from '../media/test_media_root.ts';
import { nameOrLabelOf } from '../ontology/labels.ts';
import { relationProbeGroups } from '../search/containment.ts';
import { virtualDateNow } from '../section/record/create_record.ts';
import type { DiffusionSqlTarget } from './diffusion_graph.ts';
import { getSectionDiffusionTargets } from './diffusion_map.ts';
import {
	diffusionFilesRoot,
	PER_RECORD_FILE_FORMATS,
	publishedRecordFilePath,
	sanitizePublishedFileName,
} from './published_files.ts';
import { fileTargetLockKey, withDeleteDoorLock } from './target_lock.ts';

// The sanitizer is the producer's (published_files.ts); the name stays exported
// here for the delete-side callers and the gates that pin it.
export { sanitizePublishedFileName };

export interface DiffusionDeleteOutcome {
	/** db|table keys the engine confirmed deleted. */
	deleted: string[];
	/** Targets that failed transiently (retryable): executor errors, unlink failures, no root. */
	pending: string[];
	/**
	 * Targets that can NEVER be settled by a retry (PUB-02): full-export
	 * formats, an element without service_name, an rdf without an owl:Class
	 * for the section, an sql element without database/table. Ledgered with
	 * their reason, excluded from the retry queue, reported by the
	 * public_tier reconcile.
	 */
	terminal: { key: string; reason: string }[];
}

/**
 * TEST-ONLY dd1758 activity-table override (the DIFFUSION_JOBS_TABLE seam
 * twin — S1-17/DEC-18a pattern). Every dd1758 read/write funnels through this
 * module; without the seam, a test's retryPendingDiffusion selects the oldest
 * pending rows of the REAL matrix_activity_diffusion — its stub engine can
 * flip REAL pending rows to 'unpublished' without any actual delete, and ≥10
 * older real rows starve the test's probe rows (the ledgered intermittent).
 * The bun-test preload (test/preload/session_db.ts) points
 * DIFFUSION_ACTIVITY_TABLE at a per-run scratch table. Guard: an override
 * MUST carry the scratch prefix `dedalo_ts_test_` — production (including the
 * live dev server's delete executor) can never be redirected; no env → the
 * real 'matrix_activity_diffusion'.
 */
function resolveActivityTable(): string {
	// readEnv (not process.env) per the S2-21 config rule; the bun-test preload
	// sets this in the real process env, which wins the precedence chain anyway,
	// and the dedalo_ts_test_ guard below keeps ANY source from redirecting
	// production to an arbitrary table.
	const override = readEnv('DIFFUSION_ACTIVITY_TABLE');
	if (override === undefined || override === '') {
		return 'matrix_activity_diffusion';
	}
	if (!/^dedalo_ts_test_[a-z0-9_]*$/.test(override)) {
		throw new Error(
			`DIFFUSION_ACTIVITY_TABLE override '${override}' rejected: it is a TEST seam and must match /^dedalo_ts_test_[a-z0-9_]*$/.`,
		);
	}
	return override;
}

/**
 * The dd1758 table for THIS call. Resolved per call, never at module load: the
 * whole unit tier runs in ONE process with ONE module registry, so a load-time
 * const froze whichever value the first importer saw and made a per-file seam
 * structurally impossible (the guard in resolveActivityTable is re-applied on
 * every call, so call-time resolution is strictly stronger, not weaker).
 */
export function activityTable(): string {
	return resolveActivityTable();
}

// Fail FAST: an invalid override is refused at module load, not at the first
// dd1758 write — the boot-time refusal the jobs-table-seam gate pins. The
// resolved value is deliberately discarded; only the guard matters here.
resolveActivityTable();

/** DDL latch, one entry per resolved scratch table (see activityTable). */
const activityTableEnsured = new Map<string, Promise<void>>();

/**
 * Scratch-table bootstrap. The REAL matrix_activity_diffusion is PHP-owned
 * (install/db/matrix_activity_diffusion.sql) — never touched here. When the
 * test seam is active the scratch twin must exist before the first write;
 * columns mirror the PHP DDL (the subset this module and the matrix codecs
 * use), section_id keeps its own sequence default ("sequence-allocated
 * section_id", same as the real table).
 *
 * EXPORTED (2026-09-24): a gate that runs raw SQL on the scratch table (a
 * sweep DELETE, a row-shape SELECT) needs it to EXIST first, and the lazy
 * creation here runs only on this module's own entry points. Unexported, the
 * gates materialized it through a side effect (`retryPendingDiffusion(1)`) or
 * not at all — and went 42P01 whenever no earlier file in the process had
 * created it (the unit-census reds right after `test:db:setup`). Tests reach
 * it through test/helpers/diffusion_scratch_tables.ts, never directly.
 */
export async function ensureDiffusionActivityTable(): Promise<void> {
	const table = activityTable();
	if (table === 'matrix_activity_diffusion') return; // PHP owns the real DDL
	if (!activityTableEnsured.has(table)) {
		const ensuring = (async () => {
			await sql.unsafe(`CREATE SEQUENCE IF NOT EXISTS "${table}_section_id_seq"`);
			await sql.unsafe(`
				CREATE TABLE IF NOT EXISTS "${table}" (
					id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
					"timestamp" timestamp without time zone DEFAULT now(),
					section_id integer NOT NULL DEFAULT nextval('${table}_section_id_seq'),
					section_tipo character varying(255) NOT NULL,
					data jsonb,
					relation jsonb,
					string jsonb,
					date jsonb,
					iri jsonb,
					geo jsonb,
					number jsonb,
					media jsonb,
					misc jsonb,
					relation_search jsonb,
					meta jsonb
				)
			`);
		})().catch((error) => {
			// A failed bootstrap must not poison the memo forever — retry next call.
			activityTableEnsured.delete(table);
			throw error;
		});
		activityTableEnsured.set(table, ensuring);
	}
	return activityTableEnsured.get(table);
}

/** One sql/socrata delete target handed to the executor (engine wire shape). */
export interface NativeSqlDeleteTarget {
	database_name: string;
	table_name: string;
	section_ids: (number | string)[];
	section_tipo?: string;
}

type NativeSqlDeleteExecutor = (
	targets: NativeSqlDeleteTarget[],
) => Promise<{ deleted: string[]; errors: string[] }>;

/**
 * Native in-process SQL delete executor, registered by the diffusion module
 * at boot (src/diffusion/targets/mariadb/delete_record.ts). Registration seam
 * instead of an import because core must never import src/diffusion/**
 * (DIFFUSION_SPEC §2.5 boundary; ragRecordHook precedent). While unregistered
 * there is NO fallback (the old-engine socket retired at the 2026-07-11
 * cutover): sql deletes go pending with the DEC-19 loud warning.
 */
let nativeSqlDeleteExecutor: NativeSqlDeleteExecutor | null = null;

export function registerNativeDiffusionSqlDelete(executor: NativeSqlDeleteExecutor): void {
	nativeSqlDeleteExecutor = executor;
}

/** Test hook: drop the registered executor (restores the DEC-19 pending state). */
export function resetNativeDiffusionSqlDeleteForTests(): void {
	nativeSqlDeleteExecutor = null;
}

/**
 * Native media-index (publication-marker store) operations, registered by the
 * diffusion module at boot (src/diffusion/targets/mediastore/media_index.ts)
 * through the same seam pattern as the SQL delete executor (S2-31 port).
 * While unregistered there is NO fallback: rebuild reports the DEC-19 loud
 * error (the old-engine socket retired at the 2026-07-11 cutover).
 */
export interface NativeMediaIndexOps {
	/**
	 * The FOREIGN shape of src/diffusion/targets/mediastore/media_index.ts
	 * (`rebuildMediaIndexStore`) — declared here as the seam contract, owned
	 * there. Its `ok` flag is that module's field name, not a wire body:
	 * `rebuildMediaIndex` below turns a false one into a typed throw.
	 */
	rebuild(
		targets: { database_name: string; table_name: string; section_tipo: string }[],
	): Promise<{ ok: boolean; message: string; markers: number; errors?: string[] }>;
	getStatus(): Promise<{
		enabled: boolean;
		base: string | null;
		pub_markers: number;
		auth_markers: number;
		databases: string[];
	}>;
	/** Healed, DEFERRED (a writer kept a marker database past the bounded wait — nothing applied), or null (store off). */
	reconcile(): Promise<
		| { added: number; removed: number; deferred?: undefined }
		| { deferred: { busy_target: string } }
		| null
	>;
}

let nativeMediaIndexOps: NativeMediaIndexOps | null = null;

export function registerNativeMediaIndex(ops: NativeMediaIndexOps): void {
	nativeMediaIndexOps = ops;
}

/** The registered native media-index ops (null while unregistered). */
export function getNativeMediaIndexOps(): NativeMediaIndexOps | null {
	return nativeMediaIndexOps;
}

/** Test hook: drop the registered ops (restores the DEC-19 unregistered state). */
export function resetNativeMediaIndexForTests(): void {
	nativeMediaIndexOps = null;
}

/**
 * The keys of an sql/socrata target that never published anything: the
 * compiler refuses an element without a database or table label, so a
 * delete-side target with an empty name has NOTHING to unpublish — terminal,
 * never pending (PUB-02: these rows used to sit at the head of the retry
 * queue forever).
 */
function sqlTargetTerminalReason(target: DiffusionSqlTarget): string | null {
	if (target.database_name === '') return 'sql element has no database node — never published';
	if (target.table_name === '') return 'sql element has no table label — never published';
	return null;
}

/** Propagate a record deletion to the diffusion targets. Never throws. */
export async function deleteDiffusionRecord(
	sectionTipo: string,
	sectionId: number,
	/** false when a retry drives the call (the pending row IS the log). */
	logActivity = true,
	/** The acting user for the dd1758 ledger; absent → dd1762 omitted. */
	userId?: number,
	/**
	 * Restrict the run to these element tipos (PHP retry_pending's
	 * `only_element_tipos`). The retry loop passes the pending row's dd1766
	 * element so its flip criterion is that element's outcome, never the
	 * record's; absent → every element of the section.
	 */
	onlyElementTipos?: readonly string[],
): Promise<DiffusionDeleteOutcome> {
	const outcome: DiffusionDeleteOutcome = { deleted: [], pending: [], terminal: [] };
	// Hoisted so the dd1758 fold below sees the SAME (restricted) target set
	// this run acted on — and is reached on every path that produced one.
	let targets: readonly DiffusionSqlTarget[] = [];
	try {
		targets = restrictToElements(await getSectionDiffusionTargets(sectionTipo), onlyElementTipos);

		const sqlTargets: DiffusionSqlTarget[] = [];
		for (const target of targets) {
			if (target.type === 'sql' || target.type === 'socrata') {
				const terminal = sqlTargetTerminalReason(target);
				if (terminal === null) sqlTargets.push(target);
				else outcome.terminal.push({ key: targetKey(target), reason: terminal });
				continue;
			}
			const unlinked = await unlinkPublishedFiles(
				target.element_tipo,
				target.type,
				sectionTipo,
				sectionId,
			);
			if (unlinked.kind === 'unpublished') outcome.deleted.push(targetKey(target));
			else if (unlinked.kind === 'terminal') {
				outcome.terminal.push({ key: targetKey(target), reason: unlinked.reason });
			} else outcome.pending.push(targetKey(target));
		}

		// NATIVE path (DIFFUSION_SPEC §4.2) — the ONLY executor since the
		// 2026-07-11 cutover: MariaDB deletes run through the registered
		// in-process executor, then execution falls through to the dd1758
		// ledger below. No sql target → nothing to execute, and execution
		// falls through to that same ledger (D10, fixed 2026-08-09: the old
		// `if (sqlTargets.length === 0) return outcome;` returned first and
		// left a file-only section's failed unlink with no pending row).
		if (sqlTargets.length > 0) {
			if (nativeSqlDeleteExecutor === null) {
				// DEC-19: sql targets exist but no native executor is registered —
				// delete propagation is NOT running and published rows/markers will
				// rot. Loud, per DECISIONS.md:391-395. (No dd1758 rows here — the
				// deliberate fresh-install no-op posture; with the executor
				// registered at boot this branch only fires when that registration
				// failed, which server.ts already reports as FATAL-FOR-DELETES.)
				console.error(
					`[diffusion] DEC-19: record ${sectionTipo}/${sectionId} has ${sqlTargets.length} sql publication target(s) but no native delete executor is registered — unpublish is deferred to pending rows. Fix the boot registration (src/server.ts).`,
				);
				for (const target of sqlTargets) {
					outcome.pending.push(targetKey(target));
				}
				return outcome;
			}
			await executeNativeSqlDeletes(
				nativeSqlDeleteExecutor,
				sqlTargets,
				sectionTipo,
				sectionId,
				outcome,
			);
		}
	} catch (error) {
		// Swallowed on purpose (a delete must not fail on its side effects) — but
		// NOT silent about the debt: the caller that owns the record delete has
		// already written its intent rows inside its transaction
		// (ledgerUnpublishIntent, LIFE-07); a direct caller gets the ledger below
		// from whatever target list was resolved (possibly none — which is why
		// the record delete no longer relies on this path for its debt).
		console.error(
			`diffusion unpublish of ${sectionTipo}/${sectionId} failed (swallowed; the intent rows written inside the delete transaction keep the debt):`,
			error,
		);
	}
	await logUnpublishOutcome(targets, sectionTipo, sectionId, outcome, logActivity, userId);
	return outcome;
}

/**
 * Keep only the named elements (PHP retry_pending's `only_element_tipos`).
 * An absent/empty restriction means "every element", never "no element".
 */
function restrictToElements(
	targets: readonly DiffusionSqlTarget[],
	onlyElementTipos: readonly string[] | undefined,
): readonly DiffusionSqlTarget[] {
	if (onlyElementTipos === undefined || onlyElementTipos.length === 0) return targets;
	return targets.filter((target) => onlyElementTipos.includes(target.element_tipo));
}

/** Hand the sql/socrata targets to the registered executor and record each outcome. */
async function executeNativeSqlDeletes(
	executor: NativeSqlDeleteExecutor,
	sqlTargets: readonly DiffusionSqlTarget[],
	sectionTipo: string,
	sectionId: number,
	outcome: DiffusionDeleteOutcome,
): Promise<void> {
	const native = await executor(
		sqlTargets.map((target) => ({
			database_name: target.database_name,
			table_name: target.table_name,
			section_ids: [sectionId],
			section_tipo: sectionTipo, // enables media marker removal in the store
		})),
	);
	const confirmed = new Set(native.deleted);
	for (const target of sqlTargets) {
		const key = targetKey(target);
		if (confirmed.has(key)) outcome.deleted.push(key);
		else outcome.pending.push(key);
	}
	if (native.errors.length > 0) {
		console.error('diffusion unpublish reported errors:', native.errors);
	}
}

/**
 * The outcome-ledger key of a target — the SINGLE producer of the strings
 * pushed into DiffusionDeleteOutcome.deleted/pending, so the fold below reads
 * the same grammar the delete path wrote (DIFF-A class of drift):
 * sql/socrata → `db|table`, file elements → `type:element_tipo`.
 */
export function targetKey(target: DiffusionSqlTarget): string {
	return target.type === 'sql' || target.type === 'socrata'
		? `${target.database_name}|${target.table_name}`
		: `${target.type}:${target.element_tipo}`;
}

/** How one element of a run ended (the fold of its targets). */
export type ElementOutcome =
	| { kind: 'unpublished' }
	| { kind: 'pending' }
	| { kind: 'terminal'; reason: string };

/**
 * Fold per-target confirmations into per-element outcomes: an element is
 * successful ONLY when EVERY one of its targets confirmed (AND, not OR — one
 * unconfirmed target poisons its element). Elements fold independently. An
 * element is TERMINAL when nothing of it confirmed and every unconfirmed
 * target is terminal (PUB-02: a retry can never settle it); one transient
 * target keeps the element pending (retryable).
 */
export function foldElementOutcomes(
	targets: readonly DiffusionSqlTarget[],
	outcome: Pick<DiffusionDeleteOutcome, 'deleted' | 'terminal'>,
): Map<string, ElementOutcome> {
	const deletedKeys = new Set(outcome.deleted);
	const terminalReasons = new Map(outcome.terminal.map((entry) => [entry.key, entry.reason]));
	const perElement = new Map<string, DiffusionSqlTarget[]>();
	for (const target of targets) {
		const list = perElement.get(target.element_tipo) ?? [];
		list.push(target);
		perElement.set(target.element_tipo, list);
	}
	const elements = new Map<string, ElementOutcome>();
	for (const [elementTipo, list] of perElement) {
		elements.set(elementTipo, foldOneElement(list, deletedKeys, terminalReasons));
	}
	return elements;
}

/** One element's fold: unpublished when every target confirmed; terminal when none did and none can. */
function foldOneElement(
	list: readonly DiffusionSqlTarget[],
	deletedKeys: ReadonlySet<string>,
	terminalReasons: ReadonlyMap<string, string>,
): ElementOutcome {
	const unconfirmed = list.filter((target) => !deletedKeys.has(targetKey(target)));
	if (unconfirmed.length === 0) return { kind: 'unpublished' };
	const reasons = unconfirmed.map((target) => terminalReasons.get(targetKey(target)) ?? null);
	if (unconfirmed.length === list.length && reasons.every((reason) => reason !== null)) {
		return { kind: 'terminal', reason: reasons.join('; ') };
	}
	return { kind: 'pending' };
}

/** The whole-record fold: every element unpublished / all terminal / else pending. */
export function foldRecordOutcome(
	targets: readonly DiffusionSqlTarget[],
	outcome: Pick<DiffusionDeleteOutcome, 'deleted' | 'terminal'>,
): ElementOutcome {
	const elements = [...foldElementOutcomes(targets, outcome).values()];
	if (elements.length === 0) return { kind: 'pending' }; // nothing resolved: keep the debt
	if (elements.every((element) => element.kind === 'unpublished')) return { kind: 'unpublished' };
	const terminal = elements.filter(
		(element): element is { kind: 'terminal'; reason: string } => element.kind === 'terminal',
	);
	if (terminal.length === elements.length) {
		return { kind: 'terminal', reason: terminal.map((element) => element.reason).join('; ') };
	}
	return { kind: 'pending' };
}

/**
 * dd1758 diffusion log: one row per element (sql AND file) — unpublished (2)
 * when every one of its targets confirmed, unpublish_pending (3) otherwise; a
 * terminal element's pending row carries its reason in misc.dd1758_retry so
 * the retry queue skips it and the reconcile reports it.
 */
async function logUnpublishOutcome(
	/** The targets this run acted on — already restricted by onlyElementTipos. */
	targets: readonly DiffusionSqlTarget[],
	sectionTipo: string,
	sectionId: number,
	outcome: DiffusionDeleteOutcome,
	logActivity: boolean,
	userId?: number,
): Promise<void> {
	if (!logActivity) return;
	try {
		const elements = foldElementOutcomes(targets, outcome);
		for (const [elementTipo, result] of elements) {
			await logDiffusionActivity({
				sectionTipo,
				sectionId,
				elementTipo,
				action:
					result.kind === 'unpublished'
						? DIFFUSION_ACTION.unpublished
						: DIFFUSION_ACTION.unpublishPending,
				userId,
				...(result.kind === 'terminal'
					? { retry: { attempts: 0, last_attempt: null, terminal: result.reason } }
					: {}),
			});
		}
	} catch (error) {
		console.error('diffusion log write failed (swallowed):', error);
	}
}

/** dd1767 action ids (PHP diffusion_activity_logger). */
export const DIFFUSION_ACTION = { published: 1, unpublished: 2, unpublishPending: 3 } as const;

/**
 * D16 — THE ACTION IS NOT AN ADDRESS.
 *
 * PHP wrote the dd1767 action id into a locator's `section_id`, pointing at a
 * `dd1774` section that does not exist in the ontology and holds no records:
 * the field named "record address" carried an ENUM TOKEN. Under
 * WC-2026-08-10-section-id-int-canonical every `section_id` in the matrix is a
 * record address, so the token gets its own key and stops lying:
 *
 *     { type, diffusion_action: 3, section_tipo: 'dd1774', from_component_tipo }
 *
 * `section_tipo: 'dd1774'` stays — it is the ledger's discriminator, and the
 * probes below key on it. WRITE NEW, READ BOTH: rows written before this change
 * (and rows whose legacy `section_id` a canonicalization sweep has since turned
 * from '3' into 3) are still matched by diffusionActionProbePayloads, and the
 * retry loop upgrades every row it flips to the new shape.
 */
export const DIFFUSION_ACTION_KEY = 'diffusion_action';
const DIFFUSION_ACTION_SECTION = 'dd1774';
const DIFFUSION_ACTION_COMPONENT = 'dd1767';

/**
 * Every stored shape of "the dd1767 action is `action`", as jsonb containment
 * payloads to OR together: the new explicit-key shape first, then the two
 * typed forms of the legacy locator shape (string and int section_id — the
 * dual-probe law of core/search/containment.ts).
 */
export function diffusionActionProbePayloads(action: number): string[] {
	const legacy = relationProbeGroups(DIFFUSION_ACTION_COMPONENT, [
		{ section_id: String(action), section_tipo: DIFFUSION_ACTION_SECTION },
	])[0] as string[];
	return [
		`{"${DIFFUSION_ACTION_COMPONENT}":[{"${DIFFUSION_ACTION_KEY}":${action},"section_tipo":"${DIFFUSION_ACTION_SECTION}"}]}`,
		...legacy,
	];
}

/**
 * The shape-tolerant SQL predicate for the probe payloads above. `bind` maps a
 * payload to its placeholder — callers bind, never inline (the payloads are
 * built from numeric constants here, but the discipline is the module's).
 */
export function diffusionActionContains(
	columnRef: string,
	action: number,
	bind: (payload: string) => string,
): string {
	const ors = diffusionActionProbePayloads(action).map(
		(payload) => `${columnRef} @> ${bind(payload)}::text::jsonb`,
	);
	return `(${ors.join(' OR ')})`;
}

/**
 * Append one dd1758 diffusion-log row (matrix_activity_diffusion, sequence-
 * allocated section_id): dd1762 user, dd1763 processed-record locator,
 * dd1764 section_id number, dd1765 section_tipo string, dd1766 element
 * locator ({tld}0 / numeric part — the ontology-node-as-record convention),
 * dd1767 action (see DIFFUSION_ACTION_KEY).
 *
 * Every locator section_id is minted in canonical INT form
 * (WC-2026-08-10-section-id-int-canonical) — the ledger's addresses are matrix
 * record addresses, and readers below read them through `->>` (text either way)
 * or through the dual-form probes.
 *
 * dd1762 records the REAL acting user; when no userId reaches us the field is
 * OMITTED entirely (PHP diffusion_activity_logger `if ($user_id)`) — never a
 * fabricated superuser −1 locator.
 */
/**
 * THE RETRY STAMP — misc.dd1758_retry on a pending row (PUB-02). `attempts`
 * counts the settle/retry runs that did not resolve the row; `last_attempt`
 * orders the queue (least-recently-attempted first, unattempted first of all);
 * `terminal` names why no retry can ever settle it. misc is the matrix column
 * for non-component state, the key is no component tipo, and the section read
 * never emits unknown misc keys — so the stamp is not on the wire (no WC).
 */
export const RETRY_STAMP_KEY = 'dd1758_retry';

export interface RetryStamp {
	attempts: number;
	/** ISO instant of the last unsuccessful attempt; null before the first. */
	last_attempt: string | null;
	/** Present ⇔ the row is terminal (never retried, always reported). */
	terminal?: string;
}

export async function logDiffusionActivity(entry: {
	sectionTipo: string;
	sectionId: number;
	elementTipo: string | null;
	action: number;
	userId?: number;
	now?: Date;
	/** A retry stamp to write with the row (terminal rows are born stamped). */
	retry?: RetryStamp;
}): Promise<number> {
	const now = entry.now ?? new Date();
	const relation: Record<string, unknown[]> = {
		dd1763: [
			{
				type: 'dd151',
				section_id: entry.sectionId,
				section_tipo: entry.sectionTipo,
				from_component_tipo: 'dd1763',
			},
		],
		[DIFFUSION_ACTION_COMPONENT]: [
			{
				type: 'dd151',
				// D16: the action token rides its OWN key, never section_id.
				[DIFFUSION_ACTION_KEY]: entry.action,
				section_tipo: DIFFUSION_ACTION_SECTION,
				from_component_tipo: DIFFUSION_ACTION_COMPONENT,
			},
		],
	};
	// Truthiness on purpose — PHP's `if ($user_id)`: 0/undefined/NaN → omit.
	if (entry.userId) {
		relation.dd1762 = [
			{
				type: 'dd151',
				section_id: entry.userId,
				section_tipo: 'dd128',
				from_component_tipo: 'dd1762',
			},
		];
	}
	if (entry.elementTipo !== null) {
		const match = entry.elementTipo.match(/^([a-z]+)([0-9]+)$/);
		if (match !== null) {
			relation.dd1766 = [
				{
					type: 'dd151',
					// digits of the element tipo as an address: canonical int
					// (canonicalize, not Number — a padded id would be preserved
					// rather than silently renumbered).
					section_id: canonicalizeStoredSectionId(match[2]),
					section_tipo: `${match[1]}0`,
					from_component_tipo: 'dd1766',
				},
			];
		}
	}
	const { encodeForJsonb } = await import('../db/json_codec.ts');
	await ensureDiffusionActivityTable();
	const misc = entry.retry === undefined ? {} : { [RETRY_STAMP_KEY]: entry.retry };
	const inserted = (await sql.unsafe(
		`INSERT INTO "${activityTable()}" (section_tipo, relation, string, date, number, misc)
		 VALUES ('dd1758', $1::text::jsonb, $2::text::jsonb, $3::text::jsonb, $4::text::jsonb, $5::text::jsonb)
		 RETURNING section_id`,
		[
			encodeForJsonb(relation),
			encodeForJsonb({ dd1765: [{ lang: 'lg-nolan', value: entry.sectionTipo }] }),
			encodeForJsonb({ dd1761: [{ start: virtualDateNow(now) }] }),
			encodeForJsonb({ dd1764: [{ value: entry.sectionId }] }),
			encodeForJsonb(misc),
		],
	)) as { section_id: number }[];
	return Number(inserted[0]?.section_id);
}

/**
 * RETENTION for the dd1758 ledger (audit 2026-08-26 PUB-14).
 *
 * The logger INSERTs — never upserts — one row per PRIMARY record per run, so
 * republishing the same catalogue writes them all again. Measured: 293 MB for a
 * single publish run of a 500k-record catalogue on a reduced-index clone,
 * growing linearly, inside the matrix database `pg_dump` copies. Meanwhile the
 * engine prunes its terminal JOB rows at 7 days and justifies doing so by
 * pointing at THIS table as "the durable audit trail" — so the one store
 * expected to hold history was the one with no policy for it.
 *
 * PENDING ROWS ARE NEVER PRUNED, whatever the window says. A dd1767 = 3
 * (unpublish pending) row is outstanding DEBT to a public target, not history:
 * dropping it would leave a withdrawn record live on a public site with nothing
 * left in the system to say it should not be.
 *
 * The window itself lives in the retention registry (core/retention/prune.ts);
 * the statement lives here, because this module owns the table.
 */
export async function pruneSettledLedgerRows(options: {
	windowDays: number;
	apply: boolean;
	now?: Date;
}): Promise<{ candidates: number; deleted: number; detail: Record<string, unknown> }> {
	const table = activityTable();
	const detail: Record<string, unknown> = { table, window_days: options.windowDays };
	if (options.windowDays <= 0) {
		return { candidates: 0, deleted: 0, detail: { ...detail, kept: 'no window set' } };
	}
	await ensureDiffusionActivityTable();
	const cutoff = new Date(
		(options.now ?? new Date()).getTime() - options.windowDays * 24 * 60 * 60 * 1000,
	).toISOString();
	const params: string[] = [cutoff];
	const pending = diffusionActionContains(
		'relation',
		DIFFUSION_ACTION.unpublishPending,
		(payload) => {
			params.push(payload);
			return `$${params.length}`;
		},
	);
	const where = `"timestamp" < $1 AND NOT ${pending}`;
	const counted = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`,
		params,
	)) as { n: number }[];
	const candidates = Number(counted[0]?.n ?? 0);
	if (!options.apply || candidates === 0) {
		return { candidates, deleted: 0, detail: { ...detail, cutoff } };
	}
	const deleted = (await sql.unsafe(
		`DELETE FROM "${table}" WHERE ${where} RETURNING id`,
		params,
	)) as unknown[];
	return { candidates, deleted: deleted.length, detail: { ...detail, cutoff } };
}

/** One pending dd1758 row as the retry/settle loop reads it. */
interface PendingRow {
	section_id: number;
	target_section: string | null;
	target_id: string | null;
	element_section: string | null;
	element_id: string | null;
}

const PENDING_ROW_PROJECTION = `section_id,
	        relation->'dd1763'->0->>'section_tipo' AS target_section,
	        relation->'dd1763'->0->>'section_id' AS target_id,
	        relation->'dd1766'->0->>'section_tipo' AS element_section,
	        relation->'dd1766'->0->>'section_id' AS element_id`;

/**
 * Re-run pending unpublish rows (PHP diffusion_delete::retry_pending): read
 * dd1758 rows whose dd1767 action is unpublish_pending, re-run the delete
 * restricted to the row's element, and flip the action locator IN PLACE to
 * unpublished — only when the retry actually confirmed targets (DIFFU-08).
 *
 * QUEUE FAIRNESS (PUB-02). The window is the `limit` LEAST-RECENTLY-ATTEMPTED
 * rows — never-attempted first, then by the stamp, then by age — and every
 * row the run could not settle is stamped, so the next run's window starts
 * past it. A row that fails forever therefore rotates through the queue
 * instead of pinning its head; and a TERMINAL row (misc.dd1758_retry.terminal)
 * is not selected at all — it stays on the ledger as reported debt.
 */
function pendingRowsWhere(): { where: string; params: string[] } {
	// `->>` yields text for a stored int as well as a stored string, so the
	// projected target/element ids read identically in both typed forms; only
	// the ACTION probe needs the shape tolerance (D16 + dual-form).
	const params: string[] = [];
	const pendingProbe = diffusionActionContains(
		'relation',
		DIFFUSION_ACTION.unpublishPending,
		(payload) => `$${params.push(payload)}`,
	);
	return {
		where: `section_tipo = 'dd1758'
		   AND ${pendingProbe}
		   AND (misc->'${RETRY_STAMP_KEY}'->>'terminal') IS NULL`,
		params,
	};
}

/** The retryable (non-terminal) pending rows — the read behind the tool's badge (PHP count_pending). */
export async function countPendingDiffusion(): Promise<number> {
	await ensureDiffusionActivityTable();
	const { where, params } = pendingRowsWhere();
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM "${activityTable()}" WHERE ${where}`,
		params,
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

export async function retryPendingDiffusion(
	limit = 100,
): Promise<{ total: number; retried: number; remaining: number }> {
	await ensureDiffusionActivityTable();
	const { where, params: pendingParams } = pendingRowsWhere();
	const rows = (await sql.unsafe(
		`SELECT ${PENDING_ROW_PROJECTION}
		 FROM "${activityTable()}"
		 WHERE ${where}
		 ORDER BY (misc->'${RETRY_STAMP_KEY}'->>'last_attempt') ASC NULLS FIRST, section_id ASC
		 LIMIT ${Math.max(1, Math.floor(limit))}`,
		pendingParams,
	)) as PendingRow[];
	const outcome = { total: rows.length, retried: 0, remaining: 0 };
	for (const row of rows) {
		if (row.target_section === null || row.target_id === null) {
			outcome.remaining++;
			continue;
		}
		if (
			await settlePendingRow({
				...row,
				target_section: row.target_section,
				target_id: row.target_id,
			})
		)
			outcome.retried++;
		else outcome.remaining++;
	}
	return outcome;
}

/**
 * Re-run ONE pending row's unpublish and update the row from the result:
 * flipped to unpublished (true) when its targets confirmed; stamped terminal
 * when none can ever confirm; otherwise stamped with one more attempt
 * (false). Shared by the retry queue and the post-commit settle of a record
 * delete's intent rows, so both update the ledger by the same rule.
 */
async function settlePendingRow(
	row: PendingRow & { target_section: string; target_id: string },
): Promise<boolean> {
	const element = pendingRowElementTipo(row.element_section, row.element_id);
	const retry = await deleteDiffusionRecord(
		row.target_section,
		Number(row.target_id),
		false, // the pending row already represents the intent — no new rows
		undefined,
		// D10b (fixed 2026-08-09): restrict the retry to THIS row's element
		// (PHP retry_pending `only_element_tipos`). Without it the flip below
		// — record-level `retry.deleted.length > 0` — marks a still-failing
		// element 'unpublished' because a SIBLING element succeeded.
		element === null ? undefined : [element],
	);
	// Settled ⇔ something confirmed AND nothing this row addresses is still
	// owed: the AND law of the element fold, applied to the row. For an
	// element-restricted row that is the element's own targets; for a
	// record-level row (resolution threw at delete time) it is EVERY element —
	// one confirmed sibling must not flip a row that still owes another.
	const settled =
		retry.deleted.length > 0 && retry.pending.length === 0 && retry.terminal.length === 0;
	if (settled) {
		await flipPendingRowUnpublished(row.section_id);
		return true;
	}
	await stampPendingRow(row.section_id, terminalReasonOf(retry));
	return false;
}

/**
 * Terminal only when EVERYTHING this row addresses is terminal — an
 * element-less (record-level) row folds over the whole record. Null = retryable.
 */
function terminalReasonOf(
	retry: Pick<DiffusionDeleteOutcome, 'pending' | 'terminal'>,
): string | null {
	if (retry.terminal.length === 0 || retry.pending.length > 0) return null;
	return retry.terminal.map((entry) => entry.reason).join('; ');
}

/**
 * Flip unpublish_pending → unpublished in place, AND upgrade the element to
 * the D16 shape in the same statement: drop whatever legacy `section_id`
 * token the row carried (string '3' or the int 3 a canonicalization sweep
 * left) and stamp the action under its own key. Shape-agnostic, so it is
 * correct for old and new rows alike.
 */
async function flipPendingRowUnpublished(rowId: number): Promise<void> {
	await sql.unsafe(
		`UPDATE "${activityTable()}"
		 SET relation = jsonb_set(
		         relation,
		         '{${DIFFUSION_ACTION_COMPONENT},0}',
		         ((relation->'${DIFFUSION_ACTION_COMPONENT}'->0) - 'section_id')
		             || jsonb_build_object('${DIFFUSION_ACTION_KEY}', $2::int)
		     )
		 WHERE section_tipo = 'dd1758' AND section_id = $1`,
		[rowId, DIFFUSION_ACTION.unpublished],
	);
}

/** attempts + 1, last_attempt = now (+ the terminal reason when given). */
async function stampPendingRow(rowId: number, terminal: string | null): Promise<void> {
	const { encodeForJsonb } = await import('../db/json_codec.ts');
	await sql.unsafe(
		`UPDATE "${activityTable()}"
		 SET misc = jsonb_set(
		         COALESCE(misc, '{}'::jsonb),
		         '{${RETRY_STAMP_KEY}}',
		         jsonb_build_object(
		             'attempts', COALESCE((misc->'${RETRY_STAMP_KEY}'->>'attempts')::int, 0) + 1,
		             'last_attempt', $2::text
		         ) || $3::text::jsonb
		     )
		 WHERE section_tipo = 'dd1758' AND section_id = $1`,
		[rowId, new Date().toISOString(), encodeForJsonb(terminal === null ? {} : { terminal })],
	);
}

/**
 * DURABLE INTENT, half one (LIFE-07): called INSIDE the record delete's
 * transaction, after the matrix row is gone. Writes one unpublish_pending row
 * per publication element of the section — the debt the delete owes the
 * public tier — so a commit can never outrun its ledger: whatever fails after
 * it (the executor, the process, the MariaDB link), the rows are there for the
 * retry queue and the reconcile. When target resolution itself throws, ONE
 * record-level row (no dd1766 element) is written instead; the settle and the
 * retry run such a row unrestricted. No targets → no rows (fresh-install
 * posture). `resolveTargets` is the seam the gate uses to make resolution
 * throw; production passes nothing.
 */
export interface UnpublishIntent {
	sectionTipo: string;
	sectionId: number;
	/** dd1758 row ids written, with the element each represents (null = record-level). */
	rows: { rowId: number; elementTipo: string | null }[];
}

export async function ledgerUnpublishIntent(
	sectionTipo: string,
	sectionId: number,
	userId?: number,
	resolveTargets: (
		sectionTipo: string,
	) => Promise<readonly DiffusionSqlTarget[]> = getSectionDiffusionTargets,
): Promise<UnpublishIntent> {
	const intent: UnpublishIntent = { sectionTipo, sectionId, rows: [] };
	let elements: (string | null)[];
	try {
		const targets = await resolveTargets(sectionTipo);
		elements = [...new Set(targets.map((target) => target.element_tipo))];
	} catch (error) {
		console.error(
			`[diffusion] target resolution for ${sectionTipo}/${sectionId} threw inside the delete — writing a record-level pending row so the debt survives:`,
			error,
		);
		elements = [null];
	}
	for (const elementTipo of elements) {
		const rowId = await logDiffusionActivity({
			sectionTipo,
			sectionId,
			elementTipo,
			action: DIFFUSION_ACTION.unpublishPending,
			userId,
		});
		intent.rows.push({ rowId, elementTipo });
	}
	return intent;
}

/** The dd1766 locator halves of an element tipo (`zzd7` → `zzd0` / `7`); nulls for a record-level row. */
function elementLocatorParts(elementTipo: string | null | undefined): {
	element_section: string | null;
	element_id: string | null;
} {
	const match = elementTipo?.match(/^([a-z]+)([0-9]+)$/) ?? null;
	if (match === null) return { element_section: null, element_id: null };
	return { element_section: `${match[1]}0`, element_id: match[2] as string };
}

/**
 * DURABLE INTENT, half two: post-commit, run the unpublish for each intent row
 * and settle it by the retry rule (flip / stamp terminal / stamp attempt).
 * Never throws — a row it could not settle stays pending for the queue.
 */
export async function settleUnpublishIntent(
	intent: UnpublishIntent,
): Promise<{ settled: number; pending: number }> {
	const summary = { settled: 0, pending: 0 };
	for (const row of intent.rows) {
		try {
			const settled = await settlePendingRow({
				section_id: row.rowId,
				target_section: intent.sectionTipo,
				target_id: String(intent.sectionId),
				...elementLocatorParts(row.elementTipo),
			});
			if (settled) summary.settled++;
			else summary.pending++;
		} catch (error) {
			summary.pending++;
			console.error(
				`[diffusion] settling intent row ${row.rowId} of ${intent.sectionTipo}/${intent.sectionId} failed (the row stays pending):`,
				error,
			);
		}
	}
	return summary;
}

/**
 * Rebuild an element tipo from a dd1766 locator — the inverse of the
 * ontology-node-as-record encoding logDiffusionActivity writes
 * ({tld}0 / numeric part → 'zzd0' + '7' = 'zzd7'). Null when the row carries
 * no element locator (a record-level pending row): the retry then runs
 * unrestricted, exactly as before.
 */
export function pendingRowElementTipo(
	elementSection: string | null,
	elementId: string | null,
): string | null {
	if (elementSection === null || elementId === null) return null;
	const match = elementSection.match(/^([a-z]+)0$/);
	if (match === null) return null;
	return `${match[1]}${elementId}`;
}

/**
 * What a file element's per-record path resolves to. `terminal` = no retry
 * can ever produce a path (PUB-02); `unavailable` = transient (no root
 * configured here and now) — pending, retried.
 */
export type PublishedFileResolution =
	| {
			kind: 'file';
			path: string;
			/** The target the file belongs to: its lock key is `files:<type>/<dirLabel>`. */
			dirLabel: string;
	  }
	| { kind: 'terminal'; reason: string }
	| { kind: 'unavailable'; reason: string };

/**
 * Resolve one file element's published path THROUGH THE PRODUCER publish
 * uses (published_files.ts; PHP diffusion_rdf/xml/markdown
 * get_record_file_path). The root is `mediaRoot` when a caller passes one
 * (gates), else diffusionFilesRoot() — the same call the writers make.
 */
export async function resolvePublishedFile(
	elementTipo: string,
	type: string,
	sectionTipo: string,
	sectionId: number,
	mediaRoot?: string,
): Promise<PublishedFileResolution> {
	if (!PER_RECORD_FILE_FORMATS.has(type)) {
		return {
			kind: 'terminal',
			reason: `'${type}' publishes no per-record file — a record leaves it only when the element is re-published`,
		};
	}
	let root: string;
	try {
		root =
			mediaRoot !== undefined && mediaRoot !== ''
				? assertTestMediaRoot(mediaRoot, 'resolvePublishedFile')
				: diffusionFilesRoot();
	} catch (error) {
		// The text goes to the log; the reason on the outcome is a sentence.
		console.error('[diffusion] published-files root unavailable:', error);
		return { kind: 'unavailable', reason: 'published-files root unavailable (see log)' };
	}
	const propsRows = (await sql.unsafe(
		`SELECT properties->'diffusion'->>'service_name' AS service FROM dd_ontology WHERE tipo = $1`,
		[elementTipo],
	)) as { service: string | null }[];
	const service = propsRows[0]?.service ?? null;
	if (service === null || service === '') {
		// The compiler refuses such an element (compile.ts service_name check):
		// it never published a file, so there is nothing a retry could remove.
		return {
			kind: 'terminal',
			reason: `element '${elementTipo}' has no service_name — never published`,
		};
	}

	let rdfName: string | null = null;
	if (type === 'rdf') {
		// rdf: the owl:Class child whose related section matches names the file.
		// The class is a name node: its file name is its MACHINE NAME, read by
		// the same nameOrLabelOf as the publish side (virtual_tree), so the two
		// sides can never name a different rdf file.
		const owlRows = (await sql.unsafe(
			`SELECT term, machine_name, use_machine_name, relations FROM dd_ontology WHERE parent = $1 AND model = 'owl:Class'`,
			[elementTipo],
		)) as {
			term: Record<string, string> | null;
			machine_name: string | null;
			use_machine_name: boolean | null;
			relations: { tipo?: string }[] | null;
		}[];
		for (const row of owlRows) {
			const related = (row.relations ?? []).map((link) => link.tipo);
			if (related.includes(sectionTipo)) {
				rdfName = nameOrLabelOf(row);
				break;
			}
		}
		if (rdfName === null) {
			return {
				kind: 'terminal',
				reason: `rdf element '${elementTipo}' has no owl:Class for section '${sectionTipo}' — never published`,
			};
		}
	}
	const path = publishedRecordFilePath({
		root,
		type,
		dirLabel: service,
		sectionTipo,
		sectionId,
		rdfName,
	});
	if (path === null) {
		return { kind: 'terminal', reason: `'${type}' publishes no per-record file` };
	}
	return { kind: 'file', path, dirLabel: service };
}

/**
 * The path form of resolvePublishedFile: the per-record path, or null when
 * there is none (terminal or unavailable — callers that need the distinction
 * use resolvePublishedFile).
 */
export async function resolvePublishedFilePath(
	elementTipo: string,
	type: string,
	sectionTipo: string,
	sectionId: number,
	mediaRoot?: string,
): Promise<string | null> {
	const resolved = await resolvePublishedFile(elementTipo, type, sectionTipo, sectionId, mediaRoot);
	return resolved.kind === 'file' ? resolved.path : null;
}

/** How one file element's unpublish ended. */
export type UnlinkOutcome =
	| { kind: 'unpublished' }
	| { kind: 'pending'; reason: string }
	| { kind: 'terminal'; reason: string };

/**
 * Unlink a file element's published copy (+ rdf legacy '{base}_*.rdf'
 * variants). 'unpublished' on success INCLUDING the nothing-published
 * idempotent case; 'pending' when the root is unavailable, an unlink fails, or
 * an EXCLUSIVE writer holds the target; 'terminal' when no path can ever exist
 * for this element.
 *
 * A DELETE-ONLY DOOR of the publication target (target_lock.ts
 * withDeleteDoorLock, key `files:<type>/<service>`, SHARED — the same lock a
 * run's batch and close hold exclusively, WC-2026-09-30-diffusion-target-fence
 * R2): a run's batch revalidates its records UNDER that lock, so a record
 * deleted from the archive is either seen gone by the batch or unlinked after
 * it — never written back over the unlink; and a close never archives a
 * directory this door is changing. On the request path a held target is not
 * waited for (the row stays pending for the retry queue); inside a patient
 * drain it is, on the drain's one budget.
 *
 * DURABLE (core/files/durable.ts): the directory is fsynced after the unlinks
 * — the dd1758 row flips to 'unpublished' on this answer, and an unlink a
 * power cut takes back would put an unpublished record back on the public tier.
 */
export async function unlinkPublishedFiles(
	elementTipo: string,
	type: string,
	sectionTipo: string,
	sectionId: number,
	mediaRoot?: string,
): Promise<UnlinkOutcome> {
	try {
		const resolved = await resolvePublishedFile(
			elementTipo,
			type,
			sectionTipo,
			sectionId,
			mediaRoot,
		);
		if (resolved.kind === 'terminal') return resolved;
		if (resolved.kind === 'unavailable') return { kind: 'pending', reason: resolved.reason };
		const held = await withDeleteDoorLock(fileTargetLockKey(type, resolved.dirLabel), async () =>
			unlinkRecordFiles(resolved.path, type),
		);
		if (!held.acquired) {
			return {
				kind: 'pending',
				reason:
					'publication target busy (another writer holds it) — the unpublish stays pending for the retry queue',
			};
		}
		return { kind: 'unpublished' }; // nothing to unlink = already removed (idempotent)
	} catch (error) {
		console.error('published-file unlink failed:', error);
		return { kind: 'pending', reason: 'published-file unlink failed (see log)' };
	}
}

/** Unlink one record's file (+ the rdf legacy variants), then fsync the directory. */
function unlinkRecordFiles(filePath: string, type: string): void {
	const slash = filePath.lastIndexOf('/');
	const dir = filePath.slice(0, slash);
	const toUnlink: string[] = [];
	if (existsSync(filePath)) toUnlink.push(filePath);
	if (type === 'rdf' && existsSync(dir)) {
		const base = filePath.slice(slash + 1).replace(/\.rdf$/, '');
		for (const name of readdirSync(dir)) {
			if (name.startsWith(`${base}_`) && name.endsWith('.rdf')) toUnlink.push(`${dir}/${name}`);
		}
	}
	for (const path of toUnlink) unlinkSync(path);
	if (toUnlink.length > 0) fsyncDirectory(dir);
}

/**
 * What a completed rebuild REPORTS. Not a wire body: `msg` and `markers` are
 * top-level extension keys the media_control panel reads by name
 * (render_media_control.js :543-545), and the caller is the one that puts them
 * on an `ok(...)` envelope. A rebuild that did NOT complete THROWS.
 */
export interface RebuildMediaIndexReport {
	/** Operator sentence the panel prints. */
	msg: string;
	/** Non-fatal per-target findings the store reported. */
	errors: string[];
	markers: number;
	targets: number;
}

/**
 * PHP dd_diffusion_api::rebuild_media_index — resolve EVERY sql/socrata
 * publication target of the diffusion map and regenerate the
 * .publication/pub marker store from them through the NATIVE store (S2-31; a
 * full resync; idempotent — markers derive from the published rows). The
 * global-admin gate lives in the dispatch caller (PHP checks it in the API
 * method; TS keeps permission checks at the dispatch boundary).
 *
 * FAILURE IS A THROW (envelope v2): `media.operation_failed` carries the
 * operator sentence as its public message, and the original exception rides as
 * `cause` — a raw exception string never reaches a wire field again.
 */
export async function rebuildMediaIndex(): Promise<RebuildMediaIndexReport> {
	const { getAllMediaIndexTargets } = await import('./diffusion_map.ts');
	let targets: { database_name: string; table_name: string; section_tipo: string }[];
	try {
		targets = await getAllMediaIndexTargets();
	} catch (error) {
		throw new DedaloError('media.operation_failed', {
			cause: error,
			coordinates: { operation: 'rebuild_media_index.resolve_targets' },
		});
	}

	if (nativeMediaIndexOps === null) {
		// DEC-19: sql targets exist but the native marker store is not
		// registered — the published surface can rot silently. Loud, and a
		// refusal: an "empty engine response" reported as success is how the
		// marker store rots unnoticed.
		if (targets.length > 0) {
			console.error(
				`[media_index] DEC-19: ${targets.length} sql publication target(s) exist but no native media-index is registered — the .publication/ marker store is NOT being maintained. Fix the boot registration (src/server.ts).`,
			);
		}
		throw new DedaloError('media.operation_failed', {
			publicMessage: 'Error. Empty engine response',
			coordinates: { operation: 'rebuild_media_index', targets: targets.length },
		});
	}

	let native: Awaited<ReturnType<NativeMediaIndexOps['rebuild']>>;
	try {
		native = await nativeMediaIndexOps.rebuild(targets);
	} catch (error) {
		throw new DedaloError('media.operation_failed', {
			cause: error,
			coordinates: { operation: 'rebuild_media_index', targets: targets.length },
		});
	}
	const errors = native.errors ?? [];
	if (native.ok !== true) {
		// The store's own sentence is engine-authored (never caller data), so it
		// is the one worth showing the operator; the per-target findings go to
		// the log, which is the only place that keeps them all.
		if (errors.length > 0) {
			console.error('[media_index] rebuild reported errors:', errors);
		}
		throw new DedaloError('media.operation_failed', {
			publicMessage: native.message,
			coordinates: { operation: 'rebuild_media_index', targets: targets.length },
		});
	}
	return { msg: native.message, errors, markers: native.markers, targets: targets.length };
}
