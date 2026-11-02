# WC-2026-08-02-observer-subscription-registry-activation — observer edges dispatch from an ontology-derived registry; the ontology alone decides

- **Date:** 2026-08-02 (Act 2 of the observer foundation; the transitional
  hand-written activation table was removed the same day on the owner's
  ruling — the id keeps its original name, ids are permanent).
- **Decision:** owner (paco@dedalo.dev): *"remove the allow list — it converts
  an ontology decision into a code decision and is not right; you can create a
  cache, or a read once at bun start… but not a hardcoded ontology."* Standard
  observer semantics: **the subscriber registers itself** — the observed node
  does not maintain a list of who watches it. The good configuration lives in
  the observer's `properties.observe`; the observed node does not need to say
  "X is calling me". Requiring the forward mirror was the inversion that
  produced every dead edge in this subsystem.
- **Gates:** `test/unit/observer_subscriptions_native.test.ts` (DEC-12).

### Shape before (PHP, and TS until Act 2)

Observer discovery read ONLY the SAVED component's `properties.observers`
array (`component_common::propagate_to_observers`); the matching `observe`
entry was looked up per spec. Consequences:

- an edge had to be declared TWICE (forward `observers` + reverse `observe`);
  a missing half was DEAD CONFIG that failed silently — measured on the live
  ontology 2026-08-02: 64 mirrored edges dispatched, 9 reverse-only
  declarations inert (incl. the reported `rsc19 -> oh28` bug), 4 forward-only
  specs dead (5 in the suite DB).

### Shape after (TS)

Discovery comes from the ontology-wide SUBSCRIPTION REGISTRY
(`src/core/section/record/observer_subscriptions.ts`, built from
`getNodesWithProperty('observers') ∪ getNodesWithProperty('observe')`, cached
via `createOntologyCache`, deep-frozen, warmed once at boot — server.ts).

**THE DISPATCH RULE:** an edge dispatches iff the OBSERVER declares it in
`properties.observe` with a `server` block and a covered shape — plus wildcard
edges compiled from forward specs (below). **No code table gates it.** A
reverse-only declaration is a first-class edge: the 9 previously-inert edges
now dispatch —

- 5 genuine server observers, each self-sufficient under host resolution:
  `rsc19->oh28` (the originally reported bug), `rsc860->oh87`,
  `numisdata1373->numisdata1478`, `numisdata1373->numisdata1479` (both
  virtual-section resolved), `numisdata282->numisdata321` (targets from the
  observable data);
- 4 declared no-op/same-record shapes: `oh93->oh28` (filter:false
  component_state alias — the same-record widget recompute + TM row, exactly
  what its ontology `info` text asks for), `rsc36->rsc860`, `rsc36->rsc1368`,
  `rsc30->rsc1369` (filter:false on non-info models — the oracle-pinned
  terminal no-op; nothing is written).

Dispatchable set measured 2026-08-02: **64 mirrored + 9 reverse-only = 73
edges** on the app ontology (61 + 9 = 70 on the suite DB, which lacks the tch
trio). Risk is bounded by Act 1's laws (unchanged): the grow-only shrink
fail-safe means a hop can only ADD mirror entries, and nothing fires until
the observed component saves.

**HOST-SECTION RESOLUTION** ("which section's records do I recompute?" — the
one thing a reverse declaration may not carry implicitly), in order:

1. the `observe` entry's own `section_tipo` — ontology, on the observer: the
   authoring home for new edges (nothing uses it yet);
2. the forward spec's `section_tipo` (not the literal `'self'`). NOT
   redundant: a component declared once can be REUSED across sections —
   `rsc387` declares observer `hierarchy93` three times with `section_tipo`
   on1/ts1/dc1 while hierarchy93's own ontology position is section
   hierarchy20 (9 of the 64 mirrored edges are like this). Never silently
   retargeted;
3. the observer's OWN SECTION (dd_ontology ancestor chain —
   `getAncestorSectionTipo`), refined by the SQO filter path with
   VIRTUAL↔REAL equivalence (a virtual section's `relations[0].tipo` names
   its real section — `getSectionRealTipo`): `numisdata1478`'s own section is
   numisdata276 (real) while its filter path names numisdata5 (virtual) — the
   same section; the path's face wins because the referencing records store
   that section_tipo. A NON-equivalent path resolves to nothing;
4. unresolved → the recompute is REFUSED LOUDLY
   (`observers_host_section_unresolved` counter + validator RED), naming the edge and
   telling the author to add a section scope to the observe entry. Nothing
   hits this on the current ontology.

**THE FORWARD `observers` ARRAY IS LEGACY**, kept for exactly two things:

- **wildcard scoping** — the sole structural dependency: an `observe` entry
  with `component_tipo:'all'` is a MATCHING rule with NO intrinsic scope, so
  the forward specs naming the observer are the only thing bounding it. The
  registry compiles it (pass 1 only; pass 2 skips `'all'`, so a wildcard never
  mints an edge without a forward spec) into exactly 3 edges on the live
  ontology: `numisdata282->numisdata250`, `numisdata1451->numisdata257`,
  `tch555->tch557`. A wildcard with zero forward-declarers admits zero edges
  and is RED. Inventing a scope semantic would silently widen these observers
  to every save in the system;
- **reused-component host targeting** (resolution step 2 above).

**Validity (not bookkeeping) is enforced:** dead forward specs (observer has
no matching observe entry), dead wildcards, unresolved SQO hosts, malformed
declarations (a present-but-non-object `server` value — never dispatched,
never silently read as client-only; duplicate same-tipo observe entries obey
the pass-1 first-match law: the FIRST entry in array order owns the tipo) and
declared cycles are contract violations — RED in the gates on whatever ontology the
suite runs against, and LOUD operationally on production ontologies (boot
probe warms + validates the registry on every deploy/restart; the
`observers_registry` gauge + `observers_registry_contract_violations` counter
on GET /api/v1/counters). Known-open dead config, fixable only in the
ontology: `rsc1139/rsc1140/rsc1401/rsc1403 -> rsc19` (both DBs),
`rsc1531 -> rsc1214` (suite DB only).

**Per-edge kill switch** is an ONTOLOGY EDIT, never code: blank the observe
entry's `server` key on the observer and the edge stops engine-wide once the
ontology cache invalidates. (Removing the forward `observers` declaration no
longer stops a non-wildcard edge — the reverse declaration alone dispatches.)

The classification/resolvers/perform semantics of the dispatch itself are
unchanged (see the Act 1 entries: relay-writes-nothing, cascade-bounded-flag,
references-limit-not-honoured).

## Addendum 2026-08-06 — the grow-only risk bound named here is retired

The activation-risk paragraph above says "the grow-only shrink fail-safe means
a hop can only ADD mirror entries". That bound is gone: the recompute writes
the full law, drops included
(`WC-2026-08-06-observer-grow-only-failsafe-retired`). The registry's own
laws — reverse observer-declared discovery, the `entryServerBlock`
dispatchability predicate, wildcard compilation, host resolution — are
unchanged, and the second half of the bound still holds: nothing fires until
the observed component saves.

## Addendum 2026-10-30 — edges derived from a law (pass 3)

THE DISPATCH RULE above gains one source: a covered `source_overwrite` observer gets a
synthesized edge from the component it copies (`origin: 'law'`, `declaration:
'law-derived'`, `via` = its pointer), unless any declared entry for the same key —
client-only included — shadows it. Only `source_overwrite` derives edges. Live set:
`numisdata77 → numisdata679` derived, `numisdata11 → numisdata965` shadowed. The
per-edge kill switch stays an ontology edit: a client-only `observe` entry naming the
input blocks the derived edge. Full rule: `WC-2026-10-30-observer-law-derived-edges`.

`use_inverse_relations` is now a typed `ObserveEntry.server.config` key with a resolver
(`WC-2026-10-30-observer-target-resolvers`); the "classification/resolvers/perform
semantics are unchanged" sentence above no longer holds for `set_dato_external` edges.
