# WC-2026-08-23-tool-export-register-labels — tool_export's registered label set grew with the breakdown/columns export UI

- **Date:** 2026-08-23 (ledgering an additive change that landed in
  `tools/tool_export/register.json` with the export_tabulator breakdown
  rebuild; the frozen fixture predates it — measured red in
  `tool_element_context_differential`).
- **Scope:** the tool element context served by `get_element_context` for
  `source.model: 'tool_export'` (`buildToolElementContext`,
  `src/core/tools/registry.ts`): the `labels` array.
- **Related:** the export_tabulator breakdown/columns rebuild
  (`engineering/ORACLE_HARVEST.md` tool_export rows); WC-033/WC-034 (label
  ownership).

## Shape before (PHP, frozen 2026-07-11)

`labels` carried the pre-breakdown UI strings only.

## Shape after (TS)

Six label rows were ADDED (per served lang), all consumed by the breakdown /
column-toggle export UI the frozen engine did not have:

`activate_all_columns`, `disable_all_columns`, `active_elements`,
`breakdown`, `tool_export`, `value_with_parents`.

Nothing was removed or reworded: the change is strictly additive.

## Why

The export tool's client gained the deep-breakdown and column-activation
controls after the freeze; their strings live in the tool's own register
(the tool-local label home per WC-034), so the served context necessarily
grew with the UI.

## Gate

`test/parity/tool_element_context_differential.test.ts` filters exactly this
name set out of the TS `labels` before the byte-compare, asserts that the
frozen side carries NONE of them (additive, never a rewording), and — since
the 2026-09-24 addendum — that EVERY name in the set is a TS label (the EXACT
rule; it replaced the original "the filter matched at least one row" check) —
so the exclusion can never quietly widen or go stale: a name dropped or renamed
without editing the set and this entry turns the gate red.

## Addendum 2026-09-24 — the server-built export UI

`tools/tool_export/register.json` grew 22 more label names with the
server-built export (`WC-2026-09-24-tool-export-server-built-artifacts`): the
status line, the preview pager, the download buttons, Stop and Delete.

`delete_export`, `delete_export_confirm`, `download_media`, `download_ndjson`,
`export_deleted`, `export_ended`, `export_failed`, `export_interrupted`,
`export_running`, `export_starting`, `file_failed`, `first_page`, `last_page`,
`media`, `no_columns_selected`, `preparing_file`, `print_current_page_note`,
`quality_for`, `records`, `records_per_page`, `stop`, `waiting_file`.

Still strictly additive: no existing row was removed or reworded, and the
frozen side carries none of these names. The gate's `ADDED` set grows by
exactly these names, and its matched-rows check became EXACT: every name in
`ADDED` must be a label of the served TS context.

The served context reads the labels from the REGISTERED tool (`matrix_tools`,
`buildToolElementContext`), not from `register.json`. A database whose tools
were registered before this change (a suite database not rebuilt, an install
not re-registered) therefore serves only the original six, and the gate is
RED there, listing the 22 names as missing. That red is the correct answer —
the registered tool is stale — and it clears when the tools are registered
again from the new `register.json` (`bun run test:db:setup` does it for the
suite database).

## Addendum 2026-09-24 (b) — six more names: external sources

`tools/tool_export/register.json` gains, 7 langs each: `export_rerun`,
`export_file_incomplete`, `export_external_incomplete`,
`export_external_rerun_advice`, `export_external_admin_advice`,
`export_external_stale` — the status line, the downloads note and the "Run the
export again" button of an export an external source left incomplete
(`WC-2026-09-24-tool-export-server-built-artifacts`, addendum "external
sources"). Strictly additive; the gate's `ADDED` set grows by exactly these six.
Same registration rule as above: red on a suite database whose tools were
registered before this addendum until `bun run test:db:setup` registers them
again.

## Addendum 2026-09-24 (c) — one more name: `export_external_truncated`

`tools/tool_export/register.json` gains `export_external_truncated` (7 langs):
the status line's sentence for external values the export's size limits CUT
(partly in the files), which the "could not be read" sentence used to count and
answer with "contact the administrator"
(`WC-2026-09-24-tool-export-server-built-artifacts`, addendum (c)). Strictly
additive; the gate's `ADDED` set grows by exactly this one. Same registration
rule as above.

## Addendum 2026-09-26 — two more names: the `dedalo_raw` parents note

`tools/tool_export/register.json` gained (commit 572574b, 10 langs each)
`parents_not_in_raw` and `parents_not_in_raw_short`: the tooltip and the
visible *(not in Raw)* note on the per-column "add parents" checkbox, which the
client disables in the `dedalo_raw` format (`WC-049`, addendum 2026-09-25).
That commit ledgered the UI but not this label growth, so
`tool_element_context_differential` went red on a freshly registered suite
database (parity `failing_tests` 100 → 101). Strictly additive: no existing row
removed or reworded, the frozen side carries neither name. The gate's `ADDED`
set grows by exactly these two. Same registration rule as above. No re-harvest
(the gate transforms the TS side before diffing).

## Addendum 2026-10-29 — one more name: the `data_lang` selector label

`tools/tool_export/register.json` gained (commit 8fbec16088, lg-eng and lg-spa rows) `data_lang`:
the label of the export's data-language selector (the lang the values are resolved in). The frozen
PHP side predates the selector, so `tool_element_context_differential` went red on a freshly
registered suite database (parity `tier_pass` 268 → 267). Strictly additive: no existing row
removed or reworded. The gate's `ADDED` set grows by exactly this one. Same registration rule as
above. No re-harvest (the gate transforms the TS side before diffing).
