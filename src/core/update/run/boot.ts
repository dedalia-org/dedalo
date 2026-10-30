/**
 * THE BOOT'S VIEW OF THE UPDATE RUN (update audit 2026-10-29, design §3.2;
 * U-01, U-03): which run, if any, this boot belongs to.
 *
 * A non-terminal run whose code phase started CLAIMS the boot: the new tree
 * boots in maintenance with its schema pending, and the run's own `schema`
 * phase applies the migrations in the release order (D-1: ontology before
 * schema) — the unconditional boot runner stands aside, and so does the direct
 * sentinel confirm (the run confirms only on VERIFIED). A boot without a run
 * (a fresh install, a transport not yet on runs) keeps the boot runner.
 *
 * An unreadable journal claims nothing — the boot runner runs as before — and
 * is said loudly: it also blocks any new run until a human looks.
 */

import { resumeUpdateRun } from './executor.ts';
import { blockingRun, type RunJournal, updateRunsRoot } from './journal.ts';
import { productionRunEffects } from './production.ts';

export interface BootRun {
	journal: RunJournal;
	/** The run's code phase started: its schema phase owns this boot's migrations. */
	ownsBoot: boolean;
}

/** The run in flight at boot, or null. */
export async function readBootRun(root: string = updateRunsRoot()): Promise<BootRun | null> {
	const blocking = await blockingRun(root);
	if (blocking === null) return null;
	if (!blocking.ok) {
		console.error(
			`[update run] the run journal ${blocking.file} cannot be read (${blocking.reason}) — the boot runs its own migrations; no update can start until a human looks at it`,
		);
		return null;
	}
	const ownsBoot = blocking.journal.phases.some((phase) => phase.step.kind === 'code');
	return { journal: blocking.journal, ownsBoot };
}

/** What this boot does about migrations and the run (server.ts follows it verbatim). */
export interface BootRunDecision {
	/** The unconditional boot migration runner (runBootSchema) runs pre-listen. */
	bootMigrations: boolean;
	/** The online (CONCURRENTLY) lane starts post-listen; a run's confirm starts it instead. */
	onlineMigrations: boolean;
	/** Post-listen: resume the run (it confirms) instead of the direct sentinel confirm. */
	resumeRun: boolean;
}

/**
 * THE BOOT'S DECISION, pure. A smoke boot (read-only quarantine) runs nothing and
 * never resumes a run — a production run's phases must not ride a quarantine
 * boot. A run that owns the boot replaces the boot runner and the online lane; any
 * run in flight is resumed after listen; otherwise the boot runs as before.
 */
export function bootRunDecision(smokeBoot: boolean, bootRun: BootRun | null): BootRunDecision {
	if (smokeBoot) return { bootMigrations: false, onlineMigrations: false, resumeRun: false };
	const owns = bootRun?.ownsBoot === true;
	return { bootMigrations: !owns, onlineMigrations: !owns, resumeRun: bootRun !== null };
}

/**
 * Post-listen, DB reachable: drive the run in flight to its end (or to the next
 * restart). Never throws into the boot path — a run that cannot be resumed is
 * logged, and its journal keeps it in flight for the next attempt or a human.
 * `afterConfirmed`: what a confirmed boot runs (server.ts: the Publication API push).
 */
/**
 * How long a boot keeps trying a held lock before it leaves the run to the next
 * boot: every 30 s for two hours — the Linux default TCP keepalive window in
 * which PostgreSQL still believes a dead peer's session holds it (#10). Runs
 * detached after listen (server.ts), so it never delays the boot.
 */
const RESUME_LOCK_RETRY_MS: readonly number[] = Array.from({ length: 240 }, () => 30_000);

export async function resumeBootRun(
	afterConfirmed: (() => void) | null = null,
	/** server.ts: true once shutdownGracefully started (a phase it kills stays resumable). */
	stopping?: () => boolean,
): Promise<void> {
	try {
		const outcome = await resumeUpdateRun(
			productionRunEffects(null, afterConfirmed, stopping),
			RESUME_LOCK_RETRY_MS,
		);
		if (outcome !== null) {
			console.log(
				`[update run] ${outcome.journal.run_id}: ${outcome.journal.state} (${outcome.state})`,
			);
		}
	} catch (error) {
		console.error('[update run] resume failed — the journal keeps the run in flight:', error);
	}
}
