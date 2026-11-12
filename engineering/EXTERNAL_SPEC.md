# EXTERNAL_SPEC — external record services (`src/external/`)

Standing spec for the subsystem that resolves a record from a THIRD-PARTY
service instead of from the matrix. Companion to `engineering/REWRITE_SPEC.md`
§4 (the boundary law) and `engineering/RELATIONS_SPEC.md` §1 addendum
2026-08-05 (multi-engine dispatch). Built 2026-08-05/06; the wire law is the
ten `WC-2026-08-0{5,6}-external-*` / `-multi-engine-*` entries in
`engineering/wire_contract/`.

Vocabulary: **external service**, never a bare "service" —
`docs/core/system/services.md` already owns "service" for a client-side UI
module, which is why `src/core/services/` does not exist.

---

## 1. What the subsystem is

An external record service is a third party whose records Dédalo SHOWS inside a
section without copying them: a bibliographic catalogue, an authority file, a
gazetteer. The installation's one live case is **Zenon** (DAI), bound to
section `zenon1`.

Three facts define everything else:

1. **There is no stored value.** `zenon1` has ZERO rows in every matrix table
   and no `matrix_zenon` exists; `matrix_time_machine` holds zero rows for any
   `component_external` tipo. The section is purely DERIVED.
2. **The remote id IS the `section_id`** — a zero-padded STRING (`"001338683"`).
   Never `Number()` it: that drops the padding and asks the service for a
   different record.

    > **NOTE 2026-08-10 (section_id int unification).** A matrix record address
    > is now an int, so a remote id is protected by the **VALUE invariant, not
    > by its tipo**: a true remote id is never strict-numeric-without-leading-
    > zeros (zero-padded, or opaque like `"Q42"`), and that shape is what
    > `classifyWireSectionId()` keys on. `api_config` presence on a tipo does
    > **not** make its convertible ids external — sections carrying legacy
    > `api_config` residue (`rsc205`) hold thousands of real matrix records, and
    > a tipo-keyed rule silently routed their saves into the never-write echo
    > branch (S0, fixed same day). A convertible numeric value is a record
    > address on ANY tipo; the `external-ref` classification applies only to
    > NON-convertible strings on external tipos — and since 2026-09-24 "external
    > tipo" is `isExternalReferenceSection` (the binding AND an owned
    > component_external, §2.2), so a non-address on `rsc205` is junk
    > (`synthetic`, or `section_id.numeric_shaped`), never a remote id. Consequence for §4: an adapter
    > must never mint a bare convertible integer as a remote id — that value is
    > indistinguishable from a matrix record address and will be treated as one.
    > Law: `engineering/wire_contract/WC-2026-08-10-section-id-int-canonical.md`.
3. **The traffic is one-directional.** Dédalo reads; it never writes to the
   service, and never writes a remote value into a local record (§9).

Layout — every file is private except `api/`:

| File | Owns |
|---|---|
| `api/index.ts`, `api/types.ts` | THE FACADE. The only modules `src/core/**` may import. |
| `search.ts` | server-side search: refusals, the request, the hits (§10). |
| `registry.ts` | name → adapter. Unknown name THROWS. |
| `services/<name>.ts` | one adapter each (`zenon.ts`). Checklist: `services/README.md`. |
| `descriptor_types.ts` | `ExternalServiceModel` and its satellites (§4). |
| `config.ts` | ontology `api_config` → a typed, vetted binding; `publishApiConfig`. |
| `fields_map.ts` | payload → entries: unwrap, pick, extract, format, id codec, ceilings. |
| `transport.ts` | THE SUBSYSTEM'S ONE OUTBOUND DOOR (§5) — one of the engine's three (`engineering/OUTBOUND_SPEC.md`) — + the concurrency ceiling. |
| `breaker.ts` | circuit breaker per (service, origin). |
| `cache.ts` | row cache, in-flight coalescing, the per-page fan-out. |
| `errors.ts` | the closed error taxonomy + the log grammar. |
| `settings.ts` | THE ONE settings door (`config.external`). |

---

## 2. The four ontology pieces

A working binding is four declarations, in three different places. All four are
required; a missing one is a named degradation, never a blank (§8).

### 2.1 The mirror TLD (the section tree)

The external records need a section to be addressed in. `zenon1` is a REAL
section (`parent dd14`, `model section`, `relations NULL` — it is **not** a
virtual section), whose children are the display definition:

```
zenon1   section            properties.api_config  ← the connection
└ zenon2   section_group
  ├ zenon3   component_external   fields_map remote:'id'
  ├ zenon4   component_external   fields_map remote:'title'
  ├ zenon5   component_external   fields_map remote:'authors',              format:'zenon_authors'
  ├ zenon6   component_external   fields_map remote:'publicationDates',     format:'array_values'
  ├ zenon9   component_external   fields_map remote:'recordPage'
  ├ zenon10  component_external   fields_map remote:'containerTitle'
  └ zenon11  component_external   fields_map remote:'physicalDescriptions'
  zenon7   component_filter
  zenon8   section_list       relations [zenon3, zenon4, zenon5, zenon6]
```

The tree carries no data. It exists so that a locator can address a remote
record and so that the display of that record is ontology-declared like any
other section's.

### 2.2 The section's `api_config`

On the SECTION node's `properties`. It is the connection, and it is the source
of truth: no engine path reads a CALLER's copy.

```json
{
  "api_config": {
    "entity"        : "zenon",
    "api_url"       : "https://zenon.dainst.org/api/v1/record",
    "api_url_search": "https://zenon.dainst.org/api/v1/search",
    "ui_base_url"   : "https://zenon.dainst.org/Record/",
    "response_map"  : [
      { "local": "ar_records", "remote": "records" },
      { "local": "msg",        "remote": "status"  }
    ]
  }
}
```

- `entity` — the registry key. Unknown ⇒ `ExternalServiceNotRegisteredError`.
- `api_url` / `api_url_search` — FETCHED by this server. The binding checks
  their SHAPE only (parseable http(s), no embedded credentials); WHERE the
  server may go is decided at the outbound door, step 3 of §5 (the host
  allowlist `DEDALO_EXTERNAL_ALLOWED_HOSTS`, before any DNS), and nowhere
  else. A non-allowlisted host therefore still PARSES: the binding answers
  classification (`isExternalReferenceSection`, the restore/sweep set) the same
  on every install, and the request itself is refused `blocked_host` when it
  is made. Until 2026-09-27 the allowlist was also applied at parse, so on an
  install with the default EMPTY allowlist every classification question threw
  — and every time-machine restore was refused (`update.refused`) though
  nothing was being fetched (`WC-2026-09-27-external-allowlist-at-door-only`).
- `ui_base_url` — RENDERED in the curator's browser, a different trust
  boundary: http(s)-only, no host allowlist (§7).
- `response_map` — local role → remote payload key; `ar_records` names the row
  array.

Carriers in this installation: `zenon1`, `test3`, and `rsc205` — whose copy is
a stale 2024 duplicate. It is INERT only because no component_external is OWNED
by `rsc205` (§3 addendum 2026-09-24): until that rule, a flat/export path that
applied a zenon column to a local `rsc205` target bound this copy and sent the
LOCAL id to Zenon.

**A binding is not externality (2026-09-24).** `api_config` answers "which
service does this section point at" (`getExternalServiceForSection` — a lookup,
never a test). "Is this section EXTERNAL — are its non-address ids remote
records?" has ONE predicate, `isExternalReferenceSection`
(`src/external/record_fields.ts`): the binding AND a component_external in the
section's own or real section's subtree. Every decision site asks it — the wire
classifier (`classifyWireSectionId`), the section_id restore/sweep set
(`listExternalSectionTipos`), the frontier record key, the export prefetch. The
api_config-only boolean `isExternalSectionTipo` was DELETED (not redefined), so
no caller can decide on `api_config` alone again. `rsc205` is therefore LOCAL at
every door: `'abc'` classifies `synthetic`, `'007'` is refused
`section_id.numeric_shaped`, and its junk locator ids are classed (and
purgeable) by the sweep like any local section's. Ledger:
`WC-2026-08-10-section-id-int-canonical` addendum 2026-09-24. Gate:
`test/unit/external_reference_section_native.test.ts`.
`zenon1` and `test3` also carry `properties.search_engine: 'search_zenon'`,
which nothing reads: **DEAD**.

`parseApiConfig` is the ONLY constructor of a typed `ExternalApiConfig` — the
constructor IS the validation. It validates the binding's SHAPE and never
consults the egress allowlist: classification must not depend on the
operator's egress policy (an empty allowlist is the safe default, not a
misconfiguration).

### 2.3 The component's `fields_map`

On each `component_external` node. It says which remote field becomes this
component's entries.

```json
{ "fields_map": [ { "local": "dato", "remote": "authors", "format": "zenon_authors" } ] }
```

- Only `local: 'dato'` rows carry a value; other locals are ignored by the
  emission and by the requested-field union.
- The REQUEST is section-wide, not per component (§3 addendum 2026-09-24 (c)):
  a record is asked for ONCE with the id field plus every field any
  component_external of the section maps; each component projects its own
  fields from that one row.
- `remote` is a **dotted/indexed PATH** resolved against the row
  (`labels.en.value`, `items[0].body.value`); a flat top-level key is that
  path's degenerate case. The retired engine read one top-level key only.
- `format` names a formatter the ADAPTER implements. A name it does not
  implement is a loud `bad_config`, never a silent raw passthrough.
- EVERY resolvable `dato` row contributes, in declaration order. The oracle
  folded the map with `array_reduce`, so the LAST resolvable row silently won;
  every node in this installation declares exactly one row, so the two agree
  here (ledgered: `WC-2026-08-05-external-entry-normalisation`).

### 2.4 The caller's `request_config` item

A component in a NORMAL section reaches the external section through an
ordinary relation config item that declares `api_engine`:

```json
{
  "api_engine": "zenon",
  "sqo": { "section_tipo": [ { "value": ["zenon1"], "source": "section" } ] },
  "show": { "ddo_map": [
    { "tipo": "zenon5", "parent": "self", "fields_map": true, "section_tipo": "zenon1" },
    { "tipo": "zenon6", "parent": "self", "fields_map": true, "section_tipo": "zenon1" },
    { "tipo": "zenon3", "parent": "self", "fields_map": true, "section_tipo": "zenon1" },
    { "tipo": "zenon4", "parent": "self", "fields_map": true, "section_tipo": "zenon1" }
  ], "fields_separator": " | " }
}
```

`fields_map: true` on a ddo means "hydrate from the NODE's own
`properties.fields_map`" — the flag is a request to look it up, not a value.

Five nodes in this installation declare a non-`dedalo` engine, across FOUR
models — which is why dispatch lives in the shared relation engine and not in
`models/portal.ts`:

| Node | Model | Engines |
|---|---|---|
| `rsc368` | component_autocomplete | dedalo + zenon |
| `numisdata162` | component_autocomplete_hi | dedalo + zenon |
| `rsc1285` | component_portal | dedalo + zenon |
| `tchi29` | component_portal | dedalo + zenon |
| `test204` | component_portal | zenon ONLY |
| `test61` | box elements | zenon ONLY |

---

## 3. Dispatch: how a locator reaches a service

Read `engineering/RELATIONS_SPEC.md` §1 addendum 2026-08-05 first. In one
breath:

1. **Every config item contributes children.** `relations/config_ddo_map.ts`
   flattens each item's `show` + `hide` ddo maps into one deduped list (the
   oracle's `full_ddo_map`). Taking `request_config[0]` was why the zenon
   children of `rsc368` were never resolved at all.
2. **No `api_engine` branch exists in the read path, and none may be added.**
   The flattened map is filtered PER LOCATOR by the locator's own
   `section_tipo` in `relation_core.expandPortal`, so a `zenon1` locator sees
   only the ddos declared at `zenon1`. Dispatch stays model-polymorphic.
3. **External targets are batched.** `relation_core` answers "which target
   sections of this page are external?" ONCE per expansion, partitions those
   locators out, and resolves them in ONE `fetchExternalRows` fan-out parked on
   the emission context. A malformed `api_config` counts as EXTERNAL, so the
   failure surfaces as a degraded external cell rather than as an empty
   matrix lookup.
4. **The prepass is an optimisation, never a precondition.** A direct read, a
   `section_list` cell, an indexation cell and `resolve_data` all arrive with an
   empty scratch, and the component fetches its own row.
5. **Narrowing sites negotiate.** Where the engine genuinely needs ONE item
   (pagination stamp, list columns, order path, fields separator),
   `relations/request_config/engine_select.ts` picks the `dedalo` item when
   there is one — not a preference, the fact that it is the only engine with a
   matrix table behind it — and otherwise puts the caller's CONCERN
   (`ordering` | `pagination` | `listColumns` | `search`) to the adapter's
   capabilities, REFUSING with `ExternalEngineConcernUnsupportedError` where
   unsupported. Silently degrading an unordered list into an "ordered" one is a
   wrong answer that looks right. Census + shrink-only ratchet:
   `test/unit/external_config_narrowing_census.test.ts` (DELETE IT when its
   `deferred` list is empty — it is migration scaffolding, not an invariant).

> **ADDENDUM 2026-09-24 — ownership + verbatim ids on the FLAT/EXPORT paths.**
> Measured on the install DB: `rsc368` stores 12,557 zenon1 locators as
> zero-padded strings, mixed with local `rsc205` publications.
>
> 1. **Ownership.** A component_external resolves ONLY for records of its OWNING
>    section: the first `section` on its ontology parent chain
>    (`getAncestorSectionTipo`: `zenon3` → `zenon1`, `test215` → `test3`), or a
>    virtual section whose real section is that owner (`getSectionRealTipo`).
>    Any other target is FOREIGN: `deriveExternalValue` answers `{entries: []}`
>    with no remote call, no `source_status`, and the flat cell reports nothing
>    `unresolved` — the column does not apply, exactly as a stored column yields
>    nothing on a record that does not hold it. The rule reads the ONTOLOGY,
>    never the target's `api_config` (rsc205's residue is what bound the local id
>    before). An orphan component (no section on its chain) is `misconfigured`.
>    One predicate: `component_external/value.ts externalComponentAppliesTo`.
>    Why here and not only in the portal expansion: the flat resolvers
>    (`resolve/relation_list.ts`, `diffusion/export/atoms.ts`) apply EVERY child
>    of the component's config to EVERY target; §3.2's per-locator filter is the
>    portal expansion's alone.
> 2. **Verbatim ids.** The flat resolvers take the RAW stored id
>    (`number | string`). The external family consumes it as the remote id; every
>    stored family reads the matrix ADDRESS (`canonicalizeStoredSectionId` +
>    `isSectionId`) and resolves null for a non-address — `"000012281"` is never
>    record 12281. The export walk carries the next owner id in its canonical
>    stored form (int for an address, the remote id verbatim otherwise).
> 3. **grid_value leaves.** The model's inert `relation` column is not a locator
>    bag: the export fan-out treats component_external as a PLAIN leaf
>    (`atoms.ts isStoredRelationModel`), so grid_value Zenon columns emit values.
>
> Ledger: `WC-2026-09-24-external-foreign-target-and-verbatim-id`. Gate:
> `test/unit/external_section_id_verbatim_native.test.ts`.

> **ADDENDUM 2026-09-24 (b) — the EXPORT walk: batched rows, and never silently
> incomplete** (`src/diffusion/export/external_prefetch.ts`).
>
> 1. **Batch prefetch.** §3.3's batching was the portal expansion's alone; the
>    export walk resolved one record at a time, so every external cell fetched
>    its row LIVE, in series (the §3.4 fallback). Now, before each hydrate
>    batch (grid.ts `HYDRATE_BATCH`) is walked, the batch's external targets are
>    collected from the plan — a leaf component_external (at the root record or
>    through any number of relation hops) and the component_external children
>    of a relation leaf's own config — over the batch's stored locators, only
>    for targets the component OWNS (§3 addendum rule 1), and fetched in ONE
>    `fetchExternalRows` call with the per-section UNION of the predicted
>    fields: merged, coalesced, cached, and parallel only up to
>    `DEDALO_EXTERNAL_MAX_CONCURRENCY` at the §5 door. The rows are parked on
>    the run's own emission scratch (replaced per batch — bounded to one
>    batch; at most `EXTERNAL_PREFETCH_MAX_TARGETS` targets, the rest fall back).
>    Deeper fan-out is not predicted and takes the per-cell fallback.
> 2. **Declared coverage.** A parker that PREDICTS its consumers declares the
>    fields each section's rows were fetched with
>    (`setPrefetchedExternalRows(emission, views, fieldsBySection)`); a parked row
>    is then served only to a component whose `fields_map` fields it covers,
>    anything else fetches its own. A wrong prediction costs one request, never
>    a blank (the §8.1 field-signature law, applied to the scratch). The portal
>    prepass declares nothing and is served as before.
> 3. **Degradation record.** Every degraded external cell the walk resolves is
>    reported (`relation_list.ts CellValueResolveOptions.onExternalDegraded`)
>    into a run-scoped, bounded log: counts per (service, state), exported
>    records affected, a capped sample (`EXTERNAL_DEGRADATION_SAMPLE_LIMIT`) of
>    (exported record, component, remote section, verbatim remote id).
>    INCOMPLETE = `unavailable`, `timeout`, `circuit_open`, `disabled`,
>    `misconfigured`, and `truncated` (an `ok` status with dropped values);
>    `stale` is recorded but the value IS there; `not_found` (an answer) and a
>    foreign target are not recorded. `retryable` = some incomplete state is
>    §8.2-retryable. `missing_cells` / `missing_records` count only the cells
>    with NO value from the source (incomplete minus `truncated`) — what the
>    tool calls "could not be read". The export's `'end'` line carries it as
>    `external_degraded` ONLY when something degraded; tool_export records and
>    serves it (`WC-2026-09-24-tool-export-server-built-artifacts`, addendum
>    "external sources").
> 4. **Under the export frontier.** The prefetch runs AHEAD of the walk, so it
>    applies the walk's own crossing answer (`resolver.ts
>    exportCrossingAllowed`, the predicate behind `assertExportCrossing`) at
>    every crossing the walk will make — each hop into a record with the
>    component the next step reads, and each relation-leaf target. A refused
>    crossing is not followed and no remote id behind it is sent; the walk then
>    reaches the same crossing and applies the refusal law. Without it the
>    service learned which remote records a record the caller cannot read
>    cites, before the export aborted.
> 5. **Bounded against a sick service, stoppable.** The batch is fetched through
>    `fetchExternalRows`' bounded start (§5 "A queued call meets the CURRENT
>    verdict") with the export's Stop `signal`.
>
> Gate: `test/unit/export_external_prefetch_degradation_native.test.ts`.

> **ADDENDUM 2026-09-24 (c) — one request per record, the section's whole field
> set; and no external id is ever a local address** (`src/external/record_fields.ts`).
>
> 1. **The record field set.** Measured live: each component asked Zenon for
>    ITS OWN field (`field[]=title`); Zenon answers only what it is asked for, so
>    the row had no `id`, the identity check (`defaultPickRow`) refused it and
>    every non-id column was `not_found` — and one record cost one GET per
>    component. Now `fetchExternalRows` requests every record with
>    `recordRequestFields`: the id field (head of `remoteIdPath`, default `id`)
>    FIRST, then every field mapped by any component_external of the section's
>    own subtree and its REAL section's (virtual-aware; a malformed `fields_map`
>    contributes nothing — its component reports `misconfigured`), in ontology
>    order, then any caller field the section does not map. A field name the
>    ADAPTER refuses (`acceptsRemoteField`, §4 — Zenon: bare identifiers) is
>    left out of the set and out of a caller's fields: carried, it failed every
>    record request of the section (`bad_config` → every column `unavailable`).
>    Only the component mapping it is `misconfigured` (value.ts checks the same
>    predicate before any fetch, and logs the name). The v6 / frozen-PHP
>    shape (`field[]=id&field[]=title&field[]=authors…`), restored. The identity
>    check is KEPT. One request and ONE cache entry per record (§8.1), shared by
>    a cell's own fetch, the portal prepass (§3.3) and the export prefetch
>    (addendum (b)) whatever each predicted. Cached with the ontology lifecycle.
> 2. **Self-describing views.** Every `ExternalRowView` the row layer builds
>    names its `remoteFields`; a parked view is served to a component only when
>    they cover its fields (the declared coverage of addendum (b) item 2 is now
>    the fallback for a hand-built view). An unpredicted export cell is a cache
>    hit, not a second GET.
> 3. **The portal prepass obeys ownership.** A ddo with NO `section_tipo`
>    matches every target by declaration (§3.2), so `relation_core.ts`
>    `targetChildShapes` / `collectRemoteFields` also ask
>    `externalComponentAppliesTo`: a FOREIGN component_external neither makes a
>    target "derived" nor contributes fields, so a local target (with api_config
>    residue) is never sent to the service. An orphan still counts as derived (it
>    renders `misconfigured` instead of vanishing).
> 4. **No `Number()` on a target id.** The portal expansion and the dataframe
>    frame targets read a stored row only for a matrix ADDRESS
>    (`isSectionId`); a remote id (`'000012281'`) gets the identity-only
>    placeholder, never local record 12281.
> 5. **The frontier's record key** (`security/frontier_scope.ts
>    frontierRecordAllowed`). An EXTERNAL REFERENCE — a non-address string on a
>    section that binds an external service AND owns a component_external
>    (`isExternalReferenceSection`: record absence + a derived model, the read
>    path's law — NEVER `api_config` alone, which `rsc205` carries as residue
>    over only local rows) — has no local record, so the
>    record key (projects containment, the dd478 allow-list: properties of
>    matrix rows) has nothing to evaluate: it PASSES, and the crossing is
>    governed by the component key alone (the grant on the component read
>    through it), exactly like the component_external value. A non-address on a
>    LOCAL section (`'-000001'`, `'007'`) addresses nothing and fails closed —
>    it is never `Number()`-ed into another record's answer. Nor downstream:
>    diffusion's `processBatch` drops a non-address id before any matrix read
>    (ledger line; never read, never unpublished, never fatal) and
>    `readMatrixRecords` refuses one.
>
> Ledger: `WC-2026-09-24-external-record-field-set` (items 1-2; its addendum
> (b) the refused field name), `WC-2026-09-24-external-foreign-target-and-verbatim-id`
> addenda (b) (items 3-5) and (c) (the derived-model test, the diffusion drop).
> Gates: `test/unit/external_record_field_set_native.test.ts`,
> `test/unit/diffusion_frontier_scope_native.test.ts` (LAW 3).

---

## 4. `ExternalServiceModel` — the adapter contract

An adapter is **DATA plus pure functions**: it never opens a socket, reads
config or touches the DB. That is what makes "add a service" one file + one
registry line + one doc row, with no engine edit
(`external_registry_totality_tripwire`).

Required:

| Field | Contract |
|---|---|
| `service` | the name; MUST equal `api_config.entity` and the `api_engine`. |
| `egress` | what leaves the institution (§6). NO DEFAULT. |
| `remoteIdShape` | `numeric_string` (digits, significant leading zeros) or `opaque_token` (`[A-Za-z0-9._:-]+`). |
| `capabilities` | `{ordering, pagination, listColumns, search}` — consulted by §3.5. |
| `buildRecordRequest` | the one required function; returns an `ExternalRequestSpec`. |

Optional, each with a DEFAULT in `fields_map.ts` — the defaults are the general
case, so a nested-payload/opaque-id service (Wikidata `Q42`, `labels.en.value`)
is mappable by a cataloguer with no code: `unwrapRows`, `pickRow`,
`remoteIdPath` (default `'id'`), `acceptsRemoteField` (default: every name;
the grammar of a remote field NAME, so the section-wide record field set can
leave a refused one out — §3 addendum (c)), `extract`, `formats`, `encodeRemoteId` /
`decodeRemoteId`, `uiRecordUrl`, `credentialCatalogKey` / `credentialScheme` /
`credentialParam`, and the per-service overrides `timeoutMs` / `retry` /
`softTtlMs`.

`pickRow` defaults to **the row whose encoded id equals the requested one**,
else `null`. Never a blind first element: the oracle reduced the record array
and could not tell a multi-hit answer from a single hit, so a non-matching
answer became a confidently wrong value. A non-matching answer is `not_found`
(`WC-2026-08-05-external-first-record-reduce`).

---

## 5. Transport — the one door and its order

Every byte the subsystem sends leaves through `transport.ts::fetchExternalJson`
— the external subsystem's door, one of the engine's four outbound doors
(`engineering/OUTBOUND_SPEC.md` says which request takes which, and names the
guard the three that reach other institutions share: this door reads its body with the guard's
`readBytesCapped` and pins with its `pinToVettedAddress`, never a copy).
`external_outbound_tripwire` fails the build on any other `fetch(` /
`new Request(` / `node:http(s)` / `Bun.connect` under `src/external/**`. THE
ORDER IS LOAD-BEARING — each step exists because the next one would otherwise
leak something:

| # | Step | Failure kind | Socket? |
|---|---|---|---|
| 0 | method ∈ {GET, POST} | `bad_config` | no |
| 1 | master switch + per-service kill switch | `disabled` | no |
| 2 | circuit breaker for (service, origin) | `circuit_open` | no |
| 3 | HOST ALLOWLIST, before any DNS lookup | `blocked_host` | no, and no resolver traffic |
| 4 | `assertPublicUrl` → vet every address, PIN the socket to a vetted one, SNI kept at the real host | `blocked_host` | — |
| 5 | attach the credential — ONLY NOW | `bad_config` | — |
| 6 | fetch: `redirect:'error'`, AbortSignal at the timeout, STREAMED byte ceiling | `timeout`/`transport`/`http_status`/`too_large` | yes |
| 7 | retry ONLY on a SERVICE failure (timeout/transport/408/429/5xx), full jitter, `Retry-After` honoured | — | maybe |
| 8 | breaker update: 3 consecutive SERVICE failures open; any other outcome is NEUTRAL; half-open admits ONE probe, which MUST be settled | — | — |
| 9 | JSON parse failure is `protocol`, not `transport` | `protocol` | — |

Two orderings carry the whole security argument and are asserted:

- **3 before 4** — the allowlist is consulted before the first DNS traffic. The
  URL is assembled from the ontology, which is editable data; the OPERATOR's
  allowlist, not the ontology, decides where this server may go. An EMPTY
  allowlist refuses everything: it is the door, not a narrowing of an open one.
- **5 after 3+4** — attaching the credential earlier would let an ontology edit
  point the request at an attacker's host and exfiltrate it.

Concurrency is bounded per (service, origin) AT THE DOOR, so the ceiling holds
for a caller that bypasses the row cache, and retries happen INSIDE the slot so
a retrying request cannot multiply the load a struggling service is already
failing under. The ceiling is re-tested after every wake, not once on entry:
handing a slot on only RESOLVES the next waiter, whose `active++` runs a
microtask later, and a caller arriving in that window would otherwise take a
slot that is already spoken for. A slot entry is dropped only when nobody holds
it, waits for it, or is on the way to it.

The breaker's state is keyed by `${service}|${origin}` and cleared BY TIME
ONLY. It deliberately does NOT use `createOntologyCache`: that factory's clearer
fires on every `dd_ontology` write, so an unrelated cataloguing save would reset
an open circuit and re-open the flood at the worst possible moment. v6 kept a
single `$_SESSION['zenon_is_available']` boolean — request-identity state that
bleeds between users under a persistent worker, and that one empty response
poisoned for a whole session across every entity at once.

A half-open probe must be SETTLED on every exit path — `recordSuccess`,
`recordFailure`, or `releaseProbe` when the attempt died LOCALLY and learned
nothing about the remote end. Nothing here is self-healing: an unsettled probe
leaves `probeInFlight` true, every later check refreshes `touchedAt` so the
prune never reaps the entry, and the origin answers `circuit_open` until the
process restarts — a permanent outage of a healthy service, wearing the mask of
a remote one. `releaseProbe` counts NO failure on purpose: a local defect is hit
on every request, so counting it would open the circuit by itself and hide the
real error behind `circuit_open`.

**The evidence law (2026-09-24).** The breaker answers "is the REMOTE
healthy?", so only evidence about the remote's health moves it —
`breaker.ts:isServiceFailure`, which is ALSO the retry predicate (a retry and a
count both mean "the remote may be better next time"):

| outcome | breaker | why |
|---|---|---|
| `timeout`, `transport` | counts | the remote did not answer |
| `http_status` 5xx / 429 / 408 | counts | the remote says IT is failing, overloaded, or timed out waiting |
| `http_status` any other 4xx (400, 401, 403, 404, 410, 422…) | NEUTRAL | an answer about the REQUEST; counting 401/403 would also hide a credential error behind `circuit_open` |
| `too_large` | NEUTRAL | a 2xx body past OUR ceiling — one record |
| `protocol` | success | the socket delivered; recorded before decoding |
| `blocked_host`, `bad_config` (and the no-socket kinds) | NEUTRAL | local verdicts — nothing was learned about the remote |

NEUTRAL means neither counted NOR reset: a 4xx proves the front door answered,
not that the service can serve records (a sick backend behind a validating proxy
answers 400 instantly and 503 for everything else), so only a delivered 2xx
resets the streak. A half-open probe that ends NEUTRAL is released
(`releaseProbe`) — the circuit stays half-open and the next call probes. The
measured defect this fixes: a portal sent unpadded / LOCAL ids to Zenon, Zenon
answered `400 Error loading record` three times, and the circuit opened for
every Zenon lookup on the install.

**Only the probe settles the probe.** `releaseProbe` and a probe-verdict
`recordFailure` are called only by the call `checkBreaker` admitted as the
probe (`recordFailure(…, asProbe)`). A call admitted while the circuit was
closed that ends after the probe was admitted — neutral or failed — neither
clears `probeInFlight` (a second probe would pass) nor logs a re-open line.

**A queued call meets the CURRENT verdict.** Step 2 runs on arrival AND again
when a call that waited gets its concurrency slot; a retry is abandoned once the
circuit is open (checked before and after the backoff). Before this, a batch
caller (the export prefetch: up to 5 000 targets) passed every call through the
breaker while it was still closed and parked them behind
`DEDALO_EXTERNAL_MAX_CONCURRENCY`: against a slow or hanging service each one
then ran its full timeout × (1 + retries) after the circuit had opened
(measured: 40 targets → 120 sockets; now at most
(3 + concurrency − 1) × (1 + retries)). `fetchExternalRows` additionally STARTS
its records a few at a time (at most `DEDALO_EXTERNAL_MAX_CONCURRENCY` workers)
and takes the caller's `signal`: once aborted, no further record starts.

**Logging: transitions once, refusals counted.** Opening, and a failed probe's
re-opening (so at most one line per cooldown), logs ONE `external.circuit_open`
line through the one door, naming the failure that tripped it and the cooldown;
closing logs one info line, `[external:<service>] circuit_closed origin=…
open_for_ms=… refused=…`. `refused` is PER OPEN PERIOD: a re-open line reports
the period that just ended and the count restarts, so the closing line's
`refused`, like its `open_for_ms`, is the last period's. A refused call logs NOTHING — it bumps the circuit's
`refused` (`breakerSnapshot()`) and the process counter
`external_circuit_refusals` (`GET /api/v1/counters`); `logExternalError` drops
`circuit_open` refusals by contract. Every other failure is logged once per
distinct CLASS (service, kind, origin, status, section, detail — the remote id
is deliberately NOT in it, `errors.ts logDedupKey`) per 10-minute window; the
logged line names the first id as its example, and repeats bump
`external_log_suppressed` (so `error_external_<kind>` counts LOGGED lines, and
the two counters together count occurrences). Keyed per id, an API-wide failure
the breaker does not count (every id answered 400) logged one stack per record.
The dedup ledger `errors.ts:loggedLines` is time-pruned and size-capped
(module_state_tripwire).

**Record-path 4xx degrade ONE record** (`cache.ts`, WC-2026-09-24-external-record-4xx-is-not-found):
404/410 and 400/422 on a RECORD request become that record's `not_found`
(negative-cached for a soft TTL; 400/422 are logged, since they can mean OUR
request is wrong); 401/403 and the rest stay a named `unavailable` with reason
`http_status`. A search endpoint's 4xx never comes through here.

**…unless the ENDPOINT answers 4xx for every id** (`record_answers.ts`). Per
(service, record endpoint = scheme + host + PATH of the api_url), the record-path
4xx answers since the endpoint last DELIVERED a record answer (any 2xx) are
counted. At `SUSPECT_STREAK` (20) the endpoint is SUSPECT: one
`external.http_status` line names the streak, the statuses and the api_url PATH
(a wrong path, a moved route or a changed id format is the likely cause), at most
once per 10 minutes while it lasts, and bumps `external_record_endpoint_suspect`;
every further 4xx there reads as the SOURCE failing — `unavailable`, reason
`http_status`, not negative-cached — so cells, lists and exports say "could not
be read" and an export is marked incomplete. One delivered answer ends the
episode. It never moves the breaker (a configuration error must not hide behind
`circuit_open`). The map `record_answers.ts:recordAnswerStreaks` is deleted on
delivery and pruned after an hour untouched (module_state_tripwire).

---

## 6. Egress classes, and the disclosure they imply

`egress` has NO DEFAULT: a new adapter must state its class, and
`external_egress_tripwire` proves the class is TRUE of the request the adapter
builds (sentinel-driven — a record whose CONTENT is a unique sentinel is loaded
and the sentinel grepped out of every URL, header and body).

An adapter declares TWO classes when it can search: `egress` for the RECORD
path and `searchEgress` for the SEARCH path. One field cannot be honest about
both — a record fetch sends ids the install already holds, a search sends free
text a cataloguer typed — and the gate holds each path to its own class,
proving additionally that a record request CANNOT carry terms
(`ExternalRecordRequestContext` has nowhere to put one).

| Class | What leaves | Today |
|---|---|---|
| `record_identifiers` | remote record ids, the language code, remote field NAMES; no body | `zenon` (record path) |
| `query_terms` | free text a cataloguer typed | `zenon` (search path, `searchEgress`) |
| `record_content` | data stored in this installation's own records | none |

**`record_identifiers` is not "nothing".** The id set is ITSELF a disclosure: it
tells the remote service which records this institution holds, and at what rate
they are being consulted. An institution that must not disclose its holdings
turns the subsystem off (`DEDALO_EXTERNAL_ENABLED=false`) or omits the host from
the allowlist — this is stated here so the choice is made deliberately rather
than discovered.

---

## 7. Secrets, and the two publication paths

`api_config` is CATALOGUING DATA: writable by anyone who can edit the ontology,
readable through ordinary section reads. Therefore:

- a credential NEVER comes from the ontology. `parseApiConfig` and
  `publishApiConfig` STRIP every credential-shaped key (broad regex; a false
  positive costs an unused field, a false negative ships a secret) and report
  the strip;
- a credential value is read ONLY by the outbound door, through the config
  readers, on a catalog entry whose `scope` is `'secret'` with no default;
- `ui_base_url` must be http(s) with no embedded credentials. The portal
  concatenates it with a `section_id` and opens the result, so a `javascript:`
  value stored in the ontology would be stored XSS on a curator's click.

`api_config` reaches a browser by exactly TWO paths, and both go through the ONE
shaper `publishApiConfig`: the parsed `request_config[].api_config`
(`relations/request_config/external.ts`) and the structure-context
emitted-properties echo (`resolve/structure_context.ts`). It guarantees, in
order: credential strip → a publishable-key ALLOWLIST (only an allowlist catches
a future `internal_admin_url`) → URL vetting, with ONE bad field refusing the
WHOLE object, because a half-published binding is a trap. It NEVER THROWS: both
call sites are read paths whose job is to render a form.

No host allowlist applies on publication: those URLs are fetched by the
CURATOR'S BROWSER, a different trust boundary, and gating them on the server's
egress list would silently break a working catalogue link on every install that
has not opted into server-side fetching.

Gate: `external_secret_confinement_tripwire` (both paths + a source scan proving
no third exists).

---

## 8. The row cache, and the degradation table

### 8.1 Key

```
service | originAndPath(api_url) | sectionTipo | remoteId | dataLang | fieldSignature
```

`fieldSignature` is the SORTED requested field set: v6's static cache omitted
it, so a component asking for `{id,title}` was served a row fetched for `{id}`
and silently rendered nothing. Since 2026-09-24 that set is the SECTION's record
field set (§3 addendum (c)), not the requesting component's — the signature does
not fragment by caller: one entry per record. It stays in the key because the
set is ontology-derived (a fields_map edit must never be served a row fetched
for the old set). `dataLang` is read AT CALL TIME through
`currentDataLang()`, never module-captured. The PATH is keyed but never the
QUERY — the query holds the id, the fields and (for a `query`-scheme
credential) the secret.

**NO PRINCIPAL is in the key**, and that is a claim that must stay true: with
`record_identifiers` egress and ONE install-wide credential the response cannot
vary by user, so a shared cache is legal. A per-USER credential would make it
illegal — the day an adapter needs one, the principal joins the key, or that
service opts out of the shared cache.

Rows are coalesced in flight (a portal row with four external children issues
ONE call — and, with the section-wide field set, so do four sequential cells) and served past their soft TTL as `stale` while a refresh runs behind
the request. Lifecycle is `createOntologyCache`, which is RIGHT here: the
content derives from `api_config` and the field set, both ontology-derived.
Dropping the map is not the whole of that lifecycle: a fetch already in the air
settles AFTER the write, carrying a row unwrapped by the PRE-edit binding, so
the coalescer re-resolves the section's binding before it stores and drops the
write on a mismatch. The requesting read still gets its row — refusing it would
500 a page because somebody else pressed save — but it never becomes the cached
answer for the next five minutes.

### 8.2 States

`entries: []` plus a `source_status` naming the state — **no silent blanks**.
"The source did not answer" and "this work has no author" look identical on
screen, and a cataloguer will act on the difference.

| state | Cause | `retryable` | label key |
|---|---|---|---|
| `ok` | fresh success — **never reaches the wire** (except with drop counters) | false | — (`external_source_truncated` when values were dropped) |
| `stale` | served past the soft TTL; carries `stale_since` | true | `external_source_stale` |
| `unavailable` | transport / http_status / too_large / protocol, no cached row | true | `external_source_unavailable` |
| `timeout` | the request exceeded the timeout | true | `external_source_timeout` |
| `not_found` | the service answered; the record is not in the answer — including a record-path 400/404/410/422, unless the endpoint is SUSPECT (§5: then `unavailable`) | false | `external_source_not_found` |
| `circuit_open` | the breaker is open for (service, origin) | true | `external_source_circuit_open` |
| `disabled` | master switch or per-service kill switch | false | `external_source_disabled` |
| `misconfigured` | `not_registered` / `bad_config` / `blocked_host`, a section with no `api_config`, an empty `fields_map` | false | `external_source_misconfigured` |

`label_key` is a KEY into `src/core/labels/master.json`, never prose: the
message must be translatable and the server does not know the user's
application language at this depth. `retryable` is FALSE exactly where waiting
cannot help, so a client does not offer a retry that hammers a host which will
never answer.

Emission ceilings: an over-long value is REFUSED, never trimmed (a shortened
title is a wrong title that looks real); entries past the count ceiling are
CUT; a value with no canonical text form (an object mapped without a `format`)
is REFUSED. All three are counted in `source_status`.

### 8.3 Per surface

| Surface | Degraded behaviour |
|---|---|
| edit / list / tm item | `entries: []` + `source_status`; the item still emits |
| section_list column, export flat cell | the joined entries; empty + the model reported unresolved when the source is unreachable; a FOREIGN target (§3 addendum 2026-09-24) is empty and NOT unresolved — nothing was asked |
| export (the whole deliverable) | every degraded cell is counted into the export's `external_degraded` summary ('end' line, tool_export manifest / list / preview); the files stay downloadable and are marked incomplete in the tool (§3 addendum 2026-09-24 (b)) |
| portal / autocomplete expansion | the external locators resolve to derived items; a non-`component_external` model at an external target is REFUSED loudly in the child loop |
| import | refused per cell, every shape (§9) |
| save / delete_data | refused / skipped (§9) |
| search (SQO) | THROWS — there is no SQL surface (§10) |
| search (adapter) | `searchExternalService` THROWS: a search has no other content to protect, and `[]` reads as "no matches" (§10) |
| client render | text, plus a visible per-state marker (`WC-2026-08-06-external-client-render`) |

`deriveExternalValue` NEVER THROWS: throwing would blank the whole record's read
for one degraded field. A CONFIGURATION question (§3.5) is the opposite posture
and refuses loudly — the two must not be confused.

---

## 9. The write invariant

**Dédalo never writes to an external service, and never writes a remote value
into a matrix record or into `dd_ontology`. The only curated thing written is
the CALLER's locator.**

One-directional is the CONTRACT, not a not-yet-built feature: an external record
is somebody else's, and every path that would turn it into a local write is
cheap to open and invisible once open. The predicate is the descriptor facet
`emitHook: 'external'`, never a model-name list.

| Path | Refusal |
|---|---|
| import | no `importConform`; flat/JSON/EMPTY cells refused per cell, model named |
| save | `saveComponentData` throws `ExternalWriteRefused` BEFORE the transaction opens, after the `component_alias` hop |
| delete_data | the model is in `delete_record.ts EXCLUDED_EMPTY_MODELS` — "emptying" would write a TM backfill row and a column key for data the record never held |
| subsystem | `src/external/**` imports no `matrix_write` / `json_codec` / `core/db/`, names no `matrix_*` table, holds no DML |
| outbound | `ExternalRequestSpec.method` admits only `GET`/`POST`, and the transport re-checks at step 0 — an adapter is DATA, and a `DELETE` that reached the socket would already have destroyed a remote record |

Positive control: `{"section_tipo": "zenon1", "section_id": "001338683"}` still
saves, byte-identical, zero padding intact.

DELIBERATE DIVERGENCE from the retired engine, licensed by census: PHP's
`component_external` had a `# Tool Time machine case` branch calling
`parent::set_dato()`. `matrix_time_machine` holds ZERO rows for any
`component_external` tipo and `zenon1` has ZERO matrix rows — nothing to
restore, and restoring would fossilize a stale remote answer into a column the
read path never consults. Gate: `external_write_refusal_tripwire`; ledger:
`WC-2026-08-06-external-write-refusal`.

---

## 10. Search — SERVER-SIDE (2026-08-06)

There is no SQL surface to search: the value lives in a third-party API, so an
external search goes through the adapter, never through SQO
(`component_external.search` is still `{status:'unported'}` and THROWS — a
silently empty result set would look like "no matches").

The browser asks the engine; the engine asks the service through the
subsystem's ONE outbound door (§5). Until 2026-08-06 `service_autocomplete.js` (`zenon_engine`)
called the search endpoint DIRECTLY FROM THE BROWSER, which bypassed every
control in §5 — and, since the XSS-02 CSP dropped third-party origins from
`connect-src`, failed outright. Widening `connect-src` was the wrong fix twice
over: it reverses a deliberate hardening, and the origin would come from an
OPERATOR-EDITABLE ontology field.

| Piece | Owns |
|---|---|
| `descriptor_types.ts` | `ExternalSearchRequestContext` (terms, lang, fields, **limit + offset**), `ExternalSearchPayload` (`{rows, total}`), `searchEgress` |
| `services/<name>.ts` | `buildSearchRequest` + `unwrapSearch`. Optional: no implementation ⇒ the ENGINE cannot search that service, `capabilities.search` ⇒ the SERVICE cannot. A caller refuses loudly on either |
| `search.ts` | `searchExternalService` — the facade function. Resolves the binding, refuses, builds, fetches through `transport.ts`, decodes, id-codecs every hit |
| `core/api/handlers/dd_external_api.ts` | `dd_external_api::search` — the client action. Authenticated + CSRF-gated + READ permission on the caller component |

Six things that are contract, not detail:

1. **The client sends no URL, host, service name, field list or render mode.**
   Only the CALLER's `tipo` + `section_tipo`, the terms and a page. The service
   comes from the target section's `api_config`, the fields from each external
   node's own `properties.fields_map`, and the TARGET SECTION is derived by
   three rules that are contract, not detail (gate:
   `external_search_target_tripwire`):
   **(a)** the target is the section of the ddos whose model carries
   `emitHook: 'external'` — never `ddo_map[0]`'s, which on a PORTAL is the
   portal's own ddo in its own section (`rsc1285` → `rsc368`@`rsc332`) and
   resolved three of this installation's six callers to a section with no
   `api_config`;
   **(b)** every render mode is asked, because the builder answers a different
   item set per mode and `numisdata162` declares its external item in EDIT only;
   **(c)** two distinct external targets are REFUSED by name — the client cannot
   say which source selector it is on, and searching the wrong catalogue is a
   wrong answer that looks right.
2. **An empty query is refused before any socket** and answers an empty result.
   The browser's `ñ`-sentinel (which existed because Zenon answers an empty
   `lookfor` with its first ten records) is NOT ported: a magic string whose
   correctness depends on a remote tokeniser continuing to fail to match it is
   not a contract.
3. **`limit`/`offset` are caller-driven** (default 20). Above `MAX_SEARCH_LIMIT`
   is refused, not clamped; an offset that is not a whole number of VuFind pages
   is refused, not rounded.
4. **The lang is derived**, never hard-coded — the same alpha-2 helper and `en`
   default the record path uses.
5. **`searchEgress` is a SEPARATE declaration** (§6). A search sends free text a
   cataloguer typed; the record class cannot be true of it.
6. **Search results are NOT cached**, while rows are (§8): a query is free text,
   one per keystroke, and a stale RESULT SET is a wrong answer to "what is in
   the catalogue?" with nothing to mark. Identical IN-FLIGHT queries are still
   coalesced. `searchExternalService` also THROWS rather than degrading — a
   search has no other content to protect, and `[]` is a lie a user acts on.
7. **A field name the adapter refuses is ONE column's error, not the search's
   (2026-09-24).** The search's `field[]` union is filtered through the bound
   adapter's `acceptsRemoteField` exactly like the record request
   (`record_fields.ts`), reporting through the same door
   (`reportRefusedRemoteFields`: one deduped `external.bad_config` line naming
   the tipo and the name). The component that maps it keeps its column (index
   pairing) and emits `entries: []` + `source_status.state: 'misconfigured'` on
   every hit; every other column renders. Only when NO column is left
   renderable is the whole search refused (`external.bad_config`). With no
   refused name the `field[]` bytes are unchanged. Ledger:
   `WC-2026-08-06-external-search-request` addendum 2026-09-24.

### 10.1 The client half (same day)

`service_autocomplete.js`'s `zenon_engine` is now `external_engine` and calls
`dd_external_api::search` through `data_manager.request` — the client's ONE
request path (session cookie, CSRF token + rotation, 401 re-login recovery,
error reporting). `zenon_engine` stays as an ALIAS because `autocomplete_search`
resolves an engine by name; any other non-`dedalo` `api_engine` resolves to
`external_engine` too, so adding a second service is an ontology edit and not a
client edit. The fallback URL, `lng:"de"`, the sentinel, the `field[]` list, the
per-service formatter and the whole client-side answer fabrication are DELETED —
the browser now says only who is asking and what was typed.

**A failed search is NAMED.** The action answers a service/configuration failure
with HTTP 200 + `result:false` + the record path's own `source_status`
(`stateForKind` + `externalSourceStatus`: one taxonomy, one state→label_key
map), which the widget renders through the shared `source_status_label`. A 4xx
would be worse than useless here — `data_manager` discards a non-ok body (only
401 survives, WC-051) — so 4xx is reserved for CALLER FAULTS. Two new keys:
`external_search_empty_query` (the one neutral state) and
`external_search_failed` (a failure with no envelope at all).

Ledger: `WC-2026-08-06-external-search-request`. Gates:
`test/unit/external_search_native.test.ts`, the `query_terms` half of
`external_egress_tripwire`, the fourth section of
`external_client_render_tripwire` (no third-party origin reachable from the
autocomplete path), and `client/dedalo/test/client/js/test_service_autocomplete.js`.

---

## 11. Gates

| Gate | Guards |
|---|---|
| `external_registry_totality_tripwire` | every declared engine/entity resolves to a registered adapter; unknown THROWS; every `api_config` parses; every `fields_map` well-formed; every adapter declares egress + capabilities + a round-tripping id codec |
| `external_outbound_tripwire` | ONE outbound door under `src/external/`, and it still performs every step of §5 in order (the engine's other two doors: `engineering/OUTBOUND_SPEC.md`) |
| `external_secret_confinement_tripwire` | §7, on BOTH publication paths + a no-third-path scan |
| `external_isolation_tripwire` | the closed set of module-level state; no captured request identity; concurrent langs/field sets never serve each other's row |
| `external_egress_tripwire` | §6, sentinel-driven; per-PATH classes (`egress` / `searchEgress`) |
| `external_degradation_tripwire` | §8.2 — no silent blank on any reachable (status, kind) pair; the maps are total; every label key is defined |
| `external_write_refusal_tripwire` | §9, five axes + a positive control |
| `external_client_render_tripwire` | the client half: text rendering, the visible marker, one `ui_base_url` consumer, and NO third-party origin reachable from the autocomplete search path (§10.1) |
| `external_search_target_tripwire` | §10.1 — the target section is derived from the EXTERNAL ddos (not `ddo_map[0]`), across EVERY render mode, and two targets are refused by name |
| `external_config_narrowing_census` | §3.5 — TRANSITIONAL RATCHET; delete when `deferred` is empty |

Behaviour twins (`test/unit/external_*_native.test.ts`): `breaker_evidence`, `cache`, `degradation`,
`emit`, `fields_map`, `multi_source`, `record_field_set`, `reference_section`, `request_config`, `search`, `search_action`,
`section_id_verbatim`, `transport`, `zenon`; the export walk's batch prefetch
and degradation record: `test/unit/export_external_prefetch_degradation_native.test.ts`.
Census source: the FROZEN `test/fixtures/external/ontology_census.json`,
harvested from the application DB, because the gates must be credless and the
test DB holds a smaller ontology that would quietly assert less.

Operator knobs: `src/config/catalog/external.ts` (twelve `DEDALO_EXTERNAL_*`
keys; the rendered operator prose is `docs/administration/configuration/config.md`). Cataloguer's
guide: `docs/core/system/external_services.md`.
