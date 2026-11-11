# tool_lang_multi

Translates one source text component into **every** configured project language in a single view, delegating each translation to the same core that powers `tool_lang`.

## What it does / why & when to use it

`tool_lang_multi` renders one editable instance of the same text component per project language, side by side, so a cataloguer can review and fill every language at once. It adds two batch affordances on top of the single-pair workflow of [tool_lang](tool_lang.md):

- a **per-language translate button** injected into each language column, and
- a **translate-all** button that fans the current source out to every other language in one action (with an overwrite/skip choice).

Reach for it when a component needs to be populated across many languages from one written source — for example a museum whose *Objects* catalogue publishes in eight languages and wants the Spanish *Description* propagated to all of them in one pass. For a focused, one-language-at-a-time edit with the source pinned beside the target, use `tool_lang` instead.

The tool supports the same two engine families as `tool_lang`: a **server** engine (Babel / Google), which reaches the server action below, and a **browser** engine (the shared in-page `browser_translation.js` worker running the TranslateGemma 4B ONNX model), which never calls the server. The engine list and its secrets come from `tool_lang`'s configuration — this tool ships no config of its own.

## How it works (server + client)

**Server** (`tools/tool_lang_multi/server/index.ts`). The module declares a single action, `automatic_translation`, whose handler is a one-line delegation to the shared core:

```ts
export const tool: ToolServerModule = {
	name: 'tool_lang_multi',
	configFrom: 'tool_lang', // the client context carries tool_lang's engine list
	apiActions: {
		automatic_translation: {
			permission: null,
			handler: async (ctx) => (await runAutomaticTranslation(ctx, 'tool_lang')) as ToolResponse,
		},
	},
};
```

Because it calls `runAutomaticTranslation(ctx, 'tool_lang')` (`src/core/tools/translation.ts`), the server behavior — the imperative `record`/2 permission gate, the source-value read, the target-value write, and the config resolution — is **identical** to `tool_lang`'s, and the engine list is read from `tool_lang`'s configuration (dd996 / dd1633), not from `tool_lang_multi`. `configFrom: 'tool_lang'` makes the client context carry the same engine list (`tool_lang`'s `client:true` config keys); without engines the translate buttons are not rendered. The "multi" is a **client-side affordance**: the browser fires one `automatic_translation` request per target language. See [tool_lang](tool_lang.md) for the full description of the core gate and provider seam.

**Client** (`tools/tool_lang_multi/js/`):

- `tool_lang_multi.js` is the instance. `init()` clones `page_globals.dedalo_projects_default_langs`, sorts the caller's language to the front, and adds a synthetic `lg-nolan` entry when the caller component is no-lang. `build()` resolves the `ddo_map` `main_element` role and restores the last-used engine from local DB (`translator_engine_select` in the `status` table). `get_component(lang)` clones the `main_element` context per language so each column is an isolated editable instance.
- `render_tool_lang_multi.js` builds the grid: a top bar (translate-all button + the engine picker shared with `tool_lang`, `tools/tool_lang/js/translator_engine_select.js`), a shared status banner, and one column per language. The **edited** column becomes the translation source (`set_source_lang`, wired on `input` only — focusing a column does not, so its own translate button can target it), highlighted with the `source` / `bold` CSS classes. `resolve_source_lang(exclude)` falls back to the first language with text when the current source is empty ("empty" strips markup, like the server). Each column's own translate button (in the component's button bar) translates the source into that language; it refuses a blank source and asks before overwriting text. A column being translated is dimmed with a spinner (`set_slot_busy`, `.translating`).
- `translate_target()` dispatches per target: a browser engine runs `run_browser_translation()` (the shared worker); a server engine calls `automatic_translation()`, which builds the `dd_tools_api` `tool_request` and refreshes the target column on response.
- `automatic_translation_all()` translates the source into every other language. It offers an overwrite/skip modal (Alt+click overwrites without asking), aborts early if the columns are still loading or the source is empty, counts a refused language (e.g. `translation.empty_result`) as failed and names it in the summary, and schedules work by engine type: the **browser** engine runs one language at a time (single shared worker/GPU); the **server** engine runs in bounded-concurrency batches of `SERVER_CONCURRENCY` (4). `destroy()` calls `dispose_browser_worker()` to release the ONNX model.

## Actions & options

| Action | Permission gate | Background | Reads from `options` |
| --- | --- | --- | --- |
| `automatic_translation` | `permission: null` + imperative `record`/2 gate (section-level permission + record-in-scope) inside `runAutomaticTranslation`; refuses if `component_tipo`, `section_tipo` or `target_lang` missing | no | see below |

There is no `backgroundRunnable`. Each call runs synchronously with a long client timeout (3600 s, `retries: 1`). The browser engine and the per-column source tracking are client-only and reach no server action.

Options read by `automatic_translation` (same contract as `tool_lang`, one target per call):

| Option | Type | Meaning |
| --- | --- | --- |
| `component_tipo` | string (req.) | The text component to translate. Missing → `invalid_request`. |
| `section_tipo` | string (req.) | Section type of the component. Write-gated. Missing → `invalid_request`. |
| `section_id` | int | Record id holding the component; adds the per-record scope assert. |
| `source_lang` | string | Source language code; defaults to `DEDALO_DATA_LANG`. |
| `target_lang` | string | Target language code; the translated value is saved here. |
| `translator` | string | Engine name resolved against the `tool_lang` config (`'babel'` default). |
| `config` | object | Optional translator-config object from the client; the server prefers the stored config. |

Response: `{ result: bool, msg: string, errors: string[] }`.

## How it is registered & surfaced

`tools/tool_lang_multi/register.json` is a **column-keyed dump** (`string`/`relation`/`misc`/… keyed by component tipo — a seeded matrix-row snapshot, not a hand-authored file); `importTools()` passes it through as-is (see [register.json reference](../register_json.md)). What it carries:

- `dd1326` name = `tool_lang_multi`; `dd1327` version `2.0.2`; `dd1328` minimum Dédalo version `6.0.0`; `dd1644` developer = "Dédalo team".
- `dd799` label = *Multi-language*; `dd612` description = "Tool to translate the content to any other configured language."; `dd1362` a config help note.
- `dd1372` labels supply the localized UI strings (`automatic_translation`, `translate_all_confirm`, `skip_non_empty`, `overwrite`, `cpu_device`, `loading`, `empty_source`, `translation_completed`, …).
- The affected_models / show_in_inspector / show_in_component / require_translatable / active flags (`dd1330` / `dd1331` / `dd1332` / `dd1333` / `dd1354`) appear as **relations** to their ontology records in this dump rather than as inline values. There is **no** `dd1350` affected_tipos and **no** per-tool config record — the engine list is resolved from `tool_lang`.

**Surfacing** (`getElementTools`, `src/core/tools/registry.ts`): the tool applies to translatable text components (its `affected_models` set) and renders **inline on the component** (`show_in_component`). The shipped component samples that carry it are `component_input_text`, `component_text_area` and `component_iri` (see their `samples/context.json`). It appears as a second button next to the single-language `tool_lang` translate button.

## Examples

The per-target client request (`tool_lang_multi.js::automatic_translation`) — the browser fires one of these per language:

```js
const source = create_source(self, 'automatic_translation') // → tool_lang_multi::automatic_translation
const rqo = {
    dd_api  : 'dd_tools_api',
    action  : 'tool_request',
    source  : source,
    options : {
        source_lang    : 'lg-spa',                // translate FROM Spanish
        target_lang    : 'lg-eng',                // …INTO one target (looped per lang)
        component_tipo : self.main_element.tipo,
        section_id     : self.main_element.section_id,
        section_tipo   : self.main_element.section_tipo,
        translator     : 'babel',                 // engine name from the tool_lang config
        config         : self.context.config
    }
}
const api_response = await data_manager.request({ body: rqo, retries: 1, timeout: 3600 * 1000 })
// api_response → { result:true, msg:'OK…', errors:[] }
```

For the translate-all run, `automatic_translation_all()` loops the configured languages (except the source) and calls the above once per target — serially for the browser engine, in batches of four for a server engine.

## Related

- [tool_lang](tool_lang.md) — the single source→target editor; `tool_lang_multi` reuses its translation core (`runAutomaticTranslation(ctx, 'tool_lang')`), its engine list, and its in-browser worker (`tools/tool_lang/js/browser_translation.js`).
- [tool_transcription](tool_transcription.md) / [tool_subtitles](tool_subtitles.md) — other text/media tools that use external/AI engines.
- [Creating new tools](../creating_tools.md) · [Server contract](../server_contract.md) — the tool model, `apiActions`, permission gates and config resolution this page builds on.
- Source: `tools/tool_lang_multi/server/index.ts`, the shared translation core `src/core/tools/translation.ts` (`runAutomaticTranslation`), `tools/tool_lang_multi/js/{tool_lang_multi,render_tool_lang_multi}.js`, `tools/tool_lang_multi/register.json`.
