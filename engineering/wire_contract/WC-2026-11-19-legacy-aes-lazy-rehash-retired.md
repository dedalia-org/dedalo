# WC-2026-11-19-legacy-aes-lazy-rehash-retired — a v6 AES password value is never upgraded at login; the operator migrates once, and the boot counts who is waiting

- **Date:** 2026-11-19 (T2 batch B1, items D08-a / D08-c). The behaviour itself
  dates from the TS login (`src/core/security/auth.ts`); it had no ledger entry —
  `WC-2026-08-24-proxy-trust-and-password-cost` records the Argon2 COST rehash
  only. This entry is the record, plus what changed today.
- **Decision:** — (DEC-12 gate: `test/unit/legacy_password_notice_native.test.ts`).

## Shape before (PHP)

`class.login.php` (SEC-001): a stored password that was not a hash was treated as
v6's reversible AES ciphertext (keyed by `DEDALO_INFORMATION`, IV from
`DEDALO_INFO_KEY`), decrypted and compared at login, and on a match REPLACED by
an Argon2id hash — an account upgraded itself the next time its owner logged in.

## Shape after (TS)

- **Login** accepts Argon2id only. A stored value that does not start with
  `$argon2` is refused: the same ambiguous answer on the wire as a wrong
  password, a `Legacy (pre-Argon2) password hash` activity row, and a server-log
  line naming the account and the fix. Nothing is decrypted, nothing is
  rewritten at login.
- **The fix is one operator command**, run once against the database:
  `bun run dedalo:migrate-passwords` (`scripts/migrate_v6_passwords.ts`: decrypt
  each legacy value with the v6 key material, re-hash with Argon2id, write the
  hash back; dry-run by default). Nobody chooses a new password.
- **New 2026-11-19:** the log line names that command (it said "log into the PHP
  server once", an engine that no longer exists); the BOOT counts the accounts
  still on a non-Argon2 value and warns with the number and the command
  (`auth.ts countLegacyPasswordAccounts` → `update/boot_state.ts
  refreshLegacyPasswordNotice`); `/health` carries the notice
  `notices: ['legacy_password_accounts']` — never red, never the number (the
  probe answers anyone).

## Reason

The v6 key material is a published default on most installs (`DEDALO_INFORMATION`
defaults to a known string, the IV seed is the entity name): carrying it into the
v7 configuration so that login could decrypt would preserve the ability to read
every stored password from a database copy. The config migration drops both keys
on purpose; the one-shot CLI takes them from the v6 config the operator points
it at, and they can be destroyed afterwards. An upgrade-on-login path would need
them in the running engine for as long as one account had not logged in.

## Gate reconciliation

No parity gate carries a legacy login (write path; the differential retired with
the oracle). Native gate: the refusal's log line names the command and no PHP,
the wire answer equals a wrong password's; the count (legacy +1, Argon2id / empty
+0); the boot notice (number + command; silence at 0; an unreadable count is
said, recorded as not counted); `/health` (notice, 200, no number) through the
real route. RED before (the line named PHP). Mutations red ×7. No re-harvest.
