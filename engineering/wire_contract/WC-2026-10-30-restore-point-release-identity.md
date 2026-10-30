# WC-2026-10-30-restore-point-release-identity — restore points, sentinels and the restore downgrade check name the release identity

- **Date:** 2026-10-30 (update audit 2026-10-29, finding U-07).
- **Decision:** DEC-12 (gated: `test/unit/update_restore_native.test.ts`,
  `test/unit/code_update.test.ts`, `test/unit/client_update_code_render.test.ts`,
  `client/dedalo/test/client/js/test_update_code.js`).
- **Shape before (TS):**
  1. `update_code` status `consumer.restore_points[].version` was the DATA triple the held tree's
     `version.ts` declares (`7.0.0` for every beta of 7.0.0).
  2. The restore point directory a code update or restore creates was named
     `dedalo_<data triple>[_<digest7>]_<stamp>`; the rollback sentinel's `previousVersion` was the
     running data triple, and a restore wrote the point's data triple as `version`.
  3. `restore_code` asked for `confirm_downgrade` only when the point's data triple differed from
     the running one — restoring beta.5 over beta.7 needed no confirmation.
- **Shape after (TS):**
  1. `restore_points[].version` is the RELEASE IDENTITY the held tree calls itself
     (`7.0.0-beta.5`, `7.0.0`, `7.0.1-dev`; `src/core/update/tree_identity.ts`), null when its
     `version.ts` is unreadable (`restorable_reason: unknown_version`, unchanged). New field
     `data_version`: the data triple (the old `version` value).
  2. The directory is `dedalo_<running release identity>[_<digest7>]_<stamp>`; sentinel
     `previousVersion` is the running release identity and `version` the identity the swapped-in
     tree calls itself (what `/health` answers). `boot_confirm.ts` compares that `version` with the
     running DEDALO_ENGINE_VERSION when the sentinel carries no `installDigest`.
  3. `restore_code` refuses without `confirm_downgrade` when the release identity differs, or when
     both install digests are known and differ (`restoreChangesCode`); the refusal names both
     identities (with short digests). The restart frame's `expected_version` and the envelope's
     `data.version` are the point's release identity. The panel modal mirrors the rule on
     `engine.engine_version` / `engine.install_digest`.
- **Reason:** the data triple is shared by every prerelease of one triple, so it cannot name, list
  or compare code artifacts; a restore across betas changed the code with no acknowledgement.
- **Gate reconciliation:** TS-only; the frozen store holds no update-door interaction. No re-harvest.
  A pending sentinel written before this by an unstamped restore names a data triple: on a
  prerelease or dev identity it now reports a mismatch (loud, untouched) instead of confirming.
