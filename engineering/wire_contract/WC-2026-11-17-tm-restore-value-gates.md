# WC-2026-11-17-tm-restore-value-gates — a Time Machine restore stores its image gated like a save

- **Date:** 2026-11-17 (C58 — owner ruling 2026-11-17 "implement now"; neighbour N1 of T1-14,
  `WC-2026-11-12-translation-write-value-gates`).
- **Decision:** DEC-12 (gated: `test/unit/translation_write_gates_native.test.ts` R1–R4, RED
  before; `test/unit/component_value_gate_census_tripwire.test.ts`).
- **Shape before (TS):** `tool_time_machine.apply_value` replayed a history image past the write
  engine's value gates (`src/core/section/record/write_value_gates.ts`), on both restore doors:
  the COMPONENT restore wrote the row's lane value through `persistRestoredKeys`, the
  WHOLE-RECORD restore wrote the snapshot's columns through `persistRecordColumns`, and the
  dataframe replay wrote the slots through `persistRecordKeys`. A row written before a gate
  existed (or by a door that bypassed it — an automatic translation before 2026-11-12) therefore
  put its raw value back: a `component_text_area` with `on*=` handlers or `<script>` (rendered
  unescaped by the client), an absolute `webBase` media `src` (a WC-042 violation), a number its
  node no longer formats that way, a non-hash credential stored verbatim. The census named the
  two censused doors as `replays_stored_image` exemptions. PHP restored through
  `component->Save()`, which cleaned.
- **Shape after (TS):** a replay passes the SAME gates as a save of the same value, before
  anything is written:
  - COMPONENT restore — the row's OWN lane value (`gateReplayedValue`); the live other languages
    it is merged over are not rewritten (two lanes, WC-2026-09-27 addendum);
  - WHOLE-RECORD restore — every key of the image that is a component storing in that column
    (`gateReplayedColumns`); section metadata, counters, `relation_search`, unknown tipos
    verbatim;
  - the dataframe slots a restore writes (`gateComponentItems` — no gate keys on
    `component_dataframe` today; the door exists so a future one is not bypassed).
  A value the gates CLEAN is stored cleaned — byte-for-byte what a save stores (rich text
  sanitized + media `src` relativized, a number formatted as its node declares); the restore's
  own history row holds the gated value. A value the gates REFUSE refuses the whole restore with
  the gate's own typed error, nothing written: `503 ontology.invalid_node` (a number under a
  malformed format node). A value every gate already saw restores byte-identical; `dry_run` and
  the `tool.restore_unchanged` notice judge the gated value.
- **The one rule stricter than a save — credentials.** A save takes a non-hash
  `component_password` value as a NEW plaintext (policy, then Argon2id). A replay never carries a
  new password: a credential image that is not a stored Argon2 hash (or empty) — a legacy v6
  ciphertext the upgrade did not convert, a plaintext a pre-gate door stored — is REFUSED,
  `409 tool.snapshot_unrestorable`, on both doors (a whole-record image is refused WHOLE, as for
  a malformed relation key, WC-2026-10-24). Hashing it would turn history bytes into a working
  credential and end `scripts/migrate_v6_passwords.ts`' recovery of a ciphertext; writing it raw
  is the defect. A stored hash replays verbatim. The value never rides the error
  (`coordinates.reason` names the cause only). Known wart: the code's label says "not a valid
  link" (the relation case's wording).
- **RULED 2026-11-18 (was: open owner question, 2026-11-17 review) — a v6 ciphertext image.**
  See the addendum below: a legacy v6 ciphertext is replayed VERBATIM; the refusal that blocked a
  pre-upgrade user record's restore / undelete is gone.
- **Client effect:** none for a clean row. The Time Machine PREVIEW still shows the row as
  recorded (history is not rewritten); a restored hostile row lands cleaned, so the live value
  may differ from the previewed one by exactly what a save would have stripped.
- **Not covered:** nothing any more — the bulk revert's writers were named here as an exemption
  ("exact by contract"); RULED 2026-11-18, see the addendum below.
- **Reason:** the gates are the engine's claim that no door stores an ungated component value;
  a history row is stored bytes, not proof they were gated.
- **Gate reconciliation:** TS-only (no oracle interaction covers a restore of a dirty row; no
  re-harvest). The census drops its `replays_stored_image` verdict with its last two rows
  (`applyDataframeRestore`, `restoreSectionRow` → `gated`). Review addendum (2026-11-17): the
  component restore (`toolTimeMachineApplyValue` → `persistRestoredKeys`) was gated in code but
  outside the census's walk — removing `gatedLaneState` left it green. The walk now derives the
  replay entries' callers and a `gated` row may not reach the gate THROUGH another chokepoint
  writer (the whole-record restore lives in the same file); the outcome gate adds the
  whole-record credential refusal (R4) and the recover's own history row (R3).

## Addendum 2026-11-18 — owner rulings: a v6 ciphertext replays verbatim; the bulk revert is gated too

Owner rulings 2026-11-18 (C58): (1) "as you recommend" — a legacy v6 ciphertext credential image
is replayed verbatim; (2) "the save checks must be apply always, every save must be done in the
same way, no exceptions" — the bulk revert's writers pass the gates. Both supersede the entry
above where they differ.

- **(1) A legacy v6 ciphertext credential — verbatim, on every replay door.**
  - *Before:* any `component_password` image that was not an Argon2 hash (or empty) was refused
    `409 tool.snapshot_unrestorable` — so a user record whose history image held a v6 AES
    ciphertext could not be restored or undeleted at all.
  - *After:* a credential image is NEVER hashed by a replay and is put back verbatim when each
    item is empty, an Argon2 hash, or a LEGACY v6 CIPHERTEXT; anything else is refused as before
    (never written raw, never minted into a hash). The replayed ciphertext is no working
    credential (`auth.ts` accepts only Argon2id); `scripts/migrate_v6_passwords.ts` converts it
    on the live row exactly as it converts one the upgrade left.
  - *The discriminator* (`src/core/security/password_hash.ts isLegacyEncryptedPassword`) is the
    v6 STORAGE FORMAT, not "a non-empty string that is no hash" (which a pre-gate plaintext also
    is): canonical base64 (alphabet, padding, length — it re-encodes to itself) whose decoded
    bytes are again canonical base64 text whose decoded bytes are a non-empty whole number of
    16-byte AES blocks (`base64(openssl_encrypt(serialize($pw), 'AES-256-CBC', …, 0, $iv))`,
    options 0 = already base64).
  - *Residual (stated):* a v7 install does not hold the v6 key material (the config migration
    drops it), so the shape is recognised, not decrypted. A plaintext that is itself a
    double-base64 of an AES-block-sized body would be replayed verbatim; a human password is not
    one, and a crafted one is put back as the inert string it is (no login, reported
    undecryptable by the migration script). No plaintext is ever hashed into a credential.
- **(2) The bulk revert writes its images gated like a save.** `bulk_revert_process`
  (`tools/tool_time_machine/server/bulk_revert_undo.ts writeRevertedKey` / `writeComposedUnit`,
  `bulk_revert_records.ts writeWipedKey`, the undelete `tool_time_machine.ts
  restoreAbsentSectionRow` → `persistRecordBirth`):
  - *Before:* each replayed its undo-log / role-4 image verbatim ("exact by contract"), so a
    BEFORE image holding a pre-gate value (rich text with handlers, an absolute media `src`, a
    number its node formats otherwise, a plaintext credential) was stored raw again.
  - *After:* each passes what it writes through the save's value gates AT THE WRITE: the LANE a
    key's unit restores (the other languages of a sliced key are not rewritten), a composed
    unit's restored main lanes and every slot, a wiped key's pre-wipe value, every component key
    of an undeleted record's snapshot. "Exact" now means the pre-run value AS A SAVE STORES IT;
    the revert's own undo pair holds the gated bytes (re-read from the row), so reverting the
    revert still chains.
  - *The judgements follow the write* (no phantom conflict): a key / lane is `unchanged`, and a
    cascade record `present`, when the live value equals the recorded image AS RECORDED or AS
    THE GATES STORE IT — a value an earlier revert put back cleaned is never
    `changed_since_run` / `cascade_delete_not_reverted` on the next revert; the produced state
    of a cascade record (`producedStateOf`) is asked both ways. The conflict check against the
    run's LAST after-image stays byte-strict (those bytes were re-read from the row).
  - *A value the gates refuse* (the credential rule above; `ontology.invalid_node` for a number
    under a malformed format node) refuses, typed, exactly what was restoring it — nothing of it
    written, the rest of the run still reverted:
    `data.skipped[] += {reason: 'failed', code: '<the gate's code>', section_tipo, tipo,
    section_id, lang?}` — a unit's key (rolled back whole), or the RECORD (tipo = section_tipo)
    of a standalone cascade group whose wiped keys were being put back (the group rolls back).
    The existing rule holds: `code` rides a LOCATED `failed` entry only, and it is the ONE
    converter's (`toDedaloError(error).code`). Unlocated (reason alone, SEC-16): the undelete
    of a MISSING row refused by a gate — its scope is judged on the restored row, which a
    refused image never produces — and a unit OF the record being restored (its record's scope
    is judged in the prelude the refusal interrupts). A unit whose prelude restore is refused
    rolls back with it, and the record it could not bring back is counted
    `cascade_delete_not_reverted` as for any refused unit.
  - *Client effect:* `skipped[]` entries of a kind the client already renders (`failed` + `code`,
    WC-2026-10-11-parent-link-cycle-every-door); a reverted value may differ from the recorded
    image by exactly what a save would have stripped.
- **Census (shrink-only):** `component_value_gate_census_tripwire` drops the `exact_revert`
  verdict with its four rows (→ `gated`, each reaching the gate in its own file) and pins the
  vocabulary at `gated` / `non_literal`. Its ENTRY list is now derived from the chokepoint module
  (every exported `persist*` of `record_write.ts`), so the five entries it only named —
  `persistAppendedKeyItems`, `persistRelationRemovalKeys`, `persistObserverMirrorKeys`,
  `persistObserverResaveKeys`, `persistModifiedStamp` — are walked: six more callers classified,
  all `non_literal` by mechanism (stored locators minus the removed ones, the wipe's removals +
  default project locators, a `relation`-only mirror, a permutation of the stored value, `[]`);
  none carried an authored literal, so none needed a gate.
- **Gate reconciliation:** TS-only. `translation_write_gates_native` R5 (ciphertext verbatim on
  both restore doors; look-alikes refused) and B1–B6 (each bulk-revert writer: gated outcome,
  repeat revert unchanged / present, typed refusal, revert of the revert) — RED before;
  `password_hash_on_save` (the discriminator, the replay gate).
- **Owner question left open:** a gate refusal reported UNLOCATED (a MISSING row's undelete; a
  unit of the record being restored) is `{reason: 'failed'}` with no `code` — unlocated entries
  carry the reason alone (SEC-16). Letting the bare error code ride an unlocated entry would
  tell the operator WHY without naming a record; it widens a security-reviewed channel, so it
  is not done here. The words are in the server log, with the request id.

