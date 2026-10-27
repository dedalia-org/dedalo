/**
 * THE IMAGE'S IDENTITY, CHECKED (terminal installer phase 4, 2026-10-12) — the
 * TypeScript twin of deploy/dedalo-image-lib.sh's dedalo_repo_digest /
 * dedalo_cosign_verify / dedalo_verify_release, over the same docker and
 * cosign commands:
 *
 *  - THE SIGNATURE (official repositories): `cosign verify` of
 *    <repository>@<the digest the PULLED image carries for that repository>,
 *    against the signing identity of engineering/image_registries.json (the
 *    bundled list — never a value from the environment);
 *  - THE VERSION: the signed image's `org.opencontainers.image.version` label
 *    must equal the tag it was pulled as — a signature alone proves only that
 *    SOME official run built the bytes, and a registry whose tag pointers
 *    someone else controls could name an older signed release `:<newer>`;
 *  - THE PIN (critique A16): the verified digest is recorded, and before the
 *    engine runs in the image and before the stack starts, the local tag must
 *    STILL resolve to it (a re-pull between verify and run is refused).
 *
 * All read-only; the commands depend on what the pull brought (the digest),
 * so they are the step's CHECKS, run after its listed commands.
 */

import { loadImageRegistries, normalizeRepository } from '../../../update/image_registries.ts';
import { ABORT_AND_START_AGAIN } from '../../step_loop.ts';
import type { ExecCommand, HostCtx, HostPlanCtx } from '../contract.ts';
import { probeText } from '../production/common.ts';
import { hostRefuse } from '../refuse.ts';
import type { CommandRunner, RunResult } from '../runner.ts';
import type { StackImage } from '../state_types.ts';
import { execute, stackCreated } from './common.ts';
import { dockerProbe, stackExec } from './compose.ts';
import { stackFactsOf } from './facts.ts';
import {
	imageRefOf,
	imageRepositoryOf,
	imageVerifyOf,
	imageVersionOf,
	VERSION_LABEL,
} from './layout.ts';

/** The image is present locally under its tag. */
export function imagePresentProbe(ctx: HostPlanCtx): ExecCommand {
	return dockerProbe(
		ctx,
		['image', 'inspect', '--format', '{{.Id}}', imageRefOf(ctx.answers)],
		'the image is present',
	);
}

/** The version label of the local image. */
export function versionLabelProbe(ctx: HostPlanCtx): ExecCommand {
	return dockerProbe(
		ctx,
		[
			'image',
			'inspect',
			'--format',
			`{{index .Config.Labels "${VERSION_LABEL}"}}`,
			imageRefOf(ctx.answers),
		],
		'the image declares its version',
	);
}

/** The registry digests the local image is known by. */
export function repoDigestsProbe(ctx: HostPlanCtx): ExecCommand {
	return dockerProbe(
		ctx,
		[
			'image',
			'inspect',
			'--format',
			'{{range .RepoDigests}}{{println .}}{{end}}',
			imageRefOf(ctx.answers),
		],
		'the registry digest of the pulled image',
	);
}

/**
 * `cosign verify` of `target` against the official signing identity. `target` is
 * `<repository>@<digest>` (the digest the image is verified by) or, when the Review
 * could not name the digest, `<repository>:<tag>` (the label says the digest is
 * pinned at pull instead). The identity and issuer are the same in every form.
 */
export function cosignCommand(
	ctx: HostPlanCtx,
	target: string,
	label = "verify Dédalo's signature on the pulled digest",
): ExecCommand {
	const { signing } = loadImageRegistries();
	return stackExec(
		ctx,
		[
			stackFactsOf(ctx).cosign ?? '/usr/local/bin/cosign',
			'verify',
			'--certificate-identity-regexp',
			signing.identity_regexp,
			'--certificate-oidc-issuer',
			signing.issuer,
			target,
		],
		label,
		{ mutates: false, timeoutMs: 300_000 },
	);
}

/**
 * The index digest the registry names for `ref` (`docker buildx imagetools inspect`
 * prints it as its `Digest:` line — the digest a multi-arch image is signed by, the
 * one `RepoDigests` holds after a pull). Read-only, bounded like the probes;
 * null when the registry was not asked or did not name one. Used by the Review
 * only: the run verifies the digest the pull actually brings (verifyImage).
 */
export async function registryDigestOf(
	runner: CommandRunner,
	docker: string,
	ref: string,
	home: string,
): Promise<string | null> {
	try {
		const result = await runner.run({
			argv: [docker, 'buildx', 'imagetools', 'inspect', ref],
			env: { HOME: home },
			timeoutMs: IMAGE_PROBE_TIMEOUT_MS,
		});
		if (result.exitCode !== 0 || result.timedOut) return null;
		const named = /^Digest:\s*(sha256:[0-9a-f]{64})\s*$/m.exec(result.stdout);
		return named?.[1] ?? null;
	} catch {
		return null;
	}
}

/** The digests (sha256:…) the local image carries for ITS repository. */
export async function localDigests(ctx: HostCtx): Promise<string[]> {
	const wanted = normalizeRepository(imageRepositoryOf(ctx.answers));
	return (await probeText(ctx, repoDigestsProbe(ctx)))
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => normalizeRepository(line.slice(0, line.lastIndexOf('@'))) === wanted)
		.map((line) => line.slice(line.lastIndexOf('@') + 1))
		.filter((digest) => /^sha256:[0-9a-f]{64}$/.test(digest));
}

/** The version label must equal the tag (an official image: required; a custom one: when it has one). */
async function checkVersionLabel(ctx: HostCtx, official: boolean): Promise<void> {
	const declared = (await probeText(ctx, versionLabelProbe(ctx))).trim();
	const version = imageVersionOf(ctx.answers);
	if (declared === version || (!official && declared === '')) return;
	hostRefuse(
		'install.step_failed',
		`${imageRefOf(ctx.answers)} declares version '${declared || 'none'}', not ${version} — the tag does not name the image it should (refused)`,
	);
}

/** The signature over the ONE digest the pulled image carries; answers that digest. */
async function checkSignature(ctx: HostCtx): Promise<string> {
	const digests = await localDigests(ctx);
	const digest = digests[0];
	if (digest === undefined || digests.length !== 1) {
		hostRefuse(
			'install.step_failed',
			`${imageRefOf(ctx.answers)} carries ${digests.length} registry digests for its repository — exactly one is required to verify it`,
		);
	}
	await execute(ctx, cosignCommand(ctx, `${imageRepositoryOf(ctx.answers)}@${digest}`), (result) =>
		hostRefuse(
			'install.step_failed',
			`${imageRepositoryOf(ctx.answers)}@${digest} does NOT carry Dédalo's signature (cosign exit ${result.exitCode}) — refused`,
		),
	);
	return digest as string;
}

/** Verify the pulled (or built) image; answers the record stack_image keeps. */
export async function verifyImage(ctx: HostCtx): Promise<StackImage> {
	const verify = imageVerifyOf(ctx.answers);
	if (ctx.answers.image_source !== 'build') await checkVersionLabel(ctx, verify === 'cosign');
	const digest = verify === 'cosign' ? await checkSignature(ctx) : null;
	return {
		repository: imageRepositoryOf(ctx.answers),
		version: imageVersionOf(ctx.answers),
		digest,
		verify,
	};
}

/** Does the local tag still resolve to the verified digest (or need none)? */
export async function pinHolds(ctx: HostCtx): Promise<boolean> {
	const image = stackCreated(ctx).image;
	if (image === null) return false;
	if (image.digest === null) return true;
	return (await localDigests(ctx)).includes(image.digest);
}

/** Refuse when the local tag no longer resolves to the verified digest (critique A16). */
export async function assertPinnedImage(ctx: HostCtx): Promise<void> {
	if (await pinHolds(ctx)) return;
	hostRefuse(
		'install.state_conflict',
		`${imageRefOf(ctx.answers)} no longer resolves to the image this install verified — it was re-pulled or removed: pull the verified digest (${stackCreated(ctx).image?.digest ?? 'see the install record'}) back, then --resume; ${ABORT_AND_START_AGAIN}`,
	);
}

// ── is the official image of this version PUBLISHED? (asked before `yes`) ────

/**
 * Whether the registry holds `<official repository>:<version>`, asked BEFORE
 * `yes` (beta.6 fix, owner 2026-10-15): an operator who took the defaults while
 * the official image of this release was not published failed at stack_image,
 * after `yes`. `<version>` is the installer's release identity's tag (a beta
 * asks for `:7.0.0-beta.N` — design RELEASE_IDENTITY §2.5); a development
 * build is refused before this is ever asked (preflight.ts officialImageVerdict). The TypeScript twin of deploy/dedalo-image-lib.sh's
 * dedalo_image_available: `docker manifest inspect` first, then `docker buildx
 * imagetools inspect`; READ-ONLY (nothing is pulled), as the operator (their
 * HOME: the registry logins `docker pull` will use).
 *
 *  - published: either answered;
 *  - absent: the registry SAID so — no such manifest / manifest unknown / not
 *    found, or `denied` / `unauthorized` (ghcr answers `denied` for a
 *    repository nobody may pull anonymously: the pull would fail the same way);
 *  - unknown: anything else (offline, a proxy, no buildx, a timeout) — never a
 *    refusal: stack_image's pull says what happened.
 *
 * BOUNDED (campaign C3i-F2: an unreachable registry froze the Review ~2 min,
 * each probe waiting for docker's own network timeout): each probe is killed
 * after IMAGE_PROBE_TIMEOUT_MS, and a probe that timed out ends the asking
 * (the second would wait the same) — the outcome is `unknown`, never
 * `absent`. What an `unknown` says is a plain sentence (unknownReason); the
 * raw docker words go to the install log only (`detail`).
 */
export type ImageAvailability = 'published' | 'absent' | 'unknown';

/** A registry saying the reference is not there (or not pullable by this operator). */
const REGISTRY_SAYS_ABSENT =
	/no such manifest|manifest unknown|: not found\s*$|\bdenied\b|\bunauthorized\b/im;

/** Not the registry speaking: a local tool failure whose words could read as "absent". */
const LOCAL_FAILURE =
	/error getting credentials|executable file not found|is not a docker command/i;

/** How long one registry probe may take before it is killed (the Review waits at most this, per probe). */
export const IMAGE_PROBE_TIMEOUT_MS = 15_000;

/** docker's words for a registry it could not reach (DNS, connection, its own network timeout). */
const UNREACHABLE =
	/no such host|server misbehaving|dial tcp|connection refused|connection reset|no route to host|network is unreachable|i\/o timeout|tls handshake timeout|deadline exceeded|context canceled/i;

/** The two read-only probes, in order (the argv the gates fake). */
export function imageAvailabilityProbes(docker: string, ref: string): string[][] {
	return [
		[docker, 'manifest', 'inspect', ref],
		[docker, 'buildx', 'imagetools', 'inspect', ref],
	];
}

/** Did this probe's output come from a registry saying the reference is absent? */
export function registrySaysAbsent(said: string): boolean {
	return REGISTRY_SAYS_ABSENT.test(said) && !LOCAL_FAILURE.test(said);
}

/** The probe's last words, one short line (what the Review quotes). */
function lastWords(result: RunResult): string {
	const text = `${result.stderr}\n${result.stdout}`.trim();
	const line =
		text
			.split('\n')
			.filter((item) => item.trim() !== '')
			.at(-1) ?? '';
	return line.trim().slice(0, 160);
}

/** One probe's answer: did it find the image, did it time out, and its last words. */
interface RegistryAnswer {
	found: boolean;
	timedOut: boolean;
	words: string;
}

/** Run one probe, bounded (a runner that throws — no such binary — answered nothing). */
async function askRegistry(
	runner: CommandRunner,
	argv: string[],
	home: string,
): Promise<RegistryAnswer> {
	try {
		const result = await runner.run({
			argv,
			env: { HOME: home },
			timeoutMs: IMAGE_PROBE_TIMEOUT_MS,
		});
		return {
			found: result.exitCode === 0 && !result.timedOut,
			timedOut: result.timedOut,
			words: lastWords(result),
		};
	} catch {
		return { found: false, timedOut: false, words: '' };
	}
}

/** The registry host of an image reference (Docker Hub when the first part names none). */
export function registryHostOf(ref: string): string {
	const first = ref.split('/')[0] ?? '';
	return ref.includes('/') && (/[.:]/.test(first) || first === 'localhost') ? first : 'docker.io';
}

/** Why the registry could not be asked, in plain words (never docker's raw error). */
export function unknownReason(answers: readonly RegistryAnswer[], ref: string): string {
	if (answers.some((answer) => answer.timedOut)) {
		return `the registry did not answer within ${IMAGE_PROBE_TIMEOUT_MS / 1000} s`;
	}
	if (answers.some((answer) => UNREACHABLE.test(answer.words))) {
		return `could not reach ${registryHostOf(ref)}`;
	}
	if (answers.some((answer) => answer.words !== '')) return 'docker could not ask the registry';
	return 'the registry did not answer';
}

/** One probe's raw outcome, as the install log keeps it. */
function rawWords(answer: RegistryAnswer): string {
	if (!answer.timedOut) return answer.words === '' ? 'no answer' : answer.words;
	return `killed after ${IMAGE_PROBE_TIMEOUT_MS / 1000} s${answer.words === '' ? '' : ` (${answer.words})`}`;
}

/** What the probes answered: the verdict, what the Review says, and docker's raw words (the log's). */
export interface ImageProbeOutcome {
	availability: ImageAvailability;
	/** absent: the registry's words; unknown: a plain sentence (unknownReason); published: ''. */
	said: string;
	/** docker's own last words ('' when published) — for the install log, never the screen. */
	detail: string;
}

/** The verdict of the probes' answers: published by either; absent when a registry SAID so; else unknown. */
export function availabilityOf(answers: readonly RegistryAnswer[], ref: string): ImageProbeOutcome {
	if (answers.some((answer) => answer.found)) {
		return { availability: 'published', said: '', detail: '' };
	}
	// A probe killed at the bound never counts as the registry speaking.
	const absent = answers.find((answer) => !answer.timedOut && registrySaysAbsent(answer.words));
	if (absent !== undefined) {
		return { availability: 'absent', said: absent.words, detail: absent.words };
	}
	return {
		availability: 'unknown',
		said: unknownReason(answers, ref),
		detail: answers.map(rawWords).join(' | '),
	};
}

/** Ask the registry (see ImageAvailability), each probe bounded; a timeout ends the asking. */
export async function probeImageAvailability(
	runner: CommandRunner,
	docker: string,
	ref: string,
	home: string,
): Promise<ImageProbeOutcome> {
	const answers: RegistryAnswer[] = [];
	for (const argv of imageAvailabilityProbes(docker, ref)) {
		const answer = await askRegistry(runner, argv, home);
		answers.push(answer);
		if (answer.found || answer.timedOut) break;
	}
	return availabilityOf(answers, ref);
}
