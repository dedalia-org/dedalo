/**
 * stack_image — THE IMAGE THE STACK RUNS (terminal installer phase 4,
 * 2026-10-12), from where the answers say:
 *
 *  - official / custom: `docker pull <repository>:<version>`; then the CHECKS
 *    (image_verify.ts) — the version label, and for an official repository
 *    the cosign signature of the pulled digest, which is RECORDED: before the
 *    engine runs in it and before the stack starts, the tag must still
 *    resolve to that digest (critique A16);
 *  - build: `docker build -t localhost/dedalo:<version> <context>` — the
 *    image deploy/compose.build.yml would build (the Dockerfile, the deny-all
 *    build context of deploy/build_context.ts), built BEFORE .dedalo.env
 *    exists (compose cannot interpolate the stack without it). The context is
 *    a `git archive` of the checkout's HEAD, extracted into the run dir by
 *    THE local builder (deploy/dedalo-image-build.sh → dedalo_image_build,
 *    which removes the snapshot after the build — and which the image
 *    updater's build mode calls too, so an update builds as the install did)
 *    (campaign 3, C3-46): the SAME mechanism the release image and the
 *    production route use, so build_info.txt arrives expanded and the engine
 *    reports the version the image is tagged with (7.0.0 + the commit date),
 *    never `7.0.0-dev` under a `:7.0.0` tag. Committed files only — an edit
 *    not committed is not in the image (said on the Review). A verified
 *    release tree (no .git) is its own context, already expanded.
 *
 * Nothing is undone on --abort: an image is a cache, not an install (told).
 */

import { join } from 'node:path';
import type { InstallAnswers } from '../../install_plan.ts';
import type {
	ExecCommand,
	HostCommand,
	HostCtx,
	HostPlanCtx,
	HostStepDefinition,
} from '../contract.ts';
import { executeCommands } from '../execute.ts';
import { STACK_RUN_DIR } from '../layout.ts';
import { probeOk, ran, verdictOf } from '../production/common.ts';
import { hostRefuse } from '../refuse.ts';
import type { RunResult } from '../runner.ts';
import { execute, inCheckout, stackCreated } from './common.ts';
import { dockerCommand, stackExec } from './compose.ts';
import { dockerOf, STACK_BINARIES } from './facts.ts';
import { imagePresentProbe, pinHolds, verifyImage } from './image_verify.ts';
import {
	BUILD_DURATION,
	imageModeOf,
	imageRefOf,
	imageVerifyOf,
	LOCAL_REPOSITORY,
} from './layout.ts';

/**
 * THE local builder, shared with the image updater (C3-46 deferred half,
 * owner 2026-10-14): deploy/dedalo-image-build.sh runs dedalo_image_build
 * (deploy/dedalo-image-lib.sh) — the checkout's HEAD archived into
 * BUILD_CONTEXT, `docker build` of it, the snapshot removed after, green or red.
 * deploy/dedalo-image-update.sh's build mode calls the same function, so an
 * update builds exactly as the install did.
 */
export const IMAGE_BUILDER = 'deploy/dedalo-image-build.sh';

/** The snapshot's place in a checkout (the builder's DEDALO_IMAGE_CONTEXT; gate: install_sh_image_source). */
export const BUILD_CONTEXT = join(STACK_RUN_DIR, 'image-context');

/** The build context of a checkout: its HEAD, extracted in the run dir (never the checkout itself). */
export function buildContextDir(ctx: HostPlanCtx): string {
	return join(ctx.source, BUILD_CONTEXT);
}

/**
 * The build (the one command whose progress is shown): a checkout through the
 * shared builder (with the docker CLI stack_preflight found); a verified release
 * tree (no .git) is its own context, already expanded — `docker build` of it.
 */
function buildCommand(ctx: HostPlanCtx): ExecCommand {
	const ref = imageRefOf(ctx.answers);
	const label = `build ${ref} here from ${ctx.facts.sourceIsGit ? "a clean snapshot of this checkout's last commit (committed files only, stamped with that commit)" : 'this release tree'} (the first build downloads the base image, the media toolchain and the dependencies: ${BUILD_DURATION}; its steps are shown as they run)`;
	const options = { timeoutMs: 3 * 3600 * 1000, env: { BUILDKIT_PROGRESS: 'plain' } };
	if (!ctx.facts.sourceIsGit) {
		return dockerCommand(ctx, ['build', '--tag', ref, ctx.source], label, options);
	}
	return stackExec(
		ctx,
		[STACK_BINARIES.bash, inCheckout(ctx, IMAGE_BUILDER), ctx.source, ref, dockerOf(ctx)],
		label,
		options,
	);
}

/** The image's commands (pull, or build here). */
export function imageCommands(ctx: HostPlanCtx): HostCommand[] {
	const ref = imageRefOf(ctx.answers);
	if (imageModeOf(ctx.answers) === 'build') {
		return [buildCommand(ctx)];
	}
	return [
		dockerCommand(
			ctx,
			['pull', ref],
			`pull ${ref}, then check its version label${ctx.answers.image_source === 'official' ? " and Dédalo's signature on its digest (cosign)" : ''}`,
			{ timeoutMs: 3600 * 1000 },
		),
	];
}

/** A build step's header line — BuildKit plain (`#7 [3/9] RUN …`) or the legacy builder (`Step 3/9 : RUN …`). */
const BUILD_STEP = /^(#\d+ \[[^\]]+\] |Step \d+\/\d+ : )/;

/** The interval of the "still building" line during a long step. */
export const BUILD_HEARTBEAT_MS = 30_000;

/**
 * A build's output, condensed to what the operator needs to see it move
 * (campaign 3 C3-27 — a silent build looked hung for minutes): every step
 * header, and during a long step a "still building" line with the time,
 * at most every BUILD_HEARTBEAT_MS. Lines are cut to 120 characters.
 */
export function buildProgress(ctx: HostCtx): (line: string) => void {
	const start = ctx.now();
	let last = start;
	return (line) => {
		const now = ctx.now();
		if (BUILD_STEP.test(line)) {
			ctx.say(`    ${line.slice(0, 120)}`);
			last = now;
		} else if (now - last >= BUILD_HEARTBEAT_MS) {
			ctx.say(`    still building (${Math.round((now - start) / 1000)} s)`);
			last = now;
		}
	};
}

/** The refusal of a failed build: its exit and the last line it printed. */
function buildFailed(result: RunResult): never {
	const why = result.timedOut ? 'timed out' : `exit ${result.exitCode}`;
	const last = result.stderr.trim().split('\n').at(-1) ?? '';
	return hostRefuse(
		'install.step_failed',
		`the image build failed (${why})${last === '' ? '' : `: ${last}`}`,
	);
}

/** Pull, or build with its progress shown (BuildKit writes it to stderr, the legacy builder to stdout). */
async function getImage(ctx: HostCtx): Promise<void> {
	if (imageModeOf(ctx.answers) !== 'build') {
		await executeCommands(imageCommands(ctx), ctx);
		return;
	}
	const progress = buildProgress(ctx);
	await execute(ctx, buildCommand(ctx), buildFailed, {
		onStdoutLine: progress,
		onStderrLine: progress,
	});
}

async function runImage(ctx: HostCtx) {
	await getImage(ctx);
	const image = await verifyImage(ctx);
	stackCreated(ctx).image = image;
	const how =
		image.verify === 'cosign'
			? `signature verified: ${image.repository}@${image.digest}`
			: image.repository === LOCAL_REPOSITORY
				? `built here from ${ctx.facts.sourceIsGit ? "this checkout's last commit" : 'this release tree'}`
				: 'a registry of your own: there is no Dédalo signature to check — trusted as pulled';
	return ran(`${imageRefOf(ctx.answers)} — ${how}`);
}

/** The step's label, by source: pull and verify, pull from the operator's registry, or build here (C3-48). */
export function imageLabel(answers: InstallAnswers): string {
	const ref = imageRefOf(answers);
	if (imageModeOf(answers) === 'build') {
		// The Review's [stack_image] line says how long (campaign 3c D10: the Image screen
		// promised it, and only the confirmation after `install` said it).
		return `build the image ${ref} here, from this checkout's last commit (${BUILD_DURATION})`;
	}
	return imageVerifyOf(answers) === 'cosign'
		? `pull the image ${ref} and verify Dédalo's signature`
		: `pull the image ${ref} from your registry (no Dédalo signature to check)`;
}

export const stack_image: HostStepDefinition = {
	id: 'stack_image',
	privilege: 'operator',
	kind: 'action',
	needs: [],
	label: (plan) => imageLabel(plan.answers as InstallAnswers),
	commands: imageCommands,
	verify: async (ctx) =>
		verdictOf(
			[
				[await probeOk(ctx, imagePresentProbe(ctx)), `${imageRefOf(ctx.answers)} is not present`],
				[await pinHolds(ctx), `${imageRefOf(ctx.answers)} is not the image this install verified`],
			],
			`${imageRefOf(ctx.answers)} present and verified`,
		),
	run: runImage,
	undo: async (ctx) =>
		`the image ${imageRefOf(ctx.answers)} is kept (remove it with: docker image rm ${imageRefOf(ctx.answers)})`,
};
