# WC-2026-11-22-diffusion-dataframe-hop — a component_dataframe ddo whose parent is its main publishes only that main's frames, from the host record, each with its pairing id

- **Date:** 2026-11-22 (T2 batch B8: DIF-3). The first native statement of the dataframe
  diffusion contract.
- **Decision:** T2-DIF-3 (port the frozen-v7 rule in the compiler: host-record hop +
  `mainComponentTipo`, carry the pairing id). Code: `src/diffusion/plan/compile.ts`
  (`dataframeHostScope`), `src/diffusion/plan/types.ts` (relation-hop `mainComponentTipo`),
  `src/diffusion/resolve/resolver.ts` (`resolveHop` frame filter + link pairing,
  `leafMergeColumns`), `src/diffusion/resolve/record_ir.ts` (`ResolvedLink.idKey` /
  `mainComponentTipo`), `src/diffusion/resolve/rewriters.ts` (`get_locator`).
- **Shape before (PHP):** v6 never published the id_key dataframe (its
  `component_dataframe::get_diffusion_value` is a bare `get_value()`; diffusion read only the
  pre-6.4.3 `$locator->dataframe`). Frozen v7 `component_dataframe::get_diffusion_data`: a ddo
  whose `parent` names the main component published only the frame locators whose
  `main_component_tipo` is that main (verbatim — `id_key` included); no parent (or `self`) →
  every frame of the slot. TS before this entry compiled the dataframe ddo UNDER the main's
  hop, so it ran against the main's linked records (the section filter skipped it — nothing
  published); at root level it published every frame of the slot, no main scoping, and the
  published locator carried no pairing.
- **Shape after (TS):** a component_dataframe ddo with a ddo-tipo `parent` compiles to a
  relation hop at the MAIN's own chain level (the host record: the record that holds the main)
  with `mainComponentTipo` = the parent; it keeps only the slot entries that are frames
  (`type` dd490) of that main. The ddo still names the main as its parent for the leaf/column
  rule (the main is not a leaf column, as PHP's textual rule). Every frame locator read from a
  slot carries its pairing: `get_locator` republishes `id_key` (verbatim) and
  `main_component_tipo` after `section_tipo`/`section_id`; no other locator changes shape. A
  dataframe ddo with no parent (or `self`) is unchanged (every frame of the slot).
  Refused at compile, naming field + ddo: a parent that is not a ddo of the same ddo_map, a
  parent that is itself a dataframe or has no model, a parent that does not declare the slot
  (the one slot set, `resolveDataframeSlotTipos`: ontology dataframe children ∪ own
  request_config ddos ∪ the model's fixed frames).
  A child expansion of the dataframe hop (frame target fields) publishes the target's values;
  the pairing travels on the frame locators themselves (publish them in a sibling column to
  join).
- **Reason:** one slot may serve several mains (a shared label dataframe); without scoping a
  publication joins one main's items to a sibling main's frames, and without `id_key` a
  consumer cannot join a frame to the item it extends.
- **Gate reconciliation:** no parity gate publishes a dataframe (none in the harvest); no
  fixture edit, no re-harvest. New gate: `test/unit/diffusion_ddo_hop_native.test.ts` (zzdhp:
  one slot, two mains, ddo scoped to one → only its two frames, `id_key` 1/2 +
  `main_component_tipo`; the main's own locators unchanged; wrong parent refused).
