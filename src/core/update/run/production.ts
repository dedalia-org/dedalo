/**
 * THE UPDATE RUN'S PRODUCTION EFFECTS (update audit 2026-10-29, design §3.1):
 * executor.ts's seams bound to the engine's existing executors — the run adds
 * order, journal, lock and verdicts; it re-implements none of them.
 *
 *   code       code_update.ts updateCode (verify, quarantine, smoke boot, swap,
 *              restart) — the phase stays running across the restart
 *   ontology   run/ontology_phase.ts → ontology_update.ts updateOntology
 *   schema     install/db/migrate.ts runMigrations (the boot files; ONLINE
 *              files run post-confirm, as before)
 *   data       engine.ts updateVersion with every declared step of the rung
 *   ancillary  ancillary.ts runAncillaryPhase (tools, observer mirrors, search
 *              stores, media rules)
 *
 *   backup     the newest PROVEN restorable dump (preconditions.ts
 *              backupFreshness) or a journaled waiver — its mtime opens the
 *              loss window a NEEDS_DB_RESTORE report names
 *   confirm    boot_confirm.ts confirmBootedCodeUpdate, then the online lane
 *   rollback   ordered through /health (health_payload.ts: ROLLED_BACK_CODE on
 *              the target tree is red), so the supervisor's own watchdog and
 *              rollback script put the previous tree back — one mechanism
 *   needs_restore  the sentinel flipped (boot_confirm.ts markFailedBootSchema
 *              with a moved-schema verdict): the rollback script never acts
 */

import { readFile } from 'node:fs/promises';
import { runMigrations, startOnlineMigrations } from '../../../../install/db/migrate.ts';
import { getCurrentDataVersion } from '../../area_maintenance/backup.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { getServerState, setServerState } from '../../resolve/server_state.ts';
import { type Principal, SUPERUSER_ID } from '../../security/permissions.ts';
import {
	codeUpdateSentinelPath,
	confirmBootedCodeUpdate,
	markFailedBootSchema,
} from '../boot_confirm.ts';
import { recordUpdateRunFacts } from '../boot_state.ts';
import { DEDALO_ENGINE_VERSION } from '../build_stamp.ts';
import { getMatchedDescriptor, UPDATE_CATALOG, type UpdateDescriptor } from '../catalog.ts';
import { updateCode } from '../code_update.ts';
import { updateVersion } from '../engine.ts';
import { INSTALLED_DIGEST } from '../install_stamp.ts';
import { backupFreshness, checkUpdatePreconditions } from '../preconditions.ts';
import { runAncillaryPhase } from './ancillary.ts';
import { rungVerdict } from './data_rung.ts';
import { type PhaseResult, type RunEffects, runsTargetTree } from './executor.ts';
import { failureSentence, type RunJournal, updateRunsRoot } from './journal.ts';
import { tryAcquireUpdateRunLock } from './lock.ts';
import { runOntologyPhase } from './ontology_phase.ts';
import { verifyRun } from './verify.ts';

/**
 * The superuser, as a run resumed at boot acts (no request, no session). It IS
 * the actor who started the run: the preflight (checkUpdatePreconditions) and
 * the update_run door (door_class.ts requireSuperuser) admit only SUPERUSER_ID,
 * so no run is ever started by anyone else — a resume never re-attributes a
 * write (review 2026-10-30 #4).
 */
const SUPERUSER: Principal = { userId: SUPERUSER_ID, isGlobalAdmin: true, isDeveloper: true };

/** What the panel / CLI hands a run it starts (a resumed run has only the journal). */
export interface RunStartContext {
	principal: Principal;
	/** The code update request (code_update.ts parseUpdateRequest's input). */
	codeRequest: unknown;
	waiveBackup: boolean;
	onPhase?: (frame: unknown) => void;
	signal?: AbortSignal;
	/** Runs after the sentinel flipped to confirmed (server.ts: the Publication API push). */
	afterConfirmed?: () => void;
}

/** Every declared step of the rung the database stands on, checked (the run runs them all, D-1). */
async function allStepsChecked(): Promise<Record<string, boolean>> {
	const descriptor = getMatchedDescriptor(await getCurrentDataVersion(), UPDATE_CATALOG);
	const keys = [
		...(descriptor?.sqlUpdate ?? []).map((_, index) => `SQL_update_${index}`),
		...(descriptor?.runScripts ?? []).map((_, index) => `run_scripts_${index}`),
	];
	return Object.fromEntries(keys.map((key) => [key, true]));
}

/** dataPhase's seams (the gate injects them; production: the engine's own). */
export interface DataPhaseDeps {
	currentDataVersion: () => Promise<number[]>;
	catalog: Readonly<Record<string, UpdateDescriptor>>;
	runRung: () => Promise<{ ok: boolean; msg?: unknown; errors?: unknown }>;
}

const DATA_PHASE_DEPS: DataPhaseDeps = {
	currentDataVersion: getCurrentDataVersion,
	catalog: UPDATE_CATALOG,
	runRung: async () => updateVersion(await allStepsChecked()),
};

/** This release's rung, and only it — already applied after a resume is ok, a misplaced walk runs nothing (#2). */
export async function dataPhase(
	entry: { release: string },
	deps: DataPhaseDeps = DATA_PHASE_DEPS,
): Promise<PhaseResult> {
	const verdict = rungVerdict(entry.release, await deps.currentDataVersion(), deps.catalog);
	if (verdict.kind === 'applied') {
		return {
			outcome: 'ok',
			evidence: { already_applied: true, data_version: verdict.dataVersion },
		};
	}
	if (verdict.kind === 'refuse')
		return { outcome: 'failed', evidence: { summary: verdict.summary } };
	const response = await deps.runRung();
	return {
		outcome: response.ok ? 'ok' : 'failed',
		evidence: { msg: response.msg, errors: response.errors },
	};
}

/** A release's default ontology step (it declared no steps) inside a code run — see OntologyPhaseDeps.sourceOptional. */
export function isDefaultOntologyStep(entry: { release: string }, journal: RunJournal): boolean {
	const declared = journal.release_plans[entry.release]?.declared === true;
	return !declared && journal.plan.some((planned) => planned.step.kind === 'code');
}

/** This release's migrations (and earlier ones still pending) — never a later release's (B2). */
async function schemaPhase(entry: { release: string }): Promise<PhaseResult> {
	const run = await runMigrations({ throughRelease: entry.release });
	return { outcome: 'ok', evidence: { applied: run.applied, deferred: run.deferred } };
}

/**
 * confirmBootedCodeUpdate reports a failure by LOGGING (it must never kill a
 * boot); the run needs the fact: the sentinel it leaves behind must say
 * `confirmed`, or the run stays VERIFIED (executor.ts confirmRun) — a CONFIRMED
 * journal over a pending sentinel would let the watchdog roll back a tree the
 * run calls done. No sentinel at all (no backup root, or no file) has nothing to
 * flip.
 */
export async function assertSentinelConfirmed(path: string | null): Promise<void> {
	await assertSentinelStatus(path, 'confirmed');
}

/**
 * The sentinel at `path` says `wanted`, or there is none — else throw. The
 * confirm's read-back, and the needs-restore flip's (review 2026-10-30 (4) #4:
 * markFailedBootSchema only LOGS a failed write; a model-crossing phase must
 * never run over a sentinel the watchdog would still roll back).
 */
export async function assertSentinelStatus(
	path: string | null,
	wanted: 'confirmed' | 'needs_restore',
): Promise<void> {
	if (path === null) return;
	const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return null;
		throw error;
	});
	if (text === null) return;
	const status = (JSON.parse(text) as { status?: unknown }).status;
	if (status === wanted) return;
	throw new DedaloError('update.failed', {
		message: `the code sentinel ${path} is '${String(status)}', not '${wanted}'`,
		publicMessage: `The code update sentinel could not be set (status: ${String(status)}, wanted ${wanted})`,
	});
}

function codePhase(context: RunStartContext | null): () => Promise<PhaseResult> {
	return async () => {
		if (context === null) {
			return {
				outcome: 'failed',
				evidence: { error: 'a resumed run cannot start a code swap — start the run again' },
			};
		}
		const response = await updateCode(context.codeRequest, context.principal, {
			...(context.onPhase === undefined ? {} : { onPhase: context.onPhase }),
			...(context.signal === undefined ? {} : { signal: context.signal }),
		} as Parameters<typeof updateCode>[2]);
		return { outcome: 'ok', evidence: { response }, restarting: true };
	};
}

/** The /health facts of a journal: the run, its target, whether it owns this boot. */
export function runFactsOf(journal: RunJournal): Parameters<typeof recordUpdateRunFacts>[0] {
	return {
		run_id: journal.run_id,
		state: journal.state,
		target: journal.to.release,
		owns_boot: journal.phases.some((phase) => phase.step.kind === 'code'),
		on_target: runsTargetTree(journal, {
			release: DEDALO_ENGINE_VERSION,
			digest: INSTALLED_DIGEST,
		}),
	};
}

/**
 * The production effects' own seams — defaults are the engine's; a gate drives
 * the REAL effects with them (review 2026-10-30 (5) #2/#4): the backup verdict,
 * the data phase's version/catalog/rung, the sentinel file.
 */
export interface ProductionSeams {
	freshness?: typeof backupFreshness;
	dataPhase?: DataPhaseDeps;
	sentinelPath?: string | null;
}

/** The production effects; `context` null = a run resumed at boot (`afterConfirmed` then given apart). */
export function productionRunEffects(
	context: RunStartContext | null,
	afterConfirmed: (() => void) | null = null,
	stopping?: () => boolean,
	seams: ProductionSeams = {},
): RunEffects {
	const principal = context?.principal ?? SUPERUSER;
	const sentinelPath =
		seams.sentinelPath === undefined ? codeUpdateSentinelPath() : seams.sentinelPath;
	const freshnessOf = seams.freshness ?? backupFreshness;
	return {
		...(stopping === undefined ? {} : { stopping }),
		root: updateRunsRoot(),
		lock: tryAcquireUpdateRunLock,
		maintenance: {
			get: () => getServerState().maintenance_mode === true,
			set: (on) => void setServerState({ maintenance_mode: on }),
		},
		preflight: async () => {
			try {
				checkUpdatePreconditions(principal, { maintenance: false });
				return null;
			} catch (error) {
				return failureSentence('the update preflight refused', error);
			}
		},
		backup: async () => {
			if (context?.waiveBackup === true)
				return { path: null, taken: null, waivedBy: principal.userId };
			const freshness = await freshnessOf();
			if (freshness.stale || freshness.verdict === null) {
				throw new DedaloError('update.refused', {
					message: 'update run: no fresh, proven restorable database backup',
					publicMessage:
						'No fresh, proven restorable database backup — take one, or waive it (journaled)',
				});
			}
			return {
				path: freshness.verdict.filePath,
				taken: new Date(freshness.verdict.mtimeMs).toISOString(),
				waivedBy: null,
			};
		},
		runners: {
			code: codePhase(context),
			ontology: (entry, journal) =>
				runOntologyPhase(entry.step, principal.userId, {
					...(journal.ontology_scope === undefined ? {} : { scope: journal.ontology_scope }),
					sourceOptional: isDefaultOntologyStep(entry, journal),
				}),
			schema: schemaPhase,
			data: (entry) => dataPhase(entry, seams.dataPhase),
			ancillary: (_entry, journal) => runAncillaryPhase(journal),
		},
		verify: (journal) => verifyRun(journal),
		confirm: async (journal) => {
			// Only a run that swapped code has a sentinel to flip and an online lane
			// the boot left to the run (an ontology-only run has neither).
			if (!journal.plan.some((entry) => entry.step.kind === 'code')) return;
			await confirmBootedCodeUpdate(
				sentinelPath,
				undefined,
				undefined,
				context?.afterConfirmed ?? afterConfirmed,
				{
					state: 'ok',
					applied: [],
					deferred: [],
					schemaMoved: false,
					error: null,
				},
			);
			await assertSentinelConfirmed(sentinelPath);
			void startOnlineMigrations();
		},
		rollbackCode: async (journal) => {
			console.error(
				`[update run] ${journal.run_id}: code rollback ORDERED (${journal.note ?? 'a phase failed'}) — /health is red on this tree, the supervisor puts ${journal.from.release} back`,
			);
		},
		markNeedsRestore: async (journal) => {
			await markFailedBootSchema(
				{
					state: 'failed',
					applied: [],
					deferred: [],
					schemaMoved: true,
					error: `update run ${journal.run_id}: the data model is being crossed — a rollback needs a database restore`,
				},
				sentinelPath,
			);
			await assertSentinelStatus(sentinelPath, 'needs_restore');
		},
		bootedRelease: () => DEDALO_ENGINE_VERSION,
		bootedDigest: () => INSTALLED_DIGEST,
		report: (journal) => recordUpdateRunFacts(runFactsOf(journal)),
	};
}
