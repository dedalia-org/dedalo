/**
 * ONE INSTALL, ONE PRIVATE DIRECTORY — the guard that keeps the installer's two
 * writes in the same place (B14).
 *
 * The installer writes `.env` into `installPrivateDir()` (DEDALO_INSTALL_PRIVATE_DIR,
 * else the engine's private dir) and the install status into the engine's state file
 * (`statePath()`: DEDALO_TS_STATE_PATH, else `<DEDALO_PRIVATE_DIR>/ts_state.json`).
 * Redirect only the first and the second still lands in the LIVE private dir: a
 * scratch run then marks the live installation `terminal_installing`, and its server
 * refuses to boot (measured 2026-11-07 — a probe script outside `bun test` did exactly
 * that). So a run whose state file is not in its install's private dir is refused
 * before anything is written.
 *
 * An explicit DEDALO_TS_STATE_PATH is the operator (or `bun test`'s preload) naming
 * the state file on purpose, and is honoured as such.
 *
 * Callers: persistConfig (the door every front end writes through) and the
 * executor's pre-flight (which refuses before the database is even looked at).
 * Gate: test/unit/install_persist_config.test.ts.
 */

import { dirname, resolve } from 'node:path';
import { readEnv } from '../../config/env.ts';
import { statePath } from '../resolve/server_state.ts';
import { installPrivateDir } from './paths.ts';

/** Why the state file and the install's private dir disagree; null when they agree. */
export function statePathOutsidePrivateDir(): string | null {
	if (readEnv('DEDALO_TS_STATE_PATH') !== undefined) return null;
	if (resolve(dirname(statePath())) === resolve(installPrivateDir())) return null;
	return `the server state file (${statePath()}) is not in the install's private dir (${installPrivateDir()}) — set DEDALO_PRIVATE_DIR (or DEDALO_TS_STATE_PATH) so both point at the same place`;
}
