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
- Pressing *Automatic translation* dispatches on the selected engine's `type`. A **`server`** engine (e.g. Babel, Google) calls `tool_lang.prototype.automatic_translation_server()`, which sends the `automatic_translation` request through `dd_tools_api` (long timeout, retries) and refreshes the target component on response. A **`browser`** engine (`browser_transformer`, "Local AI translator") calls `automatic_translation_browser()` → the shared `browser_translation.js` engine, which runs the chosen model entirely in a reused Web Worker (`translators/browser_transformer/browser_transformer.js`: HuggingFace Transformers + ONNX, WebGPU or `wasm`) with a streaming overlay — **no server round-trip and no API action**. The runtime is the registry-served transformers.js bundle (`/dedalo/lib/transformers/`, a digest-pinned vendored tree since 2026-09-04), its WASM glue the local `onnxruntime` pin, and the model files come from the install's **model store** (`/dedalo/ai_models/`, `src/core/ai/model_store.ts` — session-gated, digest-checked, operator-seeded), the same door `tool_transcription` uses; nothing model-shaped lives in the tools tree (gated: `dependency_integrity_tripwire` model-artifact leg, `no_remote_code_tripwire` leg 3).
- **The model catalogue.** The browser engine's entry in `translator_engine` carries a `models` array; the configuration panel offers a *Model* selector (label `engine_<name>`) and a *Quality* selector, shown only for a model pinned at more than one quantisation (a `dtypes` list in its entry; none is yet, so it stays hidden). `tools/tool_lang/js/browser_models.js` holds the same list as the fallback for a stored tool config that predates `models` (gate: `tool_lang_placeholder_repair` — it must equal both `register.json` copies). Every model is pinned by hub revision and per-file sha256 in `src/core/ai/model_pins.json`, with the licence that governs it; `bun run scripts/fetch_ai_models.ts --list` shows them, `scripts/pin_ai_models.ts` is the one way to change a pin. See [The browser model catalogue](#the-browser-model-catalogue) below.
- **Marks and markup in the browser engine.** The model never sees a Dédalo mark (index in/out, tc, svg, geo, page, person, note, reference, lang — the `tr.js` patterns) nor any HTML it could corrupt. `browser_translation.js` replaces each mark with a numbered token `[[[n]]]` in document order (`placeholders.js`), then converts the value to Markdown (`markdown_utils.js`): paragraphs, line breaks, bold and italic become Markdown, and every element with no Markdown form (`<span style>`, `<sup>`, `<a href>`, `<img>`, a table with merged cells, anything unknown) is **shielded** behind tokens too, restored byte-identical. The Markdown is cut into segments of at most 250 characters (`segment_markdown`, paragraph then line then sentence boundaries; a segment's `sep` is the text that preceded it, so the rejoin is exact). Each segment becomes a block (`build_blocks`): emphasis balanced across the cut, the tokens at its edges **hoisted** out (re-attached unchanged after translation, so most marks never reach the model) and the rest renumbered from 1, with a `restore_map` back to the document numbering. A source whose own text already looks like a token (`[[[3]]]`, `[[3]]`, or brackets that would form one around a shielded tag) is refused before the model starts.
- **The worker's block loop** (`block_runner.js`, model-free so it can be tested) sends the model the segment and nothing else: TranslateGemma translates whatever is in its text field, so an instruction or a correction would come back translated, into the record. For each block it unwraps fences or a preamble, normalises tokens the model mangled (`[[5]]`, `[[[ 5 ]]]`, escaped brackets, localised digits) and removes tokens the model invented. A **repetition loop** is retried with a stiffer repetition penalty, then with sampling; a block still looping is lost. Tokens still missing are placed by `repair_placeholders` (open/close pairs first, then sentence-aligned placement) and reported; a token the model wrote twice has **every** copy removed (which one is right is unknowable). A cancel that arrives during the last block ends the run as cancelled, never as finished.
- **Back on the main thread** the translated Markdown becomes HTML with **every character the model wrote escaped** — a translated `<script>` is stored as text — then each token is restored exactly once, inverted shielded-tag pairs and inverted index/reference pairs (`reorder_inverted_pairs`) are put back in order, and `validate_translation` counts the source's marks against the result's.
- **What is saved, and what is refused.** The run **refuses** — saves nothing, restores the target's stored value and rejects — when a block failed, when the result is empty, when any mark or shielded tag is missing, could not be placed, was duplicated or was not in the source, when a mark ended up inside markup instead of text, or when the result is a repetition loop (far longer than its source). The panel then shows *Translation needs review before saving* with one line per kind. A mark the engine had to reposition or reorder, or a token it had to remove, is **saved**, with *Translation saved — check the marks* and the same per-kind lines, and the call resolves `{result: true, msg: 'OK. Translation saved with warnings', warnings: <report>}` instead of `{result: true, msg: 'OK. Translation completed', warnings: null}`; there is no accept/discard step. A model that cannot run here (unsupported language pair, no WebGPU, too large) resolves `{result: false, code}` with a message, and nothing is saved. Lost emphasis (bold, italic) is reported, never a reason to refuse. The labels (`translation_*`, `marks_*`, `emphasis_lost`, `engine_*`, …) are tool-local, in `register.json` `dd1372`, in every catalog language. Gates: `test/unit/tool_lang_placeholder_repair.test.ts` (the block loop, the repair, segmentation, escaping, the catalogue) and the client suite `test_tool_lang_browser_translation` (the whole driver against a stand-in model).

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

- `dd1326` name = `tool_lang`; `dd1327` version (`2.6.0`); `dd1328` minimum Dédalo version (`6.9.0`); `dd1644` developer (`Dédalo team`).
- `dd999` / `dd1633` config (default + sample): `translator_config` (`client:false` — the per-engine `uri` + `key` secrets, kept server-side) and `translator_engine` (`client:true` — the engine picker list: Babel + Google as `server`, "Local AI translator" as `browser`, with its `models` catalogue). Per-install overrides live in the **Tools configuration** section (dd996) under a record named `tool_lang`.
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

## The browser model catalogue

The *Local AI translator* runs one of these models in the browser. The list lives in the browser engine's `models` array in `register.json` (`dd999` and `dd1633`); an installation narrows or extends it in its own tool configuration record.

| `name` | Model (hub id) | Runs on | Quantisation | Licence (pinned) | Offered by default |
| --- | --- | --- | --- | --- | --- |
| `qwen` | `onnx-community/Qwen3-4B-Instruct-2507-ONNX` | WebGPU only | `q4f16` | Apache-2.0 | yes (the default) |
| `translategemma` | `onnx-community/translategemma-text-4b-it-ONNX` | WebGPU only | `q4` | Gemma Terms of Use | yes |
| `nllb` | `Xenova/nllb-200-distilled-600M` | WebGPU or CPU | `q8` | CC-BY-NC-4.0 | **no** |
| `madlad` | `Kutalia/madlad400-3b-mt-onnx` | WebGPU only | `q8` | Apache-2.0 | yes |
| `opus` | `Xenova/opus-mt-{src}-{tgt}` (one model per language pair) | WebGPU or CPU | `q8` | Apache-2.0 (en→de: CC-BY-4.0) | yes |

- **Pins.** Each model is pinned by the hub's commit `revision` and every file's sha256 in `src/core/ai/model_pins.json`, together with the licence record the pin procedure read from the model cards (`card` / `upstream`, `src/core/ai/model_pins.ts::licenceProblems` validates it). The opus pairs are the pairs the hub actually serves among the languages listed in the file's `expansions` entry. A file without a pin is never fetched or served.
- **Not offered by default.** A model whose licence restricts the use is still listed, with `offered_by_default: false` and a `not_offered_reason`; the selector leaves it out. `nllb` is licensed for non-commercial use only. An installation that has confirmed its use is non-commercial enables it in its tool configuration record by setting `offered_by_default: true` on that entry.
- **Seeding.** The weights are not shipped. An administrator downloads the chosen models into the model store with `bun run scripts/fetch_ai_models.ts <model id>` (`--list` shows the catalogue and what is already in the store). A large translator is about 3 GB; an opus pair about 115 MB.
- **Quantisation.** The store serves only pinned files, so a model runs at the quantisation it is pinned at. To offer a second one (TranslateGemma at `q8`), the entry lists both in `dtypes` and each must be pinned; until then the *Quality* selector does not appear.
- **CPU fallback.** A model marked WebGPU-only refuses to start without WebGPU (`needs_webgpu`) instead of loading a multi-gigabyte model into the CPU backend; a small model (`nllb`, `opus`) falls back to the CPU when WebGPU fails.

!!! warning "Untested against the real models"
    The segmentation, hoisting, repair, repetition guard and refusals are tested against a stand-in model: the gates prove what the engine does with whatever a model returns, not how well a given model translates. None of the catalogue models has been run by the test suite (no GPU in CI). Before offering a model to cataloguers, check it by hand:

    1. Seed it (`bun run scripts/fetch_ai_models.ts <model id>`) and open a record whose text field holds index marks, a time code, bold text and a `<sup>` or a link, in a browser with WebGPU.
    2. Run *Automatic translation* into two languages with that model selected.
    3. Compare the source and the target: every mark present once and around the right words, the formatting kept, no repeated phrases. A run the engine refuses or saves with warnings shows why in the panel.

## Related

- `tool_lang_multi` — translate one source component into *several* target languages in a single run; its own `server/index.ts` action calls the same shared `runAutomaticTranslation(ctx, 'tool_lang')` core (so behavior and config resolution are identical to `tool_lang`'s) and shares the in-browser engine (`tools/tool_lang/js/browser_translation.js`).
- [tool_transcription](tool_transcription.md) / [tool_subtitles](tool_subtitles.md) — other text/media-content tools that, like `tool_lang`, can use external/AI engines (Babel, Whisper).
- [tool_export](tool_export.md) · [Exporting data](../../../using/exporting_data.md) — the read-only counterpart for getting (translated) data out of a section.
- [Creating new tools](../creating_tools.md) · [Server contract](../server_contract.md) — the tool model, `apiActions`, permission gates and config resolution this page builds on.
- Source: `tools/tool_lang/server/index.ts`, the shared translation core `src/core/tools/translation.ts` (`runAutomaticTranslation`, `babelProvider`, `resolveTranslationProvider`), `tools/tool_lang/js/{tool_lang,render_tool_lang,browser_translation,placeholders,block_runner,markdown_utils,browser_models,translator_engine_select}.js`, `tools/tool_lang/translators/browser_transformer/browser_transformer.js`, `src/core/ai/model_pins.json`, `tools/tool_lang/register.json`.
