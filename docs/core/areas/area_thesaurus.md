# area_thesaurus

> The back-office area that renders and edits the **hierarchical thesaurus
> trees** (taxonomies under the `hierarchy` TLD and project thesauri), and the
> host of the client tree widget.

> See also: [area](area.md) · [area_ontology](area_ontology.md) ·
> [TS tree (ts_object)](../ontology/ts_object.md) ·
> [Sections](../sections/index.md) · [Components](../components/index.md)

This page assumes you already know what an [area](area.md) is — a top-level menu
grouping that is an ontology node, owns no records of its own, and groups
sections. The tree machinery itself (node builder, mutations API, client widget)
is documented in [TS tree](../ontology/ts_object.md); this page covers only how
`area_thesaurus` *drives* that machinery.

## Role

`area_thesaurus` presents **every active thesaurus as an expandable tree** in one
screen. It resolves which hierarchies are active, groups them by typology,
supplies the root terms each tree starts from, and powers thesaurus search with
full ancestor-path resolution.

The tree rows themselves are *not* built here: each row is a section rendered as
a [`ts_object`](../ontology/ts_object.md) node, and every mutation (add child,
reparent, save order) belongs to that subsystem. `area_thesaurus` is the host.

In the area behavior taxonomy (`src/core/concepts/area.ts`) it carries the
`tree` behavior, which it shares with [area_ontology](area_ontology.md) — the
same area pointed at the ontology hierarchy instead. The two are **one
implementation**, selected by an argument.

## Where the engine lives

| module | what it does |
| --- | --- |
| `src/core/area/tree.ts` — `readAreaHierarchyData` | The boot payload: the active hierarchies, their root terms and children tipos, and the typology list. |
| `src/core/area/read.ts` — `readTreeArea` | The `tree` behavior branch: the per-hierarchy permission filter, the structure context (with the `section_tipo` override and the `thesaurus_mode` stamp), and the optional pre-executed search. |
| `src/core/ts_object/search.ts` — `searchThesaurus`, `getHierarchyTermsSqo` | Search with path resolution, and the SQO that scopes a search to chosen hierarchy terms. |
| `src/core/ts_object/` | The tree rows themselves — node assembly, expand, move, add, order. Shared with the ontology area. |

## Responsibilities

- **Active-hierarchy resolution** — determine which hierarchies are live, skip
  those that are not `active_in_thesaurus`, or have no typology, no root terms or
  no `children_tipo`.
- **Typology grouping** — resolve each hierarchy's typology id, label and order
  so the client can group the trees under collapsible typology blocks.
- **Root-term supply** — provide the root-term locators each tree starts from,
  and the `children_tipo` the client needs to expand each root.
- **Permission filtering** — drop every hierarchy the reader may not read, and
  every root term whose section they may not read.
- **Thesaurus search with path resolution** — run an SQO and, for every hit, walk
  its ancestors and emit the tree data for the whole branch, so the client can
  rebuild and highlight the path to each result.

It persists nothing: like every area it holds no records.

## The storage model it reads

A thesaurus is a hierarchy of section records linked by parent/child locators.
The **child** stores the parent reference in its `relation` column under the
`component_relation_parent` tipo (`dd47`); children are always *computed* by
searching who points at a parent (`component_relation_children`).
`area_thesaurus` only reads this graph — to find root terms, to iterate children
when building search paths, and to walk ancestors. The authoritative description
lives in [TS tree](../ontology/ts_object.md) and the
[`component_relation_parent`](../components/component_relation_parent.md) /
[`component_relation_children`](../components/component_relation_children.md)
references.

## The boot payload

`readAreaHierarchyData(model, areaTipo, lang, termsAreModel)` turns each active
hierarchy element into one tree root group. The fields it stamps:

| field | meaning |
| --- | --- |
| `section_id`, `section_tipo` | the hierarchy *definition* record (in `hierarchy1`, or `ontology35` for the ontology area) |
| `target_section_tipo` | the section whose records *are* the tree terms |
| `target_section_name` | the hierarchy element's name |
| `children_tipo` | the `component_relation_children` tipo the client uses to expand a node |
| `typology_section_id` | the typology this hierarchy belongs to |
| `order` | the hierarchy's order |
| `type` | always `'hierarchy'` |
| `active_in_thesaurus` | the element's thesaurus-active flag |
| `root_terms` | the root-term locators the tree starts from |

`readTreeArea` then wraps it: it filters the hierarchies by read permission,
rebuilds the typology list from the survivors, builds the structure context, and
attaches `ts_search` when a search was requested.

### What the client receives

```json
{
    "tipo": "dd100",
    "value": [
        {
            "section_id": 1,
            "section_tipo": "hierarchy1",
            "target_section_tipo": "es1",
            "target_section_name": "Onomastic places (Spain)",
            "children_tipo": "hierarchy49",
            "typology_section_id": 7,
            "order": 3,
            "type": "hierarchy",
            "active_in_thesaurus": true,
            "root_terms": [ { "section_tipo": "es1", "section_id": 1 } ]
        }
    ],
    "typologies": [
        { "section_id": 7, "type": "typology", "label": "Geographic", "order": 3 }
    ],
    "ts_search": { "result": [], "found": [], "total": 0 }
}
```

`ts_search` is present only when a search — or the area's pinned
`properties.hierarchy_terms` — was requested.

!!! note "Illustrative tipos"
    The `tipo` / `section_tipo` / `children_tipo` values above are examples; the
    real values are installation-specific ontology tipos. The *structure* — field
    names and nesting — is the contract.

## The context: two stamps the client needs

`readTreeArea` builds the area's structure context and then stamps two things
onto it:

- `section_tipo` is set to the **area tipo**, so the search panel can store
  per-area presets against it;
- `thesaurus_mode` says whether this read is an ordinary browse (`default`) or a
  term **picker** (`relation`). It is **derived by the server** — see below.

### `thesaurus_mode` is server-derived, not requested

The mode is never taken from the request. A read that names no caller is a browse
and is stamped from the area node's own `properties.thesaurus_mode` (defaulting to
`default`), which is the **install default** for that area page. A read that names a
caller is stamped with the mode the server derived from that caller, and the area
property does not enter into it: a picker request cannot be handed a mode its caller
did not earn.

!!! warning "A mode the client declares is a mode anyone can declare"
    Accepting `thesaurus_mode` from the request would let any read open relation mode
    over any thesaurus, with no component that ever asked to pick terms. The request
    names an address (the caller) that the server re-resolves; it never names a
    conclusion the server adopts.

## The term picker (relation mode)

A relation component whose ontology declares `properties.view: "tree"` opens its
target thesaurus as a **picker**: the same tree read, rendering a link affordance per
term instead of navigating to it. The picker is not a second area — it is this read,
with a caller.

**The request declares the caller.** `source.caller` carries
`{section_tipo, section_id, tipo}` — the record and component the picked terms will be
linked into. A malformed caller, a caller naming an element the ontology does not
define, and a caller whose section holds no records are each refused with their own
named `400`.

**The server derives the rest**, and grants relation mode only when all three hold:
the caller's resolved view is `tree`, its model stores relations, and the user has
edit permission on it. Otherwise the read proceeds in `default` mode.

In relation mode the response carries three extra facts, all absent from a browse read:

| Field | Where | What |
| --- | --- | --- |
| `thesaurus_mode` | `context[0]` | `"relation"` |
| `picker` | `context[0]` | `{selection_limit, remaining, targets}` — the caller's cap and the sections it may link into |
| `root_terms_selectable` | each hierarchy item in `data[0].value` | `[{section_tipo, section_id, selectable}]`, one entry per root term |

- **`selection_limit`** is the caller's `data_limit`: `null` means uncapped, and a
  literal `0` means nothing may be linked.
- **`remaining`** is that limit minus the locators the caller already holds. It — not
  the limit — is what one picker session may add: a component with `data_limit: 2`
  already holding one term accepts exactly one more pick. When it reaches `0` the tree
  still browses, and says why, instead of offering a link that would be refused.
- **`targets`** narrows the hierarchies the read returns to the caller's own target
  sections (virtual and real sections are matched against each other, so a virtual
  target still finds its hierarchy).
- **`selectable`** is the **term's own** answer, the same flag the indexation tool has
  always used: a term is linkable when the thesaurus says so, term by term. A term that
  is not selectable stays visible and navigable — those are the levels one passes
  through to reach a leaf — and simply carries no link affordance.

### Where a row's `selectable` comes from

A picker does not only paint trees. A search result, a section list opened as a picker
(the indexation tool browses people that way) and a tree node are all rows that need the
same answer, and the client reads it from whichever of **three** server channels
answers — it never computes one:

| Channel | Carried by | Answers for |
| --- | --- | --- |
| `root_terms_selectable` | the area read, keyed by locator | root terms of each hierarchy |
| `is_indexable` | each tree node, and each section-list envelope entry | any record whose section **declares** the `is_indexable` role |
| `selectability_declared: false` | each section-list envelope entry | every record of a section that declares **no** such role |

The third channel exists because silence is not an answer. A section with no
`is_indexable` role has no per-term contract, and saving a pick into it is already
exempt from that check — so its rows must be pickable. While the read said nothing at
all for those rows, the client could not tell "no contract" from "nobody answered" and
withheld the affordance from records the save would have accepted.

The two envelope keys are mutually exclusive: a section that declares the role answers
per row with `is_indexable` and never sends the exemption. Only a **declaring** section
that fails to answer for a row leaves the row genuinely unknown, and an unknown row gets
no affordance — an affordance is never offered on a guess, and never withheld on one.

See `is_indexable` in the section map documentation for what declaring the role costs:
[The `is_indexable` contract](../ontology/section_map.md#the-is_indexable-contract-declared-or-absent).

The picker is a **writer's** tool, and it is scoped to the writer. The picker names the
chain of components it is nested under (`source.callers`, see
[the RQO source fields](../rqo.md#source-object-mandatory)); when the server verifies that
chain, the component at its end holds **write** through it, and its effective config
targets the thesaurus exactly, the picker browses that thesaurus **read-only even when the
user holds no grant on it** — the same rule an autocomplete search follows. Every node it
builds is still gated by its own section, and the scope opens only the thesaurus the
component's config names
(writer-chain scoped search: `engineering/wire_contract/WC-2026-11-04-writer-chain-scoped-search.md`).

Two empty pickers are two different facts, and the read distinguishes them: everything
refused by permissions — a picker without a verified writer chain on a thesaurus the user
may not read, among others — answers `403` with a message that names nothing (naming what
you may not see is itself a leak), while a target that declares no active hierarchy — or
none among this caller's targets — answers `409 read: no active hierarchy is configured
for this component target`, which is a configuration problem, not a permission one.

!!! note "The affordance is not the authorization"
    The same cap and the same target set are resolved again when the pick is saved, by
    the same module. What the tree offers and what the save accepts are literally the
    same value, so a stale or altered client cap changes nothing. A pick the save
    refuses — a term outside the caller's targets, a non-selectable term, one past the
    cap — is answered as a named error (`relation.insert_refused`, HTTP 400); a refused
    pick is never a silent no-op. The save is authorized by the component's own **write**
    grant: it does not re-check the user's grant on the thesaurus, because picking a
    value into a component you may write is exactly what the scoped picker read offers
    (tree-picker read gate retired: `engineering/wire_contract/WC-2026-11-04-tree-picker-read-gate-retired.md`).

!!! warning "The context must never be empty"
    An area read that returns an empty `context` makes the client render the area
    **blank**. Every area read returns a non-empty context; the tree client guards
    on it explicitly.

## Search with path resolution

`searchThesaurus(sqo, principal)` (`src/core/ts_object/search.ts`) does three
things:

1. **Sanitizes** the untrusted client SQO and builds the SQL through the shared
   search chokepoint, so the principal's project filter and permissions apply.
2. For every hit, **walks its ancestors** (`getParentsRecursive`,
   `src/core/relations/parent.ts`), memoized per call, and reverses the chain so
   the root comes first.
3. For every node on every path, **builds the tree data** for the whole branch —
   root, each ancestor, and that ancestor's children — batch-resolving the
   children's indexable flag with one query for the whole child set rather than
   one per child. Nodes are keyed by `section_tipo:section_id`, so a branch shared
   by two hits is emitted once.

It returns `{ result, msg, errors, total, found }`: `found` is the raw hit
locators, `result` is the tree data covering every branch that leads to one.

`getHierarchyTermsSqo(hierarchyTerms)` builds the SQO that scopes a search to a
chosen set of `{section_tipo, section_id}` terms — used to seed a search from the
area's pinned `properties.hierarchy_terms`.

A search reaches the area two ways: the client sends
`source.search_action = 'search'` together with an `rqo.sqo`, or the area node
carries `properties.hierarchy_terms`. Either way the request-specific values are
never baked into the shared structure-context cache.

Before the search runs, the area confines it (`confineTreeSearch`,
`src/core/area/read.ts`): every section named in `sqo.section_tipo` must be one
the user can read — or, for a tree picker, one its writer-chain scope targets.
A section that fails is dropped from the search; a search left with no section
at all is refused with `perm.denied` (403).

## How it fits with the rest of Dédalo

- **[TS tree (`ts_object` / `dd_ts_api`)](../ontology/ts_object.md)** — the area is
  the *host*; every tree row is a `ts_object`. The area supplies roots and search
  paths; expand/collapse, children resolution, term rendering and all mutations
  live in the tree subsystem. Build a `ts_object` from a node; never reimplement
  node rendering here.
- **[area_ontology](area_ontology.md)** — the same area in ontology mode.
- **[hierarchy](../ontology/hierarchy.md)** — the active-element registry and the
  root-term / main-order source.
- **[area](area.md)** — the area family reference: behavior taxonomy, menu walk,
  write refusal.
- **[Sections](../sections/index.md)** — each tree term is a record of a section.
- **[Components](../components/index.md)** — the tree leans on
  [`component_relation_parent`](../components/component_relation_parent.md) and
  [`component_relation_children`](../components/component_relation_children.md)
  for its edges, [`component_select`](../components/component_select.md) for the
  typology, and the text components for labels.
- **[Search (SQO)](../sqo.md)** — the query format `searchThesaurus` consumes.

## Related

- [TS tree (ts_object)](../ontology/ts_object.md) — the node builder, the
  mutations API and the client tree widget the area hosts.
- [area](area.md) — the area reference.
- [area_ontology](area_ontology.md) — the same machinery in ontology mode.
- [hierarchy](../ontology/hierarchy.md) — active elements, root terms, main order.
- [component_relation_parent](../components/component_relation_parent.md) ·
  [component_relation_children](../components/component_relation_children.md) —
  the parent/child edges of the tree.
- [Sections](../sections/index.md) — the records that are the tree terms.
- [SQO](../sqo.md) — the query format used by thesaurus search.
- [Architecture overview](../architecture_overview.md) — areas → sections →
  components → data.
