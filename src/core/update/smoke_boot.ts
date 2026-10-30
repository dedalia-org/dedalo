/**
 * PRE-FLIGHT SMOKE BOOT (2026-08-23) — boot the QUARANTINE tree once, before
 * the swap, so a release that cannot even start never replaces a working one.
 *
 * The quarantine's own `src/server.ts` is spawned with `DEDALO_SMOKE_BOOT=true`
 * and a throwaway unix socket under the staging dir. Under that flag the
 * server (src/server.ts honours it) SKIPS boot migrations, schedulers,
 * diffusion, watchers and media-tree provisioning — it only binds and answers
 * `/health`. Those skips are convention; the STRUCTURAL guarantee is the env
 * neutralisation at the spawn site below: the child's DEDALO_PRIVATE_DIR,
 * DEDALO_SESSION_DB_PATH and DEDALO_TS_STATE_PATH are repointed at a throwaway
 * dir under the staging dir, so even an import-time writer (session_store.ts)
 * or a future unguarded boot writer cannot touch live state (the one DB touch
 * is /health's SELECT 1 ping against the shared database). The parent polls
 * `/health` over the socket (the host health_wait shape), then
 * SIGTERMs and requires a clean exit.
 *
 * HONEST LIMITS — what a green smoke boot does NOT prove:
 *  - that the release's BOOT MIGRATIONS succeed: they are deliberately
 *    skipped, because running them pre-swap would mutate the shared database
 *    while the OLD code is still live and serving;
 *  - behaviour under traffic (a single /health round-trip is the whole load).
 * It proves exactly: the tree parses, its module graph evaluates, it binds,
 * and it answers one request — the failure class where a broken release
 * previously took the install down until a manual rollback.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { envSnapshot } from '../../config/env.ts';
import { refuseUpdate } from './refuse.ts';

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 500;
const EXIT_GRACE_MS = 10_000;

/** Tail of a stderr buffer, for the LOG side of a refusal. */
function tail(text: string, lines = 30): string {
	return text.trim().split('\n').slice(-lines).join('\n');
}

/**
 * Boot `codeRoot` once and require it healthy. Throws `update.refused`
 * (operator sentence: nothing was swapped) when the child dies, never answers
 * `/health`, or does not exit cleanly on SIGTERM. The child's stderr rides
 * LOG-ONLY on the thrown error's `message`.
 */
export async function smokeBootQuarantine(codeRoot: string, stagingDir: string): Promise<void> {
	const socketPath = join(stagingDir, 'smoke_boot.sock');
	rmSync(socketPath, { force: true });
	// READ-ONLY STRUCTURALLY, not by convention (2026-08-23 review, FINDING 2):
	// the child's whole private-state surface is repointed at a throwaway dir
	// under the staging dir. session_store.ts opens (creates) its sqlite at
	// MODULE IMPORT — beneath any runtime `!smokeBoot` guard — so without this
	// a set DEDALO_SESSION_DB_PATH (envSnapshot passes the parent env through)
	// had the quarantine child opening the LIVE production session store,
	// WAL/-shm side files and bootstrap DDL included, concurrently with the
	// serving process. Neutralising the keys at the ONE spawn site means a
	// future import-time or boot-time writer that forgets its guard can only
	// ever touch the staging dir. The DB connection still rides the snapshot:
	// /health's SELECT 1 against the shared database is the deliberate single
	// DB touch. The explicit DEDALO_SESSION_DB_PATH / DEDALO_TS_STATE_PATH
	// overrides are required, not belt-and-braces: values set in the parent env
	// would otherwise outrank the repointed private dir.
	const smokePrivateDir = join(stagingDir, 'smoke_private');
	mkdirSync(smokePrivateDir, { recursive: true });
	// Boot as a finished install: an absent or non-sealed state would be refused
	// at boot (src/config/install_state.ts) — the real ts_state.json stays
	// untouched, so seal the throwaway one.
	writeFileSync(
		join(smokePrivateDir, 'ts_state.json'),
		`${JSON.stringify({ install_status: 'sealed' })}\n`,
	);
	const child = Bun.spawn([process.execPath, 'run', join('src', 'server.ts')], {
		cwd: codeRoot,
		stdout: 'ignore',
		stderr: 'pipe',
		env: {
			...(envSnapshot() as Record<string, string>),
			DEDALO_SMOKE_BOOT: 'true',
			SERVER_UNIX_SOCKET: socketPath,
			// The smoke child must never claim the dev TCP port.
			SERVER_TCP_PORT: '',
			DEDALO_PRIVATE_DIR: smokePrivateDir,
			DEDALO_SESSION_DB_PATH: join(smokePrivateDir, 'dedalo_ts_sessions.sqlite'),
			DEDALO_TS_STATE_PATH: join(smokePrivateDir, 'ts_state.json'),
		},
	});
	const stderrPromise = new Response(child.stderr).text();

	const refuse = async (why: string): Promise<never> => {
		try {
			child.kill('SIGKILL');
		} catch {
			/* already gone */
		}
		const stderr = tail(await stderrPromise.catch(() => ''));
		refuseUpdate(
			'update.refused',
			'Error. The new release failed its pre-swap boot check — nothing was swapped',
			new Error(`smoke boot: ${why}${stderr === '' ? '' : `\n--- child stderr ---\n${stderr}`}`),
		);
	};

	const healthProblem = await healthWaitProblem(child, socketPath);
	if (healthProblem !== null) return refuse(healthProblem);

	// Clean shutdown required: a tree that answers but cannot drain is not sound.
	const exitProblem = await sigtermCleanExitProblem(child);
	if (exitProblem !== null) return refuse(exitProblem);
}

/**
 * health_wait (the host scripts' idiom): poll /health over the unix socket
 * until the child answers, exits, or the timeout lapses; null = healthy.
 */
/**
 * Per-attempt bound for the health poll. Well under HEALTH_TIMEOUT_MS so a
 * wedged attempt is abandoned and RETRIED inside the drill's own budget rather
 * than consuming it.
 */
const HEALTH_POLL_TIMEOUT_MS = 5_000;

async function healthWaitProblem(
	child: Bun.Subprocess,
	socketPath: string,
): Promise<string | null> {
	let exited = false;
	void child.exited.then(() => {
		exited = true;
	});
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (exited) {
			return `the quarantine server exited (code ${await child.exited}) before answering /health`;
		}
		try {
			// Bounded per attempt, not only by the loop's deadline (CARRY-14): the
			// loop advances on RETURN, so one socket call that never settles hangs
			// the whole drill past HEALTH_TIMEOUT_MS with nothing to cancel it. A
			// server that has bound the socket but wedged is exactly the failure
			// this probe exists to detect, and it was the one it could not report.
			const response = await fetch('http://localhost/health', {
				unix: socketPath,
				signal: AbortSignal.timeout(HEALTH_POLL_TIMEOUT_MS),
			} as RequestInit & { unix: string; signal: AbortSignal });
			if (response.ok) return null;
		} catch {
			// not bound yet — keep polling
		}
		await Bun.sleep(HEALTH_POLL_MS);
	}
	return 'the quarantine server never answered /health within the timeout';
}

/** SIGTERM the child and require exit 0 within the grace period; null = clean. */
async function sigtermCleanExitProblem(child: Bun.Subprocess): Promise<string | null> {
	child.kill('SIGTERM');
	const exitCode = await Promise.race([child.exited, Bun.sleep(EXIT_GRACE_MS).then(() => null)]);
	if (exitCode === 0) return null;
	return exitCode === null
		? 'the quarantine server did not exit within the SIGTERM grace period'
		: `the quarantine server exited ${exitCode} on SIGTERM (expected 0)`;
}
