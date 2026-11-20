/**
 * PASSWORD HASHING — the ONE place a password value becomes storable.
 *
 * `component_password` (dd133 on the users section) is, to the generic write
 * engine, an ordinary string component: its descriptor declares `column:'string'`
 * and nothing else. Without this chokepoint the client's PLAINTEXT would be
 * written straight into `matrix_users.string.dd133` — and would then also fail
 * every login, because `auth.ts` accepts ONLY Argon2id (`$argon2…`). PHP hashed on
 * the way in (`component_password::Save` → `hash_password`); this is the TS twin.
 *
 * ALGORITHM: Argon2id (`Bun.password`), the same PHP v7 used
 * (`password_hash($pw, PASSWORD_ARGON2ID)`) — the two are interoperable, which is
 * why a hash written by either engine verifies against the other. The per-password
 * random salt is embedded IN the hash string, so no global salt exists (v6's
 * DEDALO_SALT_STRING never was one — it seeded a session token).
 *
 * PASS-THROUGH RULE: a value that is ALREADY a hash is stored verbatim. Re-hashing
 * it would double-wrap and lock the user out, and it is what makes an export→import
 * round-trip (and the v6 password re-hash migration) work: those replay stored
 * hashes, not plaintext.
 */

import { ARGON2_OPTIONS } from './argon2_params.ts';
import { assertPasswordPolicy } from './password_policy.ts';

/** An Argon2 (any variant) PHC string, as produced by Bun.password / PHP password_hash. */
export function isArgon2Hash(value: unknown): value is string {
	return typeof value === 'string' && value.startsWith('$argon2');
}

/**
 * How a stored dd133 value stands with the login — THE ONE DEFINITION of a
 * "legacy account" (T2 B1 review LOW-1: the login, the /health counter and the
 * conversion door each spelled their own):
 *   `none`    no password at all (absent, null, empty) — not a legacy account;
 *   `argon2`  an Argon2 hash: the only form the login verifies;
 *   `legacy`  anything else — above all v6's reversible AES value. The login
 *             refuses it, /health counts it, the conversion door examines it.
 * Read by auth.ts (the refusal) and legacy_password_migration.ts (the census,
 * the batch, and through the census the boot / `/health` count). No SQL
 * predicate restates it: the readers fetch the value and ask here.
 */
export type StoredPasswordState = 'none' | 'argon2' | 'legacy';

export function storedPasswordState(value: unknown): StoredPasswordState {
	if (value === null || value === undefined || value === '') return 'none';
	return isArgon2Hash(value) ? 'argon2' : 'legacy';
}

/**
 * A legacy v6 password: reversible AES ciphertext keyed by DEDALO_INFORMATION,
 * NOT a hash. Never produced by v7; recognised so a REPLAY of stored bytes
 * (write_value_gates.ts gateReplayedValue) puts it back verbatim — hashed, the
 * ciphertext would be frozen as if it were the password and
 * `scripts/migrate_v6_passwords.ts` could never convert it.
 *
 * THE DISCRIMINATOR IS THE v6 STORAGE FORMAT, nothing looser (C58, owner ruling
 * 2026-11-18). v6 stored `base64( openssl_encrypt(serialize($pw),
 * 'AES-256-CBC', …, 0, $iv) )` and `openssl_encrypt` with options 0 already
 * answers base64 (legacy_password.ts), so the stored value is:
 *   - CANONICAL base64 (alphabet, padding, length — it re-encodes to itself),
 *   - whose decoded bytes are AGAIN canonical base64 text,
 *   - whose decoded bytes are a non-empty whole number of 16-byte AES blocks.
 * "A non-empty string that is no hash" — the test this replaced — is also what
 * a plaintext a pre-gate door stored looks like, and a replay must never write
 * a plaintext.
 *
 * RESIDUAL (stated, not hidden): the key material is not in a v7 install (the
 * config migration drops it), so this cannot DECRYPT — it recognises the shape.
 * A plaintext that is itself a double-base64 of an AES-block-sized body passes;
 * a human password is not one (the outer layer alone must decode to pure
 * base64 text, 1 chance in 4 per byte over ≥ 24 bytes), and a value crafted to
 * pass is replayed as the inert string it is: `auth.ts` accepts only Argon2id,
 * so it is no working credential, and the migration script reports it
 * undecryptable.
 */
export function isLegacyEncryptedPassword(value: unknown): boolean {
	if (typeof value !== 'string') return false;
	const inner = canonicalBase64Bytes(value);
	if (inner === null) return false;
	const cipher = canonicalBase64Bytes(inner.toString('latin1'));
	return cipher !== null && cipher.length % AES_BLOCK_BYTES === 0;
}

const AES_BLOCK_BYTES = 16;
const BASE64_TEXT = /^[A-Za-z0-9+/]+={0,2}$/;

/** The bytes `text` encodes when it is CANONICAL, non-empty base64; else null. */
function canonicalBase64Bytes(text: string): Buffer | null {
	if (text.length % 4 !== 0 || !BASE64_TEXT.test(text)) return null;
	const bytes = Buffer.from(text, 'base64');
	return bytes.toString('base64') === text ? bytes : null;
}

/**
 * Whether a STORED password value (an item array, or one item) can be replayed
 * as it is: every value empty, already an Argon2 hash — the PASS-THROUGH RULE's
 * own domain — or a legacy v6 ciphertext ({@link isLegacyEncryptedPassword}:
 * the state the upgrade leaves and the migration recovers from, no working
 * credential). Anything else in stored bytes is a plaintext a pre-gate door
 * stored: never written back, never minted into a hash. The restore doors
 * refuse it (write_value_gates.ts gateReplayedValue).
 */
export function isReplayablePasswordValue(value: unknown): boolean {
	const items = Array.isArray(value) ? value : [value];
	return items.every((item) => isReplayablePassword(storedPasswordOf(item)));
}

/** One stored password: not a string, empty, a hash, or a v6 ciphertext. */
function isReplayablePassword(stored: unknown): boolean {
	if (typeof stored !== 'string' || stored === '') return true;
	return isArgon2Hash(stored) || isLegacyEncryptedPassword(stored);
}

/** The password an item carries: its `value` (the `{id, value, lang}` shape), or the bare item. */
function storedPasswordOf(item: unknown): unknown {
	return item !== null && typeof item === 'object' ? (item as { value?: unknown }).value : item;
}

/**
 * Hash one incoming password value for storage.
 * - already an Argon2 hash → verbatim (see PASS-THROUGH RULE)
 * - empty / null → verbatim (the caller means "no change"/"no password")
 * - anything else → treated as PLAINTEXT and Argon2id-hashed
 */
export async function hashPasswordForStorage(value: unknown): Promise<unknown> {
	if (typeof value !== 'string' || value === '') return value;
	if (isArgon2Hash(value)) return value;
	return await Bun.password.hash(value, ARGON2_OPTIONS);
}

/**
 * The item shape the write engine carries for a literal component:
 * `{ id, value, lang }`. Hash the `value` in place, leaving everything else alone.
 */
async function hashItem(item: unknown): Promise<unknown> {
	if (item === null || typeof item !== 'string') {
		if (item !== null && typeof item === 'object' && 'value' in (item as object)) {
			const record = item as { value: unknown };
			return { ...record, value: await hashNewPassword(record.value) };
		}
		return item;
	}
	// A bare string item (some doors send the value unwrapped).
	return await hashNewPassword(item);
}

/**
 * A save carries a NEW password: plaintext must satisfy the policy before it is
 * hashed (password_policy.ts). A replayed hash and an empty value are not new
 * passwords and pass through `hashPasswordForStorage` untouched.
 */
async function hashNewPassword(value: unknown): Promise<unknown> {
	if (typeof value === 'string' && value !== '' && !isArgon2Hash(value)) {
		assertPasswordPolicy(value);
	}
	return await hashPasswordForStorage(value);
}

/**
 * Hash every password value carried by a save's changed_data, refusing a new
 * plaintext that breaks the password policy (`validation.password_policy`). Applied by
 * `save_component.ts` for model `component_password` ONLY — every write door
 * (client API, MCP tools, the agent change-plan, import) funnels through there, so
 * this is the single gate.
 */
export async function hashPasswordChanges<T extends { value: unknown }>(
	changes: readonly T[],
): Promise<T[]> {
	const out: T[] = [];
	for (const change of changes) {
		if (Array.isArray(change.value)) {
			const items: unknown[] = [];
			for (const item of change.value) items.push(await hashItem(item));
			out.push({ ...change, value: items });
			continue;
		}
		out.push({ ...change, value: await hashItem(change.value) });
	}
	return out;
}
