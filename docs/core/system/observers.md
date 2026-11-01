# Server-side observers

> See also: [Events](../events.md) (the client-side `event_manager`) · [SQO](../sqo.md) · [search](search.md) · [tm_record](tm_record.md) · [component_info](../components/component_info.md) · [component_info cookbook R6](../components/component_info_cookbook.md#r6--wire-observers-so-the-widget-recomputes-on-saves) · [component_portal](../components/component_portal.md) · [System hub](index.md)

Some component values are not typed by anyone — they are **derived**. A type
record's *Coins* portal lists every coin that points at it. A thesaurus term's
*Library* portal lists every publication that cites it. A `component_state`
turns a handful of check boxes into one "finished" flag.

Nothing recomputes those values when you edit the record they derive **from**,
because that record is somewhere else entirely. That is what this subsystem is
for: when a component saves, every component that declared an interest in it
**recomputes, server side, after the save commits** — whichever door the save
came through (an editor panel, a CSV import, an API tool, a duplicate).

This page is the configurator's and integrator's reference for that machinery.
Examples are real nodes on the `monedaiberica` install (`dedalo_mib_v7`) and are
labelled with their models; verify tipos against your own ontology before
copying anything.

## The model in one breath

An **observer** declares, in its own ontology node, which components it watches.
That declaration alone is the whole registration — the watched component is not
asked and does not need to know. On every save the engine looks up the watchers
of the saved component, works out **which records** each of them has to
recompute, runs **what** it computes, and then lets the watchers of *those*
components fire in turn — bounded, and never inside the caller's transaction.

| Module | Owns |
|---|---|
| `src/core/section/record/observer_subscriptions.ts` | Edge discovery: the ontology-wide subscription registry, host-section resolution, the contract validator. |
| `src/core/section/record/observers.ts` | Dispatch and the recompute kernel: relay, `set_dato_external`, info recompute, the safety guards. |
| `src/core/section/record/external_laws/` | The three value laws an external mirror can obey, the one classifier that picks a node's law, the one merge, and the target-resolver table. |
| `src/core/section/record/external_refresh.ts` | The portal's *update external* button: an on-demand recompute of one mirror on read. |
| `src/core/section/record/observer_reconcile.ts` + `scripts/observer_reconcile.ts` | The operator sweep that heals mirrors left stale by bulk doors. |

Propagation is fired from the component-save chokepoint, so it is not
dispatch-only: imports, tools and record duplication propagate identically.

## Declaring an edge: `observe` is enough

An observer declares what it watches in its own `properties.observe`. Each entry
names one observed component and may carry two independent halves:

- `client` — drives the browser [event manager](../events.md): live UI
  reactivity inside the open tab.
- `server` — drives **this** subsystem: the recompute on save.

> **An edge dispatches if — and only if — the observer's `observe` entry carries
> a `server` object.** The observed component does not declare anything.

This is ordinary observer semantics: the subscriber registers itself. The
canonical single-declaration case, live on this install, is **oh28**
(`component_state`, section `oh1` — *Oral History*), which recomputes whenever
**rsc19** (`component_state`) saves. `rsc19` says nothing about `oh28`. From
`oh28`'s `properties.observe`:

```json
{
    "server": {
        "filter": {
            "$and": [
                {
                    "q": null,
                    "path": [
                        {
                            "name": "digitization",
                            "model": "component_portal",
                            "section_tipo": "oh1",
                            "component_tipo": "oh25"
                        }
                    ],
                    "q_operator": null
                }
            ]
        }
    },
    "component_tipo": "rsc19"
}
```

On every `rsc19` save the engine searches section `oh1` for the interviews that
reference the saved record through the `oh25` portal (*Audiovisual*), and
recomputes `oh28` on each of them.

An entry with **no** `server` key is a client-only observer: the browser
subscribes locally and the server does nothing. Both kinds are common — measured
on this install, 60 of the 136 `observe` entries are client-only, and 39 of the
67 nodes that carry `observe` declare at least one `server` half. A `server`
value that is present but is *not* an object (`"server": null`, a string, a
number) is malformed authoring — it never dispatches, and it is reported as a
contract violation.

!!! note "First match wins"
    When an observer declares several entries, the **first** entry in array
    order whose `component_tipo` equals the observed tipo (or is `"all"`) is the
    one that dispatches. A client-only entry placed before a `server` entry for
    the same tipo shadows it.

### The legacy forward `observers` array

An edge used to require a **second, mirror declaration**: a
`properties.observers` spec (`[{section_tipo, component_tipo}]`) on the
**observed** component, naming its watcher. Half-declared edges were therefore
silent dead configuration, and dropping that requirement is the point of the
2026-08-02 rebuild. Measured on this install: **73 dispatchable edges**, of which
**9** had never dispatched at all despite a perfectly correct `observe`
declaration. Six of those nine do real server-side work; the remaining three
resolve to the terminal no-op described further down, so they now dispatch but
still compute nothing.

The forward array survives for exactly **two jobs**:

1. **Scoping the `"all"` wildcard.** An `observe` entry with
   `component_tipo: "all"` is a *matching rule* with no intrinsic scope — read
   literally it would mean "every save in the system". The forward specs naming
   the observer are the only thing that bounds it: the wildcard compiles to
   exactly that edge set, and a wildcard nobody forward-declares admits **zero**
   edges. Live wildcard observers here: `numisdata250`, `numisdata257` and
   `tch557` (all `component_portal`, all in section `tchi1`), compiled from one
   forward spec each — `numisdata282`, `numisdata1451` and `tch555`.
2. **Host targeting for a reused component.** A component declared once can be
   reused across several sections, and something has to say whose records the
   edge covers. Live case: `rsc387` (`component_autocomplete_hi` —
   *Descriptors*) carries three forward specs naming the same observer
   `hierarchy93`, with `section_tipo` `on1`, `ts1` and `dc1` — three virtual
   faces of section `hierarchy20` (*Thesaurus*), where `hierarchy93` itself is
   defined.

    On *that* edge the scope is not what the save-time recompute searches — it
    is a `set_dato_external` edge, and those take their targets from the saved
    data (see the next section). What the scope buys there is the operator
    sweep: it is the set of sections `scripts/observer_reconcile.ts` walks when
    it rebuilds the mirror offline. A scope that drives dispatch directly is one
    on an SQO-filter edge.

!!! danger "A forward spec with no `observe` half is dead configuration"
    A `properties.observers` spec whose named observer carries **no** matching
    `observe` entry dispatches nothing, on either side. The engine reports every
    such edge **at every boot** and counts it
    (`observers_registry_contract_violations`). Four exist on this install —
    `rsc1139`, `rsc1140`, `rsc1401` and `rsc1403`, each naming `rsc19` — and
    they had been dead for this install's entire life without a single symptom.
    Fix the ontology: add the `observe` half on the observer, or delete the
    stale spec.

### Discovery: the subscription registry

Edges are discovered by a **subscription registry** built over the whole
ontology — every node carrying `observe` or `observers` — not by reading the
saved node alone. The registry is cached process-wide and invalidated
automatically after every ontology write (deferred to the write's commit), and
it is warmed at boot, so each deploy or restart re-validates the real ontology
and prints every violation it finds. Its state is also exposed operationally:
the `observers_registry` gauge and the `observers_*` counters on
`GET /api/v1/counters`.

!!! warning "Out-of-band ontology surgery needs a restart"
    Invalidation is wired to ontology writes **through the engine**. If you edit
    `dd_ontology` directly in the database, restart the server or the registry
    keeps serving the pre-edit picture.

### Edges derived from a copy law

Two kinds of edge are not declared at all. The first the registry **derives**
from a [copy law](#the-copy-law); the second from a portal's declared order
([below](#edges-derived-from-a-declared-order)). A copy reads a component on *another* record, so
when that component changes, the copy is stale — whether or not anyone thought
to declare the edge. For every node that follows the copy law, the registry
adds an edge from the copied component to the copy, whose targets are the
records whose pointer names the saved record.

Live case: `numisdata679` (*Coins* on a catalog term) declares that it
watches the term's own pointer, `numisdata656`, but not the type's
`numisdata77` it copies. Without the derived edge a term's *Coins* went stale
every time a coin was added to its type — term 2973 above holds two coins
while its type holds three. With it, linking a coin to a type updates
`numisdata77` on the type, and then `numisdata679` on every term catalogued
under it.

- Among the value laws, only the copy law derives edges. The inverse-reference
  law is already reached through its declared chain, and the text-tag law reads
  its own record, which its declared edge already covers. A portal's declared
  order derives edges of its own ([below](#edges-derived-from-a-declared-order)).
- **A declared edge always wins.** `numisdata965` declares its own edge from
  `numisdata11`, so nothing is derived for it. Any `observe` entry for the
  same component — a client-only one included — takes precedence; adding a
  client-only entry for the copied component is how you switch a derived edge
  off, and it is an ontology edit, not code.
- Derived edges take part in cycle detection like any other edge, and they are
  counted in the registry's diagnostics.

### Edges derived from a declared order

A portal whose `show.ddo_map` declares an `order` stores its locators sorted by
a value that lives in the **linked** records (see
[component_portal](../components/component_portal.md#the-order-model)). When
that value changes, no host is saved, so the registry derives the edges that
keep the order: for each declared ordering column it follows the column's full
order path — for a relation column, through every hop to the value it sorts
on — and adds one edge per hop, from the linked record back to the record that
links it (`use_inverse_relations` through the hop's own relation). Each edge is
a [relay](#what-is-computed-the-perform): it finds the records referencing the
saved one, re-saves the observer there through its own save rules (which
re-sorts the array) and relays on, until the portal hosts are reached.

- A declared or copy-law edge on the same key wins; two portals ordering
  through one relation share ONE edge.
- A column whose order path resolves to nothing derives no edge and is reported
  as unresolved: nothing can keep that order.
- When the portal's target sections are data-driven (`hierarchy_types`,
  `section_model`, `ontology_sections`, `field_value`), a write to those
  sections rebuilds the registry, so the derived edges follow the data.
- Their backstop is the `portal_declared_order` reconcile, not the observer
  reconcile script.

## What runs: targets × performs

Two orthogonal questions decide what a save does: **which records** an observer
recomputes on, and **what** is computed on each.

### Which records (target resolution)

For an info observer (and the relay and no-op shapes) the targets come from
`server.filter` and `use_observable_dato`:

| Targets | Declared as |
| --- | --- |
| The saved record | `server.filter: false`, no `perform` (only an info-model observer recomputes on it; anything else is a no-op — see the perform table) |
| Everything the just-saved data points at | `server.config.use_observable_dato: true` |
| Every record referencing the saved one | `server.filter` is an [SQO](../sqo.md) object: a search over the **host section** in which every clause's `q` becomes the saved record's locator, with `from_component_tipo` taken from the first clause's last path step |

For a `set_dato_external` edge one closed table decides, checked top to bottom:

| `server.config` | Targets |
| --- | --- |
| `use_observable_dato` and `use_self_section: true` | the saved record **plus** everything the saved data points at |
| `use_observable_dato` and `use_self_section: false` | everything the saved data points at (a `filter` beside it has no effect) |
| `use_inverse_relations: true` | every record that **references** the saved one — through the observer's pointer component when its law has one — one visit per record |
| anything else, no `config` at all included | the saved record |

The observable-data targets are the locators **in the payload the save door just
handed over**, not a re-read of the record — they are never found by searching a
section. Only the SQO-filter shape needs a host section.

Whichever row selects a record, an external mirror is only **created** on a
record whose section declares the observer — see
[a mirror lives only where it is declared](#a-mirror-lives-only-where-it-is-declared).

#### A save also visits what it stopped pointing at

Every save door reports two things: the value the component now holds, and the
locators the save **removed**. Both are targets. This matters because a record
you just unlinked still lists you in its mirror, and visiting it is the only
way that entry can go away at the moment you caused it — the recompute reads
current truth, so a record that turns out to be unaffected simply computes the
same value and writes nothing.

Removed locators participate in the external-mirror and relay branches. They
are deliberately **not** used by
[component_info](../components/component_info.md) observers: those select
their targets by searching for the *saved* record, so a removed locator is not
an input to that search at all.

#### An equivalence edge recomputes the whole class

When the saved component is one of the observer's own **equivalents** peers
(named in `source.data_from_field`), the save does not change one link — it
re-partitions an equivalence group, and multidirectional equivalence is
transitive. If A ≡ B and B ≡ C, then A ≡ C follows; break the B–C link and A's
group changes too, even though the save never mentions A.

So for these edges the targets are the whole equivalence group, computed
before and after: the group the saved record is in now, plus the group of each
record it was just unlinked from. This is needed in **both** directions —
merging two groups reaches the far members exactly as splitting one does. A
two-member group hides the distinction, which is why the gap went unnoticed:
with only A and B there is no third member to miss.

Edges without a `data_from_field` peer are unaffected and pay nothing extra.

!!! note "On a `set_dato_external` edge, `server.filter` is ignored"
    An external-mirror edge takes its targets from the observable data whatever
    the filter says. Only a
    [component_info](../components/component_info.md) observer (or a
    `component_state` / `component_calculation` alias) uses the filter to
    *select* targets. For every other observer the filter only picks a branch:
    `false` is the terminal no-op, absent-plus-`use_observable_dato` is the
    relay. One playground edge declares a filter **and** `set_dato_external` —
    `test199` (`component_portal`, section `test183`) observing `test188`, a
    `box elements` node, with `use_self_section: false` — and the filter has no
    effect there. Read it as a demonstration of the rule, not as authoring to
    copy. A filter next to the rows that *include the saved record* (the first
    and the last of the table) is refused and counted instead, because
    ignoring it there would silently narrow what the author asked for; no
    shipped edge has that shape.

### Host-section resolution

The host section is "whose records do I search / sweep". It is resolved in this
order:

1. the `observe` entry's own `section_tipo` — the authoring home for new edges.
   No shipped entry uses it yet; it is the fix when step 3 fails;
2. a forward spec's `section_tipo` — the reused-component targeting described
   above. The literal `"self"` names no foreign scope and falls through to
   step 3, which is what "self" means;
3. the observer's **own section** (its ontology ancestor), refined by the SQO
   filter path — see the virtual-section rule below;
4. unresolved → the recompute is **refused loudly**, naming the edge, and
   counted as `observers_host_section_unresolved`. Nothing reaches this on the
   current ontology.

Step 3 treats **virtual and real sections as equivalent**. A
[virtual section](../sections/section.md) names its real section in its first
relation, and stored records carry the *virtual* tipo — so when the filter path
names a virtual face of the observer's own real section, the **path's face
wins**. Live example: `numisdata1478` and `numisdata1479` (both
`component_info` — *Composition by period* / *Composition by Era*) observe
`numisdata1373` (`component_autocomplete_hi` — *Period*) through a filter path
naming section `numisdata5` (*Complex*), while their own ontology section is
`numisdata276` (*Location*). `numisdata5` is a virtual face of `numisdata276`,
so the two agree and the search runs against `numisdata5`, where the records
actually live. A path naming a **non**-equivalent section resolves to nothing —
the engine refuses rather than silently retargeting.

### What is computed (the perform)

| Perform | Declared as | Effect |
| --- | --- | --- |
| Info recompute | observer is a `component_info` (or a `component_state` / `component_calculation` alias) with **no** `perform` | Recomputes the widgets on each target and writes **one** `matrix_time_machine` row per target (lang `lg-nolan`). It deliberately never touches the live stored value — live reads compute. Targets equal to the saved record additionally ride the save response, so the open editing panel refreshes. |
| `set_dato_external` | `perform: {function: "set_dato_external"}`; the targets come from `config` (the table above) | Recomputes the observer's **external mirror** on each target — by the value law its `source` declares (below). |
| Relay | no `perform`, no `filter`, `config.use_observable_dato: true` or `config.use_inverse_relations: true`, observer is not an info model | A **trigger** that re-enters propagation so a dependency chain can continue. Per target it first re-saves the observer through its own save rules and writes only when they change the stored value — today only a portal declaring an `order` is re-sorted (one write and one Time Machine row). For every other observer it writes nothing at all: no value change, no Time Machine row, no modified stamps, and it does not even read the target. |
| Terminal no-op | `filter: false`, no `perform`, observer is not an info model | Nothing runs server-side; the client half is the whole point of the entry. |

Measured coverage of the 73 dispatchable edges on this install (re-measured
2026-10-30):

| Edges | Shape |
| ---: | --- |
| 33 | info / state / calculation recompute on the saved record (`filter: false`) |
| 27 | `set_dato_external` external-mirror recompute |
| 7 | info recompute through an SQO filter |
| 3 | terminal no-op (`filter: false` on a non-info observer) |
| 2 | relay |
| 1 | declared but **not covered** — `refresh_data`, see below |

On top of those, the engine derives **one** edge from a law rather than from a
declaration — see [edges derived from a copy law](#edges-derived-from-a-copy-law).

Seven of the 27 external edges were skipped until 2026-10-30, because the
engine only understood the `use_observable_dato` rows of the target table:

- the six **legend-symbol** mirrors carry no `config` block at all —
  `numisdata563`, `numisdata574`, `numisdata575`, `numisdata993`,
  `numisdata1227` and `numisdata1229`, all `component_autocomplete_hi`. They
  recompute on the saved record (the last row of the table), which is exactly
  right: each one derives from a text on its **own** record (see
  [the text-tag law](#the-text-tag-law));
- `numisdata965` (`component_portal` — *Ordered coins*) observing
  `numisdata11` (`component_portal` — *Ordered coins*) declares
  `use_inverse_relations`, which now resolves the records that point at the
  saved one.

!!! warning "One declared edge is skipped loudly, not run"
    `rsc1214` (`component_select`) observing `rsc1156` declares a well-formed
    target config **and** `perform: {"function": "refresh_data"}`. That
    perform is **not implemented** — a real, dated gap, stated rather than
    approximated. The engine names it as a known exemption in the log and
    counts it (`observers_server_shape_not_covered`); any other unknown
    `perform` is refused and counted the same way. The engine never calls a
    function just because the ontology names it.

## The value laws of `set_dato_external`

An **external mirror** is a relation component — a `component_portal` (or one of
its `component_autocomplete` aliases) with `properties.source.mode: "external"` —
whose stored value is *derived* from other data. `set_dato_external` is the
perform that recomputes it. **What** it derives depends on the node's
`properties.source`, and there are exactly three answers:

| `properties.source` declares | Law | The mirror is |
| --- | --- | --- |
| `component_to_search` | [inverse reference](#the-inverse-reference-law) | every record that points at this one |
| `source_overwrite.data_from_field` **and** `component_to_search` | [copy](#the-copy-law) | a copy of a component on the record this one points at |
| `set_observed_data` | [text tag](#the-text-tag-law) | the locators inside the tags of a text on the same record |

One classifier decides, once per node and per ontology version, and it is
closed: a node maps to exactly one law or it is **refused** — see
[ambiguous nodes are refused](#ambiguous-nodes-are-refused). No law ever falls
back to another.

### The inverse-reference law

> The observer's value becomes every record referencing the target record — **or
> any equivalent of the target** — through `source.component_to_search`, limited
> to `source.section_to_search`. Existing entries keep their stored order; new
> references are appended with the next item id. The search is uncapped and
> ordered by `section_tipo`, `section_id`.

The running example is **numisdata77** (`component_portal` — *Coins*, in section
`numisdata3`, *Type*): "which coins are of this type". Its
`properties.source`, display keys omitted:

```json
{
    "mode": "external",
    "data_from_field": ["numisdata36"],
    "section_to_search": ["numisdata4"],
    "component_to_search": ["numisdata161"]
}
```

`numisdata161` (`component_autocomplete` — *Type*) is the coin's link **to** a
type, in section `numisdata4` (*Numismatic object*). The mirror is the inverse of
that link, and it is stored as ordinary relation data — `relation` is singular
and keyed by component tipo, one locator per referencing record. Type record 16
on this install:

```json
{
    "relation": {
        "numisdata77": [
            {
                "id": 1,
                "type": "dd151",
                "section_id": 356,
                "section_tipo": "numisdata4",
                "from_component_tipo": "numisdata77"
            },
            {
                "id": 2,
                "type": "dd151",
                "section_id": 61153,
                "section_tipo": "numisdata4",
                "from_component_tipo": "numisdata77"
            }
        ]
    }
}
```

A mirror does not have to have equivalents. `hierarchy93` (`component_autocomplete`
— *Library*, in section `hierarchy20`) declares only `section_to_search`
`rsc205` and `component_to_search` `rsc387`: it lists the publications citing
the term, and nothing more.

### Equivalents — `source.data_from_field`

The inverse-reference search is seeded with **more** than the target record. For
each component tipo listed in `source.data_from_field`, the target's value in
that peer component — *plus* that peer's relation-type closure — joins the seed,
and every seed entry is re-stamped with `from_component_tipo =
component_to_search` so it matches the referencing component's locators.
Semantically:

> The mirror lists the records referencing this record **or any of its
> equivalents**.

A closure is computed **only when the peer is a
[`component_relation_related`](../components/component_relation_related.md)**. A
peer of any other relation model contributes its stored bag alone, whatever its
`relation_type_rel` says — that is a model-level rule, not a bug, and a peer of
the wrong model is the quiet way to end up with a short mirror. For a related
peer, how far the closure reaches depends on its
`config_relation.relation_type_rel`:

| `relation_type_rel` | Closure |
| --- | --- |
| `dd620` (unidirectional) | none — the stored bag only |
| `dd467` (bidirectional) | one inverse hop |
| `dd621` (multidirectional) | the **full symmetric transitive closure**, in both recursion directions |

`numisdata77`'s peer is `numisdata36`
([`component_relation_related`](../components/component_relation_related.md) —
*Equivalent terms*) with `relation_type_rel: dd621`. So a coin that references
*any* type in an equivalence group appears in the mirror of *every* type in that
group.

!!! info "The closure is the law — measured"
    Recomputing all 19,908 `numisdata3` records that hold a `numisdata77` mirror
    and comparing against the stored, migrated truth: seeding with the target
    alone loses **318,122** locators; adding the peer's stored bag (one hop)
    still loses **247,933**; the full `dd621` transitive closure is exact —
    19,885 of 19,908 records byte-identical, 13 locators residual. A one-hop
    implementation is not an approximation, it is wrong by a quarter of a
    million locators.

A declared peer whose ontology node is missing (a partial install) degrades the
seed to the stored bag — loudly, and counted as
`observers_seed_peer_node_missing`, never silently.

### `references_limit` is never honoured

!!! warning "`perform.params.references_limit` is inert on the write path — deliberately"
    Shipped configs declare it, mostly as `0` (the "no limit" sentinel), a few as
    `200`. Honouring a finite cap on a **write** path would persist a truncated
    mirror: a capped result set is indistinguishable from "these records stopped
    referencing you", and the merge removes by omission. Measured: `numisdata250`
    on record 162 of section `tchi1` stores 1,023 locators against its own
    declared limit of 200 — honouring the cap would destroy 823 of them at the
    next save on that record. The recompute always searches
    uncapped, and a finite non-zero limit is refused outright and counted as
    `observers_references_limit_refused`, never applied. The divergence is
    recorded in the wire-contract ledger under `engineering/wire_contract/`.

### The 2,000-reference freeze

A recompute whose search returns more than 2,000 referencing records computes
the diff for honest reporting but **refuses to persist it**, logged and counted
as `observers_big_result_refused` — a retained safeguard against very expensive
saves. It is reachable here: the widest real case holds 4,547 referencers.

The freeze belongs to the inverse-reference law only. A copy and a tag list
are bounded by their source, so the two laws below never freeze.

### The copy law

> The observer's value becomes a copy of component
> `source.source_overwrite.data_from_field` on the record named by the first
> qualifying locator of the observer's own pointer component,
> `source.component_to_search`.

The live case is the **catalog**. A catalog term carries **numisdata656**
(`component_autocomplete_hi` — *Term*), the type it is catalogued under; it is
what `tool_cataloging` saves when you drop a type onto a term. Two mirrors on
the same term copy that type's coins:

- **numisdata679** (`component_portal` — *Coins*) copies the type's
  `numisdata77` (*Coins*);
- **numisdata965** (`component_portal` — *Ordered coins*) copies the type's
  `numisdata11` (*Ordered coins*).

From `numisdata679`'s `properties.source`, display keys omitted:

```json
{
    "mode": "external",
    "source_overwrite": { "data_from_field": "numisdata77" },
    "section_to_search": ["numisdata4"],
    "component_to_search": ["numisdata656"]
}
```

Both mirrors are declared in section `numisdata651` (*Catalog*); the terms live
in its virtual faces `numisdata665` (*MIB catalog*), `numisdata691` (*Pere
Catalog*) and `numisdatacatalog1` (*Numisdata Catalog*), which all count as
hosts.

How a recompute resolves:

- **Which locator.** The first locator of the pointer, in stored order, whose
  section declares the copied component. A term whose first link is a period or
  a mint therefore still copies from the type that follows it. A malformed
  locator is skipped and counted (`observers_source_overwrite_pointer_malformed`).
- **Nothing to copy.** An empty pointer, no qualifying locator, or a pointed
  record that no longer exists → the mirror becomes **empty**. Unlinking a type
  from a term empties the term's *Coins*.
- **Cannot be answered.** The copied component has no ontology node, or the
  pointed section has no table → the additions apply, every drop is **withheld**
  and counted — the same rule as a [degraded seed](#removals-are-mirrored-and-the-one-case-where-they-are-not).
- **Order.** The copy keeps the **source's order** — *Ordered coins* is ordered
  on the type, and the term shows it in that order.

Term 2973 of `numisdata665` on this install, catalogued under type 17415, is a
copy that fell behind its source (see
[edges derived from a copy law](#edges-derived-from-a-copy-law) for why). The
term's stored `numisdata679`:

```json
[
    { "id": 1, "type": "dd151", "section_id": 134743, "section_tipo": "numisdata4", "from_component_tipo": "numisdata679" },
    { "id": 2, "type": "dd151", "section_id": 134744, "section_tipo": "numisdata4", "from_component_tipo": "numisdata679" }
]
```

The type's `numisdata77` holds three coins, `134743`, `181481`, `134744` in that
order. The next recompute of the term stores the three in the type's order;
coins already in the mirror keep their item ids and the new one takes the next
free id:

```json
[
    { "id": 1, "type": "dd151", "section_id": 134743, "section_tipo": "numisdata4", "from_component_tipo": "numisdata679" },
    { "id": 3, "type": "dd151", "section_id": 181481, "section_tipo": "numisdata4", "from_component_tipo": "numisdata679" },
    { "id": 2, "type": "dd151", "section_id": 134744, "section_tipo": "numisdata4", "from_component_tipo": "numisdata679" }
]
```

### The text-tag law

> The observer's value becomes the locators carried by the tags of a text
> component on the **same record** — the first `source.set_observed_data` entry
> names the text.

The live case is a coin **legend**. Record 4732 of section `numisdata41`
(*Legend*) stores its legend in **numisdata195** (`component_text_area` —
*Legend*), with two symbols placed as svg tags:

```json
{
    "string": {
        "numisdata195": [
            {
                "id": 1,
                "lang": "lg-nolan",
                "value": "<p>[svg-n-1--data:{'section_tipo':'sclat1','section_id':'86','component_tipo':'hierarchy95'}:data] / ROM[svg-n-2--data:{'section_tipo':'sclat1','section_id':'134','component_tipo':'hierarchy95'}:data]</p>"
            }
        ]
    }
}
```

**numisdata563** (`component_autocomplete_hi` — *Epigraphic legend*) lists
those symbols. Its `source` names the text and the function:

```json
{
    "mode": "external",
    "section_to_search": ["numisdata41"],
    "set_observed_data": [
        {
            "tipo": "numisdata195",
            "perform": { "function": "get_locators_of_tags", "params": { "ar_tags": ["svg"] } }
        }
    ]
}
```

and its stored value on that record is the two tag locators, in the order they
appear in the text:

```json
{
    "relation": {
        "numisdata563": [
            { "id": 1, "type": "dd151", "section_id": 86, "section_tipo": "sclat1", "component_tipo": "hierarchy95", "from_component_tipo": "numisdata563" },
            { "id": 2, "type": "dd151", "section_id": 134, "section_tipo": "sclat1", "component_tipo": "hierarchy95", "from_component_tipo": "numisdata563" }
        ]
    }
}
```

The rules:

- **Which tags.** `params.ar_mark_tag`, else `params.ar_tags`, else `["svg"]`.
  Allowed tag types: `svg`, `draw`, `geo`, `page`, `note`, `lang` — the tags
  whose payload is a locator. Anything else is refused. A tag whose payload is
  not a locator is skipped.
- **Which languages.** Every stored language of the text, in a fixed order:
  `lg-nolan`, then the installation's main data language, then the rest
  alphabetically. Within one text, **the order the tags appear in**. A locator
  already listed is not listed again. The result does not depend on who saved
  the text, or in which language they were working.
- **Deleted records.** A tag that points at a record that no longer exists
  adds nothing. Deleting a coin removes it from the legend's mirror, and it
  stays removed when the text is saved again, even though the tag is still in
  the text. A tag pointing at a section that has no table means the mirror
  cannot be answered (see below).
- **No function.** An entry with no `perform` copies the named component's
  value as it is — allowed only when that component stores locators. No shipped
  node uses it.
- **Cannot be answered.** The text's ontology node is missing, it stores the
  wrong kind of data, or a tag points at a section that has no table → drops withheld, counted
  `observers_observed_data_unanswerable`. An empty text simply gives an empty
  mirror.

All six legend-symbol mirrors on this install follow this law: `numisdata563`,
`numisdata574`, `numisdata575`, `numisdata993`, `numisdata1227` and
`numisdata1229`.

### One merge for every law

Whatever the law computes, the stored value is merged the same way:

- an entry is identified by `section_tipo` + `section_id`; one already stored
  **keeps its item id**, a new one takes the next id after the highest stored
  one — so a dataframe frame paired to an entry stays on it;
- `from_component_tipo` is always the observer; every other key of the computed
  locator is kept (the legend symbols keep their `component_tipo`); `section_id`
  is stored as an integer;
- a locator pointing at the record itself is dropped;
- order: the inverse-reference law keeps stored entries in place and appends
  new ones; the copy and text-tag laws store **their own** order;
- a recompute that changes nothing writes nothing — no Time Machine row, no
  modified stamp.

## Safety laws

All five are unconditional. None of them can be switched off.

### Removals are mirrored — and the one case where they are not

The recompute writes the **full law**: entries that no longer match are
dropped, new ones are appended. Removing a link updates every affected mirror
on the spot, the same way adding one does. The decision is membership-based,
not length-based, so a recompute that wants to drop one entry and add another
commits both.

There is no setting for this. Nothing a caller passes can grant or deny a
drop, which is deliberate: a switch that can mean "allow the deletion" is
always one mistake away from meaning it by accident.

Exactly one situation withholds the drop half — **a law that cannot be fully
answered**. For the inverse-reference law that is a degraded seed: if this
record's own equivalents could not be resolved (a peer named in
`data_from_field` has no ontology node, an entry there is not a tipo, or a
peer locator is malformed), the computed reference set is known to be
incomplete, so removing anything on the strength of it would be a guess. The
additions still apply; the drops are held, logged, and counted as
`observers_shrink_refused_degraded_seed`, and the outcome names the defect so
you know which ontology node to fix. Fix it, then re-run the reconcile script.
The copy and text-tag laws withhold drops the same way when the component they
read has no ontology node.

!!! note "This replaced a blanket rule"
    Between 2026-08-02 and 2026-08-06 the engine dropped **nothing**, ever,
    without an operator flag — a temporary guard from when the equivalents law
    was still incomplete and every drop was suspect. Once that law landed the
    guard became the problem: a mirror that can only grow is not a mirror, and
    a legitimate removal stayed visible in the public portal indefinitely.
    Retiring it corrected 1,673 stale references across 22 records on this
    install.

### Ambiguous nodes are refused

A node whose `properties.source` does not name exactly one law is refused
**before any read or write**, logged with the reason, and counted as
`observers_law_refused` (the older name `observers_unported_sublaw_refused` is
counted alongside it, so existing dashboards keep working). The refused shapes:

| `properties.source` | Why it is refused |
| --- | --- |
| both `set_observed_data` and `source_overwrite` | two laws, no way to pick one |
| `set_observed_data` or `source_overwrite` next to a top-level `data_from_field` | `data_from_field` belongs to the inverse-reference law — ambiguous |
| `source_overwrite` without `component_to_search` | the copy has no pointer; the inverse-reference law would be the wrong law |
| `source_overwrite.data_from_field` that is not a single tipo string | malformed |
| `set_observed_data` whose first entry names no tipo, an unknown `perform.function`, or tags outside the allowed list | malformed |

A node with no `source` object at all, or with no `component_to_search` and no
other law, is skipped the way it always was, counted as
`observers_component_to_search_missing`.

!!! danger "The refusal is load-bearing — never route around it"
    Running the wrong law on a mirror is not a small error. Before the copy law
    existed, the inverse-reference law run on `numisdata679` and
    `numisdata965` computed **zero** against stored mirrors of 1,077, 959 and
    766 entries — between them **131,806 locators across 4,688 records** on
    this install. A refused node keeps its stored value untouched. Fix the
    node's `source` so it names one law; do not delete keys until it "works".

### A mirror lives only where it is declared

An external mirror is only **created** on a record whose section declares the
observer — the observer is one of the section's own components, or its real
section's when the section is virtual. A target outside those sections is
skipped and counted as `observers_target_not_host`.

This matters most for the `use_observable_dato` rows of the target table,
whose targets are whatever the saved data points at. `hierarchy93`
(`component_autocomplete` — *Library*, in section `hierarchy20`) observes
`rsc387` (*Descriptors*), and the descriptors of a publication may point at
records of `numisdata6` or `tchi1`, neither of which has a *Library* field. A
mirror written there is never shown and never cleaned up with the record.

A record that **already** holds the observer's value outside a declaring
section — left by an earlier engine, an ontology move, or a Time Machine
restore — is skipped too: the value is not that section's, so it is never
grown, shrunk or healed, and a restored one stays as restored. The observer
reconcile counts such values per section and reports them as left untouched.
Measured on this install: `hierarchy93` on 45 `numisdata6` and 6 `tchi1`
records, `numisdata321` on 11 `tchi1` records. They were not repaired.

!!! warning "An observer declared in the wrong section is maintained nowhere"
    `numisdata321` is declared in sections `numisdata276` and `numisdata5`,
    but the records its observed component points at are in `tchi1`. Under
    this rule no new `numisdata321` value is created anywhere. The fix is in
    the ontology — declare the observer where its targets live.

### The bounded cascade

An observer the engine has just acted on is, from the graph's point of view,
itself a save — so **its** observers fire in turn, and a dependency chain
continues. Re-entry is bounded by a visited set shared across the whole
cascade (one dispatch per observer, per hop kind, per record, per propagation)
and a depth budget of **8** hops. A true cycle or a budget overrun is a loud,
counted refusal naming the full chain (`observers_cascade_cycle_refused`,
`observers_cascade_depth_exceeded`) — never a silent truncation, never a hang.
The same node reached along two different branches is a benign diamond,
deduplicated and counted as `observers_cascade_converged_skipped`. The real
graph on this install is depth 2 with zero cycles; the budget is a backstop.

Which branches emit a hop is not uniform, and the asymmetry is deliberate:

- a **`set_dato_external`** recompute emits one only when it actually persisted
  something — a refusal, a withheld shrink or a no-drift result ends the branch;
- a **relay** always emits one. Emitting the hop is the relay's purpose; the
  only other thing it may write is the re-sort of a declared-order portal;
- an **info recompute** always emits one, per target.

A hop into an observer that has no subscriptions of its own is a leaf and is
dropped before it is scheduled, so it never appears in the guard or the logs.

Cascade hops run **after the enclosing save commits**. Inside a transaction — a
CSV import row, for instance — the hop is queued on a commit-only lane that
fires on commit and is **discarded on rollback**, so a rolled-back save never
propagates.

### There is no configuration switch

The cascade is unconditional: **the ontology decides, not the deployment.**
Mirrors are stored data, so a deployment flag would let two installs with the
same ontology store different values. (A rollout flag existed briefly during the
rebuild and was removed the day the benchmark cleared it.)

Measured cost: one external-mirror hop p50 1.3 ms, p90 3.1 ms; the widest
records — mirrors up to 1,189 entries — p50 10.6 ms; the worst real case, 4,547
referencers, 22 ms. Cost *per entry* falls as fan-out grows (61.8 ms down to
5.2 ms per 100 entries), so the recompute is sub-linear in practice.

## Refreshing a mirror by hand

A `source.mode: "external"` portal shows an **update** button in its toolbar.
Pressing it asks the server to recompute that one mirror, on that one record,
from the data as it is committed now, and then shows the result. It is the
fix for a mirror you suspect is stale — for example a copy whose source
changed before the copy's edge existed.

- **Who may press it.** Anyone who can *read* the record and the portal
  (permission 1 or more). A mirror is derived data: its value is the same
  whoever asks, so recomputing it needs no edit permission. If you can edit
  the portal you see the button in the full toolbar; at permission 1 the
  toolbar of an external portal is reduced to this button.
- **What it writes.** Nothing, when the mirror is already right. When it was
  stale, the corrected value is saved like any recompute — with a Time Machine
  row naming **you** as the user who asked — and the mirror's own observers
  fire as after any save.
- **What it never does.** It never runs from a Time Machine view, and it only
  recomputes the portal you pressed it on.
- **When it cannot.** The data is always shown. If the recompute was not
  allowed or was held back, a notice says why: `observers.refresh_refused` (you
  cannot read the record or the portal) or `observers.refresh_withheld`, whose
  reason is one of `law_refused` (the node is
  [ambiguous](#ambiguous-nodes-are-refused)), `target_not_host`
  ([not a declaring section](#a-mirror-lives-only-where-it-is-declared)),
  `degraded_seed` (drops withheld and nothing added), `frozen` (the
  [2,000-reference freeze](#the-2000-reference-freeze)), `busy` or `error`.
  `busy` means another save was holding the record: the button waits at most
  3 seconds, then shows the stored data with this notice, and pressing it again
  later works. While a refresh is running, the button is disabled.

For an API client the request is an ordinary component `read` whose
`source.build_options` carries `get_data_external: true`; see the
[component_portal](../components/component_portal.md#source) page. The older
spelling `get_dato_external` is ignored.

## A real chain, end to end

The intent is documented in the ontology itself — `numisdata161`'s own forward
spec narrates it. Two hops, the deepest chain on this install:

1. **`numisdata161`** (`component_autocomplete` — a coin's *Type* link, in
   section `numisdata4`) saves.
2. **`numisdata36`** (`component_relation_related` — *Equivalent terms*, in
   section `numisdata3`) observes it as a **relay**: no `perform`, targets taken
   from the saved locators.

    ```json
    {
        "info": "Numismatic object update his type data. It's fired to save his data by numisdata161 because it's necesary update all equivalent types",
        "server": {
            "config": {
                "use_self_section": false,
                "use_observable_dato": true
            }
        },
        "component_tipo": "numisdata161"
    }
    ```

    The relay writes nothing (`numisdata36` declares no `order`). It exists so that step 3 fires for **every
    equivalent type**, not only the one the coin now points at.

3. **`numisdata77`** (the *Coins* mirror above) observes `numisdata36` with
   `perform: set_dato_external` and `use_self_section: true` — so each type in
   the equivalence group recomputes its own mirror.

The same three-stage shape exists for objects: `tch241` → `tch40`
(`component_relation_related`) → `tch33` (`component_portal`).

On a catalog the chain continues one hop further, through the
[derived edge](#edges-derived-from-a-copy-law):

4. **`numisdata679`** (*Coins* on each catalog term whose `numisdata656`
   names one of those types) copies the type's new `numisdata77`.

Cataloguing a term — `tool_cataloging` saving `numisdata656` — reaches the
same `numisdata679` and `numisdata965` directly, through their declared
edges: the term's pointer changed, so both copies are recomputed from the new
type.

## Why didn't my observer fire?

Work the list top-down.

1. **Is the edge declared where the engine looks?** The **observer's**
   `properties.observe` must contain an entry whose `component_tipo` is the
   observed tipo (or `"all"` plus a forward spec naming the observer), and that
   entry must carry a `server` **object**. `server: null`, a scalar, or a
   client-only entry never dispatches. Remember first-match: an earlier entry
   for the same tipo shadows a later one.
2. **Read the boot log.** Every restart validates the whole ontology and prints
   one `observer subscription contract violation: …` line per problem —
   forward-only dead specs, dead wildcards, unresolved host sections, malformed
   `server` values — each naming the exact edge and the fix.
3. **Is the shape covered?** A `server` block whose `perform` the engine does
   not implement is skipped with a `server shape not covered` log and counted
   (`observers_server_shape_not_covered`); the one live case is `refresh_data`,
   above. So is an SQO filter next to a target row that includes the saved
   record.
4. **Is the node's law clear?** An external mirror whose `source` names no
   law, or two, is refused before any write — see
   [ambiguous nodes are refused](#ambiguous-nodes-are-refused). The log line
   names the reason.
5. **Is the record in a section that declares the observer?** If not, nothing
   is created there (`observers_target_not_host`) — see
   [a mirror lives only where it is declared](#a-mirror-lives-only-where-it-is-declared).
6. **Check the counters.** `GET /api/v1/counters` carries the
   `observers_registry` gauge and the refusal counters. Configuration problems:
   `observers_registry_contract_violations`,
   `observers_host_section_unresolved`, `observers_component_to_search_missing`,
   `observers_law_refused`, `observers_server_shape_not_covered`,
   `observers_target_not_host`. Runtime refusals:
   `observers_shrink_refused_degraded_seed`, `observers_big_result_refused`,
   `observers_references_limit_refused`,
   `observers_observed_data_unanswerable`, the `observers_source_overwrite_*`
   family and the `observers_cascade_*` family. The update button:
   `observers_external_refresh_done`, `…_withheld`, `…_refused`, `…_failed`,
   `…_busy`.
   Volume signals: `observers_removed_targets_visited`,
   `observers_equivalence_class_wide`.
7. **Mirror short by thousands?** Look at the `data_from_field` peer: it must be
   a `component_relation_related` (no other model computes a closure at all),
   its `relation_type_rel` must be `dd621` for the full closure, and its
   ontology node must exist — a missing one degrades the seed to the stored bag
   and counts `observers_seed_peer_node_missing`.
8. **Edited the ontology out-of-band?** Restart the server; the registry only
   invalidates on writes made through the engine.
9. **A removal did not propagate?** It should have. Check whether the outcome
   was a degraded-seed refusal (`observers_shrink_refused_degraded_seed` — the
   log names the peer node to fix), and if the stale entry is on a record the
   save never mentioned, confirm the observer really declares the observed
   component in `source.data_from_field` — that is what makes a save an
   equivalence-group event rather than a single-link one.
10. **Auditing drift across the whole install?** `scripts/observer_reconcile.ts`
   is a census as well as a repair. `--json` emits one record per drifted
   mirror (`before`, `after`, `dropped`, `added`, plus any refusal and its
   defects) so drop volume can be reviewed by cause; `--budget` compares the
   run against `engineering/observer_shrink_budget.json` and exits non-zero if
   the install wants to delete more than the declared ceiling. Always run the
   census before `--apply`.
