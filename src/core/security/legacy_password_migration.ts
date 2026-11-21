/**
 * THE v6 → v7 PASSWORD MIGRATION DOOR — one implementation, two callers.
 *
 * v6 stored passwords as reversible AES ciphertext; v7's login accepts Argon2id
 * only (auth.ts), and nothing upgrades an account on login any more
 * (WC-2026-11-19-legacy-aes-lazy-rehash-retired). This module converts the
 * accounts still on a v6 value: decrypt once with the v6 key material, hash with
 * Argon2id, write the hash back (legacy_password.ts rehashLegacyPassword — the
 * plaintext never leaves that function). Nobody chooses a new password.
 *
 * CALLERS: `scripts/migrate_v6_passwords.ts` (`bun run dedalo:migrate-passwords`,
 * the operator's CLI) and the `legacy_passwords` maintenance widget (owner
 * ruling 2026-11-19: "we need a way in the server to update the passwords").
 * Both get the SAME reading, the same conversion and the same report.
 *
 * WHAT NEVER LEAVES THIS MODULE: a stored password value (old or new), a
 * plaintext, the key material. The report is counts and account names.
 *
 * THE WRITE IS CONDITIONAL on the value that was read, under the row's lock
 * (the matrix writer home's own primitives — this module holds no DML): an
 * account whose password changed between the read and the write (an
 * administrator reset it meanwhile) is `skipped`, never overwritten with the
 * hash of the old password.
 *
 * NOT a record save, like the CLI before it: the value written is the same
 * password in the only form the engine accepts — an operator conversion of the
 * storage format, not an edit of the account — so it stamps no modification and
 * appends no Time Machine row (write_obligations_tripwire carries the reason).
 *
 * BUT EVERY RUN IS IN THE ACTIVITY LOG (owner ruling 2026-11-20: "actor,
 * accounts converted (user section_ids), counts, dry/execute"): who ran it (the
 * panel's principal; the command line's own identity), which accounts it
 * converted (user section_ids), the counts, and whether it wrote. A DRY run is
 * recorded too (`execute: false`, no converted id): it tries the typed key
 * values against every account, which is worth a trace. The door writes the
 * entry itself — a caller cannot run it unrecorded, and must name its actor to
 * call it at all — through the engine's one activity writer (logActivity →
 * matrix_activity, section dd542), as a SAVE on the maintenance area, like the
 * other audited maintenance door (publication_host_setup). The entry is counts
 * and ids: never a credential value, a hash, a plaintext or the key material.
 * Like every activity entry it is best-effort: a failed audit write is logged
 * on the server and does not undo (or fail) the conversion.
 */

import { AREA_MAINTENANCE_TIPO } from '../concepts/area.ts';
import { readMatrixKeyForUpdate, updateMatrixKeysData } from '../db/matrix_write.ts';
import { sql, withTransaction } from '../db/postgres.ts';
import { type LegacyKeyMaterial, rehashLegacyPassword } from './legacy_password.ts';
import { storedPasswordState } from './password_hash.ts';

const USERS_TABLE = 'matrix_users';
const USERS_SECTION_TIPO = 'dd128';
const USERNAME_COMPONENT = 'dd132';
const PASSWORD_COMPONENT = 'dd133';

/** One account, as a report may name it — never with a credential value. */
export interface LegacyAccountRef {
	section_id: number;
	username: string;
}

export interface LegacyPasswordCensus {
	/** Accounts that hold a stored password at all. */
	accounts: number;
	/** …of which already Argon2id. */
	argon2: number;
	/** …of which NOT Argon2id: the accounts the login refuses. */
	legacy: number;
}

export interface LegacyPasswordMigrationReport extends LegacyPasswordCensus {
	/** false = a dry run: nothing was written. */
	execute: boolean;
	/** Legacy accounts THIS call looked at (a batch, or all of them). */
	examined: number;
	/** The key material decrypts them (a dry run stops here). */
	recoverable: number;
	/** Written as Argon2id by this call (0 on a dry run). */
	converted: number;
	/** The key material does NOT decrypt them — wrong keys, or not a v6 value. */
	failed: number;
	/** Recoverable, but the stored value changed before the write: left alone. */
	skipped: number;
	/** Legacy accounts left in the table after this call. */
	remaining: number;
	/**
	 * Where the next batch starts (`afterSectionId`), or null when this call
	 * reached the end of the table. Always null without a `limit`.
	 */
	next_after: number | null;
	recoverable_accounts: LegacyAccountRef[];
	failed_accounts: LegacyAccountRef[];
}

export interface LegacyPasswordMigrationOptions {
	/** Write the hashes. Absent/false = dry run. */
	execute?: boolean;
	/** Look only at accounts with a section_id above this (batch cursor). */
	afterSectionId?: number;
	/** Look at no more than this many legacy accounts (absent = all). */
	limit?: number;
	/**
	 * TEST SEAM: awaited after an account's hash is computed and before it is
	 * written — where a concurrent password change lands. Production passes none.
	 */
	beforeWrite?: (sectionId: number) => Promise<void>;
}

/**
 * Who runs a conversion — what its activity entry names. The panel passes its
 * principal and the request's host; the command line has no session, so it runs
 * as root (as every CLI migration does) from host `cli`, and adds the operating
 * system account that typed the command.
 */
export interface ConversionActor {
	userId: number;
	/** The activity row's host (dd544). */
	host: string;
	via: 'panel' | 'cli';
	/** Command line only: the OS account that ran it. */
	osUser?: string;
}

/** The `action` every conversion entry carries — how a reader finds them. */
export const LEGACY_CONVERSION_ACTION = 'legacy_passwords.migrate';
/**
 * Converted ids per activity entry. An activity row has a ceiling
 * (activity_log.ts ACTIVITY_DATA_MAX_BYTES; a list is cut at 256 items), and the
 * command line converts a whole table in one run: a long run is several
 * entries, each complete, instead of one that the ceiling shortens.
 */
export const LEGACY_CONVERSION_IDS_PER_ENTRY = 200;

/** What one run did, as its activity entries say it. */
export interface ConversionRunFacts {
	/** false = a dry run: it examined, and wrote nothing. */
	execute: boolean;
	/** false = the run threw before its end; the ids are what it had written. */
	completed: boolean;
	examined: number;
	converted: number;
	skipped: number;
	/** The key material did not decrypt them. */
	unconverted: number;
	/** Legacy accounts left in the table; null when the run did not complete. */
	remaining: number | null;
	convertedSectionIds: readonly number[];
}

export interface ConversionActivityEntry {
	what: 'SAVE';
	tipo: string;
	userId: number;
	host: string;
	data: Record<string, unknown>;
}

/**
 * The activity entries of one run (dry or executed): one, or several when it converted
 * more accounts than an entry may list. Every entry carries the run's counts;
 * only the id list is split. PURE — and the only place the payload is built, so
 * what an entry can hold is decided here: counts, ids, the actor. No account
 * name, no credential.
 */
export function conversionActivityEntries(
	actor: ConversionActor,
	facts: ConversionRunFacts,
): ConversionActivityEntry[] {
	const ids = facts.convertedSectionIds;
	const parts = Math.max(1, Math.ceil(ids.length / LEGACY_CONVERSION_IDS_PER_ENTRY));
	return Array.from({ length: parts }, (_, index) => ({
		what: 'SAVE' as const,
		tipo: AREA_MAINTENANCE_TIPO,
		userId: actor.userId,
		host: actor.host,
		data: {
			msg: facts.execute
				? 'Dédalo v6 passwords converted to Argon2id'
				: 'Dédalo v6 passwords checked (dry run, nothing written)',
			action: LEGACY_CONVERSION_ACTION,
			via: actor.via,
			...(actor.osUser === undefined ? {} : { os_user: actor.osUser }),
			execute: facts.execute,
			completed: facts.completed,
			examined: facts.examined,
			converted: facts.converted,
			skipped: facts.skipped,
			unconverted: facts.unconverted,
			remaining: facts.remaining,
			converted_section_ids: ids.slice(
				index * LEGACY_CONVERSION_IDS_PER_ENTRY,
				(index + 1) * LEGACY_CONVERSION_IDS_PER_ENTRY,
			),
			part: index + 1,
			parts,
		},
	}));
}

/** Append a run's entries. logActivity never throws: an audit write does not undo a conversion. */
async function recordConversion(actor: ConversionActor, facts: ConversionRunFacts): Promise<void> {
	const { logActivity } = await import('../api/handlers/activity_log.ts');
	for (const entry of conversionActivityEntries(actor, facts)) await logActivity(entry);
}

interface PasswordRow {
	section_id: number;
	username: string | null;
	password: string;
	/** storedPasswordState(password) === 'legacy' — classified once, at the read. */
	legacy: boolean;
}

/**
 * Every account holding a stored password, in id order. The values stay in this
 * module. WHICH accounts hold one, and which of those are legacy, is not decided
 * by the statement: it fetches the value, and password_hash.ts
 * storedPasswordState — the one definition, the login's own — classifies it.
 */
async function readPasswordRows(): Promise<PasswordRow[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id,
		        string->$2->0->>'value' AS username,
		        string->$3->0->>'value' AS password
		   FROM matrix_users
		  WHERE section_tipo = $1
		    AND string ? $3
		  ORDER BY section_id`,
		[USERS_SECTION_TIPO, USERNAME_COMPONENT, PASSWORD_COMPONENT],
	)) as { section_id: unknown; username: string | null; password: string | null }[];
	return rows.flatMap((row) => {
		const state = storedPasswordState(row.password);
		if (state === 'none' || row.password === null) return [];
		return [
			{
				section_id: Number(row.section_id),
				username: row.username,
				password: row.password,
				legacy: state === 'legacy',
			},
		];
	});
}

function censusOf(rows: readonly PasswordRow[]): LegacyPasswordCensus {
	const legacy = rows.filter((row) => row.legacy).length;
	return { accounts: rows.length, argon2: rows.length - legacy, legacy };
}

/** How many accounts hold a password, and how many of them are still legacy. Reads only. */
export async function legacyPasswordCensus(): Promise<LegacyPasswordCensus> {
	return censusOf(await readPasswordRows());
}

/**
 * How many accounts the login refuses as legacy — the census's own number, for
 * the boot and `/health` (update/boot_state.ts refreshLegacyPasswordNotice): the
 * operator should learn of a locked-out user base from the log, not from the
 * first user who cannot get in.
 */
export async function countLegacyPasswordAccounts(): Promise<number> {
	return (await legacyPasswordCensus()).legacy;
}

/**
 * Write one hash over the value it was computed from — through the matrix
 * writer home (db/matrix_write.ts): the row is LOCKED, its password key read
 * under the lock, and the hash written only if that value is still `previous`.
 * False when it is not (changed or removed meanwhile, or the account is gone).
 */
async function writeHash(sectionId: number, previous: string, hash: string): Promise<boolean> {
	return withTransaction(async () => {
		const stored = await readMatrixKeyForUpdate(
			USERS_TABLE,
			USERS_SECTION_TIPO,
			sectionId,
			'string',
			PASSWORD_COMPONENT,
		);
		const current = (stored?.[0] as { value?: unknown } | undefined)?.value;
		if (current !== previous) return false;
		const written = await updateMatrixKeysData(USERS_TABLE, USERS_SECTION_TIPO, sectionId, [
			{
				column: 'string',
				key: PASSWORD_COMPONENT,
				value: [{ id: 1, value: hash, lang: 'lg-nolan' }],
			},
		]);
		return written === 1;
	});
}

const accountRef = (row: PasswordRow): LegacyAccountRef => ({
	section_id: row.section_id,
	username: row.username ?? `(no username, id ${row.section_id})`,
});

/** The legacy accounts one call looks at: past the cursor, at most `limit`. */
function selectBatch(
	rows: readonly PasswordRow[],
	options: LegacyPasswordMigrationOptions,
): { pending: PasswordRow[]; batch: PasswordRow[] } {
	const after = options.afterSectionId ?? Number.NEGATIVE_INFINITY;
	const pending = rows.filter((row) => row.legacy && row.section_id > after);
	return { pending, batch: pending.slice(0, options.limit ?? pending.length) };
}

interface BatchOutcome {
	recoverable: LegacyAccountRef[];
	failed: LegacyAccountRef[];
	/** The accounts WRITTEN, by section_id. */
	converted: number[];
	skipped: number;
	/** Accounts looked at so far (the whole batch, unless the run threw). */
	examined: number;
}

/** One account: hashed (the plaintext lives only inside rehashLegacyPassword), then — on execute — written. */
async function convertAccount(
	row: PasswordRow,
	material: LegacyKeyMaterial,
	options: LegacyPasswordMigrationOptions,
	outcome: BatchOutcome,
): Promise<void> {
	outcome.examined++;
	const hash = await rehashLegacyPassword(row.password, material);
	if (hash === null) {
		outcome.failed.push(accountRef(row));
		return;
	}
	outcome.recoverable.push(accountRef(row));
	if (options.execute !== true) return;
	await options.beforeWrite?.(row.section_id);
	if (await writeHash(row.section_id, row.password, hash)) outcome.converted.push(row.section_id);
	else outcome.skipped++;
}

/**
 * Convert (or, dry, only examine) the accounts still on a v6 password value.
 * See the module header for the contract; see {@link LegacyPasswordMigrationReport}
 * for what each count means.
 */
export async function migrateLegacyPasswords(
	material: LegacyKeyMaterial,
	actor: ConversionActor,
	options: LegacyPasswordMigrationOptions = {},
): Promise<LegacyPasswordMigrationReport> {
	const execute = options.execute === true;
	const rows = await readPasswordRows();
	const census = censusOf(rows);
	const { pending, batch } = selectBatch(rows, options);

	const outcome: BatchOutcome = {
		recoverable: [],
		failed: [],
		converted: [],
		skipped: 0,
		examined: 0,
	};
	/** The run's activity entry, dry or executed — also when the run is about to throw. */
	const record = (completed: boolean, remaining: number | null) =>
		recordConversion(actor, {
			execute,
			completed,
			examined: outcome.examined,
			converted: outcome.converted.length,
			skipped: outcome.skipped,
			unconverted: outcome.failed.length,
			remaining,
			convertedSectionIds: outcome.converted,
		});
	let remaining: number;
	try {
		for (const row of batch) {
			await convertAccount(row, material, options, outcome);
		}
		// Counted again, not derived: it is what /health and the next reader see.
		remaining = execute ? (await legacyPasswordCensus()).legacy : census.legacy;
	} catch (error) {
		// What was written before the failure stays written — and stays on record.
		await record(false, null);
		throw error;
	}
	await record(true, remaining);

	return {
		...census,
		execute,
		examined: batch.length,
		recoverable: outcome.recoverable.length,
		converted: outcome.converted.length,
		failed: outcome.failed.length,
		skipped: outcome.skipped,
		remaining,
		// More legacy accounts lie past this batch: the next one starts after its last.
		next_after: batch.length < pending.length ? (batch.at(-1)?.section_id ?? null) : null,
		recoverable_accounts: outcome.recoverable,
		failed_accounts: outcome.failed,
	};
}
