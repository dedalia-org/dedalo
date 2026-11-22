# WC-2026-11-22-hierarchy-root-link-rule — a hierarchy's root is linked only when it is unambiguous; every valid root locator survives

- **Date:** 2026-11-22 (T2-OX4-01, OX4-02, OX4-03).
- **Decision:** T2 triage rows OX4-01/02/03; owner ruling 2026-11-19 **Q7 (b)**: link the ONLY
  record without a parent; several or none → change nothing, report it for the operator to
  choose. DEC-12 (gated: `test/unit/hierarchy_state_native.test.ts` §6–8).
- Code: `src/core/ontology/hierarchy_state.ts` — `pickRootRecord` (the rule),
  `parentlessRecordIds`, `splitRootLocators`, `canonicalRootItems`, `ensureRootTerm`,
  `rootTermCheck`, `nameRootTerm`.
- Wire: `tool_hierarchy.inspect_hierarchy` / `generate_virtual_section` and the installer's
  activation report — the `root_term` / `root_model` check `detail`, the `applied` lines and
  the `errors` of `ensureHierarchy`. No envelope shape changes.

## Shape before (PHP v6 / frozen v7)

The general term (`hierarchy45`, `hierarchy59` for models) was minted when the target section
was empty and never linked to an existing record (an imported thesaurus came with its link).

## Shape before (TS)

- A missing or DANGLING general-term link over a section that held records linked the record
  with the LOWEST `section_id` — an imported child as easily as the root (a Dédalo id carries
  no tree meaning).
- Only the FIRST stored locator was read: a valid first locator was re-stamped and the key
  rewritten with that one alone (every other root lost its link); a dangling first locator made
  ensure link the lowest record over a valid second locator.
- The root was named through `section_map.thesaurus.term` read as ONE string: a list
  (`["hierarchy25","hierarchy90"]`) named nothing; a term naming a non-string model (a number,
  a relation) received the `hierarchy5` string items in its own column.

## Shape after (TS)

- **Every valid locator is kept** (an existing record of the declared section, first
  occurrence of a record), re-stamped to the canonical item (`type` dd48, int `section_id`,
  `from_component_tipo`; a stored positive item id kept, a missing one given the next free).
  Dangling / foreign / duplicate locators are dropped, each named in `applied`
  (`hierarchy45: dropped DANGLING → zz1/999 does not exist`). The check is OK only when every
  locator is valid and there is at least one.
- **No valid locator → the root link rule:** empty section → the root is created (as before);
  exactly one record without a parent (no locator in the section's
  `component_relation_parent`, `hierarchy36` on hierarchy20-based sections; a section without
  a parent component counts every record) → that record is linked
  (`linked the existing root es1/1 (its only record without a parent)`); several, or none →
  NOTHING is written (a stored dangling locator stays as it is) and ensure returns
  `hierarchy45: root ambiguous — <section> holds several records without a parent; choose the
  root and link it in hierarchy45 (nothing was changed)` (`… holds records but none without a
  parent …`). The `root_term` check detail says the same, and on the broken branches what
  ensure will do (`ensure creates the root` / `ensure links <section>/<id>, its only record
  without a parent`).
- **Naming** goes through the FIRST tipo of the term role (`getSectionMapFirstTipo`), and only
  into a component stored in the `string` column; any other model leaves the root unnamed with
  `root left unnamed (the term component '<tipo>' (<model>) is not a literal string component
  — …)`.

## Known consequence (vendored data)

Three vendored thesaurus dumps (`install/import/hierarchy/`) hold more than one record without a
parent: `es1` (3), `cu1` (2), `fr1` (4037 — its municipalities carry no `hierarchy36`). The
installer creates their registry row with no general-term link, so their activation now
reports `root ambiguous` and leaves the link for the operator, instead of linking id 1. The 146
other vendored thesauri hold exactly one and link it.

## Reason

A guessed root is wrong silently and forever: the thesaurus tree hangs from it. The operator is
the only one who can tell a root from an orphaned import row.

## Gate reconciliation

No parity gate covers ensure/inspect (tool_hierarchy's differentials retired into
`hierarchy_provision_native` / `hierarchy_state_native`). No fixture change, no re-harvest.
