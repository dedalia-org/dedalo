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
  (`coordinates.reason` names the cause only). ~~Known wart: the code's label says "not a valid
  link" (the relation case's wording).~~ Resolved 2026-11-18 (review addendum below): the
  credential refusal has its own code, `409 tool.snapshot_credential_unrestorable`.
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
    The existing rule holds: ~~`code` rides a LOCATED `failed` entry only~~ (SUPERSEDED
    2026-11-18 — the bare `code` rides an UNLOCATED `failed` entry too: addendum "the bare
    `code` rides an UNLOCATED `failed` entry" at the end), and it is the ONE
    converter's (`toDedaloError(error).code`). Unlocated (~~reason alone~~ reason + `code`
    since that addendum, never a coordinate; SEC-16): a unit OF the
    record being restored (its record's scope is judged in the prelude the refusal
    interrupts). (The undelete of a MISSING row refused by a gate was listed here too —
    superseded the same day, review addendum below: its scope is judged first.) A unit whose prelude restore is refused
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
- **Owner question — RULED 2026-11-18 (the code rides; addendum at the end):** a gate refusal reported UNLOCATED (a unit of the record being
  restored) is `{reason: 'failed'}` with no `code` — unlocated entries
  carry the reason alone (SEC-16). Letting the bare error code ride an unlocated entry would
  tell the operator WHY without naming a record; it widens a security-reviewed channel, so it
  is not done here. The words are in the server log, with the request id.

## Addendum 2026-11-18 (review of 123d88b48d..39f6bd7622) — the credential refusal's own code; scope before the image

Two corrections to the addendum above, same day, nothing released between them.

- **(L1) A refused credential image has its own code.**
  - *Before:* `409 tool.snapshot_unrestorable` — the malformed-relation refusal
    (WC-2026-10-24), whose registry message and label say the stored value "is not a valid
    link". A user restoring a user record whose history holds a plaintext credential was told a
    link is malformed.
  - *After:* `409 tool.snapshot_credential_unrestorable` (`conflict`, public, not retryable,
    label `error_tool_snapshot_credential_unrestorable`: the entry stores a password that was
    not saved in a protected form; nothing was changed; set a new password instead). Every
    door: `apply_value` on a component row and on a whole-record row, the bulk revert's
    `skipped[].code`. `tool.snapshot_unrestorable` is again the relation refusal only. Same
    status, same category, same client policy (default) — only the code and its sentence.
- **(L2) An undelete judges the record's SCOPE before its image's refusal** (bulk revert, a
  MISSING row: `bulk_revert_records.ts restoreDeletedRecord` → `tool_time_machine.ts
  restoreAbsentSectionRow(…, judgeRestoredRow)`).
  - *Before:* a missing row's scope is judged on the restored row, and a refused image — a
    credential the value gates refuse (this entry), a relation key that is no locator array
    (WC-2026-10-24) — threw before any row existed. So a principal who may NOT see the record
    was answered `failed` instead of `out_of_scope`: at the in-scope unit that re-links it,
    located and with the gate's `code`; `{reason: 'failed'}` for a standalone target. The
    reason told them what an out-of-scope record's history holds. And a standalone target's
    refusal was never located, in scope or not (a typed refusal of a nested member was logged
    against the group's first member).
  - *After:* the refused keys are collected (`write_value_gates.ts gateOrCollect`), the row is
    inserted WITHOUT them inside the undelete's transaction, the scope is judged on it, and only
    then is the first refusal thrown — either answer rolls the row back; nothing of a refused
    image is committed, every key written passed the gates.
    - out of scope → `{reason: 'out_of_scope'}`, reason alone, exactly as for a restorable
      image;
    - in scope → `failed` with the gate's `code`: located at the UNIT that re-links the target
      (unchanged), or — a STANDALONE cascade target — at the record itself
      (`section_tipo`, `tipo` = `section_tipo`, `section_id`), as a wiped record's refusal
      already was. A typed throw from before the scope verdict (the verdict itself included)
      still locates nothing.
  - An address taken since the unlocked read still answers `cascade_delete_not_reverted`
    before either. A unit OF the record being restored stays unlocated (its `inScope` is set
    when its prelude returns). An untyped throw in a standalone group is logged against the
    member being undeleted, no longer the group's first (log only; the wire entry is unlocated).
- **Gates:** `bulk_revert_cascade_target_scope_native` (re-linked and standalone × out of scope
  / in scope × credential / malformed relation; a typed throw inside the verdict locates
  nothing; a restorable standalone control) — RED before, 9 of 10 mutations red (the tenth —
  the refused key written raw into the row that is rolled back — is equivalent by outcome);
  `password_hash_on_save` (the code, and that the message and the label a user reads name a
  password, never a link); `translation_write_gates_native` R4/R5/B3/B5/B6 on the new code.

## Addendum 2026-11-18 — the bare `code` rides an UNLOCATED `failed` entry (owner ruling, TM Q1)

The question left open above is ruled: yes. An unlocated `failed` entry says WHY; it still never
says WHICH record.

- **Before:** `data.skipped[] += {reason: 'failed'}` for every `failed` entry that had not passed
  the scope gate — the `code` rode a LOCATED entry only.
- **Now:** `{reason: 'failed', code: '<registry code>'}` — the ONE converter's
  (`toDedaloError(error).code`), exactly the two keys. Never `section_tipo`, `section_id`,
  `tipo` or `lang`; never words. Where it appears:
  - a unit OF the record being restored whose prelude a gate refuses (B5:
    `tool.snapshot_credential_unrestorable`) — the principal's scope over the record was judged
    and passed inside the prelude the refusal interrupts; out of scope is answered
    `out_of_scope` before any image is judged (previous addendum), so the code is never an
    answer about a record the caller may not see. **This bullet's claim holds for THIS case
    only** — a failure AFTER the verdict passed; it never covered the three below (scoped
    2026-11-18, TM Q3 addendum at the end);
  - ~~a record's door that threw before its scope verdict passed (the verdict itself included):
    the code of that throw (`internal.invariant`, `internal.unexpected`, …);~~
  - ~~an untyped throw in a standalone cascade group outside a member's own door;~~
  - ~~a key the PLAN could not place because a lookup threw (`bulk_revert_plan.ts`: the model
    lookup, the slot resolution) — `Unplanned.code`.~~
    (the three struck: SUPERSEDED 2026-11-18 by the TM Q3 addendum at the end — a failure from
    before or inside the verdict carries NO code; history kept.)
- **Unchanged:** `{reason: 'out_of_scope'}` is the reason alone — no code is ever handed to that
  skip (a principal who may not see a record does not learn why its revert stopped). Every other
  reason, located or not, carries no `code`. A `failed` entry nothing THREW for has none either:
  a key the plan refuses by its shape (`unplaceable`), a typed `RevertRefusal('failed')` (an undo
  log that is not B/A pairs, a recorded frame naming no slot) — there is no error to classify.
  Located `failed` entries are as before.
- **One builder:** `bulk_revert.ts unlocatedEntry(reason, code)` is the whole of what an
  unlocated entry may be.
- **Client effect:** none — the summary counts `skipped[]` per `reason`
  (`bulk_revert_summary_message`); `code` is for the caller reading the response.
- **Gates:** `wire_disclosure_tripwire` (the pinned shape, edited deliberately: the unlocated
  builder's exact body, a code handed to `failed` skips only, never beside `out_of_scope`, every
  code the converter's — records and plan); `translation_write_gates_native` B5,
  `bulk_revert_cascade_target_scope_native` (typed throw inside the verdict; the
  `out_of_scope` cases stay exact `{reason}`), `tm_bulk_revert` (throw from before the gate) —
  RED before; mutations red: no code on unlocated, code for any reason, a code handed to an
  `out_of_scope` skip, the group failure's code dropped, the plan's code dropped.

## Addendum 2026-11-18 — the `code` rides an UNLOCATED `failed` entry ONLY after the scope verdict passed (owner ruling, TM Q3)

Owner ruling 2026-11-18 (TM Q3, "Only after access check"), narrowing the TM Q1 addendum above:
the bare `code` tells the caller WHY a revert stopped, and that is the caller's to learn only once
the principal's scope verdict over that unit / record has PASSED.

- **Before (b29c313652):** every unlocated `failed` entry something threw for was
  `{reason: 'failed', code}` — also a failure from before any scope gate.
- **Now:** `{reason: 'failed'}` — the reason ALONE — when the failure happened before or inside
  the verdict:
  - a key the PLAN could not place because a lookup threw (`bulk_revert_plan.ts`: the model
    lookup, the slot resolution). The plan runs before any gate; `Unplanned` keeps no code;
  - a throw from the unit's gate itself (`unitInScope`: the grant read, `principalCanAccessRecord`);
  - a throw from a record door before or inside its verdict (`mayUndelete`, the restored row's
    `principalCanAccessRecord`, the born-record gate) — typed or untyped;
  - a throw in a unit's prelude while a cascade target's own verdict has not passed yet — the
    entry is LOCATED at the unit (its own record passed its gate) and still carries no code: the
    error is about the target, whose verdict has not passed.
- **Unchanged — `{reason: 'failed', code}`** for a failure AFTER the verdict passed that the
  report still does not locate: a unit OF the record being restored whose prelude a value gate
  refuses once that record's scope was judged (B5: `tool.snapshot_credential_unrestorable`), and
  an untyped throw in a standalone cascade group after the member's verdict passed. Located
  `failed` entries, `out_of_scope` (reason alone, always) and every other reason: as before.
- **How it is threaded:** one conditional converter call, `bulk_revert.ts
  codeAfterVerdict(error, verdictPassed)`; the unit loop's `UnitVerdict` (`own` — the unit's
  record verdict passed, at the gate or on the restored row in the prelude; `memberOpen` — a
  prelude target's verdict still pending); the record doors report their verdict through
  `onScopePassed` (the existing `scope.judged`), also when the restore then throws; a record
  outcome's `code` exists only when `located` (`bulk_revert_records.ts failedOutcomeOf`).
- **Client effect:** none (the summary counts per `reason`).
- **Gates:** `bulk_revert_cascade_target_scope_native` (a typed AND an untyped throw inside the
  verdict → exactly `{reason: 'failed'}`; a re-linked target's verdict throwing → the unit's
  located entry without `code`), `tm_bulk_revert` (a throw before the gate — the plan —
  and inside the unit's gate → exactly `{reason: 'failed'}`; after the gate → located with code),
  `translation_write_gates_native` B5 (exact, WITH code), `wire_disclosure_tripwire` (pinned
  shape edited deliberately: exactly three code-passing skip calls, each
  `codeAfterVerdict(error, <verdict flag>)` or a record outcome's code; a plan code, a bare
  converter call or a literal flag is red — positive controls; the plan file holds no code).
  RED before; mutations red: code always, code never (unit/group; record outcome), the plan's
  code kept, the unit's verdict pre-passed, the group member's verdict pre-passed, the prelude member's
  pending verdict ignored.
