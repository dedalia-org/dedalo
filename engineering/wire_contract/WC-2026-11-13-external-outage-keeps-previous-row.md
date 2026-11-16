# WC-2026-11-13-external-outage-keeps-previous-row — a `component_external` OUTAGE during publication SKIPS the record's row (the previous publication stays) and is retried by the next run

- **Date:** 2026-11-13.
- **Decision:** owner ruling C49 (`T1_owner_decisions.md`, 2026-11-13; item T1-42 OD-1 "Zenon
  outage during publication"): "skip row + report (never unpublish by outage)". Closes the OPEN
  decision of `WC-2026-11-12-diffusion-external-chain` (addendum there). DEC-12 gate:
  `test/unit/diffusion_external_chain_native.test.ts` — the `zzdxo` situation (own external
  section on a public IP literal, `fetch` stubbed per remote id): 503 → no row / no unpublish /
  `skipped` + line; one down locator among healthy ones holds the whole row; 404 (`not_found`)
  still writes the row with the value empty; `publishedRecordsOf` (runner) leaves the held
  records out of the dd1758 ledger. Mutation-verified RED: with the outage set emptied the 503
  record publishes a row with the value empty.
- Code: `src/diffusion/resolve/external_value.ts` (`OUTAGE_STATES`, `isExternalOutage`),
  `src/diffusion/resolve/resolver.ts` (`SkippedRecord`, `ResolvedBatch.skipped`,
  `drainExternalDegradations` → the skip, `processRecord` / `processRdfRecord` / `processBatch`),
  `src/diffusion/runner.ts` (`publishedRecordsOf`).

## Shape before (PHP)

A failed remote read published the component's value EMPTY, silently: a Zenon outage during a
publication run replaced the public bibliography columns with empty cells — an unpublish by
accident, repaired only by the next successful run.

## Shape before (TS, WC-2026-11-12 → this entry)

The row was still written, the field keeping its other locators' values, and a run error line
`external_source:<state> <component> <section>/<remote id>` named the loss (the loud channel).
The public value was still emptied for the run's duration.

## Shape after (TS)

The missing states split in two:

| state | meaning | the record's row |
|---|---|---|
| `unavailable`, `timeout`, `circuit_open` | an OUTAGE — the source is configured and exists but could not be asked NOW; the answer may differ next run | **SKIPPED**: no row written, no row removed, no graph, no dd1758 `published` row; `ResolvedBatch.skipped` carries `{sectionId, reason}`; the record's error line reads `external_source:<state> <component> <section>/<id> — row SKIPPED (previous publication kept; retried by the next run)`; the run finishes "Partial success" naming it |
| `disabled`, `misconfigured` | an operator's decision or defect — retrying changes nothing | written, the value empty, the error line as before |
| `not_found` | the source's own answer (the remote record is gone) | written, the value empty, no line (unchanged) |

- The record's publication gate is untouched (`status: 'publish'`): it is publishable, merely
  held back; a gate `unpublish` still removes the row as before (an outage never blocks a
  withdrawal — the unpublish path reads no remote value).
- ONE down locator among healthy ones holds back the WHOLE row: a partial row would publish the
  healthy values and empty the down one — the very unpublish-by-outage the ruling forbids.
- The rdf element behaves alike: the record's document is not produced this run (the previous
  file stays); a subject failure still withdraws (fail-closed, unchanged).
- Retry: there is no separate ledger — the record is selected again by the next run of the
  element like every other record (`jobs/pending_retry.ts` is the UNPUBLISH debt and does not
  fit: nothing is owed to the target, a value is owed to the run). A frontier record held back
  is still `used` for the run (no duplicate processing) and still queues its own linked records.

## Reason

A publication must never remove heritage data from the public site because a third-party service
was down for the minutes the run took: the public table's previous row is the better answer
until the source answers again. A configuration state is not an outage: publishing empty there
is the honest result of the operator's setting, and the line says so.

## Gate reconciliation

No frozen fixture reaches a component_external in a publication (WC-2026-11-12). The chain gate's
degraded case (`misconfigured` — the allowlist meter refuses the host) is unchanged by design: a
configuration state still publishes the row.

## Addendum 2026-11-14 — the held record stays in the CONSOLIDATED artifacts too (review of a0e4a8252f)

The entry above kept the per-record publication (the MariaDB row; the rdf/xml/markdown per-record
file) and the dd1758 ledger row. It did NOT keep the record in the consolidated document and zip
the file writers build at close FROM THE RUN MANIFEST (`WriterCloseContext.manifest()`, a replay of
the run's `wrote`/`removed` artifact events): a held record wrote no file, so it had no event, so
it was absent from `diffusion_rdf_merged.rdf` / `diffusion_xml_merged.xml` and the zips — and a
run that held EVERY record (the service down for the whole run) had an EMPTY manifest and
WITHDREW the previous run's merged document and zip (`withdrawConsolidated`). That is an unpublish
by outage at the artifacts consumers download.

**After.** `WriterSession.keepPublished?(section, ids)` (rdf / xml / markdown): for each held
record whose previous per-record file still exists the session notes a `wrote` artifact event —
the file IS this run's publication of the record, bytes unchanged — and the runner calls it per
batch with `ResolvedBatch.skipped` before taking the batch's events. The held record therefore
rides the manifest into the merged document and the zip exactly as the records this run wrote; a
held record that never had a file is not carried (nothing to keep; its report line already says
it was skipped). Writers whose previous publication is not a per-record file (MariaDB, csv, json)
have no door: their rows and run-built files were already right. Gate:
diffusion_consolidated_withdrawn_native (hold both → artifacts kept holding both; hold only a
never-published record → withdrawn — RED before: no door).
