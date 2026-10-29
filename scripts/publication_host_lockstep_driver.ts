#!/usr/bin/env bun
/**
 * PUBLICATION-HOST LOCKSTEP DRIVER — the ENGINE half of the [lockstep] rows of
 * scripts/publication_host_engine_drill.ts (engineering/PUBLICATION_HOST_SPEC.md §3, Lockstep).
 *
 * Runs INSIDE a scratch installed tree (scripts/lib/publication_host_lockstep.ts), so every
 * module below is THAT tree's. Its INSTALLED_DIGEST is the stamp the drill wrote; its
 * projectRoot is the tree the manifest covers; its privateDir is the engine drill's scratch
 * private dir (the registry + secrets the real pair CLI wrote — this driver never pairs) and
 * its backup root is the drill's scratch dir (DEDALO_PRIVATE_DIR, DEDALO_BACKUP_PATH). There
 * is one command per process: the stamp is read once at module init, so a re-stamp needs a
 * fresh process, exactly as a swap needs its restart.
 *
 *   bun run scripts/publication_host_lockstep_driver.ts <command> '<json args>'
 *     manifest  {}                await writePublicationManifest(tree, INSTALLED_DIGEST)
 *     verify    {}                await verifyPublicationTree for v1 and v2
 *     reconcile {apply, name}     reconcilePublicationApis for one host
 *     confirm   {name, waitMs}    confirmBootedCodeUpdate WITH the afterConfirmed callback
 *                                 server.ts passes, then — when the trigger started a push —
 *                                 wait until it settles in the runtime file
 *
 * THE CONFIRM HOOK IS THE PRODUCTION CALLBACK. confirmBootedCodeUpdate's 4th parameter
 * defaults to null: only server.ts's CODE-UPDATE BOOT CONFIRMATION block passes the push.
 * `confirm` passes the same shape: api_reconcile.ts loaded INSIDE the hook, after the flip,
 * then triggerPublicationApiPush with smokeBoot from readEnv('DEDALO_SMOKE_BOOT') — so the
 * drill drives the trigger's own guard. It returns what
 * the trigger answered, or null when the hook never ran (the sentinel was not flipped).
 *
 * Prints ONE `DRIVER_RESULT <json>` line (exit 0) or `DRIVER_ERROR <message>` (exit 1).
 * REFUSES any tree without the drill marker: it writes the manifest, flips the sentinel,
 * builds bundles and pushes code — never in a live installation.
 */

import { projectRoot, readEnv } from '../src/config/env.ts';
import {
	type PushTriggerOutcome,
	reconcilePublicationApis,
} from '../src/core/publication_host/api_reconcile.ts';
import { type HostRuntime, loadRuntime } from '../src/core/publication_host/runtime.ts';
import { confirmBootedCodeUpdate } from '../src/core/update/boot_confirm.ts';
import { INSTALLED_DIGEST } from '../src/core/update/install_stamp.ts';
import {
	verifyPublicationTree,
	writePublicationManifest,
} from '../src/core/update/publication_manifest.ts';
import { DEDALO_DATA_VERSION, formatVersion } from '../src/core/update/version.ts';
import { assertDrillTree, DRIVER_ERROR, DRIVER_RESULT } from './lib/publication_host_lockstep.ts';

const ACTOR = 'drill';

/** Task 2's writer is async: awaited, or the manifest may not exist yet. */
async function manifest(): Promise<{ digest: string; version: string }> {
	if (INSTALLED_DIGEST === null) throw new Error('this tree carries no install stamp');
	await writePublicationManifest(projectRoot, INSTALLED_DIGEST);
	return { digest: INSTALLED_DIGEST, version: formatVersion(DEDALO_DATA_VERSION) };
}

/** Both verdicts awaited: an unawaited Promise would serialize as `{}`. */
async function verify() {
	return {
		v1: await verifyPublicationTree(projectRoot, 'v1'),
		v2: await verifyPublicationTree(projectRoot, 'v2'),
	};
}

async function reconcile(args: { apply: boolean; name: string }) {
	const report = await reconcilePublicationApis({
		apply: args.apply,
		hosts: [args.name],
		actor: ACTOR,
	});
	return { version: formatVersion(DEDALO_DATA_VERSION), digest: INSTALLED_DIGEST, report };
}

type Apis = HostRuntime['apis'] | null;

const apisOf = async (name: string): Promise<Apis> => (await loadRuntime())[name]?.apis ?? null;

/** Both APIs written since `before`, and neither still pending: L6 runs v2 then v1. */
function settled(before: Apis, now: Apis): boolean {
	if (now === null) return false;
	return (['v1', 'v2'] as const).every(
		(api) =>
			now[api].state !== 'pending' &&
			now[api].at !== null &&
			now[api].at !== (before?.[api].at ?? null),
	);
}

async function confirm(args: { name: string; waitMs: number }) {
	const before = await apisOf(args.name);
	// A holder, not a `let`: TS would narrow a closure-assigned `let` to its initial null.
	const hook: { trigger: PushTriggerOutcome | null; loaded: Promise<void> | null } = {
		trigger: null,
		loaded: null,
	};
	// The SAME callback as server.ts's CODE-UPDATE BOOT CONFIRMATION block: the module is
	// imported INSIDE the hook, after the flip (server.ts's rationale: CONVENTIONS §2
	// rationale 3, a cold path once per confirmed boot), then the trigger decides. `undefined` selects
	// each default (the sentinel under DEDALO_BACKUP_PATH, this tree's version and digest).
	await confirmBootedCodeUpdate(undefined, undefined, undefined, () => {
		hook.loaded = import('../src/core/publication_host/api_reconcile.ts').then(
			({ triggerPublicationApiPush }) => {
				hook.trigger = triggerPublicationApiPush({
					smokeBoot: readEnv('DEDALO_SMOKE_BOOT') === 'true',
				});
			},
		);
	});
	await hook.loaded;
	if (hook.trigger !== 'started') {
		return { trigger: hook.trigger, settled: false, before, apis: await apisOf(args.name) };
	}
	const deadline = Date.now() + args.waitMs;
	let now = await apisOf(args.name);
	while (!settled(before, now) && Date.now() < deadline) {
		await Bun.sleep(500);
		now = await apisOf(args.name);
	}
	return { trigger: hook.trigger, settled: settled(before, now), before, apis: now };
}

async function run(command: string, args: Record<string, unknown>): Promise<unknown> {
	switch (command) {
		case 'manifest':
			return manifest();
		case 'verify':
			return verify();
		case 'reconcile':
			return reconcile(args as unknown as { apply: boolean; name: string });
		case 'confirm':
			return confirm(args as unknown as { name: string; waitMs: number });
		default:
			throw new Error(`unknown command '${command}' (manifest|verify|reconcile|confirm)`);
	}
}

if (import.meta.main) {
	const [command = '', raw = '{}'] = process.argv.slice(2);
	try {
		assertDrillTree(projectRoot);
		const result = await run(command, JSON.parse(raw) as Record<string, unknown>);
		console.log(`${DRIVER_RESULT}${JSON.stringify(result)}`);
		process.exit(0);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.log(`${DRIVER_ERROR}${message.replace(/\n/g, ' | ')}`);
		process.exit(1);
	}
}
