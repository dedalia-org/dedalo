# component_dataframe

> **Canonical contract (id_key cutover, 2026-06).** A frame pairs to **exactly one data item** of a "main" component via that item's stable server-minted `id`, stored on the frame locator as **`id_key`**, with the positive marker **`type = 'dd490'`** (`DATAFRAME_RELATION_TYPE` / JS `DATAFRAME_TYPE`). Frames live in the **same section record** as the main component, in the `relation` JSONB column under the dataframe component's tipo.
>
> **`id_key` is the single pairing key.** The legacy pair `section_id_key` / `section_tipo_key` has been removed from all live dataframe code. It survives ONLY at two edges: the **old-CSV import** (which accepts a pre-v7 `section_id_key` as the `id_key` source, then strips it) and the historical **v6→v7 data migration** (which converted all stored frames to the `id_key` shape, and the physical `matrix_time_machine.section_id_key` column it left behind). **Even the relation sibling-order is now an id_key dataframe** (see *Relation ordering*).

## The match predicate (single authority)

The client's `component_common/js/dataframe.js` finder and the server's `dataframeEntryMatches()` (`src/core/concepts/subdatum.ts`, consumed by `src/core/relations/dataframe.ts`) are the ONLY pairing matchers. A frame matches a caller when:

```text
el.type === 'dd490'
AND el.from_component_tipo  === <slot tipo>        (when the caller supplies one)
AND el.main_component_tipo  === caller.main_component_tipo
AND el.id_key               === caller.id_key       (the main item id)
```

`isDataframeEntry()` (`src/core/concepts/subdatum.ts`) detects a frame purely by `type === 'dd490'`.

## End-to-end data flow

```text
 MAIN COMPONENT (e.g. portal numisdata32, item id = 1, links → material1/3)
        │  the main item id (1) is the pairing key — never the target section_id (3)
        ▼
 CLIENT render
   relation main:  section_record built per portal entry → self.locator.id (=1)
                   section_record.js get_component_data(dataframe_id_key = self.locator.id)
   literal main:   dataframe.js attach_item_dataframe(item.id)
        │  → self.data.id_key = 1
        ▼
 CLIENT save   common.js create_source → source.caller_dataframe = { id_key:1, … }
               component_dataframe.js create_new_section / link_record → value.id_key = 1
        ▼
 SERVER  dd_core_api handler reads source.caller_dataframe off the request
                     → save_component.ts threads it through as callerDataframe (id_key only)
        ▼
   read:  full slot → filter by dataframeEntryMatches(caller)                 [id_key]
   save:  caller-aware merge (relations/dataframe.ts); stamp caller.id_key
          on additions                                                        [id_key]
        ▼
 PERSISTED frame: { type:'dd490', section_tipo, section_id, id_key:1,
                    from_component_tipo, main_component_tipo, id }
```

**Time machine:** a main with dataframe slots records its history in **two lanes**, always under the **main** tipo (the frames are stored apart, under each slot's own tipo; the main's history is the one place the two halves travel together — see [two lanes](../system/tm_record.md#dataframe-mains-two-lanes)): a **language** row (`lg-spa`, `lg-ell`…) holds only that language's value, and an **`lg-nolan`** row holds the main's `lg-nolan` value (a non-translatable main's whole value, a transliterable main's base form, nothing for a translatable literal main) followed by ALL frames of every slot of the main. A relation main (a portal, a select…) is never split by language: its history is `lg-nolan` rows only — its whole value + the frames — whatever its ontology `translatable` flag and whatever the working language, and every language's history lists them. A save of the main in one language writes that language's row, plus an `lg-nolan` row only when the save changed the frames (removing an item strips its frames); a save of the slot itself (a frame added, edited or removed) writes ONE `lg-nolan` row under the main, never a row under the slot tipo and never a copy per language. The state at any row is rebuilt from the two lanes (each language's newest row up to it, the frames of the newest frame-state row up to it — an `lg-nolan` row, or a Dédalo v6 row carrying frames), so whatever order the main and its frames are saved in (a frame before its item included) every row is a complete state, and the tool's history of a language lists that language's rows and the `lg-nolan` rows together. This holds for every main model: relation mains and literal mains (`has_dataframe: true`, component_iri's fixed `dd560` included), translatable, transliterable or not. A frame-lane row the frames of a slot are missing from means that slot was empty then (`rowSlotTipos()`). Preview, list and restore split a row with the shared `splitComposed()` (`src/core/relations/dataframe_slots.ts`): every frame entry (dd490-marked, or carrying the legacy `main_component_tipo`) goes to the slots, every other entry stays in the main, for every model — so a frame never leaks into the main column and a main item (a v6 title-only `component_iri` item included) is never dropped. The `matrix_id` selects the row.

## `section_id_key` / `section_tipo_key` — where they remain (de-confusion)

Both the dataframe pairing AND the relation sibling-ordering have moved to `id_key`. These property names now survive only at the edges — do not "clean them up" there:

| Bucket | What it is | Status |
|---|---|---|
| **A. Dataframe pairing** | the pre-v7 shape of this component | **Removed** → `id_key` |
| **B. relation_parent ordering** | the per-parent sibling sort order on a `component_number` (`section_map → thesaurus → order`) | **Converted** → the order is now a dataframe of the child's **parent-link locator**, paired by `id_key` (see *Relation ordering* below) |
| **Old-CSV import** | reading a pre-v7 export envelope | **Kept** — accepts `section_id_key` as the `id_key` source, then strips it on write |
| **C. matrix_time_machine `section_id_key` column** | a physical DB column from the old split-storage TM | To be dropped |
| **D. one-time upgrade code** | the historical v6→v7 data migration (incl. its own dual-read) | Ran once, before the cutover; not carried into the current update catalog |

## Overview

```json
{
    "could_be_translatable" : false,
    "is_literal"            : false,
    "is_related"            : true,
    "is_media"              : false,
    "modes"                 : ["edit","list","tm"],
    "default_tools"         : [
        "tool_time_machine"
    ],
    "render_views" :[
        {
            "_comment" : "edit: the component_portal views, verbatim",
            "view"     : "default | line | tree | mosaic | indexation | content | text | print",
            "mode"     : "edit"
        },
        {
            "_comment" : "list: dataframe-specific renderers (dataframe_<view>); others fall back to the portal list view",
            "view"     : "default | text | mini",
            "mode"     : "list"
        }
    ],
    "data"        : "array of frame locators",
    "sample_data" : [
        {"type":"dd490","section_id":3,"section_tipo":"dd1706","id_key":2,"from_component_tipo":"dd560","main_component_tipo":"rsc217","id":1}
    ],
    "value"        : "array of frame locators",
    "sample_value" : [
        {"type":"dd490","section_id":3,"section_tipo":"dd1706","id_key":2,"from_component_tipo":"dd560","main_component_tipo":"rsc217","id":1}
    ]
}
```

!!! note "Typology"
    `component_dataframe` is a **related** component. On the client it is an **alias** of `component_portal` (`export const component_dataframe = component_portal`) with a few dataframe-specific additions (`create_new_section`, `get_rating`). Server-side it reuses the same shared portal engine: the descriptor `src/core/components/component_dataframe/descriptor.ts` registers `resolveData: 'portal'` (`src/core/relations/models/portal.ts`), so it gets the whole related-component contract ([locator](../locator.md) storage in the record's `relation` column, `from_component_tipo` filtering, grid/export/diffusion resolution) from the shared relation engines, and adds one purpose of its own: pairing **frame records** to individual data items of another component. The id_key pairing/merge algebra itself (not row emission) lives in `src/core/relations/dataframe.ts`.

!!! info "About `default_tools`"
    As for the portal model it shares, the toolbar is assembled from the model + ontology, never hardcoded — the concrete list should be verified per instance in the ontology. A dataframe slot is non-translatable, so it never receives `tool_lang` / `tool_lang_multi`. In practice the frame editing surface is the **target section opened in a modal**, so most of the per-item tooling lives on the target record, not on the dataframe button. `tool_time_machine` is the only tool guaranteed by the verified source in this checkout (`tools/tool_time_machine`).

## Definition

`component_dataframe` is an auxiliary relation component that extends INDIVIDUAL data items of a **main component** with **frame records**: uncertainty, qualifiers, sources, or contextual information (in the spirit of Wikidata qualifiers and references).

**Why it exists.** The Dédalo data model stores values, but research data often needs statements *about* values: how certain is this date, who assigned this label, what is the source of this number, what is the confidence rating of this attribution. Putting that metadata inside the value itself would bloat every data shape and break literal components; putting it in a free-standing record would lose the link to the specific value. The dataframe solves both: the frame content lives in a normal ontology-defined section (searchable, time-machine covered, diffusable like any record), and a small **pairing locator** ties each frame record to exactly one data item of the main component.

**When to use it.** Reach for a dataframe when you need to qualify *specific values*, not the whole record:

- An attribution that is uncertain only for the *second* of three authors, while the others are certain.
- A source/footnote that documents one particular reading of an inscription among several.
- A confidence *rating* on one of many proposed datings of an object.
- An IRI whose human-readable *label* must be stored and versioned (the built-in `component_iri` label slot).

It works for relation main components ([component_portal](component_portal.md), [component_select](component_select.md), [component_check_box](component_check_box.md), …) and for literal main components ([component_input_text](component_input_text.md), [component_text_area](component_text_area.md), [component_date](component_date.md), [component_number](component_number.md), [component_email](component_email.md), [component_iri](component_iri.md)).

**When not to use it.**

- To qualify the *whole record* (its state, its global source) -> use ordinary components in the section.
- To link the record to another record without per-item metadata -> use [component_portal](component_portal.md) directly.
- To store a value that every cataloguer types inline -> use the appropriate literal component; only add a dataframe when item-level metadata is genuinely needed.

!!! note "One frame slot, many pairings"
    A single `component_dataframe` instance (a *slot*, e.g. the IRI label slot `dd560`) holds the pairing locators for ALL items, and even for several main components of the same record. When a caller context is supplied, the read filters the slot's entries down to just the ones matching that caller (the *match predicate* below); without one, the whole slot is returned.

## Data model

**Data type:** `array of frame locators` stored in the record's **`relation`** JSONB column under the **dataframe slot's own tipo** as the key — exactly like any relation component.

!!! warning "The column is `relation`, the shape is an object"
    Frames live in `relation` (singular), as `{"<slot tipo>": [ … ]}` — never in
    a flat `relations` array, and never under the *main* component's tipo. See
    [Sections › typed JSONB columns](../sections/index.md#storage-detail-the-data-column-is-split-into-typed-jsonb-columns)
    and [Locator](../locator.md#function-and-structure).

**Value type:** `array` of frame locators, or `null`.

### The pairing contract

Every value of every component carries a stable, server-minted item `id` (a per-component counter inside the section record). The dataframe pairs against that id, not against array position and not against the target record:

```text
main component data item              frame locator (relation column, key = slot tipo)
{ "id": 2, "iri": "https://..." } ←── { "type": "dd490", "id_key": 2,
                                        "main_component_tipo": "rsc217",
                                        "from_component_tipo": "dd560",
                                        "section_tipo": "dd1706", "section_id": 3 }
```

A frame locator matches a main item when these four properties agree (the *match predicate*, `dataframeEntryMatches()`, `src/core/concepts/subdatum.ts`):

| property | meaning |
|---|---|
| `type` | always `dd490` (`DATAFRAME_RELATION_TYPE`) — the positive marker that an entry is a frame pairing |
| `from_component_tipo` | the dataframe slot (which `component_dataframe` owns this frame) |
| `main_component_tipo` | the main component the frame extends |
| `id_key` | the main data item's `id` — **never** a target section_id, **never** an array index |

`section_tipo` / `section_id` of the locator point at the frame **target record** (where the frame fields actually live).

### The write contract (server-authoritative)

Every frame write funnels through **`normalizeDataframeEntry()`**
(`src/core/concepts/subdatum.ts`), reached from both write doors —
`validateRelationInsert()` (`src/core/relations/save.ts`, via the `pairing`
option) and `mergeCallerEntries()` (`src/core/relations/dataframe.ts`). It is
the single definition of the persisted shape:

| rule | why |
|---|---|
| `type` **forced** to `dd490` | never trusted from the client, which sends it absent (autocomplete pick) or as `dd151` (portal tree view). A frame without the marker is stored-but-unreadable |
| `from_component_tipo`, `main_component_tipo`, `id_key` taken from the **server's** caller context | the client sources its `id_key` from the last read echo, so trusting the payload lets one bad read corrupt every later write |
| `section_id` canonicalized to an **int** | a record address is an integer; a numeric string is the deprecated legacy form. Search containment is type-strict, so locator probes run in dual form while unconverted stock remains (`engineering/wire_contract/WC-2026-08-10-section-id-int-canonical.md`) |
| `paginated_key`, `section_id_key`, `section_tipo_key` **stripped** | a read-time transient the client echoes back, and the pre-v7 pairing keys (read-only BC) |

Duplicate rejection compares **`DATAFRAME_TEST_EQUAL_PROPERTIES`**
(`dataframeEntriesEqual()`), *not* the generic relation key: `id` is excluded
(it is minted per insert, so including it makes every duplicate look unique),
and `id_key` is included (framing the same target record from two different
main items is legitimate and must not be collapsed).

> **Regression note (2026-07-31).** `component_dataframe` was the one relation
> column excluded from this normalizer, so raw client locators were persisted
> verbatim: no `type`, numeric `section_id`, echoed `paginated_key`, no dedup.
> Gates: `test/unit/dataframe_write_contract_native.test.ts` (raw payloads only
> — never spell `type:'dd490'` in an input there) and
> `test/unit/dataframe_contract_tripwire.test.ts`.

### The frame chip colour (rating)

A dataframe slot may declare a `role: "rating"` ddo in the **hide** block of its
`request_config`; the client paints the frame chip with that option's colour
(`view_default_list_dataframe.js`). The chain, using the live wiring:

```
numisdata1448 (dataframe on numisdata30)
  └ hide.ddo_map → rsc1246  role:"rating"   component_radio_button
                     ├ sqo.section_tipo → rsc1256   (the vocabulary)
                     ├ show → rsc1259 "Valuation"   → the option LABEL
                     └ hide → rsc1260 "Colour"      → the option COLOUR
```

The colour reaches the client on the **datalist**: each option carries
`hide: [{literal, tipo, section_id, section_tipo}]` — one entry per hide ddo,
resolved against that option's own record — and the client matches the picked
locator's `section_id` against the datalist, then reads `hide[0].literal`.

> **Regression note (2026-07-31).** `src/core/relations/datalist.ts` emitted
> `hide: []` for every option (a ledgered gap), so `hide[0].literal` threw and
> killed the whole record render. Both halves are now fixed: the datalist
> resolves hide ddos, and the client access is optional-chained so a colour can
> never again take a page down. Gate:
> `test/unit/datalist_hide_ddos.test.ts` (seeds its own vocabulary — the corpus
> records are not in the test DB, and an install-data assertion there passed
> with zero `expect()` calls).

### Reading one item's frames

`get_data` on a `component_dataframe` is a **paired** read: it honours
`source.caller_dataframe` (declared on `rqoSourceSchema`, read through the one
accessor `callerDataframePairing()`), returns only that main item's frames, and
stamps `id_key` + `main_component_tipo` on the item. That stamp is load-bearing
— the client assigns the response onto `self.data` and sources the next write's
`id_key` from it, so an unstamped echo destroys the following write's pairing.
Without a usable pairing (search mode, maintenance) the read degrades to the
unpaired expansion rather than inventing one.

### Storage shape

Frames live in the record's **`relation`** column — a JSONB **object keyed by
component tipo**, one key per component, each holding that component's locator
array. (It is `relation`, singular, and not a flat array: a frame is just one
more entry under its own slot's key, alongside every other relation component
of the record.)

Live `matrix` row `numisdata5/9`: the IRI value `id:1` of main component
`numisdata215` paired with label record `dd1706:60`, through slot `dd560`:

```json
{
    "relation": {
        "dd560": [
            {"id":1,"type":"dd490","id_key":1,"section_id":60,"section_tipo":"dd1706","from_component_tipo":"dd560","main_component_tipo":"numisdata215"}
        ]
    }
}
```

Note that the frame locator carries its **own** `id` (it is itself a data item of the dataframe component) — do not confuse it with `id_key`, the pairing key.

**Literal main: text with a role qualifier.** The live literal wiring — a
[component_input_text](component_input_text.md) `oh16` (section `oh1`) with two
values, each qualified by a frame in slot `oh130` pointing at an `rsc1242`
("Data frame | Uncertainty") record. Note the literal's values live in the **`string`** column
(keyed by tipo, like every literal) while its frames live in **`relation`**
under the SLOT's tipo — never under the main's:

```json
{
    "string": {
        "oh16": [
            {"id": 1, "lang": "lg-spa", "value": "Primer testimonio"},
            {"id": 2, "lang": "lg-spa", "value": "Segundo testimonio"}
        ]
    },
    "relation": {
        "oh130": [
            {"id":4,"type":"dd490","id_key":2,"section_id":583,"section_tipo":"rsc1242","from_component_tipo":"oh130","main_component_tipo":"oh16"},
            {"id":5,"type":"dd490","id_key":1,"section_id":585,"section_tipo":"rsc1242","from_component_tipo":"oh130","main_component_tipo":"oh16"}
        ]
    }
}
```

`id_key: 2` pairs the first frame to the value whose `id` is `2` ("Segundo
testimonio") — never to its array position, which here is the opposite order.

The edit view renders the frame button next to the second value; reordering or editing the values never breaks the pairing because it follows `id:2`, not the position.

**Relation main: portal informant with a role frame.** The live wiring of `oh1/368`: a [component_portal](component_portal.md) (tipo `oh24`, "Informants") pointing at two person records, the first link qualified by a frame in slot `oh115` ("Role"). Main and slot are **separate keys of the same `relation` column** — the frame is never appended to the main's own array:

```json
{
    "relation": {
        "oh24": [
            {"id":1,"type":"dd151","section_id":15855,"section_tipo":"rsc197","from_component_tipo":"oh24"},
            {"id":2,"type":"dd151","section_id":15856,"section_tipo":"rsc197","from_component_tipo":"oh24"}
        ],
        "oh115": [
            {"id":4,"type":"dd490","id_key":1,"section_id":1,"section_tipo":"rolepos1","from_component_tipo":"oh115","main_component_tipo":"oh24"}
        ]
    }
}
```

The frame stays attached to portal row `id:1` even if that locator is later re-pointed to a different person record, and even when the same target person is linked twice.

!!! warning "Legacy (pre-migration) shape"
    Data written before the v7 unification used `section_id_key` / `section_tipo_key` instead of `type` + `id_key`, and relation mains were keyed by the TARGET record's section_id. **Dual-read has been removed**: readers and the match predicate (`dataframeEntryMatches`, `isDataframeEntry`) recognise only the `type` + `id_key` shape. A database still carrying that legacy shape needed a one-time re-key of matrix data, time machine and the activity log to the unified contract before the cutover; an unmigrated legacy frame won't pair (it simply won't render). The only remaining tolerance for a legacy *input* shape is the **old-CSV import**, which accepts a pre-v7 export's `section_id_key` as the `id_key` source and strips the legacy keys on write.

### Lifecycle

- **Create** — the user activates the frame button on a value: a new target record is created (`create_new_section`) and the pairing locator saved. If the value is not persisted yet, pending changes are saved first (*save-then-attach*, single-writer rule): ids are minted server-side only, atomically, then the attach is repeated against the real id.
- **Update / reorder** — pairing is untouched: the item `id` is immutable and order-independent. Re-pointing a relation locator to another target also keeps its frame (the frame qualifies the *statement*, not the target).
- **Delete** — a frame locator leaves its slot through two doors: removing the **main item** cascades server-side (`removeDataframeDataById()`, `src/core/relations/save.ts`, wired into the component save path for a removed item, strips the paired frame locators from every dataframe slot of the main component — relation and literal mains alike, `component_iri`'s fixed `dd560` included, and also when an observer recompute drops a locator; the same cascade runs for inverse-reference cleanup when a whole record is deleted, `src/core/section/record/delete_record.ts`), and deleting the **frame itself** from the dataframe modal removes that one locator from the slot. On both doors, what happens to the frame **target record** is the slot's [delete policy](#dataframedelete_policy-on-the-dataframe-slot-node): by default it **survives** — the time machine needs it to render past states — and is reclaimed later by maintenance; a frame-private slot can opt into emptying it (the row is always kept).
- **Time machine** — the main's history is kept in two lanes: its language rows (each language's value only) and its `lg-nolan` rows (its `lg-nolan` value + the full frames of its slots), whichever of the two was saved. Restoring a language row puts that language back with the frames as they stood at that row; restoring an `lg-nolan` row puts its `lg-nolan` value and its frames back. Another main's frames in a shared slot stay as they are, and a frame of an item deleted since is not written back. A dataframe the frame state holds no frames for was empty then, and restoring empties it (`rowSlotTipos()`). A Dédalo v6 save of the main (one language + the frames) is read as that language's value and that moment's frames; a v6 dataframe save as the `lg-nolan` lane. A bulk revert restores the main and all its frames together, as one unit, lane by lane.
- **Writes are caller-aware** — the save path preserves the sibling frames of other items sharing the slot (`filterCallerEntries()`/`mergeCallerEntries()`, `src/core/relations/dataframe.ts`), so clearing the frames of one item never wipes another item's frames.

## Ontology instantiation

A `component_dataframe` is created as an ontology node whose `model` is `component_dataframe`. Its `parent` is normally the **main component** it extends; its portal `request_config` points at the frame **target section** (the section whose records hold the frame fields). Like the portal model it shares, it is non-translatable, so its language is `lg-nolan`.

Node definition of the live slot `oh115` (the role frame of the `oh24` portal,
in section `oh1`) — its `properties` block is shown in full immediately below,
so it is omitted here rather than shown empty:

```json
{
    "tipo"         : "oh115",
    "model"        : "component_dataframe",
    "parent"       : "oh24",
    "section_tipo" : "oh1",
    "lg-eng"       : "Role",
    "lg-spa"       : "Rol",
    "translatable" : false
}
```

Its live `properties` block — a portal `source` whose `sqo.section_tipo` is the
frame target. Here the target is resolved dynamically from `hierarchy_types: 4`
rather than named literally: that expands to **all ACTIVE hierarchies of
typology 4 on this installation**, which on `monedaiberica` are the five
sections `ds1`, `roleusr1`, `rolejob1`, `rolepos1` and `uncertainty1` (measured;
another installation registering fewer of them, or having deactivated some,
resolves fewer — one archive here resolves `ds1` alone). A fixed target uses
`{"value": ["<section>"], "source": "section"}` instead, as `numisdata1447` does
with `rsc1242` further below.

```json
{
    "mode": "edit",
    "view": "tree",
    "source": {
        "mode": "autocomplete",
        "request_config": [{
            "sqo": {
                "section_tipo": [{"value": [4], "source": "hierarchy_types"}]
            },
            "show": {
                "ddo_map": [
                    {"tipo": "hierarchy25", "parent": "self", "section_tipo": "self", "value_with_parents": false}
                ],
                "sqo_config": {"limit": 30},
                "show_interface": {"label": false},
                "fields_separator": ", "
            }
        }]
    }
}
```

The optional delete policy is a sibling block on the same node:

```json
{
    "dataframe": { "delete_policy": "delete_target" }
}
```

**Wiring it into a main component.** Two things must be present:

1. On the **main component instance**, the flag `has_dataframe: true`. **Required for literal mains** (input_text, text_area, date, number, email): the literal's JSON controller reads it (to add the RQO + build the subdatum) and its views call `attach_item_dataframe`, which no-ops without it. **Relation mains (portal, autocomplete, select…) ignore the flag** — they render each linked record as a `section_record`, so the slot ddo in `show.ddo_map` (step 2) is enough. A relation dataframe therefore works with no `has_dataframe`; a literal one does not — see *has_dataframe* below.
2. The main instance's `request_config` `show.ddo_map` must include a ddo pointing at the dataframe slot, so the subdatum builder knows which frame slot to attach per value item:

```json
{
    "source": {
        "request_config": [{
            "show": {
                "ddo_map": [
                    {"tipo": "oh115", "mode": "edit", "view": "line", "parent": "self", "section_tipo": "oh1"}
                ]
            }
        }]
    }
}
```

!!! danger "Declare `mode` — on the ddo AND on the slot node"
    **A slot ddo that omits `mode` does not inherit the caller's.** When the
    owner is not a section it resolves to **`mode: "list"`** (the
    resolve-ddo-mode rule, `src/core/relations/request_config/explicit.ts`) and
    the server stamps `"mode":"list","fixed_mode":true` on it — so you get the
    compact read-only cell instead of the editable picker.

    The resolution order is the same on **every** kind of main: the **ddo's**
    `mode`/`view` win, then the slot **node's** `properties.mode`/`view`, then
    `list`. Declaring it in either place works; declaring it in neither gives
    you `list`.

    In **edit** mode the views are simply
    [component_portal](component_portal.md)'s, used verbatim — `line`, `tree`,
    `default`, `mosaic`, `indexation`, `content`, `text`. `view: "line"` above
    is one of them and renders through `view_line_edit_portal`.

    **List** mode is the exception: there the client prefixes the view name to
    `dataframe_<view>` to reach the dataframe-specific renderers, and only
    three exist — `dataframe_default`, `dataframe_text`, `dataframe_mini`
    (views `default`, `text`, `mini`). Any other name matches no case and falls
    through to `view_default_list_portal`, the plain portal renderer, which
    shows nothing for a slot that has no frames yet.

    So `{"view": "line"}` with **no** `mode` is the trap: a good edit view
    silently demoted to list, where it does not exist. Adding `"mode": "edit"`
    is the fix — the view was never the problem.
    (The two switches: `render_edit_component_portal.js` and
    `render_list_component_portal.js`.)

    Symptom: the server sends the frame item and its context correctly, the
    browser console is clean, and nothing appears.

At construction the dataframe instance is created with a **caller_dataframe** object (carrying `id_key` / `main_component_tipo` for the item it is paired with); this context is expected in non-search modes. `section_tipo` / `parent` of the *target* records are not the dataframe node's own section; persistence still flows through the main record's section (the single database writer), with the frame locators living in that record's `relation` column under the slot's tipo.

## Properties & options

Dataframe configuration is split across two nodes: a flag on the **main component**, and a block on the **dataframe slot node**. All live in the ontology `properties` JSON.

### has_dataframe *(on the main component)*

- **Values:** `true` | `false` (default `false`).
- **Effect:** activates dataframe handling for the *main* component's data. When set, the read path (`src/core/section/read.ts`, the `has_dataframe` branch) adds the RQO to the context and builds the per-item frame subdatum, and the edit/list views attach the dataframe control per value item. This is what makes the frame button appear next to each value.
- **Literal vs relation (important).** The flag is **only consulted by literal mains**. A **relation main** (portal, autocomplete, select, check_box…) activates its dataframe purely from the `component_dataframe` ddo in `show.ddo_map` (rendered through the `section_record` path) and never reads `has_dataframe`. So a working relation dataframe with no flag is **not** a template for a literal — the literal needs the flag or its button never renders. Must be boolean `true` (`===true`); `"true"` / `1` will not pass the strict-typed controllers.

### dataframe.delete_policy *(on the dataframe slot node)*

- **Values:** `"unlink"` (default) | `"delete_target"`. Read from the **slot node's** `properties` by `dataframeDeletePolicyOf()` (`src/core/relations/dataframe.ts`) on every door a frame locator can leave its slot by: the main-item cascade (`removeDataframeDataById()`), the direct frame removal from the modal (the save path's `remove` on the slot), and the deletion of the host record itself in either mode. A policy written on the *main* component is ignored. The curator must hold a **write grant (level 2) on the frame target section**: the door was authorized on the host only, so the applier asks that grant itself and refuses the whole request with `perm.denied` otherwise. The resolved value is served to the client as the context key `delete_policy` on the slot entry.
- **Effect:** controls what happens to a frame **target record** once its pairing locator has left the slot. **No policy ever removes the target row.** The time machine renders a main's past frames through their targets: its preview and history list read each frame's children as of the history row, so a target `delete_target` emptied after that row still shows its values from before the wipe. The target is touched only *after* the unlink has **committed** (the wipes are queued on the transaction's commit lane, each in its own transaction); if the request rolls back, the locator and the target both stay as they were. An entry whose stored `section_id` is not a record address is left alone under every policy.
    - `unlink` — only the pairing locator is removed; the target record survives (the time machine needs it) and is reclaimed later by maintenance.
    - `delete_target` — for frame-private sections where an unlinked record is meaningless: the target is **emptied** (every component cleared, row kept — `deleteSectionData()`, recoverable from the time machine).
- **`hard_delete: true`** — a **retired** v6 key and **inert**: v6 removed its reader on purpose ("time machine needs to show the previous state, so, never deletes it"), and the engine reads it as `unlink`. The resolver logs each node that still carries it. `"delete_target_record"` (briefly accepted in 2026-09) is likewise `unlink`. Anything else (a typo, a value on the wrong node) is `unlink`: an unknown spelling never destroys data.

```json
{
    "dataframe": {
        "delete_policy": "delete_target"
    }
}
```

### source *(the shared portal contract)*

- **Values:** the standard portal `source` / `request_config` object.
- **Effect:** on a dataframe slot node, `source.request_config.sqo.section_tipo[0]` names the frame **target section** that `create_new_section` will create records in and open in the modal. The `show.ddo_map` resolves how the frame target is summarised. See [component_portal](component_portal.md) for the full portal `source` contract.

### role: "rating" *(ddo-level, in the slot request_config)*

- **Values:** set `"role": "rating"` on a ddo inside the slot's `request_config.hide.ddo_map`, pointing at a [component_radio_button](component_radio_button.md) in the target section.
- **Effect:** the client resolves that component's value against its datalist and paints the frame button with the rating's colour (and contrast-aware text colour). Used to surface a confidence/quality rating directly on the frame button without opening the modal. The ddo lives in `hide` so the rating is fetched for display only.

### Worked example — the valuation rating

This is the live `monedaiberica` configuration, verbatim. Main component
`numisdata161` (a `component_autocomplete` — an alias of
[component_portal](component_portal.md) — in
section `numisdata4`), dataframe slot `numisdata1447`, frame target section
`rsc1242`, rating [component_radio_button](component_radio_button.md)
`rsc1246`.

**1. Dataframe slot node** (`numisdata1447`, `parent: numisdata161`) — its
portal points at the frame target section `rsc1242`, and it declares `rsc1246`
**twice**: in `show` (mode `edit`) so the rating is editable inside the frame,
and in `hide` (mode `solved`, `role: "rating"`) so the colour is resolved for
the chip without rendering a second column.

```json
{
    "label": "?",
    "source": {
        "request_config": [{
            "sqo": { "section_tipo": [{"value": ["rsc1242"], "source": "section"}] },
            "show": {
                "ddo_map": [
                    {"tipo": "rsc1246", "mode": "edit", "view": "line", "parent": "self", "section_tipo": "self"}
                ],
                "sqo_config": {"limit": 1}
            },
            "hide": {
                "ddo_map": [
                    {"tipo": "rsc1246", "mode": "solved", "role": "rating", "parent": "self", "section_tipo": "self"}
                ]
            }
        }]
    },
    "hard_delete": true
}
```

!!! note "`hard_delete: true` is inert"
    `numisdata1447` carries it, and so do 58 other slot nodes of the
    `monedaiberica` install. v6 retired the key on purpose, and the engine
    ignores it: removing this frame, from the modal or by removing the
    valuation it qualifies, only unlinks it, and the `rsc1242` record
    survives for the time machine. To empty frame-private targets on unlink,
    use `"dataframe": {"delete_policy": "delete_target"}` (see
    [dataframe.delete_policy](#dataframedelete_policy-on-the-dataframe-slot-node)).

**2. The rating component** (`rsc1246`, a `component_radio_button` under the
`rsc1243` grouper of section `rsc1242`) — its options are the records of
section `rsc1256`, labelled by `rsc1259` in `show` and **coloured by `rsc1260`
in `hide`**:

```json
{
    "view": "rating",
    "source": {
        "request_config": [{
            "sqo": { "section_tipo": [{"value": ["rsc1256"], "source": "section"}] },
            "show": { "ddo_map": [{"tipo": "rsc1259", "parent": "self", "section_tipo": "self"}] },
            "hide": { "ddo_map": [{"tipo": "rsc1260", "parent": "self", "section_tipo": "self"}] }
        }]
    }
}
```

**3. The vocabulary** — each `rsc1256` record stores its label in `rsc1259`
(per language) and its colour in `rsc1260` (`lg-nolan`). The four live options:

| `rsc1256` id | `rsc1259` (label) | `rsc1260` (colour) |
|---|---|---|
| 1 | Valor incierto | `#b51a00` |
| 2 | Valor aproximado | `#ffaa00` |
| 3 | Menos cierto | `#f5ea14` |
| 4 | Más cierto | `#27bb4c` |

The colour reaches the client on the rating component's **datalist**: every
option carries `hide: [{literal, tipo, section_id, section_tipo}]`, and
`view_default_list_dataframe.js` matches the picked locator's `section_id`
against it and paints the chip with `hide[0].literal`.

**4. Result** — open a `numisdata4` record in edit: each `numisdata161` value
shows a round rating button; click it to create/open the `rsc1242` frame record
and pick a valuation; the button takes that colour. The same button also renders
in **read-only** contexts — Time Machine previews and read-only users (the edit
views attach the dataframe in both the writable and read-only render branches).

!!! note "Copying this onto a LITERAL main"
    A dataframe behaves **identically** on a literal and on a relation main —
    one component, one ontology contract — so this config is portable as-is.
    The only difference is the activation flag: a literal main also needs
    `has_dataframe: true` (see below); a relation main activates from the slot
    ddo alone.

    In both cases the frame's `mode`/`view` come from the **ddo** in the main's
    `show.ddo_map`, falling back to the slot node's own `properties.mode` /
    `properties.view`, then to `list`. That is why `numisdata1447` carries no
    node-level `mode` (its ddo supplies it) while `dd560` and `oh115` declare
    `"mode": "edit"`, `"view": "tree"` on the node — both spellings work, on
    either kind of main.

    The live literal wiring is `oh16` (a
    [component_input_text](component_input_text.md) in section `oh1`) with the
    slot `oh130`.

!!! note "Standard context properties"
    Like every component, `component_dataframe` honours the generic ontology context blocks carried into the datum `context`: `css`, `request_config` (RQO) and `view`. Any other custom key seen in production should be verified in the ontology.

!!! warning "Deprecated"
    `component_iri` shipped a literal `title` property that stored the IRI label inline; it is **deprecated** in favour of the `dd560` label dataframe slot. Title resolution still falls back to that literal for unmigrated data. A maintenance conversion that turns those literals into label frame records and strips the property has no confirmed implementation in this checkout.

## Render views & modes

The dataframe surface is intentionally minimal: a small button per value item. Views are dispatched by the per-mode render files; only the `list` render files ship (`view_default_list_dataframe.js`, `view_mini_list_dataframe.js`) because the button is rendered in both edit and list contexts of the *main* component.

| View | edit | list / tm | Notes |
| --- | :---: | :---: | --- |
| `default` | yes | yes | Round `button.activate` showing `properties.label` (or `?`). With no frame yet, first interaction reveals a `button.add` (the `+`) that creates the target record; with a frame, it opens the target section in a modal. A read-only button (no write permission, or any Time Machine surface) does neither. |
| `mini` | yes | yes | Same button rendered inside a `component_dataframe_mini` wrapper for tight spaces (e.g. inline next to a value). No add/modal chrome beyond the button. |
| `line` | yes | yes | Inline variant; used by `component_iri`, where the dataframe button sits inside a `column_component_dataframe` next to the IRI's input. |
| `tree` | yes | — | Inherited from the portal, not declared here: the client module **is** [component_portal](component_portal.md), so `properties.view: "tree"` in edit mode routes to the portal's [term picker](component_portal.md#tree-view-the-term-picker) and the frame's target thesaurus opens for picking. `oh115` is the live example (its target is resolved from `hierarchy_types`). |

!!! warning "`view: "tree"` in **list** mode has no renderer"
    The list dispatcher prefixes a dataframe's view with `dataframe_`, so a node
    declaring `mode: "list", view: "tree"` asks for a `dataframe_tree` route — and there
    is no such case. It falls through to the **default portal** list view, so the cell
    renders something, just not what the declaration asked for. It is declared live on
    `monedaiberica`: the `section_list` nodes `rsc1442`, `rsc1443` and `rsc1444` (all on
    section `rsc197`) each carry a `ddo_map` entry with `"mode": "list", "view": "tree"`
    for the dataframe slots `rsc1433`, `rsc1434` and `rsc1057`. The capability they
    anticipate is editing a frame from the list without opening the record, which is not
    implemented. Declare `mode: "edit"` for the picker.

Modes:

- **edit** — read/write through the main record. The button creates target records (`create_new_section`) and opens them in a modal (`open_target_section`); the modal footer offers a soft delete that calls `unlink_record()`. **Read-only edit render** (`permissions === 1`) still shows the button: the literal edit views attach the dataframe in *both* the writable (`get_content_value`) and read-only (`get_content_value_read`) branches. There the button is **inert**: it paints its label and rating colour (its `content_value` carries `read_only`), but it has no add button and a click never opens the target (`view_default_list_dataframe.is_read_only`: `permissions < 2`, `show_interface.read_only`, or a Time Machine surface). The **Time Machine** tool uses exactly this path — it renders the main component in edit mode with `permissions = 1` (`render_tool_time_machine.js`), so the historical rating shows in the TM preview.
- **list / tm** — the same button renders, coloured by the rating ddo when present. On a **Time Machine surface** (the dd15 history list, or the tool's preview — any instance whose caller chain holds a dd15 list, a `data_source:'tm'` or a `matrix_id`) the button is always read-only, whatever the user's permissions: the chip shows a historical frame, while opening it would open the LIVE target in an editable modal whose Delete unlinks the frame from the slot. It paints its label and rating colour, and nothing more. In the Time Machine the main's value is read from the selected history row (`data_source:'tm'` + its `matrix_id`). The read-only preview grafts the main's items **and**, in each slot, the frames of that main as of that row (the row's own frames, or for a language row the newest frame state at or below it), so the dataframe button shows the frames of that moment. The frames' **children** (the rating on a frame target, which drives the chip colour) are read as of the row too, not live, and so are the frames of a sibling-anchored slot. The history list's cells show the same frames and children as the preview of the same row, a language row included, and so does a whole-record row of a section's history (a delete snapshot shows each frame target as it stood when the record was deleted). The list's datum is shared by every row, so a frame target linked from several rows is emitted once per row, stamped with `row_section_id`, and each row's chip reads its own copy (`get_rating`). Frames of **other** mains in a shared slot stay live, and so do labels and datalists; the exact bound is the wire-contract entry `WC-2026-09-29-tm-preview-frame-children-as-of` (`engineering/wire_contract/`). A slot the row holds no frame of the main for previews empty, as a restore leaves it. On the client the preview's dataframe instance is keyed by the row's `matrix_id` and carries `data_source:'tm'`, so it never shares an instance with the live one and never refreshes from a live save (the TM tool drives the *edit*-mode read-only preview described above).
- **search** — there is no dedicated search render view; the JSON controller tolerates `search` mode (it does not require a caller_dataframe there) but the component is not a primary search input. Search over frame *content* is done on the target section.

DOM (list / default): `wrapper_component component_dataframe <tipo> <mode>` -> `content_data` -> `content_value` -> `span.button.activate` (+ optional `span.button.add.icon`).

## Import / export model

**Export.** A dataframe is a component with its own stored data, so a `dedalo_raw` export gives it **its own column**, headed by the dataframe component's tipo and placed right after the component it frames. Every cell is the plain [dedalo_data wrapper](../../using/importing_data.md#the-dedalo_data-wrapper) around that component's stored slice:

| `oh16` (the framed component) | `oh130` (the dataframe) |
|---|---|
| `{"dedalo_data": [{"id":2,"value":"Segundo testimonio","lang":"lg-spa"}]}` | `{"dedalo_data": [{"type":"dd490","id_key":2,"section_id":4,"section_tipo":"rolepos1","from_component_tipo":"oh130","main_component_tipo":"oh16"}]}` |

The column is minted from the ontology (`getDataframeChildTipos()` in `buildEntries`, `src/diffusion/export/grid.ts`), so it appears for every record of the export, empty where a record carries no frames. Explicit item ids round-trip, which is exactly what keeps `id_key` valid across an export/import cycle — the pairing lives in the data, which is why the two components can travel in separate columns at all.

**Import.** The dataframe column maps like any other component column: the header resolves to the frame tipo, the relation conform facet (`src/core/tools/import_conform.ts`) writes the locators with `id_key`, `main_component_tipo` and `type: dd490` intact, and the slot is replaced by what the column carries.

Files exported before 2026-08-09 fold the frames into the framed component's own cell as `{"dedalo_data":{"data":…,"dataframe":[…]}}` (`dato` instead of `data` in v6-era files). `unwrapDedaloData()` (`src/core/tools/import_data.ts`) still accepts both spellings and splits the frame array out; `writeDataframeFrames()` (`src/core/tools/import_csv_execute.ts`) writes them per slot, preserving frames owned by other components in the same slot and accepting a pre-v7 export's `section_id_key` as the `id_key` source. A `dataframe`-only envelope writes just the frames and leaves the component's data untouched. Nothing emits that envelope any more.

Wire contract: `WC-2026-08-09-export-raw-dataframe-own-column`.

See [importing data](../../using/importing_data.md) and [exporting data](../../using/exporting_data.md).

## Relation ordering (the order is a dataframe)

The sibling sort order of `component_relation_parent` children is itself a dataframe, paired by `id_key` like everything else — there are no exceptions to the contract.

- **What stores it.** A section that participates in ordered hierarchies declares an order component (`section_map → thesaurus → order`, a `component_number`). A child's position under one parent is a single value item of that order component.
- **The pairing key.** The order value pairs by `id_key` = the **id of the child's parent-link locator** (the entry in the child's `component_relation_parent` that points at this parent). A different parent means a different parent-link locator, a different `id`, and therefore an independent order. Stored shape: `{ value, id_key }` (the old `{ value, section_tipo_key, section_id_key }` is retired).
- **Inline helpers.** `src/core/relations/dataframe.ts` exposes the id_key-keyed accessors `getInlineDataByIdKey()`, `addInlineValueByIdKey()`, `removeInlineByIdKey()`, `getInlineValueByIdKey()`, `updateInlineValueByIdKey()`.
- **Writing.** Adding a parent link pre-allocates the parent locator's `id` before the order value is stamped, so the order can pair before the save mints ids; removing a parent resolves the id from the stored locator. Sorting and sibling-order recalculation resolve each child's parent-link id via `resolveParentLinkIdKey()` (`src/core/relations/children.ts`).
- **Reading (list order).** Because `id_key` differs per child, the order cannot be a single constant JSONB predicate. `resolveParentLinkIdKey()` resolves each child's `id_key` + order value, and the children engine (`src/core/relations/children.ts`) applies the order as a stable ascending in-process sort (children without an order value sink last) — rather than pushing a precomputed `array_position(...)` ordering into SQL, so paging a very large sibling set costs a full-child-list read.

## Notes

- **Diffusion.** Two opt-in mechanisms:
    - On the **main component's** diffusion ddo, an opt-in flag publishes the data items with their paired frame locators attached as a `dataframe` property, joined by item id.
    - A **`component_dataframe` ddo** in the diffusion map (with `parent` set to the main component tipo) publishes the parent-scoped frame locators; the chain processor recursion follows them into the frame target section records. Published locators carry `id_key` as the join key. See the *dedalo-diffusion* skill.
- **Maintenance.** The `dataframe_control` widget (`src/core/area_maintenance/widgets/dataframe_control.ts`) scans for frame locators whose main item no longer exists (orphans), reporting up to 500 in detail, and can remove them in place (target records are never deleted by this scan).
- **Observers / observables.** Not used by the dataframe button itself; observer/observable wiring, when needed, is configured in the ontology `properties` like any other component (see the index page *Observers and observables* section).
- **component_iri integration.** `component_iri` ships with a fixed label slot: each IRI row's `id` pairs with a label record in target section `dd1706` through slot `dd560`. The IRI's title resolution reads the paired label and falls back to a deprecated literal `title` property for unmigrated data.
- **Security.** Follows the same relation-component persistence rules as every other relation model; direct, unauthenticated access fails closed.
- **Related components:** [component_portal](component_portal.md) (the shared portal engine on the server, the client alias in the browser), [component_iri](component_iri.md) (built-in label dataframe), [component_input_text](component_input_text.md), [component_text_area](component_text_area.md), [component_date](component_date.md), [component_number](component_number.md), [component_email](component_email.md), [component_select](component_select.md), [component_check_box](component_check_box.md), [component_radio_button](component_radio_button.md).