# WC-2026-11-04-writer-chain-scoped-search — an autocomplete WRITER may search an ungranted target, scoped to its verified chain and its config's columns (owner decision (h))

- **Date:** 2026-11-04 (owner decision (h), round 4, 2026-11-03; landed W4b —
  `src/core/security/writer_chain_scope.ts`, `security/read_floor.ts` `withScopedPairs`,
  the read and count doors).
- **Decision:** DEC-12. Diverges from PHP.

## Shape before (PHP)

`get_subdatum` raises every child of a component caller to read so the user can "search
with autocomplete, to assign data", yet the read door refuses any sqo section the user holds
< 1 on (`class.dd_core_api.php` :2131-2153, Gate B): a cataloguer who may WRITE a toponym
autocomplete reads the term it holds but cannot SEARCH the toponymy to pick one —
`perm.denied`.

## Shape after (TS)

A search (read and count) of a target section the user holds no grant on is admitted ONLY
when ALL hold:

1. the request names `source.callers` (`WC-2026-11-04-rqo-source-callers`) and the chain
   VERIFIES;
2. the component at its end holds WRITE (≥ 2) through that chain — computed like PHP stamps
   it (`inheritSubdatumPermission`: a raised component is read-only, a read-only caller caps);
   a RULE basis (dd655 / dd1324) is not a write grant; a consultation-only section (dd15 /
   dd542) caps at read;
3. its EFFECTIVE config targets every ungranted sqo section EXACTLY (never the virtual ↔ real
   equivalence) and shows at least one column pair there.

The rows carry only the config's show / search / choose columns (never hide), stamped read
(1); filter / order paths on the opened sections are limited to those pairs plus the
config's declared `fixed_filter` / `filter_by_list` paths. Every relation element of a
scoped read expands ONE level: its children come from the request's column map (the client
lines `scopedDeclaredSections` judged), never from its OWN config
(`EmissionContext.callerChildrenOnly`), and the subdatum raise reaches the config's column
pairs only (`NodeLevelPolicy.raises`) — so a scoped relation column whose own config shows a
third section the scope never opened serves none of that section's values on the scoped
rows (review 2026-11-04). The count door agrees with the
read door. No chain, a refused chain, a read-only caller, a config-less (v5) component
(decision (j)) or a non-target section beside the target → exactly the PHP answer,
`perm.denied`. A get_data (not a search) of the target stays refused.

## Reason

Picking a value into a component the user may write is the one use the PHP raise exists
for; scoping it to the verified writer chain and the config's own columns opens exactly that
and nothing else.

## Gate reconciliation

`test/unit/subdatum_permission_native.test.ts` — *(h) DECIDED*, *(h) the scope limits
COLUMNS and FILTER PATHS* (incl. *a scoped relation column OWN-config child on an ungranted
third section is NOT served*), *(h)/(i) the scope never widens*, *decision (j) and the
write-authority caps*. Parity: Gate B's refusal for a chain-less request is byte-unchanged;
no fixture carries `source.callers` — no drift. **Re-harvest: none.**
