# WC-2026-11-22-state-of-component-msg-refused — `state_of_component.msg` ships resolved text or not at all

- **Date:** 2026-11-22 (T2 batch B5: SC-1).
- **Decision:** T2 triage row SC-1 (O04/O05). Code: `src/core/resolve/structure_context.ts`
  (`stampPostEmission` → `resolveStateOfComponent`).
- **Shape before (PHP v6/v7, frozen :1994-2005):** for each `state_of_component` entry
  declaring BOTH `msg` and `target_component`, `msg` became
  `sprintf(label::get_label(msg), term(target_component))` in the application lang; an
  unknown key became the decorated key (`<i>key</i>`); an entry without `target_component`
  shipped its raw `msg` key. TS before this entry shipped every `msg` raw (the client's
  tooltip read `component_alternative`).
- **Shape after (TS):** `msg` is the UI-label text in the request's application lang, `%s`
  filled with the target's term (`termByTipo`, the target tipo itself when no node). Applied to
  the EMITTED properties, so an RQO override or a governing ddo cannot ship a raw key. A `msg`
  that is not a label key, or whose text keeps an unfilled `%s` (no target to name), is
  REFUSED: the `msg` key is dropped from that entry (siblings kept) and the defect is logged.
- **Reason:** a label key or a dangling `%s` is not text a user can read; the client shows
  `msg` verbatim as a tooltip. The defect is the ontology's, so it is logged for its author.
- **Gate reconciliation:** no frozen fixture carries a `state_of_component` carrier (the
  harvested corpus has none in its requested contexts); no re-harvest. Gate:
  `test/unit/structure_context_state_of_component_native.test.ts`.
