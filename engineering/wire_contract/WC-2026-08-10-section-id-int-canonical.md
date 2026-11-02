# WC-2026-08-10-section-id-int-canonical — a matrix record address is ALWAYS an int: stored locators, the app wire, and every internal writer flip from string-canonical to int-canonical

- **Date:** 2026-08-10.
- **Decision:** section_id unification (owner-approved plan, this date). DEC-12
  gates: `test/unit/section_id_concept.test.ts`,
  `test/unit/section_id_intify.test.ts`,
  `test/unit/section_id_intify_apply.test.ts`,
  `test/unit/search_containment_dual_probe.test.ts`,
  `test/unit/section_id_int_tripwire.test.ts` (registered in
  `engineering/TRIPWIRES.md` + `scripts/verify.ts` the same change); parity
  absorbed by the gate-side transform `normalizeSectionIdTypes`
  (`test/parity/normalize.ts`) — **fixtures NOT edited** (a re-harvest is
  impossible; the WC-001 pattern).

## The law

A **matrix record address is a safe integer** — negatives included (`-1` is
the root/superuser record, `-666` the activity sentinel; the invariant is
*integer*, never *positive integer*). Everything that is not an int is a
DIFFERENT CONCEPT that historically squatted on the same field name:

| concept | representation | fate |
|---|---|---|
| record address | branded int (`src/core/concepts/section_id.ts`) | THE canonical form, stored + emitted |
| external remote id | string, verbatim (`"001338683"` zenon zero-padded, `"Q42"` wikidata) | permanent — protected by the VALUE INVARIANT: true remote ids are never convertible (padded or opaque). (!) NOT by tipo: sections carrying legacy `api_config` residue (rsc205) hold thousands of real records — a tipo-keyed rule silently dropped their writes (S0, adversarial round, fixed same day). A convertible numeric string is a record address ON ANY TIPO; `external-ref` classification applies only to non-convertible strings on external tipos |
| synthetic wire token | string, verbatim (`search_1`, `tmp_export_2`) | permanent — addresses no record, echoes verbatim |
| absent | null / undefined / `''` | `''` now classifies ABSENT (divergence below) |

This REPEALS the string-canonical storage law (`concepts/locator.ts:15-17`
"NEVER change what we re-persist", `relations/save.ts` `String(section_id)`,
`subdatum.ts`, the emit-side stringifies of `section/read.ts` /
`resolve_echo.ts` / `relations/datalist.ts`, and the comment-stated laws
beside them — all rewritten in this change).

## Shape before (PHP-era, frozen fixtures)

Stored locators: `{"section_id":"7","section_tipo":"oh1",...}` — string
canonical (PHP `locator::set_section_id` cast `(string)`). Emitted data,
datalists and echoes: string. The wire accepted both (`z.union`), compared
loosely on `section_id` only. Reference-DB census (2026-08-10, deep JSONPath
walk in STRICT mode — lax `$.**` double-counts array-wrapped objects, a bug
caught by cross-checking the sweep's own count;
`scripts/census_section_id.ts`): **16 689 768 convertible string addresses**
(matrix.relation ~7.2M, matrix_activity_diffusion.relation ~5.4M,
matrix_hierarchy.relation ~2.2M, matrix.misc ~0.7M, …), 1 158 567 already
int, 12 560 leading-zero (ALL `zenon1` external), 3 `''`, 4 `"null"`, 2 610
tokens (`"self"`/`"current"` config markers, `"${section_id}"` v6-tool
literals in TM), ~2.3K JSON-null (the documented record-metadata shape).

## Shape after (TS)

- **Stored**: writers mint int via `canonicalizeStoredSectionId` (convertible
  string→int; ANYTHING else verbatim — external ids can never be corrupted by
  a writer). The data sweep converts the stock (below).
- **Emitted**: record addresses int on every app-API surface (reads, echoes,
  datalists, dd_info, tags info payloads, lock events, TM reader emissions);
  synthetic/external verbatim.
- **Accepted**: int primary. Numeric strings still coerce at the boundary
  (`coerceSectionId`) with per-door counters
  `section_id_string_coercions.<source>` + a sampled
  `[section_id-string-coercion]` WARN — **deprecable doors** (RQO JSON body)
  are removed at the contraction release on counter evidence; **URL-shaped
  doors** (`search_obj` from `location.search`, GET params — URLSearchParams
  yields strings forever) coerce PERMANENTLY under their own keys and are
  excluded from that gate. Counter payload (`/api/v1/counters`) carries
  `uptime_s`: counters are process-lifetime, a bare zero is not evidence.
- **Search**: jsonb `@>` containment is type-strict, so every locator probe is
  DUAL-FORM and polarity-aware (`src/core/search/containment.ts`): positive =
  per-element `(col @> strForm OR col @> intForm)` AND-composed; negated
  (`!=`/`!==`) = the De Morgan dual `(NOT str AND NOT int)` OR-composed.
  Per-element decomposition (not whole-array dual probes) because a
  half-migrated row can hold mixed-typed elements of one q. The string leg is
  removed at contraction.

## Deliberate behavior divergences (beyond the type flip)

1. **`''` → absent.** The NaN era ran `Number('') === 0` past `hasRecordId`
   and silently read record 0. `classifyWireSectionId('')` returns `absent`.
2. **Numeric-shaped non-addresses refuse loudly.** `'007'` on a non-external
   tipo used to silently read record 7 (`Number('007')`); now it throws
   (leading zeros are an external-ref shape or corruption, never an address).
   Same for digits beyond `Number.MAX_SAFE_INTEGER`.
3. **Branch parity everywhere else is LAW, unit-gated**: synthetic tokens and
   external refs land in exactly the branches the old
   `Number.isNaN`/`startsWith('search_')` sniffs selected (search-mode grant
   2, per-record scope-gate skip, verbatim echo).
4. **Digits-only external ids and the search-mode grant**: a NON-convertible
   string on an external tipo (`'001338683'`) now takes the synthetic/external
   grant-2 + scope-skip branches uniformly; the NaN era Number()'d it to
   `1338683` and fell through to the matrix permission walk. Uniformity wins
   — the value addresses no matrix record either way.
5. **Micro-divergences at the save door**: a non-`search_` synthetic token on
   a consultation-only section answers 400 "addresses no record" (was 403
   "Illegal save"); an external-ref on a consultation-only section enters
   resolve+echo (non-writing either way).
6. **D16 — token abuse of the locator shape**: `diffusion_delete.ts` stored an
   action token (`String(entry.action)`) in `section_id` position inside
   `matrix_activity_diffusion` payloads; restructured to a dedicated field,
   readers keep read tolerance for old-shape rows. A locator-shaped field may
   not carry a non-record token going forward.

## Pinned edges (string form is CONTRACT, not legacy — never "fixed")

- **Diffusion → MariaDB published shape** (`src/diffusion/` rewriters):
  published DBs are external consumers; publication v1 PHP LIKE-probes the
  quoted form (`class.free_node.php:108,451`, `class.web_data.php:2017+`) —
  audited, v1 is a frozen consumer of the string-form published DB.
- **Inline tag markers** (locator JSON serialized inside text STRING scalars):
  the sweep kernel never descends into string scalars; the marker byte-form is
  pinned (publication v1 consumes it).
- **`dedalo_ts_component_locks` / `dedalo_ts_error_reports`** text columns
  (named exemption — TABLES only; lock EVENTS to the client carry int).
- **TM readers** (previews/diffs) stay string-tolerant permanently.
- **Tipo-less `section_id` keys are USER DATA, not locators** (the
  locator_rewrite.ts law: a locator carries `section_tipo` + `section_id`).
  The sweep kernels, the post-verify census and the residue counts all require
  the paired tipo key — a `component_json` value whose user JSON happens to
  hold a `section_id` key survives byte-for-byte (refined 2026-08-10 while
  auditing the import doors; both kernels + both counters gated).

## The data update (two homes, one rule)

The conversion rule — strict numeric, no leading zero (`'0'` yes, `'-0'` no),
safe-int range — is pinned by the shared vector file
`test/unit/fixtures/section_id_conversion_vectors.json`, asserted on BOTH
runtimes (bun gate + the PHP step's run-start self-check; the v6 package
carries a byte-identical copy, drift-gated when both trees are present).

- **v6 widget step (primary)**: `close_v6_prepare_v7` bundled engine,
  `v6_to_v7::intify_section_id_locators` + its `run_scripts[]` descriptor
  entry — ordered AFTER the reformat/dataframe migrations and BEFORE the
  string-search/relation-index store builds (derived stores backfill from int
  form). Every future v6→v7 migration arrives int-clean.
- **v7 repair script** (installs already on v7 beta):
  `scripts/migrate_section_id_locators.ts` — dry-run default, `--user`
  mandatory, per-row `FOR UPDATE` re-read (TOCTOU closed), 0-affected =
  abort, no modified stamps, no per-row TM (D13 — recovery is the mandatory
  fresh backup), TM sweep mandatory on `--all` (`--skip-tm` only for partial
  reruns), `--purge-class=empty,null-literal` operator-adjudicated junk
  deletion, POST-VERIFY by an INDEPENDENT jsonb_path census (never the
  sweep's own prefilter) + relation-index re-backfill, exit 1 on red.
- **Marker**: both writers record a `section_id_int_normalize` row in
  `matrix_updates` on green — the machine-readable evidence the contraction
  release's boot floor checks. Both version readers
  (`backup.ts getCurrentDataVersion`, bundled `get_current_data_version`) are
  guarded `WHERE data ? 'dedalo_version'` so non-version rows can never
  shadow the version (a latent NULLS-FIRST-under-DESC fragility fixed here).
- **Restore convergence (D6.2)**: `tool_time_machine` restoreSection /
  component restore and `bulk_revert` route restored values through the same
  kernel (`normalizeRestoredSectionIds`) — an old backup or TM snapshot
  restored into a post-migration install converges on write instead of
  re-injecting strings.
- **Sweep scope**: 24 `MATRIX_TABLE_ALLOWLIST` tables × 11 jsonb columns +
  `matrix_time_machine.data` + `dd_ontology.relations` (writer minted strings
  until this change; census measured 0 stored). Named exemptions, each with
  its census line: `dd_ontology.properties` (config DSL; `self`/`current`
  markers are tokens by design), `matrix_structurations` (v6 archival
  payload, engine never parses it), `matrix_notifications` / `matrix_updates`
  (census: zero address values).

## Client half (shipped FIRST)

`same_section_id(a,b)` (`client/dedalo/core/common/js/utils/util.js`) —
String-compare, null/undefined never equal; safe on leading zeros precisely
because external ids echo verbatim on both sides. ~40 bare `===` sites
replaced (instances registry, ddinfo lookups, the whole select-family
selected-state, portal/dataframe/tags/state/ts_object/search sites); latent
truthiness bugs fixed (`section.js` dropped a legitimate id 0;
`render_list_section.js` string-literal `'0'`). Gate: `bun run test:client`
(117-green baseline preserved; the one red suite pre-dates this change).

## Gate reconciliation

- **Parity**: `normalizeSectionIdTypes` transform applied gate-side to the
  affected differentials — address-shaped keys (`section_id`,
  `parent_section_id`, `row_section_id`, `section_id_key`,
  `target_section_id`, `created_section_id`, `typology_section_id` — the
  tree-area boot payload's typology address, canonicalized by the engine in
  `src/core/area/tree.ts`) with strict-numeric string
  values map to int on both sides during the expand window. Fixtures are NOT
  edited. **At contraction the transform flips fixture-side-only**, so a
  server regression re-emitting `"7"` reddens parity again (recorded here so
  the flip is a scheduled part of the law, not an optimization someone
  removes).
- **Unit**: string-form assertions flipped to int with a WC-id comment
  (datalist/portal-writes/activity/alias/section-terms et al.);
  `locator_law.test.ts` re-scoped (loose compare retained — external ids,
  unmigrated installs, TM); `ws_a_tripwires` INLINE_SECTION_ID_MATCH_RATCHET
  drains as the burn-down proceeds.
- **New tripwire**: `section_id_int_tripwire.test.ts` — a shrink-only
  type-decl allowlist (starts at the census of `number | string` decls) and a
  writer-site allowlist that contains ONLY the named permanent exemptions
  above (no grandfathering: every in-repo string writer was fixed in this
  change).

## Order of deploy

1. Client hardening (type-tolerant against old AND new servers).
2. Server expand (this entry): int writers/emitters + dual probes +
   coercion counters — deployable against fully unmigrated data.
3. Per install: maintenance ON → fresh backup → dry-run → operator review
   (residue must be external + documented token classes only) → apply →
   post-verify green → marker row → maintenance OFF → dry-run rerun = 0.
   (New v6 migrations get step 3 inside `close_v6_prepare_v7`.)
4. Soak; deprecable counters trend to 0 (uptime-qualified + access-log
   cross-check of the WARN tag).
5. Contraction (LATER release, own WC addendum): deprecable string coercion
   removed, dual-probe string leg removed, boot refuses to serve without the
   `section_id_int_normalize` marker, parity transform flips
   fixture-side-only, locator parse schema narrows.

## Appendix — writer/emitter closure

The full grep-derived closure of flipped writer and emitter sites (and the
residual sites classified permanent-exemption) is frozen in this change's
review record; the mechanically-enforced form is the
`section_id_int_tripwire` writer allowlist — additions to it require editing
THIS entry with the justification.

## Addendum 2026-08-22 — pinned-edge census refresh (ceilings 2→4, 1→4)

The `section_id_int_tripwire` writer allowlist requires an edit here for any
ceiling raise. Commit `fa11f2e440` (2026-08-13) added string-minting legs to
two files ALREADY named as pinned edges above, all inside their existing law
class. No new class, no grandfathering:

- `src/diffusion/resolve/rewriters.ts` — 2 → 4. The two new legs (`:390`,
  `:410`) are the v6 `component_relation_index` INDEX-EDGE projection, whose
  key order and string scalars are the published byte shape ("Diffusion →
  MariaDB published shape").
- `src/diffusion/resolve/resolver.ts` — 1 → 4, law widened to
  "MariaDB published shape + dual-probe variant". Three of the four are the
  published shape (`:846` the pinned coercion this entry already names;
  `:1349` / `:1676` build the `StoredLocator`s that feed the same publish).
  The fourth, `:1280`, is the STRING leg of the `rootHierarchyParentId` dual
  probe — a READ tolerance pair (`probeInt` / `probeStr`), the same class as
  `src/core/search/containment.ts`.

Contraction note: the two classes end differently. The dual-probe string leg
at `resolver.ts:1280` is removed at contraction (step 5 above); the published
shape is not — it is external-consumer contract and stays.

Drained in the same pass (NOT an exemption, a fix):
`src/core/test_data/test_corpus/ensure.ts:385` minted `section_id: String(...)`
for the STORED hierarchy-registry relation locators it seeds — i.e. the suite
corpus carried the repealed shape. Flipped to int (`locatorItem`'s `sectionId`
param narrowed to `number`). Rows already seeded keep the string form until
`bun run test:db:setup` re-runs.

## Addendum 2026-09-24 — "external tipo" is the ONE externality predicate, never `api_config` alone

The law table's row "`external-ref` classification applies only to
non-convertible strings on external tipos", divergence 4, and the sweep's
`external-skip` class all leaned on "external tipo" without defining it. The
engine defined it as `isExternalSectionTipo` — `api_config` present — which is
the tipo-keyed rule this entry already refused for CONVERTIBLE values, left
standing for non-convertible ones. `rsc205` carries a stale `api_config` over
~21k real local records and owns no component_external.

### The definition (now)

An **external tipo** is one `isExternalReferenceSection` (src/external/
record_fields.ts) answers true for: the section BINDS a service (`api_config`)
AND owns a component_external (its own subtree or its real section's). It is
the ONE externality predicate; `isExternalSectionTipo` is DELETED from
`src/external/config.ts` and the facade, so no door can decide on the binding
alone. Doors moved: `classifyWireSectionId` (concepts/section_id.ts),
`listExternalSectionTipos` (update/transform/section_id_restore.ts — the TM
restore / bulk revert normalization and `scripts/migrate_section_id_locators.ts`),
the export prefetch (same answer there: its caller already proved ownership).
The frontier record key moved earlier the same day
(WC-2026-09-24-external-foreign-target-and-verbatim-id addendum (c)).

### Shape before → after, on an api_config RESIDUE section (rsc205-like)

| door / input | before | after |
|---|---|---|
| save (`dd_core_api`) `'abc'` | `external-ref`: resolve+echo, nothing written | `synthetic`: the same no-write branch |
| save `'007'` / beyond-safe digits | `external-ref`: echoed, nothing written | 400 `section_id.not_an_address` (the save door wraps every classifier refusal; the classifier's `section_id.numeric_shaped` rides as the log-only `cause`) |
| read (`section/read.ts`) `'007'` | `external-ref` no-record widget | refusal caught → `absent` (+ a `console.warn`); same no-record widget, the emitted `section_id` is the verbatim input either way |
| permissions (search mode) `'abc'` | grant 2 | grant 2 (synthetic) |
| permissions (search mode) `'007'` / `'001338683'` | grant 2 | refusal → `absent` → the matrix walk |
| import_conform locator `'abc'` / `'007'` | stored verbatim as the locator's section_id | cell fails `IGNORED: Trying to import invalid section_id in locator` |
| TM restore / bulk revert | — | bytes unchanged (convertible converts and non-convertible stays, on any tipo; restore passes no purge class) |
| sweep script findings | `external-skip` | `empty` / `null-literal` / `token` / `leading-zero` / `out-of-range` — so `--purge-class=empty,null-literal` now reaches residue junk |

A TRUE external section (zenon1, test3, a virtual of one) is unchanged.

### Reason

A non-address id on a section whose records are all local addresses nothing;
calling it a remote id echoed it, stored it and granted on it. The value
invariant protects real remote ids; the owned component_external is what makes
a section's non-address ids remote at all (the read path's law —
relations/relation_core.ts, record absence + a derived model).

### Gate reconciliation

No parity fixture classifies a residue tipo; no re-harvest. Behaviour:
`test/unit/external_reference_section_native.test.ts` (the `zzxr` situation:
residue / owner / virtual-of-owner), mutation-verified — the api_config-only
rule swapped back into the classifier, or into the restore set, reddens two
cases each. `section_id_concept` and `section_id_intify_apply` stay green
(`test3` owns `test215`).

## Addendum 2026-10-30 — component_inverse backlinks emit `from_section_id` as INT

- **Surface:** the component_inverse emit hook (`src/core/components/component_inverse/emit.ts`,
  added 2026-10-29 with the tool_cataloging "used" marker) stamps each backlink with its owner's
  `from_section_tipo` / `from_section_id`. It shipped minting `String(hit.section_id)`, copying the
  PHP row (`samples/api_data.json`) — a new string writer site (`section_id_int_tripwire` red).
- **Shape after:** `from_section_id` is the owner's record address as an INT, like every record
  address on the app API (§ Shape after). Divergence from PHP: `"1"` → `1`.
- **Consumers:** the component_inverse client views only render it (`render_value(…, 'text')`, a
  text node), and tool_cataloging's `is_used` reads `from_section_tipo` only — no consumer compares
  the id's type.
- **Gates:** `test/unit/component_inverse_emit_native.test.ts` asserts a safe integer (was:
  `typeof 'string'`). No parity fixture carries this emission; no re-harvest.
- **Scope (AUTHZ-05, same change):** the hook ran the UNSCOPED inverse scan and returned every
  owner to the requester — the list read named records the caller cannot open. It now passes the
  hits through `scopeInverseReferenceHits` (section read grant + projects boundary) for the
  request's principal; a global admin sees all, a principal without the grant sees none of those
  owners. Registered as a `door` in `security_audit_2026_07_23_tripwire`; behaviour leg in
  `component_inverse_emit_native` (mutation-verified).

## Addendum 2026-10-30 — external laws: the observer locator unions move, one read-side union added

- **Surface:** the external-value law registry (`src/core/section/record/external_laws/`,
  WC-2026-10-30-observer-external-value-laws) took over the mirror compute from
  `observers.ts`. Its two kept unions moved with it: `StoredLocator.section_id` (a stored bag as
  read — `types.ts`) and the equivalence `peerBag` (`inverse_search.ts`). `observers.ts` drains
  2 → 0 and leaves the ceiling list.
- **One new decl:** `DesiredLocator.section_id` (`types.ts`) — the item a law WANTS in the
  mirror. The copy laws read it straight out of a stored bag (source_overwrite: the pointed
  record's bag; observed_data: a tag payload), so the legacy string form can arrive; it is a
  READ-side union. The merge (`merge.ts` `mergeMirror`) canonicalizes every emitted
  `section_id` to an int, so no mirror WRITE carries a string — the wire law is unchanged.
- **Ceilings:** `external_laws/types.ts` 2, `external_laws/inverse_search.ts` 1 (net +1 across
  the move, the read-side decl above). Gate: `section_id_int_tripwire` DECL_CEILINGS.
