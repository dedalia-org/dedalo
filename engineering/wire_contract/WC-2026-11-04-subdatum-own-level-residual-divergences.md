# WC-2026-11-04-subdatum-own-level-residual-divergences — four residual gaps between the subdatum own level and PHP resolve_component_read_permission

- **Date:** 2026-11-04 (nested-ddo_map plan, W4 owner decision (d) "exact PHP"; W7
  review). Code: `src/core/section/node_permissions.ts` (the chain), the own level
  `resolveComponentContextPermission` (`src/core/security/permissions.ts`).
- **Decision:** owner decision (d) of 2026-11-03. These four are what (d) did NOT
  reach: they are gaps of the own-level TWIN on EVERY door, older than the plan,
  not new behaviour of the node chain.

## Shape before (PHP)

`child->get_component_permissions()` = `component_common::resolve_component_read_permission`
(`class.component_common.php:3512-3612`) on the child INSTANCE (its own section_id, its
mode), plus the instance overrides of `get_component_permissions` (`:3455-3483`):

1. **TM notes** — section `rsc832` (`DEDALO_TIME_MACHINE_NOTES_SECTION_TIPO`), non-search:
   always `1`; the note's creator gets `2` (`get_my_section_record`).
2. **IRI label dataframe** — tipo `dd560`, non-search: always `2`.
3. **dd15 in tm mode** — section `dd15`, mode `tm`: always `1`, whatever the grant.
4. **Node-level stamp** — PHP has no node: a context entry is the FIRST instance's
   (`merge_unique_context` first-wins), so its level is resolved on that instance's row.

## Shape after (TS)

`resolveComponentContextPermission` carries the search-mode grants and the dd128
own-user-record cases exactly; for the four above:

1. `rsc832` resolves through the matrix (`getPermissions`) — no forced `1`, no creator `2`.
2. `dd560` resolves through the matrix — no forced `2`.
3. dd15 gets the grant-derived floor of `getPermissions` (`timeMachineReadFloor`: `1` for a
   global admin or a principal reading a scoped section's history it holds the
   `time_machine_list` grant on, else `0`) — never the unconditional `1`.
4. A NODE-level stamp (a context entry; the caller level a child inherits from) is asked
   with NO section_id — the matrix level of (section, tipo) — not the first row's.

## Reason

(3) is DELIBERATE and already ledgered: the unconditional dd15 `1` is replaced by the ACL
floor (`WC-2026-08-14-tm-permission-floor`, `WC-2026-10-22-tm-scope-whole-request`).
(4) is structural: one node serves every row of a read (owner decision (b)), so no
single row is "the" row; first-wins made the level depend on page order. The per-ITEM
own level (data items) still passes the item's section_id, as PHP's instance does.
(1) and (2) are UNPORTED, not chosen: the twin never carried them on any door. Each is
a gap to close by porting the PHP case into `resolveComponentContextPermission` (one
place, every door), not by a door-local patch.

## Gate reconciliation

1. TM notes `rsc832` — **no gate**; reason: unported (see Reason). A port lands with a
   `*_native` twin on a `test`-TLD situation.
2. IRI `dd560` — **no gate**; reason: unported (see Reason), same rule.
3. dd15 tm floor — `test/unit/tm_permission_floor_native.test.ts` (the floor, per grant).
4. Node-level stamp — **no gate** pinning the row-less ask; reason: the per-item path it
   differs from is pinned (`test/unit/own_user_record_read_stamp.test.ts`,
   `test/unit/subdatum_permission_native.test.ts`), and no page-order-dependent level
   exists to assert against.

Parity: no frozen fixture isolates any of the four — no drift. **Re-harvest: none.**
