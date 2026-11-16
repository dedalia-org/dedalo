# WC-2026-10-01-search-hop-configured-targets — a search hop reaches only its component's configured targets the caller may read

- **Date:** 2026-10-01.
- **Decision:** owner, 2026-10-01 ("option A": admins included; links outside a
  field's configured targets stop matching, as they already render nothing).
  Gates: `test/unit/search_hop_targets_native.test.ts` (the leak, reproduced and
  closed), `test/unit/search_path_acl_native.test.ts` (census: the users-rule
  hop now rides `dd200`, whose configured target is dd128; the audit's literal
  `test54 → dd128` shape answers FALSE). Code: `src/core/search/hop_scope.ts`,
  called from `search/conform.ts` `buildJoinChain` (filter AND order chains).

## Shape before

A multi-hop path's hop joined the record each stored locator names
(`<alias>.section_tipo = locator->>'section_tipo'`) in the DECLARED step's table.
SEC-02's two frontier keys — the component grant and the record predicate —
were evaluated for the DECLARED step section only (the client writes
`section_tipo[0]` of the ddo). Sections sharing a table and a component (a real
section and its virtual twin) were readable through each other: granted the
component on A, not on B, a caller declared A and matched B's values — the
prefix oracle SEC-02 closed, re-opened sideways. Locators naming a section
outside the hop component's configured targets were followed too, although the
cell renders nothing for them.

## Shape after

For a search WITH a principal (admins included), each hop's ON clause carries
`(<alias>.section_tipo IN (…) [AND (<record predicate>)]) OR …` over the hop
component's CONFIGURED target sections in the step's table — the UNION of its
targets resolved from EVERY section the previous step can hold (the search's
own `sqo.section_tipo` for the first hop, the previous hop's admitted sections
after that; a `self`-relative config targets a different set per source, so
resolving from the one section a client step declares dropped every other
section of a multi-section search — caught in review: material1/tchi1/dc1
through hierarchy36 lost dc1's 185 rows for admins) — keeping only those where
the principal holds the read grant on the step's component, each under its own
record predicate (sections sharing a predicate grouped into one IN list). The
same clause is the hop's `acl`, so the reversed relation-index shape
(`deep_path.ts`) applies it too. Every denied target is noted
(`[frontier] REFUSED …` + the request's `perm.out_of_scope` notice). No
admissible section → `FALSE`. Unresolvable targets (no previous-step section,
a config naming none) fall back to the declared section — never wider than the
grant check that guards it.

An INTERNAL search (no principal) is unchanged.

Measured on a real install (9.94M locators, read-only): 64,219 locators fall
outside their component's configured targets, most in another table (never
joined before either). Same-table cases that stop matching, admins included:
tch300's tch198/tch260 → dd501 (7,050 each, from an ontology `dato_default`
naming dd501, a virtual sibling of dd938/dd1178), plus tens of thesaurus
cross-links (hierarchy36 parents across scxibo1/scell1, hierarchy45/59 into
inactive toponymies, ontology6/ontology10 cross-TLD). They already render
nothing; the data is untouched and returns once the field's config targets the
section. Unresolvable targets fall back to the declared section for admins too
(4 component/section pairs on that install).

## Reason

A hop is a read of another section's records; the read must be governed by
the section actually read, not the one the caller declared. And search must
not match what the display does not show.

## Gate reconciliation

No parity fixture carries a principal-scoped multi-hop search; the per-name
unit sweep (search / principal / order / deep / frontier / export / diffusion
files) shows no new failure beyond the reconciled census case.

## Addendum 2026-11-12 — the admitted sections also key a relation leaf's from_component_tipo

`buildJoinChain` now hands the LAST hop's admitted sections back to the leaf, and a multi-hop
relation leaf asks its `from_component_tipo` key of each of them (bound on `r.section_tipo` when
they disagree), never of the declared step section (T1-16 / S04). The rule of this entry — the
read is governed by the section actually read, not the one declared — thus reaches the one key it
did not. See the 2026-11-12 addendum of `WC-2026-09-30-search-root-step-acl`; gates there.
