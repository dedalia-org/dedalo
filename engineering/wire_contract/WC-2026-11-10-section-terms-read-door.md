# WC-2026-11-10-section-terms-read-door — get_section_terms asks the term component and the record scope per locator

- **Date:** 2026-11-10 (T0-3 S12 residue, plan finding F5, owner decision of 2026-11-10: CLOSE).
  The gate site is `get_section_terms` (`src/core/api/handlers/dd_core_api.ts`), through
  `admitTermLocators` (`src/core/api/handlers/section_terms_access.ts`).
- **Decision:** DEC-12. Stricter than PHP, which asked the section grant only.

## Shape before (PHP, and TS until this entry)

```
{action:'get_section_terms', dd_api:'dd_core_api', locators:[{section_tipo, section_id}…], lang?, scope?}
→ {ok:true, request_id, data:{"<tipo>_<id>": "<term>", …}}
```

- **PHP** (`dd_core_api::get_section_terms`) and **TS**: per locator the SECTION grant ≥ 1, a
  refused locator silently omitted. Neither the record scope nor the grant on the term component was
  asked: any user with a section grant read the display term of every record they could name,
  inside their projects or not, and of a term component their profile denies.

## Shape after (TS)

Per locator, all three required (else the locator is OMITTED — batch semantics, the map is keyed by
the caller's own locators, so an absent key is the answer and the client keeps its provisional
label):

1. the section read grant ≥ 1;
2. the grant on EVERY term component the section_map draws the term from (`getTermTipos` — the
   human read's pair, `doorComponentAllowed`). ALL, not any: the term is the join of every fragment,
   and "as displayed" means each fragment must be readable through the component it is drawn from.
   A term partly drawn from a refused component is omitted whole — never re-joined from the granted
   fragments (a label the record never displays);
3. the record scope of the address the term read HITS — `Number(section_id)`, the resolver's own
   coercion (`term_resolver.ts readComponentItems`), so `'001338683'` is scoped as record 1338683.
   One scope statement per (section, 200-id chunk) — `scopeInverseReferenceHits`, global admins
   unscoped. An id whose `Number()` is not an integer (`'abc'`, a graph token, `'1.5'`) addresses no
   row and passes unchanged (`''`, as before); a non-positive integer is never a reachable record
   and is omitted for EVERY caller, the superuser included (`principalCanAccessRecord` law — was
   served for any section-granted caller).

A response that omitted anything for steps 1-3 carries ONE `notices:[{code:'perm.out_of_scope'}]`
entry (`readDoorNotices`, the read-door MANY-keys law; one per request, never a count) — new on this
door: the section-grant omission was silent before. Untermed sections are still skipped without a
notice (nothing to quote). The `data` map's shape and key order are unchanged.

## Reason

The term IS the value of the term component of a record. A user the human read refuses (record
outside their projects, or the term component denied) must not read the same value through the graph
view's batch label channel.

## Client

`build_graph_data.js fetch_section_terms` already reads only the keys it finds
(`apply_section_terms` keeps a node's own label for a missing key); the notice is toasted by the
page's default `api_notices` subscriber like any narrowed read. No client change.

## Gate reconciliation

- `test/unit/section_terms_read_door_native.test.ts` — the paired gate: out-of-scope record (reader
  absent + in-scope neighbour present / superuser present), leading-zero id scoped as its
  `Number()`, term component denied, section denied (+ the new notice), non-address id flowing,
  non-positive id refused, two 1000-locator timing runs. RED on the section-only gate for 7 of 9.
- `test/unit/section_terms_native.test.ts` — unchanged and green (its denied case asserts `data`
  only).
- `test/parity/section_terms_differential.test.ts` — corpus-bound red set unchanged
  (`engineering/parity_baseline.json`); the frozen capture runs as the superuser. No fixture edit,
  no re-harvest.
