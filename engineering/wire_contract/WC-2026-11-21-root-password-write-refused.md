# WC-2026-11-21-root-password-write-refused — no application door writes root's password; root's own save answers a typed 403

- **Date:** 2026-11-21 (S07; owner ruling 2026-11-19, RC plan decision 13, option c).
- **Decision:** owner ruling (S07 c). DEC-12 gate:
  `test/unit/root_password_write_refusal_native.test.ts`.
- **Narrows:** `WC-2026-08-28-root-self-service-write` — root keeps its own-record
  write of name (dd452), email (dd134), image (dd522) and UI preferences (dd1206);
  the PASSWORD (dd133) leaves that set of effects.

## Shape before (TS, 2026-08-28 → 2026-11-20)

A `dd_core_api save` from the root session for `dd128/-1`, component `dd133`,
answered `ok:true` and stored the new Argon2id hash (the self-service exception).
Below the API, nothing bound the record: any engine path reaching the record-write
chokepoint with that address and key wrote it — a Time Machine `apply_value` or
full-record restore of root's history, an import or a tool running as root, a bulk
revert.

(PHP: `security::user_can_access_record` refused every `section_id < 1`, so root's
password was never written through the API; it was set by the installer or at the
database.)

## Shape after (TS)

A write that CHANGES `dd133` of `dd128/-1` is refused by the record-write chokepoint
(`section_record/record_write.ts` §3j → `security/root_password_guard.ts`), for
every principal, root included, with nothing written:

```json
{ "ok": false,
  "error": { "code": "record.root_password_write_refused", "category": "permission",
             "label_key": "error_record_root_password_write_refused", "retryable": false } }
```

HTTP 403. Every chokepoint entry asks: the key entries and the atomic append (the
path names the key — any value, the current hash and a removal included), the
whole-record write (the key's stored value differs from the live row's, judged
under the row lock — a full-record restore that leaves the password as stored is
not refused) and the birth (the columns carry the key). A non-root caller is still
refused earlier, as before (`perm.out_of_scope`): the wire change is root's own
save, `ok:true` → this 403.

Not in the `perm.*` domain on purpose: the client's policy for that domain replaces
the page, and this refusal answers one field of a record root may otherwise edit —
it takes the default action (a toast with the label).

**Not refused — by construction, each driven by the gate:**

- the login-time COST UPGRADE (`auth.ts rehashStoredPassword`): the same password,
  proved at that login, re-hashed at the current cost. Recognised by the scope it
  already runs in (`revocation.ts runWithoutAccountRevocation`, one caller);
- the writers that never pass the chokepoint: the installer's first set
  (`install/root_pw.ts`, only over an empty password), the v6 → v7 conversion door
  (`legacy_password_migration.ts`, panel and `dedalo:migrate-passwords` — the owner
  ruling names it) and the suite's credential setter (`test_data/suite_login.ts`,
  marker-guarded).

The permission level is unchanged: `(dd128, dd133)` on root's own record still
resolves to 2 (`SELF_EDITABLE_COMPONENTS`), so the client still renders the field
editable for root. Whether to stamp it read-only is an open owner question.

## Reason

Root's password is the installation's most privileged credential, and a session
is not proof of the person: an unattended root session, a stolen cookie or a
tool running as root could replace it without knowing the current one. The owner
chose to close the door (option c) over a re-authentication step (option b,
post-7.0). The manual procedure (documented:
`docs/administration/users_and_permissions.md` → *Changing the root password*)
requires access to the server and the database, which is the authority the
credential stands for.

## Gate reconciliation

No parity fixture carries a write to `dd128/-1` (read-path store; root is excluded
from every read by `section_id > 0`). **No re-harvest.**
`root_password_write_refusal_native`: every `persist*` entry of the chokepoint
DRIVEN against root's record (list derived from the module — a new entry without
a probe is red), the human save door as root and as another principal,
`saveComponentData`, the raw-writer bypass census (derived), and the three
sanctioned writers driven for real. `root_user_hidden_tripwire`: "root can rotate
its own password" flipped to the refusal; root's own full-name save added as the
exception that remains.
