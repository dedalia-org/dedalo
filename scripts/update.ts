/**
 * THE UPDATE RUN'S COMMAND LINE (update audit 2026-10-29, design §3.1, Phase
 * 2.6; U-33): `bun run update <command> [--json]`.
 *
 *   status          the run in flight (or the newest run) and where it stands
 *   check           may the code be rolled back on its own? (rollback.ts — the
 *                   same verdict as scripts/update_run_rollback_check.ts)
 *   plan <release>  the dry run: the phases a run to <release> would execute,
 *                   planned from the configured master's manifest — no lock, no write
 *   abort [note]    end the run in flight by a human decision: ABANDONED before
 *                   the swap, MANUAL after it. Refused while the code phase runs
 *                   (the swap may have landed — the next boot settles it), and
 *                   while any process holds the UPDATE_RUN lock (a live server
 *                   driving the run would overwrite the abort with its next save).
 *                   On a NEEDS_DB_RESTORE run it CLOSES it (the human restored the
 *                   database): until then no new run starts (D-2)
 *
 * `apply` and `resume` are NOT here, by design: a run's code phase restarts
 * the SERVER, and its post-swap phases run in the server's own boot (server.ts
 * → run/boot.ts). A command-line process can do neither; it would start a
 * swap it cannot finish. Apply from the maintenance panel (Update code), which
 * starts the same run (run/start.ts).
 *
 * status / check are LEAF (journals only: no database, no network) — they work
 * while the server is down. abort also probes the UPDATE_RUN advisory lock (the
 * database), and refuses when it cannot. plan reads the database's data version
 * and the master's manifest.
 */

import {
	blockingRun,
	closeRestore,
	completedPhases,
	finishPhase,
	type RunJournal,
	readRunJournals,
	transition,
	unclosedRestore,
	updateRunsRoot,
	writeRunJournal,
} from '../src/core/update/run/journal.ts';
import { isTerminal } from '../src/core/update/run/states.ts';
import { rollbackCheck } from './update_run_rollback_check.ts';

export interface CliResult {
	code: number;
	/** What is printed (one JSON line with --json, else these lines). */
	lines: string[];
	json: unknown;
}

const USAGE =
	'usage: bun run update status|check|plan <release>|abort [note] [--json] [--root <runs dir>]';

function result(code: number, json: unknown, lines: string[]): CliResult {
	return { code, json, lines };
}

/** The phases run so far (a rerun phase shows twice), then the plan still ahead. */
function phaseLines(journal: RunJournal): string[] {
	const ran = journal.phases.map(
		(phase) => `  ${phase.release} ${phase.step.kind} — ${phase.outcome}`,
	);
	const last = journal.phases.at(-1);
	const ahead = completedPhases(journal) + (last !== undefined && last.outcome !== 'ok' ? 1 : 0);
	const pending = journal.plan
		.slice(ahead)
		.map((entry) => `  ${entry.release} ${entry.step.kind} — pending`);
	return [...ran, ...pending];
}

async function status(root: string): Promise<CliResult> {
	const reads = await readRunJournals(root);
	const blocking = await blockingRun(root);
	if (blocking !== null && !blocking.ok) {
		return result(4, { verdict: 'unreadable', file: blocking.file, reason: blocking.reason }, [
			`UNREADABLE run journal ${blocking.file} (${blocking.reason}) — it blocks every new run until a human moves it aside`,
		]);
	}
	const newest = blocking ?? reads.filter((read) => read.ok).at(-1) ?? null;
	if (newest === null || !newest.ok)
		return result(3, { verdict: 'no_run' }, ['no update run recorded']);
	const { journal } = newest;
	return result(0, journal, [
		`run ${journal.run_id}: ${journal.state}${isTerminal(journal.state) ? '' : ' (IN FLIGHT)'}`,
		`  ${journal.from.release} (data ${journal.from.data}) → ${journal.to.release} (data ${journal.to.data})`,
		...phaseLines(journal),
		...(journal.note === null ? [] : [`  note: ${journal.note}`]),
	]);
}

async function check(root: string): Promise<CliResult> {
	const { code, line } = await rollbackCheck(root);
	return result(code, line, [JSON.stringify(line)]);
}

/** The terminal state a human ends `journal` in, or why it may not end now. */
export function abortTarget(journal: RunJournal): RunJournal['state'] | string {
	const running = journal.phases.find((phase) => phase.outcome === 'running');
	if (running?.step.kind === 'code') {
		return 'the code phase is running — the swap may have landed; let the next boot settle it, then abort';
	}
	if (journal.state === 'PLANNED') return 'REFUSED';
	const swapped = journal.phases.some(
		(phase) => phase.step.kind === 'code' && phase.outcome === 'ok',
	);
	return swapped ? 'MANUAL' : 'ABANDONED';
}

/** The lock probe (production: the real advisory lock); null = another process holds it. */
export type LockProbe = () => Promise<{ release: () => Promise<void> } | null>;

async function realLockProbe(): ReturnType<LockProbe> {
	const { tryAcquireUpdateRunLock } = await import('../src/core/update/run/lock.ts');
	return tryAcquireUpdateRunLock();
}

async function abort(root: string, note: string, probe: LockProbe): Promise<CliResult> {
	const lock = await probe().catch((error: unknown) => {
		throw new Error(
			`abort refused: cannot read the update lock (${String(error)}) — no process can be proven idle`,
		);
	});
	if (lock === null) {
		return result(1, { verdict: 'refused', reason: 'run_locked' }, [
			'abort refused: a process holds the update lock — the server is driving this run; let it end, or stop the server first',
		]);
	}
	try {
		return await abortHeld(root, note);
	} finally {
		await lock.release();
	}
}

async function abortHeld(root: string, note: string): Promise<CliResult> {
	const blocking = await blockingRun(root);
	if (blocking === null) return closePendingRestore(root, note);
	if (!blocking.ok) {
		return result(4, { verdict: 'unreadable', file: blocking.file }, [
			`run journal ${blocking.file} is unreadable — move it aside by hand after inspecting it`,
		]);
	}
	const target = abortTarget(blocking.journal);
	if (!['REFUSED', 'MANUAL', 'ABANDONED'].includes(target)) {
		return result(1, { verdict: 'refused', reason: target }, [`abort refused: ${target}`]);
	}
	const settled = blocking.journal.phases.some((phase) => phase.outcome === 'running')
		? finishPhase(blocking.journal, 'failed', { aborted: true })
		: blocking.journal;
	const ended = transition(settled, target as RunJournal['state'], `ended by a human: ${note}`);
	await writeRunJournal(root, ended);
	return result(0, { run_id: ended.run_id, state: ended.state }, [
		`run ${ended.run_id} → ${ended.state}. Maintenance mode is left as it is — switch it off when the install is sound.`,
	]);
}

/** No run in flight: close a NEEDS_DB_RESTORE run a human restored (B3), or say there is nothing. */
async function closePendingRestore(root: string, note: string): Promise<CliResult> {
	const pending = await unclosedRestore(root);
	if (pending === null) return result(3, { verdict: 'no_run' }, ['no update run in flight']);
	const closed = closeRestore(pending, `closed by a human: ${note}`);
	await writeRunJournal(root, closed);
	return result(0, { run_id: closed.run_id, state: closed.state, restore_closed: true }, [
		`run ${closed.run_id} (NEEDS_DB_RESTORE) closed. New update runs may start. Maintenance mode is left as it is — switch it off when the install is sound.`,
	]);
}

async function plan(release: string): Promise<CliResult> {
	const { planCodeUpdate } = await import('../src/core/update/run/start.ts');
	const planned = await planCodeUpdate(release);
	if (!planned.ok)
		return result(1, planned, [`plan refused (${planned.refusal}): ${planned.detail}`]);
	return result(0, planned, [
		`${planned.from.release} (model ${planned.from.model}) → ${planned.to.release} (model ${planned.to.model})`,
		...planned.plan.map(
			(entry, at) => `  ${String(at + 1).padStart(2)}. ${entry.release} ${entry.step.kind}`,
		),
	]);
}

/** Parse and run one command (exported for the gate). */
export async function runUpdateCli(
	argv: readonly string[],
	probe: LockProbe = realLockProbe,
): Promise<CliResult> {
	const args = [...argv];
	const rootAt = args.indexOf('--root');
	const root = rootAt === -1 ? updateRunsRoot() : (args.splice(rootAt, 2)[1] ?? '');
	const words = args.filter((arg) => arg !== '--json');
	const [command, ...rest] = words;
	if (command === 'status' && rest.length === 0) return status(root);
	if (command === 'check' && rest.length === 0) return check(root);
	if (command === 'abort') return abort(root, rest.join(' ') || 'no reason given', probe);
	if (command === 'plan' && rest.length === 1) return plan(rest[0] as string);
	if (command === 'apply' || command === 'resume') {
		return result(2, { verdict: 'not_here' }, [
			`${command} runs in the server, not here: the code phase restarts the server and its post-swap phases run in the server's boot. Use the maintenance panel (Update code).`,
		]);
	}
	return result(2, { verdict: 'usage' }, [USAGE]);
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const outcome = await runUpdateCli(argv);
	if (argv.includes('--json')) console.log(JSON.stringify(outcome.json));
	else for (const line of outcome.lines) console.log(line);
	process.exit(outcome.code);
}
