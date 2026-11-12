# component_text_area

## Overview

```json
{
    "could_be_translatable" : true,
    "is_literal": true,
    "is_related": false,
    "is_media": false,
    "modes": ["edit","list","tm","search"],
    "default_tools" : [
        "tool_indexation",
        "tool_lang",
        "tool_lang_multi",
        "tool_propagate_component_data",
        "tool_subtitles",
        "tool_tc",
        "tool_time_machine",
        "tool_tr_print"
    ],
    "render_views" :[
        {
            "view"    : "default | line | mini",
            "mode"    : "edit | list"
        },
        {
            "view"    : "print | html_text",
            "mode"    : "edit"
        },
        {
            "view"    : "text | note",
            "mode"    : "list"
        }
    ],
    "data": "object",
    "sample_data": {
        "lg-spa":["<p>La descripción del objeto</p>"],
        "lg-eng":["<p>The object description</p>"]
    },
    "value": "array of strings",
    "sample_value": ["<p>The object description</p>"]
}
```

!!! note "Default tools depend on the ontology node"
    The `default_tools` list above is the full set declared on the canonical
    transcription node (`rsc36`). A concrete node only exposes the tools that
    make sense for its configuration: `tool_indexation`, `tool_subtitles`,
    `tool_tc` and `tool_tr_print` are only useful for audiovisual transcription
    nodes (those with `tags_*` properties and a related `component_av`). A plain
    description node typically ships only `tool_lang`,
    `tool_propagate_component_data` and `tool_time_machine`.

## Definition

`component_text_area` is a **literal, direct** component for **rich (formatted)
text**. Unlike [component_input_text](component_input_text.md) (plain strings,
no markup), the value is HTML produced by a WYSIWYG editor (CKEditor) and can
carry inline semantic markup: thesaurus indexations, cross-record references,
person/speaker tags, language switches, geolocation references, editorial notes
and audiovisual time codes.

It exists to cover two distinct needs that both require formatted, paragraph-level
text:

- **Long descriptive prose** — a narrative description, an abstract, a scholarly
  note, an editorial commentary. Here `component_text_area` is "the formatted
  textarea": bold/italic/underline plus paragraphs.
- **Oral-history / audiovisual transcription** — the historical reason the
  component is so feature-rich. A transcription is the text of an interview
  synchronised with the media (`[TC_hh:mm:ss.mmm_TC]` time codes), with the
  speaker marked inline (`[person-...]`), thesaurus terms indexed inline
  (`[index-...]`), bibliographic references (`[reference-...]`), inline notes
  (`[note-...]`) and map references (`[geo-...]`). Clicking a time-code tag in the
  transcription jumps the related `component_av` player to that position
  (observer/observable wiring, see [Notes](#notes)).

**When to use it.** Use `component_text_area` for cultural-heritage fields such as
*Physical description*, *History of the object*, *Conservation notes*,
*Interview transcription*, *Synopsis*, or any field where the cataloguer needs
paragraphs and basic styling, or where inline tagging (indexation, references,
speakers, time codes) is required.

**When not to use it.** Do not use it for short, single-line, unformatted values
(titles, codes, names) — use [component_input_text](component_input_text.md). For
strictly numeric values use [component_number](component_number.md); for
controlled vocabularies use [component_select](component_select.md) or a relation
component. If you need a richer HTML subset (strikethrough, code, sub/superscript)
use `component_html_text`, which shares this text-handling logic but keeps
more HTML tags on import/sanitization; in the TS server `component_html_text` is
an alias that resolves to the same `component_text_area` descriptor
(`src/core/components/component_text_area/descriptor.ts`).

!!! note "Legacy aliases"
    Two legacy v5/v6 model names — `component_html_text` and
    `component_input_text_large` — are registered in the TS server only as thin
    alias stubs whose descriptors set `alias: 'component_text_area'`. They own no
    storage or resolver of their own; each is resolved to `component_text_area`
    at runtime, so everything on this page applies to them too.

!!! warning "Transcription tooling: storage only, no tag machinery yet"
    The TS server stores, reads and saves the HTML value like any other
    string-family component (`descriptor.ts` → `column: 'string'`,
    `classSupportsTranslation: true`, resolved through
    `src/core/resolve/component_data.ts` /
    `src/core/section/record/save_component.ts`). The **transcription-specific**
    behaviour described below — `tags_*` inline-tag resolution/repair, the
    `dd_component_text_area_api` actions, time-code → `component_av` sync,
    plain-text extraction and annotation extraction — is **not ported**: no module under
    `src/` or `tools/` references `tags_index`, `tags_reference`, `tags_notes`,
    `tags_persons`, `tags_draw` or `fix_broken_index_tags` (verified by grep,
    2026-07-05). A plain description field works end-to-end; a transcription
    node's inline-tag tooling does not yet.

## Data model

**Data:** `object` with languages as properties (one entry array per language).

**Value:** `array` of `strings` (HTML), or `null`.

**Storage:** In the matrix `data` column, `component_text_area` stores its value
exactly like the other literal-direct string components: an object keyed by
language, each language holding an array of strings. The strings are HTML
fragments (paragraph-wrapped) optionally containing Dédalo inline tags.

Translatable node (the common case):

```json
{
    "lg-spa" : ["<p>La historia del objeto…</p>"],
    "lg-eng" : ["<p>The history of the object…</p>"]
}
```

A non-translatable node (`translatable: false`) stores a single value under
`lg-nolan`:

```json
{
    "lg-nolan" : ["<p>Plain note without language</p>"]
}
```

At instantiation a translatable component only manages the value of the language
it was instantiated in (see [Translatable property](index.md#translatable-property)).
Internally each item is the canonical `{id, value, lang}` shape of the
`{context, data}` datum. A transcription value with inline tags looks like:

```json
[
    {
        "id": 1,
        "lang": "lg-eng",
        "value": "<p>[TC_00:00:00.000_TC][person-a-1-JavNa-data:{'section_tipo':'rsc197','section_id':'2','component_tipo':'oh24'}:data]The project <strong>Dédalo</strong> … [index-n-1-label in 1-data::data]He was installed as <i>Chief Architect</i>.[/index-n-1-label in 1-data::data]</p>"
    }
]
```

!!! note "Inline tags are text, not relations"
    `component_text_area` is a **literal** component: even though `[index-…]`,
    `[reference-…]`, `[person-…]`, `[geo-…]` and `[note-…]` tags encode locators,
    they live **inside the stored string**. The actual relation locators are kept
    in companion relation components (configured via the `tags_*` properties);
    the text only carries a synchronised copy of the tag. The component never
    stores locator arrays of its own (`is_related: false`).

    That is also why the `section_id` inside a marker is **quoted**: the marker
    is a byte sequence serialized into a text scalar, not a locator the engine
    reads back as a record address. Everywhere the engine emits a real record
    address — including the tags payload the person/index widgets receive — it is
    an integer.

!!! note "Empty values"
    Editor garbage such as `<p></p>`, `<p> </p>` and `<br data-mce-bogus="1">` is
    treated as empty, so an "empty" editor never persists noise.

## Ontology instantiation

Define the component as an ontology node whose `model` is `component_text_area`.
The node hangs from the section (or grouper) it belongs to, and the section wires
it in through `parent` / `section_tipo`.

Minimal node JSON:

```json
{
    "tipo"          : "rsc36",
    "model"         : "component_text_area",
    "parent"        : "rsc167",
    "section_tipo"  : "rsc167",
    "translatable"  : true,
    "lg-eng"        : "Description / AV transcription",
    "lg-spa"        : "Descripción / transcripción av"
}
```

A plain *Description* node usually needs no `properties` (or only display
options). A full **transcription** node declares the companion relation
components that store the inline tags. A realistic `properties` block for the
transcription node:

```json
{
    "auto_init_editor": true,
    "tags_index": {
        "tipo": "rsc860",
        "section_id": "self",
        "section_tipo": "self"
    },
    "tags_reference": {
        "tipo": "rsc1368",
        "section_id": "self",
        "section_tipo": "self"
    },
    "tags_notes": {
        "rsc326": [
            { "id": "title",       "type": "text", "section_tipo": "rsc326", "component_tipo": "rsc328" },
            { "id": "body",        "type": "text", "section_tipo": "rsc326", "component_tipo": "rsc329" },
            { "id": "publishable", "type": "bool", "section_tipo": "rsc326", "component_tipo": "rsc399" }
        ]
    },
    "tags_persons": {
        "oh1": [
            { "state": "a", "section_tipo": "oh1",    "component_tipo": "oh24", "parent": "oh1" },
            { "state": "b", "section_tipo": "rsc167", "component_tipo": "rsc50", "parent": "oh1" }
        ]
    }
}
```

The special string `"self"` in a `tags_*` config means "resolve to the current
record" (`section_id`/`section_tipo` of the live instance). Each `tags_*` config
points at the **portal/relation component** (its `tipo`) that actually stores the
locators for that tag family, and that is where the tag data is read from.

To make the time-code → player jump and the indexation tooling work, the same
section should also contain a related `component_av` and (for the
"original language" selector) a related `component_select_lang`; both are
discovered through the ontology relation, not configured on this node.

## Properties & options

All properties live in the ontology node `properties` JSON. If a property is not
listed here, **verify in ontology** before relying on it.

### Display / behaviour

`auto_init_editor`

options: `true | false` (default: `false` / `undefined`)

When `true` the WYSIWYG editor (`service_ckeditor`) is initialised as soon as the
component renders, instead of waiting for the user to focus it. Tools such as
`tool_indexation` also set this at run-time.

`show_interface`

options: `object` of boolean / option flags

Fine-grained control of the rendered UI (buttons, save animation, read-only,
fullscreen, etc.). Example keys observed on the transcription node:
`button_create_fragment`, `read_only`, `value_buttons`, `button_add`,
`button_delete`, `button_fullscreen`, `button_save`, `save_animation`, `label`.
The exact accepted keys are the shared `show_interface` set — **verify in
ontology** for a given node.

`has_dataframe`

options: `true | false` (default: `false`)

Enables the [dataframe](component_dataframe.md) subdatum (per-item frame records:
uncertainty, qualifiers, context) for this component. Required for literal mains (relation mains
activate from the slot ddo alone); the control also renders in read-only contexts (Time Machine
previews). Full ontology setup including a coloured rating: [component_dataframe](component_dataframe.md)
→ "Worked example — uncertainty rating on a literal".

### Inline-tag families (transcription)

Each `tags_*` property points at the relation/portal component that stores the
locators for one family of inline tags. Presence of a property both enables the
corresponding toolbar button (in edit mode) and lets the server resolve / repair
the tags. All accept an object with `tipo`, `section_id`, `section_tipo`
(`"self"` allowed).

`tags_index`

Thesaurus **indexation** tags (`[index-…]`/`[/index-…]`). Points at the
`component_portal` that stores the indexed term locators. Drives the auto-repair of
broken in/out tag pairs and the diffusion "global search" term resolution.

`tags_draw`

Drawing / image-region indexation tags (`[draw-…]`). Same shape as `tags_index`;
covered by the same tag auto-repair.

`tags_reference`

Cross-record **reference** tags (`[reference-…]`/`[/reference-…]`). Points at the
portal storing the reference locators; used by the legacy references-HTML diffusion
parser.

`tags_notes`

Inline editorial **note/annotation** tags (`[note-…]`). The value is an object
keyed by the notes `section_tipo`; each entry is a `ddo_map` of
`{ id, type, section_tipo, component_tipo }` describing the note fields to read
(`type: "text" | "bool"`). Consumed when annotations are collected for diffusion search.

`tags_persons`

**Speaker / person** tags (`[person-…]`). The value is an object keyed by the
people `section_tipo`; each entry lists `{ state, section_tipo, component_tipo,
parent, section_id? }` describing which related person components become available
as insertable speaker tags. Person labels are built from name/surname.

!!! note "Geolocation tags are derived, not configured"
    `[geo-…]` tags exist in the text, but their geometry is **not** stored in the
    text dataset anymore: it lives in a related
    [component_geolocation](component_geolocation.md). The geo toolbar button
    appears automatically when a related `component_geolocation` exists (no
    `tags_geo` property), and the text tags are reconciled against the geolocation
    layers.

### Observers / observables

`observe` / `observers`

options: `array` of observer configuration objects

Standard component observer wiring (see [index.md](index.md#observers-and-observables)).
On the transcription node `observe` subscribes to the related "original language"
selector (`set_lang_value` → `change_lang`). The `observers` array is the legacy
mirror list of components watching this one; it no longer registers an edge —
see [Server-side observers](../system/observers.md).

### Output formatting

`fields_separator` / `records_separator`

options: `string` (defaults: `", "` and `" | "` respectively)

Separators used when this component renders multiple values into a single grid /
export cell.

### Deprecated

- Storing geolocation geometry inside the `[geo-…]` tag dataset is **deprecated**;
  use a related [component_geolocation](component_geolocation.md).
- The legacy `indexation_list` custom-columns grid path is kept only for the
  indexation tool grid; export and the generic grid use the atoms adapter.

## Render views & modes

| view | edit | list | search | notes |
|---|---|---|---|---|
| `default` | ✓ | ✓ | (single text input) | full editor (edit) / truncated HTML (list) |
| `line` | ✓ | | | compact single editor row |
| `mini` | ✓ | ✓ | | minimal; renders inline tag images |
| `print` | ✓ | | | read-only render (forces permission 1), reuses the `line` view |
| `html_text` | ✓ | | | editor variant with the wider HTML tag set, reuses the `default` view |
| `text` | | ✓ | | plain text list cell |
| `note` | | ✓ | | note-oriented list cell |

- **edit** opens the WYSIWYG editor; the toolbar buttons present depend on the
  `tags_*` properties and on a related `component_av` / `component_geolocation`
  (`button_person`, `button_note`, `reference`, `button_draw`, `button_geo`).
- **list** / **tm** render a truncated, image-resolved HTML preview (falling back to
  another language's value when the current one is empty); `tm` reuses the list renderer.
- **search** renders one (or more) plain `input[type=text]` fields plus, when the
  component is translatable, the "search in all langs" checkbox. The query is split
  (`q_split = true`). Saves are blocked in `search`/`tm` modes (shared contract).
  Server-side the filter is turned into SQL by the shared
  `src/core/search/builders/builder_string.ts` (same builder as
  [component_input_text](component_input_text.md) and
  [component_email](component_email.md)), dispatched from
  `src/core/search/conform.ts`.

DOM follows the standard
`wrapper_component → label / buttons / content_data → content_value → value`
structure built by the shared `ui.component` builders.

## Import / export model

### Import

By default the import format is the JSON of the data: an object keyed by language
with arrays of HTML strings.

```json
{
    "lg-spa" : ["<p>Mi descripción</p>", "<p>Otra descripción</p>"],
    "lg-eng" : ["<p>My description</p>", "<p>Other description</p>"]
}
```

The v7 per-item shape is also accepted (`[{"value":"<p>Hello</p>"}]`), as is a
single flat string (auto-wrapped into `{value}`; `component_text_area` is a
`VALUE_PROPERTY_MODELS` member in `src/core/tools/import_data.ts`). The
`conformImportData()` normalizes all of these into the v7 `{value}` item shape, so
a bare title imported into a text area still becomes a valid item — whether the
`<p>…</p>` paragraph-wrapping and `\n`/`<br>` → paragraph-break
normalization is reproduced has not been independently verified in this path. A cell that
looks like JSON but fails to parse is rejected and reported as
`IGNORED: JSON decode failed`.

!!! note "text_area vs html_text on import"
    Both components use the same import format and data structure; the difference
    is which HTML tags survive sanitization. `text_area` keeps the basic set
    (`<p>`, `<strong>`, `<i>`, `<u>`) and strips the rest, while `component_html_text`
    preserves the wider set (`<s>`, `<code>`, `<sub>`, `<sup>`, …).

See the full formatted-text import definition in
[Importing data → Formatted text](../../using/importing_data.md#formatted-text).

### Export

Flat display values are produced by the generic cell resolver `resolveCellValue()`
(`src/core/resolve/relation_list.ts`), consumed by
`tools/tool_export/server/tool_export.ts`, the same path every literal component
exports through. Finer-grained export refinements — an atoms contract emitting
one atom per non-empty item, on-the-fly inline image tag resolution, an
`is_fallback` flag — are not independently
verified in this path; the legacy `indexation_list` grid mode has no
equivalent here (not implemented).

See [Exporting data](../../using/exporting_data.md).

## Notes

- **Model.** There is no class hierarchy: `component_text_area`
  is a descriptor (`src/core/components/component_text_area/descriptor.ts`,
  `column: 'string'`, `classSupportsTranslation: true`) resolved by the same
  generic engines as [component_input_text](component_input_text.md) —
  `src/core/resolve/component_data.ts` (read),
  `src/core/section/record/save_component.ts` (save). See
  [component model descriptors](base_classes.md) for the descriptor model.
- **Save sanitization — gap.** No HTML sanitizer (the stored-XSS hardening step
  tracked as SEC-034) runs over a value before it is persisted: no such sanitizer
  runs in the save path (verified by grep).
- **Tag repair — not ported.** Auto-repair of broken inline in/out tag pairs,
  deleting a tag across every language, and the whole `tags_*` reconciliation layer
  have no TS equivalent yet.
- **Plain text — not ported.** Stripping tags/HTML down to a plain-text body for
  publication search has no TS equivalent.
- **API actions (WC-077).** `dd_component_text_area_api` is registered in
  `src/core/api/dispatch.ts`, with two actions:
    - `get_tags_info` (read) — resolves a transcription's marks into the
      records they point at (tool_tr_print's feed). `source`: `tipo`,
      `section_tipo`, `section_id` (int, coerced per
      WC-2026-08-10-section-id-int-canonical), optional `lang` (defaults to
      the current data lang); `options.ar_type` a non-empty array of tag
      types. Gate: `principalCanAccessRecord` (read scope) on the host
      record. Returns the tags-info map, plus any unresolvable requested
      types named in the envelope's `unknown_types` extension.
    - `delete_tag` (write) — removes one tag's marks from every language of
      the text (tool_indexation's step 1; the portal locator is a separate
      `dd_component_portal_api::delete_locator` call the client issues
      right after). `source`: `tipo`, `section_tipo`, a positive int
      `section_id`; `options`: `tag_id`, `type` — only `index` and
      `reference` are deletable by id, any other `type` is a named refusal.
      Gate: `getPermissions(principal, section_tipo, tipo) >= 2`, then
      per-record project scope for non-admins. Returns a **boolean** —
      `removedCount > 0 && no partial-write error` — and that falsiness is
      load-bearing: the client only strips the editor's tag markup on a
      truthy answer, so "nothing matched" is a valid falsy success, never a
      thrown error. A partial multi-lang failure rides as a
      `record.save_failed` notice alongside a still-successful envelope.
- **Default tools.** Indexation/transcription tooling (`tool_indexation`,
  `tool_subtitles`, `tool_tc`, `tool_tr_print`) plus the shared `tool_lang`,
  `tool_lang_multi`, `tool_propagate_component_data` and `tool_time_machine` are
  read-only ontology-driven context; whether the underlying tools themselves are
  implemented server-side is tracked per-tool elsewhere, out of scope for this page.
- **Filled from a PDF.** A text area that a [component_pdf](component_pdf.md)
  names in its ontology `relations` (core: `rsc37` → `rsc38`, `rsc209` →
  `rsc210`, `rsc165` → `rsc166`) receives the PDF's text, one page tag per
  page, in the user's current data language. A new PDF uploaded to the
  `original` quality, with or without OCR, **replaces** text already in that
  language (the upload shows a notice; Time Machine keeps the previous
  version); `tool_update_cache` and **Regenerate files** fill it only when it
  is empty. See [component_pdf › Transcription and OCR](component_pdf.md#transcription-and-ocr).
- **Observer example (AV sync) — not ported.** The `[TC_…]` time-code →
  `component_av` jump relies on the client-side observer wiring plus the
  transcription tag machinery above; since the tag layer is unported, this
  interaction is currently non-functional against the TS server.
- **Gotcha — tags vs locators.** Conceptually, the inline tags are meant to be a
  synchronised *copy* of the locators stored in the companion `tags_*` relation
  components (documented here as the target contract); with the repair logic
  unported, nothing currently keeps them in sync on the TS server.

### See also

- [component_input_text](component_input_text.md) — plain (unformatted) text.
- [component_geolocation](component_geolocation.md) — stores the geometry behind
  `[geo-…]` tags.
- [component_portal](component_portal.md) — the relation component that stores
  the `tags_*` locators.
- `component_html_text` — same text-handling logic, wider HTML tag set.
- [component_select_lang](component_select_lang.md) — the related
  original-language selector.
- `component_av` — the audiovisual player synchronised via time-code tags.
