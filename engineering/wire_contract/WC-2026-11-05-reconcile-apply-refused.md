# WC-2026-11-05-reconcile-apply-refused — a refused reconcile apply says why; the widget offers a scope

- **Date:** 2026-11-05 (owner report: master's `ontology_machine_names` apply showed
  `apply — drift 16537, applied 0` and nothing else). Amends
  `WC-2026-09-03-maintenance-reconcile-status-widget` (row, run record, message) and
  `WC-2026-10-22-reconcile-deferred-rearm` (the record/gauge shape it extended).
- **Decision:** DEC-12 (gated: `test/unit/reconcile_status_client.test.ts`,
  `test/unit/machine_name_reconcile_native.test.ts`; `reconcile_registry_tripwire` pins the
  gauge keys against PRODUCTION.md §6.5).
- **Shape before (TS):** a definition whose own precondition refused an apply could only
  say so inside its `detail` (machine names: `detail.apply_refused`). The widget's last-run
  line and the run message read `apply — drift N, applied 0` — a refusal indistinguishable
  from a run that found nothing it could write. The widget sent no `scope`, so an apply that
  REQUIRES one (machine names on an ontology server) could never succeed from the panel.
- **Shape after (TS):**
  - **Registry.** `ReconcileReport` gains an optional `refused: { reason }` — the apply was
    refused by the definition's precondition, nothing applied, NOT owed (re-running
    unchanged is refused again). `ReconcileRunRecord` gains `refused: string | null`; the
    `reconcile` gauge gains `last_refused`. `detail.apply_refused` is gone (machine names
    report `refused`).
  - **Scheduler.** A refused run is `completed` (warned, not re-armed sooner).
  - **Operator surfaces.** The run message reads `<name>: drift N, nothing applied —
    REFUSED: <reason>`; the last-run line `<ranAt> REFUSED — drift N, nothing applied:
    <reason>`; `scripts/reconcile.ts` prints `REFUSED: <reason>`.
  - **Scope.** A row whose definition has a `scope_label` renders a scope field
    (comma-separated values, empty = all); Check and Apply send it as `options.scope`
    (the server already accepted it).
  - **Machine names on an ontology server**: the refusal names how — an explicit TLD scope
    (the widget field or `scripts/reconcile.ts --scope`), applied TLD by TLD.
