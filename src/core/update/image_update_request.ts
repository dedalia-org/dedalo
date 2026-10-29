/**
 * THE PANEL'S IMAGE-UPDATE REQUEST — what "Request this update" does on a
 * container installation (installer unification D3/D4, 2026-10-09).
 *
 * The engine never updates its own image (it has no docker access, by design).
 * It RECORDS a request in the image-update channel (image_update_channel.ts);
 * the opt-in host updater claims it within a minute and runs
 * deploy/dedalo-image-update.sh — backup, pull or build, health, rollback —
 * from the operator's OWN `.dedalo.env`. What a request can choose is a
 * version and nothing else: the repository, the mode, every flag and every
 * ref are the host's.
 *
 * THE GATES, in order, each the one its neighbours already use:
 *   1. checkUpdatePreconditions — superuser + maintenance mode, the code
 *      update's own gate (preconditions.ts);
 *   2. the deployment channel is `image` (channel.ts, the `channel` check's
 *      predicate) — a tree-swap install updates through the swap;
 *   3. the host updater is ALIVE (its heartbeat) — a request nobody will
 *      claim would sit there until the next unrelated install;
 *   4. nothing is pending or in flight — one update at a time;
 *   5. a developer (-dev) target is refused, whatever the installation runs:
 *      Docker has no nightly images (VERSIONING_SPEC §2, §3, S3). The refusal
 *      carries nightlyImageMessage (update/release_identity.ts). The host
 *      updater refuses the same tags (deploy/dedalo-image-updater.sh
 *      host_floor_refusal);
 *   6. the target is a legal step of the IDENTITY walk from what this engine
 *      calls itself (version_walk.ts identityWalkRefusal, THE rule the tree
 *      swap and the host CLI's check-target use): a prerelease target is
 *      named by its release identity (`release`, a prerelease item's own —
 *      code_manifest.ts), never by the bare triple its `version` carries.
 * Refusals are returned as machine ids; the widget turns them into
 * `maintenance.action_refused` with `coordinates.reason`, the client words them.
 *
 * Gate: test/unit/update_code_widget_native.test.ts.
 */

import { randomUUID } from 'node:crypto';
import { projectRoot } from '../../config/env.ts';
import { DedaloError } from '../errors/index.ts';

import { type Principal, SUPERUSER_ID } from '../security/permissions.ts';
import { DEDALO_ENGINE_VERSION } from './build_stamp.ts';
import { type DeploymentChannel, detectDeploymentChannel } from './channel.ts';
import {
	type CancelResult,
	cancelRequest,
	type ImageUpdateRequest,
	imageUpdateDir,
	type PendingRequestView,
	readHostUpdaterState,
	readPendingRequest,
	requestOutstanding,
	writeRequest,
} from './image_update_channel.ts';
import { checkUpdatePreconditions } from './preconditions.ts';
import { nightlyImageMessage, parseReleaseVersion } from './release_identity.ts';
import { type ImageTag, parseImageTag, type WalkRefusal, walkRefusalOf } from './version_walk.ts';

/** Why a request is refused — the closed id set the client labels. */
export type ImageRequestRefusal =
	| 'not_image_channel'
	| 'host_updater_not_alive'
	| 'request_pending'
	| 'malformed_version'
	| 'version_refused';

export type ImageRequestResult =
	| { ok: true; request: PendingRequestView }
	| { ok: false; reason: ImageRequestRefusal; walk?: WalkRefusal; message?: string };

/** Test seams — production passes none. */
export interface ImageRequestSeams {
	channel?: DeploymentChannel;
	dir?: string;
	now?: Date;
	/**
	 * The RELEASE IDENTITY the walk starts from (default: this engine's own,
	 * build_stamp.ts DEDALO_ENGINE_VERSION) — a gate pins it, because the
	 * checkout a suite runs in is `.dev` on a branch and the tag on a release commit.
	 */
	running?: string;
}

/** The tag suffix of each channel a manifest item can carry (an absent channel is a release). */
const CHANNEL_SUFFIX: Readonly<Record<string, string>> = Object.freeze({ master: '', dev: '-dev' });

/**
 * The target the options name, or null: `{version:'X.Y.Z', channel?:'master'|'dev'}`,
 * or a prerelease `{version:'X.Y.Z', channel:'prerelease', release:'X.Y.Z-beta.N'}`
 * — the manifest item's own fields (code_manifest.ts CodeReleaseItem), whose
 * `release` must be a prerelease OF that `version`: the image tag IS the
 * identity (release_identity.ts imageTagOf), and a release naming another
 * triple would pick one image while the walk judged another.
 */
export function requestedTag(options: Record<string, unknown>): ImageTag | null {
	const version = options.version;
	if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return null;
	if (options.channel === 'prerelease') return prereleaseTag(version, options.release);
	const suffix = CHANNEL_SUFFIX[String(options.channel ?? 'master')];
	return suffix === undefined ? null : parseImageTag(`${version}${suffix}`);
}

/** A prerelease target: its identity, a prerelease of `version`, as a tag. */
function prereleaseTag(version: string, release: unknown): ImageTag | null {
	if (typeof release !== 'string') return null;
	const parsed = parseReleaseVersion(release);
	if (parsed === null || parsed.prerelease === null || parsed.triple.join('.') !== version)
		return null;
	return parseImageTag(release);
}

/** Gates 2-4: the state of this installation, before the target is looked at. */
async function stateRefusal(
	seams: ImageRequestSeams,
	dir: string,
): Promise<ImageRequestRefusal | null> {
	if ((seams.channel ?? detectDeploymentChannel(projectRoot)) !== 'image')
		return 'not_image_channel';
	if ((await readHostUpdaterState(seams.now ?? new Date(), dir)).state !== 'alive')
		return 'host_updater_not_alive';
	return requestOutstanding(dir) ? 'request_pending' : null;
}

/** Gate 5: Docker has no nightly images — a -dev target is refused, whatever runs now (S3). */
function devImageRefusal(target: ImageTag): ImageRequestResult | null {
	if (target.channel !== 'dev') return null;
	return { ok: false, reason: 'version_refused', message: nightlyImageMessage(target.tag) };
}

/** The request record a valid target becomes. */
function requestRecord(target: ImageTag, principal: Principal, now: Date): ImageUpdateRequest {
	return {
		schema: 1,
		id: randomUUID(),
		tag: target.tag,
		version: target.version,
		channel: target.channel,
		from_version: DEDALO_ENGINE_VERSION,
		requested_at: now.toISOString(),
		requested_by: principal.userId,
	};
}

/**
 * Write the request; a pending one makes it `request_pending`. The record is
 * built here from validated parts, so its own validation failing is an engine
 * defect, never an operator's refusal.
 */
async function writeTarget(
	target: ImageTag,
	principal: Principal,
	now: Date,
	dir: string,
): Promise<ImageRequestResult> {
	const written = await writeRequest(requestRecord(target, principal, now), dir);
	if (written.ok)
		return { ok: true, request: (await readPendingRequest(dir)) as PendingRequestView };
	if (written.reason === 'request_pending') return { ok: false, reason: 'request_pending' };
	throw new DedaloError('internal.invariant', {
		message: `image update request for ${target.tag} failed its own validation (from ${DEDALO_ENGINE_VERSION})`,
		coordinates: { module: 'core/update/image_update_request.ts' },
	});
}

/** Gate 6 and the write. */
async function recordTarget(
	target: ImageTag,
	principal: Principal,
	seams: ImageRequestSeams,
	dir: string,
): Promise<ImageRequestResult> {
	const walk = walkRefusalOf(
		seams.running ?? DEDALO_ENGINE_VERSION,
		target.identity,
		target.channel,
	);
	if (walk !== null) return { ok: false, reason: 'version_refused', walk };
	const result = await writeTarget(target, principal, seams.now ?? new Date(), dir);
	// the request is an instruction to replace the running code: who asked is
	// logged loudly, like the backup waiver (code_update.ts)
	if (result.ok)
		console.warn(
			`[image_update] user ${principal.userId} requested the image update to ${target.tag} (host updater will claim it)`,
		);
	return result;
}

/**
 * Record an image-update request. THROWS the preconditions' own typed errors
 * (perm.superuser_required / maintenance.mode_required); every other refusal
 * is a returned id.
 */
export async function requestImageUpdate(
	options: Record<string, unknown>,
	principal: Principal,
	seams: ImageRequestSeams = {},
): Promise<ImageRequestResult> {
	checkUpdatePreconditions(principal);
	const dir = imageUpdateDir(seams.dir);
	const refusal = await stateRefusal(seams, dir);
	if (refusal !== null) return { ok: false, reason: refusal };
	const target = requestedTag(options);
	if (target === null) return { ok: false, reason: 'malformed_version' };
	const devRefusal = devImageRefusal(target);
	if (devRefusal !== null) return devRefusal;
	return recordTarget(target, principal, seams, dir);
}

/**
 * Withdraw an UNCLAIMED request. Superuser only — and deliberately NOT the
 * maintenance-mode half of checkUpdatePreconditions: withdrawing an update is
 * never the risky direction, and an operator who left maintenance mode after
 * requesting must still be able to take the request back. (The `maintenance:
 * false` flag is a shrink-only census in update_preconditions.test.ts; this
 * door asks the superuser question alone instead of joining it.)
 */
export function cancelImageUpdateRequest(
	principal: Principal,
	seams: Pick<ImageRequestSeams, 'dir'> = {},
): CancelResult {
	if (principal.userId !== SUPERUSER_ID) {
		throw new DedaloError('perm.superuser_required', { coordinates: { user: principal.userId } });
	}
	const result = cancelRequest(imageUpdateDir(seams.dir));
	if (result.ok)
		console.warn(
			`[image_update] user ${principal.userId} cancelled the pending image update request`,
		);
	return result;
}
