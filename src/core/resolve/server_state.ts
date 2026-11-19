/**
 * TS-NATIVE runtime state (the TS equivalent of PHP's config_core.php custom
 * overrides — DEDALO_MAINTENANCE_MODE_CUSTOM / DEDALO_NOTIFICATION_CUSTOM).
 * The PHP widgets write the PHP install's config file; a
 * coexisting TS server must not touch that, so the TS server keeps its OWN
 * state in <private>/ts_state.json and honors it in its own login flow:
 * maintenance mode refuses non-superuser logins.
 */

import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { privateDir, readEnv } from '../../config/env.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { writeFileDurably } from '../files/durable.ts';

export interface ServerState {
	maintenance_mode: boolean;
	/** Login-page notification message; false/'' disables it. */
	notification: string | boolean;
	/** Runtime area deny/allow lists; null = the static config defaults. */
	areas_deny: string[] | null;
	areas_allow: string[] | null;
	/** Runtime menu skip tipos; null = the static config defaults. */
	menu_skip_tipos: string[] | null;
	/**
	 * Runtime media access mode override (the TS-native equivalent of PHP's
	 * DEDALO_MEDIA_ACCESS_MODE_CUSTOM), written by the root-only media_control widget.
	 * It lives HERE and not in `.env` because `../private/.env` is append-only, so a
	 * UI-settable value cannot go there. `null` = no override → the .env value wins.
	 * `false` = protection explicitly OFF, which is NOT the same as "no override".
	 * Resolved by core/media/protection.ts `resolveMediaAccessMode()`.
	 */
	media_access_mode?: 'private' | 'publication' | false | null;
	/**
	 * Install lifecycle, written ONLY by the terminal installer
	 * (scripts/install.ts → core/install/executor.ts). Absent on a box the
	 * installer never touched (a fresh box, a migrated one) →
	 * `terminal_installing` once persist_config wrote `.env` → `sealed` at
	 * install_finish (the executor's finish mark).
	 *
	 * Any value present and not `sealed` REFUSES THE BOOT
	 * (src/config/install_state.ts notInstalledRefusal, exit 78): the database
	 * is not the install's yet, and an unfinished install is resumed with
	 * the installer's `--resume` (per route), never by starting the server.
	 */
	install_status?: 'terminal_installing' | 'sealed';
	/** Install fingerprint captured at persist_config (PHP state.information). */
	information?: string;
	/** Install fingerprint key captured at persist_config (PHP state.info_key). */
	info_key?: string;
}

const DEFAULT_STATE: ServerState = {
	maintenance_mode: false,
	notification: false,
	areas_deny: null,
	areas_allow: null,
	menu_skip_tipos: null,
	media_access_mode: null,
};

/** The EFFECTIVE deny list: runtime override, else the static config value. */
export function getEffectiveAreasDeny(staticDefault: readonly string[]): string[] {
	return getServerState().areas_deny ?? [...staticDefault];
}

/** The EFFECTIVE menu skip tipos: runtime override, else the static config value. */
export function getEffectiveMenuSkipTipos(staticDefault: readonly string[]): string[] {
	return getServerState().menu_skip_tipos ?? [...staticDefault];
}

/** The EFFECTIVE allow list: runtime override, else empty (no static config source). */
export function getEffectiveAreasAllow(): string[] {
	return getServerState().areas_allow ?? [];
}

/**
 * Can the state file be written (the TS analog of PHP config_local_writer::
 * is_writable, which the widgets surface as `writable` so the client disables
 * Save instead of failing it).
 */
export function isStateWritable(): boolean {
	try {
		const path = statePath();
		accessSync(existsSync(path) ? path : dirname(path), constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * State path (S1-18 precedent): the live file in <private>/ts_state.json by
 * default; the DEDALO_TS_STATE_PATH override exists so `bun test` (bunfig
 * [test].preload → test/preload/session_db.ts) points the WHOLE test process
 * at a per-run scratch file — a test flipping maintenance_mode must never put
 * the LIVE server into maintenance mode (and a killed run must not leave it
 * there).
 */
export function statePath(): string {
	const path = statePathOf();
	if (readEnv('DEDALO_TS_STATE_PATH') !== undefined) return path;
	// The ONE private-dir resolution (src/config/env.ts), which honors
	// DEDALO_PRIVATE_DIR. This used to fall back to `process.cwd()` when the
	// private dir did not exist — under systemd cwd IS the code tree, so the
	// state file landed inside projectRoot and a code-update tree swap carried
	// it away (runtime-path census, 2026-08-23). A missing private dir is now
	// CREATED, and a private dir that cannot be created is a loud typed refusal,
	// never a silent write into the code tree.
	if (!existsSync(privateDir)) {
		try {
			mkdirSync(privateDir, { recursive: true });
		} catch (error) {
			throw new DedaloError('internal.invariant', {
				message: `server_state: the private directory '${privateDir}' does not exist and cannot be created (${(error as Error).message}); refusing to place ts_state.json inside the code tree`,
				coordinates: { module: 'core/resolve/server_state.ts', path: privateDir },
				cause: error,
			});
		}
	}
	return path;
}

/**
 * The state file's path WITHOUT creating anything — the ONE resolution
 * statePath() also answers (DEDALO_TS_STATE_PATH, else <private>/ts_state.json).
 * For a read-only reader (the installer's System check, install/installed_here.ts)
 * that must never mkdir the private dir it is only looking at.
 */
export function statePathOf(): string {
	return readEnv('DEDALO_TS_STATE_PATH') ?? join(privateDir, 'ts_state.json');
}

/**
 * The state when the file EXISTS but cannot be read as a state object (torn by a
 * crash mid-write under the pre-atomic writer, hand-edited into invalid JSON,
 * unreadable): FAIL CLOSED. Maintenance mode is a gate on every route — the
 * dispatcher's Gate 2b and every non-dispatch route through
 * security/session_gate.ts — and the writers that set it (an update run, a
 * restore) are exactly the ones a crash interrupts; answering the defaults
 * would re-open the installation to every session mid-window, silently. Root
 * still enters, and saving the maintenance widget rewrites the file clean.
 * Gate: test/unit/server_state_torn_native.test.ts.
 */
const UNREADABLE_STATE: ServerState = { ...DEFAULT_STATE, maintenance_mode: true };

/** Said once per distinct damage (the read is per request), never per call. */
let lastUnreadableReport: string | null = null;

function unreadableState(path: string, why: string): ServerState {
	const report = `${path}\n${why}`;
	if (report !== lastUnreadableReport) {
		lastUnreadableReport = report;
		console.error(
			`[server_state] ${path} exists but is not a readable state file (${why}) — FAILING CLOSED: maintenance mode is ON for every non-root session until root saves the maintenance settings again (which rewrites the file) or the file is repaired/removed`,
		);
	}
	return { ...UNREADABLE_STATE };
}

export function getServerState(): ServerState {
	const path = statePath();
	let raw: string;
	try {
		raw = readFileSync(path, 'utf8');
	} catch (error) {
		// No file is the legitimate first state (a box nothing wrote yet).
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			lastUnreadableReport = null;
			return { ...DEFAULT_STATE };
		}
		return unreadableState(path, (error as Error).message);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return unreadableState(
			path,
			raw.trim() === '' ? 'the file is empty' : (error as Error).message,
		);
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return unreadableState(path, 'the content is not a JSON object');
	}
	lastUnreadableReport = null;
	// `recovery_mode` is RETIRED (WC-2026-11-12-recovery-mode-retired): a file written
	// before keeps it, so it is dropped here — the next setServerState rewrites it clean.
	const { recovery_mode: _retired, ...stored } = parsed as Partial<ServerState> & {
		recovery_mode?: unknown;
	};
	return { ...DEFAULT_STATE, ...stored };
}

/**
 * ATOMIC AND DURABLE (core/files/durable.ts writeFileDurably: sibling temp →
 * fsync → rename → directory fsync): a reader, or a boot after a crash, sees the
 * previous state or the new one — never a truncated file. The file's mode is
 * kept (0644 on first write), since the rename replaces the inode.
 */
export function setServerState(patch: Partial<ServerState>): ServerState {
	const next = { ...getServerState(), ...patch };
	const path = statePath();
	mkdirSync(dirname(path), { recursive: true });
	let mode = 0o644;
	try {
		mode = statSync(path).mode & 0o777;
	} catch {
		// first write
	}
	writeFileDurably(path, `${JSON.stringify(next, null, '\t')}\n`, { mode });
	return next;
}
