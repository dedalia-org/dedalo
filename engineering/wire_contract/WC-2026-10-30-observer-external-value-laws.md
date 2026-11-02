# WC-2026-10-30-observer-external-value-laws — both PHP sub-laws ported behind one closed classifier, one merge, observer-owned ids

- **Date:** 2026-10-30 (the external-value law, reachable from propagation and from the
  on-demand refresh; owner rulings of the same day: dangling source ⇒ `[]`, tag langs
  = union in document order, port the `set_observed_data` no-`perform` branch, no data
  repair).
- **Decision:** DEC-12 (gated: `test/unit/external_law_classify.test.ts`,
  `test/unit/external_merge_mirror.test.ts`, `test/unit/external_tag_locators.test.ts`
  (the pure laws), `test/unit/observer_source_overwrite_native.test.ts` (law
  `source_overwrite`), `test/unit/observer_observed_data_native.test.ts` (law
  `observed_data`, the gone-record rule included),
  `test/unit/external_law_registry_tripwire.test.ts` (every corpus node maps to one law;
  the shrink-only named exemptions), `test/unit/covered_slot_consumers_native.test.ts`
  (duplicate / create / bulk-revert consumers) and the positive-law cases of
  `test/unit/observer_failsafe_native.test.ts`). Supersedes the
  Phase-0 disarm row of `WC-2026-08-06-observer-grow-only-failsafe-retired` (see its
  2026-10-30 addendum).

### Shape before (PHP)

`component_relation_common::set_data_external` (frozen
`class.component_relation_common.php:1793-1888`) chose a law by key order and never
refused:

1. `source.set_observed_data` (`:1793`) — the first ddo only. With a `perform` it
   called the method the ontology names (`call_user_func_array`), in practice
   `component_text_area::get_locators_of_tags`, which reads `$options->ar_mark_tag ??
   ['svg']` (`class.component_text_area.php:298`) out of `data[0].value` of the data
   lang only. With no `perform` (`:1810-1831`) it copied the ddo's `get_data()`
   verbatim.
2. `source.source_overwrite` + `component_to_search` (`:1849`) — the "tool cataloging
   case": the FIRST pointer locator, taken blindly, names a record whose
   `source_overwrite.data_from_field` component is copied **with its item ids**. An
   empty pointer left the mirror untouched (stale). A pointer to a deleted record read
   `get_data()` = `[]`.
3. otherwise the default inverse-search law (law (c)).

PHP took (1) when both sub-laws were declared, and fell through to (3) for a
`source_overwrite` without `component_to_search`. It always saved, drifted or not, and
applied no >2000 freeze on (1)/(2).

### Shape before (TS, 2026-08-02 → 2026-10-30)

Both sub-laws were refused before any read (`observers_unported_sublaw_refused`,
outcome `refusedSublaw`). That disarm was correct — law (c) on `numisdata679` /
`numisdata965` recomputes 131,806 stored locators to zero — but it left every catalog
term's *Coins* / *Ordered coins* portal empty after a `tool_cataloging` drop (the
reported bug) and the six legend-symbol mirrors (`numisdata563`, `numisdata574`,
`numisdata575`, `numisdata993`, `numisdata1227`, `numisdata1229`) never recomputed.

### Shape after (TS)

**One closed classifier** (`src/core/section/record/external_laws/classify.ts`
`resolveExternalLaw`, cached per ontology version) maps every node to exactly one law
or one named refusal. No law ever falls back to another.

| `properties.source` | Law |
|---|---|
| `set_observed_data[0]` with `perform.function: get_locators_of_tags` | `observed_data` (`get_locators_of_tags`) |
| `set_observed_data[0]` with no `perform` | `observed_data` (`copy`) — only for a relation-stored ddo |
| `source_overwrite.data_from_field` (string) + `component_to_search` | `source_overwrite` |
| `component_to_search` | `inverse_search` (law (c), byte-identical) |

Refusals that **PHP did not make** (each counted `observers_law_refused` + the old
alias `observers_unported_sublaw_refused`; outcome `refusedLaw: {reason}`):

| Reason | PHP did |
|---|---|
| `both_sublaws` | took `set_observed_data` silently |
| `sublaw_with_data_from_field` (a sub-law next to law (c)'s seed key) | ignored the extra key |
| `source_overwrite_without_component_to_search` | fell through to law (c) — the wipe law for that node |
| `source_overwrite_malformed` (non-string `data_from_field`) | read whatever was there |
| `observed_data_malformed`, `observed_data_function_unknown`, `observed_data_tags_invalid` | called the named method on whatever it got |

`node_missing`, `source_not_object` (the `oh55` string / `oh90` number sources) and
`component_to_search_missing` keep the historical counted skip
(`observers_component_to_search_missing`, no `refusedLaw`).

**`source_overwrite`** (`external_laws/source_overwrite.ts`):

- the target row's mirror, `_hi` index and pointer are read in ONE `FOR UPDATE`; the
  source row `FOR SHARE`, always target first;
- the **first QUALIFYING** pointer locator wins — the first whose section declares
  `data_from_field` (`declaredSectionComponents`, virtual-aware). PHP took the first
  blindly, so a term whose first link was a mint or a period copied nothing. A
  malformed locator is skipped and counted (`observers_source_overwrite_pointer_malformed`);
- empty pointer / no qualifying locator ⇒ `[]` (PHP left the mirror stale — an
  unlinked term kept the old type's coins);
- the pointed record is gone ⇒ `[]` (**PHP parity**, owner ruling);
- `data_from_field` has no ontology node, or the pointed section has no matrix table ⇒
  a DEFECT: the law is unanswerable, drops are withheld (the degraded-seed rule of
  `WC-2026-08-06-observer-degraded-seed-refuses-shrink`).

**`observed_data`** (`external_laws/observed_data.ts`):

- tags = `ar_mark_tag ?? ar_tags ?? ['svg']`. **TS honours `ar_tags`; PHP ignored it.**
  Every live and fixture node declares `params: {ar_tags: ['svg']}`, so the output is
  the same today — this is a divergence, not parity;
- the tag set is CLOSED: `LOCATOR_TAG_TYPES = svg, draw, geo, page, note, lang` (the tag
  patterns whose payload sits where `get_locators_of_tags` reads it); `person`, `index`
  and `reference` are excluded. A non-locator payload is skipped (PHP pushed whatever
  `json_decode` returned);
- **langs: the UNION of every stored lang**, in a fixed order — `lg-nolan`, the main
  data lang (`config.lang.dataLangDefault`), then the rest sorted — and inside each
  text the **document order** of the tags (the order the user arranged the symbols in
  the legend). First occurrence wins. PHP read `data[0]` of the request's data lang,
  so the stored mirror depended on who saved last. The live legends
  (`numisdata195` on `numisdata41/4732`) are stored `lg-nolan`, where the union equals
  PHP's read;
- the `copy` branch is ported for a relation ddo only (a literal ddo's
  `{id, lang, value}` items are not locators — PHP would have stored them as locators).
  No live or fixture node uses it;
- a missing ddo node or a ddo of the wrong storage is a defect
  (`observers_observed_data_unanswerable`, drops withheld); an empty text is `[]`.
- **a tag whose record is GONE contributes nothing** — the same gone-record rule as
  `source_overwrite`. The delete door strips the deleted record's locator from every
  inverse slot, this one included, but leaves the text's tag in place; without the rule
  the next recompute (a save of the text, the update-external button, the reconciler)
  would write the dead locator back into live relation data and the relation index,
  and the reconciler would report the record drifted for as long as the tag exists.
  With it, the strip and the recompute agree. PHP pushed the locator regardless. Gate:
  `observer_observed_data_native` (deletes the tag target through the delete door, then
  saves the text: the mirror stays without it).

**One merge for every law** (`external_laws/merge.ts` `mergeMirror`):

- identity `section_tipo|section_id`; a kept item keeps its STORED id, a new one gets
  the next id past the stored max — **observer-owned ids**, where PHP copied the
  source's ids. A copy's frame drops by dropped id stay correct across a type switch
  (no dataframe child exists under `numisdata77`, `numisdata679`, `numisdata11`,
  `numisdata965` — nothing is lost);
- `from_component_tipo` forced to the observer; `type` from the desired item, else the
  observer's relation type (not a hard-coded `dd151`) for the copy laws;
- every other desired key is KEPT (the S7 mirrors carry `component_tipo`, e.g.
  `{…, section_tipo: 'sclat1', section_id: 86, component_tipo: 'hierarchy95'}`);
  `section_id` canonical int (`'86'` ⇒ `86`, WC-2026-08-10-section-id-int-canonical);
  self-references dropped;
- order: law (c) `'stored'` (kept in stored order, then appended — byte-identical to
  the old `mirrorAdditions`); the copy laws `'desired'` (the source's order IS the
  value — `numisdata965` is *Ordered coins*);
- **no-drift skip**: a kept item equal to the stored one up to key order is re-emitted
  verbatim, so a recompute that changes nothing writes nothing (no TM row, no stamp).
  PHP always saved;
- the >2000 freeze applies to law (c) only (**PHP parity** for the copy laws).

**Covered state reaches the consumers.** "Covered" = a stored law AND a
`set_dato_external` edge with a resolvable shape
(`isCoveredExternalObserverNode`). The copy-law slots are therefore derived state:

- duplicate strips them and recomputes them by declaration
  (`ownDataCoveredSlots` ⇒ `selfRecompute`) — before, a duplicate never recomputed an
  `observed_data` slot (its input is a `string` key, outside the relation birth edges);
  `createSectionRecord` adds the same slots to its birth's `selfRecompute`, so a
  `dato_default` filling a copy law's input is recomputed too (an empty input is a
  no-drift no-op; gate: `covered_slot_consumers_native` 1c, a source leg — no suite node
  declares such a default);
- bulk revert treats an `observed_data` slot as the only indexed witness of a text
  tag's link (still a link for `isReferenced`); inverse and `source_overwrite` slots
  re-state an indexed edge and are not links (`isRestatedEdgeSlot`);
- the reconciler sweeps the copy laws at every section that declares the observer.

**Not covered any more:** `testimmovable1000`-`1002` (an `observe` edge with
`use_observable_dato` but no `component_to_search`) were stripped on duplicate; their
law is a refusal, so they are now copied verbatim. They never computed either way.

### Reason

The premise: a catalog term must show the coins of the type it is catalogued under,
and a coin's legend symbols must follow its legend. Both were declared in the
ontology and silently dead. Each divergence above is the structurally correct reading:
an ambiguous node refused instead of guessed; a mirror that owns its ids, order and
membership; a value that is a pure function of committed data, never of who saved.

### Gate reconciliation

No fixture re-harvest: the oracle store holds read-path shapes; this is a write-path
value law. The served bytes of an external portal are the stored mirror, which now
matches what a correct PHP re-save would produce for law (c) and the copy laws, except
for the ids, the key preservation and the lang/tag rules listed above. Static pins that
read `observers.ts` for the moved code were repointed at `external_laws/`.

Corpus note (dry run on `dedalo_mib_v7`, `write: false`): `numisdata679` and
`numisdata965` now sweep `numisdata651`, `numisdata665`, `numisdata691` and
`numisdatacatalog1`; `numisdata563` 4,180 candidates, 0 drifted. Nothing was applied
(no data repair).
