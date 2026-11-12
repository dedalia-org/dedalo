/**
 * THE BOOT MARKER — the engine's half of the watchdog's boot grace (T1-26 / S15;
 * finding F3, campaign 2 L7).
 *
 * Boot migrations and the search-store backfill run BEFORE the server binds its
 * socket and can outlast any fixed grace. deploy/dedalo-ts-watchdog.sh skips a red
 * probe while `$(dirname <socket>)/booting` exists and its FIRST LINE names a live
 * pid (bounded by the grace times four). This module is the PRODUCER the script was
 * gated against with a planted file only: `startServer` (src/server.ts) writes the
 * marker before its pre-bind work and removes it once the socket listens; a process
 * exit removes it too, and a killed boot leaves a dead pid — inert by the script's
 * own `kill -0`.
 *
 * WRITTEN ONLY WHERE ITS CONSUMER LIVES AND NOTHING ELSE CAN WRITE:
 *  - only under a declared supervisor (isSupervised — the watchdog is a supervisor
 *    unit's companion; an unsupervised `bun run start` has no reader);
 *  - only in a socket directory that is NOT world-writable: the unit's
 *    RuntimeDirectory (0750) qualifies; a shared `/tmp` (the development default
 *    socket, /tmp/dedalo_ts.sock) never gets a `/tmp/booting`;
 *  - never over a marker whose pid is alive and not ours.
 * Written atomically (a private temp name, then rename). REMOVED ONLY WHEN IT IS
 * STILL THE FILE WE WROTE — the `clear` a write returns compares the inode (a
 * bounded stat, safe in a synchronous `exit` hook), so a marker another process
 * put there since is never removed. NEVER THROWS: a boot must not die on its grace
 * marker — a failure is one `[boot]` warning.
 *
 * Functions only, no module state (module_state_tripwire). Gate:
 * test/unit/boot_marker_native.test.ts; consumer gate:
 * install_restart_supervisor_tripwire (GRACE_CASES plants it through this producer).
 */

import { statSync, unlinkSync } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isSupervised } from './supervision.ts';

/** The marker's file name, beside the socket (the watchdog derives it the same way). */
export const BOOT_MARKER_NAME = 'booting';

/** Where the marker of the server bound to `socketPath` lives. */
export function bootMarkerPath(socketPath: string): string {
	return join(dirname(socketPath), BOOT_MARKER_NAME);
}

export type BootMarkerSkip =
	| 'skipped:unsupervised'
	| 'skipped:no_socket_dir'
	| 'skipped:world_writable_dir'
	| 'skipped:foreign_live_marker'
	| 'failed';

/** A write's outcome; `written` carries the one door that removes THAT file. */
export type BootMarkerWrite =
	| { outcome: 'written'; clear: () => void }
	| { outcome: BootMarkerSkip };

/** The pid on the first line of `path`, or null (absent, unreadable, not a pid). */
async function markerPid(path: string): Promise<number | null> {
	try {
		const first = (await readFile(path, 'utf8')).split('\n')[0] ?? '';
		return /^[0-9]+$/.test(first) ? Number(first) : null;
	} catch {
		return null;
	}
}

/** Is `pid` a live process (EPERM = alive, owned by someone else)? */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** Why the marker must not be written in `dir`, or null when it may. */
async function directoryRefusal(dir: string): Promise<BootMarkerSkip | null> {
	try {
		const stats = await stat(dir);
		if (!stats.isDirectory()) return 'skipped:no_socket_dir';
		return (stats.mode & 0o002) !== 0 ? 'skipped:world_writable_dir' : null;
	} catch {
		return 'skipped:no_socket_dir';
	}
}

/** The precondition verdict for writing the marker of `socketPath`, or null to write it. */
async function writeRefusal(
	socketPath: string,
	supervised: boolean,
): Promise<BootMarkerSkip | null> {
	if (!supervised) return 'skipped:unsupervised';
	const refusal = await directoryRefusal(dirname(socketPath));
	if (refusal !== null) return refusal;
	const held = await markerPid(bootMarkerPath(socketPath));
	return held !== null && held !== process.pid && pidAlive(held)
		? 'skipped:foreign_live_marker'
		: null;
}

/** The door that removes `target` only while it is still the file identified by `ino`/`dev`. */
function clearIfStill(target: string, ino: number, dev: number): () => void {
	return () => {
		try {
			const now = statSync(target);
			if (now.ino === ino && now.dev === dev) unlinkSync(target);
		} catch {
			// already gone (or unreadable) — nothing of ours to clear
		}
	};
}

/**
 * Write `<socket dir>/booting` holding this process's pid (see the header for when
 * it is skipped). `supervised` is the gate's seam (default: isSupervised()).
 */
export async function writeBootMarker(
	socketPath: string,
	options: { supervised?: boolean } = {},
): Promise<BootMarkerWrite> {
	const refusal = await writeRefusal(socketPath, options.supervised ?? isSupervised());
	if (refusal !== null) return { outcome: refusal };
	const target = bootMarkerPath(socketPath);
	const temp = `${target}.${process.pid}.tmp`;
	try {
		await writeFile(temp, `${process.pid}\n`, { flag: 'wx', mode: 0o644 });
		const { ino, dev } = await stat(temp);
		await rename(temp, target);
		return { outcome: 'written', clear: clearIfStill(target, ino, dev) };
	} catch (error) {
		await rm(temp, { force: true });
		console.warn(
			`[boot] could not write the boot marker ${target} (the watchdog's boot grace is not extended): ${(error as Error).message}`,
		);
		return { outcome: 'failed' };
	}
}
