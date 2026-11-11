# WC-2026-11-11-section-elements-target-groups — a multi-target relation's simple context carries `target_section_groups`; the fields picker drills into every target

- **Date:** 2026-11-11 (owner request: tool_export must reach every section a relation points to —
  tch199 → every toponymy + tchi1; owner chose the per-family grouping, "option B").
- **Decision:** none (additive key); DEC-12 (gates in the same change).

## Shape before (PHP)

`dd_core_api::get_section_elements_context` stamped `target_section_tipo` (the whole target
array, `get_ar_target_section_tipo`) on relation elements. The client picker
(`common/js/render_common.js render_components_list`) drilled into `target_section_tipo[0]`
("Select first only"), so a relation pointing to several sections exposed only the first one's
fields: tch199 opened España, and no tchi1 field (or any non-first target) could be picked for
export or search.

## Shape after (TS)

- **Server** (`src/core/resolve/section_elements_context.ts groupTargetSections`): a
  `component_portal` / `component_dataframe` element whose `target_section_tipo` has MORE than one
  entry also carries

      target_section_groups: [{ tipo: <real section>, label, members: [{ tipo, label }] }]

  Targets grouped by `getSectionRealTipo` (virtual siblings es1, fr1 … → hierarchy20 form ONE
  family; a real target such as tchi1 is its own family), first-seen order, duplicates once.
  A member the principal may not read (section grant < 1) is omitted; an empty family is omitted.
  Single-target elements are unchanged (no key). `target_section_tipo` is unchanged.
- **Client** (`render_common.js get_target_choices` / `render_section_chooser`): the drilled level
  shows a section chooser (`select.section_chooser` in the level's section bar) when there is more
  than one choice; the level reopens on the last choice for that field.
  - `caller.group_target_sections === true` (tool_export): one choice per FAMILY, drilled through
    its first member — label `<real section label> (<n>)`, members in the tooltip.
  - other callers (search): one choice per MEMBER, grouped under its family in an `<optgroup>`.
- **Export walk** (`src/diffusion/resolve/resolver.ts resolveRecordAtoms`, export-only): the walk
  follows every locator by component tipo whatever section the declared step names, and
  authorizes each crossing at runtime (`assertExportCrossing`), so a column picked through es1
  exports the same component from fr1 targets. NEW: a hop now SKIPS a locator whose target section
  does not hold the next step's component (`exportTargetHoldsComponent`: the component's owning
  section, via `getAncestorSectionTipo`, is neither the target nor the target's real section).
  Before, such a target was CROSSED: for a non-admin the frontier asked a `tchi1/hierarchy25` grant
  no profile can hold and refused the whole export (`perm.export_column_out_of_scope`) for a value
  that does not exist; for a global admin it emitted nothing. A component owned by no section
  (the section-info group, dd196's children) keeps crossing every target. A target that DOES hold
  the component is crossed and authorized as before — a missing grant on an in-family member
  (es1 granted, fr1 not) still refuses the export (fail closed; narrowing instead is an open owner
  decision). The declared step stays a plain `section_tipo` string — the SEC-01 multi-element
  refusal (`frontier_scope.ts resolveDeclaredTipo`) is untouched.

## Reason

The client is the consumer: without the family list it can only label targets by tipo, and it has
no other way to know which targets share components (es1/fr1) and which do not (tchi1).

## Gate reconciliation

No parity gate replays `get_section_elements_context` — no re-harvest, no fixture edit.
Gates: `test/unit/export_multi_target_family_native.test.ts` (grouping, read-grant omission,
single-target absence, the family-wide export column and the other family's column as admin AND as
a scoped non-admin, the in-family missing grant still refusing);
`test/unit/tool_export_job_native.test.ts` H (its runtime-only section moved from `test2`, which
holds no `test52`, to a scratch virtual of `test3` — the skip would otherwise void its read);
`client/dedalo/test/client/js/test_fields_target_chooser.js` (choices in both modes, the chooser
renders/switches/remembers, no chooser for a single target, drag paths name the chosen section).
