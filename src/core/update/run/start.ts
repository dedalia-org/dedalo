/**
 * STARTING A RUN FROM A CODE-UPDATE REQUEST (update audit 2026-10-29, design
 * §3.1, Phase 2.6; U-33): the maintenance panel's update and the CLI's
 * `apply` both come here — the code swap is one PHASE of the run, never a
 * process of its own.
 *
 * The request names the item the operator chose (`options.file`). Before
 * anything runs, the engine asks that item's master for the manifest ITSELF
 * (code_manifest_pin.ts: the item must be offered, same URL and sha256) and
 * plans from what the master answered: its `plans` carry the steps of every
 * release above this install (release_plans_wire.ts) — this tree's own catalog
 * never knows the release it is about to install. The browser selects; the
 * master's answer plans.
 */

import { config } from '../../../config/config.ts';
import { getCurrentDataVersion } from '../../area_maintenance/backup.ts';
import { toDedaloError } from '../../errors/convert.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import type { Principal } from '../../security/permissions.ts';
import { DEDALO_ENGINE_VERSION } from '../build_stamp.ts';
import { RELEASE_PLANS } from '../catalog.ts';
import type { ReleasePlan } from '../catalog_file.ts';
import type { CodeReleaseItem } from '../code_manifest.ts';
import { type CodeMaster, fetchCodeManifest, pinToMasterManifest } from '../code_manifest_pin.ts';
import { refuseUpdate } from '../refuse.ts';
import { parseReleaseVersion } from '../release_identity.ts';
import type { ReadWirePlans } from '../release_plans_wire.ts';
import { formatVersion } from '../version.ts';
import { type DriveOutcome, startPlannedRun, startUpdateRun } from './executor.ts';
import type { RunJournal } from './journal.ts';
import { ontologyOnlyPlan, planRun, type RunPlan } from './plan.ts';
import { productionRunEffects } from './production.ts';

/** The chosen item's fields the run plans from (shape-untrusted until pinned). */
interface ChosenItem {
	url: string;
	sha256: string;
	version: string;
	release: string | null;
	channel: string | null;
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function chosenItemOf(options: Record<string, unknown>): ChosenItem {
	const file = (options.file ?? {}) as Record<string, unknown>;
	return {
		url: text(file.url),
		sha256: text(file.sha256),
		version: text(file.version),
		release: text(file.release) || null,
		channel: text(file.channel) || null,
	};
}

/** The configured master the item's URL belongs to (same rule as code_update.ts). */
function masterOf(url: string, masters: readonly CodeMaster[]): CodeMaster {
	const origin = (candidate: string) => {
		try {
			return new URL(candidate).origin;
		} catch {
			return null;
		}
	};
	const wanted = origin(url);
	const master = masters.find((entry) => wanted !== null && origin(entry.url) === wanted);
	if (master === undefined) {
		refuseUpdate(
			'request.invalid_options',
			'Error. Release URL is not on a configured code server',
		);
	}
	return master;
}

/** The release identity the item installs: a prerelease's own identity, else its triple. */
function targetOf(item: ChosenItem): string {
	return item.release ?? item.version;
}

export type ManifestFetch = (
	master: CodeMaster,
	channel: string,
) => Promise<{ items: readonly CodeReleaseItem[]; plans: ReadWirePlans }>;

/**
 * The plans a run walks with: this tree's catalog overlaid by the master's
 * (the master's catalog is the newer), the target's data version from the
 * master when it published one. Refuses when the master does not offer the item.
 */
export async function plansFromMaster(
	item: ChosenItem,
	masters: readonly CodeMaster[],
	readManifest: ManifestFetch = fetchCodeManifest,
): Promise<{ plans: Record<string, ReleasePlan>; targetData: number[] | undefined }> {
	const master = masterOf(item.url, masters);
	const channel = item.channel === 'dev' || item.channel === 'prerelease' ? item.channel : 'master';
	let manifest: Awaited<ReturnType<ManifestFetch>> | null = null;
	await pinToMasterManifest(
		{ url: item.url, declaredSha: item.sha256, channel: item.channel },
		master,
		async () => {
			manifest = await readManifest(master, channel);
			return manifest.items;
		},
	);
	const read = (manifest as Awaited<ReturnType<ManifestFetch>> | null)?.plans ?? {
		plans: {},
		data: {},
	};
	const triple = parseReleaseVersion(targetOf(item))?.triple;
	const targetData = triple === undefined ? undefined : read.data[formatVersion(triple)];
	return { plans: { ...RELEASE_PLANS, ...read.plans }, targetData };
}

/** What the caller streams / stops / runs after a confirm. */
export interface RunStartHooks {
	onPhase?: (frame: unknown) => void;
	signal?: AbortSignal;
	afterConfirmed?: () => void;
}

/**
 * Did the run end on a REFUSAL — the preflight / backup step (REFUSED), or a
 * gate inside a pre-swap phase that threw `update.refused` (a checksum
 * mismatch, a refused upgrade path: FAILED_PRE_SWAP, nothing the install runs
 * changed)? Then the job says `update.refused`, as the gate did (refuse.ts:
 * never launder a refusal). A failure after the swap is `update.failed`
 * whatever threw: the run did change the install.
 */
function refusedRun(journal: RunJournal): boolean {
	if (journal.state === 'REFUSED') return true;
	if (journal.state !== 'FAILED_PRE_SWAP') return false;
	const failed = [...journal.phases].reverse().find((phase) => phase.outcome === 'failed');
	return failed?.evidence.code === 'update.refused';
}

/**
 * A run that ENDED short of a confirm is a failed job, never a quiet success:
 * the panel shows its note (the vetted sentence — journal.ts failureSentence).
 * A run that is restarting, or ended CONFIRMED, answers its journal.
 */
export function outcomeOrThrow(outcome: DriveOutcome): DriveOutcome {
	const { state, note, run_id } = outcome.journal;
	const restartingOn = outcome.state === 'restarting' && state !== 'ROLLED_BACK_CODE';
	if (restartingOn || state === 'CONFIRMED') return outcome;
	const said = note ?? 'The update did not complete';
	throw new DedaloError(refusedRun(outcome.journal) ? 'update.refused' : 'update.failed', {
		message: `update run ${run_id} ended ${state}: ${said}`,
		publicMessage: `${said} (update run ${run_id}: ${state})`,
		coordinates: { rule: state.toLowerCase() },
	});
}

/**
 * The update_code JOB's terminal data: the swap's own envelope (`ok({version,
 * release})` — what the panel's resolve_final_frame reads to hand over to the
 * /health poll), with the run's id and state beside it. A run that never reached
 * its swap has no envelope; outcomeOrThrow already failed it.
 */
export function codeRunAnswer(journal: RunJournal): Record<string, unknown> {
	const swap = [...journal.phases].reverse().find((phase) => phase.step.kind === 'code');
	const response = swap?.evidence.response as { data?: Record<string, unknown> } | undefined;
	const run = { run_id: journal.run_id, state: journal.state };
	if (response === undefined || typeof response !== 'object') return { ok: true, data: run };
	return { ...response, data: { ...(response.data ?? {}), ...run } };
}

/** The panel's / CLI's code update, as an update run. */
export async function startCodeUpdateRun(
	options: Record<string, unknown>,
	principal: Principal,
	hooks: RunStartHooks = {},
): Promise<DriveOutcome> {
	const item = chosenItemOf(options);
	const { plans, targetData } = await plansFromMaster(item, config.update.codeServers);
	const effects = productionRunEffects({
		principal,
		codeRequest: options,
		waiveBackup: options.waive_backup === true,
		...hooks,
	});
	const outcome = await startUpdateRun(
		{
			installedRelease: DEDALO_ENGINE_VERSION,
			installedData: await getCurrentDataVersion(),
			target: targetOf(item),
			targetDigest: item.sha256,
			...(targetData === undefined ? {} : { targetData }),
		},
		{ ...effects, plans },
	);
	return outcomeOrThrow(outcome);
}

/**
 * The DRY RUN (`bun run update plan <release>`): what a run to `release` would
 * execute, planned from the manifest of the first configured master that OFFERS
 * it, exactly as a run is — no lock, no write. With several code masters (an
 * official release server and a beta one) the release's own channel decides who
 * can offer it: a prerelease asks every master for its prerelease channel, a
 * stable release for its master channel, and a master that does not serve that
 * channel or does not list the release is passed over, never trusted as "the
 * first". A release no master offers is refused, naming each one asked.
 */
export async function planCodeUpdate(
	release: string,
	readManifest: ManifestFetch = fetchCodeManifest,
	masters: readonly CodeMaster[] = config.update.codeServers,
): Promise<RunPlan> {
	if (masters.length === 0) {
		return {
			ok: false,
			refusal: 'release_unknown',
			detail: 'no code server is configured (CODE_SERVERS)',
		};
	}
	const prerelease = parseReleaseVersion(release)?.prerelease != null;
	const channel = prerelease ? 'prerelease' : 'master';
	const notOffered: string[] = [];
	for (const master of masters) {
		const offer = await manifestOffering(release, master, channel, readManifest);
		if (typeof offer === 'string') {
			notOffered.push(offer);
			continue;
		}
		return planFromManifest(release, offer);
	}
	return {
		ok: false,
		refusal: 'release_unknown',
		detail: `${notOffered.join(', ')} ${notOffered.length === 1 ? 'does' : 'do'} not offer ${release} to this install`,
	};
}

/**
 * `master`'s manifest on `channel` when it lists `release`; otherwise the words
 * the refusal names it by — its url, plus the stable error code when it could not
 * be read (never the raw message: it may carry a remote body or a local path).
 */
async function manifestOffering(
	release: string,
	master: CodeMaster,
	channel: 'prerelease' | 'master',
	readManifest: ManifestFetch,
): Promise<Awaited<ReturnType<ManifestFetch>> | string> {
	let manifest: Awaited<ReturnType<ManifestFetch>>;
	try {
		manifest = await readManifest(master, channel);
	} catch (error) {
		return `${master.url} (${toDedaloError(error).code})`;
	}
	const offers = manifest.items.some((item) => (item.release ?? item.version) === release);
	return offers ? manifest : master.url;
}

/** The plan of `release` from the manifest of the master that offers it. */
async function planFromManifest(
	release: string,
	manifest: Awaited<ReturnType<ManifestFetch>>,
): Promise<RunPlan> {
	const triple = parseReleaseVersion(release)?.triple;
	const targetData = triple === undefined ? undefined : manifest.plans.data[formatVersion(triple)];
	return planRun({
		installedRelease: DEDALO_ENGINE_VERSION,
		installedData: await getCurrentDataVersion(),
		target: release,
		plans: { ...RELEASE_PLANS, ...manifest.plans.plans },
		...(targetData === undefined ? {} : { targetData }),
	});
}

/**
 * The panel's Update ontology, as an ONTOLOGY-ONLY run (plan.ts
 * ontologyOnlyPlan): journaled, under maintenance, behind the run's backup and
 * lock, resumed by the next boot if the process dies mid-import (the phase
 * re-runs forward: replacing a TLD with the same package converges). The TLD
 * set is the server's (run/ontology_phase.ts); `scope` (the operator's
 * selection) only narrows it, journaled.
 */
export async function startOntologyUpdateRun(
	principal: Principal,
	options: { waiveBackup: boolean; scope?: string[]; source?: string },
): Promise<DriveOutcome> {
	const plan = ontologyOnlyPlan({
		installedRelease: DEDALO_ENGINE_VERSION,
		installedData: await getCurrentDataVersion(),
		...(options.scope === undefined ? {} : { scope: options.scope }),
		...(options.source === undefined ? {} : { source: options.source }),
	});
	const effects = productionRunEffects({
		principal,
		codeRequest: null,
		waiveBackup: options.waiveBackup,
	});
	return outcomeOrThrow(await startPlannedRun(plan, effects));
}
