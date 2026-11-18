# WC-2026-11-12-search-hop-join-record-address — a search hop joins a locator only through the record-address law

- **Date:** 2026-11-12.
- **Decision:** RC-closure T1-36 (audit P09; Tier 1 authorised by the owner
  2026-11-12). The address law itself is ruled by
  `WC-2026-08-10-section-id-int-canonical` (external ids stay verbatim) and its
  SQL form by DATA-26 (`WC-2026-09-03-monovalue-insert-replaces`).
  Code: `src/core/concepts/section_id.ts` `sectionIdAddressSqlValue`, called from
  `src/core/search/conform.ts` `buildJoinChain` (filter joins, the deep FORWARD
  shape of `deep_path.ts`, the ORDER chain). Same helper, same law:
  `src/core/tools/registry.ts` `getProfileGrantedToolIds` (a user's dd1725
  profile locator), `src/core/test_data/run_created_records.ts`.
  Gates: `test/unit/search_deep_semantics_native.test.ts` (describe "non-address
  locator ids reach no record"), `test/unit/search_multisection_deep_path_dedup_native.test.ts`
  (UNION negations, TODO-011), `test/unit/value_law_agreement_native.test.ts`
  (value form over the 25-value corpus), `test/unit/value_law_agreement_tripwire.test.ts`
  (per-occurrence census of every locator-id cast).

## Shape before

Every hop join read the stored locator id as
`<alias>.section_id = NULLIF((<locator>->>'section_id'), '')::bigint` — a
verbatim port of PHP `trait.where.php`. Over a relation holding a locator id
that is not a record address (an external record's id kept verbatim, e.g. a
zero-padded `'001338683'` or an opaque `'Q42'`):

- opaque id → the WHOLE statement failed (`22P02`): list, count and export of
  the section errored for any deep negation / empty filter, any deep positive on
  a table the relation index does not cover, and any order by a linked field;
- zero-padded id → joined matrix record `1338683` of the step section, an
  unrelated record: a deep `-x` / `!*` / `$not` excluded or included the record
  on another record's values, and order sorted it by them.

The reverse (relation-index) shape and identify's JS twin already skipped such
ids, so `positive ∪ negation` did not cover the section.

## Shape after

In every hop join the locator id goes through
`sectionIdAddressSqlValue(text)` = `(CASE WHEN <sectionIdAddressSqlPredicate> THEN (text)::int END)`:
a non-address id (zero-padded, opaque, `''`, past int4) reaches NO record. A
deep negation / empty leaf counts the record as having no related record there,
a positive never matches through it, an order by a linked field sorts it in the
NULL group (NULLS LAST). Same answer as the relation index and identify. No
error for legitimate external data.

`getProfileGrantedToolIds`: a non-address dd1725 locator id reaches no profile
→ the existing fail-closed branch (only always-active tools), where it used to
fail (opaque) or read another profile's grants (zero-padded).

## Reason

One record-address law across the three resolvers (forward join, relation
index, identify); the cast is total only inside the CASE (SQL `AND` has no
evaluation order).

## Gate reconciliation

No parity fixture edited, no re-harvest: no fixture holds a hop over a
non-address locator id. Measured on the suite DB (`EXPLAIN (ANALYZE, BUFFERS)`,
best of 5): the deep `-x` on test3 and the order chain keep the same plans (the
order's index condition carries the CASE as its RHS); 0.80 → 0.85 ms and
0.041 → 0.049 ms.

Boundary: TODO-012's id half (the reversed shape skips non-int4 ids the
correlated form still cast) is now aligned — both skip. TODO-012's other half
(intermediate hop source unconstrained) and its closure are open owner decision
20 (P09); not decided here.

Cross-refs: `WC-2026-08-10-section-id-int-canonical`,
`WC-2026-09-03-monovalue-insert-replaces`, `WC-2026-09-29-search-deep-leaf-mixed-rule`.

## Addendum 2026-11-17 — TODO-012 closed: the reversed shape reads the intermediate record in its step table (owner decision 20)

Ruled by the owner 2026-11-17 (C57, P09): the reversed deep shape matches the
correlated one exactly. Code: `src/core/search/deep_path.ts` `hopSourceJoin`
(called by `reverseShell`). Gate: `test/unit/search_deep_path_reverse_native.test.ts`
(describe "two hops: both shapes read the middle record in the step table").

**Before.** Walking a chain back through `matrix_relation_index`, an
INTERMEDIATE hop's source record was joined to its step table only when the hop
carried an ACL (`JOIN <step table> … AND (<acl>)`). The index holds
`(section_tipo, section_id)` and no table, so with no ACL — an INTERNAL search,
no principal; a search with a principal always carries a hop clause, the
admitted sections or `FALSE` (`WC-2026-10-01-search-hop-configured-targets`) — the
intermediate record was whatever record held the hop component's locator. A
main record whose locator named a record of a section stored in ANOTHER table
matched through that record's own index rows. The correlated form never did:
its join reads the step table's row at the locator's address.

**After.** Every intermediate hop emits
`JOIN <step table> AS <alias> ON <alias>.section_tipo = ri.section_tipo AND <alias>.section_id = ri.section_id [AND (<acl>)]`
— the forward join's own ON conjuncts, ACL or not. Same ids from both shapes.

Not narrowed further: without an ACL the correlated form admits any section of
the step table a locator names (hop_scope.ts: an internal search follows every
locator), so the reversed one does too — pinned by the same gate (a virtual
sibling stored in the step table still matches in both shapes).

Boundary: the index carries no table, so two rows at one
`(section_tipo, section_id)` in two tables — not a legitimate state: a section
has one table — would still be read as one record by the reversed shape.

Measured on the suite DB (`EXPLAIN (ANALYZE, BUFFERS)`, best of 5, two-hop
positive on test3): 0.19 → 0.15 ms, i.e. within noise — the join is the one
every search with a principal already ran.

No parity fixture edited: no fixture holds an internal multi-hop search over a
cross-table locator.

TODO-013 ("verify multiple left join issues (MDCAT case)") is closed as
SUPERSEDED by the same ruling: a deep leaf adds no join to the main FROM since
`WC-2026-09-29-search-deep-leaf-mixed-rule` (semi-joins; the count is
`count(*)`), and the hop join itself is this entry.

