# component_relation_index

## Overview

```json
{
    "could_be_translatable" : false,
    "is_literal"            : false,
    "is_related"            : true,
    "is_media"              : false,
    "modes"                 : ["edit","list","tm","search"],
    "default_tools"         : [
        "tool_propagate_component_data",
        "tool_time_machine"
    ],
    "render_views" : [
        {
            "view" : "default | line",
            "mode" : "edit | list"
        },
        {
            "view" : "content | indexation | mini | mosaic | tree",
            "mode" : "edit"
        },
        {
            "view" : "text",
            "mode" : "list"
        }
    ],
    "data"        : "array of locators (computed inverse references, saved for easy search)",
    "sample_data" : [
        {
            "type"                    : "dd96",
            "section_tipo"            : "rsc170",
            "section_id"              : 1,
            "from_component_top_tipo" : "rsc1054"
        },
        {
            "type"                    : "dd96",
            "section_tipo"            : "rsc420",
            "section_id"              : 48,
            "from_component_top_tipo" : "rsc909"
        }
    ],
    "value"        : "array of strings",
    "sample_value" : ["Pottery survey 2019", "Restoration log #48"]
}
```

!!! note "Typology"
    `component_relation_index` is a **related** component: it stores its value as an array of [locator](../locator.md) objects, not as literal data. Unlike a normal related component, its data is **inverse and computed** — it resolves the records that point **at** the current record through an *indexation* relation, rather than the outgoing links the record itself authored. Its client model is an **alias of [component_portal](component_portal.md)** (`export const component_relation_index = component_portal`), so it reuses the whole portal render/view layer; the difference lives entirely in the server-side resolver.

!!! info "TS server implementation"
    The descriptor `src/core/components/component_relation_index/descriptor.ts` registers `resolveData: 'relation_index'` (`src/core/relations/models/relation_index.ts`). In `list`/`tm` cells it resolves one page of dd96 inverse locators via `findInverseReferenceLocators` / `countInverseReferences` (`src/core/search/search_related.ts`) and, on the first page of a request, attaches each pointing section's `related_list` children: a relation child that declares its own `request_config` expands its own show in `related_list` mode (the relation_list's mode governs it; no `section_list` swap happens), while a config-less (v5) relation child or a literal stays a one-level `list` cell — a pinned per-request state-bleed quirk (`relationIndexSolvedSections`) that reproduces a shared-instance re-parenting behaviour. Other modes fall through to the shared portal engine. Search is implemented as its own dedicated computed-inverse builder — see below and the *dedalo-relations-ts* skill.

!!! info "About `default_tools`"
    The list above is what the sample model carries in `context.tools` (verified in `samples/context.json`): `tool_propagate_component_data` and `tool_time_machine`. The component is non-translatable, so the language tooling that translatable components receive does not apply. The toolbar is assembled from the model + ontology; it is not hardcoded in the descriptor.

## Definition

`component_relation_index` displays **indexation backlinks**: the list of other records, in other sections, that index (cite) the current record through a relation of type `DEDALO_RELATION_TYPE_INDEX_TIPO` (`dd96`). It answers the question *"who indexes me?"* — typically *"which catalogue records have tagged this thesaurus term?"*.

**Why it exists.** Indexation in Dédalo is authored on the **citing** side: a [component_text_area](component_text_area.md) transcription, or a relation component, writes a `dd96` locator pointing at a thesaurus term (or any indexed record). The indexed record itself stores nothing about who cited it. `component_relation_index` reconstructs that inverse direction dynamically, resolving *"find every record that index-links to ME"*, so the backlink panel is always correct and never drifts from the authoritative outgoing indexation. Because recomputing the whole relation graph on every search is expensive, the resolved values are also **saved to the matrix data column** to enable "Easy Search" (the `*` / `!*` operators) without re-walking the graph.

**When to use it.**

- On a **thesaurus / authority term** (a place, a person, a subject heading): show every *Activity*, *Audiovisual*, *Cultural item* record that has indexed this term. This is the canonical use — a "referenced by" / "appears in" panel on a controlled-vocabulary record.
- On any record that is the **target** of indexation tagging and where the cataloguer needs to see the citing records read-back, grouped by the section that cites it.
- As a **search facet**: filter a thesaurus section to terms that are cited somewhere (`*`, *Not Empty*) or orphan terms that nobody cites (`!*`, *Is Empty*).

**When not to use it.**

- To author an **outgoing** link from this record to another -> use [component_portal](component_portal.md) (generic link `dd151`), [component_select](component_select.md) / [component_check_box](component_check_box.md) (closed list) or [component_relation_related](component_relation_related.md) (`dd89`).
- To show generic backlinks of **any** relation type (not just indexation `dd96`) as a read-only info field -> use [component_inverse](component_inverse.md), which is an *info* component and never stores anything.
- To navigate the thesaurus parent/child tree -> use [component_relation_parent](component_relation_parent.md) / [component_relation_children](component_relation_children.md).

!!! note "relation_index vs. inverse"
    Both resolve "who points at me?". [component_inverse](component_inverse.md) is a literal **info** component: read-only, computed live, never persisted, any relation type. `component_relation_index` is a **related** component: it is scoped to the indexation relation type (`dd96`), it can be grouped and paginated per citing section, and its resolved value is **saved to the database** so it is searchable. Use `component_relation_index` for thesaurus indexation panels; use `component_inverse` for a lightweight generic backlink count/list.

## Data model

**Data:** `array of locators`. Each entry is an inverse [locator](../locator.md) describing one record that indexes the current one.

**Value:** `array` of `strings`, or `null` — resolved from each citing record/section, not stored as literal text.

**Storage shape.** A component never touches the database; it reads and writes through its section, which stores component data in its matrix `data` column. Because the value of `component_relation_index` is **external/computed**, a stored array is never trusted as the source of truth: resolution builds a *filter locator* `{type: dd96, section_tipo, section_id}` for the current record, resolves every inverse reference via `findInverseReferenceLocators()` (`src/core/search/search_related.ts`), and maps each raw inverse row into a locator. The resolved value is still persisted to the matrix column so the easy-search operators can run without recomputation.

The persisted / transmitted shape is an array of locator objects. The relation `type` is the indexation type `dd96`; `section_tipo` / `section_id` point at the **citing** record; `from_component_top_tipo` names the component on the citing side that authored the indexation:

```json
[
    {
        "type"                    : "dd96",
        "section_tipo"            : "rsc170",
        "section_id"              : 1,
        "from_component_top_tipo" : "rsc1054"
    },
    {
        "type"                    : "dd96",
        "section_tipo"            : "rsc170",
        "section_id"              : 33,
        "from_component_top_tipo" : "rsc1054"
    },
    {
        "type"                    : "dd96",
        "section_tipo"            : "rsc420",
        "section_id"              : 48,
        "from_component_top_tipo" : "rsc909"
    }
]
```

Each resolved locator also carries, when present, `component_tipo` / `tag_id` (the exact tag inside a transcription that produced the index), and `section_top_id` / `section_top_tipo` (the top record of a hierarchical citing section). `from_component_top_tipo` is the component that owns the indexation on the citing side.

!!! note "Datum vs. API `entries`"
    The transmitted unit is a `{context, data}` datum. In the API payload the locator array is surfaced under `data.entries`, accompanied by `parent_tipo`, `parent_section_id` and a `pagination` block (`total`, `limit`, `offset`) — indexation backlinks are paginated because a single popular thesaurus term can be cited by thousands of records. `context` carries the description (`tipo`, `model`, `mode`, `lang`, `label`, `properties`, `permissions`, `tools`, `view`, the per-citing-section sub-contexts and `request_config`) and never the values. See the *dedalo-context-data-layers* skill for the full layering rules.

## Ontology instantiation

A `component_relation_index` is created as an ontology node whose `model` is `component_relation_index`. Its `parent` is the section (or grouper) it belongs to, and its `section_tipo` wires it into the section whose backlinks it will display. It is **non-translatable**, so its language slot is `lg-nolan`.

Node definition (shape):

```json
{
    "tipo"         : "actv25",
    "model"        : "component_relation_index",
    "parent"       : "actv1",
    "section_tipo" : "actv1",
    "lg-eng"       : "Indexations",
    "lg-spa"       : "Indexaciones",
    "translatable" : false,
    "properties"   : { }
}
```

Realistic `properties` block. The defining option is `source.mode`, which marks the component as resolving external (computed) data. With no `request_config` of its own the component falls back to *all* sections that index the record; a `source.request_config` can restrict it to specific target sections and supply the `ddo_map` used to resolve sub-columns:

```json
{
    "source": {
        "mode": "external"
    },
    "css": {
        ".wrapper_component": { "grid-column": "span 5" }
    }
}
```

`section_tipo` / `parent` tell the section which column owns this component. Because the value is computed, the read is paginated, and on the first page (offset 0) the server discovers every citing section, resolves one sample record per section and merges their contexts/sub-contexts into the component context — this is how a single relation-index field can render columns drawn from many different citing sections without a hand-authored `request_config` for each combination.

## Properties & options

All properties are optional and live in the ontology node `properties` JSON. Verified names consumed by this component (most relation behaviour comes from the shared relations engine, `src/core/relations/`):

### source.mode

- **Values:** `"external"` (the indexation backlink use), or the generic relation source modes (`autocomplete`, etc.). Default behaviour when absent: the component computes inverse references over **all** citing sections.
- **Effect:** declares that the component's data is resolved from *other* sections rather than owned locally. The sample model ships `{"source": {"mode": "external"}}`. In `external` mode the value is computed by resolving inverse `dd96` locators; the locally stored array is a search-acceleration cache, not the authority.

### source.request_config

- **Values:** an array of request-config (RQO) objects, each with `sqo`, `show.ddo_map`, `sqo_config`, etc.
- **Effect:** restricts which citing **sections** are displayed and supplies the `ddo_map` (target columns) used to resolve the sub-values per backlink. When present, the subdatum is built from it and the target section tipos are read from `source.request_config.sqo.section_tipo`. When absent, the component discovers the citing sections dynamically and targets them all.

### css

- **Values:** an object of CSS rule blocks keyed by selector (e.g. `".wrapper_component"`).
- **Effect:** style stamped on the component wrapper, exactly as for any component (e.g. `{"grid-column": "span 5"}` in the sample model). Not specific to this component.

!!! note "Relation-type configuration"
    Like every related component, `component_relation_index` resolves its relation type on instantiation from `properties.config_relation.relation_type` (and `relation_type_rel`). It is rarely set in the ontology for this component because the model default `DEDALO_RELATION_TYPE_INDEX_TIPO` (`dd96`) is the whole point — overriding it would change which relations are treated as "indexation". Verify any non-default value in the ontology.

!!! note "Standard context blocks"
    The generic ontology context blocks (`request_config`, `view`, `permissions`, `tools`) are carried into the datum `context` like for any component. They are not component-specific options. Any other custom key seen in production should be verified in the ontology.

## Render views & modes

Because the client model is an alias of [component_portal](component_portal.md), the available views and modes are the **portal** ones, served by the portal render files (`render_edit_component_portal.js`, `render_list_component_portal.js`, `render_search_component_portal.js`). The sample model defaults to `view: "line"` with `children_view: "text"`.

| View | edit | list / tm | Notes |
| --- | :---: | :---: | --- |
| `default` | yes | yes | Standard presentation: wrapper with label, buttons, `content_data` and one `content_value` per backlink, resolving each citing record's columns from the merged sub-context. |
| `line` | yes | yes | Compact single-line display (the sample model's default `view`). |
| `mini` | yes | — | Minimal view for tight space / service autocomplete. |
| `content` | yes | — | Content-oriented presentation of the linked records. |
| `mosaic` | yes | — | Grid-based layout for visual targets. |
| `tree` | yes | — | Tree presentation (useful when the citing/target section is hierarchical). |
| `indexation` | yes | — | Specialised view for displaying thesaurus indexation data. |
| `text` | — | yes | Plain textual rendering of the resolved value. |

Modes:

- **edit** — renders the live, paginated indexation backlink list. At offset 0 the server assembles the per-citing-section context; further pages reuse it. The data is computed, so "editing" is effectively read-back of the resolved relations.
- **list / tm** — read-only listing; `tm` (Time Machine) reuses the list render. Note the resolved value **is** persisted, so Time Machine can show prior indexation snapshots, unlike the never-stored [component_inverse](component_inverse.md).
- **search** — exposes the easy-search operators (see *Import / export model* and *Notes*); no per-record filter input beyond the operator dropdown.

DOM follows the standard portal structure: `wrapper_component component_relation_index <tipo> <mode>` -> `label`, `buttons_container`, `content_data` -> one or more `content_value`.

## Import / export model

**Import.** `component_relation_index` data is **computed**, not authored, so there is normally nothing to import here. To populate indexation backlinks, import the indexation on the **citing** side (the [component_text_area](component_text_area.md) tag, [component_portal](component_portal.md) or relation component that writes the `dd96` locator), not on this component. The persisted value is a search-acceleration cache that is rebuilt from the relation graph. See [importing data](../importing_data.md#related-data).

**Export.** Export runs through the shared relation export path (the export atoms path, `src/diffusion/export/atoms.ts`) and follows the atoms contract — one atom per backlink locator. Because this component has **no `request_config` of its own**, its export columns are computed per locator instead of being read from a configured `ddo_map`: the `ddo_map` is taken from the *pointed* (citing) section's `relation_list` request config, prefixed with a synthetic `component_section_id` ddo so the target `section_id` becomes the leading export column, and the remaining columns are then resolved from that section. See [exporting data](../exporting_data.md).

**Search.** Only two operators are supported:

| Operator | Meaning | SQL produced |
| --- | --- | --- |
| `*` | Not empty — record **is** indexed by someone | `<alias>.section_id IN (<referenced ids>)` |
| `!*` | Empty — record is **not** indexed by anyone (orphan) | `<alias>.section_id NOT IN (<referenced ids>)` |

The referenced ids are the `section_id`s of every record in this section that some other record indexes; they are resolved once per query. Edge cases: if no references exist at all, `*` resolves to `1=0` (matches nothing) and `!*` to `1=1` (matches everything).

!!! note "Search implementation"
    `src/core/search/builders/builder_relation_index.ts` implements the computed-inverse search: only `*` (indexed) and `!*` (orphan) resolve to a clause; any other operator is dropped, matching the table above. The referenced-id list comes from `findInverseReferenceLocators()` (`src/core/search/search_related.ts`) and is interpolated as literal integers; an empty reference set resolves `*` to `1=0` (matches nothing) and `!*` to `1=1` (matches everything). There is no Time Machine twin for this search — the matrix time-machine table has no `relation` column to scan, so a Time Machine search against this model throws loudly rather than searching the wrong data.

## Notes

- **Computed, then persisted.** Reads never trust a stored array as the source of truth — they resolve inverse `dd96` locators live via `findInverseReferenceLocators()` (`src/core/search/search_related.ts`). The resolved value is also saved to the matrix column specifically to power the `*` / `!*` easy-search operators.
- **Dynamic context assembly.** A relation-index field can be cited by many heterogeneous sections, so it cannot carry a hand-authored `request_config` for every combination. Instead, the citing sections are counted grouped by `section_tipo`, one sample record is fetched per section, and their contexts/sub-contexts are built and merged, each ddo re-parented to this component's `tipo` so the client can resolve subdata. This runs only on the first page (`offset === 0`).
- **Pagination is mandatory.** Totals are counted (overall and grouped by `section_tipo`) and the read paginates, because a popular term can have thousands of citing records.
- **Relation type.** Fixed to `DEDALO_RELATION_TYPE_INDEX_TIPO` (`dd96`) via the descriptor's `defaultRelationType`. Duplicate detection on add uses the key (`section_tipo`, `section_id`, `type`, `from_component_tipo`, `component_tipo`, `tag_id`).
- **Observers / observables.** None ship for this component; as a derived view it re-resolves whenever the host record reloads.
- **Default tools.** The sample model exposes `tool_propagate_component_data` and `tool_time_machine`. Tools are read-only context, assembled from model + ontology.
- **Permissions.** Resolved by the permissions engine (`getPermissions()`, `src/core/security/permissions.ts`; 0 none / 1 read / 2 read+write / 3 admin). Data is emitted only for `permissions > 0`.
- **Related components:** [component_inverse](component_inverse.md) (generic, never-stored backlinks), [component_portal](component_portal.md) (the outgoing link and the client model this aliases), [component_select](component_select.md), [component_check_box](component_check_box.md), [component_text_area](component_text_area.md) (authors `dd96` indexation tags), [component_dataframe](component_dataframe.md).
