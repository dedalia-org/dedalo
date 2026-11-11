# tool_lang

Side-by-side multilingual editing of a single text component, with one-click automatic translation of its data from a source language to a target language using a configured translation engine.

## What it does / why & when to use it

`tool_lang` opens a two-pane editor on **one text component of one record**: the left pane shows the component's value in a *source* language (read-only), the right pane the same component in a *target* language (editable). The cataloguer picks both languages from the language selects, then either:

- presses **Automatic translation** to fill the target from the source through a translation engine, or
- presses **Copy to target** to copy the source value verbatim (useful as a starting point for hand-translation, or for non-translatable strings).

The point is that Dédalo stores every textual value per language (`lg-eng`, `lg-spa`, …) on the same component. `tool_lang` makes maintaining those parallel values a focused, comparison-driven task instead of switching the whole record's interface language back and forth.

Concrete heritage scenario: a museum publishes its *Objects* catalogue trilingually. A curator has written the long *Description* (a `component_text_area`) in Spanish but the English and Catalan versions are empty. They open `tool_lang` on that Description, set **Source language = Spanish**, **Target language = English**, choose the **Babel** engine and press *Automatic translation*; the English value is produced by the external machine-translation service and saved on the component. The curator then switches the target select to **Catalan**, repeats, and lightly edits each machine draft in place. For a single record, this is the day-to-day translation workflow; to translate a component into *many* languages at once, see [tool_lang_multi](#related).

Use it when: a record's text component needs a translated (or copied) value in another language, edited with the source visible alongside. Do not use it for bulk translation across many records (no such action exists here) or for non-text components.

## How it works (server + client)

The tool is **element-driven and component-scoped**: it is wired onto a specific text component through that component's ontology `properties->tool_config->tool_lang`, whose `ddo_map` declares the roles the client reads. The heavy lifting is split between a server engine (online services) and a client engine (in-browser AI).

**Client** (`tools/tool_lang/js/`):

- `tool_lang.js` is the instance. `init()` loads the project default languages (adding `lg-nolan` when the caller component is no-lang) and restores the last-used engine from local DB (`translator_engine_select` in the `status` table). `build()` resolves the `ddo_map` roles into live component instances — `main_element` (the source component), `target_component` (a second instance of the same component bound to the target lang, created via `load_component` with `id_variant:'target_component'`), and optional `status_user_component` / `status_admin_component` — and restores the last target lang (`tool_lang_target_lang`).
- `render_tool_lang.js` builds the two-pane edit UI: source select + read-only source component on the left, target select + editable target component on the right, plus the **Automatic translation** block (engine `<select>`, run button, gear-toggled configuration with a CPU/`wasm` device checkbox) and the **Copy to target** button. Copy writes `source.data.value` onto the target component and saves it per item.
- Pressing *Automatic translation* dispatches on the selected engine's `type`. A **`server`** engine (e.g. Babel, Google) calls `tool_lang.prototype.automatic_translation_server()`, which sends the `automatic_translation` request through `dd_tools_api` (long timeout, retries) and refreshes the target component on response. A **`browser`** engine (`browser_transformer`, "Local AI translator") calls `automatic_translation_browser()` → the shared `browser_translation.js` engine, which runs the TranslateGemma 4B model entirely in a reused Web Worker (HuggingFace Transformers + ONNX, WebGPU or `wasm`) with a streaming overlay — **no server round-trip and no API action**. The runtime is the registry-served transformers.js bundle (`/dedalo/lib/transformers/`, a digest-pinned vendored tree since 2026-09-04), its WASM glue the local `onnxruntime` pin, and the model files (`onnx-community/translategemma-text-4b-it-ONNX`) come from the install's **model store** (`/dedalo/ai_models/`, `src/core/ai/model_store.ts` — session-gated, digest-checked, operator-seeded), the same door `tool_transcription` uses; nothing model-shaped lives in the tools tree (gated: `dependency_integrity_tripwire` model-artifact leg, `no_remote_code_tripwire` leg 3).

**Server** (`tools/tool_lang/server/index.ts`, delegating to the shared core `src/core/tools/translation.ts::runAutomaticTranslation`): the single action `automatic_translation`:

1. Gates imperatively — `apiActions` declares `permission: null` (the shared core's own `assertActionPermission` call does the real gating, reusing the `record`/2 kind against `{section_tipo, section_id}`). Note the `record` gate's scope: it always checks the permission level on `(section_tipo, section_tipo)` — the section-level permission — not on the specific component tipo. A profile that grants section-level write but denies write specifically on this component (or vice versa) is not distinguished by this gate. The gate also asserts the record is in the caller's project scope.
2. Loads the tool config (`getToolConfig('tool_lang')`) and finds the requested engine's entry by `name`; refuses if its `uri`/`key` is missing.
3. Reads the component's source-lang value and translates it. `babel` (the default) is a SSRF-guarded HTTP call to the configured Apertium-based Babel service (`babelProvider`, direction mapping like `sp-en`); other server-side engines resolve through the same provider-seam contract (`resolveTranslationProvider`); `browser_transformer` is rejected on the server (client-only).
4. Writes the translated value onto the target-lang instance of the same component and surfaces a "Quota exceeded"-style message when the engine reports it. A result with no visible text for a source item that has some (`isEmptyTranslation`; markup is not text) is **refused**: nothing is written and the request fails with `translation.empty_result` (what Babel answers for an unsupported language pair; WC-2026-11-10-translation-empty-result). Both tools show translation refusals in their own panel (`translation.*` → `silent` page policy, registered by `tools/tool_lang/js/translator_engine_select.js`, the engine picker both tools share).

## Actions & options

`apiActions = { automatic_translation: { permission: null, handler: ... } }` — the gate lives inside the shared `runAutomaticTranslation` core, not the dispatcher's declarative layer — see the note above. There is no `backgroundRunnable`; the request runs synchronously with a long client timeout. Copy-to-target and the in-browser engine are **client-only** and reach no server action.

| Action | Permission gate | Background | Reads from `options` |
| --- | --- | --- | --- |
| `automatic_translation` | `permission: null` + imperative `record`/2 gate (section-level permission + record-in-scope) on `{section_tipo, section_id}`, inside `runAutomaticTranslation`; refuses if `component_tipo`, `section_tipo` or `target_lang` missing | no | see below |

Options read by `automatic_translation`:

| Option | Type | Meaning |
| --- | --- | --- |
| `component_tipo` | string (req.) | The text component to translate. Missing → `invalid_request`. |
| `section_tipo` | string (req.) | Section type of the component. Missing → `invalid_request`. Write-gated. |
| `section_id` | int | Record id holding the component. When present, adds the per-record scope assert and selects the exact record's data. |
| `source_lang` | string | Source language code; defaults to `DEDALO_DATA_LANG`. Read side. |
| `target_lang` | string | Target language code; the translated values are saved here. |
| `translator` | string | Engine name resolved against the tool config (`'babel'` default, `'google_translation'` not implemented, `'browser_transformer'` server-rejected). |
| `config` | object | Optional translator-config object passed from the client; the server prefers the stored tool config (dd996/dd1633). |

Response: `{ result: bool, msg: string, errors: string[] }`, plus a `debug` object (`translated_data`, `raw_result`) when `SHOW_DEBUG===true`.

## How it is registered & surfaced

`tools/tool_lang/register.json` is a **column-keyed dump** (`string`/`relation`/`misc`/… keyed by component tipo — a seeded matrix-row snapshot, not a hand-authored file); `importTools()` passes it through as-is (see [register.json reference](../register_json.md)). What it carries:

- `dd1326` name = `tool_lang`; `dd1327` version (`2.5.0`); `dd1328` minimum Dédalo version (`6.9.0`); `dd1644` developer (`Dédalo team`).
- `dd999` / `dd1633` config (default + sample): `translator_config` (`client:false` — the per-engine `uri` + `key` secrets, kept server-side) and `translator_engine` (`client:true` — the engine picker list: Babel + Google as `server`, "Local AI translator" as `browser`). Per-install overrides live in the **Tools configuration** section (dd996) under a record named `tool_lang`.
- `dd1335` properties = `{ "open_as": "window" }` → the tool opens in its own window.
- `dd1372` labels supply the localized UI strings (`automatic_translation`, `source_lang`, `target_lang`, `copy_to_target`, progress/status strings, …) across all project languages.

**Surfacing** (in `getElementTools`, `src/core/tools/registry.ts`): the register.json declares **no** `affected_models` / `affected_tipos` and no `show_in_inspector` / `show_in_component` flags. `tool_lang` is therefore attached the **element-`properties` way**: a text component whose ontology `properties->tool_config->tool_lang` names the tool (and supplies the `ddo_map` with the `main_element` / `target_component` / status roles) gets the *Translation* button. In other words it appears **inline on the configured text component**, not as a blanket section/area tool.

## Examples

Client-side request built by `tool_lang.js::automatic_translation_server` and dispatched through `dd_tools_api`:

```js
const source = create_source(self, 'automatic_translation') // → tool_lang::automatic_translation
const rqo = {
    dd_api  : 'dd_tools_api',
    action  : 'tool_request',
    source  : source,
    options : {
        source_lang    : 'lg-spa',                 // translate FROM Spanish
        target_lang    : 'lg-eng',                 // …INTO English
        component_tipo : self.main_element.tipo,    // e.g. the Description component
        section_id     : self.main_element.section_id,
        section_tipo   : self.main_element.section_tipo,
        translator     : 'babel',                  // engine name from tool config
        config         : self.context.config
    }
}
// long timeout: machine translation of a long text can take a while
const response = await data_manager.request({ body: rqo, retries: 5, timeout: 3600 * 1000 })
// response → { result:true, msg:'OK. Request done [automatic_translation]', errors:[] }
```

Engine selection (the data the client reads from `translator_engine`, `client:true`):

```json
[
  { "name": "babel",               "type": "server",  "label": "Babel" },
  { "name": "google_translation",  "type": "server",  "label": "Google translator" },
  { "name": "browser_transformer", "type": "browser", "label": "Local AI translator" }
]
```

A `server` engine triggers the `automatic_translation` API action above; a `browser` engine runs the in-page Web Worker model and never calls the server. The matching secret per `server` engine lives in `translator_config` (`client:false`):

```json
{ "name": "babel", "uri": "https://babel.render.es/babel_engine/", "key": "•••" }
```

## Related

- `tool_lang_multi` — translate one source component into *several* target languages in a single run; its own `server/index.ts` action calls the same shared `runAutomaticTranslation(ctx, 'tool_lang')` core (so behavior and config resolution are identical to `tool_lang`'s) and shares the in-browser engine (`tools/tool_lang/js/browser_translation.js`).
- [tool_transcription](tool_transcription.md) / [tool_subtitles](tool_subtitles.md) — other text/media-content tools that, like `tool_lang`, can use external/AI engines (Babel, Whisper).
- [tool_export](tool_export.md) · [Exporting data](../../../core/exporting_data.md) — the read-only counterpart for getting (translated) data out of a section.
- [Creating new tools](../creating_tools.md) · [Server contract](../server_contract.md) — the tool model, `apiActions`, permission gates and config resolution this page builds on.
- Source: `tools/tool_lang/server/index.ts`, the shared translation core `src/core/tools/translation.ts` (`runAutomaticTranslation`, `babelProvider`, `resolveTranslationProvider`), `tools/tool_lang/js/{tool_lang,render_tool_lang,browser_translation}.js`, `tools/tool_lang/register.json`.
