# WC-2026-11-04-tree-picker-read-gate-retired — the tree picker follows the writer-chain scope; its save-door read gate and hierarchy prune are retired (owner decision (i))

- **Date:** 2026-11-04 (owner decision (i), round 4, 2026-11-03; landed W4b —
  `src/core/relations/save.ts` (`refuseUnreadableTreePickerTarget` removed),
  `src/core/area/read.ts`, `src/core/ts_object/ts_api.ts`, `src/core/ts_object/search.ts`).
- **Decision:** DEC-12. **Supersedes** gate 2 (READ GRANT on the linked section, tree-picker
  callers) of `WC-2026-08-14-relation-insert-target-validation` (its 2026-08-16 addendum) and
  the picker read's grant prune described in `WC-2026-08-14-thesaurus-picker-caller-declared`,
  and the `target_not_readable` refusal named among the length-1 door's constraint refusals in
  `WC-2026-08-14-relation-insert-accepts-batch` — all three carry a `## Addendum 2026-11-04`
  pointing here.

## Shape before (TS, 2026-08-14 / 2026-08-16)

- The picker READ pruned every hierarchy whose target section the principal holds no grant
  on, so a writer of a `view:'tree'` component without a thesaurus grant got `perm.denied`
  (or an empty tree).
- The SAVE door re-judged the linked section (`target_not_readable`, `perm.denied` 403) for a
  NET-NEW locator into a tree-picker caller — stricter than PHP, which authorizes the pick by
  the caller's grant alone.

## Shape after (TS)

- The tree picker of a `view:'tree'` component browses its target thesaurus READ-ONLY under
  the writer-chain scope of `WC-2026-11-04-writer-chain-scoped-search`: the picker caller
  names its chain (`callers`), the component holds write through it, the effective config
  targets the thesaurus exactly. Every node a tree door builds is gated by its own section
  (a client children list included), the area search's sections likewise
  (`confineTreeSearch`), and a NESTED picker's `view` is read from its verified chain line.
  Without the scope, the picker READ (hierarchy prune): `perm.denied` as before.
- **Every** tree-area search — picker or not, `area_thesaurus` and `area_ontology` alike — is
  now confined (`confineTreeSearch`): each section the client's `sqo.section_tipo` names
  must hold the principal's read grant (or, for a picker, be a target of its verified tree
  scope). A section that fails is DROPPED from the search (a mixed list answers 200 with the
  admitted sections' hits only); a search that keeps NONE of the sections it named answers
  `perm.denied` (403). Before, the scope-less search ran `searchThesaurus` over the client's
  sections with no section gate (only the projects filter) — 200 with hits from sections the
  principal could not read. A hardening, not a PHP shape: the frozen area parity fixtures
  are admin reads and cannot see it.
- The save door no longer re-judges the target section: a known term locator into the
  component is accepted on the component's own write grant (TARGET, selectability and CAP
  gates unchanged).

## Reason

Tree pickers and autocompletes are the same act — picking a value into a component the user
may write — and must follow one rule; the save-side twin of a retired read prune would only
refuse what the scoped read now legitimately offers.

## Gate reconciliation

`test/unit/subdatum_permission_native.test.ts` — *(i) DECIDED: the TREE-PICKER variant is
accepted at save*, *(i) DECIDED: the tree picker reads the ungranted thesaurus ONLY through
the writer chain*; `test/unit/area_picker_mode_native.test.ts` (*a plain (caller-less) area search of the
ungranted thesaurus → perm.denied*; *dropped beside the target, refused alone*),
`test/unit/relation_insert_target_native.test.ts` (updated to the retired gate). Parity: the
frozen area differentials are default-mode admin reads — byte-unchanged, no drift.
**Re-harvest: none.**
