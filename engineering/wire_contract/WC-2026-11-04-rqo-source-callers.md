# WC-2026-11-04-rqo-source-callers — new optional `rqo.source.callers`: the element's caller chain, verified by the server

- **Date:** 2026-11-04 (nested-ddo_map plan W4; `src/core/relations/caller_chain.ts`, client
  `common.js` `create_callers` / `create_search_callers`, `component_portal` `picker_caller`).
- **Decision:** DEC-12. Additive request field.

## Shape before (PHP)

A get_data / search that targets a nested element directly (page 2 of tch197 → rsc1400, the
autocomplete inside that cell) arrives as a top-level read: no caller, so the server can
only resolve the element's OWN config.

## Shape after (TS)

`source.callers` — OPTIONAL array of the element's caller instances from the OUTERMOST down
to its direct parent, each `{tipo, section_tipo}`, plus `mode` (`'edit'|'list'`) on the first:

```json
"source": {"tipo":"rsc1400","section_tipo":"rsc1389", …,
           "callers":[{"tipo":"tch197","section_tipo":"tch1","mode":"edit"}]}
```

The first link may be the SECTION itself (`{tipo:S, section_tipo:S, mode}`) when the
outermost component is a column of a section's LIST map. A top-level component sends no
`callers` key at all (byte-unchanged). The RQO schema does NOT type the key (any value
passes it — never a `request.invalid_rqo` 400). The server VERIFIES, never trusts: shape (an
array of 1..`MAX_DDO_DEPTH` links, checked by length before any link is walked; short
tipos) — a non-array or an over-long list is a shape failure like any other; the root readable by grant (section read grant + the
component's own; a SECTION root's map gated by STEP 11); every further link and the target a
declared data child (show/hide line) of the link above in its EFFECTIVE config. Any failure
→ the whole chain is ignored (one log line `[relations/caller_chain] refused source.callers
…`) and the read proceeds exactly as without one. A verified chain resolves the target under
its caller (stage-1 inheritance — `WC-2026-11-04-nested-paging-add-show`; the search read
floor from the effective config, decision (f); the writer scope —
`WC-2026-11-04-writer-chain-scoped-search`).
Known limitation (fail-closed): a LIST read whose columns came from a preset or a client show
rather than the ontology map is not reproduced — the read falls back to the target's own
config.

## Reason

The server cannot know where a directly-targeted element sits; the client names the address
and the server re-derives everything from the ontology.

## Gate reconciliation

`test/unit/subdatum_permission_native.test.ts` (forged chains refused, SECTION-rooted list
chain incl. *SHAPE: an empty chain, a non-array and one over MAX_DDO_DEPTH links are refused
as shape* and *the RQO schema accepts any source.callers value*, page-2 inheritance, read floor, count door); client
`client/dedalo/test/client/js/test_caller_chain.js`. Parity: `hashRequest` keys on the
canonical rqo — no frozen request carries `callers`, and a top-level read sends none; no
drift. **Re-harvest: none.**
