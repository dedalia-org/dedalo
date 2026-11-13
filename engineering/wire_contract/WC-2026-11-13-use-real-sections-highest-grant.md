# WC-2026-11-13-use-real-sections-highest-grant — `get_section_elements_context` honours `use_real_sections`: one block per REAL section, element grants = the HIGHEST any readable member holds (PHP: the first readable member's)

- **Date:** 2026-11-13.
- **Decision:** owner ruling C34 (`T1_owner_decisions.md`, 2026-11-13; item
  T1-27 D1): "highest (order-independent)". DEC-12 gate:
  `test/unit/section_elements_context_native.test.ts` (`use_real_sections`
  block: cases 1-4, the flag-absent / false controls, case 10 both orders, the
  unreadable member).
- Code: `src/core/resolve/section_elements_context.ts` (`elementFamilies`,
  `familyElementGrant`, `sectionBlock`).

## Shape before (PHP)

`class.common.php:3789-3808` (frozen v7): per requested section, AFTER the
section read gate, `use_real_sections === true` replaced the section by its
REAL tipo (`section_real_tipo`) and skipped a real already built — one block
per real section, its instance, children walk and element instances on the
real tipo (so a virtual section's `exclude_elements` are NOT applied). Element
permission was read on `$base_section_tipo` — the FIRST readable requested
member of the family (`:3863-3865`): a field granted only in the second
hierarchy (es1 first, fr1 second) was hidden; the list depended on the order
the client sent.

## Shape before (TS, the defect)

The option was declared and never read: every requested section produced its
own full block. The thesaurus / ontology search panels (every active hierarchy
is a virtual section over `hierarchy20`) listed each field once PER HIERARCHY
(measured: 174 entries for 3 hierarchies, 58 = one block), the client drew N
duplicate section bars, and the server built N× the contexts.

## Shape after (TS)

1. `use_real_sections: true` (exact) → the readable requested sections are
   grouped by `getSectionRealTipo` in first-seen order; ONE block per family,
   built on the REAL tipo: the section entry, its own elements (DFS order, no
   virtual exclusion — PHP), every entry's `section_tipo` / `parent` = the real
   tipo, then the section-info tail. A real section requested beside its
   virtuals is the same family. Flag absent or `false`: unchanged (one block
   per requested section, repeats included).
2. **Element grant = the HIGHEST level any readable member of the family holds
   on the element** (DIVERGENCE from PHP's first-member read). The offered list
   is the UNION of what the members may read, at the maximum level, whatever
   order the client sent. The section entry's `permissions` is the highest
   section grant among the members. A member the principal may not read
   (section grant < 1) is skipped before grouping and never claims its family
   (PHP order).
3. PHP's `component_relation_model` `ar_target_section_tipo` union (:3963-3988)
   is deliberately NOT emitted: its only consumer, `search.js:1084-1088`
   `source_add`, is commented out in the client.

## Reason

The list is a picker hint, not a grant: the search engine authorizes per ROW
with a `some` verdict over the mains (`conform.ts rootVerdict`), so a field any
readable member grants IS filterable — offering it at the highest level matches
what the engine will do, and makes the panel independent of the order the
client happens to send. Every read re-keys per record; nothing here widens
what a user can read.

## Gate reconciliation

No parity gate replays `get_section_elements_context` with `use_real_sections`
— no re-harvest, no fixture edit. The client caches the answer per user under
the `…_real` key (`common.js`), purged at logout.
