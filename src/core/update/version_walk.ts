/**
 * THE VERSION WALK — one rule shared by every door that moves an install to
 * another version (installer unification D3, 2026-10-09): the tree swap
 * (code_update.ts), the image-update request the panel records
 * (area_maintenance/widgets/update_code.ts), and the host CLI's `check-target`
 * (scripts/ops/image_update_channel.ts) that deploy/dedalo-image-update.sh asks
 * before it pulls or builds.
 *
 * MOVED VERBATIM out of code_update.ts so the CLI can load it without
 * config.ts (it must answer on a box that is not configured, inside an image the operator is
 * about to replace). A LEAF: version.ts, the pure release-identity grammar and
 * a type, nothing else — the RUNNING identity is handed in by each door, never
 * imported here (release_identity_separation_tripwire: this module is a data
 * consumer).
 *
 * TWO LAYERS (RELEASE_IDENTITY_DESIGN §2.8 item 3, 2026-10-18). The DATA walk
 * ({@link assertLinearUpgrade}, triples only) is what migrations care about; the
 * IDENTITY walk ({@link identityWalkRefusal}) is what every door asks, and it
 * delegates to the data walk exactly when the move crosses a data triple.
 * Gates: test/unit/code_update*.test.ts (the swap),
 * test/unit/image_update_channel_native.test.ts (the CLI's verdicts equal this)
 * and test/unit/release_identity_walk_native.test.ts (gate 15: the truth table
 * test/fixtures/release_identity/walk_truth_table.json, TS + client verdict).
 */

import type { InstallChannel } from './install_stamp.ts';
import {
	compareReleaseIdentities,
	identityOfImageTag,
	type ParsedReleaseVersion,
	parseReleaseVersion,
} from './release_identity.ts';
import { compareVersionArrays } from './version.ts';

/**
 * Strict linear upgrade guard (Opus §1.3) — a backstop against a malicious or
 * buggy code server offering a skip. Returns null when the target is a legal
 * next rung, else the reason.
 *
 * THE DATA WALK, on triples only. No door asks it directly since the identity
 * walk (2026-10-18): {@link identityWalkRefusal} asks it for every move that
 * crosses a data triple — and it stays exported, unchanged, because it IS the
 * contract of every engine that predates the identity walk (the engine a host
 * meets when it is the old image being replaced; test/unit/image_update_script_native
 * emulates that engine with it).
 *
 * THE DEV CHANNEL (2026-08-24) relaxes exactly ONE clause: `target === current`
 * becomes legal, because a branch build carries no version bump — that is the
 * whole point of testing unreleased `v7` code on a remote install. This is the
 * TRIPLE walk, the one an engine that predates the identity walk still runs, so
 * the host relies on it to move a prerelease forward (beta.6 → beta.7 is asked
 * as the data move `X.Y.Z-dev`). An identity-aware engine decides the same-triple
 * developer moves with its identity order (identityWalkRefusal), which is
 * STRICTER: a developer build below its triple's stable is a downgrade there.
 * It relaxes an ORDERING guard, not an AUTHENTICITY one: the origin allowlist,
 * the no-redirect rule and the sha256-vs-sidecar check are untouched. Downgrades
 * and rung skips stay refused on both channels, and an OMITTED channel never
 * relaxes anything.
 */
export function assertLinearUpgrade(
	current: readonly number[],
	target: readonly number[],
	channel: InstallChannel = 'master',
): string | null {
	const order = compareVersionArrays(target, current);
	if (order === 0 && channel === 'dev') return null;
	if (order !== 1) return 'refusing a downgrade or same-version install';
	return versionSkipReason(current, target);
}

/**
 * The skip rules over a KNOWN-ascending pair (assertLinearUpgrade gates order
 * first) — the swap path's ONLY version gate, so it must be exact.
 *
 * The PATCH AXIS WAS NEVER CONSTRAINED: `cPatch` was not even destructured, so
 * `assertLinearUpgrade([7,0,0], [7,0,99999])` returned null and 7.0.0 → 7.0.3
 * installed in one hop, skipping every intervening rung's migrations. Nothing
 * else caught it — the sha is CLIENT-SUPPLIED and matches the genuinely
 * published sidecar of the skipped-to release, so a consumer pointed at a
 * master with several archives on disk could jump the queue.
 *
 * Now it asks ONE question, the same notion of "next rung" the manifest builds
 * from (code_manifest.ts upgradeRung): major+1.0.0, minor+1.0, or patch+1.
 */
function versionSkipReason(current: readonly number[], target: readonly number[]): string | null {
	const [cMajor = 0, cMinor = 0, cPatch = 0] = current;
	const [tMajor = 0, tMinor = 0, tPatch = 0] = target;
	if (isNextRung([cMajor, cMinor, cPatch], [tMajor, tMinor, tPatch])) return null;
	if (tMajor > cMajor) return 'major version skip is not allowed';
	if (tMinor <= cMinor) return 'patch version skip is not allowed';
	return tPatch !== 0 ? 'a minor/major bump must land on .0' : 'minor version skip is not allowed';
}

/** Is `target` the ONE rung above `current`: major+1.0.0, minor+1.0, or patch+1? */
function isNextRung(
	[cMajor, cMinor, cPatch]: readonly [number, number, number],
	[tMajor, tMinor, tPatch]: readonly [number, number, number],
): boolean {
	if (tMajor === cMajor + 1) return tMinor === 0 && tPatch === 0;
	if (tMajor !== cMajor) return false;
	if (tMinor === cMinor + 1) return tPatch === 0;
	return tMinor === cMinor && tPatch === cPatch + 1;
}

// ---------------------------------------------------------------------------
// The identity walk (RELEASE_IDENTITY_DESIGN §2.8 item 3, 2026-10-18)
// ---------------------------------------------------------------------------

/**
 * Why a walk is refused, as a MACHINE id — the CLI prints it, the panel
 * refusal carries it in its coordinates, the label catalog owns the sentence.
 *  - `downgrade_or_same_version`: the target's DATA triple is not above the
 *    running one (and the move is not a same-triple one, below);
 *  - `version_skip`: the target's triple is above, but not the next rung;
 *  - `not_newer_release`: the SAME data triple, and the target identity is not
 *    above the running one (beta.7 → beta.6, 7.0.0 → rc.1, the same identity).
 *    Its own id, never `downgrade_or_same_version`: deploy/dedalo-image-update.sh
 *    reads that one from an engine that predates this walk as BLIND (it saw
 *    rc.1 → 7.0.0 as 7.0.0 → 7.0.0) and re-asks the data walk — an informed
 *    refusal from this engine must never be re-asked away;
 *  - `channel_refused`: the target is a prerelease asked for on the release
 *    channel, or a developer build asked for off the dev channel;
 *  - `not_newest_of_rung`: another triple, and a newer identity of that rung is
 *    offered on the asker's channel (only decidable where the offer is known).
 */
export type WalkRefusal =
	| 'downgrade_or_same_version'
	| 'version_skip'
	| 'not_newer_release'
	| 'channel_refused'
	| 'not_newest_of_rung';

/** A refusal: its id and the operator sentence the swap door throws. */
export interface WalkVerdict {
	refusal: WalkRefusal;
	reason: string;
}

/**
 * THE IDENTITY WALK — may an install RUNNING `running` move to `target`?
 * Null when it may, else why not. Both are release identities (`X.Y.Z`,
 * `X.Y.Z-beta.N`, `X.Y.Z-dev`); a developer-build target is named by its
 * triple + `-dev` (what it calls itself is decided by its archive, so the walk
 * asks only what it is: a branch build of that triple). Garbage THROWS (the
 * comparator's RangeError) — every door validates its target first.
 *
 *  1. CHANNEL ADMISSION: a prerelease target needs the `prerelease` (or `dev`)
 *     channel, a developer build the `dev` channel. Not an authenticity guard
 *     (the channel rides the request) but the same opt-in the manifest applies:
 *     no door installs what the asker's channel would never have offered.
 *  2. THE SAME DATA TRIPLE crosses no migration, so it needs no rung:
 *      - a developer build is legal on the dev channel (the 2026-08-24
 *        exception: a branch build carries no version bump), the SAME
 *        identity included (`7.0.1-dev` → `7.0.1-dev`: a reinstall);
 *      - a RUNNING developer build, ON THE DEV CHANNEL, may move to any
 *        release of its own triple — the way back from a branch build to the
 *        release line (its identity names no point in the sequence). OFF the
 *        dev channel it is ordered as it is named (compareReleaseIdentities:
 *        above every prerelease of its triple, below its stable release):
 *        an install of a stable archive can
 *        resolve to `X.Y.Z-dev` without being a branch build (an unexpanded
 *        describe, a tag/version.ts disagreement, no tag evidence), and
 *        `7.0.1-dev → 7.0.1-beta.1` on the prerelease channel would install
 *        older code over data the 7.0.1 descriptor already migrated. The dev
 *        channel is the operator's explicit opt-in to leave the order;
 *      - otherwise the target must be a NEWER identity (semver §11:
 *        beta.6 → beta.7, beta.7 → rc.1 → 7.0.0; skipping betas is legal).
 *  3. ANOTHER TRIPLE: the data walk decides ({@link assertLinearUpgrade}: up,
 *     and the next rung only) — and, when the caller knows what is `offered`
 *     for that rung, the target must be its newest identity on the asker's
 *     channel ({@link newestOfRung}). Only the manifest knows the offer
 *     (code_manifest.ts rungItemsFor picks with the same function); no door
 *     holds the list, and a door asking a server for it would ask the very
 *     party the backstop distrusts.
 */
export function identityWalkRefusal(
	running: string,
	target: string,
	channel: InstallChannel = 'master',
	offered?: readonly string[],
): WalkVerdict | null {
	const from = requireIdentity(running);
	const to = requireIdentity(target);
	const admission = channelRefusal(to, channel);
	if (admission !== null) return admission;
	if (sameTriple(from, to)) return sameTripleRefusal(running, target, from, to, channel);
	return dataStepRefusal(from, to) ?? rungNewestRefusal(target, to, channel, offered);
}

/** Rule 3, first half: another triple is the data walk's (up, the next rung only). */
function dataStepRefusal(from: ParsedReleaseVersion, to: ParsedReleaseVersion): WalkVerdict | null {
	const data = assertLinearUpgrade(from.triple, to.triple);
	if (data === null) return null;
	const up = compareVersionArrays(to.triple, from.triple) === 1;
	return { refusal: up ? 'version_skip' : 'downgrade_or_same_version', reason: data };
}

/** Rule 3, second half: where the offer is known, the target is the rung's newest on the channel. */
function rungNewestRefusal(
	target: string,
	to: ParsedReleaseVersion,
	channel: InstallChannel,
	offered: readonly string[] | undefined,
): WalkVerdict | null {
	const newest = offered === undefined ? null : newestOfRung(offered, to.triple, channel);
	if (newest === null || compareReleaseIdentities(newest, target) === 0) return null;
	return {
		refusal: 'not_newest_of_rung',
		reason: `${target} is not the newest release of its version on this channel (${newest} is)`,
	};
}

/**
 * The newest identity of `triple` among `offered` that `channel` admits (a
 * stable release always; a prerelease on `prerelease`/`dev`; developer builds
 * are never "a release of the rung" and are ignored), or null when none.
 * A stable release outranks every prerelease of its triple, so a stable
 * asker can never be steered to a prerelease even when one is the newest
 * archive a master holds.
 */
export function newestOfRung(
	offered: readonly string[],
	triple: readonly number[],
	channel: InstallChannel = 'master',
): string | null {
	const admitted = offered.filter((identity) => releaseOfRung(identity, triple, channel));
	return admitted.reduce<string | null>(
		(newest, identity) =>
			newest === null || compareReleaseIdentities(identity, newest) > 0 ? identity : newest,
		null,
	);
}

/** Is `identity` a release (stable, or prerelease where `channel` admits it) of `triple`? */
function releaseOfRung(
	identity: string,
	triple: readonly number[],
	channel: InstallChannel,
): boolean {
	const parsed = parseReleaseVersion(identity);
	if (parsed === null || parsed.dev) return false;
	if (compareVersionArrays(parsed.triple, triple) !== 0) return false;
	return parsed.prerelease === null || channel !== 'master';
}

/** Rule 1: what the asker's channel admits. */
function channelRefusal(to: ParsedReleaseVersion, channel: InstallChannel): WalkVerdict | null {
	if (to.dev && channel !== 'dev') {
		return {
			refusal: 'channel_refused',
			reason: 'a developer build installs only on the developer channel',
		};
	}
	if (to.prerelease !== null && channel === 'master') {
		return {
			refusal: 'channel_refused',
			reason: 'a prerelease installs only on the prerelease (or developer) channel',
		};
	}
	return null;
}

/** Rule 2: the same data triple — no rung, only the release order. */
function sameTripleRefusal(
	running: string,
	target: string,
	from: ParsedReleaseVersion,
	to: ParsedReleaseVersion,
	channel: InstallChannel,
): WalkVerdict | null {
	// Never a downgrade, on any channel (owner decision, 2026-10-26). The order
	// decides: a dev build sits above its prereleases and below its stable, so a
	// developer install moves forward to the next release, never back to rc/beta.
	// The one same-identity move is a developer build reinstalled over itself on
	// the dev channel (the nightly is rebuilt in place, no version bump).
	if (compareReleaseIdentities(target, running) > 0) return null;
	if (channel === 'dev' && to.dev && from.dev && target === running) return null;
	return {
		refusal: 'not_newer_release',
		reason: `refusing a downgrade or same-version install: ${target} is not a newer release than the running ${running}`,
	};
}

function sameTriple(a: ParsedReleaseVersion, b: ParsedReleaseVersion): boolean {
	return compareVersionArrays(a.triple, b.triple) === 0;
}

function requireIdentity(version: string): ParsedReleaseVersion {
	const parsed = parseReleaseVersion(version);
	if (parsed === null) throw new RangeError(`not a release identity: '${version}'`);
	return parsed;
}

/** The identity walk verdict as an id only: null when `target` is a legal next step. */
export function walkRefusalOf(
	running: string,
	target: string,
	channel: InstallChannel = 'master',
): WalkRefusal | null {
	return identityWalkRefusal(running, target, channel)?.refusal ?? null;
}

// ---------------------------------------------------------------------------
// The image-tag face of the same rule (installer unification D3, 2026-10-09)
// ---------------------------------------------------------------------------

/** A parsed image tag: `X.Y.Z` (a release), `X.Y.Z-beta.N` (a prerelease) or `X.Y.Z-dev` (a developer image). */
export interface ImageTag {
	tag: string;
	/** `X.Y.Z` — the DATA version the tag names, without any suffix. */
	version: string;
	triple: [number, number, number];
	/**
	 * The release identity the tag names (release_identity.ts identityOfImageTag):
	 * `X.Y.Z`, `X.Y.Z-beta.N`, or `X.Y.Z-dev` for a `-dev` tag — what the
	 * identity walk is asked about.
	 */
	identity: string;
	/** The channel the tag is published on: `master`, `prerelease` or `dev`. */
	channel: InstallChannel;
}

/**
 * The image-tag grammar the engine walks: `X.Y.Z`, `X.Y.Z-(alpha|beta|rc).N`
 * or `X.Y.Z-dev`, canonical numbers of at most six digits. EXACTLY the host's
 * grammar (deploy/dedalo-image-lib.sh DEDALO_VERSION_RE = release_identity.ts
 * identityOfImageTag) since the identity walk (design step 9c): until then the
 * engine refused a prerelease tag as `malformed_version` and the host re-asked
 * the data walk as `X.Y.Z-dev` — which deploy/dedalo-image-update.sh still
 * does for an OLDER engine, the one that answers when it is the old image
 * being replaced.
 */
export const IMAGE_TAG_RE =
	/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(-dev|-(?:alpha|beta|rc)\.(?:0|[1-9]\d{0,5}))?$/;

/** Parse an image tag, or null when it is not one. */
export function parseImageTag(value: unknown): ImageTag | null {
	if (typeof value !== 'string') return null;
	const match = IMAGE_TAG_RE.exec(value);
	const identity = match === null ? null : identityOfImageTag(value);
	if (match === null || identity === null) return null;
	const triple: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
	return { tag: value, version: triple.join('.'), triple, identity, channel: tagChannel(match[4]) };
}

/** The channel a tag's suffix names: none = a release, `-dev` = a developer image, else a prerelease. */
function tagChannel(suffix: string | undefined): InstallChannel {
	if (suffix === undefined) return 'master';
	return suffix === '-dev' ? 'dev' : 'prerelease';
}
