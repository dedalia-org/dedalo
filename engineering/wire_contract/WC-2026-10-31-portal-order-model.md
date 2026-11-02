# WC-2026-10-31-portal-order-model — the stored locator array is the only real order: declared `order` becomes WRITE-time, `view_order` is a temporary read, `paginated_key` is the stored index

- **Date:** 2026-10-31 (owner ruling 2026-10-31 on the portal order model; simplified the same
  day: re-ordering is a COMPATIBLE data change on a pre-stable v7, so no release step, no
  data-version gate and no read-time declared sort).
- **Decision:** DEC-12 (gated: `test/unit/portal_order_native.test.ts`, the chokepoint
  save-rule reach derived from the writer closure in `write_obligations_tripwire` leg B6; the read-time
  helpers stay pinned by `portal_order_by_columns_native` / `portal_declared_column_order_native`).
- **Shape before (TS, WC-048):**
  - a portal column ddo declaring `order: "asc"|"desc"` sorted the portal at READ time only
    (`relation_core.ts` `expandPortal` → `orderLocatorsByDeclaredColumns`); the stored array was
    never written in that order;
  - every emitted locator's `paginated_key` was its DISPLAY index (`index + offset`) — under a
    declared order that is not the stored index, so a drag (`sort_data source_key/target_key`)
    on such a portal addressed the wrong item and was refused as a locator mismatch;
  - a header click on a `sort_by_column: true` column persisted at once (`sort_by_column`);
  - the context carried nothing saying a portal is declared-order (the client had no authority
    for it).
- **Shape after (TS):**
  1. **Declared `order` is WRITE-time.** The record-write chokepoint applies the KEY SAVE RULES
     (`record_write.ts` `applyKeySaveRules`, §3f of its header) to every key before it persists:
     a relation key whose component declares `order` is stored SORTED by it — through the ONE
     ordering function (`order_locators.ts` `sortByDeclaredOrder` → `orderLocatorsByDeclaredColumns`),
     on every door: save, link/autocomplete insert (a declared-order key never takes the atomic
     append — `persistAppendedKeyItems` refuses it, `save_component` routes it to the full-array
     persist under its row lock), TM restore, removal, observer mirror, whole-record restore and
     every BIRTH (`writeBirth`, `prepareBirthColumns`: create-with-values, duplicate). The save
     echo (`result.data`) is the value AS STORED. Identity for every key without `order`.
  2. **`context.declared_order`** — ADDITIVE key on a component entry whose edit config declares
     `order`: `[{tipo, direction}]` (`direction` `'ASC'|'DESC'`, priority order). ABSENT otherwise.
     The client's one authority for "declared-order portal" (no client mirror of the predicate).
  3. **`sort_data` and `sort_by_column` on a declared-order portal are refused** with envelope v2
     `{ok:false, error:{code:'request.invalid_data', …}}`, status 400, BEFORE anything moves
     (`relations/save.ts` `assertNoDeclaredOrder`; log coordinates `reason: 'declared_order'`).
     The chokepoint would undo either on the same write, so "ok, nothing changed" was the
     alternative. **User-visible until the client half lands** (see *Client status* below):
     the shipped client still offers both controls there.
  4. **`sqo.view_order`** — NEW optional field of the get_data RQO's sqo:
     `{tipo, direction: 'ASC'|'DESC'} | null` — absent or `null` = no view order; a strict
     object, wire-validated by `sqoSchema`, `direction` in the ONE wire spelling the sqo `order`
     clause and `context.declared_order` already use (lowercase, `null` or any other direction
     refused at the gate, and again by `orderLocatorsByViewOrder`). The server
     orders the portal's FULL locator list by that one column before paginating
     (`orderLocatorsByViewOrder`); never written; honoured on a declared-order portal (only its
     SAVE is refused). The column must be a `show.ddo_map` column of the portal's own edit
     config declaring `sort_by_column: true` (the same opt-in the persisted `sort_by_column`
     honours), AND the request principal must hold READ (level ≥ 1) on EVERY STEP of the order
     path the ranking sorts on (`search/order_path.ts` `buildOrderPath`), from every section the
     ranking could search (the edit config's target sections and the locators' own): the column
     itself there and, for a RELATION column, each hop to its sortable leaf, judged in the
     hop's own section (a `component_filter` column → `dd156@dd153`, a portal column → its
     target's list column; `ddoIsAuthorized`; no request principal = an internal resolution,
     unfiltered); otherwise `request.invalid_data` (log reason `view_order`). The rank search
     is system-scoped (it is shared with the write chokepoint, which must see every value), so
     the page order of a column — or of a leaf behind it — the caller may not read would compare
     hidden values: the ordering side channel the general search closes on the root step
     (`search/conform.ts` `rootOrderStepAllowed`) and on every hop (`sql_assembler`
     `buildJoinChain`, SEC-02). Here it is REFUSED rather than silently dropped: the client
     asked for exactly that one column.
     A present `view_order` is validated WHATEVER THE RECORD HOLDS — an empty or one-locator
     portal refuses the same RQO a three-locator one does (`order_locators.ts`
     `assertViewOrder`, run in `expandPortal` before its empty short-circuit); only the ranking
     needs two locators. It is ignored by every non-portal read (`sqo.ts`). **Server half
     only** — no shipped client sends it yet (see *Client status* below).
  5. **`paginated_key` = the STORED index under a read order** (`view_order`). Without a read
     order the two coincide, so every portal read without `view_order` is byte-identical.
  6. **No read-time declared sort.** `relation_core.ts` `expandPortal` serves a declared-order
     portal's stored array AS STORED (it used to sort it for display on every read). An array
     stored before its order was declared (or before the chokepoint existed) shows its stored
     order until it is written again or the `portal_declared_order` reconcile sorts it
     (`relations/declared_order_reconcile.ts`): the operator (Maintenance › Reconcile,
     `scripts/reconcile.ts`), queued POST-COMMIT when an ontology rebuild or a local node
     projection ADDS or CHANGES an `order` (`ontology_state.ts` `rebuildOntology`,
     `ontology_projection.ts` `projectOntologyNode`), and DRY in the post-restore plan (its
     drift held for the operator). No release step, no data-version gate: on a pre-stable v7
     re-ordering is a compatible data change.
  7. **Observer re-sort** (dated addendum on `WC-2026-08-02-observer-relay-writes-nothing`):
     editing a linked record's ordering value re-sorts every host portal holding it, through
     the edges the observer registry derives from the declared order and the default branch's
     re-save (one TM row per host, no host save). A declared-order portal whose
     `sqo.section_tipo` names a DATA-driven source (`hierarchy_types`, `section_model`,
     `ontology_sections`, `field_value`) resolves its targets from records: a write to those
     sections clears the registry (`observer_subscriptions.ts` ORDER DATA SOURCES), so its
     derived edges follow the data without an ontology write.
  8. **One predicate.** "Declared-order portal" is ONE question everywhere — the refusal (3),
     the atomic-append gates, `context.declared_order` (2), the chokepoint sort (1), the
     observer re-save (7) and the reconcile (6) all answer it from the RESOLVED edit config
     (`config[0]`) (`order_locators.ts` `componentDeclaresOrder` = `declaredOrderOf(…) !== null`);
     the raw scan of every request_config item is only the cheap pre-gate. An `order` on a later
     request_config item, or on a column the edit build drops, is a declared order nowhere —
     never refused while the context offers drag and the chokepoint never sorts.
     **Asked by the DATA tipo** (`order_locators.ts` `orderKeyOf` → `ontology/alias.ts`
     `resolveDataTipo`): the stored array lives under a `component_alias`'s TARGET key and every
     save is re-keyed to it (WC-020), so the context of an alias answers exactly as its target —
     an alias whose own `source` override declares a different `order` (or none) cannot show a
     declared order the chokepoint never applies, nor offer a drag the server refuses. That own
     `order` is a declared order nowhere: the reconcile census never scans an alias (no record
     holds an alias key) and NAMES such an alias in `detail.skipped`; the observer registry
     derives no order edge into one.
  9. **The reconcile's report is exact and per-record.** A record whose judging or save fails
     — refused (`ok:false`) or THROWN (a legacy null item the value-shape law refuses) — is
     isolated: `failedCount` counts it exactly, `failed` lists up to 50, and the run goes on to
     the next holder (one malformed array never hides the verdict for every record after it).
     Holders are scanned in keyset pages (bounded memory). The ontology-change trigger runs
     THROUGH the registry (`runReconcile`), so its outcome is the `reconcile` gauge's last run.
     OPEN (owner decision): no DURABLE owed-state survives a process death mid-sweep — it needs
     a store (a section/component on the master ontology, or an engine table — both need
     authorisation); until then the operator dry run lists what a cut sweep left. WHERE the
     trigger's sweep runs is decided at queue time (`declared_order_reconcile.ts`
     `queueDeclaredOrderReconcile`): an ontology UPDATE collects every committed tld's changed
     portals and runs ONE sweep after the last tld and the cross-package model pass
     (`ontology_update.ts` `deriveOntologyPackages` → `ontology_state.ts`
     `withOrderReconcileBatch`) — never between two tlds, where a declared order whose column
     (or column model) a later tld adds or changes would be ranked on that tld's OLD
     definitions, with nothing re-queuing it afterwards; inside a background job the sweep is
     awaited in the write's commit lane (detached, it would outlive the job that owes it and die
     unseen with an update's planned restart); an HTTP request's ontology write (tool_ontology's
     developer `set_records_in_dd_ontology`, an ontology record's TM undelete) HANDS it to a
     tracked background job (`media/jobs.ts`, lane `maintenance`, kind
     `reconcile_portal_declared_order`: the lane deadline, stop, shutdown interrupt) — the request
     never waits on a sweep over every holder. A scope entry the ontology layer refuses to
     resolve (`ontology.invalid_node`) is skipped and named in `detail.skipped` exactly as in
     the unscoped census — one broken alias never aborts the scoped run for the portals beside
     it. It is STOPPABLE: `runReconcile` hands every run a signal composing
     the caller's (the trigger passes the running background job's stop / deadline,
     `media/job_scope.ts` `currentJobSignal`) with the SIGTERM drain's
     (`reconcile/scheduler.ts` `stopReconcileScheduler` → `reconcile/registry.ts`
     `abortInFlightReconciles`); the sweep checks it between records and ends typed
     (`update.failed`, the gauge's `last_error`) — rewritten records stay rewritten, the rest
     is drift. Report payloads carry error CODES, never raw exception text (the census skip
     reason, `failed[].error` of a thrown save — ERRORS_SPEC; the text goes to the log).
     The observer re-save of one relay target is ISOLATED (`observers.ts` `resaveIsolated`):
     a throw is logged and counted (`observers_resave_failed`), the target's hop, the other
     targets and the save's later subscriptions still run; a key whose data tipo declares no
     `order` is not locked or read at all (`no_rule`).
  10. **Mirror recompute measures what it would store.** A `set_dato_external` copy law
     (`source_overwrite`, `observed_data` — order `'desired'`) on a portal that also declares
     `order`: the recompute passes the law's merge through the same key save rules before its
     no-drift compare (`observers.ts` `recomputeExternalRelation`), so the slot converges — the
     second recompute writes nothing (dated addendum on
     `WC-2026-08-02-observer-relay-writes-nothing`).
- **Client status (OPEN, 2026-10-31):** the SERVER half above is shipped; the CLIENT half is not.
  The shipped vanilla-JS client reads `context.declared_order` only for its drag-and-drop source
  (`component_portal/js/drag_and_drop.js` `can_reorder` / `can_drag_out`). Still ungated: the
  header sort button (`common/js/ui.js` `allow_column_order` / `exec_order`) sends the PERSISTED
  `sort_by_column`, and the drag handle's change-order modal (`render_edit_component_portal.js`)
  sends `sort_data` — on a declared-order portal both now answer the item-3 refusal as an error
  toast (nothing moves, nothing is lost). No client sends `sqo.view_order` (item 4): the
  temporary header sort, its indicator and the "save current order" button
  (`can_view_sort` / `can_save_view_order`, exported, uncalled) are not wired. The client half
  (header click → `sqo.view_order` on the get_data refresh and every later page; persist only
  through "save current order"; the change-order modal and the drag handle gated on
  `can_reorder`) is stage **O2** of this change: it lands in the SAME release as this server
  half, before any push, with its own browser gate (`test:client`: a declared-order portal
  offers no persisted header sort and no drag / change-order reorder; a header click sends
  `sqo.view_order`); this entry gains a dated addendum then. Until O2 lands, a header-click
  save or a drag-handle double-click (change-order modal) on a declared-order portal gets the
  item-3 `declared_order` refusal.
- **Reason:** the stored array is what export, diffusion and every reader see; a display-only
  order made the edit view disagree with all of them and made drag on those portals impossible.
  Removing the read-time sort (instead of gating it on the installed data version) keeps ONE
  order on every path; the reconcile, not a read, repairs an unsorted array.
  Write-time enforcement at the one chokepoint is the only shape no door can forget. The
  temporary view keeps the user's column sort without silently rewriting data on a click; the
  stored-index `paginated_key` is what lets a persisted reorder address the right item while a
  read order is shown.
- **Gate reconciliation:** no frozen fixture declares `order`, `sort_by_column` or
  `view_order` (WC-048: 0 corpus hits), so removing the read-time declared sort changes no
  replayed response, and no fixture portal is read under a read order, so
  `paginated_key` is unchanged in every replayed response — the frozen store replays
  byte-identical; no re-harvest needed (none possible).


## Addendum 2026-11-01 — client half (stage O2) landed: *Client status* CLOSED

The *Client status (OPEN, 2026-10-31)* paragraph above, and the "until the client half lands" /
"Server half only — no shipped client sends it yet" sentences of items 3 and 4, describe the
pre-O2 client and are superseded by this addendum. The SERVER contract (items 1–10) is unchanged.

- **Header click = TEMPORARY `sqo.view_order`, never a write.** `common/js/ui.js` `exec_order`
  (portal case) calls `component_portal.set_view_order({tipo, direction}, column)`; it no longer
  sends `sort_by_column`. The offered columns are exactly `can_view_sort` (`sort_by_column: true`
  on the ddo — a declared-order portal included). The instance property `view_order`
  (`{tipo, direction: 'ASC'|'DESC'}` or null) is the one source: `sync_view_order_sqo` stamps it
  as `sqo.view_order` on every EDIT-mode read rqo (the first page, every later page, a destroying
  refresh) and removes it on clear / save. A new order starts at offset 0. Single flight: an
  order change / reset / save is refused while another one or any other read of the portal is
  in flight (`view_order_changing` + status `rendered`); a refused or failed change restores the
  previous order and offset, and a read the SERVER refuses (item 4's `request.invalid_data`) is
  re-read under the restored order, so the portal stays usable.
- **Persist only through "save current order".** The order indicator (`.list_after >
  .order_indicator`) shows the active view order with a reset (`clear_view_order`) and — iff
  `can_save_view_order` (view order active, NO declared order, write permission) — a save
  (`save_view_order` → the existing persisted `sort_by_column`, same column and direction; the
  view order clears on success, stands on a refusal). Without a view order on a declared-order
  portal it shows the PERMANENT declared order, no button. No new action, no new label key.
- **A save echo is never rendered under a view order.** The echo of a link / unlink / add /
  refused save is read in the STORED order (a save carries no `sqo`): under an edit-mode
  `view_order` `build()` drops it and re-reads with the stamped rqo (`echo_hides_view_order`).
- **Drag and the move-to-position (change-order) modal are gated on `can_reorder`**: no drag
  source and no reorder under a declared order (`declared_order_of`, the ONE reader of
  `context.declared_order`) or while a `view_order` is active. So item 3's `declared_order`
  refusal is no longer reachable from the shipped client's header or drag handle (it remains
  the server's guard for any other caller).
- **Gate:** `client/dedalo/test/client/js/test_portal_order.js` (`test:client`, registered in
  `test_registry.js` generic_suites_green): header click reads with `sqo.view_order` (offset 0)
  and writes nothing; indicator / reset / save; pagination and refresh keep the order; link /
  unlink re-read under it; refused / server-refused changes; single flight; declared-order
  portal offers no save and no drag; mosaic alt table adds no second indicator. Server twin:
  `test/unit/portal_order_native.test.ts`.
- **Gate reconciliation:** unchanged — no frozen fixture is read under a `view_order`.
