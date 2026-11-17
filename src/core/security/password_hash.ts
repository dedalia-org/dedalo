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
export function isArgon2Hash(value: unknown): boolean {
	return typeof value === 'string' && value.startsWith('$argon2');
}

/**
 * A legacy v6 password: reversible AES ciphertext keyed by DEDALO_INFORMATION,
 * NOT a hash. Never produced by v7; recognised so we neither re-hash it (which
 * would freeze the ciphertext as if it were a password) nor mistake it for one.
 */
export function isLegacyEncryptedPassword(value: unknown): boolean {
	return (
		typeof value === 'string' && value !== '' && !isArgon2Hash(value) && !value.startsWith('$')
	);
}

/**
 * Whether a STORED password value (an item array, or one item) can be replayed
 * as it is: every value empty or already an Argon2 hash — the PASS-THROUGH
 * RULE's own domain. Anything else in stored bytes is not a credential a replay
 * may mint a hash from: a legacy v6 ciphertext (hashed, it would freeze the
 * ciphertext as the password and end `migrate_v6_passwords`' recovery), or a
 * plaintext a pre-gate door stored. The restore doors refuse those
 * (write_value_gates.ts gateReplayedValue).
 */
export function isReplayablePasswordValue(value: unknown): boolean {
	const items = Array.isArray(value) ? value : [value];
	return items.every((item) => {
		const stored = storedPasswordOf(item);
		return typeof stored !== 'string' || stored === '' || isArgon2Hash(stored);
	});
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
