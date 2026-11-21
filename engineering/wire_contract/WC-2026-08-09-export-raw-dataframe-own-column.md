# WC-2026-08-09-export-raw-dataframe-own-column — a dataframe slot is its own dedalo_raw column, and no cell carries a `dato` key

- **Date:** 2026-08-09 (reported against `numisdata6` §2: a raw export cell for
  the `numisdata163` portal came out with a `dato` key that names nothing in the
  data model, and with another component's rows inside it).
- **Decision:** — (DEC-15 divergence; DEC-12 gate:
  `test/unit/tool_export_raw_dataframe_native.test.ts`).

### What was wrong

Two things, one shape.

`component_dataframe` is a COMPONENT: it has its own ontology node, its own
`relation` slot on the record, and its own stored locators. The frames are tied
to their main component's items by the locator's `id_key`, and by nothing else —
the pairing is carried by the data, not by adjacency. The raw export nevertheless
folded a main's frames INTO the main's own cell, so one cell held two components'
stored data, and the file lost the ability to say "this is the `numisdata1530`
column".

To do that folding it invented a wrapper key, `dato` — the deprecated v6 spelling
of "data", and a key that appears nowhere in the stored record. `dedalo_raw`'s
whole contract is "the stored slice, verbatim, re-importable"; a cell whose top
level is an invented envelope breaks the one property the format exists for.

### Shape before (PHP, and TS until 2026-08-09)

One column per exported component. A framed main's cell:

    {"dedalo_data":{"dato":[…the main's stored items…],
                    "dataframe":[…the frames whose main_component_tipo is this main…]}}

An unframed component's cell: `{"dedalo_data":[…]}`. So the cell's top-level
shape depended on whether the record happened to carry frames.

### Shape after (TS)

**Every** `dedalo_raw` cell is the component's stored slice wrapped exactly once:

    {"dedalo_data": <the component's stored slice>}

and each dataframe slot of an exported component mints its OWN column:

| column key | header (raw tipos) | cell |
|---|---|---|
| `numisdata6_numisdata163` | `numisdata163` | `{"dedalo_data":[…22 portal locators…]}` |
| `numisdata6_numisdata1530` | `numisdata1530` | `{"dedalo_data":[…the slot's frames…]}` |

Ordering: the frame column is registered immediately after its main (same ddo
ordinal, next arrival seq), so the file reads main-then-its-frames.

The frame column is **ontology-driven** (children of model `component_dataframe`
under the exported component), not data-driven: it mints for a frameless record
too, with an empty cell. Two runs of the same export therefore produce the same
column set regardless of which records matched.

The frame column carries the slot's stored data WHOLE — every frame in it, not
only the ones whose `main_component_tipo` is the exported main. That is what the
component stores, and it is what the import writes back.

**Round trip.** The frame column re-imports as an ordinary component column: the
CSV header is the frame tipo, the mapper resolves it like any other component
(`getModelByTipo` → `component_dataframe`), and the relation conform facet writes
the locators with `id_key`, `main_component_tipo` and `type: dd490` intact. This
is why the export can be losslessly split: `id_key` re-pairs the frame with the
main's item on the way back in, exactly as it did on the way out.

**Legacy input stays readable.** `unwrapDedaloData` still accepts the old inner
envelope, under BOTH spellings (`{"data"|"dato", "dataframe"}`), so CSVs exported
before today — and v6/PHP-era files — import unchanged, frames included. It is
read-only legacy: nothing in the engine emits either spelling any more.

### Reason

The consumer here is the CSV file and the importer that reads it back, not a
widget. A cell that mixes two components' data cannot be mapped to a component,
cannot be re-pointed in the column mapper, and cannot be diffed against the
record it came from. Splitting the slot into its own column makes the export say
what the storage says — one component, one column — and makes the frames
addressable in every tool that consumes a raw export.

The `dato` key had no defence at all: it is the deprecated term, it names nothing
in the data model, and the shape it introduced was conditional on the data.

### Gate reconciliation

- `test/unit/tool_export_raw_dataframe_native.test.ts` (NEW) is the shape gate:
  bare `dedalo_data` cells, the extra column and its ordering/header/model, the
  ontology-driven mint on a frameless record, the unwrap+conform round trip, and
  the two legacy envelope spellings. Fixture: the canonical test3 playground plus
  one synthetic `zzdf` dd_ontology node (swept in `afterAll`).
- `test/unit/tool_export_relation_dataframe_fanout_native.test.ts` (the
  generic-TLD twin that RETIRED `test/parity/tool_export_dataframe_differential
  .test.ts`, 2026-08-19) carries the RELATION-main half: the `dedalo_raw` combo
  asserts the TS shape (two columns, no `"dato"`) directly, and grid_value
  default/rows/columns + value/default assert the fan-out's frame column and
  frame values on a `zzxd` situation instead of the retired oracle equality.
- **Re-harvest: NOT needed.** The fixture keeps the PHP response verbatim; the
  gate reads the oracle leg as the fossil instead of diffing it against TS
  (the WC-001 pattern).

## Addendum 2026-11-21 — the frame columns are the main's ONE slot set (T2-SL-6)

The `dedalo_raw` frame columns were minted from the top-level component's ontology children of
model `component_dataframe`. They are now minted — and authorized, once per run, on the same
key — from `resolveDataframeSlotTipos` (`src/core/relations/dataframe_slots.ts`): dataframe
children ∪ the component's own-config ddos (show and hide) ∪ the model's fixed frames — the set
the read, the save cascade and the Time Machine answer. Consequences: a slot a component
declares only in its `request_config` gets its column, and so does `component_iri`'s fixed label
slot (dd560) — both were absent from a dump that claims to be lossless. Column order follows the
set's order (children, config, fixed). Gate: the CROSS-DOOR case of
`test/unit/has_dataframe_literal_native.test.ts`
(see WC-2026-08-09-time-machine-restore-replays-paired-dataframe-frames, addendum 2026-11-21).

## Addendum 2026-11-21 — a caller-injected slot gets its column too (B3 review M3)

Owner ruling 2026-11-21 (B3 Q2): a dataframe slot a CALLER injects (a section map naming a
`component_dataframe` as a literal's child — declared nowhere on the main) is the main's like a
declared one, for every door. The `dedalo_raw` frame columns — and their once-per-run
authorization — now come from `resolveSectionSlotTipos(section, main)`
(`src/core/relations/dataframe_slots.ts`): the declared set ∪ every slot ANY record of the
exported section holds one of the main's frames in (model-checked, sorted). The column set stays
ONE per run (memoized per section + main; a record without frames there gets an empty cell),
and a caller without a read grant on an injected slot is refused the run (`perm.denied` naming
the slot), exactly like a declared one. Cost: one pass over the section's relation column per run
(and one per declaration re-check). Gate: `has_dataframe_literal_native` → "CROSS-DOOR, INJECTED"
(the injected frame exported; the declaration gate refuses without the grant, serves with it).
