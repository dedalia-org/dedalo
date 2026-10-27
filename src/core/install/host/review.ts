/**
 * THE REVIEW'S HOST COMMANDS (terminal installer phase 4, 2026-10-12) — what a
 * host route's Review lists: the facts of THIS machine measured now (read-only
 * commands, the same gathering host_preflight freezes), then every host step's
 * `commands()` for them, rendered as they will run (a check whose value only the
 * run learns is shown with its placeholder: contract.ts REVIEW EQUALS RUN). The
 * run measures again at host_preflight and prints its own list; a resume runs the frozen one.
 *
 * On a machine that cannot be measured from this process (not root, not the
 * target), the facts read what they can; every refusal they imply is the run's
 * preflight's, never the Review's.
 *
 * Production also gets, BEFORE the steps (campaign 3 — what was discovered
 * only during the run, or only after it):
 *  - a TO DO block (`step: 'todo'`): what the operator must do themselves —
 *    the firewall's closed ports with the command (C3-6), Apache's modules
 *    (C3-34), the institution's certificate expiring within 30 days or not
 *    trusted by this host (C3-56, C3-13) — the installer checks these, never
 *    does them;
 *  - on each step and on its own mkdir line, the shared directories that
 *    already exist, marked "exists, not created" (C3-57, N26: a second
 *    instance's Review read as if it would recreate /srv/dedalo, /opt/dedalo…).
 */

import type { Subprocess } from 'bun';
import type { InstallPlan } from '../install_plan.ts';
import type { ReviewMeasure } from '../review_measure.ts';
import { buildPlanFile } from '../run_files_core.ts';
import type { HostPlanCtx, ReviewImage } from './contract.ts';
import { gatherHostFacts, type HostFacts } from './facts.ts';
import { type HostFs, hostFs } from './fs.ts';
import type { HostExecutorOptions } from './host_executor.ts';
import { type HostReviewBlock, hostReview } from './host_table.ts';
import { type InstancePaths, instancePaths, pathsFor } from './layout.ts';
import { OS_ROWS, osRowById } from './os_support.ts';
import { operatorTodo, webServerClash } from './production/preflight.ts';
import { institutionCertVerdict } from './production/tls.ts';
import { plannedDefaultTold } from './production/web.ts';
import { type CommandRunner, scratchRunner, systemRunner } from './runner.ts';
import { readHostRootSeam } from './scratch.ts';
import { bunPinOf, sourceTreeRoot } from './source.ts';
import { gatherStackFacts, pendingStackFacts } from './stack/facts.ts';
import { registryDigestOf } from './stack/image_verify.ts';
import { imageRefOf, imageVerifyOf } from './stack/layout.ts';
import { officialImageVerdict, stackPlanFacts, stackReviewTodo } from './stack/preflight.ts';

/** The runner and the fs the Review (and the identity probe) measure through (the scratch seam's when it is armed). */
export function reviewMachine(): { runner: CommandRunner; fs: HostFs } {
	const scratch = readHostRootSeam();
	if (scratch !== null) {
		return {
			runner: scratchRunner(scratch.markerDir),
			fs: hostFs(scratch.root, `${scratch.markerDir}/owners.json`),
		};
	}
	return {
		runner: systemRunner({ children: new Set<Subprocess>(), redactions: () => [] }),
		fs: hostFs(''),
	};
}

/** The facts the Review computes with: the host's on production, the compose stack's on docker/trial. */
async function reviewFacts(
	plan: InstallPlan,
	paths: InstancePaths,
	source: string,
): Promise<HostFacts> {
	const { runner, fs } = reviewMachine();
	if (plan.answers.route !== 'production') {
		return stackPlanFacts(await gatherStackFacts(runner, fs), source);
	}
	return gatherHostFacts(runner, fs, plan.answers, paths, osRowById, source);
}

/** The step name of the Review's to-do block (not a host step: nothing in it is run). */
export const REVIEW_TODO_STEP = 'todo' as const;

/** A Review block: a host step's, or the to-do block. */
export type ReviewBlock = Omit<HostReviewBlock, 'step'> & {
	step: HostReviewBlock['step'] | typeof REVIEW_TODO_STEP;
};

/**
 * What the operator must do before (or for) the install, in words — the
 * firewall, Apache's modules, the institution's certificate. [] when nothing.
 */
export function reviewTodo(
	ctx: HostPlanCtx,
	fs: Pick<HostFs, 'readText' | 'exists'>,
	now: number,
): string[] {
	const cert = ctx.answers.tls_mode === 'files' ? institutionCertVerdict(ctx, fs, now) : null;
	return [
		// Another web server on this host: host_preflight refuses it — said BEFORE `yes` (campaign 3b N3).
		...webServerClash(ctx, fs),
		...operatorTodo(ctx),
		// nginx installed by this run: its package's default site, said before `yes` (campaign 3e E5).
		...plannedDefaultTold(ctx),
		...(cert === null
			? []
			: [...cert.problems, ...cert.warnings].map(
					(line) => `certificate ${ctx.answers.tls_cert_path}: ${line}`,
				)),
	];
}

/** A `mkdir <path> (…)` Review line's path, or null. */
function mkdirPath(line: string): string | null {
	return /^mkdir (\S+) \(/.exec(line)?.[1] ?? null;
}

/**
 * The suffix of a `mkdir` line whose directory already exists (campaign 3b
 * N26 / C3-57). Not "used as is": the step's mkdir still sets the mode and
 * owner the line shows (fs.ts fixDirectory) — it only does not create it.
 */
export const EXISTS_NOT_CREATED = ' — exists: not created, mode and owner set as shown';

/**
 * Each block's label, with the directories it would create that already exist
 * — and each such `mkdir` line says so ITSELF: a header reading "exists, used
 * as is" above a bare `mkdir` of the same path read as a contradiction
 * (campaign 3b N26).
 */
function markExisting(
	blocks: readonly HostReviewBlock[],
	fs: Pick<HostFs, 'exists'>,
): HostReviewBlock[] {
	return blocks.map((block) => {
		const isExisting = (line: string): boolean => {
			const path = mkdirPath(line);
			return path !== null && fs.exists(path);
		};
		const existing = block.commands.filter(isExisting).map((line) => mkdirPath(line) as string);
		if (existing.length === 0) return block;
		return {
			...block,
			label: `${block.label} — exists, not created: ${existing.join(', ')}`,
			commands: block.commands.map((line) =>
				isExisting(line) ? `${line}${EXISTS_NOT_CREATED}` : line,
			),
		};
	});
}

/** The Review's to-do block, when there is anything to do. */
function todoBlocks(todo: readonly string[]): ReviewBlock[] {
	if (todo.length === 0) return [];
	return [
		{
			step: REVIEW_TODO_STEP,
			label:
				'TO DO YOURSELF — the installer checks these and never does them (read before you install)',
			commands: [...todo],
		},
	];
}

/** The plan context the Review lists the commands of. */
function reviewContext(
	plan: InstallPlan,
	facts: HostFacts,
	pin: string,
	source: string,
): HostPlanCtx {
	return {
		plan: buildPlanFile(plan, {}),
		answers: plan.answers,
		facts,
		row: facts.os === null ? (OS_ROWS[0] as (typeof OS_ROWS)[number]) : osRowById(facts.os),
		paths: pathsFor(plan.answers, pin, facts),
		source,
	};
}

/** Does this plan run no HOST step here (the developer route, the delegated engine child)? */
function runsNoHostStep(plan: InstallPlan): boolean {
	return plan.answers.route === 'developer' || plan.answers.engine_only;
}

/**
 * The Review blocks of a host plan (none for the developer route, the engine
 * child, or an unsupported OS). `measure`: the session's scope for this Review
 * build (review_measure.ts — the image probe the refusals also need runs once).
 */
export async function reviewHostCommands(
	plan: InstallPlan,
	measure?: ReviewMeasure,
): Promise<ReviewBlock[]> {
	if (runsNoHostStep(plan)) return [];
	const source = sourceTreeRoot();
	const pin = bunPinOf(source);
	// The instance-derived names to measure under; the commands take the paths
	// whose service group the measured account decides (critique B2).
	const facts = await reviewFacts(plan, instancePaths(plan.answers, pin), source);
	if (plan.answers.route === 'production' && facts.os === null) return [];
	const ctx = reviewContext(plan, facts, pin, source);
	if (plan.answers.route !== 'production') return stackReviewBlocks(ctx, measure);
	const { fs } = reviewMachine();
	return [...todoBlocks(reviewTodo(ctx, fs, Date.now())), ...markExisting(hostReview(ctx), fs)];
}

/**
 * The image digest a Review shows for a signed image (F4, the same identity the
 * run verifies): the index digest the registry names, asked read-only BEFORE the
 * pull — unresolved (the tag form, the digest pinned at pull) when docker is not
 * there, the registry did not answer or said the image is absent (the image
 * verdict already asked it: asked once, never again), or it names no digest.
 * Undefined for an image with no signature check (a build, a registry of the
 * operator's own).
 */
async function reviewImageOf(
	ctx: HostPlanCtx,
	runner: CommandRunner,
	verdict: { problems: readonly string[]; warnings: readonly string[] },
): Promise<ReviewImage | undefined> {
	if (imageVerifyOf(ctx.answers) !== 'cosign') return undefined;
	const stack = ctx.facts.stack ?? pendingStackFacts();
	if (stack.docker === null) return { unresolved: true };
	if (verdict.problems.length > 0 || verdict.warnings.length > 0) return { unresolved: true };
	const digest = await registryDigestOf(runner, stack.docker, imageRefOf(ctx.answers), stack.home);
	return digest === null ? { unresolved: true } : { digest };
}

/** A docker/trial plan's Review blocks: the TO DO (image, certificate), then the steps. */
async function stackReviewBlocks(
	ctx: HostPlanCtx,
	measure: ReviewMeasure | undefined,
): Promise<ReviewBlock[]> {
	const { runner, fs } = reviewMachine();
	// An official image whose publication could not be checked (offline): said
	// before `yes`, never refused — an ABSENT one is a preflight refusal.
	const image = await officialImageVerdict(
		{ answers: ctx.answers, runner, ...(measure === undefined ? {} : { measure }) },
		ctx.facts.stack ?? pendingStackFacts(),
	);
	const reviewImage = await reviewImageOf(ctx, runner, image);
	// The signature check is listed by tag: say why, and that the run verifies the pulled digest.
	const digestNote =
		reviewImage !== undefined && 'unresolved' in reviewImage
			? [
					`the signature of ${imageRefOf(ctx.answers)} is listed by its tag: the registry did not name its digest before the pull — the digest the pull brings is pinned, and the run verifies that digest with cosign`,
				]
			: [];
	return [
		...todoBlocks([...image.warnings, ...digestNote, ...stackReviewTodo(ctx, fs, Date.now())]),
		...hostReview(reviewImage === undefined ? ctx : { ...ctx, reviewImage }),
	];
}

/**
 * What the run's own system check would refuse for this plan, asked BEFORE
 * `yes` — the session's `preflightRefusals` (install_session.ts), wired by
 * scripts/install.ts (campaign 3c D2: an untrusted chain, Apache beside nginx,
 * a held port were refused only after `yes`, every answer lost). The SAME
 * function the run asks (host_executor.ts hostPlanRefusals), over the plan
 * with no secret; none for a plan that runs no host step. `options`: a gate's
 * scratch machine (default: this one, or the scratch seam's when armed).
 */
export async function reviewPreflightRefusals(
	plan: InstallPlan,
	options: HostExecutorOptions = {},
): Promise<string[]> {
	if (runsNoHostStep(plan)) return [];
	const { hostPlanRefusals } = await import('./host_executor.ts');
	return (await hostPlanRefusals(buildPlanFile(plan, {}), options)).errors;
}
