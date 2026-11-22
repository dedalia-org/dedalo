# WC-2026-09-30-write-door — one write door: the pair, the section floor, the id grammar and the scope, in one order

- **Date:** 2026-09-30 (closure Step 3, audit 2026-09-26 SEC-05 one layer down / SEC-03 residuals).
- **Decision:** owner decisions 2026-09-30 (all Step 3 leanings accepted). Code:
  `src/core/security/write_door.ts` (`authorizeRecordAccess`, `authorizeSectionTarget`,
  `authorizeSectionRecord`, `parseRecordId`).
- **Doors:** the declarative tool gate (`src/core/tools/security.ts`, kinds `record`,
  `record_tipo`, `tipo`, `section`, `targets`); `dd_core_api` save / duplicate / delete;
  `dd_component_text_area_api.delete_tag`; the MCP write tools (`dedalo_set_field`,
  `dedalo_portal_link`, `dedalo_portal_unlink`, `dedalo_find_or_create`,
  `dedalo_duplicate_record`, `dedalo_save_component`, `dedalo_create_record`,
  `dedalo_delete_record`, `dedalo_upload_media`); the media doors
  (WC-2026-09-30-media-pair-scope); tool_transcription
  (WC-2026-09-30-transcription-record-tipo).
- **Shape before:** every door wrote its own subset of the rule. The tool gate read the RAW
  `getPermissions` (the dd128 own-record rule never applied at a tool door), put the
  global-admin bypass ABOVE the non-positive-id refusal (`record` / `record_tipo`), passed
  ANY `section_id < 1` through `tipo` / `section` (so a global admin holding
  `(dd128, dd133)` reached root's dd128/-1 through `tool_time_machine.apply_value`),
  accepted `1.5` as a record id (`Number.isFinite`), read a garbage id (`'abc'`) on
  `tipo` / `section` as "no record named", never asked the SECTION on `record_tipo` or `tipo`, and
  ignored the consultation-only cap on the `section` kind. The MCP writes floored ids
  (`Math.floor(1.5)` = 1) and asked no section grant.
- **Shape after:** one fixed order — (1) grammar: both tipos valid, the id an INTEGER
  (`undefined` / `null` / `''` = absent; `1.5`, `'abc'`, booleans = invalid); (2) the
  section half, `getSectionPermissions >= sectionFloor` (skipped only for an account's own
  self-service write, `isSelfServiceAccountWrite`); (3) the pair, dd128-aware
  (`getRecordComponentPermission`) on a write, the read door's `authorizeComponentRead` on
  a read; (4) the scope — `assertRecordWriteTarget` / `principalCanAccessRecord`, where a
  non-positive id is refused for EVERY caller before the admin bypass. Per-caller floors:
  tools and MCP = 1; media = the door's own level; **the human save door and its twin, the
  text_area `delete_tag` = 0, the named exception** (PHP `component_common::save` asks the
  component only, and inline editing of a subdatum portal TARGET depends on it; deleting a
  tag IS an edit of that value, so the two doors share one floor — review r8). Floor 0 is a
  CLOSED list (`SECTION_FLOOR_ZERO_DOORS`, shrink-only): any other door asking it is refused
  as `internal.invariant` before anything is read (review r9). The media WRITE doors keep
  HEAD's section floor 2 (a profile reading the section but writing the AV still cannot
  create, move or delete posterframes). Section
  targets: an absent id is a create (the level is its whole authorization); a present id
  must be an integer in scope. A whole-record effect — the `record` tool kind, the human
  duplicate / delete of a named record, the MCP `dedalo_delete_record` /
  `dedalo_duplicate_record` — goes through `authorizeSectionRecord`, which refuses an
  absent id (`undefined` / `null` / `''`) itself as `request.invalid`: no record-lifecycle
  door can degrade into a section-level authorization with a null target, whatever its
  schema layer does. `dedalo_find_or_create` asks the section level of the create AND every
  match / set field's (section, component) pair at write level BEFORE the record is created,
  then runs the create and every fill in ONE transaction (a fill the door still refuses —
  the new record's scope, a link target out of reach — rolls the create back). A
  SECTION-level target is ALWAYS consultation-capped (`getSectionPermissions`) — the
  `section`, `tipo` (naming the section itself) and `targets` tool kinds, the human
  create / duplicate / delete (single and SQO multi-delete) and the MCP create /
  duplicate / delete / find_or_create alike: there is no uncapped variant (the option
  that let the `tipo` / `targets` kinds decline it was the hole — an importer could
  create or overwrite Activity / Time Machine rows). `dd_core_api.create` now goes through
  `authorizeSectionTarget` too (same code `perm.denied`, coordinates now name the door).
- **Wire:** the tool envelope is unchanged — the adapter maps `perm.denied` →
  `'insufficient permissions on target'`, `perm.out_of_scope` → `'record is out of the user
  scope'`, `request.invalid` → the kind's existing grammar sentence
  (`FAILURE_LITERAL_BASELINE` untouched). New refusals a client can now see: a garbage or
  zero `section_id` on a `tipo` / `section` tool action (was served); `1.5` on `record` /
  `record_tipo` (was served); a non-positive id on any record-addressed kind for a global
  admin (was served); a consultation-only section written through the `section` kind at
  level 2 (was served); an MCP write naming a fractional id (was floored) or a section the
  profile holds 0 on (was served); a `targets` entry naming a component OF a record now
  asks the section floor too; a section-level `targets` entry (or a `tipo` naming the
  section) at level 2 on a consultation-only section (was served); a non-positive id on a
  `targets` entry is refused by the SCOPE step (`'record is out of the user scope'`, was
  the grammar sentence `'invalid record target'`); an MCP delete / duplicate without an id
  is `request.invalid` (the schema refused it before; a caller that skips the schema no longer
  reaches the engine with a null id); an MCP `find_or_create` whose match / set field the
  profile cannot write is refused BEFORE any record exists, and one whose fill is refused
  after the create leaves no record behind (it used to leave a stray empty record per call).
- **Owner review:** converging the floor of the human save door AND its tag-delete twin from
  0 to 1 (it would refuse subdatum inline edits of a section the profile holds 0 on) is left
  to the owner — the two converge together or not at all; the exception is named at both
  call sites and here.
- **Reason:** a door that re-implements a subset of the rule is a door that forgets part of
  it — that is how SEC-05 survived at the tool gate after the human doors were fixed.
- **Gate reconciliation:** no parity fixture covers a refused write (the frozen store is
  read-path); no re-harvest. Gates: `test/unit/write_door_native.test.ts` (every half,
  every kind incl. the `targets` legs, the real resolver, no mocks),
  `test/unit/authz_door_matrix_native.test.ts` (the derived door census × NO_SECTION /
  NO_COMPONENT / OUT_OF_SCOPE / NO_TOOL / DD1725 / ADMIN_ID0 / READ_ONLY / ADMIN_CAPPED /
  NO_SOURCE / CONTROL; a DD1725 cell counts only as `perm.denied` ON dd1725; the MCP
  create / delete / duplicate / upload / find_or_create doors and the SQO multi-delete
  probed, `dedalo_portal_unlink` included — the second dd128-reachable writer of
  `fields_write.ts`, listed in `DD128_PROBED`; `find_or_create` refused ON the match field
  for NO_COMPONENT; `delete_tag` serves NO_SECTION like `save`; NOT_YET_PROBED pinned by a
  ceiling), `test/unit/mcp_record_door_native.test.ts` (absent / null / `''` ids on the MCP
  delete / duplicate for the admin and the control, a served twin; find_or_create measured on
  the section's row count and its row-id SEQUENCE — refused before the create, rolled back
  after it, a served twin), `test/unit/dd128_write_census_tripwire.test.ts` (verdict
  `delegates`, measured through `DD128_PROBED`).

## Addendum 2026-10-21 — the id grammar is int4-bounded (review-diff 2026-10-21)

- **Shape before:** an integer (or decimal-digit string) id of any magnitude
  passed the grammar; `'99999999999999999999'` rounded silently through
  `Number()` and reached SQL, where the statement aborted (an internal error).
- **Shape after:** `parseRecordId` accepts an id only when it is a safe integer
  inside `INT4_MIN..INT4_MAX` (the matrix `section_id` columns' range); any
  other is `invalid` → `request.invalid`, before any SQL, like the rest of the
  grammar.
- **Gate reconciliation:** no parity fixture covers a refused write; no
  re-harvest. Gate: `test/unit/write_door_native.test.ts` (the out-of-range
  leg).

## Addendum 2026-11-22 — the last PENDING writers ask the door; propagate is STRICTER than PHP (T2-B4 S05/S06)

- **Date:** 2026-11-22 (T2 batch B4: S05-a/b/c, S06; owner FYI-1).
- **Shape before:** four writers decided their own write (dd128 census verdict `PENDING`
  or a hand-rolled pair): `transcription_asr.saveTranscriptionResult` saved for a bare
  `userId`; `tool_tc` `change_all_timecodes` checked the payload's `tipo` and wrote the
  record named by `component_tipo` (two different components passed); the dataframe
  restore engine was trusted by convention; `tool_propagate_component_data` asked the pair
  per row with its own `getPermissions` / `getRecordComponentPermission` /
  `principalCanAccessRecord` and NO section floor — PHP's propagate likewise checked only the
  component permission, so a user with no access to the section but a component grant
  propagated into every matched record.
- **Shape after:** `saveTranscriptionResult` takes a `principal` and asks
  `authorizeRecordAccess` (write, level 2, section floor 1; door
  `transcription_asr.save_result`, the detached poll `tool_transcription.background_save`)
  BEFORE it looks at the segments; `change_all_timecodes` refuses `tipo ≠ component_tipo`
  (`request.invalid_options`) and is its own door (`tool_tc.change_all_timecodes`); the dataframe
  restore engine's writers and importers are DERIVED in the census (`delegates`);
  propagate asks `authorizeSectionTarget` (section floor 1, then the pair) up front — a
  caller below the floor is refused before any row is read (`perm.*`), STRICTER than PHP
  — and `authorizeRecordAccess` per row, whose grant addresses the save (a refused row is
  reported `out of the user scope` / `no write permission` / `invalid record address
  (<code>)`, never written). The background transcript save turns only a door refusal
  (`perm.*`, `request.invalid*`) into the job's terminal sentence; a save failure escapes
  the poll with its own code. dd128 census:
  PENDING 0.
- **Gate reconciliation:** no parity fixture covers a refused write; no re-harvest. Gates:
  `test/unit/authz_door_matrix_native.test.ts` (transcript writer, tc handler, propagate
  probes; NOT_YET_PROBED ceiling 60 → 59), `test/unit/dd128_write_census_tripwire.test.ts`
  (rows `delegates`, derived DELEGATING_ENGINES, positive control),
  `test/unit/media_timecode.test.ts` (tipo/component_tipo conflict, id grammar).
