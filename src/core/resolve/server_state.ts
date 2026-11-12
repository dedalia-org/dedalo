/**
 * TS-NATIVE runtime state (the TS equivalent of PHP's config_core.php custom
 * overrides — DEDALO_MAINTENANCE_MODE_CUSTOM / DEDALO_NOTIFICATION_CUSTOM).
 * The PHP widgets write the PHP install's config file; a
 * coexisting TS server must not touch that, so the TS server keeps its OWN
 * state in <private>/ts_state.json and honors it in its own login flow:
 * maintenance mode refuses non-superuser logins.
 */

import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { privateDir, readEnv } from '../../config/env.ts';
import { DedaloError } from '../errors/dedalo_error.ts';

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
	const override = readEnv('DEDALO_TS_STATE_PATH');
	if (override !== undefined) return override;
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
	return join(privateDir, 'ts_state.json');
}

export function getServerState(): ServerState {
	try {
		const raw = readFileSync(statePath(), 'utf8');
		// `recovery_mode` is RETIRED (WC-2026-11-12-recovery-mode-retired): a file written
		// before keeps it, so it is dropped here — the next setServerState rewrites it clean.
		const { recovery_mode: _retired, ...stored } = JSON.parse(raw) as Partial<ServerState> & {
			recovery_mode?: unknown;
		};
		return { ...DEFAULT_STATE, ...stored };
	} catch {
		return { ...DEFAULT_STATE };
	}
}

export function setServerState(patch: Partial<ServerState>): ServerState {
	const next = { ...getServerState(), ...patch };
	const path = statePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, '\t')}\n`);
	return next;
}
