# WC-2026-11-10-iri-frame-and-tm-note-levels — the IRI label frame takes its main's level; TM notes follow the annotated change

- **Date:** 2026-11-10 (T0-4, owner decisions of 2026-11-10). Code:
  `src/core/security/permissions.ts` (`getRecordComponentPermission` — the fixed-slot
  and rsc832 blocks), `src/core/security/write_door.ts` (`frameOf`),
  `src/core/tm_record/tm_note_create.ts` (`create_tm_note`),
  `src/core/resolve/read_tm.ts` (the note cell), `src/core/section/read.ts`
  (`appendIriLabelFrameContext`).
- **Decision:** owner, 2026-11-10 (T0-4 plan §7). Closes items 1 and 2 of
  `WC-2026-11-04-subdatum-own-level-residual-divergences` (see its addendum).

## Shape before (PHP)

`component_common::resolve_component_read_permission` + `get_component_permissions`
(frozen `class.component_common.php:3455-3612`; v6 identical):

1. **IRI label dataframe `dd560`**, non-search: always `2`, whatever the IRI main's level.
   Read was capped by the caller chain, save was not — a user who could only READ the
   IRI could rewrite its label.
2. **TM notes `rsc832`**, non-search: `1` for everyone; the note's creator `2`. No link to
   the annotated change: a user without access to that change's history still read the note.
3. **Note creation**: the client sent a generic `create` on `rsc832`, then a `save` of the
   Code `rsc835` carrying the TM row id it chose — any user with write on `rsc835` could
   bind a note to any row, or leave a code-less note.
4. **Note cell** (`component_text_area` tm branch): `created_by_user_id` = the TM ROW's
   author, under a name that means the note's creator.

The TS engine before this entry carried none of 1–2 (matrix only: `dd560` refused to every
non-superuser; `rsc832` editable by any matrix-2 user, also on others' notes).

## Shape after (TS)

1. **Fixed dataframe slots (`dd560`)** take their MAIN's level, read and write, on every
   record-addressed door: own level 2; the read chain caps it at the main; get_data's frame
   context = the main's level (the `max(main, 2)` is gone).
   - A write names its main (`source.caller_dataframe.main_component_tipo`, validated: a
     component of the record's section whose model declares the slot) and is judged at
     `min(2, main)`; whole-record writes (TM restore, bulk revert) are bounded by EVERY main
     of the section. A fixed-slot write without a valid main → `request.invalid_source`
     (root included). Doors that cannot name a main (MCP `set_field`, record/tool kinds,
     propagate) refuse a fixed slot loudly. The importers name the frame's main (CSV
     column / legacy envelope); a refused frame is reported IGNORED, the row is not rolled
     back.
   - A direct read of the slot (Gate A, the get_data self-gate and main stamp) is bounded by
     the named main ONLY with a complete pairing (main + `id_key ≥ 1`), otherwise by every
     main of the section.
   - Section-level / ddo doors ask the bare matrix, which holds no dd560 row: 0 for
     non-superusers (fail-closed, as before).
2. **TM notes (`rsc832`)**: level = max(profile grant on rsc832, TM-path level).
   - Profile grant (basis `profile`) = the AUDIT path: rsc832 behaves as any section.
   - TM path (everyone else, root and global admins included), record-addressed asks: the
     note must be bound (`rsc835`) to a VISIBLE TM row whose section the caller has Time
     Machine access to; then the creator (dd200) `2` on the text, others `1`; `rsc835` is
     `1` for everyone. No TM access → `0`. Code-less note → `0`. A TM row hidden or purged
     → `0` at once (the row is read on every ask; only creator + code are cached). No
     section_id (node stamp) → the profile level.
   - **rsc832 is no longer a public-list section** (it lives in `matrix_notes`; PHP and the
     engine before gave every user read 1 through that fallback). Without a profile grant:
     non-admin 0, global admin 1 (rule), root 3 (superuser). So every section-level / ddo
     door — Gate B, `read_raw`, the raw view, MCP read/search, export, RAG, identify, the
     per-ddo filter, search stamps — refuses TM-path users; they reach a note only through
     the Time Machine (the record-addressed get_data of the note view). Other `matrix_notes`
     sections (rsc326 …) keep the public-list read.
   - The creator deletes their own note on the TM path (single `delete_record`).
   - `duplicate` of an rsc832 record is refused for every caller and door (`perm.denied`):
     a copy would be a second note bound to someone else's change.
3. **`create_tm_note`** (`dd_component_text_area_api`, options `{matrix_id}`) replaces the
   `create` + `rsc835` save pair: one transaction under a per-row lock; caller must be the
   TM row's author and have TM access to its section; an already-bound row returns its note
   (`data.section_id`, extension key `created: false`). Refusals: `request.invalid_data`
   (malformed / absent id); `perm.denied`, one identical shape, for a well-formed id that is
   unknown, hidden, not the caller's, or without TM access (no row-existence oracle).
4. **Note cell**: `tm_user_id` = the TM row's author; `created_by_user_id` = the note
   record's dd200 creator (`null` when no note).

## Reason

Owner, 2026-11-10: (1) a label is part of its IRI — read-only IRI, read-only label;
writable IRI, writable label. (2) a TM note belongs to the change it annotates: the owner
edits it, others read it, and who cannot see the change cannot see its note. (3) a
specific grant on rsc832 is the audit/export door, recorded by rsc832's own Time Machine.
(Q-b) a note created outside the Time Machine is not a TM note; users never choose the code.

Numbering note: this entry's item 1 is `dd560` and item 2 is `rsc832` — the reverse of
`WC-2026-11-04-subdatum-own-level-residual-divergences` (its 1 = rsc832, 2 = dd560).

Owner decision 2026-11-10 (kept deliberately): at section-level doors a global admin reads
every rsc832 record at 1 (code-less ones included) and root keeps 3 (read_raw, delete,
export) — the administrative audit/maintenance door; their record-addressed asks follow the
TM path like everyone else's.

## Gate reconciliation

- `test/unit/subdatum_own_level_iri_native.test.ts` — item 1 (read, write, pairing, import,
  refusals).
- `test/unit/subdatum_own_level_ported_native.test.ts` — item 2 (paths, creator, delete,
  duplicate, node stamp, cache, hidden/purged TM row, every section-level door asserted on
  DATA).
- `test/unit/tm_note_create_native.test.ts` — items 3 and 4 (incl. rollback, race, the
  uniform refusal shape).
- `test/unit/tm_emit_row_context_native.test.ts` — item 4 pin updated
  (`tm_user_id`, `created_by_user_id` null without a note).

Fixture interaction: `test/parity/fixtures/oracle_harvest/tm_component_history_differential.json`
pins `created_by_user_id` on two rsc329 note items with the PHP meaning (TM row author).
No live gate replays it (its differential was retired); the bytes are left frozen and read
under item 4 as `tm_user_id`. **Re-harvest: none.**
