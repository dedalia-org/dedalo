# WC-2026-11-19-maintenance-legacy-passwords-widget — the `legacy_passwords` maintenance widget is TS-ONLY (no PHP twin)

- **Date:** 2026-11-19 (owner ruling, T2 batch B1 follow-up D08-a: "we need a
  way in the server to update the passwords"); landed 2026-11-20.
- **Decision:** — (DEC-12 gates: `test/unit/legacy_password_migration.test.ts`,
  the client suite `test_legacy_passwords.js`).
- **Shape before (PHP):** nothing. The frozen PHP engine converted a v6 password
  (reversible AES) to a hash at that account's next login; it had no panel and
  no count. The TS engine retired that conversion
  (WC-2026-11-19-legacy-aes-lazy-rehash-retired), leaving one command line,
  `bun run dedalo:migrate-passwords`, and a number-less `/health` notice.
- **Shape after (TS):** the maintenance catalog gains one block,
  `id: 'legacy_passwords'`, category `migration`, label key `legacy_passwords`,
  at the end of `CORE_WIDGET_MODULES`. Global-admin gated like every
  maintenance widget (`requireMaintenanceAdmin`; door class `reversible_admin`).
  - **`get_widget_value`** → `{ accounts, argon2, legacy, command,
    default_info_key, batch }`: accounts holding a password, those already
    Argon2id, those still legacy (the ones the login refuses); the command-line
    spelling; this installation's entity (what an empty info key stands for);
    the per-request batch size.
  - **`widget_request` `migrate`**, options `{ information?, info_key?,
    execute?, after?, limit? }` — the v6 `DEDALO_INFORMATION` /
    `DEDALO_INFO_KEY` (empty = v6's defaults: the published information string,
    this entity); `execute` writes only when it is the boolean `true` (anything
    else is a dry run); `after` is the previous batch's `next_after`; `limit` is
    capped at `batch`. Answer `data`: `{ execute, accounts, argon2, legacy,
    examined, recoverable, converted, failed, skipped, remaining, next_after,
    failed_accounts: [{ section_id, username }] }`.
  - `/health` is unchanged on the wire (`notices: ["legacy_password_accounts"]`,
    never the number); a panel read or a run hands its count to the boot state,
    so the notice follows at once instead of at the next 60 s recount.
- **Never on the wire, in a log or in a report:** a stored password value (old
  or new), a plaintext, or the key material that was typed. A malformed option
  is refused by its NAME.
- **One door:** the widget and the command line call
  `src/core/security/legacy_password_migration.ts`; the script holds no
  statement of its own any more. The write goes through the matrix writer home
  under the row's lock and only over the value that was read (a password
  changed meanwhile is `skipped`). As before, it is not a Time Machine event:
  the value is the same password in the only form the login accepts.
- **Reason:** an installation whose operator has no shell on the server could
  not convert its accounts at all, and nothing but the boot log said how many
  were affected.
- **Gate reconciliation** (the WC-018 / WC-035 TS-only pattern):
  `test/parity/widgets_differential.test.ts` — `legacy_passwords` joins
  `TS_ONLY_WIDGET_IDS`; `test/parity/dedalo_files_differential.test.ts` — its
  client tree joins `isTsOnlyEntry`. TS ground truth:
  `legacy_password_migration` (through `dispatchRqo`: non-admin refused on
  the panel and the run; the count; dry by default; execute converts the
  planted accounts the keys decrypt and reports the rest; the report's exact
  keys; batches; no credential on the wire or in the log; the skip; the command
  line is the same door).
- **Fixture interaction (DEC-14b):** NO re-harvest — the gates filter the new
  id out of the TS side before diffing.
