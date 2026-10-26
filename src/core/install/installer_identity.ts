/**
 * THE INSTALLER'S RELEASE IDENTITY (design RELEASE_IDENTITY §2.4/§2.5, owner
 * answers Q1 and Q6, 2026-10-15) — what this installer calls itself, and the
 * three decisions of the Docker/trial routes that follow from it:
 *
 *  - the header and the System check name it (`7.0.0-beta.7 (prerelease)`),
 *    never the bare data version: a beta installer that says `7.0.0` cannot
 *    be told from the stable release (finding C3i-F1);
 *  - the image tag it installs is `imageTagOf(identity)` (host/stack/layout.ts):
 *    `7.0.0`, `7.0.0-beta.7`, or `7.0.0-dev` for an untagged build — a beta
 *    never asks for `:7.0.0`, which after the stable release is ANOTHER image;
 *  - Official is decided from the identity's KIND: a stable or prerelease
 *    identity names a published, signed image (the Review asks the registry,
 *    host/stack/preflight.ts); a DEV identity (an untagged checkout) names no
 *    release at all, so Official is refused from the identity itself — no
 *    registry is asked — and Build is the preselected source (Q6).
 *
 * The identity is the RUNNING tree's (`build_stamp.ts` RELEASE_IDENTITY): the
 * installer installs the checkout or release tree it runs from.
 */

import { processEnvValue } from '../../config/env.ts';
import { isTestProcess } from '../../config/suite_database.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { RELEASE_IDENTITY } from '../update/build_stamp.ts';
import {
	type ParsedReleaseVersion,
	parseReleaseVersion,
	type ReleaseIdentity,
	type ReleaseKind,
} from '../update/release_identity.ts';
import {
	compareVersionArrays,
	DEDALO_NEXT_DEV_TRIPLE,
	DEDALO_VERSION,
	DEDALO_VERSION_TRIPLE,
} from '../update/version.ts';

/** The test seam's key (src/config/catalog/install.ts). */
export const INSTALLER_IDENTITY_SEAM = 'DEDALO_INSTALL_RELEASE_IDENTITY';

/**
 * The identity this installer runs as: the running tree's, or — in a TEST
 * process only — the one DEDALO_INSTALL_RELEASE_IDENTITY names. Read per call
 * (no module state): a gate pins a kind for its file and restores it after.
 *
 * Why a seam at all: the identity is a fact about the checkout the suite runs
 * in (`.dev` on a working commit, the tag itself on a CI run of a release
 * tag), and the three decisions above differ per kind — an unpinned gate
 * would test whatever the machine's HEAD happens to be.
 *
 * Refused (never ignored) outside a test process, and refused when it is no
 * identity of THIS data version: a stray value can never make an installation
 * pull an image of another release.
 */
export function installerIdentity(): ReleaseIdentity {
	const pinned = processEnvValue('DEDALO_INSTALL_RELEASE_IDENTITY') ?? '';
	return pinned === '' ? RELEASE_IDENTITY : pinnedIdentity(pinned);
}

/**
 * A pin belongs to this data version: the next dev build (`X.Y.Z-dev` of the
 * declared next triple), or a release at or above the data triple (a code-only
 * patch runs on its minor's data).
 */
function belongsToDataVersion(parsed: ParsedReleaseVersion): boolean {
	if (parsed.dev) return compareVersionArrays(parsed.triple, DEDALO_NEXT_DEV_TRIPLE) === 0;
	return compareVersionArrays(parsed.triple, DEDALO_VERSION_TRIPLE) >= 0;
}

/** The seam's identity — refused outside a test process, or for another data version. */
function pinnedIdentity(pinned: string): ReleaseIdentity {
	if (!isTestProcess()) {
		throw seamRefused(
			`${INSTALLER_IDENTITY_SEAM} is a test seam — unset it: an installation runs as the release it is (${RELEASE_IDENTITY.version})`,
		);
	}
	const parsed = parseReleaseVersion(pinned);
	if (parsed === null || !belongsToDataVersion(parsed)) {
		throw seamRefused(
			`${INSTALLER_IDENTITY_SEAM}=${pinned} is not a release identity of this data version (${DEDALO_VERSION} or later, ${DEDALO_VERSION}-beta.N, or the next dev build ${DEDALO_NEXT_DEV_TRIPLE.join('.')}-dev)`,
		);
	}
	const kind = kindOf(parsed);
	return Object.freeze({
		version: pinned,
		kind,
		triple: parsed.triple,
		tag: kind === 'dev' ? null : `v${pinned}`,
		notice: null,
	});
}

function kindOf(parsed: ParsedReleaseVersion): ReleaseKind {
	if (parsed.dev) return 'dev';
	return parsed.prerelease === null ? 'stable' : 'prerelease';
}

function seamRefused(sentence: string): DedaloError {
	return new DedaloError('install.invalid_input', { message: sentence, publicMessage: sentence });
}

/**
 * How the installer names itself (the header, the welcome, the System check):
 * the identity, with its kind said for anything that is not a stable release.
 */
export function installerVersionLabel(identity: ReleaseIdentity = installerIdentity()): string {
	if (identity.kind === 'prerelease') return `${identity.version} (prerelease)`;
	if (identity.kind === 'dev') return `${identity.version} (development build)`;
	return identity.version;
}

/** The image source the Image screen preselects: Build for a dev identity (Q6), else Official. */
export function defaultImageSource(identity: ReleaseIdentity = installerIdentity()): string {
	return identity.kind === 'dev' ? 'build' : 'official';
}

/**
 * Why Official is refused for this identity WITHOUT asking any registry, or
 * null when the registry decides (stable, prerelease). A dev identity names no
 * release: no official image is its bytes (a published `-dev` image is the dev
 * BRANCH's head, mutable, not this checkout — design §2.5: no `-dev` escape).
 */
export function officialRefusedFor(identity: ReleaseIdentity = installerIdentity()): string | null {
	if (identity.kind !== 'dev') return null;
	return `this installer is a development build (${identity.version}: its commit carries no release tag), so no official image is its code — choose Build on the Image screen (--image-source build), or a registry of your own (Custom, --image-source custom)`;
}
