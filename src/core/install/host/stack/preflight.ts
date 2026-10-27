/**
 * stack_preflight — THE SYSTEM CHECK OF A DOCKER / TRIAL RUN (terminal
 * installer phase 4, 2026-10-12). Measures the operator's machine
 * (stack/facts.ts) and REFUSES, before anything is pulled or written,
 * everything the later steps would trip on:
 *
 *  - no Docker, a daemon this operator cannot reach, no Compose v2 — TOLD how
 *    to fix, never fixed (owner question Q5: the installer does not install
 *    Docker or change group membership);
 *  - under 8 GiB free under Docker's root (measured on a clean Ubuntu 26.04:
 *    the engine image ~2.5 GB, postgres ~0.7 GB, a local build parks ~3 GB of
 *    cache; below it the seed restore dies with "No space left on device") —
 *    a root that cannot be measured (a VM, a remote daemon) skips the check;
 *  - an instance already here (the `dedalo_private` volume: the seed restore
 *    needs an empty database, so a second install is never a repair), or the
 *    stack files of an earlier install (.dedalo.env, compose.override.yaml);
 *  - an image version other than this installer's (Q7), an "official" image
 *    from a repository the official list does not name, an official image
 *    without cosign to verify it (critique A16 — use a local build instead, or
 *    install cosign);
 *  - the institution's certificate files (address, expiry, key) — and that
 *    THIS machine trusts their chain (tls_trust.ts: stack_health probes the
 *    site with this machine's curl; campaign 3 C3-13);
 *  - a local CA already in deploy/certs that cannot serve the answered
 *    addresses (host/tls_authority.ts — stack_tls would skip its issue);
 *  - Compose older than 2.24.4 (the override's `!override` tag).
 *  - a port the stack publishes that something already listens on (`ss`;
 *    campaign 3c D2 — found at stack_up, after the build, before);
 *  - an official image that is not published for this release identity
 *    (officialImageVerdict: the registry asked for a stable or prerelease
 *    identity — not checkable offline: said, not refused; a development build
 *    refused from its identity alone, no registry asked).
 *
 * Then FREEZES the facts and the digest of every stack step's commands in the
 * state file, as host_preflight does: what the rest of the run, and any
 * resume, executes. It creates nothing (no undo); done once, a resume skips it.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { installerIdentity, officialRefusedFor } from '../../installer_identity.ts';
import type { HostCtx, HostPlanCtx, HostRunResult, HostStepDefinition } from '../contract.ts';
import { type HostFacts, pendingFacts } from '../facts.ts';
import { ran } from '../production/common.ts';
import { hostRefuse } from '../refuse.ts';
import { checkCertificateFiles } from '../tls_files.ts';
import { chainTrustVerdict, SYSTEM_CA_BUNDLES } from '../tls_trust.ts';
import { inCheckout } from './common.ts';
import { gatherStackFacts, type StackFacts } from './facts.ts';
import { type ImageProbeOutcome, probeImageAvailability } from './image_verify.ts';
import {
	acceptedImageVersions,
	ENV_FILE,
	imageRefOf,
	imageRepositoryOf,
	imageVerifyOf,
	imageVersionOf,
	isOfficialRepository,
	OVERRIDE_FILE,
	PRIVATE_VOLUME,
	stackFileOf,
} from './layout.ts';
import { stackAuthorityConflict } from './tls.ts';

/** The disk floor (see the header). */
export const STACK_MIN_FREE_GIB = 8;

/**
 * The oldest Compose the stack runs on: the installer's compose.override.yaml
 * replaces the trial nginx's ports and volumes with the `!override` tag, which
 * Compose understands from 2.24.4 (an older one refuses the file).
 */
export const MIN_COMPOSE: readonly number[] = Object.freeze([2, 24, 4]);

/** Is `version` (`2.39.1`, `5.0.0-desktop.1`) at least `minimum`? null: no Compose. */
export function composeAtLeast(version: string | null, minimum: readonly number[]): boolean {
	const parts = (version ?? '').split(/[.-]/).map((part) => Number.parseInt(part, 10));
	for (const [index, wanted] of minimum.entries()) {
		const have = Number.isNaN(parts[index] ?? Number.NaN) ? -1 : (parts[index] as number);
		if (have !== wanted) return have > wanted;
	}
	return true;
}

/** The operator as a sentence names them. */
function who(facts: StackFacts): string {
	return facts.user === '' ? 'this user' : facts.user;
}

/**
 * THE MACHINE CHECKS, one sentence (or null) each — exported because the
 * interactive System check (probes.ts stackRows) shows them as rows BEFORE the
 * run, over the same facts (gatherStackFacts): one wording, one rule, never a
 * second copy. The preflight below refuses with the same sentences.
 */
export const STACK_MACHINE_CHECKS = Object.freeze({
	/** Docker itself is installed. */
	docker: (facts: StackFacts): string | null =>
		facts.docker === null
			? 'Docker is not installed — install Docker Engine and its Compose plugin (https://docs.docker.com/engine/install/), then run this again; the installer never installs it'
			: null,
	/** The daemon answers this operator. */
	daemon: (facts: StackFacts): string | null =>
		facts.daemon
			? null
			: `the Docker daemon does not answer ${who(facts)} — start it (sudo systemctl enable --now docker) or join the docker group (sudo usermod -aG docker ${who(facts)}, then log in again); DOCKER_HOST is not passed through: use a docker context`,
	/** Compose 2.24.4 or newer (the installer's override uses `!override`). */
	compose: (facts: StackFacts): string | null =>
		composeAtLeast(facts.composeVersion, MIN_COMPOSE)
			? null
			: `Docker Compose ${MIN_COMPOSE.join('.')} or newer is required (the \`docker compose\` plugin, not the old docker-compose)${facts.composeVersion === null ? '' : ` — this machine has ${facts.composeVersion}`}`,
	/** The disk floor (a root that cannot be measured skips it — see the header). */
	disk: (facts: StackFacts): string | null => {
		const free = facts.freeGib ?? STACK_MIN_FREE_GIB;
		return free < STACK_MIN_FREE_GIB
			? `only ${free} GiB free under ${facts.dockerRoot} — the install needs about ${STACK_MIN_FREE_GIB} GiB (docker system prune -af, or move Docker's root to a bigger disk)`
			: null;
	},
	/**
	 * cosign is installed — the official image's signature is checked with it. Not
	 * every route needs it (a build or a registry of your own does not), so the
	 * System check shows it as a warning row, and the preflight refuses only an
	 * official pull without it (imageProblems).
	 */
	cosign: (facts: StackFacts): string | null =>
		facts.cosign === null
			? "cosign is not installed — Dédalo's image signature is checked with it: install cosign (https://docs.sigstore.dev/cosign/system_config/installation/), or choose Build for a local image"
			: null,
	/** The operator's identity is known. */
	operator: (facts: StackFacts): string | null =>
		knownOperator(facts)
			? null
			: 'the operator cannot be identified (`id -un` / `id -u` answered nothing) — run the install as a user with a login on this machine',
});

/** The sentences of `checks` that fail on `facts`. */
function failing(
	facts: StackFacts,
	checks: readonly (keyof typeof STACK_MACHINE_CHECKS)[],
): string[] {
	return checks
		.map((check) => STACK_MACHINE_CHECKS[check](facts))
		.filter((sentence): sentence is string => sentence !== null);
}

/** Docker itself: present, reachable, Compose v2 (not installed: that one sentence alone). */
function dockerProblems(facts: StackFacts): string[] {
	return facts.docker === null ? failing(facts, ['docker']) : failing(facts, ['daemon', 'compose']);
}

/**
 * Is the operator's identity known — `id -un` and `id -u` answered? Through
 * `id`, never /etc/passwd: macOS keeps its accounts in Directory Services and
 * an LDAP/SSSD account is not in /etc/passwd either, and both are operators
 * the route supports. The files the install writes need no lookup by name for
 * them (host/fs.ts ownerIds: an unprivileged process writing as ITSELF).
 */
function knownOperator(facts: StackFacts): boolean {
	return facts.user !== '' && facts.uid >= 0;
}

/** Disk and the operator's identity. */
function machineProblems(facts: StackFacts): string[] {
	return failing(facts, ['disk', 'operator']);
}

/** An instance, or an earlier install's stack files, already here. */
function instanceProblems(ctx: HostCtx, facts: StackFacts): string[] {
	const stack = stackFileOf(ctx.answers);
	return [
		...(existsSync(join(ctx.source, stack))
			? []
			: [`${stack} is not in ${ctx.source} — run the installer from a Dédalo checkout`]),
		...(facts.volumes.includes(PRIVATE_VOLUME)
			? [
					`this machine already has a Dédalo instance (volume ${PRIVATE_VOLUME}) — the seed restore needs an empty database: keep that instance, or destroy it first (docker compose -f ${stack} --env-file ${ENV_FILE} down -v)`,
				]
			: []),
		...[ENV_FILE, OVERRIDE_FILE]
			.filter((name) => ctx.fs.exists(inCheckout(ctx, name)))
			.map(
				(name) =>
					`${inCheckout(ctx, name)} is from an earlier install — remove it (or keep that instance) and run this again`,
			),
	];
}

/** The image: this installer's version, an official repository that is one, cosign to verify it. */
function imageProblems(ctx: HostPlanCtx, facts: StackFacts): string[] {
	const { answers } = ctx;
	const version = imageVersionOf(answers);
	const repository = imageRepositoryOf(answers);
	return [
		...(acceptedImageVersions().includes(version)
			? []
			: [
					`image version ${version} is not this installer's (${acceptedImageVersions().join(' or ')}) — the engine steps run inside the image with this installer's request format; use the matching release of the installer`,
				]),
		...(answers.image_source === 'official' && !isOfficialRepository(repository)
			? [
					`${repository} is not an official Dédalo registry — use --image-source custom for a registry of your own`,
				]
			: []),
		...(imageVerifyOf(answers) === 'cosign' && facts.cosign === null
			? [
					`cosign is not installed, so the signature of ${repository} cannot be verified — install cosign (https://docs.sigstore.dev/cosign/system_config/installation/) or build the image here (--image-source build)`,
				]
			: []),
	];
}

/**
 * Is the OFFICIAL image of this release published (image_verify.ts
 * probeImageAvailability)? Decided by the installer's RELEASE IDENTITY
 * (installer_identity.ts, design §2.5, owner Q1/Q6):
 *  - a stable or prerelease identity: the registry is asked for
 *    `:<imageTagOf(identity)>` (`:7.0.0`, `:7.0.0-beta.7` — a beta never asks
 *    for `:7.0.0`). Absent (e.g. the tag is pushed and its image not yet
 *    approved for publication): a refusal (the Review does not offer install,
 *    the answers are kept); not checkable (offline…): a line on the Review,
 *    never a refusal — in plain words; docker's raw error goes to the install
 *    log (`ctx.say`) only (C3i-F3).
 *  - a dev identity (an untagged checkout): refused from the identity itself —
 *    NO registry is asked: no published image is this commit's code.
 * Only an `official` source naming an official repository is decided here — a
 * build or a registry of the operator's own is never probed (beta.6 fix: the
 * default source failed at stack_image, after `yes`).
 *
 * Bounded and said (campaign C3i-F2): the probe is bounded (image_verify.ts
 * IMAGE_PROBE_TIMEOUT_MS), a `checking the official image …` line is said
 * BEFORE it runs, and within one Review build it runs ONCE (`measure`: the
 * session's scope, shared by the TO-DO block and the refusals — a new build
 * gets a new scope and probes again).
 */
export async function officialImageVerdict(
	ctx: VerdictCtx,
	facts: StackFacts,
): Promise<{ problems: string[]; warnings: string[] }> {
	const { answers } = ctx;
	if (!decidesOfficial(answers)) return { problems: [], warnings: [] };
	// The identity alone decides a dev build: no registry is asked.
	const refused = officialRefusedFor(installerIdentity());
	if (refused !== null) return { problems: [refused], warnings: [] };
	if (facts.docker === null || !acceptedImageVersions().includes(imageVersionOf(answers)))
		return { problems: [], warnings: [] };
	return registryVerdict(ctx, facts.docker, facts.home);
}

/** The registry's answer for the official image of this release, in the Review's words. */
async function registryVerdict(
	ctx: VerdictCtx,
	docker: string,
	home: string,
): Promise<{ problems: string[]; warnings: string[] }> {
	const ref = imageRefOf(ctx.answers);
	const { availability, said, detail } = await measuredAvailability(ctx, docker, ref, home);
	if (availability === 'unknown')
		ctx.say?.(`    ${ref} could not be checked — docker said: ${detail}`);
	return {
		problems:
			availability === 'absent' ? [imageNotPublished(ref, imageVersionOf(ctx.answers), said)] : [],
		warnings: availability === 'unknown' ? [imageNotChecked(ref, said)] : [],
	};
}

/** What officialImageVerdict runs with: the Review's scope (`measure`) or the run's transcript (`say`). */
type VerdictCtx = Pick<HostCtx, 'answers' | 'runner'> & Partial<Pick<HostCtx, 'say' | 'measure'>>;

/** The probe, its `checking` line said first — once per Review build when a scope is given. */
function measuredAvailability(
	ctx: VerdictCtx,
	docker: string,
	ref: string,
	home: string,
): Promise<ImageProbeOutcome> {
	const { measure } = ctx;
	const progress = measure?.say ?? ctx.say ?? (() => {});
	const probe = async (): Promise<ImageProbeOutcome> => {
		progress(imageCheckingLine(ref));
		const outcome = await probeImageAvailability(ctx.runner, docker, ref, home);
		if (outcome.availability === 'published') progress(imagePublishedLine(ref));
		return outcome;
	};
	return measure === undefined ? probe() : measure.once(`official-image ${ref}`, probe);
}

/** The progress line said while the registry is asked (a `checking` line: the running mark). */
export function imageCheckingLine(ref: string): string {
	return `checking the official image ${ref}…`;
}

/** The progress line said when the registry answers that the image is published (the run's visible success). */
export function imagePublishedLine(ref: string): string {
	return `${ref} is published`;
}

/** Is the official image decided here: an `official` source naming an official repository? */
function decidesOfficial(answers: HostPlanCtx['answers']): boolean {
	return answers.image_source === 'official' && isOfficialRepository(imageRepositoryOf(answers));
}

/**
 * The refusal: no official image of the asked tag. Two different absences: the
 * identity's own tag (a release whose image is not published yet — it will be),
 * and an explicit `X.Y.Z-dev` tag (the dev BRANCH's mutable head, which no
 * release tag ever publishes — telling the operator to wait would be false).
 */
function imageNotPublished(ref: string, version: string, said: string): string {
	const choose =
		'choose Build on the Image screen (--image-source build), or a registry of your own (Custom, --image-source custom)';
	if (version.endsWith('-dev'))
		return `no official image ${ref} is published (the registry answered: ${said}) — a \`-dev\` image is the development branch's own, published by no release tag, so waiting will not bring it: ${choose}`;
	return `no official image ${ref} is published for this release yet (the registry answered: ${said}) — an official image appears once its release (stable or prerelease) is published, which can follow the release tag by a while: ${choose}`;
}

/** The Review line: the registry could not be asked. */
function imageNotChecked(ref: string, said: string): string {
	return `whether the official image ${ref} is published could not be checked (${said}) — stack_image pulls it and says so if it is not there; to install without the registry, choose Build (--image-source build)`;
}

/**
 * The institution's own certificate, checked before it is copied — by the
 * preflight (a refusal), and on the Review (campaign 3b N8: an untrusted chain
 * was accepted by the TLS screen and the Review and refused only after `yes`,
 * every answer lost; the Review now lists it under TO DO, before `yes`).
 */
export function stackTlsVerdict(
	answers: HostPlanCtx['answers'],
	fs: Pick<HostCtx['fs'], 'readText'>,
	now: number,
): { problems: string[]; warnings: string[] } {
	if (answers.route !== 'docker' || answers.tls_mode !== 'files') {
		return { problems: [], warnings: [] };
	}
	const fullchain = fs.readText(answers.tls_cert_path);
	const verdict = checkCertificateFiles(
		fullchain,
		fs.readText(answers.tls_key_path),
		answers.server_name,
		now,
	);
	// The install's last step probes the site with THIS machine's curl (C3-13).
	const trust = chainTrustVerdict(
		fullchain,
		SYSTEM_CA_BUNDLES.map((path) => fs.readText(path)),
	);
	return {
		problems: [...verdict.problems, ...(trust.problem === null ? [] : [trust.problem])].map(
			(problem) => `${answers.tls_cert_path}: ${problem}`,
		),
		warnings: [...verdict.warnings, ...(trust.warning === null ? [] : [trust.warning])],
	};
}

/** The Review's TO DO lines of a stack plan: the institution certificate's problems and warnings. */
export function stackReviewTodo(
	ctx: HostPlanCtx,
	fs: Pick<HostCtx['fs'], 'readText'>,
	now: number,
): string[] {
	const { problems, warnings } = stackTlsVerdict(ctx.answers, fs, now);
	return [
		...problems,
		...warnings.map((line) => `certificate ${ctx.answers.tls_cert_path}: ${line}`),
	];
}

/** The host ports the stack publishes (the trial serves plain HTTP only). */
function publishedPorts(answers: HostPlanCtx['answers']): string[] {
	return answers.route === 'trial' ? [answers.http_port] : [answers.http_port, answers.https_port];
}

/**
 * A published port something already listens on (campaign 3c D2: a held 443
 * passed every check and failed at stack_up, after the image was built). Not
 * measurable (no `ss`): nothing said — stack_up's own error names it.
 */
export function portProblems(answers: HostPlanCtx['answers'], facts: StackFacts): string[] {
	const listening = facts.listening ?? [];
	return [...new Set(publishedPorts(answers))]
		.map((port) => ({ port, holder: listening.find((item) => item.port === port) }))
		.filter((item) => item.holder !== undefined)
		.map(
			({ port, holder }) =>
				`port ${port} is already in use${holder?.process === 'unknown' ? '' : ` by ${holder?.process}`} — the stack publishes it: stop that program, or choose another port (Containers screen, --http-port / --https-port)`,
		);
}

/** Refuse with every problem, joined (the operator fixes them all in one pass). */
function refuseAll(problems: readonly string[]): void {
	if (problems.length > 0) hostRefuse('install.state_conflict', problems.join('; '));
}

/**
 * The facts of a docker/trial plan: no host facts, the stack's — and whether
 * the source is a git checkout, which picks stack_image's builder (the shared
 * clean-snapshot builder for a checkout, a plain build of a release tree).
 * Campaign 3b N1: this was left at the pending `false` on the stack routes, so
 * every install-time build took the working tree as it was (`X.Y.Z.dev`,
 * uncommitted files included). ONE function for the run, its frozen digest and
 * the Review.
 */
export function stackPlanFacts(stack: StackFacts, source: string): HostFacts {
	return { ...pendingFacts(), sourceIsGit: existsSync(join(source, '.git')), stack };
}

/** The facts a plan context carries once they are frozen. */
function withFacts(ctx: HostCtx, facts: StackFacts): HostPlanCtx {
	return { ...ctx, facts: stackPlanFacts(facts, ctx.source) };
}

/** The measured machine's refusals (each sentence once) and warnings — read-only. */
async function evaluateStack(
	ctx: HostCtx,
): Promise<{ facts: StackFacts; problems: string[]; warnings: string[] }> {
	const facts = await gatherStackFacts(ctx.runner, ctx.fs);
	const docker = dockerProblems(facts);
	if (docker.length > 0) return { facts, problems: docker, warnings: [] };
	const tls = stackTlsVerdict(ctx.answers, ctx.fs, ctx.now());
	const published = await officialImageVerdict(ctx, facts);
	const problems = [
		...machineProblems(facts),
		...instanceProblems(ctx, facts),
		...imageProblems(withFacts(ctx, facts), facts),
		...published.problems,
		...portProblems(ctx.answers, facts),
		...tls.problems,
		// A local CA already in deploy/certs that cannot serve the answers (stack_tls
		// would skip its issue) — refused here, before anything is built.
		...[stackAuthorityConflict(ctx)].filter((line): line is string => line !== null),
	];
	return {
		facts,
		problems: [...new Set(problems)],
		warnings: [...published.warnings, ...tls.warnings],
	};
}

/**
 * The stack preflight's refusals, measured now and recorded nowhere (campaign
 * 3 C3-23): a fresh run checks them BEFORE it writes .dedalo-install/.
 */
export async function stackPreflightRefusals(ctx: HostCtx): Promise<string[]> {
	return (await evaluateStack(ctx)).problems;
}

/** The preflight's own run: measure, refuse, freeze. */
async function runStackPreflight(
	ctx: HostCtx,
	digest: (ctx: HostPlanCtx) => Record<string, string>,
): Promise<HostRunResult> {
	const { facts, problems, warnings } = await evaluateStack(ctx);
	refuseAll(problems);
	const planCtx = withFacts(ctx, facts);
	ctx.state.preflight.host = { facts: planCtx.facts, commands_digest: digest(planCtx) };
	return ran(
		`Docker Compose ${facts.composeVersion}, ${facts.freeGib === null ? 'disk not measurable' : `${facts.freeGib} GiB free`}, as ${facts.user}`,
		{ warnings },
	);
}

/**
 * The step. `digest` is the stack table's: every stack step's command list
 * for the frozen facts (passed in, so this module does not import the table).
 */
export function stackPreflightStep(
	digest: (ctx: HostPlanCtx) => Record<string, string>,
): HostStepDefinition {
	return {
		id: 'stack_preflight',
		privilege: 'operator',
		kind: 'probe',
		needs: [],
		label: () => 'system check: Docker, Compose v2, disk, no instance yet, the image source',
		commands: () => [],
		run: (ctx) => runStackPreflight(ctx, digest),
		refusals: stackPreflightRefusals,
	};
}
