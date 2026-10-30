/**
 * THE UPDATE RUN JOURNAL (update audit 2026-10-29, design §3.1; owner decision
 * D-9: a file journal is enough).
 *
 * One JSON file per run, `<private>/update/runs/<run_id>.json` — outside the
 * code tree (a swap moves the tree) and outside the database (a run may have to
 * say "restore the database"). Every write is durable and atomic (temp + fsync
 * + rename + dir fsync, src/core/files/durable_async.ts), so after a crash the
 * file is the last state the run reached, never a torn one; an unreadable file
 * is reported as such, never taken as "no run".
 *
 * The journal is the run's memory: which release it walks to, the phases (the
 * release steps, D-1), what each phase did ({phase, started, finished,
 * outcome, evidence}), the backup it took or the waiver it recorded, and the
 * state (states.ts). Transitions go through `transition`, which refuses one the
 * state machine does not allow.
 *
 * The root is a parameter everywhere (tests pass a scratch dir); production
 * reads `updateRunsRoot()`.
 */

import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { privateDir } from '../../../config/env.ts';
import { DedaloError, isDedaloError } from '../../errors/dedalo_error.ts';
import { writeTextFileDurablyAsync } from '../../files/durable_async.ts';
import type { ReleasePlan, ReleaseStep } from '../catalog_file.ts';
import type { DbRestoreReport } from './rollback.ts';
import { canTransition, isTerminal, PHASE_STATE, type RunState } from './states.ts';

export const RUN_JOURNAL_FORMAT = 1;

/** The production root of the run journals. */
export function updateRunsRoot(): string {
	return join(privateDir, 'update', 'runs');
}

/** One version the run moves between: release identity, data version, data model. */
export interface RunEndpoint {
	release: string;
	data: string;
	model: string;
	/**
	 * `to` only: the install digest the target tree will carry (the archive's
	 * sha256, stamped by the swap). What proves the swap landed — a developer
	 * build keeps its version, so only the digest tells the trees apart.
	 */
	digest?: string;
}

export type PhaseOutcome = 'running' | 'ok' | 'failed' | 'skipped';

/** One executed phase: a release step of one release. */
export interface PhaseRecord {
	release: string;
	step: ReleaseStep;
	started: string;
	finished: string | null;
	outcome: PhaseOutcome;
	/** What the phase can prove it did (applied files, imported TLDs, digests…). */
	evidence: Record<string, unknown>;
}

export interface RunBackup {
	/** The verified dump the run took, or null when waived. */
	path: string | null;
	/** When the dump's snapshot was taken (ISO) — the start of the loss window. */
	taken: string | null;
	/** Who waived it (user id) — journaled, never silent (U-29). */
	waivedBy: number | null;
}

export interface RunJournal {
	format: number;
	run_id: string;
	created: string;
	updated: string;
	from: RunEndpoint;
	to: RunEndpoint;
	/** The planned phases, in order: each release's steps along the walk. */
	plan: { release: string; step: ReleaseStep }[];
	/**
	 * The catalog plan of every release on the walk, as the run was PLANNED —
	 * from the master's manifest for releases this tree's catalog does not know
	 * yet. The rollback predicate reads it, so a resumed run judges its phases
	 * by the plans it ran, whichever tree resumes it.
	 */
	release_plans: Record<string, ReleasePlan>;
	/**
	 * An ontology-only run's NARROWING: the shared TLDs the operator asked for.
	 * It only ever narrows the server's set (run/ontology_phase.ts) — a TLD
	 * outside that set is never added. Absent = every TLD of the set.
	 */
	ontology_scope?: string[];
	state: RunState;
	phases: PhaseRecord[];
	backup: RunBackup | null;
	/** Why the run is where it is, for the operator (the last refusal or failure). */
	note: string | null;
	/** Maintenance mode as the operator had it before the run (restored at the end). */
	maintenance_before?: boolean;
	/** The post-verify verdicts (verify.ts), once the run reached them. */
	verify?: { id: string; ok: boolean; detail: string }[];
	/** NEEDS_DB_RESTORE: what the human is told (rollback.ts dbRestoreReport). */
	restore?: DbRestoreReport;
	/**
	 * NEEDS_DB_RESTORE closed by a human (`bun run update abort <note>` after the
	 * restore). Until then the run blocks every new run (unclosedRestore, D-2).
	 */
	restore_closed?: { at: string; note: string };
}

/** A sortable, collision-free id: the UTC instant + a random suffix. */
export function newRunId(now: Date = new Date()): string {
	const stamp = now
		.toISOString()
		.replaceAll(/[-:]/g, '')
		.replace(/\.\d+Z$/, 'Z');
	return `${stamp}_${crypto.randomUUID().slice(0, 8)}`;
}

/** A new run journal at PLANNED (not yet written). */
export function createRunJournal(input: {
	from: RunEndpoint;
	to: RunEndpoint;
	plan: RunJournal['plan'];
	releasePlans?: Record<string, ReleasePlan>;
	ontologyScope?: string[];
	now?: Date;
}): RunJournal {
	const now = (input.now ?? new Date()).toISOString();
	return {
		format: RUN_JOURNAL_FORMAT,
		run_id: newRunId(input.now),
		created: now,
		updated: now,
		from: input.from,
		to: input.to,
		plan: input.plan,
		release_plans: input.releasePlans ?? {},
		...(input.ontologyScope === undefined ? {} : { ontology_scope: input.ontologyScope }),
		state: 'PLANNED',
		phases: [],
		backup: null,
		note: null,
	};
}

/**
 * The journal's sentence for a failure: the vetted public sentence of a
 * DedaloError, else a pointer to the log — the raw exception text goes to the
 * server log under `where`, never into the journal the panel shows (SEC-18).
 */
export function failureSentence(where: string, error: unknown): string {
	console.error(`[update run] ${where}:`, error);
	if (isDedaloError(error) && error.publicMessage !== undefined) return error.publicMessage;
	return `${where} (see the server log)`;
}

/** Phases that finished `ok` — the state machine's progress counter. */
export function completedPhases(journal: RunJournal): number {
	return journal.phases.filter((phase) => phase.outcome === 'ok').length;
}

/** Throw unless the machine allows `journal.state → to` with `completed` phases done. */
function assertTransition(journal: RunJournal, completed: number, to: RunState): void {
	const kinds = journal.plan.map((entry) => entry.step.kind);
	if (!canTransition(kinds, completed, journal.state, to)) {
		throw new DedaloError('update.refused', {
			message: `update run ${journal.run_id}: ${journal.state} → ${to} is not a transition of this run`,
			coordinates: { rule: 'run_transition' },
		});
	}
}

/**
 * Move the run to `to` (a fixed state, VERIFIED/CONFIRMED, or a side exit), or
 * throw `update.refused` when the machine does not allow it. A PHASE state is
 * reached only by `finishPhase(…, 'ok', …)` — the phase's success IS the move.
 */
export function transition(
	journal: RunJournal,
	to: RunState,
	note: string | null = null,
): RunJournal {
	if (Object.values(PHASE_STATE).includes(to)) {
		throw new DedaloError('internal.invariant', {
			message: `update run ${journal.run_id}: ${to} is reached by finishing its phase, not by a transition`,
		});
	}
	assertTransition(journal, completedPhases(journal), to);
	return { ...journal, state: to, note: note ?? journal.note, updated: new Date().toISOString() };
}

/** Record a phase start (outcome `running`). */
export function startPhase(journal: RunJournal): RunJournal {
	const next = journal.plan[completedPhases(journal)];
	if (next === undefined || journal.phases.some((phase) => phase.outcome === 'running')) {
		throw new DedaloError('internal.invariant', {
			message: `update run ${journal.run_id}: no phase to start`,
		});
	}
	const record: PhaseRecord = {
		release: next.release,
		step: next.step,
		started: new Date().toISOString(),
		finished: null,
		outcome: 'running',
		evidence: {},
	};
	return { ...journal, phases: [...journal.phases, record], updated: record.started };
}

/**
 * Close the running phase with its outcome and evidence. An `ok` phase also
 * moves the run to the phase's state (checked against the machine with the
 * phases done BEFORE it); a failed one leaves the state for the caller's side
 * exit (rollback.ts decides which).
 */
export function finishPhase(
	journal: RunJournal,
	outcome: Exclude<PhaseOutcome, 'running'>,
	evidence: Record<string, unknown>,
): RunJournal {
	const index = journal.phases.findIndex((phase) => phase.outcome === 'running');
	if (index === -1) {
		throw new DedaloError('internal.invariant', {
			message: `update run ${journal.run_id}: no running phase to finish`,
		});
	}
	const running = journal.phases[index] as PhaseRecord;
	const state = outcome === 'ok' ? PHASE_STATE[running.step.kind] : journal.state;
	if (outcome === 'ok') assertTransition(journal, completedPhases(journal), state);
	const finished = new Date().toISOString();
	const phases = journal.phases.map((phase, at) =>
		at === index ? { ...phase, finished, outcome, evidence } : phase,
	);
	return { ...journal, phases, state, updated: finished };
}

/** Persist the journal durably and atomically under `root`. */
export async function writeRunJournal(root: string, journal: RunJournal): Promise<void> {
	await ensureRunsRoot(root);
	await writeTextFileDurablyAsync(
		join(root, `${journal.run_id}.json`),
		`${JSON.stringify(journal, null, '\t')}\n`,
	);
}

/**
 * The runs directory exists before the first journal: nothing else creates it,
 * and a fresh install's first run must not die on ENOENT. Private (0700); the
 * parent is fsynced so the new entry survives a power cut with the journal.
 */
async function ensureRunsRoot(root: string): Promise<void> {
	const created = await mkdir(root, { recursive: true, mode: 0o700 });
	if (created === undefined) return;
	const parent = await open(dirname(root), 'r');
	try {
		await parent.sync();
	} finally {
		await parent.close();
	}
}

/** What reading a journal file found. */
export type JournalRead =
	| { ok: true; journal: RunJournal }
	| { ok: false; file: string; reason: string };

/** Read one journal file; an unreadable or foreign file is reported, never dropped. */
export async function readRunJournal(path: string): Promise<JournalRead> {
	try {
		const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<RunJournal>;
		if (parsed.format !== RUN_JOURNAL_FORMAT || typeof parsed.run_id !== 'string') {
			return { ok: false, file: path, reason: 'not a run journal of this format' };
		}
		return { ok: true, journal: parsed as RunJournal };
	} catch (error) {
		const code = (error as { code?: string }).code;
		return { ok: false, file: path, reason: code ?? 'not valid JSON' };
	}
}

/** Every journal under `root`, oldest first (run ids sort by time). A missing root = none. */
export async function readRunJournals(root: string): Promise<JournalRead[]> {
	let names: string[];
	try {
		names = await readdir(root);
	} catch (error) {
		if ((error as { code?: string }).code === 'ENOENT') return [];
		throw error;
	}
	const files = names.filter((name) => name.endsWith('.json')).sort();
	return Promise.all(files.map((name) => readRunJournal(join(root, name))));
}

/**
 * A NEEDS_DB_RESTORE run no human has closed, or null (drill 2026-10-30, B4).
 * The state is terminal — nothing resumes it — but D-2 says a human restores
 * the database: until one records that (closeRestore), a new run would start
 * over a database on a crossed model, so the start doors refuse.
 */
export async function unclosedRestore(root: string): Promise<RunJournal | null> {
	const reads = await readRunJournals(root);
	const open = reads.find(
		(read) =>
			read.ok &&
			read.journal.state === 'NEEDS_DB_RESTORE' &&
			read.journal.restore_closed === undefined,
	);
	return open?.ok === true ? open.journal : null;
}

/** The human's close of a NEEDS_DB_RESTORE run (pure; the caller writes it). */
export function closeRestore(journal: RunJournal, note: string): RunJournal {
	return { ...journal, restore_closed: { at: new Date().toISOString(), note } };
}

/**
 * The run that blocks a new one (design §3.2: one non-terminal run at a time),
 * or null. An UNREADABLE journal blocks too — a torn or foreign file is not
 * proof that no run is in flight.
 */
export async function blockingRun(root: string): Promise<JournalRead | null> {
	const reads = await readRunJournals(root);
	return (
		reads.find((read) => !read.ok) ??
		reads.find((read) => read.ok && !isTerminal(read.journal.state)) ??
		null
	);
}
