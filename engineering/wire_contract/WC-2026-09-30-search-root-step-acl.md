# WC-2026-09-30-search-root-step-acl — the ROOT step of a search path is keyed like every hop

- **Date:** 2026-09-30 (closure Step 3, SEC-1 conform half; also closes ONT-2 for filters).
- **Decision:** owner decisions 2026-09-30. Code: `src/core/search/conform.ts`
  (`rootStepKey`, `rootOrderStepAllowed`, `relationLeafComponentKey`),
  `src/core/security/frontier_scope.ts` (`SqlFrontierScope.mainSectionTipos` — REQUIRED —
  and `readFloor`), `src/core/security/permissions.ts` (`searchSurfaceGrants`),
  `src/core/security/read_floor.ts` (`subdatumReadFloor`). LANDS WITH the assembler hunk
  (`src/core/search/sql_assembler.ts` `buildPathScope` passing the SQO's sections and the
  floor, `buildOrderClauses` applying `rootOrderStepAllowed`, `SearchOptions.readFloor`) and
  the read path's floor wiring (`section/read.ts` `readSectionRows`, `section/read_source.ts`
  `getRows` / `count`, `dd_core_api.count`) — ONE commit.
- **Shape before:** `buildJoinChain` keyed every HOP (index >= 1), never `path[0]`. A
  non-admin holding 0 on a component of her OWN section still filtered and sorted her
  records by its hidden values: contains, `==`, begins-with and `$not` answered
  differently for a hit and a miss (the SEC-02 prefix oracle, one hop shorter). A relation
  leaf read `matrix_relation_index` with any `from_component_tipo`, hidden or absent.
- **Shape after:** for a principal, the root component is judged per MAIN section — the
  SQO's own `section_tipo` list, the sections the main WHERE binds every row to. The
  client-declared `path[0].section_tipo` is NEVER an authorization input (declaring the
  globally visible projects section, or a sibling the profile grants, over another
  section's rows used to hand the hidden predicate back). A component is readable when the
  subdatum read floor covers it, OR it is a search-surface standing grant (below), OR the
  frontier component key allows it (identity path tipos and globally visible tables
  exempt). All mains granted → the predicate is unchanged; none → the leaf is `1=0` (hit
  and miss identical, constant under AND / OR / NOT) and the request carries the one
  `perm.out_of_scope` notice; some → the predicate holds only on rows of a granted
  section (`alias.section_tipo IN (…)`). An ORDER entry is applied only when every main
  grants its root component; otherwise it is dropped (the ORDER BY falls back to the
  `section_id` default).
- **The mains are REQUIRED, and refused loudly when absent (review r7):** a
  principal-bearing scope that does not carry `mainSectionTipos` (a second scope builder
  that forgets it, a cast, a JS caller) is `internal.invariant` from `conform.ts
  keyedMains` — never conformed UNKEYED, which would silently re-open the root-step
  oracle. Only a scope with NO principal (an internal search) is unkeyed.
- **The relation leaf:** its `from_component_tipo` is a component of the OWNING row. On a
  single-step path the key is asked of the mains (several that disagree are told apart ON
  THE ROW: `(r.section_tipo = <S> AND <S's condition>)`, OR-ed); on a multi-hop path of
  the last step's section — the same declaration the hop's own component key and record
  predicate read. An EXPLICIT hidden `from_component_tipo` answers `1=0` for that locator;
  an ABSENT one gains `r.from_component_tipo IN (granted relation components)` when, and
  only when, some relation component (the section's own, plus the metadata relations
  created/modified by) is hidden.
- **The search surface's standing grants (`searchSurfaceGrants`):** the section-info
  metadata components (dd199 created date, dd200 created by, dd197 modified by, dd201
  modified date) and every component of the thesaurus template (hierarchy20). No profile
  grants them per section and the search panel offers them to everyone — the SAME rule the
  search-mode context stamp (`resolveComponentContextPermission`) reads, so the panel can
  never offer a field the filter then refuses.
- **The read floor (`subdatumReadFloor`):** the `${section}_${component}` pairs a
  component source's request_config names — every show / search / choose / hide ddo at
  every section it resolves to, every `fixed_filter` path step, every `filter_by_list`
  field — for a source the server VERIFIES, never one the client merely names (amended
  2026-10-01, refuter-surviving S1): `source.tipo` must be a component OF
  `source.section_tipo` in the ontology (`tipoBelongsToSection`, virtual-aware), and the
  principal must hold the read door's PAIR on it (the section read grant AND the
  component's) with a PROFILE basis on both halves (`getPermissionGrant`): a RULE grant
  — dd655 = 2 and dd1324 = 1 for any tipo, the dd15 TM floor, the inverse-relations
  wildcard, the public list-value fallback — mints nothing, because the rule's own bound
  (dd655's owner predicate, …) does not travel into an unbounded search of the target
  section. A refused source is the ordinary KEYED search, not an error. Read off the
  source's own request_config, never off the client payload. PHP get_subdatum's floor: an
  autocomplete on a target component the profile holds 0 on is served.
- **The floor is the CALLER'S OWN subdatum map (amended 2026-10-01, refuter-surviving
  S1):** it is built per call for the VERIFIED principal (the request context's principal
  set to it for the build) and NEVER cached across principals. An IMPLICIT request_config
  (no `source.request_config`) keeps only the ddos the principal holds >= 1 on
  (`filterAuthorizedRelated`, PHP STEP 5), so a principal-free cache served whoever
  populated it first: the superuser first handed a 0-grant user the search of a component
  her own portal does not show her; she first narrowed every later caller's floor. A
  principal-free BUILD would floor permanently what the implicit builder authorizes away.
  Through a config-less portal, a component the caller holds 0 on therefore stays KEYED
  (as PHP: it is not in her subdatum).
- **Open, ledgered:** the multi-hop JOIN binds the step's TABLE, not its section (PHP
  `build_sql_join` parity — the `target_section_tipo` binding is commented out there), so
  a hop's component key and record predicate are asked of the DECLARED step section. That
  is the hop class's property, shared by string and relation leaves alike; binding it is a
  separate item (it would narrow honest multi-target portal searches), not closed here.
- **Reason:** the value of a component the profile hides must not be recoverable by
  asking the search engine questions about it.
- **Gate reconciliation:** the frozen parity store runs as the superuser (every grant);
  no fixture changes, no re-harvest. Gate: `test/unit/search_path_acl_native.test.ts`
  (the ROOT-step block: hit = miss for begins-with / equality / contains under `$and` and
  `$not`; both relation-leaf legs with the control's hit AND miss; the SPOOFED-root and
  SPOOFED-relation legs declaring dd153 and a granted sibling; the metadata legs dd199 /
  dd200 for a non-admin and a global admin; the ORDER leg; the loud notice; the read-floor
  leg; the end-to-end AUTOCOMPLETE legs through `readSectionRows` — served through the
  portal source, keyed without it, keyed for a field the portal does not name, keyed for a
  source the caller does not hold; the IMPLICIT-SOURCE legs (a config-less portal naming
  test162: each principal's floor is his own whichever populated first, keyed for her
  through read and count, and outside any request scope or under another principal's
  scope the THREADED principal decides); the FORGED-SOURCE legs (a test3 portal named under dd655,
  a dd655 member, a dd1324 member, a test65 component paired with test3 through a stray
  matrix pair, a test65 member without the section grant: read AND count keyed) beside the
  virtual-section source (zzvmain1 → test3) still served; the autocomplete COUNT equal to the rows the read serves;
  served through a source naming the field only in its `fixed_filter` / only in its
  `filter_by_list`; an absent-`from_component_tipo` created-by (dd200) leaf served as the
  superuser answers; the MULTI-MAIN legs over `[test3, test65]` — test65 grants what test3
  hides — for the string leaf (three operators and `$not`) and both relation-leaf shapes:
  test3 rows blind with the notice, the sibling's row still filtered, the control's
  answers differ; review r7: the MULTI-MAIN ORDER leg — test162 granted on test65 only,
  her rows keep the default order under ASC and DESC, the superuser's reverse; the
  VIRTUAL-MAIN leg — `zzvmain1`, a scratch virtual of test3 owning no component, an
  absent-`from_component_tipo` leaf on a test91 locator hidden on the REAL section: blind
  with the notice, the control's answers differ; the refusal SHAPE leg — the hidden leaf
  under `$and` beside a granted leaf matching alpha answers EMPTY (`1=0`, never a dropped
  leaf that widens the `$and`); the scope-without-mains leg — `internal.invariant` from
  both the ORDER key and the filter conform).

## Addendum 2026-11-12 — multi-hop relation leaf keyed per ADMITTED section; the "Open, ledgered" hop paragraph is CLOSED

The "Open, ledgered" paragraph above is CLOSED by `WC-2026-10-01-search-hop-configured-targets`:
every hop's ON clause binds the joined row to the sections the hop ADMITS (the hop component's
configured targets in the step table where the caller holds the step component), each under its
own record predicate (`search/hop_scope.ts`). The relation-leaf rule above ("on a multi-hop path
of the last step's section") is superseded (T1-16 / S04): a multi-hop relation leaf's
`from_component_tipo` key is asked of EVERY section the LAST hop admits — told apart ON THE ROW
exactly like several mains — never of the client's declared step section. So a twin the
declaration does not name (granted the step component, hiding the leaf's `from_component_tipo`)
answers `1=0` for that locator (explicit) or `r.from_component_tipo IN (granted)` (absent), loudly
(`perm.out_of_scope`); a SPOOFED declaration (a non-target granting everything) keys nothing the
hop reaches. A hop that admits nothing keys nothing (matches nothing, as the hop). Internal
searches are unchanged. No fixture change (the store runs as the superuser). Gates:
`test/unit/search_hop_targets_native.test.ts` ("relation leaf from_component_tipo keyed per
ADMITTED section (T1-16)": explicit hidden + the loud refusal, absent, `$not` hit = miss, spoofed
declaration, the all-granted control, the internal search) and
`test/unit/search_hop_targets_real_user_native.test.ts` (the T1-16 leg: a real restricted profile
through `buildSearchSql`, root as control).
