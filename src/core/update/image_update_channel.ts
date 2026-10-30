/**
 * THE IMAGE-UPDATE CHANNEL — the files the engine and the opt-in HOST UPDATER
 * exchange (installer unification D4, 2026-10-09).
 *
 * A container installation updates by replacing its image, and only the Docker
 * HOST can do that: the engine is never given docker.sock. So when the operator
 * presses "Request update" in the panel, the engine only RECORDS the request;
 * the host updater (deploy/dedalo-image-updater.sh, a systemd timer the
 * operator installs) claims it, runs deploy/dedalo-image-update.sh with its
 * backup / health / rollback, and records the outcome here for the panel.
 *
 * WHY FILES, AND WHY NOT A SECTION (the Dédalo way). Sections hold cataloguing
 * data; this is a one-shot instruction between two processes of ONE deployment,
 * the same kind of thing as the tree-swap sentinel (boot_confirm.ts) and
 * ts_state.json. A section would force the host to hold database credentials
 * and know ontology tipos — and a database restore would resurrect a stale
 * request, which could then install an image nobody asked for today.
 *
 * WHERE: `<private dir>/image_update/` (`/private/image_update` in the stacks),
 * owned by the engine's user: the dir 0750, every file 0640 — explicit modes,
 * never the umask's. The host never touches the volume's host path (it differs
 * under Docker Desktop, rootless docker, a remote DOCKER_HOST); it talks to
 * scripts/ops/image_update_channel.ts through `docker compose exec|run`, and
 * gets back only strictly validated fields.
 *
 *   host_updater.json   the host updater's heartbeat (seen_at stamped here)
 *   request.json        written by the engine (the panel's request), EXCLUSIVELY
 *   inflight.json       the claimed request (request + claimed_at)
 *   last_outcome.json   the last result, as dedalo-image-update.sh wrote it
 *
 * EVERY FILE IS UNTRUSTED ON READ. Validators are closed-shape: an unknown key,
 * a value outside its grammar, or a broken JSON reads as ABSENT (null), never
 * as a partial object and never as a throw — a panel is a diagnostic surface.
 *
 * A LEAF: env.ts (privateDir), the version walk, the registry grammar and node
 * builtins — never config.ts, so the CLI answers on an unconfigured box too.
 * Gates: test/unit/image_update_channel_native.test.ts (every CLI verb, the
 * modes), update_status_native.test.ts (the panel block),
 * update_code_widget_native.test.ts (the request / cancel actions).
 */

import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { privateDir } from '../../config/env.ts';
import { isRepositoryReference } from './image_registries.ts';
import { INSTALL_CHANNELS, type InstallChannel } from './install_stamp.ts';
import { identityOfImageTag, parseReleaseVersion } from './release_identity.ts';
import { parseImageTag } from './version_walk.ts';

export const IMAGE_UPDATE_DIR_MODE = 0o750;
export const IMAGE_UPDATE_FILE_MODE = 0o640;

export const HEARTBEAT_FILE = 'host_updater.json';
export const REQUEST_FILE = 'request.json';
export const INFLIGHT_FILE = 'inflight.json';
export const OUTCOME_FILE = 'last_outcome.json';

/** The floor of the alive window: a heartbeat at most this old (or 3 intervals) is alive. */
export const ALIVE_FLOOR_SECONDS = 180;

/** The channel directory (the seam: tests and the CLI's --dir pass their own). */
export function imageUpdateDir(dir?: string): string {
	return dir ?? join(privateDir, 'image_update');
}

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------

export type ImageSourceModeValue = 'pull' | 'build';
export type ImageVerify = 'cosign' | 'none';

/** What the host updater says about itself (stdin of `heartbeat`). */
export interface HostHeartbeat {
	schema: 1;
	interval_seconds: number;
	mode: ImageSourceModeValue;
	image: string;
	/** The DEDALO_VERSION pinned in the host's `.dedalo.env`. */
	pinned: string;
	verify: ImageVerify;
	running_digest: string | null;
}

/** The heartbeat as stored: the CLI stamps the moment it saw it. */
export interface StoredHeartbeat extends HostHeartbeat {
	seen_at: string;
}

/** A request the panel recorded. */
export interface ImageUpdateRequest {
	schema: 1;
	id: string;
	/** `X.Y.Z`, `X.Y.Z-(alpha|beta|rc).N` or `X.Y.Z-dev` — the image tag the host installs. */
	tag: string;
	/** `X.Y.Z` — the data version the tag names. */
	version: string;
	channel: InstallChannel;
	/**
	 * The engine that asked, by its RELEASE IDENTITY (release_identity.ts):
	 * `X.Y.Z`, `X.Y.Z-(alpha|beta|rc).N` or `X.Y.Z.dev`. Informational — the
	 * host orders by `tag`/`version`, never by this.
	 */
	from_version: string;
	requested_at: string;
	/** The requesting user's id. */
	requested_by: number;
}

/** A claimed request. */
export interface ImageUpdateInflight extends ImageUpdateRequest {
	claimed_at: string;
}

export const OUTCOME_STATUSES = [
	'green',
	'rolled_back',
	'rollback_failed',
	'refused',
	'failed',
] as const;
export const OUTCOME_DETAILS = [
	'healthy',
	'health_timeout',
	'unhealthy',
	'pull_failed',
	'verify_failed',
	'build_failed',
	'backup_failed',
	'version_refused',
	// the pinned release asked for again (deploy/dedalo-image-update.sh check_version)
	'same_version',
	'downgrade_refused',
	'not_running',
	'env_incomplete',
	'locked',
	'interrupted',
	'malformed_request',
] as const;

/** One update's result (deploy/dedalo-image-update.sh --outcome-file). */
export interface ImageUpdateOutcome {
	schema: 1;
	request_id: string | null;
	from: string;
	to: string;
	mode: ImageSourceModeValue | null;
	image: string;
	status: (typeof OUTCOME_STATUSES)[number];
	detail: (typeof OUTCOME_DETAILS)[number];
	backup: string | null;
	digest: string | null;
	started_at: string | null;
	finished_at: string | null;
}

/** The outcome as stored: the CLI stamps when it recorded it. */
export interface StoredOutcome extends ImageUpdateOutcome {
	recorded_at: string;
}

// ---------------------------------------------------------------------------
// Grammar — each a predicate over an untrusted value
// ---------------------------------------------------------------------------

type Rule = (value: unknown) => boolean;

const UUID4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const TRIPLE_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const BACKUP_PATH_RE = /^\/[A-Za-z0-9._/+:-]{1,1024}$/;

function oneOf(values: readonly unknown[]): Rule {
	return (value) => values.includes(value);
}
function orNull(rule: Rule): Rule {
	return (value) => value === null || rule(value);
}
function orEmpty(rule: Rule): Rule {
	return (value) => value === '' || rule(value);
}
function matching(re: RegExp): Rule {
	return (value) => typeof value === 'string' && re.test(value);
}
function integerIn(min: number, max: number): Rule {
	return (value) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

export const isUuid4: Rule = matching(UUID4_RE);
/**
 * A release identity, by the ONE grammar the engine names itself with — a
 * private grammar here once refused every prerelease engine's own request.
 * Bounded in length like the other string fields.
 */
const isEngineVersion: Rule = (value) =>
	typeof value === 'string' && value.length <= 64 && parseReleaseVersion(value) !== null;
export const isIsoInstant: Rule = (value) =>
	matching(ISO_RE)(value) && !Number.isNaN(Date.parse(value as string));
const isTag: Rule = (value) => parseImageTag(value) !== null;
/**
 * A tag the HOST reports (the heartbeat's pin, an outcome's from/to): the host
 * library's image-tag grammar (deploy/dedalo-image-lib.sh DEDALO_VERSION_RE =
 * identityOfImageTag — a prerelease pin `7.0.0-beta.7` since design step 6, the
 * installer writes one for every beta stack), or a tag this engine walks. A
 * DESCRIPTIVE field: refusing it would blind the panel to the very stack the
 * installer built. A request's TARGET stays isTag — what the engine may walk to.
 */
const isHostTag: Rule = (value) =>
	isTag(value) ||
	(typeof value === 'string' && value.length <= 64 && identityOfImageTag(value) !== null);
const isDigest: Rule = matching(DIGEST_RE);
const isRepository: Rule = (value) => isRepositoryReference(value);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A CLOSED shape: exactly these keys, each satisfying its rule. */
function matchesShape(raw: unknown, rules: Readonly<Record<string, Rule>>): boolean {
	if (!isRecord(raw)) return false;
	const keys = Object.keys(rules);
	if (Object.keys(raw).some((key) => !keys.includes(key))) return false;
	return keys.every((key) => (rules[key] as Rule)(raw[key]));
}

const HEARTBEAT_RULES: Readonly<Record<string, Rule>> = Object.freeze({
	schema: oneOf([1]),
	interval_seconds: integerIn(10, 3600),
	mode: oneOf(['pull', 'build']),
	image: isRepository,
	pinned: isHostTag,
	verify: oneOf(['cosign', 'none']),
	running_digest: orNull(isDigest),
});

const REQUEST_RULES: Readonly<Record<string, Rule>> = Object.freeze({
	schema: oneOf([1]),
	id: isUuid4,
	tag: isTag,
	version: matching(TRIPLE_RE),
	// the InstallChannel ladder (install_stamp.ts INSTALL_CHANNELS): a
	// prerelease tag is its own channel since the identity walk (design step 9c)
	channel: oneOf(INSTALL_CHANNELS),
	from_version: isEngineVersion,
	requested_at: isIsoInstant,
	requested_by: integerIn(-1, Number.MAX_SAFE_INTEGER),
});

const OUTCOME_RULES: Readonly<Record<string, Rule>> = Object.freeze({
	schema: oneOf([1]),
	request_id: orNull(isUuid4),
	from: orEmpty(isHostTag),
	to: orEmpty(isHostTag),
	mode: orNull(oneOf(['pull', 'build'])),
	image: orEmpty(isRepository),
	status: oneOf(OUTCOME_STATUSES),
	detail: oneOf(OUTCOME_DETAILS),
	backup: orNull(matching(BACKUP_PATH_RE)),
	digest: orNull(isDigest),
	started_at: orNull(isIsoInstant),
	finished_at: orNull(isIsoInstant),
});

/** The tag, version and channel of a request must name ONE release. */
function requestIsCoherent(raw: Record<string, unknown>): boolean {
	const parsed = parseImageTag(raw.tag);
	return parsed !== null && parsed.version === raw.version && parsed.channel === raw.channel;
}

export function validHeartbeat(raw: unknown): raw is HostHeartbeat {
	return matchesShape(raw, HEARTBEAT_RULES);
}

export function validStoredHeartbeat(raw: unknown): raw is StoredHeartbeat {
	return matchesShape(raw, { ...HEARTBEAT_RULES, seen_at: isIsoInstant });
}

export function validRequest(raw: unknown): raw is ImageUpdateRequest {
	return matchesShape(raw, REQUEST_RULES) && requestIsCoherent(raw as Record<string, unknown>);
}

export function validInflight(raw: unknown): raw is ImageUpdateInflight {
	return (
		matchesShape(raw, { ...REQUEST_RULES, claimed_at: isIsoInstant }) &&
		requestIsCoherent(raw as Record<string, unknown>)
	);
}

export function validOutcome(raw: unknown): raw is ImageUpdateOutcome {
	return matchesShape(raw, OUTCOME_RULES);
}

export function validStoredOutcome(raw: unknown): raw is StoredOutcome {
	return matchesShape(raw, { ...OUTCOME_RULES, recorded_at: isIsoInstant });
}

// ---------------------------------------------------------------------------
// Files — atomic writes with explicit modes; reads that never throw
// ---------------------------------------------------------------------------

/** Create the channel dir (0750, whatever the umask). */
export function ensureChannelDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: IMAGE_UPDATE_DIR_MODE });
	chmodSync(dir, IMAGE_UPDATE_DIR_MODE);
}

/** A sibling temp file holding `value` (0640), ready to be renamed or linked in. */
async function writeTemp(dir: string, name: string, value: unknown): Promise<string> {
	ensureChannelDir(dir);
	const temp = join(dir, `.${name}.${randomUUID()}.tmp`);
	await writeFile(temp, `${JSON.stringify(value, null, '\t')}\n`, { mode: IMAGE_UPDATE_FILE_MODE });
	chmodSync(temp, IMAGE_UPDATE_FILE_MODE);
	return temp;
}

/** Replace `name` atomically: a reader sees the old file or the new one, never half. */
export async function writeChannelFile(dir: string, name: string, value: unknown): Promise<void> {
	renameSync(await writeTemp(dir, name, value), join(dir, name));
}

/** Create `name` only if it does not exist (link is atomic and refuses EEXIST). */
async function writeChannelFileExclusive(
	dir: string,
	name: string,
	value: unknown,
): Promise<boolean> {
	const temp = await writeTemp(dir, name, value);
	try {
		linkSync(temp, join(dir, name));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
		throw error;
	} finally {
		unlinkSync(temp);
	}
}

/** A channel file: absent, unreadable/unparseable (malformed), or its raw JSON. */
export type FileRead =
	| { state: 'absent' }
	| { state: 'malformed' }
	| { state: 'ok'; value: unknown };

export async function readChannelFile(dir: string, name: string): Promise<FileRead> {
	const path = join(dir, name);
	if (!existsSync(path)) return { state: 'absent' };
	try {
		return { state: 'ok', value: JSON.parse(await readFile(path, 'utf8')) };
	} catch {
		return { state: 'malformed' };
	}
}

/** The file's value when it passes `valid`, else null — the never-throw read. */
async function readValid<T>(
	dir: string,
	name: string,
	valid: (raw: unknown) => raw is T,
): Promise<T | null> {
	const read = await readChannelFile(dir, name);
	return read.state === 'ok' && valid(read.value) ? read.value : null;
}

/** Remove a file; true when this call removed it. */
function removeChannelFile(dir: string, name: string): boolean {
	try {
		unlinkSync(join(dir, name));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}

// ---------------------------------------------------------------------------
// The host updater's state
// ---------------------------------------------------------------------------

export type HostUpdaterState = 'absent' | 'stale' | 'alive';

/** The panel's view of the host updater (design 5.5). */
export interface HostUpdaterView {
	state: HostUpdaterState;
	seen_at: string | null;
	interval_seconds: number | null;
	mode: ImageSourceModeValue | null;
	image: string | null;
	pinned: string | null;
	verify: ImageVerify | null;
	running_digest: string | null;
}

const NO_HOST_UPDATER: Readonly<HostUpdaterView> = Object.freeze({
	state: 'absent',
	seen_at: null,
	interval_seconds: null,
	mode: null,
	image: null,
	pinned: null,
	verify: null,
	running_digest: null,
});

/** alive ⇔ now − seen_at ≤ max(3 × interval, ALIVE_FLOOR_SECONDS). */
export function heartbeatIsAlive(beat: StoredHeartbeat, now: Date): boolean {
	const window = Math.max(3 * beat.interval_seconds, ALIVE_FLOOR_SECONDS) * 1000;
	return now.getTime() - Date.parse(beat.seen_at) <= window;
}

export async function readHostUpdaterState(
	now: Date,
	dir: string = imageUpdateDir(),
): Promise<HostUpdaterView> {
	const beat = await readValid(dir, HEARTBEAT_FILE, validStoredHeartbeat);
	if (beat === null) return { ...NO_HOST_UPDATER };
	const { schema: _schema, ...fields } = beat;
	return { ...fields, state: heartbeatIsAlive(beat, now) ? 'alive' : 'stale' };
}

/** Store a heartbeat from the host (validated; seen_at is OURS, never the host's). */
export async function recordHeartbeat(
	raw: unknown,
	now: Date,
	dir: string = imageUpdateDir(),
): Promise<boolean> {
	if (!validHeartbeat(raw)) return false;
	await writeChannelFile(dir, HEARTBEAT_FILE, { ...raw, seen_at: now.toISOString() });
	return true;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** The pending request as the panel shows it (design 5.5). */
export interface PendingRequestView extends Omit<ImageUpdateRequest, 'schema'> {
	state: 'requested' | 'claimed';
	claimed_at: string | null;
}

/** Is any request pending or in flight (files present, valid or not)? */
export function requestOutstanding(dir: string = imageUpdateDir()): boolean {
	return existsSync(join(dir, REQUEST_FILE)) || existsSync(join(dir, INFLIGHT_FILE));
}

/** The claimed request first (it is what is running), else the pending one, else null. */
export async function readPendingRequest(
	dir: string = imageUpdateDir(),
): Promise<PendingRequestView | null> {
	const inflight = await readValid(dir, INFLIGHT_FILE, validInflight);
	if (inflight !== null) {
		const { schema: _schema, ...fields } = inflight;
		return { ...fields, state: 'claimed' };
	}
	const request = await readValid(dir, REQUEST_FILE, validRequest);
	if (request === null) return null;
	const { schema: _schema, ...fields } = request;
	return { ...fields, state: 'requested', claimed_at: null };
}

export type WriteRequestResult =
	| { ok: true }
	| { ok: false; reason: 'request_pending' | 'invalid' };

/** Record a request — refused while another is pending or in flight. */
export async function writeRequest(
	request: ImageUpdateRequest,
	dir: string = imageUpdateDir(),
): Promise<WriteRequestResult> {
	if (!validRequest(request)) return { ok: false, reason: 'invalid' };
	if (existsSync(join(dir, INFLIGHT_FILE))) return { ok: false, reason: 'request_pending' };
	return (await writeChannelFileExclusive(dir, REQUEST_FILE, request))
		? { ok: true }
		: { ok: false, reason: 'request_pending' };
}

export type CancelResult = { ok: true } | { ok: false; reason: 'request_claimed' | 'no_request' };

/** Remove an UNCLAIMED request. A claimed one is already running on the host. */
export function cancelRequest(dir: string = imageUpdateDir()): CancelResult {
	if (existsSync(join(dir, INFLIGHT_FILE))) return { ok: false, reason: 'request_claimed' };
	if (removeChannelFile(dir, REQUEST_FILE)) return { ok: true };
	// lost the race against `claim` (it renamed the file away), or there was none
	return {
		ok: false,
		reason: existsSync(join(dir, INFLIGHT_FILE)) ? 'request_claimed' : 'no_request',
	};
}

export type ClaimResult =
	| { kind: 'claimed'; inflight: ImageUpdateInflight }
	| { kind: 'none' }
	| { kind: 'busy' }
	| { kind: 'malformed' };

/** The outcome a request that cannot be read is answered with. */
function malformedRequestOutcome(now: Date): ImageUpdateOutcome {
	const stamp = now.toISOString();
	return {
		schema: 1,
		request_id: null,
		from: '',
		to: '',
		mode: null,
		image: '',
		status: 'refused',
		detail: 'malformed_request',
		backup: null,
		digest: null,
		started_at: stamp,
		finished_at: stamp,
	};
}

/** Test seam: a hook run immediately before the claim's rename (the claim window). */
export interface ClaimSeams {
	beforeRename?: () => Promise<void> | void;
}

/**
 * Claim the pending request for the host updater. The claim is a RENAME
 * (request.json → inflight.json), so it and a concurrent cancel cannot both
 * win. The rename comes FIRST and the claimed inflight.json is what is read,
 * validated and stamped with `claimed_at`: a request read before the rename
 * could be cancelled and replaced in between, and the claim would then
 * install the cancelled request over the new one (U-43).
 */
export async function claimRequest(
	now: Date,
	dir: string = imageUpdateDir(),
	seams: ClaimSeams = {},
): Promise<ClaimResult> {
	if (existsSync(join(dir, INFLIGHT_FILE))) return { kind: 'busy' };
	if (!existsSync(join(dir, REQUEST_FILE))) return { kind: 'none' };
	await seams.beforeRename?.();
	if (!renameRequestToInflight(dir)) return { kind: 'none' }; // cancelled before the rename
	const read = await readChannelFile(dir, INFLIGHT_FILE);
	if (read.state !== 'ok' || !validRequest(read.value)) {
		removeChannelFile(dir, INFLIGHT_FILE);
		await recordOutcome(malformedRequestOutcome(now), now, dir);
		return { kind: 'malformed' };
	}
	const inflight: ImageUpdateInflight = { ...read.value, claimed_at: now.toISOString() };
	await writeChannelFile(dir, INFLIGHT_FILE, inflight);
	return { kind: 'claimed', inflight };
}

/** The claim's one atomic step; false when there was no request.json to move. */
function renameRequestToInflight(dir: string): boolean {
	try {
		renameSync(join(dir, REQUEST_FILE), join(dir, INFLIGHT_FILE));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}

export type OrphanResult =
	| { kind: 'orphan'; inflight: ImageUpdateInflight }
	| { kind: 'none' }
	| { kind: 'malformed' };

/**
 * An inflight request nobody finished (the host died mid-update). The host
 * records it as failed/interrupted through `outcome`. An inflight that cannot
 * be read is answered here, with a request id of null, and cleared.
 */
export async function orphanInflight(
	now: Date,
	dir: string = imageUpdateDir(),
): Promise<OrphanResult> {
	const read = await readChannelFile(dir, INFLIGHT_FILE);
	if (read.state === 'absent') return { kind: 'none' };
	if (read.state === 'ok' && validInflight(read.value))
		return { kind: 'orphan', inflight: read.value };
	removeChannelFile(dir, INFLIGHT_FILE);
	await recordOutcome(
		{ ...malformedRequestOutcome(now), status: 'failed', detail: 'interrupted' },
		now,
		dir,
	);
	return { kind: 'malformed' };
}

/**
 * Record an outcome (validated; recorded_at is OURS). When it answers the
 * request in flight, that request is done and its file goes.
 */
export async function recordOutcome(
	raw: unknown,
	now: Date,
	dir: string = imageUpdateDir(),
): Promise<boolean> {
	if (!validOutcome(raw)) return false;
	await writeChannelFile(dir, OUTCOME_FILE, { ...raw, recorded_at: now.toISOString() });
	const inflight = await readValid(dir, INFLIGHT_FILE, validInflight);
	if (inflight !== null && raw.request_id === inflight.id) removeChannelFile(dir, INFLIGHT_FILE);
	return true;
}

/** The last recorded outcome, or null. */
export async function readLastOutcome(
	dir: string = imageUpdateDir(),
): Promise<StoredOutcome | null> {
	return readValid(dir, OUTCOME_FILE, validStoredOutcome);
}

/** Everything the panel and `status` report about the channel. */
export interface ChannelStatus {
	host_updater: HostUpdaterView;
	request: PendingRequestView | null;
	last_outcome: StoredOutcome | null;
}

export async function readChannelStatus(
	now: Date,
	dir: string = imageUpdateDir(),
): Promise<ChannelStatus> {
	const [hostUpdater, request, lastOutcome] = await Promise.all([
		readHostUpdaterState(now, dir),
		readPendingRequest(dir),
		readLastOutcome(dir),
	]);
	return { host_updater: hostUpdater, request, last_outcome: lastOutcome };
}
