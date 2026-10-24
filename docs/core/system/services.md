# services

> See also: [Architecture overview](../architecture_overview.md) · [Components](../components/index.md) · [Tools](../../development/tools/creating_tools.md) · [common](common.md)

The `core/services/` subsystem holds small, mostly client-side runtime objects that package a piece of shared interface/logic (file upload, rich-text editing, autocomplete search, …) so that **many** components, sections and tools can reuse it without re-implementing it.

!!! note "A service is not an *external service*"
    "Service" on this page means a reusable **client-side** interface module.
    It is unrelated to an [external record service](external_services.md) — the
    server-side subsystem that resolves a record from a third-party catalogue —
    which has its own ontology configuration, its own outbound controls and no
    client module at all. The two words collide by history; the pages do not.

This page is the **subsystem reference** for `core/services/`. A service is not a
section or a component — it does not live in the ontology and it has no `tipo`.
It is a reusable helper instanced *by* a component, section or tool and wired to
its **caller**. Read [Components](../components/index.md) first for the
component/datum model these services plug into.

!!! note "Services are client modules; their server side is the generic API"
    Services are **vanilla-JS client modules**, living at
    `client/dedalo/core/services/`. Their *server* side is whatever generic API
    action they call, served by the dispatch registry
    (`src/core/api/dispatch.ts`) — there is no service-specific endpoint. The
    paths written `core/services/<service>/…` below are client-relative.

## Role

A **service** is a self-contained interface-plus-logic module that is shared
between unrelated callers. Where a [component](../components/index.md) is the
abstraction of a *field* and a [tool](../../development/tools/creating_tools.md)
is a discrete *task*, a service is the **shared building block underneath them**:
the same upload machinery powers `component_3d`, `tool_upload` and
`tool_import_dedalo_csv`; the same CKEditor wrapper powers `component_text_area`;
the same autocomplete search powers every relational component.

Services are **entirely client-side** (ES6 modules under `<service>/js/`). They are
*not* ontology nodes and have **no server model** of their own: their server side
is whatever generic API action they call — `get_system_info`, `upload`,
`join_chunked_files_uploaded`, the read API — each a handler in the dispatch
registry (`src/core/api/dispatch.ts`).

A client service object reuses the shared `common` JS prototype the same way a
component does — it borrows `common.prototype.render` / `destroy` / `refresh` /
`init` — but it is instanced through the same factory with a `service_`-prefixed
model, **not** declared in the ontology:

```javascript
// instances.js resolves the module path from the model prefix:
//   tool_*     -> ../../../tools/<model>/js/<model>.js
//   service_*  -> ../../../core/services/<model>/js/<model>.js   <-- services
//   (default)  -> ../../../core/<model>/js/<model>.js
```

!!! note "A service is not a component"
    Services have no ontology `tipo`, no `properties`, no record data and no
    typed-JSONB column. They carry a `caller` reference and operate **on the
    caller's behalf** — reading the caller's `context`/`request_config`, calling
    the caller's `save_value()`, or publishing events the caller subscribes to.
    Two services (`service_autocomplete`, `service_ckeditor`) do not even use
    `common.prototype.init`; they set their own minimal state.

## Responsibilities

- **Package shared UI + logic** that more than one component/section/tool needs,
  so it is implemented and maintained once.
- **Bind to a caller.** Every service keeps a `self.caller` and acts on it —
  there is no standalone service; `service_upload` even logs an error if no
  caller is set.
- **Talk to a generic server action**, never to a service-specific endpoint:
  `service_upload` calls the `get_system_info`, `upload` and
  `join_chunked_files_uploaded` actions on `dd_utils_api` (backed by
  `src/core/api/handlers/system_info.ts` and `src/core/media/ingest/upload.ts`);
  `service_autocomplete` / `service_time_machine` build an RQO or SQO and call the
  read API through the caller.
- **Stay out of the ontology.** No node, no `tipo`, no permission row. The
  *caller's* permissions and the server action's own checks govern access — the
  `upload` handler, for instance, asserts write permission on the target section
  when a `tipo` is supplied.
- **Reuse the client lifecycle** (`init` → `build` → `render` → `destroy`) via
  the shared `common` prototype so the caller can hold them in its
  `ar_instances` and tear them down uniformly.

## Key concepts

### The caller relationship

A service is always created *by* something and given that thing as
`options.caller`. The service then reaches back into the caller:

- `service_autocomplete` reads `caller.context.request_config` and calls
  `caller.build_rqo_search(...)` to construct the search request.
- `service_ckeditor` calls `caller.save_value(key, value)` and
  `caller.update_changed_data(...)`, and asks the caller to render its tag/
  reference modals (`caller.render_reference(...)`).
- `service_upload` resolves its target directory from
  `caller.context.features.key_dir` (walking up `caller.caller` if nested) and
  publishes `upload_file_done_<caller.id>` when finished.

### Lifecycle & instancing

Services that use the standard lifecycle are instanced through the shared
factory `get_instance({model:'service_*', caller, …})` (from
`core/common/js/instances.js`), which resolves the module path from the
`service_` prefix, news up the exported function (named exactly as the model),
sets `id`/`id_base`, then runs `init()`. The caller usually then calls
`build()` and `render()`, and pushes the service into its own `ar_instances`
so `destroy()` cascades. Two services are instead **imported directly** as ES6
modules by a single caller:

| how it is obtained | services |
| --- | --- |
| `get_instance({model:'service_*'})` (factory, by model prefix) | `service_autocomplete`, `service_time_machine`, `service_tmp_section`, `service_subtitles` |
| direct ES6 `import` by one component | `service_upload` (the `upload()` fn, used by `component_3d`), `service_ckeditor` (used by `component_text_area`) |

!!! note "`service_upload` is consumed two ways"
    Tools (`tool_upload`, `tool_import_dedalo_csv`, `tool_dev_template`) instance
    the **object** via `get_instance({model:'service_upload'})` and call its
    `upload_file()` method. `component_3d` instead imports the **standalone
    `upload()` function** directly and calls it. Both end up at the same
    `dd_utils_api` actions.

## Files & structure

```text
core/services/
├── service_autocomplete/      # relational search-as-you-type
│   ├── css/service_autocomplete.less
│   └── js/
│       ├── service_autocomplete.js
│       └── view_default_autocomplete.js
├── service_ckeditor/          # rich-text editor wrapper (component_text_area)
│   ├── css/service_ckeditor.less (+ dist/)
│   ├── js/
│   │   ├── service_ckeditor.js
│   │   └── render_text_editor.js
│   └── plug-ins/reference/    # custom CKEditor "reference" plug-in (src + theme)
├── service_subtitles/         # subtitle text generation (transcription tools)
│   └── js/service_subtitles.js      # client shell only (server path not yet ported)
├── service_time_machine/      # dd15 history list (time machine)
│   ├── css/service_time_machine.less
│   └── js/
│       ├── service_time_machine.js
│       ├── render_service_time_machine_list.js
│       └── view_*_time_machine_list.js
├── service_tmp_section/       # ephemeral in-memory section (import preview)
│   ├── css/service_tmp_section.less
│   ├── img/icon.svg
│   └── js/
│       ├── service_tmp_section.js
│       └── render_edit_service_tmp_section.js
└── service_upload/            # chunked upload, single-file AND multi-file
    ├── css/service_upload.less
    ├── img/icon.svg
    └── js/
        ├── service_upload.js
        ├── render_edit_service_upload.js       # single-file form
        ├── upload_transport.js                 # DOM-free wire core (the only XHR)
        ├── upload_queue.js                     # DOM-free multi-file state model
        ├── dropped_files.js                    # recursive directory-drop traversal
        └── render_edit_service_upload_queue.js # multi-file queue renderer
```

The file nomenclature mirrors [components](../components/index.md): the main
class is `<service>/js/<service>.js`, render helpers are
`render_*_<service>.js`, views are `view_*_<service>.js`, and styles are
`<service>/css/<service>.less`.

## The available services

### service_upload

Chunked upload to the server, with progress, retry and concurrency control, in
**two modes on one model**: the default single-file form, and the multi-file
drag-and-drop queue selected by the `multiple:true` init option. The main entry
points are the standalone `upload()` function and the
`service_upload.prototype.upload_file()` method.

- Validates extension (`allowed_extensions`) and size (`max_size_bytes`,
  fetched from `dd_utils_api::get_system_info`).
- Slices the file into `DEDALO_UPLOAD_SERVICE_CHUNK_FILES`-MB chunks, queues
  them, and uploads at most `DEDALO_UPLOAD_SERVICE_MAX_CONCURRENT` (default 50)
  at a time; falls back to a single `send()` when chunking is disabled.
- Each chunk is a `POST` to `DEDALO_API_URL` carrying a `Content-Range` header,
  `X-File-Name`, the per-session **CSRF token** (header `X-Dedalo-Csrf-Token`
  plus a `csrf_token` form-field fallback, SEC-008), and the chunk in a
  `FormData`.
- On network error a chunk retries up to 3 times (5 s backoff).
- When all chunks land it calls `dd_utils_api::join_chunked_files_uploaded`
  server-side, then publishes `upload_file_done_<caller.id>` and reports
  progress through `upload_file_status_<id>` events.

**Consumed by:** `component_3d` (direct `upload()` import), `tool_upload`,
`tool_import_dedalo_csv`, `tool_dev_template`. The media components
(`component_image`, `component_av`, `component_pdf`, `component_svg`, `component_3d`)
are the canonical upload-service consumers — see
[Components → media components](../components/index.md#media-components).

#### Multi-file mode (`multiple: true`)

`init({multiple:true})` swaps the single-file renderer for
`render_edit_service_upload_queue`, a drag-and-drop queue that accepts whole
**directories** (recursive traversal in `dropped_files.js`) and uploads through
the same transport, chunking and CSRF path as the single-file mode — one wire,
two renderers. It also restores a queue across a page reload from
`dd_utils_api::list_uploaded_files`, and removes a staged row through
`dd_utils_api::delete_uploaded_file`.

**Consumed by** the import tools: `tool_import_files`, `tool_import_marc21`,
`tool_import_zotero`.

### service_autocomplete

Search-as-you-type for relational components. It does **not** use
`common.prototype.init`; it builds a small `context`, resolves the *main*
`request_config` object, and drives a pluggable search **engine**
(`dedalo_engine` over the internal read API, or `external_engine`, which asks
the Dédalo **server** to search the bound external service — the browser never
contacts a third party, and never needs to know which service it is), re-combining user input + fixed filters into an SQO via
`rebuild_search_query_object()`. **Consumed by** `component_portal` (and through
it the other relational components — `component_relation_parent`,
`component_relation_children`, `component_relation_related`); the consumer
passes `caller: self` so the service can call `caller.build_rqo_search()`.

### service_ckeditor

Wraps a custom-built CKEditor (`lib/ckeditor`). It builds either a `ddEditor`
(limited custom toolbar, used by `component_text_area`) or an `InlineEditor`
(full toolbar). It owns the Dédalo *tag* model — index in/out, geo, timecode,
draw, SVG, person, note, lang and the custom **reference** plug-in
(`plug-ins/reference/`) — converting between CKEditor model nodes and Dédalo
tags, and tracking an `is_dirty` flag that drives `save()` →
`caller.save_value(key, value)`. **Consumed by** `component_text_area`
(`self.service_text_editor = service_ckeditor`).

The editor bundle is shared by every field on a page, so it is loaded once per
page (`preload_ckeditor`, memoized) and warmed during browser idle as soon as an
editable text area renders (`schedule_ckeditor_preload`). Only the per-field
editor instance is created on activation.

### service_time_machine

The data/render logic of the [Time Machine](../../development/tools/reference/tool_time_machine.md)
history list (section `dd15`). It hard-codes `tipo`/`section_tipo` to `dd15`,
takes the caller's `section_tipo`/`section_id` as the record whose history to
show, borrows `common.prototype.build_rqo_show` and a paginator, and renders the
versions list. **Consumed by** `tool_time_machine`, the `inspector`,
`section_record` list view, `component_text_area` note view and the shared
`component_common` event subscriptions.

### service_tmp_section

An **ephemeral, in-memory section** used to render and collect data without a
persisted record (the import-preview pattern). `init()` takes a `ddo_map`;
`build()` instances each mapped element via the JS `get_instance` factory;
`get_components_data()` harvests their current values back out. **Consumed by**
the import tools (e.g. `tool_import_marc21`) to stage parsed rows before commit.

### service_subtitles

The client lifecycle shell for subtitle work, consumed by `tool_subtitles` and
`tool_tr_print`.

Subtitle **file** generation is a tool action, not a service endpoint:
`build_subtitles_file` (`tools/tool_transcription/server/index.ts`) builds the
WEBVTT file from a transcription's text and timecodes. See
[Creating tools](../../development/tools/creating_tools.md) for how a tool action
is registered and permission-gated.

## Public API / Key methods

Client services share four borrowed `common` prototype methods —
`render()`, `destroy()`, `refresh()`, and (for most) `init()`. Below are the
**service-specific** public methods, verified from the source, grouped by
service. *(All are instance methods on the JS prototype unless noted.)*

### service_upload (`core/services/service_upload/js/service_upload.js`)

| method | exported fn? | purpose |
| --- | --- | --- |
| `init(options)` | | Set `caller`, `allowed_extensions`, `key_dir`, `max_concurrent`, `multiple` (strict `true` selects the queue renderer); subscribe the `upload_file_status_<id>` progress handler. |
| `build(autoload=false)` | | Fetch server limits via `dd_utils_api::get_system_info` (max size, tmp dir, chunk size, OCR engine). |
| `upload_file(options)` | | Resolve `key_dir` from the caller, run `upload()`, then publish `upload_file_done_<caller.id>`. |
| `join_chunked_files(options)` | | Call `dd_utils_api::join_chunked_files_uploaded` to reassemble chunks server-side. |
| `upload(options)` | ✓ (module export) | The standalone uploader: validate, chunk/queue/concurrency, XHR with CSRF + retry; resolves the API response. Imported directly by `component_3d`. |

### service_autocomplete (`core/services/service_autocomplete/js/service_autocomplete.js`)

| method | purpose |
| --- | --- |
| `init(options)` | Build the minimal service `context`; store `caller`, `request_config`, `lang`. |
| `build(options={})` | Resolve the main `dedalo` request_config, build `rqo_search` via the caller, map columns. |
| `render(options={})` | Delegate to `view_default_autocomplete.render`. |
| `autocomplete_search()` | Dispatch to the configured `<engine>_engine`. |
| `dedalo_engine()` | Internal read-API search (list mode, `skip_projects_filter`). |
| `external_engine(options)` | External-service search THROUGH the engine (`dd_external_api::search`). `zenon_engine` is a stable alias of it. |
| `rebuild_search_query_object(options)` | Merge user input + fixed/list filters into the SQO. |
| `service_autocomplete_keys(e)` | Keyboard navigation (Up/Down/Enter) over the datalist. |
| `split_q(q)` | Split a multi-field query on `|`. |
| `get_total()` | Paginator-compatibility shim (returns `limit`). |
| `show()` / `hide()` | (from `view_default_autocomplete`) toggle the datalist. |
| `destroy(...)` | Remove the keydown listener, then call the parent destroy. |

### service_ckeditor (`core/services/service_ckeditor/js/service_ckeditor.js`)

| method | purpose |
| --- | --- |
| `init(options)` | Create the editor (`ddEditor`/`InlineEditor`) for one field, awaiting the shared engine preload. |
| `preload_ckeditor()` | Load the CKEditor bundle + language JSON once per page (memoized). |
| `schedule_ckeditor_preload()` | Warm that load during browser idle when an editable text area renders (once per page; skipped under data saver). |
| `create_ddEditor(cfg)` / `create_InlineEditor(cfg)` | Build the two editor flavours and wire toolbar/events. |
| `save()` | If dirty, `caller.save_value(key, editor.getData())`. |
| `get_value()` | Editor content as raw HTML string. |
| `set_content(tag_obj)` | Insert a Dédalo tag node at the caret. |
| `delete_tag(tag_obj)` / `update_tag(options)` | Remove / edit a tag (by `type`+`tag_id`) in the model. |
| `get_selection()` / `set_selection_from_tag(tag_obj)` | Read / set the current selection. |
| `wrap_selection_with_tags(in,out)` | Wrap a selection with paired in/out tags. |
| `set_reference(options)` / `remove_reference()` / `get_selected_reference_element()` | Manage the custom `reference` plug-in tags. |
| `get_view_tag` / `get_view_tag_node` / `get_view_tag_attributes` / `get_last_tag_id` | Tag lookup helpers over the editor model/view. |
| `setup_events(cfg)` / `setup_button_reference()` / `build_toolbar(cfg)` / `factory_events_for_buttons(btn)` | Wire editor events and the custom toolbar buttons. |
| `set_dirty(value)` / `init_status_changes()` | Track and propagate the dirty state to the caller. |
| `focus()` / `scroll_to_selection()` / `destroy()` | Focus, scroll, teardown. |

### service_time_machine (`core/services/service_time_machine/js/service_time_machine.js`)

| method | purpose |
| --- | --- |
| `init(options)` | Pin `tipo`/`section_tipo` to `dd15`; store caller record + columns map. |
| `build(autoload=false)` | Prepare the request and paginator for the history list. |
| `build_request_config()` | Compose the `request_config` for the `dd15` list. |
| `list()` / `tm()` | (from `render_service_time_machine_list`) render the versions list. |
| `build_rqo_show()` | (from `common`) build the show RQO. |
| `get_total()` | Total versions, for the paginator. |

### service_tmp_section (`core/services/service_tmp_section/js/service_tmp_section.js`)

| method | purpose |
| --- | --- |
| `init(options)` | Store the `ddo_map`. |
| `build(autoload=false)` | Instance each `ddo_map` element via the JS factory. |
| `get_components_data()` | Harvest the current values from the instanced components. |
| `edit()` | (from `render_edit_service_tmp_section`) render the editable inputs. |

### service_subtitles — server side

`service_subtitles.js` is a client shell. The server work — building the WEBVTT
file from a transcription — is the `build_subtitles_file` action of
`tool_transcription`, not a service endpoint.

## How it fits with the rest of Dédalo

- **Components** — media components (`component_image`, `component_av`,
  `component_pdf`, `component_svg`, `component_3d`) consume the **upload**
  service; `component_text_area` consumes **ckeditor**; the relational
  components (via `component_portal`) consume **autocomplete**. See
  [Components → index](../components/index.md),
  [component_text_area](../components/component_text_area.md),
  [component_portal](../components/component_portal.md),
  [component_3d](../components/component_3d.md).
- **Tools** — upload/import tools consume **upload** (single-file or the
  multi-file queue) and **tmp_section**; `tool_time_machine` consumes **time_machine**;
  `tool_subtitles` / `tool_transcription` consume **subtitles**. See
  [Creating tools](../../development/tools/creating_tools.md).
- **The shared client prototype** — every client service borrows `render` /
  `destroy` / `refresh` (and most borrow `init`), so it lives in the caller's
  `ar_instances` and tears down with it.
- **The instance factory** — `core/common/js/instances.js` resolves `service_*`
  models to `core/services/<model>/js/<model>.js`; factory-instanced services share
  the same caching and keying as components and tools.
- **The server API** — services never expose a bespoke endpoint; they call the
  generic actions in the dispatch registry (`src/core/api/dispatch.ts`):
  `get_system_info` (`src/core/api/handlers/system_info.ts`), the multipart
  `upload` plus `join_chunked_files_uploaded` / `list_uploaded_files`
  (`src/core/media/ingest/upload.ts`), and the read API. Permission enforcement is
  the caller's and the API action's responsibility — the upload handler asserts
  write permission on the target section when a `tipo` is supplied.
- **Search** — `service_autocomplete` builds an SQO through the caller and runs
  it over the internal read API. See [SQO](../sqo.md) and [RQO](../rqo.md).

## Examples

### A tool instancing the upload service (factory)

```javascript
import { get_instance } from '../../../core/common/js/instances.js'

// inside a tool's build():
self.service_upload = await get_instance({
    model               : 'service_upload', // resolves to core/services/service_upload/js/service_upload.js
    caller              : self,             // MANDATORY — the service acts on the caller
    allowed_extensions  : ['jpg','jpeg','png','tiff'],
    key_dir             : { type:'dedalo_config', value:'DEDALO_TOOL_UPLOAD_FOLDER_PATH' }
})
self.ar_instances.push(self.service_upload) // tear down with the tool
await self.service_upload.build()           // fetch server limits (get_system_info)

// later, on a chosen file:
const api_response = await self.service_upload.upload_file({ file })
```

### A component importing the standalone `upload()` function

```javascript
// component_3d/js/component_3d.js
import { upload } from '../../services/service_upload/js/service_upload.js'

const api_response = await upload({
    self                : self,
    id                  : self.id,           // used for upload_file_status_<id> progress events
    file                : file,              // { name:'model.glb', size:12345678 }
    key_dir             : 'image',
    allowed_extensions  : self.allowed_extensions,
    max_size_bytes      : self.max_size_bytes,
    tipo                : self.tipo,
    max_concurrent      : self.max_concurrent
})
```

### component_portal wiring the autocomplete service

```javascript
self.autocomplete = await get_instance({
    model           : 'service_autocomplete',
    caller          : self,                                   // service calls caller.build_rqo_search()
    tipo            : self.tipo,
    section_tipo    : self.section_tipo,
    request_config  : self.context.request_config,
    properties      : self.context.properties.service_autocomplete || null,
    id_variant      : (self.id_variant || '') + '_' + Date.now() // avoid instance cache collisions
})
await self.autocomplete.build()
const service_node = await self.autocomplete.render()
```

## Related

- [Architecture overview](../architecture_overview.md) — where the work-system
  client/server split sits.
- [Components](../components/index.md) — the field abstraction services plug
  into; [component_text_area](../components/component_text_area.md) (ckeditor),
  [component_portal](../components/component_portal.md) (autocomplete),
  [media components](../components/index.md#media-components) (upload).
- [Creating tools](../../development/tools/creating_tools.md) — the task
  abstraction that consumes upload/tmp_section/time_machine/subtitles.
- [common](common.md) — the shared object machinery services borrow on the
  client.
- [RQO](../rqo.md) · [SQO](../sqo.md) — the request/query objects
  `service_autocomplete` builds.
- [dd_object (ddo)](../dd_object.md) — the datum services render and collect.
