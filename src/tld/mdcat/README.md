# `mdcat` — the TLD package

Code the **mdcat** ontology (the historical-memory catalogue install) names
through its own `process.file`: the grant chain of its exhumation / reparation
files. The ontology declares `calculation` widgets with
`file: "/mdcat/calculation/mdcat.ts"`, so every fn there is mdcat's scope
(ruling Q3, 2026-11-13) — even the ones that carry no mdcat tipo and could be
generic one day (a one-line move back, when a second TLD needs them).

| module key | fn | what |
|---|---|---|
| `calculation/mdcat` | `calculate_period` | days → years / months / days buckets |
| | `calculate_import_major` / `_minor` | grant amount by months; **zero days = no output** (A2) |
| | `to_euros` | pesetas → euros |
| | `range_to_days` | date range → days (min 1) |
| | `days_correction_manually` | the manual day count wins |
| | `subtract` | total − total_period |
| | `final_total` | manual / major / minor − paid; **the major branch is `MAJOR_GRANT_SECTION`** (A1) |

## The one literal

`MAJOR_GRANT_SECTION = 'mdcat2605'` (`calculation.ts`) — the section whose
`final_total` takes the major-grant branch. The earlier engine hard-coded it
in its mdcat file; the owner ruled (A1, 2026-11-13) it stays TLD-owned code,
not an ontology option (`major_section_tipos` exists in no ontology and is
not read). It is the ONLY install tipo the engine tree may name, because this
directory is mdcat's: `engine_install_tld_tripwire` leg 2 allows a package to
name its own TLD and nothing else. Tests read the exported constant, never
the literal.

## Laws (gated by `test/unit/engine_install_tld_tripwire.test.ts`)

- names only `mdcat*` tipos (+ the seed-shipped core TLDs);
- imports `src/core/**` only (through `widgets/calculation/fn_kit.ts`), never
  `src/diffusion/`, `src/external/`, `src/ai/`;
- no fn name shadows a generic one (`summarize`);
- registered once, in `src/tld/registry.ts`.
