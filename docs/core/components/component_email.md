# component_email

## Overview

```json
{
    "could_be_translatable" : false,
    "is_literal": true,
    "is_related": false,
    "is_media": false,
    "modes": ["edit","list","tm","search"],
    "default_tools" : [
        "tool_time_machine",
        "tool_replace_component_data",
        "tool_add_component_data"
    ],
    "render_views" :[
        {
            "view"    : "default | mini",
            "mode"    : "edit | list"
        },
        {
            "view"    : "line | print",
            "mode"    : "edit"
        },
        {
            "view"    : "text",
            "mode"    : "list"
        }
    ],
    "data": "object",
    "sample_data": {
        "lg-nolan": [{"id":1,"lang":"lg-nolan","value":"my_email@dedalo.dev"}]
    },
    "value": "array of strings",
    "sample_value": ["my_email@dedalo.dev", "other@dedalo.dev"]
}
```

!!! note "Typology"
    `component_email` is a **literal-direct** component. It shares the same string-family descriptor shape as [component_input_text](component_input_text.md) and [component_text_area](component_text_area.md) — `src/core/components/component_email/descriptor.ts` declares `column: 'string'`, `classSupportsTranslation: true` — and is resolved by the same generic engines (`src/core/resolve/component_data.ts`, `src/core/section/record/save_component.ts`); there is no per-model code tree. See [base classes](base_classes.md) for the model/descriptor scheme. The e-mail-specific validation, cleaning and mailto helpers described below are a client-side behaviour layer; see the gaps flagged in [Notes](#notes) for what the server currently enforces.

## Definition

`component_email` manages one or more **e-mail addresses** as plain strings, with format validation on both the client and the server. It is a literal-direct component: it owns and stores its own value, never a locator to another section.

It exists so that addresses are not stored as free `component_input_text`, where nothing guarantees a well-formed `local-part@domain.tld`. By concentrating the address handling in a dedicated model, Dédalo can:

- validate the format before saving (rejecting malformed input);
- clean / normalize the raw string against header-injection payloads;
- offer "write e-mail" affordances (single `mailto:` and a batch BCC `mailto:` over a whole list of records).

E-mail addresses are inherently language-neutral, so the component is **non-translatable**: its language is always forced to `DEDALO_DATA_NOLAN` (`lg-nolan`), whatever the request's data language.

**When to use it.** Any cultural-heritage record that needs a contact address: the e-mail of a museum or archive (institution section), the contact of a project's principal investigator, a donor's or a lender's address, the maintainer of a digital collection.

**When not to use it.** Do not use it for a generic web address or a contact form URL (use `component_external` / a URL component), nor for a person you want to *link to* as a related record (use `component_portal` / a relation component and put the e-mail on the linked person's record). It is not a rich-text field — use [component_text_area](component_text_area.md) for formatted notes and [component_input_text](component_input_text.md) for free single-line text.

## Data model

**Data:** `object` keyed by language (always `lg-nolan` for this component), whose value is an array of data items.

**Value:** `array` of `strings`, or `null`.

Each data item is an object `{id, lang, value}` where `value` is the e-mail string, `lang` is always `lg-nolan`, and `id` is the per-item counter assigned by the shared save engine. Bare scalars are wrapped into `{value, lang:'lg-nolan'}` and empty arrays/`[null]`/`['']` collapse to `null`; the address-cleaning step (stripping control characters and header-injection sequences) is the gap described under *Validation* below.

**Storage shape** inside the matrix `data` column (language-keyed object, value as array of items):

```json
{
    "lg-nolan": [
        {"id": 1, "lang": "lg-nolan", "value": "raspa@dedalo.dev"},
        {"id": 2, "lang": "lg-nolan", "value": "other@other.org"}
    ]
}
```

Because the component is non-translatable, there is a single language group, `lg-nolan`; there is no per-language variant and no transliteration. When the component is instantiated it reads its data from the section and resolves only the `lg-nolan` group.

### Validation

The string `value` must be a well-formed address: a *local-part*, the `@` symbol, and a *domain* with at least one dot before a top-level label.

- **Server-side (intended contract)**: a save should reject the write if any non-empty value is not a well-formed address (a format check plus a defence against header-injection payloads — control characters, quotes and CR/LF sequences such as `\n`, `\r`, `%0A`, `%0D`).

    !!! warning "Gap: no server-side validation implemented yet"
        The save path (`src/core/section/record/save_component.ts`) is model-agnostic and does not run any e-mail-format or header-injection check before persisting — no such check exists under `src/`. The client `verify_email()` check below is, for now, the **only** validation; a malformed or malicious address typed through a means other than the standard form is not rejected server-side.
- **Client** (`component_email.js` `verify_email()`): validates with the regex `/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i`. The `{2,}` TLD quantifier accepts long modern TLDs (`.museum`, `.travel`). When several addresses are present **all** must validate. An empty value is allowed (so the user can clear the field).

!!! note "Local-part and domain rules"
    The local-part may use the ASCII letters `a–z`, digits `0–9`, the special characters `!#$%&'*+-/=?^_{|}~` and a dot `.` (not first/last, not consecutive). The domain must be a dot-separated list of DNS labels (letters, digits, and `-` not first/last), each up to 63 characters; the TLD must not be all-numeric.

## Ontology instantiation

To define an e-mail field, create an ontology node with `model: "component_email"` whose parent is the target section (or a section grouper). The `lg-*` localized labels carry the human name of the field. A minimal node:

```json
{
    "tipo"   : "tch442",
    "model"  : "component_email",
    "parent" : "tch1",
    "lg-eng" : "Contact e-mail",
    "lg-spa" : "Correo de contacto"
}
```

The `section_tipo` is the section the component lives in; it is resolved from the node's `parent` chain and is **mandatory** at instantiation (auto-resolution was removed — an empty `section_tipo` returns `null`). Wiring the node as a child (directly or through a grouper) of section `tch1` is what makes the field appear in that section's edit form.

A realistic `properties` block for this component (all keys optional):

```json
{
    "mandatory": true,
    "has_dataframe": false
}
```

Because the component is non-translatable, the instantiated `context` reports `"translatable": false` and `"lang": "lg-nolan"` regardless of the user interface language. A representative instantiation context (from `src/core/components/component_email/samples/context.json`):

```json
{
    "model"        : "component_email",
    "tipo"         : "test208",
    "section_tipo" : "test3",
    "parent"       : "test3",
    "lang"         : "lg-nolan",
    "mode"         : "edit",
    "translatable" : false,
    "properties"   : {},
    "permissions"  : 2,
    "sortable"     : true,
    "type"         : "component",
    "view"         : "default"
}
```

## Properties & options

| Property | Values | Default | Effect |
| --- | --- | --- | --- |
| `mandatory` | `true` \| `false` | `false` | Read in `render_edit_component_email.js`. When `true` and the field is empty, the input is rendered with the `mandatory` CSS class to flag to the user that a value is required. |
| `has_dataframe` | `true` \| `false` | `false` | Read in the TS section read (`src/core/section/read.ts`, the `has_dataframe` branch). When `true` it builds the paired dataframe subdatum (uncertainty / qualifier frame records paired with each item via the shared dataframe contract) and ships the extra dataframe DDO context to the client. Required for literal mains (relation mains activate from the slot ddo alone); the control also renders read-only (Time Machine previews). Full ontology setup incl. a coloured rating: [component_dataframe](component_dataframe.md) → "Worked example — uncertainty rating on a literal". |

!!! warning "`multi_line` does not apply"
    Unlike [component_input_text](component_input_text.md), `component_email` does **not** read a `multi_line` property — there is no reference to it anywhere in the component. Multiple addresses are handled by adding rows (one item per address), not by switching to a textarea. For multi-line free text use [component_text_area](component_text_area.md).

!!! note "Other ontology keys"
    `css` and `request_config` (search configuration) flow from the ontology node into the datum `context` like any other component. Observer/observable wiring, if needed, is configured in `properties` as documented in the [components index](index.md#observers-and-observables). Any other key not listed above is not consumed by this component — verify in the ontology before relying on it.

## Render views & modes

Modes: `edit`, `list`, `tm`, `search` (`tm` reuses the `list` renderer).

| View | Modes | File | Notes |
| --- | --- | --- | --- |
| `default` | edit, list | `view_default_edit_email.js`, `view_default_list_email.js` | Edit: one `input` per address inside `content_data`, with per-row **email** button (single `mailto:`) and a **remove** button on rows after the first; the toolbar carries an **add** button and the **email_multiple** batch button. List: addresses joined by `fields_separator`, click opens edit-in-list as a modal. |
| `mini` | edit, list | `view_mini_email.js` | Compact value-only wrapper (shared between edit and list). |
| `line` | edit | `view_line_edit_email.js` | Inline single-line edit; hides the row buttons, appends an *exit edit* button. |
| `print` | edit | (handled in `render_edit_component_email.js`) | Forces `permissions = 1` and falls through to the `default` renderer, so values render as read-only nodes. |
| `text` | list | `view_text_list_email.js` | Plain `span`, addresses joined by `fields_separator`; no DOM controls. Used for exports / flat-table text rendering. |
| `default` (search) | search | `render_search_component_email.js` | Renders a `q_operator` input plus one value input per filter entry; changes publish `change_search_element`. |

The client views above ship unchanged (copied as-is). Server-side, the search filter is turned into SQL by the shared `src/core/search/builders/builder_string.ts` (same builder as [component_input_text](component_input_text.md) and [component_text_area](component_text_area.md)), dispatched from `src/core/search/conform.ts`.

## Import / export model

The canonical v7 import is an array of value objects (no language key, since the component is non-translatable):

```json
[{"value":"user@example.com"},{"value":"admin@example.com"}]
```

The model-agnostic import engine `conformImportData()` (`src/core/tools/import_data.ts`) accepts:

- **JSON array of value objects** (canonical) — `[{"value":"..."}]`; bare strings inside the array are auto-wrapped into `{"value":...}` (`component_email` is a `VALUE_PROPERTY_MODELS` member).
- **Single value object** — `{"value":"user@example.com"}` (wrapped into an array).
- **Plain string** — `user@example.com` (wrapped into `[{"value": "..."}]`).

!!! warning "Gap: pipe-separated import shape"
    The **pipe-separated string** shape (`user@example.com | admin@example.com`, meant to split into one item per address) is not handled by the generic import engine — a pipe-separated cell is stored verbatim as a single address string, not split. The **lang-keyed object** shape (`{"lg-nolan":["user@example.com"]}`) is a plain JSON object whose first key starts with `lg-`, and the generic engine does handle that shape generically (`conformImportData()`, `src/core/tools/import_data.ts`), wrapping each bare string into `{"value":…}` for value-property models such as this one.

See the dedicated import section [Email](../../using/importing_data.md#email) and the general [importing data](../../using/importing_data.md) reference. For export formats (value / grid_value / `dedalo_raw`) see [exporting data](../../using/exporting_data.md); flat display values are produced by the generic cell resolver `resolveCellValue()` (`src/core/resolve/relation_list.ts`) via `tools/tool_export/server/tool_export.ts`.

## Notes

- **Default tools.** `tool_time_machine`, `tool_replace_component_data`, `tool_add_component_data` (plus `tool_propagate_component_data` when configured). Tools and nested buttons arrive read-only in the `context` toolbar.
- **Mailto helpers.** The single-address **email** button sets `window.location.href = 'mailto:' + value`. The toolbar **email_multiple** button re-runs the builder's (section or portal) search restricted to this component to gather every address across the result set, joins them with `;`, and opens a BCC `mailto:?bcc=...`. These are client-side behaviours; the batch search they depend on runs through the same TS search stack as any other filter.
- **Validation gotcha — server check missing.** The intended contract treats the server-side format check as the authoritative backstop, refusing a save with an invalid address regardless of what the client sent. **No such backstop currently exists** (see the gap noted above under Data model → Validation): rely on the client `verify_email()` alone until server-side validation is implemented.
- **Non-translatable by design.** The component is always resolved under `lg-nolan` (non-translatable). This differs from [component_input_text](component_input_text.md), which can be translatable or transliterated.
- **Related components.** [component_input_text](component_input_text.md) (sibling string component, free text), [component_text_area](component_text_area.md) (multi-line / rich text), [component_dataframe](component_dataframe.md) (frame records when `has_dataframe` is set). See the [components index](index.md) for the full literal/related typology.

