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
- **Open owner question (2026-11-17 review) — a v6 ciphertext in a WHOLE-RECORD image.** The
  refusal is whole, so a user record whose history image holds a v6 AES ciphertext under its
  password key cannot be restored at all through this door: an undelete of a user deleted on v6,
  or a restore of a user to a snapshot from before the upgrade (even when only other fields
  differ). `scripts/migrate_v6_passwords.ts` converts live `matrix_users` rows only, never
  history rows, and the bulk revert's undelete covers run-deleted records only — there is no
  other path. Not decided here; the alternatives named by the review: replay a legacy ciphertext
  verbatim (`isLegacyEncryptedPassword` — it is no working credential, auth accepts Argon2 only,
  and it is the state the migration recovers from — but that predicate cannot tell a ciphertext
  from a plaintext a pre-gate door stored: both are "a non-empty string that is no hash"), or
  drop the credential key from the image and keep the live one. Until ruled the refusal stands
  (fail closed).
- **Client effect:** none for a clean row. The Time Machine PREVIEW still shows the row as
  recorded (history is not rewritten); a restored hostile row lands cleaned, so the live value
  may differ from the previewed one by exactly what a save would have stripped.
- **Not covered (named, not narrowed silently):** the bulk revert's own writers
  (`bulk_revert_undo.ts`, `bulk_revert_records.ts` — `persistRestoredKeys` / the undelete's
  `persistRecordBirth`) replay their undo-log images verbatim: a revert is EXACT by contract
  (`changed_since_run` compares the bytes the run wrote), and gating one side would refuse its
  own pairs. Open owner question. Censused since the 2026-11-17 review (the census walks the
  replay entries `persistRestoredKeys` / `persistRecordBirth` too): those four writers carry
  the `exact_revert` verdict, which only the bulk revert's own files may take.
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
