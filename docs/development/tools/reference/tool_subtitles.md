# tool_subtitles

A two-pane subtitle workbench: edits the transcription of an audiovisual record alongside its media player and turns timecoded transcript text into VTT-ready subtitle blocks. UI-only — no remotely callable server methods.

## What it does / why & when to use it

`tool_subtitles` opens on a **transcription text component** (a `component_text_area`) and gives the cataloguer a dedicated editing surface for producing subtitles from that transcription. The left pane is the editable transcript, broken into per-line CKEditor blocks (one rich-text editor per subtitle line, plus dedicated timecode (`tc`) blocks); the right pane is the **media player** for the same record (the AV component), with playback controls geared to transcription work: a play-speed slider, configurable keyboard shortcuts for play/pause, auto-rewind seconds, and timecode-tag insertion, and a *Build subtitles* control with a *characters per line* setting. The goal is to keep the operator's hands on the keyboard while listening: tap a key to pause-and-rewind, type the line, insert a timecode at the playhead, and let the tool segment the text into subtitle lines that can later be served as **VTT**.

It deliberately carries **no server logic of its own**. All the heavy lifting it needs already lives in core: the transcription text is a normal `component_text_area`, the player is a normal `component_av`, the subtitle model is stored in a `component_json`, and the rich-text editing and segmentation are provided by the shared **`service_ckeditor`** / **`service_subtitles`** services. The tool is the glue that arranges those three components side by side and wires the editing services to them.

Concrete heritage scenario: an oral-history archive has digitized interviews, each with a verbatim transcription kept in a text-area component and timecode tags (`[TC_..._TC]`) marking where each passage occurs in the recording. To publish accessible, captioned video, an editor opens the transcription record, presses the **Subtitles** button on the transcription component, and gets the interview's audio/video on the right next to the transcript on the left. They set the play/pause key to `Escape` and auto-rewind to 3 seconds, play the clip, correct the wording line by line in the inline editors, and adjust *characters per line* to 42 before pressing *Build subtitles* — producing the per-line, timecoded blocks that become the VTT subtitle track for the published interview.

Use it when: someone is producing or correcting subtitles/captions from an existing timecoded transcription of an AV record. It is **not** an importer or a batch process, and it is not where automatic speech-to-text happens — generating the raw transcription (Whisper/Babel) belongs to [`tool_transcription`](#related); shifting all timecodes by an offset belongs to `tool_tc`; rendering a printable transcript or a finished VTT belongs to `tool_tr_print`.

## How it works (server + client)

**Server.** `tools/tool_subtitles/` ships **no `server/` package** — confirmed: there is no `tools/tool_subtitles/server/` directory, so `dd_tools_api.tool_request` refuses any action named against this tool at dispatch gate 5, `tool has no server module`. There is no `backgroundRunnable`, no `isAvailable`/`onRegister`/`onRemove`, and no business logic on the server. `register.json` exists only to (a) carry the registry record (version, label, localized UI labels) and (b) declare the `affected_tipos` restriction. All behavior is client-side, and any data writes happen through the **components** the tool hosts (the text-area save, the json save), not through the tool.

**Client (JS).** `tools/tool_subtitles/js/` holds the real behavior, following the standard `tool_common` lifecycle:

- `tool_subtitles.js` is the instance. `init()` calls `tool_common.prototype.init`, then fixes the working languages (`page_globals.dedalo_projects_default_langs`) and the source language from the caller, and selects `service_ckeditor` as its text-editor service. `build()` calls the common build, then resolves three component instances from the tool's `tool_config.ddo_map`: the **transcription** component (the caller `component_text_area`), the **media** component (the entry whose `role === "media_component"`, an `component_av`), and the **subtitles** component (the entry whose `role === "subtitles_component"`, a `component_json` that stores the per-line subtitle model). It then loads the existing subtitle data for the current language via `get_subtitles_data(lang)`, which reads `subtitles_component.data.value[0][lang]` and, when empty, seeds an empty model from the raw transcription text.
- `render_tool_subtitles.js` builds the DOM. `edit()` produces a two-column layout: a **`left_container`** with the per-line subtitle nodes (each text line gets its own `service_ckeditor` instance with a `bold / italic / underline / undo / redo / Save` toolbar; `tc` lines render as editable timecode blocks), and a **`right_container`** with the media component in `player` mode. For `component_av` media it adds the play-speed slider and the keyboard/rewind controls — the play/pause key, auto-rewind seconds, and insert-tag key are persisted in `localStorage` (`av_playpause_key`, `av_rewind_secs`, `tag_insert_key`) and pushed onto `component_text_area.features.context.av_player` — plus the *Build subtitles* button and the *characters per line* input (`subtitles_characters_per_line`, default 90). The header carries a **language selector** (re-loads and re-renders the left pane for the chosen language) and, if the user is authorized for it, a **Time Machine** button that calls `open_tool({ tool_context: tool_tm, caller: self.caller })`. An `activity_info` panel subscribes to the `save` event to show save notifications.

The tool reaches its sibling components purely through `tool_config.ddo_map` (resolved by `tool_common`), and reaches Time Machine through `get_user_tools(['tool_time_machine'])`, which calls the **tools API** action `user_tools` (an action of `dd_tools_api`, *not* of `tool_subtitles`) to discover whether the current user may open it.

## Actions & options

`tool_subtitles` itself exposes **no** API actions:

| `apiActions` | Form | Notes |
| --- | --- | --- |
| *(no server module)* | — | UI-only tool. No action is dispatchable through `dd_tools_api`; a `tool_request` naming this tool is refused at dispatch gate 5. There is **no** `backgroundRunnable` and no lifecycle-hook override. |

Because there are no server actions, the meaningful "options" are the **client** inputs the tool reads — the `ddo_map` roles that wire it to its components, and the user preferences it persists. Key client-side parameters:

| Where read | Key / field | Purpose |
| --- | --- | --- |
| `tool_config.ddo_map` | role `media_component` → `tipo` | Resolves the AV (`component_av`) instance shown in the player pane. |
| `tool_config.ddo_map` | role `subtitles_component` → `tipo` | Resolves the `component_json` instance that stores the subtitle model. |
| caller | the `component_text_area` instance | The transcription being edited (left pane); also `self.transcription_component`. |
| `subtitles_component.data.value[0][lang]` | per-language subtitle array | Source of the editable line model (`self.ar_value`); empty → seeded from transcript text. |
| `localStorage` | `av_playpause_key` (default `Escape`) | Keyboard code that pauses + rewinds the player while transcribing. |
| `localStorage` | `av_rewind_secs` (default `3`) | Seconds the player rewinds on pause. |
| `localStorage` | `tag_insert_key` (default `F2`) | Keyboard code that inserts a timecode tag at the playhead. |
| `localStorage` | `subtitles_characters_per_line` (default `90`) | Max characters per subtitle line for *Build subtitles*. |

The tool does make one server call from the client, but it targets the **shared tools API**, not this class:

| Client method | API | Action | Reads | Purpose |
| --- | --- | --- | --- | --- |
| `get_user_tools(['tool_time_machine'])` | `dd_tools_api` | `user_tools` | `options.ar_requested_tools` | Returns the simple tool-context for each requested tool the user is authorized for; used to decide whether to show the Time Machine button in the header. |

## How it is registered & surfaced

`tools/tool_subtitles/register.json` is a **column-keyed dump** (`string`/`relation`/`misc`/… keyed by component tipo — a seeded matrix-row snapshot, not a hand-authored file); `importTools()` passes it through as-is (see [register.json reference](../register_json.md)). The essentials it carries:

- `dd1326` name = `tool_subtitles`; `dd1327` version (`1.0.1`); `dd1328` minimum Dédalo version (`6.0.0`); `dd1644` developer (`Dédalo team`); `dd612` description (*"Create and edit the subtitles of a transcript to use them in VTT format"*, localized across project languages).
- `dd799` label = *Subtitles* (localized: `Subtítols` / `Untertitel` / `Υπότιτλος` / `Subtitles` / `Sous-titres` / `Sottotitolo` / `Subtítulos`).
- `dd1350` `affected_tipos` = `["rsc36"]` — the tool is restricted to that transcription text component tipo.
- `dd1335` `properties` = `{ "open_as": "window", "windowFeatures": null }` — the tool opens **as its own window** (it needs the room for the two-pane editor + player), not as a modal.
- `dd1353` *simple tool object* mirrors the surfacing flags: `affected_models: ["component_text_area"]`, `affected_tipos: ["rsc36"]`, `show_in_component: true`, `show_in_inspector: false`, `always_active: false`, `requirement_translatable: true`.

**Where it appears.** Surfacing is element-driven through the section/component tool filter: the button attaches to a **`component_text_area`** whose tipo is `rsc36`, and renders **inline on that component** (`show_in_component: true`) rather than in the section inspector (`show_in_inspector: false`). Because `require_translatable` is set, it only shows on translatable instances. Profile authorization applies as for any tool (superusers see it; otherwise it must be granted on the profile's Tools).

## Examples

The tool is UI-only, so there is no `tool_request` to `tool_subtitles`. The only server round-trip the client makes is the tools-API `user_tools` probe used to gate the in-header Time Machine button (as built in `get_user_tools`):

```js
// Ask the tools API which of these tools the current user may open
const rqo = {
    dd_api  : 'dd_tools_api',
    action  : 'user_tools',
    source  : create_source(self, 'user_tools'),
    options : { ar_requested_tools : ['tool_time_machine'] }
}
const response  = await data_manager.request({ body: rqo })
const tool_tm   = response.result.find(el => el.name === 'tool_time_machine')
// if tool_tm is present → render the Time Machine button in the header
```

Opening Time Machine from that button reuses the shared client helper (no extra server action of its own — `open_tool` resolves and launches the other tool against the same caller):

```js
import {open_tool} from '../../tool_common/js/tool_common.js'

open_tool({
    tool_context : tool_tm,     // the simple tool-context returned above
    caller       : self.caller  // the transcription component being edited
})
```

The subtitle model the tool edits lives on the `subtitles_component` (a `component_json`), read per language during `build()`:

```js
// self.subtitles_component.data.value[0] is keyed by language
const original_ar_value = self.subtitles_component.data.value[0]
self.ar_value = original_ar_value[lang] && original_ar_value[lang].length
    ? original_ar_value[lang]   // existing subtitle lines for this language
    : []                        // none yet → seed from the transcript text
```

## Related

- [Creating new tools](../creating_tools.md) — the end-to-end tool tutorial.
- [Server contract](../server_contract.md) — the `ToolServerModule` contract; note that a UI-only tool ships no `server/` package at all, and that lifecycle hooks are never listed inside `apiActions`.
- [Tools catalog](index.md) — index of all per-tool reference pages.
- Transcription/subtitle siblings: **`tool_transcription`** (generates the raw transcription via Whisper/Babel and the AV plumbing this tool builds on), **`tool_tc`** (offsets all `[TC_..._TC]` timecode tags in the transcript), **`tool_tr_print`** (renders printable transcripts and finished VTT subtitles). These do not yet have dedicated reference pages — see the [tools catalog](index.md).
- [`tool_time_machine`](tool_time_machine.md) — the audit/history tool surfaced from this tool's header for reverting transcript edits.
- The components this tool hosts: [`component_text_area`](../../../core/components/component_text_area.md) (the transcription), [`component_av`](../../../core/components/component_av.md) (the media player), [`component_json`](../../../core/components/component_json.md) (the subtitle model store).
- Shared editing services: `service_ckeditor` and `service_subtitles` under `core/services/` (see [Services](../../../core/system/services.md)).
- The *other* way data leaves Dédalo: [`tool_export`](tool_export.md) and the core guide [Exporting data](../../../using/exporting_data.md).
