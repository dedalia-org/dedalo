# WC-2026-08-09-ddo-map-per-entry-sanitization — an unusable ddo is dropped, not 400'd

- **Date:** 2026-08-09 (audit `audits/2026-08_oh1_beta/REPORT.md` §7, finding X1).
- **Decision:** DEC-12 gate shipped with it — `test/unit/ddo_schema_native.test.ts`.

## The defect

`ddoSchema` (`src/core/concepts/ddo.ts`) is not only the client-echo sanitizer. `rqoSchema`
embeds it, and `src/server.ts` answers **400 `Invalid RQO`** on a parse failure — before any
handler runs. So a single ddo the schema cannot parse does not degrade a field: it kills the
whole request.

Two of the schema's declared value TYPES did not match what `dd_ontology` actually authors:

| field | schema said | ontology stores | authoring nodes |
|---|---|---|---|
| `hover` | `string` | `true` (boolean) | 16 `component_portal` (`dedalo7_mht`), incl. **`oh17`**, the oh1 identifying-image portal |
| `section_id` | `number \| string` | explicit `null` | `rsc36`/`oh83` tool_transcription roles, `numisdata672`, `component_text_area` |

The client echoes back the shape our own context responses ship, so any RQO carrying one of
those ddo_maps 400'd wholesale — a dead screen, not a missing tooltip. `hover` is a FLAG, not
text: the client tests it as `columns_map.filter(el => el.hover===true)`
(`client/dedalo/core/component_portal/js/view_mosaic_edit_portal.js:204`).

Beyond the two types, `z.array(ddoSchema)` is all-or-nothing where PHP is per-entry, and the
ontology also authors ddos NO consumer can use — a bare `{}` (`test188`) and tipo-less entries
(`numisdata1138`, `numisdata1139`).

## Shape before (PHP)

`request_config_object::sanitize_client_ddo_map`
(`core/common/class.request_config_object.php:673`) whitelists **keys** and never types their
values. It loops the map, `continue`s past an entry it cannot use (logging a WARNING), and
never aborts the map, let alone the request. `tipo` is not required. The ONLY shape check is on
the two pagination fields:

```php
foreach (['limit','offset'] as $pag) {
    if (property_exists($clean_ddo,$pag) && (!is_int($clean_ddo->{$pag}) || $clean_ddo->{$pag} < 0)) {
        unset($clean_ddo->{$pag});   // drop the KEY, keep the ddo
    }
}
```

## Shape after (TS)

Three of the four changes RESTORE the oracle and are recorded here only for context:

- `hover: z.boolean()`, `section_id: … .nullable()` — the schema now accepts what the ontology
  authors, so the affected RQOs stop 400ing;
- `limit`/`offset` are `z.number().int().nonnegative().optional().catch(undefined)` — a
  tampered shape drops the KEY and keeps the ddo, exactly as PHP does and exactly as
  `docs/api/dd_object.md` has always documented ("accepted only as non-negative integers (any
  other shape is dropped)"). Before this, `limit: -5` and `limit: 1.5` both passed straight
  through to `pagination.limit`, while `limit: '10'` failed the request;
- `buildSqoSectionTipoDdos` (`src/core/relations/request_config/explicit.ts`) stamps the
  caller's real ACL on every portal TARGET-SECTION ddo instead of a literal `3`, and derives
  each `button_new`/`button_delete` descriptor from its OWN grant — PHP
  `build_sqo_section_tipo_ddo` / `build_section_buttons`
  (`core/common/trait.request_config_utils.php:424`, `:467`). No ledger entry of its own: it is
  a restoration, and the fabricated 3 was never a decision.

**The one DIVERGENCE** is `ddoMapSchema`, now per-entry:

```
client ddo_map [ {}, {section_tipo:'numisdata3'}, {tipo:'rsc20', hover:true} ]

  PHP  → [ {}, {section_tipo:'numisdata3'}, {tipo:'rsc20', hover:true} ]   (kept, unresolvable)
  TS   → [ {tipo:'rsc20', hover:true} ]                                    (dropped, logged)
```

An entry that fails the schema is dropped with a `console.warn` naming its `tipo` and the zod
issues (the DEC-07 posture: narrow if you must, never in silence). `tipo` stays MANDATORY for
an entry to survive — the whole resolution graph keys on it (`getDirectChildren`,
`getDescendants`), and PHP's own downstream `validate_requested_ddo` resolves nothing for a
tipo-less ddo either.

## Reason

The divergence is **downstream-equivalent and upstream-safer**. PHP's kept-but-unusable entry
produces no output; TS's dropped entry produces no output. What differs is the blast radius of
the failure mode PHP never had: with a strict array, one authoring typo anywhere in an
ontology ddo_map takes down every request that carries it. Restoring PHP's per-entry posture
was the correct fix, not widening the schema until nothing can fail — an over-strict whitelist
and a permissive one are the same defect from opposite sides.

Resilience is NOT a licence for type drift: dropping silently is exactly what would have HIDDEN
the `hover` mismatch. The pairing is deliberate — resilient at the wire, strict at the gate.

## Gate reconciliation

- `test/unit/ddo_schema_native.test.ts` (new, 17 cases). The load-bearing one is the
  **ontology-wide census**: every `ddo_map` entry in `dd_ontology`, key-whitelisted exactly as
  PHP does, is parsed through `ddoSchema` STRICTLY. That is the mechanical guard the resilience
  above would otherwise remove, and it goes red the next time a declared type stops matching an
  authored one. It is DB-backed, so it is a native gate rather than a hermetic
  `engineering/TRIPWIRES.md` row.
  - Named exemption, by MODEL not by shape: `section_list_thesaurus`. Its
    `properties.show.ddo_map` is not a wire ddo_map but the tree-element descriptor list
    consumed by `src/core/ts_object/ts_object.ts` and
    `src/core/section/list_definitions/section_list_thesaurus.ts`, both of which declare their
    own `{tipo, type, icon}` shape and never touch `ddoSchema`. Two of its entries carry an
    ARRAY `tipo` (`ontology32`, `rsc1050` — the multi-term tree label), meaningless on the RQO
    wire.
  - The schema's key set is asserted equal to PHP's `$allowed_fields`, so the whitelist itself
    cannot drift while the types are being maintained.
- The resilience half is gated from both sides: a tipo-less ontology ddo is dropped, and an RQO
  carrying `[{}, {section_tipo:…}, {tipo:'rsc20', hover:true}]` still parses.
- **No re-harvest.** The frozen store carries no fixture of an unusable ddo_map entry, and the
  read paths it replays are unchanged: every fixture ddo bears a `tipo` and parses identically
  before and after. `test/parity/replay.test.ts`, `context_differential`,
  `edit_ddo_map_differential`, `component_edit_context_differential` and `buttons_differential`
  are green on this change.
