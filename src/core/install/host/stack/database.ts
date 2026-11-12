/**
 * stack_database — THE STACK'S POSTGRESQL (terminal installer phase 4,
 * 2026-10-12): `compose up -d postgres`, then wait (bounded) for pg_isready —
 * the engine steps that follow restore the seed into it.
 *
 * --abort: the stack's containers go down; the VOLUMES this install created
 * (the database's, the engine's, never one that existed before it) are
 * removed only with `--confirm-database <db>` — the same confirmation a
 * production abort asks before it drops a database. The images are kept, and
 * named (keptImages).
 */

import type { HostCommand, HostCtx, HostPlanCtx, HostStepDefinition } from '../contract.ts';
import { executeCommands } from '../execute.ts';
import { probeOk, ran, verdictOf } from '../production/common.ts';
import { hostRefuse } from '../refuse.ts';
import { pollUntil, rememberNewVolumes, stackCreated } from './common.ts';
import { composeCommand, composeProbe, dockerCommand, dockerProbe } from './compose.ts';
import { stackFactsOf } from './facts.ts';
import { certbotImage, postgresImage, serviceImages } from './images.ts';
import { DATABASE_VOLUME, ENV_FILE, imageRefOf, stackFileOf } from './layout.ts';

/** `pg_isready` inside the postgres container. */
export function readyProbe(ctx: HostPlanCtx): HostCommand & { kind: 'exec' } {
	return composeProbe(
		ctx,
		[
			'exec',
			'-T',
			'postgres',
			'pg_isready',
			'-U',
			ctx.answers.db_username,
			'-d',
			ctx.answers.db_database,
		],
		'PostgreSQL accepts connections',
		{ timeoutMs: 30_000 },
	);
}

export function databaseCommands(ctx: HostPlanCtx): HostCommand[] {
	return [composeCommand(ctx, ['up', '-d', 'postgres'], 'start PostgreSQL'), readyProbe(ctx)];
}

async function runDatabase(ctx: HostCtx) {
	await executeCommands([composeCommand(ctx, ['up', '-d', 'postgres'], 'start PostgreSQL')], ctx);
	const ready = await pollUntil(
		ctx,
		{ limitMs: 180_000, everyMs: 2000, progressEvery: 15, what: 'PostgreSQL' },
		() => probeOk(ctx, readyProbe(ctx)),
	);
	if (!ready) {
		hostRefuse(
			'install.step_failed',
			`PostgreSQL did not become ready — inspect it with: docker compose -f ${stackFileOf(ctx.answers)} --env-file ${ENV_FILE} logs postgres`,
		);
	}
	return ran(`PostgreSQL is up (database ${ctx.answers.db_database})`);
}

/** The stack's containers down (volumes kept). */
async function stackDown(ctx: HostCtx): Promise<void> {
	await executeCommands(
		[
			composeCommand(ctx, ['down', '--remove-orphans'], 'stop and remove the stack containers', {
				okExit: [0, 1],
			}),
		],
		ctx,
	);
}

/** Remove the volumes this install created — only with the database confirmed. */
async function removeCreatedVolumes(ctx: HostCtx): Promise<string> {
	const created = stackCreated(ctx);
	if (created.volumes.length === 0) return '; no volume was created';
	if (ctx.confirmDatabase !== ctx.answers.db_database) {
		hostRefuse(
			'install.invalid_input',
			`--abort removes the stack's volumes (the database ${ctx.answers.db_database} with them): confirm with --confirm-database ${ctx.answers.db_database}`,
		);
	}
	const names = [...created.volumes];
	await executeCommands(
		[
			dockerCommand(ctx, ['volume', 'rm', ...names], 'remove the volumes this install created', {
				okExit: [0, 1],
			}),
		],
		ctx,
	);
	created.volumes = [];
	return `; volumes removed: ${names.join(', ')}`;
}

/**
 * Every image this stack can use (the Dédalo image, the service images, certbot
 * on Let's Encrypt) — the service and certbot pins read from the route's stack
 * file (images.ts), so a probe or `docker image rm` names the exact reference
 * compose pulled (`name:version@sha256:…`; measured on Docker 29: inspect and
 * rm both resolve that form).
 */
export function stackImages(ctx: HostPlanCtx): string[] {
	const le = ctx.answers.route === 'docker' && ctx.answers.tls_mode === 'letsencrypt';
	return [imageRefOf(ctx.answers), ...serviceImages(ctx), ...(le ? [certbotImage(ctx)] : [])];
}

/** `docker image inspect` of one image: present on this machine? */
function imagePresentProbe(ctx: HostPlanCtx, image: string) {
	return dockerProbe(
		ctx,
		['image', 'inspect', '--format', '{{.Id}}', image],
		`${image} is present`,
	);
}

/**
 * The stack's images ON THIS MACHINE, measured (campaign 3e E4: an abort
 * before nginx ever started named nginx:alpine — never pulled — and its
 * `docker image rm` failed with "No such image").
 */
export async function presentImages(ctx: HostCtx): Promise<string[]> {
	const present: string[] = [];
	for (const image of stackImages(ctx)) {
		if (await probeOk(ctx, imagePresentProbe(ctx, image))) present.push(image);
	}
	return present;
}

/**
 * The images an abort leaves on the machine, named (campaign 3 C3-52) — a
 * cache, not the install; the operator decides whether to reclaim the space.
 * `images` are the ones PRESENT (presentImages — campaign 3e E4). `postgresRuns`:
 * a SERVED abort keeps PostgreSQL running with the data, so its image cannot
 * be removed yet — the command names only what `docker image rm` can remove
 * now, and says when the rest goes (campaign 3c D8). `runningPostgres` is the
 * postgres image when it keeps running (postgresImage), null otherwise.
 */
export function keptImagesLine(
	images: readonly string[],
	runningPostgres: string | null = null,
): string {
	if (images.length === 0) return 'no image of this stack is on this machine';
	const removable =
		runningPostgres === null ? images : images.filter((image) => image !== runningPostgres);
	const remove =
		removable.length === 0 ? '' : ` — remove them with: docker image rm ${removable.join(' ')}`;
	const kept = `the images are kept (${images.join(', ')})${remove}`;
	return runningPostgres !== null && images.includes(runningPostgres)
		? `${kept}; ${runningPostgres} runs the kept database — it goes with the instance (see that section)`
		: kept;
}

/** The kept images of this stack, measured on the machine (keptImagesLine). */
export async function keptImages(ctx: HostCtx, postgresRuns = false): Promise<string> {
	return keptImagesLine(await presentImages(ctx), postgresRuns ? postgresImage(ctx) : null);
}

export const stack_database: HostStepDefinition = {
	id: 'stack_database',
	privilege: 'operator',
	kind: 'action',
	needs: [],
	// `up -d postgres` again is the whole repair of a stopped PostgreSQL (C3-10).
	restartable: true,
	label: (plan) => `start PostgreSQL (database ${String(plan.answers.db_database)})`,
	commands: databaseCommands,
	verify: async (ctx) =>
		verdictOf(
			[[await probeOk(ctx, readyProbe(ctx)), 'PostgreSQL does not accept connections']],
			'PostgreSQL is up',
		),
	run: runDatabase,
	intent: (ctx) => rememberNewVolumes(ctx, [DATABASE_VOLUME], stackFactsOf(ctx).volumes),
	undo: async (ctx) => {
		await stackDown(ctx);
		return `the stack is down${await removeCreatedVolumes(ctx)}; ${await keptImages(ctx)}`;
	},
};
