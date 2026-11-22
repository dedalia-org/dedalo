# WC-2026-11-22-section-containment-law — a component parked under a `box elements` container is not of the section, for every walker (the v6 law)

- **Date:** 2026-11-22 (T2-SL-3a).
- **Decision:** T2 triage row SL-3 (O08, latent); owner ruling 2026-11-21 SL-3a **(b)**: the
  containment law applies EVERYWHERE, as v6; `delete_data` leaves the data of components parked
  under box elements; the two gates that pinned the old walk are re-homed. DEC-12 (gated:
  `test/unit/section_containment_native.test.ts`).
- Code: `src/core/ontology/resolver.ts` — "THE SECTION CONTAINMENT LAW" (`isOutsideSectionContainment`,
  the one predicate; the walk `readSubtreeRows` applies it in SQL; `getContainingSectionTipo` /
  `tipoInSectionContainment`, its upward form); `src/core/section/record/declared_components.ts`
  (`crossNestedSections`); `src/core/security/write_door.ts` (`isValidFrameMain`).
- **The law.** Outside a section — the node AND everything under it: a `box elements` container
  (stored `box elements`, or the legacy `dataframe` / `component_relation_struct`, which read as
  it), a `component_semantic_node`, an area (`area*`). A nested section is returned but not
  entered (the declared-components census crosses it, the law still applies on the far side).
  The structural walk (`crossSections`: the diffusion tree, the ontology update) is not a section
  walk and applies neither rule. Nor is the DEFINITIONS walk (`getSectionDefinitionTipos`: law-free,
  a nested section returned but not entered — every key a record of the section may store).
- **Shape before (PHP v6):** `section::get_ar_recursive_children` excluded `box elements`, `area`
  and `component_semantic_node` with their subtrees by default, so every section lookup built on
  it (children by model, search fields, `delete_data`'s component list, permissions) never saw a
  component parked under a box. The edit form never showed one (it collects components and
  groupers only).
- **Shape before (TS):** the walks pruned nested sections and areas only. A component parked
  under a `box elements` container was a search field ("any relation component" of a relation
  leaf with no `from_component_tipo`), a declared component (the record wipe EMPTIED it; the
  observer host predicate, the covered-slot restore and the media stem rules counted it), a
  record-birth default, "the first component of its model" (`findFirstDescendantTipoByModel`),
  an archive ontology row, an MCP / external-record field, an identify path step, and a valid
  fixed-dataframe-slot main — while the edit form did not show it.
- **Shape after (TS):** none of those. Every walker of a section's subtree reads the one walk;
  the write door's named fixed-slot main is valid iff the every-main walk lists it. Concretely:
  - `deleteSectionData` (`delete_data`) **leaves** the data of a box-parked component in the
    record, untouched, as v6 did. Nothing is migrated or swept: data already stored under such a
    key stays, and is reachable as before through the pair check below.
  - a search over "any relation component" of the section no longer matches a locator held only
    by a box-parked component;
  - the archive's `ontology.json` `subtree` is NOT a section walk: it reads the definitions walk,
    so it still carries the box-parked rows — their values stay stored (and archived raw), and an
    artifact must define every key it stores (`engineering/ARCHIVE_FORMAT.md` self-description;
    fixer 2026-11-22, review MEDIUM 2);
  - a SECURITY singleton the law hides is refused, never answered null: when the section walk
    finds no `component_filter` (null = no projects ACL) or `component_publication` (null = every
    record publishable) but the definitions walk finds one under an outside node,
    `findFirstDescendantTipoByModel` / `getComponentFilterTipo` throw `ontology.invalid_node`
    naming it (fail closed; v6 answered null — honouring the parked node instead is an open owner
    choice). No installation measured has that shape (app DB, suite DB: 0);
  - a fixed-dataframe-slot frame naming a box-parked main is refused (`request.invalid_source`)
    while the main itself stays readable/writable by the pair check below — the frame door follows
    the every-main walk, the main's door the pair;
  - a record birth seeds no default for a box-parked component.
- **NOT the law — the pair honesty check.** `tipoBelongsToSection` / `getAncestorSectionTipo`
  (read floor, area caller declaration, writer chain, host component read, TM subject, observer
  host-section step 3) still tie a box-parked component to its section: v6 let a root read and
  write it, and the pair IS honest — the ontology does tie it to the section. Which profiles may
  grant it is the security-access datalist's own walk (T2-SL-3b, separate).
- **Fixture interaction:** none — no frozen fixture records a box-parked component's walk; no
  re-harvest. TS-native gates only.
- **Gate reconciliation:** `section_containment_native` (new; every walker on the scratch TLD
  `zzsctn`, the upward form, the write door, and the pair check pinned as NOT the law; the
  archive extraction pinned to the definitions walk, the security-singleton refusal). Re-homed in the same change: `relation_search_coherence_native` (its holder was
  test3/`test205`, parked under the box `test115` — the wipe no longer empties it; now its own
  scratch section `zzrscoh1` with an autocomplete_hi carrying test205's definition) and
  `test3_canonical_fixture` (test3's components under `test115` leave the coverage census; they
  are listed apart, `OUTSIDE_SECTION_TIPOS` in `src/core/test_data/manifest.ts`, and the gate
  proves the list is exactly the box-parked data-bearing set; the stored `test97` is admitted
  there).
