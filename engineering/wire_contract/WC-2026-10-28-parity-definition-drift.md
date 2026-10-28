# WC-2026-10-28-parity-definition-drift — four parity expectations re-pinned to the 2026-10 ontology definitions

- **Date:** 2026-10-28 (after the vendored release refresh `60457edca1` + test-TLD regeneration `a421d3be0c`).
- **Decision:** DEC-14b (a frozen-body expectation re-pinned against a deliberate upstream ontology
  change; the frozen PHP bodies are unchanged and each old value stays asserted on the PHP side).
- **Drift, one per gate:**
  - `section_tool_start_differential` (`test6269`, twin of `numisdata201`): the `coins` role of
    `tool_numisdata_epigraphy` points at the portal `test6157` (`numisdata77`) with an inline
    properties copy, no longer at the alias `test6271` (`numisdata203`) the frozen body recorded.
    TS pin: tipo `test6157`, model `component_portal`, properties carried. The coins-less config
    stays byte-compared.
  - `grouper_context_differential` (`test6100`): the unmappable-token cap goes 3 → 1. The two
    component entries the old clone lacked are cloned now; only the install area above the clone
    cut remains (as on `test6099`).
  - `context_differential` (structure-context subset) and `get_element_context_differential`: the
    mint section label is `Ceca` on master (was `Cecas`). The frozen PHP label is asserted as
    `Cecas`, the TS label as `Ceca | testmint`.
- **Coverage note:** no definition in the test TLD routes a section_tool role through a
  `component_alias` any more; the WC-020 alias-in-`tool_config` path has no gate here (open
  follow-up: a scratch `zz*` twin).
- **Client:** none.
- **Gate reconciliation:** TS-only.
