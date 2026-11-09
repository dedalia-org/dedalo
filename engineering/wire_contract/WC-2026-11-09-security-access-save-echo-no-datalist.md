# WC-2026-11-09-security-access-save-echo-no-datalist — the dd774 save echo omits the ACL datalist and changes_files

- **Date:** 2026-11-09 (a profile permissions save reported a false error on slow links).
- **Decision:** DEC-12 (gated: `test/unit/security_access_save_echo_native.test.ts` —
  the save echo has no `datalist` / `changes_files`, keeps `parent_tipo` /
  `parent_section_id` and the saved entries, and fits `IDEMPOTENCY_MAX_BODY_BYTES`; the
  contrast half proves the get_data edit read still carries a non-empty `datalist`).
- **Shape before (PHP):** the scalar save echo of `component_security_access`
  (`dd774`) was decorated like an edit read, so it carried the full ACL datalist (about
  6.5 MB, 34,726 nodes) plus `changes_files`. The TS engine inherited the same shape.
- **Shape after (TS):** the echo carries the value plus `parent_tipo` /
  `parent_section_id`. The section read and the direct get_data are unchanged. Mechanism:
  `EmitHookContext.door` (`'read' | 'save_echo'`, required), set by the two context
  builders (`section/read.ts`, the save handler in `api/handlers/dd_core_api.ts`); the
  hook attaches the datalist only on `door === 'read'`. Other hooks (text_area
  tags_persons/related_sections, …) still decorate the echo fully. The client
  (`component_common.run_save`) keeps its existing `datalist` (same array identity) and
  `changes_files` when the echo lacks them, and no longer sends `datalist` in the save.
- **Reason:** the client never needs the datalist back from a save — it already holds
  it from the edit read. Carrying it put the echo above the 512 KB idempotency replay
  cap (`IDEMPOTENCY_MAX_BODY_BYTES`, `src/core/api/dispatch.ts`), so a client retry of a
  committed save answered `idempotency.replay_unavailable`, which the client showed as a
  save error on slow links; every save also downloaded and serialized the tree again.
- **Accepted edge:** a non-global-admin editing their OWN profile keeps the datalist from
  before the save (not re-narrowed to the new grants) until a reload. A client cached
  from before this change renders an empty permissions tree after a save until a hard
  reload.
- **Gate reconciliation:** no parity fixture replays a dd774 save echo (`dd774` appears
  only in `component_datalist_lifecycle_differential` read/get_data actions and the
  white-box `permissions_differential`); no fixture change, no re-harvest.
