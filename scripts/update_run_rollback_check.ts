/**
 * LEAF CLI — may the watchdog / rollback script put the code back on its own?
 * (update audit 2026-10-29, U-02; design §3.1: ONE predicate for every caller.)
 *
 *   bun run scripts/update_run_rollback_check.ts [--root <runs dir>]
 *
 * Reads the run journals (`<private>/update/runs/`, src/core/update/run/
 * journal.ts) and answers for the run in flight with src/core/update/run/
 * rollback.ts canAutoRollback — the same answer the engine gives, so a shell
 * script never re-derives D-2 in bash. One JSON line on stdout, and:
 *
 *   exit 0  allowed     — the previous code still fits the database
 *   exit 1  REFUSED     — a database phase crossed the data model: NEEDS_DB_RESTORE,
 *                         a human restores (the line carries the report)
 *   exit 3  no run      — no non-terminal run journal: the caller's own (sentinel)
 *                         rules decide, as before the run existed
 *   exit 4  unreadable  — a journal that cannot be read: NOT proof of anything,
 *                         so the caller must not roll back automatically
 *   exit 2  a malformed call
 *
 * LEAF: no database, no network — it runs while the server is down. It judges
 * by the plans the journal recorded (whichever tree runs it).
 *
 * NOT called by deploy/dedalo-code-rollback.sh, deliberately: that script lives
 * OUT of tree and must work in the crash window when no tree exists. The
 * engine carries the same verdict into the file the script already reads —
 * before a phase that crosses the data model runs, the sentinel is flipped to
 * `needs_restore` (run/production.ts markNeedsRestore), and the script never
 * acts on anything but `pending`. This CLI is the operator's and the CLI's
 * view of the same predicate.
 */

import { blockingRun, updateRunsRoot } from '../src/core/update/run/journal.ts';
import { canAutoRollback, dbRestoreReport } from '../src/core/update/run/rollback.ts';

/** The verdict line and the exit code for the journals under `root`. */
export async function rollbackCheck(
	root: string,
): Promise<{ code: number; line: Record<string, unknown> }> {
	const blocking = await blockingRun(root);
	if (blocking === null) return { code: 3, line: { verdict: 'no_run' } };
	if (!blocking.ok) {
		return {
			code: 4,
			line: { verdict: 'unreadable', file: blocking.file, reason: blocking.reason },
		};
	}
	const verdict = canAutoRollback(blocking.journal, blocking.journal.release_plans);
	if (verdict.allowed) {
		return {
			code: 0,
			line: { verdict: 'allowed', run_id: blocking.journal.run_id, reason: verdict.reason },
		};
	}
	return {
		code: 1,
		line: {
			verdict: 'needs_db_restore',
			reason: verdict.reason,
			report: dbRestoreReport(blocking.journal, blocking.journal.release_plans),
		},
	};
}

function rootOf(argv: readonly string[]): string | null {
	if (argv.length === 0) return updateRunsRoot();
	return argv.length === 2 && argv[0] === '--root' ? (argv[1] as string) : null;
}

if (import.meta.main) {
	const root = rootOf(process.argv.slice(2));
	if (root === null) {
		console.error('usage: bun run scripts/update_run_rollback_check.ts [--root <runs dir>]');
		process.exit(2);
	}
	const { code, line } = await rollbackCheck(root);
	console.log(JSON.stringify(line));
	process.exit(code);
}
