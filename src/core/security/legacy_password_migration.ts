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
 */

import { readMatrixKeyForUpdate, updateMatrixKeysData } from '../db/matrix_write.ts';
import { sql, withTransaction } from '../db/postgres.ts';
import { type LegacyKeyMaterial, rehashLegacyPassword } from './legacy_password.ts';
import { isArgon2Hash } from './password_hash.ts';

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

interface PasswordRow {
	section_id: number;
	username: string | null;
	password: string;
}

/** Every account holding a stored password, in id order. The values stay in this module. */
async function readPasswordRows(): Promise<PasswordRow[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id,
		        string->$2->0->>'value' AS username,
		        string->$3->0->>'value' AS password
		   FROM matrix_users
		  WHERE section_tipo = $1
		    AND COALESCE(string->$3->0->>'value', '') <> ''
		  ORDER BY section_id`,
		[USERS_SECTION_TIPO, USERNAME_COMPONENT, PASSWORD_COMPONENT],
	)) as { section_id: unknown; username: string | null; password: string }[];
	return rows.map((row) => ({ ...row, section_id: Number(row.section_id) }));
}

function censusOf(rows: readonly PasswordRow[]): LegacyPasswordCensus {
	const argon2 = rows.filter((row) => isArgon2Hash(row.password)).length;
	return { accounts: rows.length, argon2, legacy: rows.length - argon2 };
}

/** How many accounts hold a password, and how many of them are still legacy. Reads only. */
export async function legacyPasswordCensus(): Promise<LegacyPasswordCensus> {
	return censusOf(await readPasswordRows());
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
	const pending = rows.filter((row) => !isArgon2Hash(row.password) && row.section_id > after);
	return { pending, batch: pending.slice(0, options.limit ?? pending.length) };
}

interface BatchOutcome {
	recoverable: LegacyAccountRef[];
	failed: LegacyAccountRef[];
	converted: number;
	skipped: number;
}

/** One account: hashed (the plaintext lives only inside rehashLegacyPassword), then — on execute — written. */
async function convertAccount(
	row: PasswordRow,
	material: LegacyKeyMaterial,
	options: LegacyPasswordMigrationOptions,
	outcome: BatchOutcome,
): Promise<void> {
	const hash = await rehashLegacyPassword(row.password, material);
	if (hash === null) {
		outcome.failed.push(accountRef(row));
		return;
	}
	outcome.recoverable.push(accountRef(row));
	if (options.execute !== true) return;
	await options.beforeWrite?.(row.section_id);
	if (await writeHash(row.section_id, row.password, hash)) outcome.converted++;
	else outcome.skipped++;
}

/**
 * Convert (or, dry, only examine) the accounts still on a v6 password value.
 * See the module header for the contract; see {@link LegacyPasswordMigrationReport}
 * for what each count means.
 */
export async function migrateLegacyPasswords(
	material: LegacyKeyMaterial,
	options: LegacyPasswordMigrationOptions = {},
): Promise<LegacyPasswordMigrationReport> {
	const execute = options.execute === true;
	const rows = await readPasswordRows();
	const census = censusOf(rows);
	const { pending, batch } = selectBatch(rows, options);

	const outcome: BatchOutcome = { recoverable: [], failed: [], converted: 0, skipped: 0 };
	for (const row of batch) {
		await convertAccount(row, material, options, outcome);
	}

	return {
		...census,
		execute,
		examined: batch.length,
		recoverable: outcome.recoverable.length,
		converted: outcome.converted,
		failed: outcome.failed.length,
		skipped: outcome.skipped,
		// Counted again, not derived: it is what /health and the next reader see.
		remaining: execute ? (await legacyPasswordCensus()).legacy : census.legacy,
		// More legacy accounts lie past this batch: the next one starts after its last.
		next_after: batch.length < pending.length ? (batch.at(-1)?.section_id ?? null) : null,
		recoverable_accounts: outcome.recoverable,
		failed_accounts: outcome.failed,
	};
}
