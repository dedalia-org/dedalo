# WC-2026-08-11-regenerate-drops-llm-map-post-step — a dd_ontology rebuild no longer rebuilds the LLM map

- **Date:** 2026-08-11.
- **Decision:** none standing; adopted here. Related:
  [WC-2026-08-11-diffusion-uninstalled-package-skip](WC-2026-08-11-diffusion-uninstalled-package-skip.md)
  names the same install's declared-but-empty packages, which is what made the
  removed step's log noise visible.

## Shape before (PHP, and this engine until today)

`tool_ontology_parser::regenerate_ontologies` ran `export_llm_map()` as a
post-step after the dd_ontology write and **merged its errors** into the tool
response — `result` and `msg` stayed the write's, `errors[]` could carry the
map's. The TS port reproduced that as `withLlmMap()`.

## Shape after (TS, from 2026-08-11)

`regenerate_ontologies` returns the write's own summary. `errors[]` now contains
only per-TLD rebuild errors; a failure to write `ontology_llm_map.json` can no
longer appear in a regenerate response.

`export_ontologies` is unchanged: `exportLlmMap` is still its step 5, always
runs, errors still merged.

## Reason

`ontology_llm_map.json` is a **distribution artifact**, not runtime state.
Nothing in the engine reads it; it is served to consuming installs by
`serveOntologyIoFile` (`src/server.ts:453`) beside `ontology.json` and the
per-TLD `.copy.gz` dumps. A regenerate refreshes **none** of those companions, so
keeping the map alone current did not make the served set coherent — it was
stale in company either way until the operator pressed Export, which rebuilds
all of it.

The cost was not marginal. The map builder walks the WHOLE install regardless of
which TLD was selected, and its `linkTargetSections` step builds a full
`request_config` per link field. Measured on `dedalo7_mht` (752 sections, 22151
field nodes, 9408 link fields), regenerating the 178-record `mht` TLD:

| step | time |
| --- | --- |
| `inspectOntology('mht')` — same parse + diff the rebuild does | 76 ms |
| `listSectionNodes()` | 19 ms |
| `sectionFieldNodes()` × 752 | 363 ms |
| **`linkTargetSections()` × 9408 @ 2.2 ms** | **21 060 ms** |
| `buildLlmMap()` total (20 581 ms on a warm re-run) | 21 248 ms |

That is the whole of the observed `[slow-request] dd_tools_api::tool_request took
22097.1ms`: 96 % of a per-TLD write was a whole-install export build. Warm caches
do not help, so it is per-call work, not cold start.

The removed step was also the source of the `[request_config/explicit] dropped
sqo target …` warnings an operator saw on a regenerate — emitted by the map
walk over other TLDs' components, never by the rebuild. Those reports are
correct (the targets really are unresolvable on that install) and still appear
where they belong: on an export, and in normal editing of the components
concerned.

## What this does NOT change

- The map's content, its path, or its export ordering.
- `repair_tlds`, `inspect_ontologies`, `get_ontologies` — none ever ran it.
- The `OntologyExportIo` seam and `runExportOntologies`' abort/continue
  semantics.

## Operator-visible consequence, stated

After a regenerate the served `ontology_llm_map.json` is as stale as
`ontology.json` and the dumps beside it. Press **Export** to refresh the
distribution set. Documented in `docs/using/tools/using_ontology_parser.md` and
`docs/development/tools/reference/tool_ontology_parser.md`.

## Gate reconciliation

- `test/unit/tool_ontology_parser.test.ts` — `regenerate_ontologies` must not
  reach the LLM map (asserted against the handler source, the same technique the
  file already uses for label keys).
- `test/unit/ontology_data_io.test.ts` — unchanged: still pins `exportLlmMap` as
  step 5 of the export pipeline, always-runs, errors-merged.
- **No re-harvest.** The frozen store holds no `regenerate_ontologies` response
  (it is a write action, never harvested), so no fixture moves.

## Addendum 2026-08-11 — the cost argument shrank by 18×; the entry stands on the other one

Same day, the `linkTargetSections` hot path was fixed: `findSectionButtonTipo`
(`relations/request_config/explicit.ts`) probed dd_ontology **uncached**, twice per
resolved sqo target and four times when the section has no such button. An sqo
sourced from `ontology_sections` resolves to every ontology registry target — 205
on dedalo7_mht — so `ontology10`/`ontology42` cost 42 ms per resolution. Memoized
through `createOntologyCache` (hub-cleared, so a newly authored button still
appears), they cost 0.64 ms. `buildLlmMap()` went 21 668 ms → 1 206 ms on the same
install, output byte-identical (sha256 over 9 065 936 bytes).

So the table above is now HISTORY. Removing the post-step saves ~1.2 s today, not
~21 s. **The removal is not revisited**, because the cost was never its first
reason: the map is a distribution artifact whose companions (`ontology.json`, the
per-TLD dumps) a regenerate does not refresh either, so rebuilding it there made
the served set no more coherent — and that is as true at 1.2 s as at 21 s. What
changed is that the operator-visible argument is now "a rebuild is not a publish",
not "a rebuild is unusably slow".

Gate for the fix: `test/unit/request_config_section_button_cache.test.ts`
(verified to FAIL without it). No wire divergence — a pure memoization of a
dd_ontology-derived lookup.
