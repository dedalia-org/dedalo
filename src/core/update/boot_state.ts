/**
 * BOOT STATE — what this process learned about its own schema and data at boot
 * (update audit 2026-10-29, U-01 / U-04).
 *
 * Four facts, all request-INDEPENDENT process-lifecycle state (same class as
 * process_health.ts's poison latch — module_state_tripwire allowlist):
 *
 *  - the BOOT SCHEMA verdict: did this boot's migration run succeed? A failed
 *    run used to be one journal line while /health stayed green and the update
 *    sentinel was confirmed, disarming every rollback. The verdict now feeds
 *    /health (red on failure) and the confirmation (refused on failure).
 *
 *  - the DATA VERSION state: the installed data version (matrix_updates) against
 *    the data version this code declares (DEDALO_DATA_VERSION). Nothing read it at
 *    boot, so code could serve a database it was not written for, unflagged.
 *    `pending` = the database is BEHIND the code (an "Update data" is due);
 *    `ahead` = the database is NEWER than the code (old code restored over a
 *    migrated database — VERSIONING_SPEC S7: needs a human, never served green).
 *    `unreachable` = the database is of an OLDER MAJOR than any rung of the
 *    catalog starts at (a Dédalo v6 database): no "Update data" of this engine
 *    can move it — its migration runs on the engine that owns it. Red (T2 D08-b).
 *
 *  - the LEGACY PASSWORD count (T2 D08-a): accounts whose stored password is not
 *    Argon2id — they cannot log in until `bun run dedalo:migrate-passwords` ran.
 *    A boot warning and a /health notice; never red.
 *
 *  - the UPDATE RUN facts (design §3.5): the run in flight and whether it owns
 *    this boot — /health carries them, and a run applying pending schema/data
 *    is not "red" for being in the middle of its job.
 *
 * Leaf-ish: no DB access here; the readers are injected by the boot (server.ts)
 * and by the data engine after a committed rung, so this module stays pure.
 */

import type { BootSchemaVerdict } from '../../../install/db/migrate.ts';
import { MIGRATE_PASSWORDS_COMMAND } from '../security/legacy_password_command.ts';
import { lowestReachableFrom } from './catalog.ts';
import { compareVersionArrays, DEDALO_DATA_VERSION, formatVersion } from './version.ts';

/** Installed data version vs the code's declared one. */
export type DataVersionStateName = 'ok' | 'pending' | 'ahead' | 'unreachable' | 'unknown';

export interface DataVersionState {
	state: DataVersionStateName;
	/** The installed data version (matrix_updates), or null when it could not be read / is absent. */
	installed: string | null;
	/** The data version this code declares. */
	code: string;
}

/** The boot schema verdict as /health reports it (`skipped`: a smoke boot, or not run yet). */
export type BootSchemaStateName = 'ok' | 'failed' | 'skipped';

/**
 * The update run as /health reports it (design §3.5): the run in flight, or the
 * last one this process ended. `owns_boot`: a run in flight claimed this boot —
 * its schema phase, not the boot runner, applies the migrations.
 */
export interface UpdateRunFacts {
	run_id: string;
	state: string;
	/** The release identity the run installs. */
	target: string;
	owns_boot: boolean;
	/** This process runs the tree the run installs (executor.ts runsTargetTree). */
	on_target: boolean;
}

interface BootStateFacts {
	schema: BootSchemaVerdict | null;
	data: DataVersionState | null;
	run: UpdateRunFacts | null;
	/** Accounts on a non-Argon2 stored password; null = not counted (or unreadable). */
	legacyPasswords: number | null;
	/** When that count was taken (ms epoch); 0 = never. */
	legacyPasswordsAt: number;
	/** The boot's counter, kept so the count can be taken again; null = no boot count. */
	legacyPasswordCounter: (() => Promise<number>) | null;
	/** The recount in flight (single-flight), or null. */
	legacyPasswordRecount: Promise<number | null> | null;
	/**
	 * Raised by every count this process records itself (boot, panel, run). A
	 * recount whose query started under an older generation saw an older table:
	 * its count is dropped, never written over the newer one.
	 */
	legacyPasswordGeneration: number;
}

const bootState: BootStateFacts = {
	schema: null,
	data: null,
	run: null,
	legacyPasswords: null,
	legacyPasswordsAt: 0,
	legacyPasswordCounter: null,
	legacyPasswordRecount: null,
	legacyPasswordGeneration: 0,
};

/** Record the update run's facts (the boot's journal read, then every executor step). */
export function recordUpdateRunFacts(facts: UpdateRunFacts | null): void {
	bootState.run = facts;
}

/** The update run's facts, or null when no run concerns this process. */
export function updateRunFacts(): UpdateRunFacts | null {
	return bootState.run;
}

/** Record this boot's schema verdict (server.ts, once, after runBootSchema). */
export function recordBootSchemaVerdict(verdict: BootSchemaVerdict): void {
	bootState.schema = verdict;
}

/** This boot's schema verdict, or null when no migration run happened (smoke boot / tests). */
export function bootSchemaVerdict(): BootSchemaVerdict | null {
	return bootState.schema;
}

/** The /health spelling of the schema verdict. */
export function bootSchemaStateName(): BootSchemaStateName {
	return bootState.schema === null ? 'skipped' : bootState.schema.state;
}

/**
 * On a FAILED run only: whether it moved the schema (null = unknown, read as
 * moved by the confirmation). Undefined otherwise — /health omits the key.
 */
export function bootSchemaMoved(): boolean | null | undefined {
	return bootState.schema?.state === 'failed' ? bootState.schema.schemaMoved : undefined;
}

/**
 * Classify an installed data version against the code's. `installed` null = it
 * could not be read (unknown); `[]` = no version row (a database that never
 * recorded one — reported as unknown, never as ok).
 *
 * `unreachable` is CATALOG-DERIVED: the installed MAJOR is below the major of
 * `lowestFrom`, the lowest from-version any rung starts at (catalog.ts
 * lowestReachableFrom) — behind the code like `pending`, but no rung of this
 * engine will ever move it. Judged on the major only: inside a reachable major
 * the rung walk decides, as before.
 */
export function classifyDataVersion(
	installed: readonly number[] | null,
	code: readonly number[],
	lowestFrom: readonly number[] = lowestReachableFrom(),
): DataVersionState {
	const codeText = formatVersion(code);
	if (installed === null || installed.length === 0) {
		return { state: 'unknown', installed: null, code: codeText };
	}
	return {
		state: stateOfInstalled(installed, code, lowestFrom),
		installed: formatVersion(installed),
		code: codeText,
	};
}

/** The state of a READ, non-empty installed version (see classifyDataVersion). */
function stateOfInstalled(
	installed: readonly number[],
	code: readonly number[],
	lowestFrom: readonly number[],
): DataVersionStateName {
	const order = compareVersionArrays(installed, code);
	if (order === 0) return 'ok';
	if (order > 0) return 'ahead';
	return majorOf(installed) < majorOf(lowestFrom) ? 'unreachable' : 'pending';
}

/** A version's major (a missing segment counts as 0, as everywhere in version.ts). */
function majorOf(version: readonly number[]): number {
	return version[0] ?? 0;
}

/** Where the migration of a database of an older major is documented (the manual, in the repo). */
const OLDER_MAJOR_MIGRATION_DOC = 'docs/install/migrating_from_v6.md';

/**
 * What to do about a database this engine cannot update — ONE sentence, the same
 * on the boot line, the code-update door and the Update-data panel; null for
 * every other state (each has its own wording where it is reported).
 */
export function dataVersionAdvice(state: DataVersionState): string | null {
	const facts = dataVersionAdviceFacts(state);
	if (facts === null) return null;
	return `the database is on data version ${facts.installed}, a Dédalo v${facts.installed_major} database: this engine (${facts.engine}) has no update that starts from it — run the v${facts.installed_major} → v${facts.engine_major} migration on the v${facts.installed_major} installation first (${facts.doc})`;
}

/** The values {@link dataVersionAdvice} is made of — what a screen needs to say it in its own language. */
export interface DataVersionAdviceFacts {
	/** The one advice this engine gives (a closed set of one, today). */
	code: 'data_version_unreachable';
	/** The installed data version (`6.9.1`). */
	installed: string;
	/** The data version this engine declares (`7.0.0`). */
	engine: string;
	installed_major: string;
	engine_major: string;
	/** Where that migration is documented (a path in the manual). */
	doc: string;
}

/**
 * The facts of {@link dataVersionAdvice}, for a consumer that words the advice
 * itself (the Update-data panel: a label per language, these values in its
 * placeholders). Null exactly when the advice is — the two cannot disagree,
 * the sentence is built from this.
 */
export function dataVersionAdviceFacts(state: DataVersionState): DataVersionAdviceFacts | null {
	if (state.state !== 'unreachable') return null;
	return {
		code: 'data_version_unreachable',
		installed: String(state.installed),
		engine: state.code,
		installed_major: String(state.installed).split('.')[0] ?? '',
		engine_major: state.code.split('.')[0] ?? '',
		doc: OLDER_MAJOR_MIGRATION_DOC,
	};
}

/**
 * Re-read and record the data version state. `read` is the strict reader
 * (backup.ts readInstalledDataVersionStrict); a read failure records `unknown`.
 * Called at boot and after a committed data rung, so /health follows "Update
 * data" without a restart.
 */
export async function refreshDataVersionState(
	read: () => Promise<number[]>,
	code: readonly number[] = DEDALO_DATA_VERSION,
): Promise<DataVersionState> {
	let installed: number[] | null;
	try {
		installed = await read();
	} catch (error) {
		console.error('[boot] installed data version unreadable (reported as unknown):', error);
		installed = null;
	}
	const state = classifyDataVersion(installed, code);
	bootState.data = state;
	if (state.state === 'pending') {
		console.warn(
			`[boot] DATA UPDATE PENDING: the database is on data version ${state.installed}, this code declares ${state.code} — run "Update data" in the maintenance area before using the new version`,
		);
	} else if (state.state === 'unreachable') {
		console.error(
			`[boot] DATABASE NOT MIGRATED: ${dataVersionAdvice(state)} (/health is red until then)`,
		);
	} else if (state.state === 'ahead') {
		console.error(
			`[boot] DATA VERSION AHEAD OF CODE: the database is on data version ${state.installed}, this code declares ${state.code} — older code over a newer database; restore a compatible backup or install the matching code (/health is red until then)`,
		);
	}
	return state;
}

/** The last recorded data version state, or null before the first refresh. */
export function dataVersionState(): DataVersionState | null {
	return bootState.data;
}

/**
 * Count the accounts whose stored password is not an Argon2id hash and tell the
 * operator at boot (T2 D08-a): those accounts cannot log in — the PHP engine's
 * upgrade-on-next-login is retired (WC-2026-11-19-legacy-aes-lazy-rehash-retired)
 * — and the fix is one command. Recorded for /health, which carries a NOTICE
 * (never red: the engine is healthy; never the number: the probe answers anyone).
 * A count that cannot be read is said and recorded as null — never guessed.
 * `count` is injected by the boot (legacy_password_migration.ts
 * countLegacyPasswordAccounts): this
 * module reads no database. The counter is KEPT: the fix may run in another
 * process (`bun run dedalo:migrate-passwords`), so /health re-takes the count
 * through {@link currentLegacyPasswordAccounts} — the notice must not outlive
 * the condition until the next restart. The maintenance panel's run is in THIS
 * process and reports its own count ({@link recordLegacyPasswordAccounts}).
 */
export async function refreshLegacyPasswordNotice(
	count: () => Promise<number>,
	now: number = Date.now(),
): Promise<number | null> {
	bootState.legacyPasswordCounter = count;
	const accounts = await countLegacyPasswords(count, '[boot]');
	bootState.legacyPasswords = accounts;
	bootState.legacyPasswordsAt = now;
	bootState.legacyPasswordGeneration += 1;
	if (accounts !== null && accounts > 0) {
		console.warn(
			`[boot] LEGACY PASSWORDS: ${accounts} account(s) still hold a Dédalo v6 password value (not Argon2id) and cannot log in — run \`${MIGRATE_PASSWORDS_COMMAND}\` against this database, or convert them in Maintenance → Legacy passwords (docs/install/migrating_from_v6.md, "Migrate the passwords"); nobody has to choose a new password`,
		);
	}
	return accounts;
}

/** One count; a failure is said and answered as null (not counted) — never a guess. */
async function countLegacyPasswords(
	count: () => Promise<number>,
	tag: string,
): Promise<number | null> {
	try {
		return await count();
	} catch (error) {
		console.error(`${tag} legacy password accounts could not be counted:`, error);
		return null;
	}
}

/** The last counted legacy-password accounts, or null when not counted. */
export function legacyPasswordAccounts(): number | null {
	return bootState.legacyPasswords;
}

/**
 * How long a legacy-password count is served before /health takes it again. The
 * probe answers anyone, so the count is NOT taken per call: at most one query
 * per window, whatever the traffic.
 */
export const LEGACY_PASSWORD_RECOUNT_MS = 60_000;

/**
 * The legacy-password count /health serves (T2 B1 review, S3-5/7): the boot's
 * count while it is younger than {@link LEGACY_PASSWORD_RECOUNT_MS}, else taken
 * again with the boot's own counter — one recount in flight at a time, shared by
 * every caller that arrives meanwhile. So the notice goes away within a minute
 * of `bun run dedalo:migrate-passwords` (another process: nothing can tell this
 * one), and appears within a minute of an account being put back on a legacy
 * value — no restart either way. A process whose boot never counted (a smoke
 * boot) has no counter and answers what is recorded. A change is logged once.
 */
export async function currentLegacyPasswordAccounts(
	now: number = Date.now(),
): Promise<number | null> {
	const count = bootState.legacyPasswordCounter;
	if (count === null) return bootState.legacyPasswords;
	if (now - bootState.legacyPasswordsAt < LEGACY_PASSWORD_RECOUNT_MS) {
		return bootState.legacyPasswords;
	}
	bootState.legacyPasswordRecount ??= (async () => {
		const generation = bootState.legacyPasswordGeneration;
		try {
			const accounts = await countLegacyPasswords(count, '[health]');
			// A count recorded meanwhile (the panel's run) is NEWER than this
			// query's view of the table: it stands, and so does its window.
			if (bootState.legacyPasswordGeneration !== generation) return bootState.legacyPasswords;
			const before = bootState.legacyPasswords;
			bootState.legacyPasswords = accounts;
			bootState.legacyPasswordsAt = now;
			if (accounts !== null && before !== null && accounts !== before) {
				console.warn(
					accounts === 0
						? `[health] LEGACY PASSWORDS: none left (was ${before}) — the /health notice is withdrawn`
						: `[health] LEGACY PASSWORDS: ${accounts} account(s) still hold a Dédalo v6 password value (was ${before}) — run \`${MIGRATE_PASSWORDS_COMMAND}\` against this database`,
				);
			}
			return accounts;
		} finally {
			bootState.legacyPasswordRecount = null;
		}
	})();
	return bootState.legacyPasswordRecount;
}

/**
 * A count taken by THIS process outside the recount window — the maintenance
 * panel's read, or its migration run (area_maintenance/widgets/legacy_passwords.ts):
 * /health answers it at once instead of up to {@link LEGACY_PASSWORD_RECOUNT_MS}
 * later (owner 2026-11-19: after a run the notice must follow). The window
 * restarts here; a change is logged once, as the recount does. A /health
 * recount in flight took its count BEFORE this one: it is dropped when it lands.
 */
export function recordLegacyPasswordAccounts(accounts: number, now: number = Date.now()): void {
	const before = bootState.legacyPasswords;
	bootState.legacyPasswords = accounts;
	bootState.legacyPasswordsAt = now;
	bootState.legacyPasswordGeneration += 1;
	if (before !== null && accounts !== before) {
		console.warn(
			accounts === 0
				? `[maintenance] LEGACY PASSWORDS: none left (was ${before}) — the /health notice is withdrawn`
				: `[maintenance] LEGACY PASSWORDS: ${accounts} account(s) still hold a Dédalo v6 password value (was ${before})`,
		);
	}
}

/** TEST-ONLY: forget every fact (the state is process-global by design). */
export function resetBootStateForTest(): void {
	bootState.schema = null;
	bootState.data = null;
	bootState.run = null;
	bootState.legacyPasswords = null;
	bootState.legacyPasswordsAt = 0;
	bootState.legacyPasswordCounter = null;
	bootState.legacyPasswordRecount = null;
	bootState.legacyPasswordGeneration = 0;
}
