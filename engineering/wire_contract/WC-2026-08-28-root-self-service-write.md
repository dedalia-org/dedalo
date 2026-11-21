# WC-2026-08-28-root-self-service-write — an account may write its OWN four self-editable components on its OWN record, root (dd128/-1) included

- **Date:** 2026-08-28 (deep audit 2026-08-26, finding SEC-05; reviewer round on the
  REVOCATION class, must-fix 5).
- **Decision:** DEC-15 (a deliberate divergence from the frozen PHP, argued below).
  DEC-12 (the gate lands in the same change:
  `test/unit/root_user_hidden_tripwire.test.ts`).
- **Companion:** `WC-2026-08-28-login-active-account.md` — the same change's revocation
  seam. Read the two together: this entry is the ONE hole deliberately left in the
  non-positive-id refusal that entry relies on.

## Shape before

**PHP.** `security::user_can_access_record` (`class.security.php:1007-1009`) returns
false for any `section_id < 1`, unconditionally and for every caller, with no
own-record exception. Root's password was therefore not rewritable through the PHP API
either; it was rotated at the database, or by the installer.

**TS through 2026-08-27.** The three record-lifecycle doors (save, duplicate, delete)
each wrote the scope check as `if (!principal.isGlobalAdmin) { isRecordInScope(...) }`,
which inlines the admin bypass ABOVE the non-positive-id refusal. For an admin-flagged
principal the refusal never executed at all, so **root's password was rewritable by any
global admin holding a level-2 grant on `(dd128, dd133)`** — a precondition met at both
real installations measured for SEC-05. That is the finding.

**TS on 2026-08-28, first shape (SEC-05 fix, before this entry).** The doors were moved
onto `assertRecordWriteTarget`, which refuses `section_id < 1` ahead of the bypass, for
every caller. Correct for the finding — and it took something nobody decided to take:

- root could no longer change its OWN password (dd133) or its OWN email (dd134);
- `password_reset.ts` excludes root from the emailed recovery flow by the same `id > 0`
  rule, so there was no second route;
- which left an installation with **no in-engine way to rotate its most privileged
  credential**, and the only remaining procedure was an operator writing an Argon2id hash
  into `matrix_users` by hand.

The first report of that change under-disclosed it as "the engine has no door for
changing root password", as though it had always been so. It had not: the door existed
and was closed by that change.

## Shape after (TS)

`assertRecordWriteTarget` takes one named option, `selfServiceAccountWrite`, and returns
early when it is true **and** `sectionId === principal.userId`. The save door computes it
through `permissions.isSelfServiceAccountWrite`, which is true only when ALL of:

| condition | why |
|---|---|
| `section_tipo === 'dd128'` | the users section is the only place a legitimate record carries a non-positive id |
| `Number(section_id) === principal.userId` | the ACTOR is the RECORD; nobody gains anything on anyone else's row |
| `principal.userId !== 0` | 0 is PHP's "not logged in" sentinel and must never match a record id |
| the component is one of **dd452** (full name), **dd134** (email), **dd133** (password), **dd522** (user image) | `SELF_EDITABLE_COMPONENTS` — the four PHP itself forces to level 2 on an own record, i.e. the self-service profile editor's exact surface |

Nothing else moves:

- **the LEVEL rule is untouched.** `getRecordComponentPermission` still forces dd244
  (security administrator) to 1 for EVERY caller including root, and still downgrades
  dd1725 / dd515 / dd132 / dd330 for a non-global-admin on their own record. The
  exception is to the ID rule, not to the level rule.
- **duplicate and delete of dd128/-1 stay refused for every caller**, root included:
  only the save door passes the option. Duplicating root would mint a positive-id user
  carrying root's Argon2 hash and root's username, and `duplicate_record.ts` bypasses
  the dd132 `unique` check.
- **dd131 stays unwritable on root**, which is what keeps the login root-exemption in
  the companion entry unreachable by escalation.
- **the record stays HIDDEN.** `buildSearchSql` still ANDs `section_id > 0` for the users
  section, so root never appears in a list, a search, an autocomplete or a
  `filter_by_locators` pin. The write door is not a read door.

**Wire effect:** a `dd_core_api save` POST from the root session for `dd128/-1` on one of
the four components now answers `ok:true` and lands the write, where between the SEC-05
fix and this entry it answered `perm.out_of_scope`. For every other caller, and for every
other component, the answer is unchanged (`perm.out_of_scope`, or `perm.denied` from the
level gate).

## Reason

The engine must not be the reason an installation cannot rotate its own most privileged
credential. A heritage institution's root password is exactly the credential most likely
to need rotating years after the person who set it has left, and "edit the hash in
Postgres by hand" is not an operator procedure — it is a way to lock a museum out of its
own catalogue on a typo.

Diverging from PHP here is the smaller risk, and the divergence is bounded by
construction rather than by care: the predicate names the actor's own id and four
component tipos, so it cannot widen into an escalation without a code change that fails
the gate. PHP's blanket refusal was safe only because PHP had a second door (the
installer, and a DBA); this engine's hardening removed the second door, so the first one
has to open a crack.

The narrower alternative — refuse, and write the manual rotation procedure into
`engineering/PRODUCTION.md` — was considered and rejected: it makes correct operation
depend on someone finding a document, and it leaves the four self-editable components
inconsistent (every other account may edit its own email; only the recovery identity may
not).

## Gate reconciliation

No parity fixture asserts this door (the frozen store holds READ-path responses; the
write-path contracts are the TS-native `*_native` gates, DEC-14b), and the root record is
excluded from every read fixture by the `section_id > 0` filter. **No re-harvest is
needed.**

`test/unit/root_user_hidden_tripwire.test.ts` — layer 4 of its header, asserted
behaviourally:

- `isSelfServiceAccountWrite` is true for exactly dd452 / dd134 / dd133 / dd522 on the
  actor's own record, and false for dd244 / dd132 / dd1725 / dd515 / dd330 / dd131, for
  another account's record, for another section, and for the userId-0 sentinel;
- `assertRecordWriteTarget(dd128, -1, <a global admin>, …, {selfServiceAccountWrite:true})`
  still REJECTS — the flag is re-checked against `principal.userId` inside the gate, so a
  mis-wired door cannot open root's record to anyone;
- **root rotates its own password through the REAL save door** and gets `200`. The value
  written is root's CURRENT stored hash: `hashPasswordForStorage` passes an existing
  `$argon2…` string through verbatim (the export/import round-trip rule), so the gate
  proves the door admits the write while leaving the suite database's root credential
  byte-identical — a gate may not rotate it as a side effect. The Time Machine rows the
  write appends are swept against a watermark taken before the run, so root's real
  history is never touched;
- dd244 and dd132 on root's own record are still refused **for root itself**;
- duplicate and delete of -1 are still refused for a granted global admin AND for root.

## Addendum 2026-11-21 — the password leaves the exception's effects (S07)

Owner ruling 2026-11-19 (RC plan decision 13, option c): the "narrower alternative"
rejected above is now the rule **for the password only**. The door described here is
unchanged — root is still admitted onto its own record for the self-editable
components — but a write that changes `dd133` of `dd128/-1` is refused below it, at
the record-write chokepoint, for every caller: `WC-2026-11-21-root-password-write-refused`.
The gate case "root rotates its own password through the REAL save door" is flipped
to that refusal; root's own full-name save is the case that proves the exception
still admits root.
