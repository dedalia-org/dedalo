# WC-2026-11-22-tool-availability-context — a tool's `isAvailable` hook receives the element's real section and mode

- **Date:** 2026-11-22 (T2 batch B5: O11-4).
- **Decision:** T2 triage row O11-4. Code: `src/core/tools/types.ts` (`ElementToolsTarget`
  `sectionTipo`/`mode` REQUIRED), `src/core/tools/registry.ts` (`toolIsAvailable`,
  `toolFitsElement`, `getSectionTools(tipo, mode, keys)`), call sites
  `src/core/resolve/structure_context.ts`, `src/core/section/context.ts`,
  `src/core/section/indexation_grid.ts` (mode `indexation_list`).
- **Shape before (PHP v6/v7, `common::get_tools`):** `is_available($context)` got
  `section_tipo = $this->get_section_tipo()` and `mode = $this->mode`; an element living in
  `dd15` offered `tool_export` only. TS before this entry FABRICATED the context:
  `sectionTipo` = the element's own tipo, `mode` = `''`, and had no dd15 rule — so a
  section-keyed hook (`sectionTipo === <section>`) answered false for every component of that
  section, and a mode-keyed hook could never fire.
- **Shape after (TS):** PHP's context and the dd15 rule. The two fields are REQUIRED on
  `ElementToolsTarget` (a caller cannot omit them — compile-time); a section's `sectionTipo`
  is its own tipo; the indexation grid's column components run in `indexation_list`.
  Consultation-only sections keep shipping NO section toolbar
  (WC-2026-10-06-consultation-only-no-section-tools); the dd15 rule governs the elements
  INSIDE dd15.
- **Reason:** a tool's availability is a statement about the element where it is offered;
  a fabricated context makes the hook answer about another element.
- **Gate reconciliation:** the section/component toolbar parity gates
  (`section_tools_differential`, `component_tools_differential`) are unchanged in outcome
  (no shipped tool's hook reads mode; section contexts already had sectionTipo = tipo); no
  re-harvest. Gates: `test/unit/component_tools_stamp.test.ts` (O11-4 legs: dd15, the hook
  context through the registry and the structure-context call site, `@ts-expect-error` on a
  target without the fields).
