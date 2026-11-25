/**
 * PUBLIC-URL PROBE — PUBLICATION_HOST_SPEC §7, phase 6 (plan Decisions P1-P3).
 *
 * A rule hash proves the rules are INSTALLED; this proves they GATE. Through the
 * URL the public uses, the operator's published probe file must answer 2xx and the
 * unpublished one 404.
 *
 * THE PUBLIC URL IS AN ORIGIN. `public_url` must parse as a bare http(s) origin: no
 * path, query, fragment or credentials. The probe URL is built from `url.origin`, so
 * a stray path or query can never move the probe off the media URL, and userinfo
 * never reaches the outbound door. Anything else is `unknown`, and nothing is sent.
 * Checked here on every probe, whatever the registry accepted.
 *
 * P1 — VALIDATED, NOT TRUSTED. The operator picks the two files (registry `probe`,
 * no scratch records in a production DB). Before any request each must be a plain
 * relative path under a public quality (`filterPublicQualities`: never a master),
 * match `MEDIA_FILENAME_GRAMMAR`, not be a working file, exist as a regular file in
 * the work media tree (a 404 caused by absence proves nothing), and carry — or not
 * carry — the `pub/<key>` marker it claims. A failed validation is `unknown` with
 * the reason, never a pass, and no request leaves.
 *
 * P2 — THE PUBLIC DOOR. `fetchGuardedText` (vetted, pinned, redirects refused),
 * `Range: bytes=0-0`, a 1 KiB cap. A body is read only for a 2xx (the door cancels
 * any other unread), so a `body_cap` — a server ignoring Range — IS a 2xx. A
 * non-public address is `unknown`, never a pass; the SSRF guard is not bent.
 * No cache-busting header, on purpose: a CDN still serving an unpublished file is
 * exactly the exposure this probe exists to see.
 *
 * THE ONE REDIRECT FOLLOWED — AN UPGRADE (§7; the door pattern: OUTBOUND_SPEC §2). Public sites commonly answer :80 with a
 * redirect to :443, so a public URL entered as `http://museum.org` would otherwise probe
 * red forever. The door still refuses every redirect; the probe reads where the refused
 * one pointed (`refusedRedirectLocation` — the guard keeps the peer's raw Location OFF its
 * log-printed coordinates) and follows it ONCE, and only when it is
 * exactly the https twin of the URL it asked for: same host, scheme http → https, the
 * https default port (from 80 or any explicit port), same path and query, no credentials,
 * no fragment (`httpsUpgradeOf`). The URL followed is BUILT FROM THE PROBE'S OWN URL —
 * the peer's Location only answers yes or no, it never supplies a byte of the target —
 * and goes back through the SAME guarded door, so it is re-vetted and pinned like the
 * first. A redirect on that second request is refused (never a second hop); so is any
 * other redirect, as an answer whose status is the 3xx (`failed`, as before), with a
 * detail that says where it pointed. A followed upgrade adds a note to the verdict's
 * detail — even an `ok` one — telling the operator to store the https URL. Each side
 * may take two requests, so its time bound is twice the per-request deadline.
 *
 * COPY HOSTS — A 404 MUST BE THE GATE'S, NOT ABSENCE'S. On a `copy`-mode host the
 * unpublished file is, by construction, never copied (the desired set holds published
 * keys only, the agent refuses an unmarked put), so its public URL answers 404 whether
 * Rule B is installed or not. After the two requests the probe asks the host's agent
 * (`copyHolding`): not a copy host (the agent's word, else a STAMPED `n/a` in the runtime
 * — the last proven answer) → the 404 stands; a copy host whose manifest LISTS the
 * unpublished file (a pending deletion: exactly the exposure §7 exists to see) → the 404
 * proves the gate; a copy host that does not hold it, or an agent that cannot be asked
 * → that 404 is `unknown` with the reason, never `ok`. Only a 404 is downgraded: a 2xx
 * is the gate OPEN whatever the agent holds. (A canary the agent holds unmarked, so a
 * copy host can prove its gate on every run, is not built: an unmarked file under a
 * public quality needs synthetic bytes and a planner exemption — never an unpublished
 * record's real bytes on the public machine.)
 *
 * VERDICT. A definite failure on either side (the unpublished file served → the
 * gate is OPEN) is `failed` even when the other side is `unknown`; otherwise any
 * unknown side is `unknown`; otherwise `ok`. A 2xx is recorded as 200.
 *
 * P3 — CALLERS: the `apply_rules` action (`probeAfterRulesApplied`); the end of a
 * copy-apply round that changed the host (`scheduleProbeAfterCopyBatch` — called by
 * the copy worker's `afterSync`, wired in server.ts, and by the media_copy reconcile
 * apply; never by `applyCopy` itself, so one sync schedules once); the `probe_public`
 * action (`probePublicGate`); and the scheduled `PUBLICATION_PROBE_RECONCILE`, whose
 * DRY run writes nothing (ReconcileRunOptions) and whose APPLY — the scheduled mode,
 * `autoApply` — records the observation. Every recorded verdict lands in
 * `runtime.probe`, an OBSERVATION; no mode of this module writes the gate, the media
 * or the registry.
 */

import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../config/config.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import {
	filterPublicQualities,
	getPublicQualities,
	MEDIA_FILENAME_GRAMMAR,
	MEDIA_WORKING_FILE_EXTENSIONS,
	markerStoreBase,
	mediaRoot,
} from '../media/protection.ts';
import type {
	ReconcileDefinition,
	ReconcileReport,
	ReconcileRunOptions,
	ReconcileScope,
} from '../reconcile/registry.ts';
import {
	fetchGuardedText,
	type GuardedFetchOptions,
	isAddressRefusal,
	isSsrfRefusal,
	type PinnedHopDeps,
	refusedRedirectLocation,
} from '../security/ssrf_guard.ts';
import { hostMediaManifest, hostStatus } from './agent_client.ts';
import { getHost, loadRegistry, type PublicationHostRecord } from './registry.ts';
import { type HostRuntime, loadRuntime, updateHostRuntime } from './runtime.ts';

export type GateProbe = HostRuntime['probe'];
export type ProbeCause = 'apply_rules' | 'copy_batch';

/**
 * What the host holds of the unpublished probe file (the COPY HOSTS clause above):
 * `not_copy` = not a copy-mode host; `held` / `not_held` = a copy host's manifest lists /
 * does not list it; `{unknown}` = the agent could not tell.
 */
export type CopyHolding = 'not_copy' | 'held' | 'not_held' | { readonly unknown: string };

/** Injectable seams (production supplies none): the guard's resolver/fetch, the deadline, the agent. */
export interface ProbeDeps extends PinnedHopDeps {
	readonly timeoutMs?: number;
	readonly copyHolding?: (record: PublicationHostRecord, path: string) => Promise<CopyHolding>;
}

/**
 * What the copy trigger reads of one copy-apply round. Structural on purpose: the
 * diffusion `CopyApplyReport` satisfies it, and core never imports a diffusion type.
 */
export interface CopyBatchCounts {
	readonly put: number;
	readonly deleted: number;
	readonly withdrawn: number;
	readonly published: number;
}

export const PUBLICATION_PROBE_EVERY_MS = 15 * 60_000;
/** A proof older than two periods is shown `warn` (the scheduler stopped, or every run failed). */
export const PROBE_MAX_AGE_MS = 2 * PUBLICATION_PROBE_EVERY_MS;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_BYTES = 1024;

export const BARE_ORIGIN_REFUSAL =
	'public URL must be a bare origin (http(s)://host[:port], no path, query, fragment or credentials)';

export const NEVER_PROBED: Readonly<GateProbe> = Object.freeze<GateProbe>({
	state: 'unknown',
	at: null,
	published_status: null,
	unpublished_status: null,
	detail: 'never probed',
});

// ---------------------------------------------------------------------------
// The public URL: a bare origin
// ---------------------------------------------------------------------------

function isBareOrigin(url: URL): boolean {
	return [
		url.protocol === 'https:' || url.protocol === 'http:',
		url.username === '' && url.password === '',
		url.pathname === '/' || url.pathname === '',
		url.search === '' && url.hash === '',
	].every(Boolean);
}

/** `url.origin` of a bare http(s) origin; null for anything else (never a guess). */
export function bareOrigin(publicUrl: string): string | null {
	try {
		const url = new URL(publicUrl);
		return isBareOrigin(url) ? url.origin : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// P1 — validation against ground truth
// ---------------------------------------------------------------------------

/** One path segment: no leading dot (so no `.`/`..`/`.publication`), web-safe characters only. */
const PROBE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
/** The rule-B grammar, anchored on the basename (its `[^/]*` prefix never crosses a slash). */
const PROBE_FILENAME = new RegExp(`^${MEDIA_FILENAME_GRAMMAR}`);
const WORKING_EXTENSIONS: ReadonlySet<string> = new Set(MEDIA_WORKING_FILE_EXTENSIONS);

interface ParsedProbePath {
	path: string;
	key: string;
}

type Validation = { ok: true } | { ok: false; reason: string };

function refused(reason: string): Validation {
	return { ok: false, reason };
}

function hostQualities(record: PublicationHostRecord): string[] {
	return filterPublicQualities(record.qualities ?? getPublicQualities());
}

function parseProbePath(path: string, qualities: readonly string[]): ParsedProbePath | string {
	if (!path.split('/').every((segment) => PROBE_SEGMENT.test(segment))) {
		return `'${path}' is not a plain relative media path`;
	}
	const inQuality = qualities.some((quality) => path.startsWith(`${quality}/`));
	if (!inQuality) return `'${path}' is not under a public quality (${qualities.join(', ')})`;
	return parseProbeFile(path);
}

function parseProbeFile(path: string): ParsedProbePath | string {
	const file = path.slice(path.lastIndexOf('/') + 1);
	const extension = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
	if (WORKING_EXTENSIONS.has(extension)) {
		return `'${path}' is a working file (.${extension}), never served`;
	}
	const match = PROBE_FILENAME.exec(file);
	if (match === null) return `'${path}' does not match the media filename grammar`;
	return { path, key: `${match[1]}_${match[2]}` };
}

async function isRegularFile(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isFile();
	} catch {
		return false;
	}
}

function markerMismatch(parsed: ParsedProbePath, wantPublished: boolean): string {
	return wantPublished
		? `'${parsed.path}' is not published (no pub/${parsed.key} marker): it cannot prove that published media is served`
		: `'${parsed.path}' is published (pub/${parsed.key} exists): it cannot prove that unpublished media is refused`;
}

async function checkGroundTruth(
	parsed: ParsedProbePath,
	wantPublished: boolean,
): Promise<string | null> {
	const root = mediaRoot();
	const base = markerStoreBase();
	if (root === null || base === null) return 'the media root is not configured';
	if (!(await isRegularFile(join(root, parsed.path)))) {
		return `'${parsed.path}' is not a file in the work media tree`;
	}
	const published = await isRegularFile(join(base, 'pub', parsed.key));
	return published === wantPublished ? null : markerMismatch(parsed, wantPublished);
}

async function checkProbePath(
	path: string,
	qualities: readonly string[],
	wantPublished: boolean,
): Promise<string | null> {
	const parsed = parseProbePath(path, qualities);
	return typeof parsed === 'string' ? parsed : checkGroundTruth(parsed, wantPublished);
}

/** P1. `{ok:true}` only when both paths mean exactly what they claim, today. */
export async function validateProbePaths(record: PublicationHostRecord): Promise<Validation> {
	const { published, unpublished } = record.probe;
	if (published === null || unpublished === null) return refused('probe paths are not set');
	if (published === unpublished) {
		return refused('the published and unpublished probe paths are the same file');
	}
	const qualities = hostQualities(record);
	const publishedProblem = await checkProbePath(published, qualities, true);
	if (publishedProblem !== null) return refused(publishedProblem);
	const unpublishedProblem = await checkProbePath(unpublished, qualities, false);
	return unpublishedProblem === null ? { ok: true } : refused(unpublishedProblem);
}

// ---------------------------------------------------------------------------
// P2 — through the public door
// ---------------------------------------------------------------------------

/**
 * What one side of the probe answered. `redirect` names a refused redirect (where it
 * pointed: the verdict's failure says so); `upgradedTo` is the https origin of a followed
 * http → https upgrade (the verdict's note).
 */
type Answer = (
	| { readonly status: number; readonly redirect?: string }
	| { readonly unknown: string }
) & { readonly upgradedTo?: string };

/** `origin` is `bareOrigin(...)`'s answer — never the raw registry string. */
function probeUrl(origin: string, path: string): string {
	return `${origin}/dedalo/${config.mediaDir}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function probeOptions(deps: ProbeDeps): GuardedFetchOptions {
	return {
		maxBytes: PROBE_MAX_BYTES,
		timeoutMs: deps.timeoutMs ?? PROBE_TIMEOUT_MS,
		init: { method: 'GET', headers: { Range: 'bytes=0-0' } },
	};
}

/**
 * An ADDRESS refusal (isAddressRefusal — the guard's one table; no reason is spelled
 * here): a private address, or a name that does not resolve to a public one. The
 * guard's reason code is named as a fact; its message (which names the address) is not.
 */
function addressDetail(error: unknown): string {
	const reason = String((error as DedaloError).coordinates?.reason ?? 'address');
	return `not a public host (${reason}): a private address, or a name that does not resolve to a public one`;
}

function answerOfOutbound(coordinates: Readonly<Record<string, string | number>>): Answer {
	// Only a 2xx body is read, so a body over the cap is a 2xx answer.
	if (coordinates.reason === 'body_cap') return { status: 200 };
	if (typeof coordinates.status === 'number') return { status: coordinates.status };
	return {
		unknown: `the public URL did not answer (${String(coordinates.reason ?? 'transport')})`,
	};
}

function answerOfFailure(error: unknown): Answer {
	if (isAddressRefusal(error)) return { unknown: addressDetail(error) };
	if (isSsrfRefusal(error)) return { unknown: 'the public URL is not a fetchable http(s) URL' };
	if (!(error instanceof DedaloError) || error.code !== 'security.outbound_failed') {
		console.error('[publication_host] probe request failed unexpectedly:', error);
		return { unknown: 'probe error (see the server log)' };
	}
	return answerOfOutbound(error.coordinates ?? {});
}

/** A redirect the door refused: its 3xx and the raw Location (`RedirectRefused`). */
interface RefusedRedirect {
	readonly status: number;
	readonly location: string;
}

/**
 * The refused redirect a door failure carries, or null for any other failure. The status
 * is the guard's `status` coordinate; the Location is read from the error's own field
 * (`refusedRedirectLocation`), never from the coordinates — those are log text.
 */
function refusedRedirectOf(error: unknown): RefusedRedirect | null {
	const location = refusedRedirectLocation(error);
	if (location === null) return null;
	const status = (error as DedaloError).coordinates?.status;
	return typeof status === 'number' ? { status, location } : null;
}

/** ONE request through the public door: its answer, or the redirect it refused. */
async function guardedHop(
	url: string,
	deps: ProbeDeps,
): Promise<{ answer: Answer } | { redirect: RefusedRedirect }> {
	try {
		await fetchGuardedText(url, probeOptions(deps), deps);
		return { answer: { status: 200 } };
	} catch (error) {
		const redirect = refusedRedirectOf(error);
		return redirect === null ? { answer: answerOfFailure(error) } : { redirect };
	}
}

/**
 * THE upgrade policy (header: THE ONE REDIRECT FOLLOWED). The https URL to follow when
 * `location` (resolved against `requested`) is EXACTLY the https twin of `requested` —
 * same host, http → https, the https default port, same path and query, no credentials,
 * no fragment; null for anything else. The returned URL is built from `requested`, never
 * from `location`: the peer's text decides yes or no and supplies nothing.
 */
export function httpsUpgradeOf(requested: string, location: string): string | null {
	const from = new URL(requested);
	if (from.protocol !== 'http:') return null;
	const twin = new URL(from.href);
	twin.protocol = 'https:';
	twin.port = '';
	try {
		// Compared as normalized hrefs: case, a default `:443`, percent-encoding of the path.
		return new URL(location, from).href === twin.href ? twin.href : null;
	} catch {
		return null;
	}
}

/** The longest redirect target a detail quotes (a peer's text, shown to the operator). */
const REDIRECT_TARGET_MAX = 200;

/** Where a refused redirect pointed, display-safe: resolved, credentials dropped, bounded. */
function redirectTarget(location: string, requested: string): string {
	let target: string;
	try {
		const url = new URL(location, requested);
		url.username = '';
		url.password = '';
		target = url.href;
	} catch {
		return 'an unparseable Location';
	}
	const flat = target.replace(/[\p{Cc}\p{Cf}\s]+/gu, '');
	return flat.length > REDIRECT_TARGET_MAX ? `${flat.slice(0, REDIRECT_TARGET_MAX - 1)}…` : flat;
}

/** A refused redirect as an answer: its 3xx (judged like any status) and where it pointed. */
function refusedRedirectAnswer(
	redirect: RefusedRedirect,
	requested: string,
	after: string,
): Answer {
	const where = redirectTarget(redirect.location, requested);
	return {
		status: redirect.status,
		redirect: `${after}redirected to ${where}, not followed (only one http → https upgrade of the same host, path and query is)`,
	};
}

/**
 * One side of the probe: the request, and — only for an http → https upgrade of that very
 * URL — ONE more request to its https twin through the same door. Never a third.
 */
async function publicAnswer(url: string, deps: ProbeDeps): Promise<Answer> {
	const first = await guardedHop(url, deps);
	if ('answer' in first) return first.answer;
	const upgrade = httpsUpgradeOf(url, first.redirect.location);
	if (upgrade === null) return refusedRedirectAnswer(first.redirect, url, '');
	const upgradedTo = new URL(upgrade).origin;
	const second = await guardedHop(upgrade, deps);
	if ('answer' in second) return { ...second.answer, upgradedTo };
	const again = 'after the http → https upgrade, a second redirect: ';
	return { ...refusedRedirectAnswer(second.redirect, upgrade, again), upgradedTo };
}

function statusOf(answer: Answer): number | null {
	return 'status' in answer ? answer.status : null;
}

function unknownOf(which: string, answer: Answer): string | null {
	return 'unknown' in answer ? `${which}: ${answer.unknown}` : null;
}

function unpublishedFailure(status: number): string {
	return status >= 200 && status <= 299
		? `the unpublished file is publicly served (HTTP ${status}): the gate is OPEN`
		: `the unpublished file answered HTTP ${status} (must be 404)`;
}

/** A failure sentence plus where a refused redirect pointed, when that is what answered. */
function withRedirect(failure: string, answer: Answer): string {
	return 'redirect' in answer && answer.redirect !== undefined
		? `${failure}: ${answer.redirect}`
		: failure;
}

function gateFailures(published: Answer, unpublished: Answer): string[] {
	const failures: string[] = [];
	const publishedStatus = statusOf(published);
	const unpublishedStatus = statusOf(unpublished);
	if (publishedStatus !== null && publishedStatus !== 200) {
		const failure = `the published file answered HTTP ${publishedStatus} (must be 2xx)`;
		failures.push(withRedirect(failure, published));
	}
	if (unpublishedStatus !== null && unpublishedStatus !== 404) {
		failures.push(withRedirect(unpublishedFailure(unpublishedStatus), unpublished));
	}
	return failures;
}

/**
 * The operator's note when either side followed the http → https upgrade: the stored
 * public URL costs every request a redirect, and the https one is what the public uses.
 */
function upgradeNote(published: Answer, unpublished: Answer): string | null {
	const origin = published.upgradedTo ?? unpublished.upgradedTo;
	return origin === undefined ? null : `http redirects to https — set the public URL to ${origin}`;
}

function verdict(published: Answer, unpublished: Answer, at: string): GateProbe {
	const statuses = {
		at,
		published_status: statusOf(published),
		unpublished_status: statusOf(unpublished),
	};
	const failures = gateFailures(published, unpublished);
	const unknown = [unknownOf('published', published), unknownOf('unpublished', unpublished)].filter(
		(part): part is string => part !== null,
	);
	const note = upgradeNote(published, unpublished);
	const notes = note === null ? [] : [note];
	if (failures.length > 0) {
		return { ...statuses, state: 'failed', detail: [...failures, ...unknown, ...notes].join('; ') };
	}
	if (unknown.length > 0) {
		return { ...statuses, state: 'unknown', detail: [...unknown, ...notes].join('; ') };
	}
	return { ...statuses, state: 'ok', detail: note };
}

// ---------------------------------------------------------------------------
// Copy hosts: a 404 must be the gate's, not absence's
// ---------------------------------------------------------------------------

const NOT_HELD_DETAIL =
	'the copy host does not hold the unpublished probe file (a 404 proves absence, not the gate)';

/** The agent's word on copy mode; unreachable → the last PROVEN (stamped) `n/a`, else unknown. */
async function takesCopy(name: string): Promise<boolean | { unknown: string }> {
	try {
		return (await hostStatus(name)).media.mode === 'copy';
	} catch {
		const row = ((await loadRuntime().catch(() => ({}))) as Record<string, HostRuntime>)[name];
		const provenNotCopy =
			row?.media_copy.state === 'n/a' && row.media_copy.last_verified_at !== null;
		return provenNotCopy
			? false
			: { unknown: 'the agent could not be asked whether it copies media' };
	}
}

async function manifestHolds(name: string, path: string): Promise<CopyHolding> {
	try {
		const manifest = await hostMediaManifest(name);
		return manifest.entries.some((entry) => entry.path === path) ? 'held' : 'not_held';
	} catch {
		return { unknown: "the copy host's manifest could not be read" };
	}
}

/** Production `copyHolding`: status (or the stamped runtime), then the manifest of a copy host. */
export async function agentCopyHolding(
	record: PublicationHostRecord,
	path: string,
): Promise<CopyHolding> {
	const copy = await takesCopy(record.name);
	if (copy === false) return 'not_copy';
	return copy === true ? manifestHolds(record.name, path) : copy;
}

function holdingDetail(holding: CopyHolding): string | null {
	if (holding === 'not_copy' || holding === 'held') return null;
	return holding === 'not_held' ? NOT_HELD_DETAIL : holding.unknown;
}

/**
 * A 404 on the unpublished side counts only when the host could have served the file;
 * the agent is asked only then (any other answer stands as it is).
 */
async function gateAnswer(
	record: PublicationHostRecord,
	path: string,
	unpublished: Answer,
	deps: ProbeDeps,
): Promise<Answer> {
	if (!('status' in unpublished) || unpublished.status !== 404) return unpublished;
	// AFTER the request: a file listed now was there then (an unmarked put is refused).
	const detail = holdingDetail(await (deps.copyHolding ?? agentCopyHolding)(record, path));
	if (detail === null) return unpublished;
	// The upgrade note survives the downgrade to unknown: it is about the URL, not the gate.
	return unpublished.upgradedTo === undefined
		? { unknown: detail }
		: { unknown: detail, upgradedTo: unpublished.upgradedTo };
}

function unknownProbe(at: string, detail: string): GateProbe {
	return { state: 'unknown', at, published_status: null, unpublished_status: null, detail };
}

/** Validate the origin and the paths, then probe both files through the public door. Writes nothing. */
export async function probeHostRecord(
	record: PublicationHostRecord,
	deps: ProbeDeps = {},
): Promise<GateProbe> {
	const at = new Date().toISOString();
	if (record.public_url === null) return unknownProbe(at, 'the public URL is not set');
	const origin = bareOrigin(record.public_url);
	if (origin === null) return unknownProbe(at, BARE_ORIGIN_REFUSAL);
	const valid = await validateProbePaths(record);
	if (!valid.ok) return unknownProbe(at, valid.reason);
	const paths = record.probe as { published: string; unpublished: string };
	const published = await publicAnswer(probeUrl(origin, paths.published), deps);
	const unpublished = await publicAnswer(probeUrl(origin, paths.unpublished), deps);
	return verdict(published, await gateAnswer(record, paths.unpublished, unpublished, deps), at);
}

async function probeAndRecord(record: PublicationHostRecord, deps: ProbeDeps): Promise<GateProbe> {
	const probe = await probeHostRecord(record, deps);
	await updateHostRuntime(record.name, (current) => ({ ...current, probe }));
	return probe;
}

/** Probe one registered host and record the verdict in `runtime.probe`. */
export async function probePublicGate(name: string, deps: ProbeDeps = {}): Promise<GateProbe> {
	const record = getHost(name);
	if (record === null) {
		throw new DedaloError('publication_host.unconfigured', {
			message: `publication host '${name}' is not in the registry`,
			coordinates: { host: name },
		});
	}
	return probeAndRecord(record, deps);
}

/** The `apply_rules` trigger: awaited by the action, never fails the (already applied) rules. */
export async function probeAfterRulesApplied(
	name: string,
	deps: ProbeDeps = {},
): Promise<GateProbe> {
	try {
		return await probePublicGate(name, deps);
	} catch (error) {
		console.error(`[publication_host] probe after apply_rules on '${name}' failed:`, error);
		return unknownProbe(new Date().toISOString(), 'the probe could not run (see the server log)');
	}
}

// ---------------------------------------------------------------------------
// P3 — the after-change lane (rule changes, copy batches)
// ---------------------------------------------------------------------------

interface ProbeLane {
	tail: Promise<void>;
	queued: boolean;
}

// Per-host serialization of AFTER-CHANGE probes (module_state_tripwire allowlisted):
// keyed on the registry host name, never request identity. An entry lives from the
// schedule call until its own probe settles (runLane deletes it), so the map holds
// at most one queued lane per host that is still changing.
const probeLanes = new Map<string, ProbeLane>();

async function runLane(
	name: string,
	cause: ProbeCause,
	lane: ProbeLane,
	probe: (name: string) => Promise<unknown>,
): Promise<void> {
	lane.queued = false;
	try {
		await probe(name);
	} catch (error) {
		console.error(`[publication_host] probe after ${cause} on '${name}' failed:`, error);
	} finally {
		if (probeLanes.get(name) === lane) probeLanes.delete(name);
	}
}

/**
 * Detached, never rejects. A change while a probe is IN FLIGHT queues one follow-up
 * (the running probe may predate the change); a change while one is merely QUEUED
 * joins it (it has not started, so it will see the change).
 */
export function scheduleProbeAfterChange(
	name: string,
	cause: ProbeCause,
	probe: (name: string) => Promise<unknown> = probePublicGate,
): Promise<void> {
	const current = probeLanes.get(name);
	if (current?.queued === true) return current.tail;
	const lane: ProbeLane = { tail: Promise.resolve(), queued: true };
	lane.tail = (current?.tail ?? Promise.resolve()).then(() => runLane(name, cause, lane, probe));
	probeLanes.set(name, lane);
	return lane.tail;
}

/** Did one copy-apply round change what the host serves (a file or a marker)? */
export function copyBatchChanged(counts: CopyBatchCounts): boolean {
	return counts.put + counts.deleted + counts.withdrawn + counts.published > 0;
}

/**
 * THE copy-batch trigger (P3). Called once at the end of each copy-apply driver —
 * the worker run (server.ts `afterSync`) and the media_copy reconcile apply — never
 * from `applyCopy`, so one sync schedules at most once. null = nothing changed.
 */
export function scheduleProbeAfterCopyBatch(
	name: string,
	counts: CopyBatchCounts,
	probe: (name: string) => Promise<unknown> = probePublicGate,
): Promise<void> | null {
	return copyBatchChanged(counts) ? scheduleProbeAfterChange(name, 'copy_batch', probe) : null;
}

// ---------------------------------------------------------------------------
// P3 — the scheduled reconcile (dry = report; apply = record the observation)
// ---------------------------------------------------------------------------

function probeConfigured(host: PublicationHostRecord): boolean {
	return (
		host.public_url !== null && host.probe.published !== null && host.probe.unpublished !== null
	);
}

function inScope(host: PublicationHostRecord, scope: ReconcileScope | undefined): boolean {
	return scope === undefined || scope.includes(host.name);
}

/** Dry: probe, write nothing (ReconcileRunOptions). Apply: probe and record. */
function probeFor(apply: boolean): (host: PublicationHostRecord) => Promise<GateProbe> {
	return apply ? (host) => probeAndRecord(host, {}) : (host) => probeHostRecord(host);
}

async function runProbeReconcile(options: ReconcileRunOptions): Promise<ReconcileReport> {
	const hosts: Record<string, GateProbe['state']> = {};
	const skipped: string[] = [];
	const probe = probeFor(options.apply);
	let recorded = 0;
	for (const host of loadRegistry().hosts.filter((entry) => inScope(entry, options.scope))) {
		const verdictOf = await probe(host);
		if (options.apply) recorded++;
		if (probeConfigured(host)) hosts[host.name] = verdictOf.state;
		else skipped.push(host.name);
	}
	const drift = Object.values(hosts).filter((state) => state !== 'ok').length;
	// An observation repairs nothing: applied is always 0; `recorded` counts runtime writes.
	return { drift, applied: 0, detail: { hosts, skipped, recorded } };
}

export const PUBLICATION_PROBE_RECONCILE: ReconcileDefinition = {
	name: 'publication_probe',
	stores: [
		'publication-host registry probe paths + work pub/ markers',
		'publication-host public URL answers',
	],
	description:
		"Fetches each publication host's two probe files through its PUBLIC URL: the published one must answer 2xx, the unpublished one 404. Drift = configured hosts whose gate is not proven (failed or unknown). A dry run writes nothing; apply records each verdict in runtime.probe and repairs nothing — the repair is apply_rules, an operator action.",
	scopeLabel: 'publication host name',
	schedule: { everyMs: PUBLICATION_PROBE_EVERY_MS },
	autoApply: {
		reason:
			'apply only records the observed verdict in runtime.probe (idempotent, overwrites one observation per host, writes no gate, media or registry); without it the scheduled dry run would leave the panel showing a stale proof',
	},
	sources: ['src/core/publication_host/probe.ts'],
	run: runProbeReconcile,
};
