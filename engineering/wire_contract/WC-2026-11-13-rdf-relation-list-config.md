# WC-2026-11-13-rdf-relation-list-config — a relation_list ddo `config` (section_filter / component_filter) compiles into the hop's filters; the rdf element no longer refuses it

- **Date:** 2026-11-13.
- **Decision:** owner ruling C14 (`T1_owner_decisions.md`, 2026-11-13; item T1-4 "relation_list
  `config` ddo inside rdf": "port if numisdata needs it" — D3b: numisdata1311 / numisdata1314 carry
  it). Closes the "not ported" refusal of `WC-2026-11-12-rdf-graph-interpretation` (addendum
  there). DEC-12 gates: `test/unit/diffusion_rdf_graph_native.test.ts` (compile: the zzdif171
  hop carries `sectionFilter` / `componentFilter`; resolve: the pinned document publishes
  `ex:referencedBy` = 941101 only — 941103 points through another component; the broken element
  still refuses a `config` on a non-relation_list ddo), `diffusion_plan_compile` /
  `diffusion_external_chain_native` unchanged (the shared chain compiler).
- Code: `src/diffusion/plan/compile.ts` (`DdoEntry.config`, `relationListConfigFilters`,
  `compileSourceChain`), `src/diffusion/plan/rdf_compile.ts` (`addChainField` — refusal removed,
  a chain-compiler error still drops the property), `src/diffusion/resolve/rdf_graph.ts`
  (`textEntriesOf`: a chain atom = one lang-less literal per linked record's id).

## Shape before (PHP)

`class.diffusion_rdf.php` `get_ddo_map_value` (:1066-1090): for a `relation_list` ddo WITH
`$ddo->config`, `resolve_configuration($config)` looked the configuration up in the publication
services record (dd1010, `component_json` dd1014 titled `title`, entry `id`) and
`$this->{$config->process_fn}(…)` — `filter_locators` — ran a search over the referrers'
section with the configured `filter`. Without `config`, one lang-null value per referrer:
`$ddo_value->value = $value->section_id`. The relation_list itself (class.relation_list.php
`get_data` :1278-1302) narrowed the inverse search by `section_filter` (the linked sections, the
sqo `section_tipo`, default `['all']`) and `component_filter` (one `from_component_tipo` locator
per tipo).

## Shape before (TS until today)

Any ddo carrying `config` was a compile ERROR of the rdf element ("declares a relation_list
'config' (resolve_configuration → filter_locators) — not ported"): numisdata's Nomisma element
could not compile once D3 restored numisdata1311 / 1314.

## Shape after (TS)

- A ddo `config` is read by the ONE chain compiler (sql and rdf alike) ONCE the model is known:
  on a `relation_list` ddo, `config.section_filter` (string or list of section tipos) → the hop's
  `sectionFilter` (the inverse search's section whitelist) and `config.component_filter` → the
  hop's `componentFilter` (one `from_component_tipo` locator per tipo) — the SAME slots the sql
  grammar's ddo-level `section_filter` / `component_filter` fill (a ddo-level key wins over the
  config one). The resolver applies them as it already did (`relationListLocators`).
- REFUSED loudly, never ignored (a compile error naming field and ddo; the element does not
  compile): a `config` on a ddo whose model is not `relation_list` (PHP read none there — the
  zzdif broken element's portal `config: {filter}` keeps its refusal); a `config` with a key
  outside `section_filter` / `component_filter` (the PHP `resolve_configuration` dd1010 lookup +
  `filter_locators` SQO grammar — `title`, `id`, `process_fn`, `result.ddo_map`, `filter` — is
  NOT ported; see the open question below); a filter value that is not a non-empty list of tipos.
- An rdf literal property whose chain ENDS on the relation hop publishes one literal per
  referrer's `section_id` (PHP's `value = section_id`), lang-tagged per published lang like
  every lang-null literal (divergence 3 of `WC-2026-11-12-rdf-graph-interpretation`).

## Reason

numisdata's rdf properties over relation lists (coins of a type, types referencing a mint) need
to publish only the referrers that reach the record through the mapped component: without the
filter a type's `nmo:hasObverse`-style back-references would list every section pointing at it.
The owner ruled the port; the grammar ported is the relation_list's own filter pair.

## Open — owner question

The planner's reading (`T1_C_impl_plan.md` B3 C14) is that numisdata1311 / 1314 carry
`config.section_filter` / `config.component_filter`. The vendored ontology
(`install/import/ontology/7.0/numisdata.copy.gz`) holds neither node (they live on beta7 since D3),
so the shape could not be verified in this tree. If their `config` is the PHP dd1010 shape
(`{section_tipo:'dd1010', component_tipo:'dd1014', title, id, process_fn:'filter_locators',
result:{ddo_map}}`), the element refuses loudly naming the unsupported keys and the port of
`resolve_configuration` + `filter_locators` (a configured SQO over the referrers) is a further
decision.

## Gate reconciliation

No frozen fixture holds an rdf document. The zzdif pinned document gains one line
(`ex:referencedBy`); the zzdif object records now store FULL locators (`type` +
`from_component_tipo`, the engine's own stored shape) so the inverse breakdown's component filter
has something to match — a fixture change of the test situation, no contract edit.
