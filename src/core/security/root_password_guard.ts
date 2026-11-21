/**
 * ROOT'S PASSWORD IS NOT WRITTEN BY THE APPLICATION (S07 — owner ruling
 * 2026-11-19; WC-2026-11-21-root-password-write-refused).
 *
 * The password component (dd133) of the root user record (dd128/-1) is changed
 * by the documented manual procedure only (docs/administration/
 * users_and_permissions.md → "Changing the root password"). Every application
 * write door refuses to change it — for every principal, root included — with
 * ONE typed refusal, `record.root_password_write_refused`.
 *
 * WHERE. The rule is asked by the record-write chokepoint
 * (section_record/record_write.ts: the key entries, the atomic append, the
 * whole-record write and the birth), never by a door: the human save, the
 * relation and whole-record saves, the importers, the tools, the Time Machine's
 * apply_value / restore / bulk revert all end there, so none has a rule to
 * remember. No principal is read — there is no caller it would admit.
 *
 * WHAT IS NOT REFUSED, and why each is not a hole:
 *   - the LOGIN-TIME COST UPGRADE (auth.ts rehashStoredPassword): the SAME
 *     password, proved a millisecond earlier, re-hashed at the current cost —
 *     not a change of the credential. It is recognised by the scope it already
 *     runs in (revocation.ts runWithoutAccountRevocation — "this dd133 write is
 *     not an account transition", ONE caller, ALS-scoped, request-local).
 *     Without it a root password set by the manual procedure at a lower cost
 *     would stay below target forever.
 *   - the writers that do not pass the chokepoint at all, by design: the
 *     installer's first set (install/root_pw.ts — only over an EMPTY password),
 *     the v6 → v7 conversion door (legacy_password_migration.ts — the same
 *     password re-hashed, only over the value read) and the suite's credential
 *     setter (test_data/suite_login.ts — marker-guarded test data).
 *
 * Gate: test/unit/root_password_write_refusal_native.test.ts (every chokepoint
 * entry driven, census total by derivation; the sanctioned writers driven too).
 */

import { DedaloError } from '../errors/dedalo_error.ts';
import { accountRevocationSuppressedBy } from './revocation.ts';

const USERS_SECTION_TIPO = 'dd128';
const ROOT_SECTION_ID = -1;
/** dd133 — component_password of the users section. */
export const ROOT_PASSWORD_COMPONENT = 'dd133';

/** Is this record the root user record? Two compares: the hot path of every other write. */
export function isRootUserRecord(sectionTipo: string, sectionId: number): boolean {
	return sectionId === ROOT_SECTION_ID && sectionTipo === USERS_SECTION_TIPO;
}

/**
 * Refuse a write that changes root's password. `changedKeys` — the component
 * tipos the write changes on the record (a key entry: every key it names; a
 * whole-record write: the keys whose stored value differs). Throws; never
 * returns a verdict a caller could ignore.
 */
export function refuseRootPasswordWrite(
	target: { sectionTipo: string; sectionId: number },
	changedKeys: readonly string[],
	door: string,
): void {
	if (!isRootUserRecord(target.sectionTipo, target.sectionId)) return;
	if (!changedKeys.includes(ROOT_PASSWORD_COMPONENT)) return;
	if (accountRevocationSuppressedBy() !== undefined) return;
	throw new DedaloError('record.root_password_write_refused', {
		coordinates: {
			section_tipo: target.sectionTipo,
			section_id: target.sectionId,
			component_tipo: ROOT_PASSWORD_COMPONENT,
			door,
		},
	});
}
