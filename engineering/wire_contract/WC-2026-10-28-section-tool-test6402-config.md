# WC-2026-10-28-section-tool-test6402-config — test6402 reroutes; the config-less section_tool refusal moves to a scratch gate

- **Date:** 2026-10-28 (feature crawl #11).
- **Decision:** DEC-14b (a parity expectation re-pinned against a deliberate ontology fix); DEC-12
  (the refusal contract keeps a gate: `test/unit/section_tool_context.test.ts` "start on a
  section_tool: config.target_section_tipo or a loud refusal").
- **Shape before:** `numisdata625` (Countermark descriptions, a `section_tool`) carried its target
  under the v6 key `properties.context`. Neither engine reads it: PHP fatals building a section on
  the non-section tipo (`result:false`), TS refuses `resource.conflict`. Its test-TLD twin
  `test6402` was the parity differential's "config-less section_tool → BOTH engines refuse" case.
- **Shape after:** the maintainer renamed the key `config` on the master ontology and the local
  install (2026-10-28). The vendored source `test/fixtures/ontology/numisdata_ontology.copy.gz` got
  the same one-row edit, and `test6402` in `src/core/test_data/test_tld_ontology.json` the value a
  clone-script run produces from it (`config`, twin tipos). `start` now reroutes `test6402` to
  `test6099`. `section_tool_start_differential` keeps the frozen PHP refusal (the pre-fix answer)
  and pins the TS reroute; the refusal itself is pinned on scratch `zzstc1` (a `section_tool` with
  only the v6 key), with `zzstc2` (`config`) as the rerouting control.
- **Not done here:** a full clone-script regeneration — it refuses at HEAD on three dangling
  references from the 2026-10 vendored release refresh (`mdcat4500`, `mdcat597`, `mdcat681`) and,
  once excluded, rewrites ~290 test-TLD nodes; a separate change.
- **Client:** none.
- **Gate reconciliation:** TS-only; the frozen PHP body is unchanged.
