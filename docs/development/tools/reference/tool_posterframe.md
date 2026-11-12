# tool_posterframe

Extracts a posterframe (thumbnail) from an audiovisual file with FFmpeg at a chosen timecode, and optionally attaches that frame as the *identifying image* of a target portal record.

## What it does / why & when to use it

`tool_posterframe` opens on an audiovisual component (`component_av`, also `component_3d`) and gives the cataloguer a player with three actions below it:

- **Create** / **Delete** the component's own *posterframe* — the still image that represents the video in lists, grids and the media player itself.
- **Create identifying image** — grab the frame visible at the current playhead position and push it, as a real `component_image`, into a new record of a related portal that has been declared (in the ontology) as the *identifying image* of this AV's section.

The first two actions are the everyday case: a video has no thumbnail, or its auto-generated thumbnail landed on a black/title frame. The operator scrubs to a representative frame and presses **Create**; FFmpeg writes a poster image alongside the video and the UI refreshes.

The third action solves a heritage-specific problem. In an oral-history archive (`oh1`), an interview record holds the video, but the public catalogue and the related "Person" or "Event" records want a *face* — a representative still. By configuring a portal on the related section with the ontology property `identifying_image` (pointing at the image component that should hold the frame), the cataloguer can, from the interview's video, capture the exact frame where the interviewee is best framed and have the tool create the related record and store that frame as its identifying image — no manual screenshot, crop, upload and re-link.

Concrete scenario: an `oh1` interview video is open. The operator scrubs to `00:14:32`, picks "Person — 318" from the identifying-image selector (offered because that Person section, reached by an inverse reference, exposes a portal with the `identifying_image` property), and presses **Create identifying image**. The tool adds a new element to that portal, extracts the frame to the `original` quality of the target image component, and processes it into the standard image qualities — so the Person record now shows that still wherever its image is displayed.

## How it works

### Server

`tools/tool_posterframe/server/index.ts` exposes exactly two API actions, both declaratively gated `permission: 'record', minLevel: 1`; the media (frame-extract + derivative regen) half reuses the tested `src/core/media/tools/posterframe.ts` core, and the DB portal-create + ontology walk is wired in the module itself.

**`create_identifying_image`** — the full capture-and-attach workflow (`tools/tool_posterframe/server/index.ts::createIdentifyingImage`):

1. **Validate + gate.** The declarative `record`/1 gate covers **read** on the source AV (`options.section_tipo`/`section_id`) before the handler runs. The handler then asserts an **additional imperative write (level 2) gate on the target portal** (`item_value.section_tipo` + `item_value.component_portal`) — a second permission target the declarative single-gate form cannot express: read on the AV source, write on the destination portal.
2. **Create the destination record.** It resolves the portal's target section tipo and creates a new record through the portal via the standard `saveComponentData` path (`changedData: [{action:'add_new_element', ...}]`) — producing the new `section_id` that will hold the image.
3. **Resolve the target image path** on that new record (media-path helpers, `original` quality).
4. **Find the source AV file** via the shared media-tool-context resolver; refuses if the source component isn't `component_av`.
5. **Extract the frame** with `createIdentifyingImageCore` (`src/core/media/tools/posterframe.ts`) — the real ffmpeg extraction core, unit-gated.
6. Returns `{result:true, msg:'OK. Posterframe created successfully', section_id, files_info}` on success; any thrown error is caught and returned as `{result:false, msg, errors}`.

**`get_ar_identifying_image`** — populates the selector (`getArIdentifyingImage`). It requires `section_tipo` + a positive `section_id` (covered by the declarative `record`/1 gate), walks the section's **inverse references** (`findInverseReferences`, `src/core/search/search_related.ts`), and for each referencing section resolves the first `component_portal` in its ontology subtree whose `properties.identifying_image` is set — packaging `{section_id, section_tipo, component_portal, component_image, label}`. Returns the array of all such matches, or `false` when none.

The portal-tipos-in-section walk and the per-section descriptor resolution are internal helpers, not separately exposed actions.

### Client

`tools/tool_posterframe/js/tool_posterframe.js` defines the tool instance; `render_tool_posterframe.js` builds the DOM. The tool restricts itself to AV-ish models (`this.ar_allowed = ['component_av', 'component_3d']`). On `build` it pins `self.main_element` to the `main_element` role of the `ddo_map` (the AV component). On `edit` it rebuilds that component in **`player`** view so the operator can navigate the stream frame by frame, then renders the action buttons beneath it.

Two distinct dispatch paths matter here:

- **Posterframe create/delete** buttons call `self.create_posterframe()` / `self.delete_posterframe()`, which delegate to the **AV component's own** methods (`component_av.prototype.create_posterframe` / `delete_posterframe`). Those hit the **`dd_component_av_api`**, *not* this tool — the tool is only the UI host for them, and they read the frame from the player's `video.currentTime`.
- **Create identifying image** button calls `self.create_identifying_image(item_value, current_time)`, which *does* go to `tool_posterframe` via `dd_tools_api` / `tool_request` (source built by `create_source(self, 'create_identifying_image')`), with `retries:1` and a 120 s timeout. The selector that supplies `item_value` is filled by `self.get_ar_identifying_image()` → the `get_ar_identifying_image` server action.

Both tool actions confirm with the user before running. The posterframe image preview falls back to `page_globals.fallback_image` on load error.

## Actions & options

Both actions declare `permission: 'record', minLevel: 1` — read + record-scope on the **source** AV record. There is no `backgroundRunnable`; both run inline. `create_identifying_image` additionally asserts an **imperative write (level 2) gate on the target portal** inside the handler, since that second permission target (a different section_tipo/tipo pair than the declared one) cannot be expressed by a single declarative spec.

| Action | Permission gate | Key options it reads | Returns (`result`) |
| --- | --- | --- | --- |
| `create_identifying_image` | declarative `record`/1 on the source AV (`section_tipo`, `section_id`) **+** imperative write (2) on `(item_value.section_tipo, item_value.component_portal)` | `tipo` (AV component), `section_tipo`, `section_id` (source AV record); `item_value` `{ section_tipo, section_id, component_portal, component_image }` (the target); `current_time` (timecode, e.g. `"00:14:32.000"` or seconds from the player) | `true` on success (with `msg:'OK. Posterframe created successfully'`, plus `section_id`/`files_info`), else `false` + `errors` |
| `get_ar_identifying_image` | declarative `record`/1 on `section_tipo`/`section_id` | `section_tipo`, `section_id` (the AV's section) | `array` of `{ section_id, section_tipo, component_portal, component_image, label }`, one per inverse-referencing section that exposes a portal with `properties.identifying_image` |

`item_value` for `create_identifying_image` is exactly one element of the `get_ar_identifying_image` result, so the UI round-trips it: read the selector options, then post the chosen one back.

The **ontology property that drives everything** is `identifying_image`, set on the *portal component* of the related section. Its value is the `tipo` of the image component that should receive the frame; the tool returns that as `component_image` and writes into it.

## How it is registered & surfaced

`tools/tool_posterframe/register.json` is a **column-keyed dump** (`string`/`relation`/`misc`/… keyed by component tipo — a seeded matrix-row snapshot, not a hand-authored file); `importTools()` passes it through as-is (see [register.json reference](../register_json.md)). Essentials decoded from its ontology tipos:

- `dd1326` name → `tool_posterframe`; `dd799` label → "Posterframe" (cat/spa/nep/…); `dd612` description → "Manages video posterframe images".
- `dd1327` version → `2.0.3`; `dd1328` `dedalo_version_min` → `6.0.0`; `dd1644` developer → "Dédalo team".
- `dd1330` (affected_models) relations point at AV/3D component models; `dd1331` (show_in_inspector) and `dd1332` (show_in_component) carry the surfacing flags; `dd1354` active → on.

Surfacing is element-driven in `getElementTools` (`src/core/tools/registry.ts`). The tool attaches to **AV (and 3D) components** — it appears inline on the component and/or in the inspector per the `show_in_component` / `show_in_inspector` flags. It is not a section- or area-level tool. The client further guards on `this.ar_allowed` (`component_av`, `component_3d`), and the **Create identifying image** block only renders when the host model is `component_av`. Note that the identifying-image flow additionally requires a related section whose portal carries the `identifying_image` ontology property — without it, `get_ar_identifying_image` returns an empty list and the selector is empty.

## Examples

### Client tool_request (Create identifying image)

Built by `create_source(self, 'create_identifying_image')` and sent through `data_manager.request`:

```js
const rqo = {
    dd_api  : 'dd_tools_api',
    action  : 'tool_request',
    source  : create_source(self, 'create_identifying_image'), // { model:'tool_posterframe', action:'create_identifying_image', ... }
    options : {
        tipo         : 'oh18',          // the AV component
        section_tipo : 'oh1',           // the interview section
        section_id   : 5,               // the interview record
        item_value   : {                // one option returned by get_ar_identifying_image
            section_id       : 318,
            section_tipo     : 'rsc197',     // the related "Person" section
            component_portal : 'rsc205',     // its portal carrying properties.identifying_image
            component_image  : 'rsc29'       // the image component to fill
        },
        current_time : self.main_element.video.currentTime // e.g. 872.4 (seconds)
    }
}
// data_manager.request({ body: rqo, retries: 1, timeout: 120000 })
```

Server reply on success:

```json
{ "result": true, "msg": "OK. Posterframe created successfully", "errors": [] }
```

### Populating the selector (get_ar_identifying_image)

```js
const rqo = {
    dd_api  : 'dd_tools_api',
    action  : 'tool_request',
    source  : create_source(self, 'get_ar_identifying_image'),
    options : { section_tipo: 'oh1', section_id: 5 }
}
// response.result →
// [ { section_id:318, section_tipo:'rsc197', component_portal:'rsc205',
//     component_image:'rsc29', label:'Person' }, ... ]
```

### Ontology configuration that enables the flow

On the related section's portal component, set the ontology property:

```json
"identifying_image": "rsc29"
```

i.e. "frames captured for records reached through this portal are stored in image component `rsc29`". This single property is what `get_ar_identifying_image` matches and `create_identifying_image` writes into.

## Related

- [tool_media_versions](tool_media_versions.md) — manage the qualities/versions the posterframe and identifying image produce (build, rotate, delete, conform headers).
- [tool_import_files](tool_import_files.md) — bulk-ingest media files (incl. AV) and the records that wrap them; [tool_image_rotation](tool_image_rotation.md) rotates/crops the resulting image files.
- [tool_subtitles](tool_subtitles.md), [tool_transcription](tool_transcription.md) — the other AV-centric tools that also host a media player and act on the same `component_av`.
- `component_av` `create_posterframe` / `delete_posterframe` (`dd_component_av_api`, registered in `src/core/api/dispatch.ts`) — the component-level posterframe actions this tool surfaces buttons for (these do **not** go through `tool_posterframe`; TS-ported).
- [Exporting data](../../../using/exporting_data.md) — the export side ([tool_export](tool_export.md)), for context on the wider tools catalog.
- [Creating tools](../creating_tools.md), [Server contract](../server_contract.md), [Security](../security.md) — the tool model, the `ToolServerModule` contract, and the permission rules this tool follows.
- Source: `tools/tool_posterframe/server/index.ts`, `tools/tool_posterframe/register.json`, `tools/tool_posterframe/js/{tool_posterframe,render_tool_posterframe}.js`; the media core: `src/core/media/tools/posterframe.ts`.
