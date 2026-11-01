/**
 * THE EXTERNAL-MIRROR REFRESH DOOR — the portal's "update external data"
 * button (component_portal buttons.js) asks the read to recompute the requested
 * component's external mirror BEFORE it is served
 * (`source.build_options.get_data_external === true`).
 *
 * PHP: component_portal_json.php :97 — `build_options->get_data_external`
 * AND `properties->source->mode === 'external'` → `set_data_external({save:
 * true})`, then the ordinary read. PHP gated it by READ permission only; so
 * does this door (owner ruling 2026-10-30): an external mirror is DERIVED
 * state — a pure function of committed data, independent of who asks — so
 * recomputing it reveals nothing the reader could not read and writes nothing
 * a writer could have chosen differently. A no-drift refresh writes nothing.
 *
 * ── PRECONDITIONS (all of them; any miss = a silent no-op, the read as usual)
 *
 *   1. the flag is `=== true` (the v6 `get_dato_external` is COUNTED as
 *      `rqo_deprecated_get_dato_external` and ignored);
 *   2. the request is `dd_core_api:read` — the only handler that reaches
 *      routeSectionRead, so `dd_core_api:start` (CSRF-exempt) never can; the
 *      check here is the second wall;
 *   3. NOT a Time Machine read — neither `sqo.mode === 'tm'` nor inside the
 *      TM read scope (withTimeMachineReadScope): a TM view must never recompute
 *      the LIVE row;
 *   4. not a temporal instance (its sentinel id addresses no record);
 *   5. the source names a COMPONENT (tipo ≠ section_tipo) and its id
 *      classifies as a RECORD (classifyWireSectionId — synthetic search ids and
 *      external refs address no matrix row);
 *   6. the component's ontology says `properties.source.mode === 'external'`.
 *
 * The caller (read_facade.ts routeSectionRead) calls this ONLY in the
 * top-level component get_data branch, after the record gate and the level ≥ 1
 * pair check and before readComponentData — never for a subdatum, a section
 * read or a search. Requested element only: the hop the recompute owes is the
 * cascade's, not this door's.
 *
 * ── PAST THE PRECONDITIONS, every outcome is SERVED, with a notice when the
 *    refresh did not run (envelope v2 notices; ERRORS_SPEC §3):
 *
 *   observers.refresh_refused   the read-level authorizeRecordAccess refused
 *                               (door `dd_core_api.read.refresh_external`), or
 *                               the section is consultation-only;
 *   observers.refresh_withheld  {reason}: law_refused | target_not_host |
 *                               degraded_seed | frozen | busy | error.
 *
 * A refresh that WROTE is done, whatever else it reports: a degraded seed
 * that withheld the drops but persisted additions (`wrote` + `skippedShrink`)
 * refreshed the mirror as far as the law allows — counted done, no notice.
 * Only a degraded seed that wrote NOTHING is withheld `degraded_seed`.
 *
 * ── THE LOCK-WAIT BOUND (review 2026-10-30): the recompute takes the target
 * row's FOR UPDATE on the request pool, and this door is READ-level — so its
 * transaction is born with `SET LOCAL lock_timeout =
 * EXTERNAL_REFRESH_LOCK_TIMEOUT`. A row another transaction holds (an import,
 * a bulk revert, a cascade) makes the refresh give up after that bound,
 * writing nothing: withheld `busy`, the ONE retryable reason
 * (`observers_external_refresh_busy`). A read never parks a pool connection
 * behind a long write.
 *
 * READ AFTER WRITE: the refresh is AWAITED — refreshExternalMirror commits its
 * own transaction before returning — and the component get_data branch opens
 * no record memo, so the read that follows sees the committed row.
 *
 * AUDIT: the requester is the Time Machine actor (grant.userId — the actor the
 * read grant was minted for), as an observer cascade records the saving user.
 * No origin tag (owner ruling 2026-10-30): the mirror is a calculation; the real
 * change lives in the source components' own TM rows.
 *
 * Errors: this door never fails the read. An unexpected failure is logged,
 * counted (`observers_external_refresh_failed`) and becomes the withheld
 * notice. Nothing runs inside a transaction here (the read handler opens
 * none), so absorbing it rolls nothing back that should have propagated.
 *
 * `observers.ts` is reached by DYNAMIC import only (import_scc_tripwire: the
 * section/record write graph must not close a cycle through the read facade).
 * No module-level state.
 */

import { incrementCounter } from '../../api/counters.ts';
import type { Rqo } from '../../concepts/rqo.ts';
import { isTemporalSource } from '../../concepts/rqo.ts';
import { isConsultationOnlySection } from '../../concepts/section.ts';
import { classifyWireSectionId } from '../../concepts/section_id.ts';
import { isInTransaction, sqlStateOf } from '../../db/postgres.ts';
import { type ApiNotice, isDedaloError, isErrorInDomain, specOf } from '../../errors/index.ts';
import { getNode } from '../../ontology/resolver.ts';
import type { Principal } from '../../security/permissions.ts';
import { authorizeRecordAccess, type RecordGrant } from '../../security/write_door.ts';
import { isTimeMachineRead } from '../list_definitions/tm_scope_context.ts';
import { getExternalLaw, isStoredExternalLaw, reportRefusedLaw } from './external_laws/classify.ts';
import { isObserverHostSection } from './external_laws/resolvers.ts';

/** The door name the read-level authorization is asked (and logged) under. */
export const EXTERNAL_REFRESH_DOOR = 'dd_core_api.read.refresh_external';

/**
 * The refresh recompute's lock-wait bound (header: THE LOCK-WAIT BOUND). A
 * named constant, not a config key: it bounds a derived-state refresh a user
 * may simply retry, so no installation has a reason to lengthen it.
 */
export const EXTERNAL_REFRESH_LOCK_TIMEOUT = '3s';

/** SQLSTATE lock_not_available — the bound above ran out. */
const LOCK_NOT_AVAILABLE = '55P03';

/** Why a permitted refresh wrote nothing — the `reason` detail of observers.refresh_withheld. */
export type ExternalRefreshWithheldReason =
	| 'law_refused'
	| 'target_not_host'
	| 'degraded_seed'
	| 'frozen'
	| 'busy'
	| 'error';

/** The withheld reasons a plain retry can clear (the notice's `retryable`). */
const RETRYABLE_WITHHELD: ReadonlySet<ExternalRefreshWithheldReason> = new Set(['busy']);

/** The refresh target once every precondition held. */
export interface ExternalRefreshTarget {
	readonly sectionTipo: string;
	readonly componentTipo: string;
	readonly sectionId: number;
}

/** The `build_options` bag of a source, or undefined when it is not an object. */
function buildOptionsOf(source: Rqo['source']): Record<string, unknown> | undefined {
	const bag = (source as { build_options?: unknown } | undefined)?.build_options;
	return bag !== null && typeof bag === 'object' && !Array.isArray(bag)
		? (bag as Record<string, unknown>)
		: undefined;
}

/**
 * Whether the RQO asks for the refresh at all — `get_data_external === true`,
 * strictly. Counts (and ignores) the v6 spelling.
 */
export function externalRefreshRequested(source: Rqo['source']): boolean {
	const bag = buildOptionsOf(source);
	if (bag === undefined) return false;
	if ('get_dato_external' in bag) incrementCounter('rqo_deprecated_get_dato_external');
	return bag.get_data_external === true;
}

/** A Time Machine read, by the SQO or by the scope already open around the request. */
function isTimeMachineRequest(rqo: Rqo): boolean {
	const mode = (rqo.sqo as { mode?: unknown } | undefined)?.mode;
	return mode === 'tm' || isTimeMachineRead();
}

/** Whether the component's ontology declares an EXTERNAL source (PHP `properties->source->mode`). */
async function isExternalSourceComponent(componentTipo: string): Promise<boolean> {
	const node = await getNode(componentTipo);
	const source = (node?.properties as { source?: unknown } | null | undefined)?.source;
	return (
		source !== null &&
		typeof source === 'object' &&
		(source as { mode?: unknown }).mode === 'external'
	);
}

/** Precondition 2: a dd_core_api record read, never a Time Machine read. */
function servesRequest(rqo: Rqo): boolean {
	if (rqo.action !== 'read') return false;
	if ((rqo.dd_api ?? 'dd_core_api') !== 'dd_core_api') return false;
	if (isTimeMachineRequest(rqo)) {
		incrementCounter('observers_external_refresh_skipped_tm');
		return false;
	}
	return true;
}

/** Preconditions 3-4: a non-temporal source naming a COMPONENT of a section. */
function componentAddressOf(
	source: Rqo['source'],
): { sectionTipo: string; componentTipo: string; rawSectionId: unknown } | null {
	if (source === undefined || isTemporalSource(source)) return null;
	const { section_tipo: sectionTipo, tipo: componentTipo } = source;
	if (typeof sectionTipo !== 'string' || typeof componentTipo !== 'string') return null;
	if (componentTipo === sectionTipo) return null;
	return { sectionTipo, componentTipo, rawSectionId: source.section_id };
}

/** Precondition 5: the wire id addresses ONE record (a malformed id is no refresh, not an error). */
async function recordIdOf(rawSectionId: unknown, sectionTipo: string): Promise<number | null> {
	const wireId = await classifyWireSectionId(
		rawSectionId,
		sectionTipo,
		'rqo.get_data.external_refresh',
	).catch((error: unknown) => {
		if (isErrorInDomain(error, 'section_id')) return { kind: 'absent' } as const;
		throw error;
	});
	return wireId.kind === 'record' ? wireId.id : null;
}

/**
 * Preconditions 2-6 (see the header). `null` = not a refresh request this
 * door serves: the read proceeds as usual, with no notice.
 */
export async function externalRefreshTarget(rqo: Rqo): Promise<ExternalRefreshTarget | null> {
	if (!servesRequest(rqo)) return null;
	const address = componentAddressOf(rqo.source);
	if (address === null) return null;
	const sectionId = await recordIdOf(address.rawSectionId, address.sectionTipo);
	if (sectionId === null) return null;
	if (!(await isExternalSourceComponent(address.componentTipo))) return null;
	return { sectionTipo: address.sectionTipo, componentTipo: address.componentTipo, sectionId };
}

function refusedNotice(): ApiNotice {
	return {
		code: 'observers.refresh_refused',
		label_key: specOf('observers.refresh_refused').label_key,
		retryable: false,
	};
}

function withheldNotice(reason: ExternalRefreshWithheldReason): ApiNotice {
	return {
		code: 'observers.refresh_withheld',
		label_key: specOf('observers.refresh_withheld').label_key,
		retryable: RETRYABLE_WITHHELD.has(reason),
		details: { reason },
	};
}

/**
 * The read-level grant on (section, component, record), or null when refused
 * (a consultation-only section is refused before the door is asked). A
 * non-DedaloError is not a refusal: it propagates to the caller's catch.
 */
async function authorizeRefresh(
	principal: Principal,
	target: ExternalRefreshTarget,
): Promise<RecordGrant | null> {
	const where = `${target.sectionTipo}/${String(target.sectionId)} ${target.componentTipo}`;
	if (isConsultationOnlySection(target.sectionTipo)) {
		console.warn(`[external_refresh] ${where}: consultation-only section — refresh refused`);
		incrementCounter('observers_external_refresh_refused');
		return null;
	}
	try {
		return await authorizeRecordAccess(
			principal,
			{
				section_tipo: target.sectionTipo,
				component_tipo: target.componentTipo,
				section_id: target.sectionId,
			},
			{ mode: 'read', level: 1, sectionFloor: 1, door: EXTERNAL_REFRESH_DOOR },
		);
	} catch (error) {
		if (!isDedaloError(error)) throw error;
		console.warn(`[external_refresh] ${where}: refresh refused (${error.code})`);
		incrementCounter('observers_external_refresh_refused');
		return null;
	}
}

/**
 * Why a finished refresh wrote nothing although it was permitted — read off the
 * recompute's outcome (observers.ts ExternalRecomputeOutcome, which
 * refreshExternalMirror returns: `refusedLaw`, `targetNotHost`,
 * `refusedBigResult`, `skippedShrink`). Read structurally: the type lives in
 * the write graph, reached here by dynamic import only. `null` = it wrote, or
 * found no drift (both are success).
 *
 * `wrote === true` is SUCCESS before any flag: a degraded seed withholds only
 * the drop half, so `skippedShrink` beside `wrote` means the additions landed
 * — the refresh ran, and saying "could not be refreshed" over the freshly
 * written value would misreport it (and miscount the operator counter).
 */
export function withheldReasonOf(outcome: unknown): ExternalRefreshWithheldReason | null {
	if (outcome === null || typeof outcome !== 'object') return null;
	const fields = outcome as Record<string, unknown>;
	if (fields.refusedLaw !== undefined) return 'law_refused';
	if (fields.wrote === true) return null;
	return flaggedWithheldReason(fields);
}

/**
 * The first FLAGGED_WITHHELD flag set on an outcome that did not write, in
 * precedence order; `null` = none set (the refresh found no drift).
 */
function flaggedWithheldReason(
	fields: Record<string, unknown>,
): ExternalRefreshWithheldReason | null {
	for (const [field, reason] of FLAGGED_WITHHELD) if (fields[field] === true) return reason;
	return null;
}

/**
 * The bounded lock wait ran out (SQLSTATE 55P03 anywhere on the cause chain —
 * the raw driver error, or a typed wrapper keeping it as `cause`).
 */
export function isRefreshLockBusy(error: unknown): boolean {
	return sqlStateOf(error) === LOCK_NOT_AVAILABLE;
}

/** The outcome flags that mean "withheld", in precedence order (after `refusedLaw`). */
const FLAGGED_WITHHELD: readonly (readonly [string, ExternalRefreshWithheldReason])[] =
	Object.freeze([
		['targetNotHost', 'target_not_host'],
		['refusedBigResult', 'frozen'],
		['skippedShrink', 'degraded_seed'],
	] as const);

/** The permitted refresh itself (law + host checked here; the recompute is observers.ts's). */
async function runRefresh(
	target: ExternalRefreshTarget,
	grant: RecordGrant,
): Promise<ExternalRefreshWithheldReason | null> {
	const where = `${target.sectionTipo}/${String(target.sectionId)}`;
	const law = await getExternalLaw(target.componentTipo);
	if (!isStoredExternalLaw(law)) {
		reportRefusedLaw(law, `${where} (external refresh)`);
		return 'law_refused';
	}
	if (!(await isObserverHostSection(target.componentTipo, target.sectionTipo))) {
		incrementCounter('observers_target_not_host');
		return 'target_not_host';
	}
	const { refreshExternalMirror } = await import('./observers.ts');
	let outcome: unknown;
	try {
		outcome = await refreshExternalMirror(
			target.componentTipo,
			target.sectionTipo,
			target.sectionId,
			grant.userId,
			new Date(),
			{ lockTimeout: EXTERNAL_REFRESH_LOCK_TIMEOUT },
		);
	} catch (error) {
		// The bound ran out: the recompute's transaction rolled back, nothing
		// was written. Not a failure — the row is busy; anything else is one.
		if (!isRefreshLockBusy(error)) throw error;
		console.warn(
			`[external_refresh] ${where} ${target.componentTipo}: target row locked past ${EXTERNAL_REFRESH_LOCK_TIMEOUT} — refresh withheld (busy)`,
		);
		incrementCounter('observers_external_refresh_busy');
		return 'busy';
	}
	return withheldReasonOf(outcome);
}

/** The notices a permitted refresh owes: none when it ran, one withheld notice when it did not. */
function noticesOf(reason: ExternalRefreshWithheldReason | null): readonly ApiNotice[] {
	if (reason === null) {
		incrementCounter('observers_external_refresh_done');
		return [];
	}
	incrementCounter('observers_external_refresh_withheld');
	return [withheldNotice(reason)];
}

/**
 * THE HOOK (read_facade.ts, the component get_data branch): refresh the
 * requested external mirror when asked, AWAITED to commit, and say so when it
 * did not run. Returns the notices the read owes (empty = nothing to say).
 * Never throws for a refresh failure — the read is always served.
 */
export async function maybeRefreshExternal(
	rqo: Rqo,
	principal: Principal,
): Promise<readonly ApiNotice[]> {
	if (!externalRefreshRequested(rqo.source)) return [];
	let where = `${String(rqo.source?.section_tipo)}/${String(rqo.source?.section_id)} ${String(rqo.source?.tipo)}`;
	try {
		const target = await externalRefreshTarget(rqo);
		if (target === null) return [];
		where = `${target.sectionTipo}/${String(target.sectionId)} ${target.componentTipo}`;
		// The recompute owns its transaction and must COMMIT before the read:
		// a caller that already holds one would read its own uncommitted state
		// and hold the target lock across the read. The read door opens none.
		if (isInTransaction()) {
			console.error(`[external_refresh] ${where}: called inside a transaction — refresh skipped`);
			incrementCounter('observers_external_refresh_failed');
			return [withheldNotice('error')];
		}
		const grant = await authorizeRefresh(principal, target);
		if (grant === null) return [refusedNotice()];
		return noticesOf(await runRefresh(target, grant));
	} catch (error) {
		console.error(`[external_refresh] ${where}: refresh failed — the stored data is served`, error);
		incrementCounter('observers_external_refresh_failed');
		return [withheldNotice('error')];
	}
}
