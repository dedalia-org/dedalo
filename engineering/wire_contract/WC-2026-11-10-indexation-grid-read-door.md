# WC-2026-11-10-indexation-grid-read-door — get_indexation_grid gates every row's quote, and names what it withheld

- **Date:** 2026-11-10 (T0-3 S12 residue, owner decision of 2026-11-10: CLOSE). The gate site is
  `get_indexation_grid` (`src/core/api/handlers/dd_core_api.ts`) → `buildIndexationGrid` /
  `indexationRowsPast` (`src/core/section/indexation_grid.ts`: `indexationQuoteGate`,
  `withholdUnquotableRows`, `quotableTail`), and the handler's locator gate
  (`gateIndexationGridLocators`).
- **Decision:** DEC-12. Stricter than PHP, which asked the section grant on the TERM's section only.
  Builds on WC-2026-08-09-indexation-grid-read-grant-scope (the AUTHZ-05 group scope, kept).

## Shape before (PHP, and TS until this entry)

```
{action:'get_indexation_grid', dd_api:'dd_core_api', source:{section_tipo, section_id, tipo, value},
 sqo:{mode:'related', section_tipo, limit, offset, filter_by_locators}}
→ {ok:true, request_id, data:[…dd_grid cells…], notices?:[search.page_clamped]}
```

- **PHP**: section grant ≥ 1 on the term's section, then every indexing record's fragment quoted.
- **TS until this entry**: the same + the term record's scope + the AUTHZ-05 scope of each
  section_top GROUP (section grant + projects predicate). The INDEXING record's own section and the
  text_area the fragment is quoted from were never asked: a user with a grant on the term and on the
  group's section read fragments of transcriptions their profile denies.

## Shape after (TS)

**The hosts.** The grid is BUILT from `sqo.filter_by_locators` (the build and the past probe ask
who indexes THOSE records), not from `source` — so every entry is a host and passes the source's
own gate: the section read grant ≥ 1 on its section and its record inside the caller's scope
(`scopeInverseReferenceHits`, batched — the predicate `principalCanAccessRecord` asks per id). One
failing entry REFUSES the call with `perm.denied` (403; the same for a missing and an out-of-scope
record — no existence oracle): a client naming a host it may not read is refused, never narrowed.
The source term must be among the entries, else `search.invalid_sqo` (400) — a grid is about its
source. An entry that names no record (no `section_id` = a section-wide sweep, a non-address id, no
`section_tipo`) is malformed: `search.invalid_sqo`. An absent / empty list still answers the empty
grid. The build and the probe read exactly the gated, canonical list (int ids). Client evidence
(`render_ts_line.js` → `ts_object.js show_indexations`): the direct badge sends `[term]`; the
recursive badge sends `get_children_recursive(term)` — the read's `children_recursive` answer, i.e.
the term AND its descendants, already scoped by that read — so both satisfy "source among them,
every entry readable" and keep working.

Per ROW (one indexation locator), on the indexing record's OWN section (`locator.section_tipo`):

1. the section read grant ≥ 1, and
2. the grant on the text_area the fragment is quoted from — the locator's `tag_component_tipo`
   (the human read's pair, `doorComponentAllowed`); a locator naming no tag component needs the
   section grant here, and the text_area cell re-asks the component it ACTUALLY reads
   (`ctx.quoteGate` in `textAreaIndexationCell` — the backstop; a refused quote renders nothing and
   withholds its row), and
3. the indexing record's OWN record scope (`locator.section_tipo`/`section_id` — the record the
   fragment is quoted FROM; a group's AUTHZ-05 scope is its section_top's, never its rows'), one
   batched `scopeInverseReferenceHits` over the rows the quote key admitted; each section with an
   out-of-scope row records one `perm.out_of_scope` refusal.

A refused row is OMITTED; a group left with no row and a section left with no group leave no husk
(no head row, no caption). The number of rows withheld is NAMED in the owned top-level key
**`withheld_rows`** (always present; `0` = nothing withheld), and a withholding request carries ONE
`notices:[{code:'perm.out_of_scope'}]` entry beside any `search.page_clamped`. Rows of groups the
AUTHZ-05 scope already hides are NOT counted (that count would be an existence oracle over records
the caller cannot reach — `scopeInverseReferenceHits`); only rows of groups the caller may see are.

Paging: the past-the-page probe (`indexationRowsPast`, READ-4) applies the same quote key to the
tail in SQL (`quotableTail`: the DISTINCT (owner section, tag component) pairs, judged once each by a
SILENT gate, then the row filter rides the probe's one EXISTS) and the row record scope
(`scopedRows` over the quoted tail; the section_top leg then lists its sections from the UNNARROWED
tail — `scopedRows`' `sectionsFrom` — so what the probe reads does not depend on what the row leg
kept) — a defaulted page owes
`search.page_clamped` only when a row the caller would be SERVED lies past it.

Head cells and the other row columns (portal hops, atoms) are unchanged by this entry: the owner
decision gates the quoted fragment.

## Reason

A row quotes a fragment of a text_area of another section's record; a user the human read refuses
that text_area (or the whole section) must not read it through the thesaurus grid.

## Client

`ts_object.js show_indexations` → `dd_grid` view `indexation` renders `data` only and ignores
unknown top-level keys; fewer rows render as fewer rows. The paginator's `total` comes from the
caller's own count (`totals_group`), unchanged — as for the AUTHZ-05 scope already, a page may
render fewer rows than the total promises. No client change.

## Gate reconciliation

- `test/unit/indexation_grid_read_door_native.test.ts` — the paired gate: indexing section denied /
  text_area denied → no row, no husk, `withheld_rows: 2` + notice, control served with `0`; the past
  probe false for both readers / true for the control on a page of 1. RED before this entry for all
  three refusal cases. (d) LOCATOR SWAP: the source + a locator in an ungranted section, or naming an
  out-of-scope record → 403 `perm.denied` (superuser served); a filter without the source / a
  section-wide sweep → 400 `search.invalid_sqo`; control (source + granted in-scope locator) served.
  (e) ROW RECORD SCOPE: an indexing record only in a project the caller lacks (its group in scope) →
  withheld, `withheld_rows: 1` + notice; the WIDE persona (same profile, both projects) and the
  superuser served with `0`; the past probe false for the reader, true for WIDE. RED on the code
  before the addendum: (d) 3 cases, (e) 2 cases (1 with only the probe mirror reverted).
- `client_page_doors_native` — RE-PINNED: the section_top twin's HOST4 cell (row owner hidden by
  project, top visible) now owes NO notice (the page withholds that row) — was `true` under group
  scope only. The BOUNDED probe test keeps equal statements AND rows across hidden / visible tails.
- `indexation_grid_av_native`, `indexation_grid_tc_native`, `start_record_scope_native` —
  unchanged and green (superuser / data-only assertions).
- `test/parity/indexation_grid_differential.test.ts` — corpus-bound red set unchanged
  (`engineering/parity_baseline.json`); the capture compares `data` as the superuser. No fixture
  edit, no re-harvest.
