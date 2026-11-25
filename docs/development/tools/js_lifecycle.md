# Tools JS lifecycle

The client-side contract of a Dédalo tool — vanilla constructor-function/prototype JS, no build step. Base module: `client/dedalo/core/tools_common/js/tool_common.js`, served at `/dedalo/core/tools_common/js/tool_common.js` (see *Roots & static serving* in `engineering/TOOLS_SPEC.md`). Reference implementation: `tools/tool_dev_template/js/`.

## Files

| File | Role |
| --- | --- |
| `js/index.js` | module entry; `export * from './tool_x.js'` |
| `js/tool_x.js` | tool constructor, wiring, custom logic |
| `js/render_tool_x.js` | render module: `edit()` (and/or `list()`) building the DOM |
| `css/tool_x.css` | tool stylesheet, loaded on demand (LESS/SASS sources welcome; the compiled file must keep this name) |

## Wiring

`wire_tool` performs the standard prototype assignments every tool needs:

``` js
import {tool_common, wire_tool} from '../../../core/tools_common/js/tool_common.js'
import {render_tool_x} from './render_tool_x.js'

export const tool_x = function () { /* declare instance vars */ }

wire_tool(tool_x, render_tool_x)
// equals:
// tool_x.prototype.render  = tool_common.prototype.render
// tool_x.prototype.destroy = common.prototype.destroy
// tool_x.prototype.refresh = common.prototype.refresh
// tool_x.prototype.tool_request = tool_common.prototype.tool_request
// tool_x.prototype.edit    = render_tool_x.prototype.edit   (when defined)
// tool_x.prototype.list    = render_tool_x.prototype.list   (when defined)
```

Add further prototype methods after the call as usual.

## Lifecycle: init → build → render

A tool is opened by `open_tool({tool_context, caller, open_as})` (bound automatically to the tool buttons that the section/component tool filter — `getElementTools`, `src/core/tools/registry.ts` — placed in the element context).

1. **init(options)** — call super first: `await tool_common.prototype.init.call(this, options)`. It assigns the common vars (`model`, `section_tipo`, `section_id`, `lang`, `mode`), resolves the `caller` (directly, or reconstructed from the compressed URL when the tool opens in its own window) and the `tool_config`. When no `tool_config.ddo_map` is defined, a fallback ddo_map is built from the caller.
2. **build(autoload)** — call super: it awaits the tool CSS (`load_style`) and resolves every `ddo_map` entry into a live component/section instance in `self.ar_instances`. Pass `{load_ddo_map: fn}` as the third argument to replace the default loader. Locate your elements by role:
   ``` js
   const ddo = self.tool_config.ddo_map.find(el => el.role==='main_element')
   self.main_element = self.ar_instances.find(el => el.tipo===ddo.tipo)
   ```
3. **render()** — delegates to your `edit()` / `list()` (matching `self.mode`). The render must return a wrapper that exposes a `tool_header` node; build it with the helpers:
   ``` js
   const content_data = ui.tool.build_content_data(self)
   // ...append your nodes to content_data...
   const wrapper = ui.tool.build_wrapper_edit(self, { content_data })
   return wrapper
   ```

Wrap custom init/build code in `try/catch` and set `self.error = error` on failure — `tool_common.prototype.render` then renders the standard error view instead of your `edit()`. Build/render exceptions inside the modal are also surfaced visibly to the user (standard `content_data_error` block).

### ddo_map

`tool_config.ddo_map` declares the elements the tool operates on:

``` json
{
	"ddo_map": [{
		"model": "component_input_text",
		"tipo": "rsc36",
		"section_tipo": "rsc197",
		"section_id": "self",
		"lang": "lg-eng",
		"role": "main_element",
		"autoload": true,
		"mode": "edit"
	}]
}
```

`"section_id": "self"` is substituted with the caller's record id. `"autoload": false` entries are skipped by the default loader (load them yourself later). `role` is your own label for locating instances.

## Calling the server: tool_request

``` js
const response = await self.tool_request({
	action  : 'my_method',          // key of the server module's apiActions map
	options : { section_tipo: '...', section_id: '...', my_param: 1 },
	background : false,             // true = detached run (the action must be in the module's backgroundRunnable)
	url        : null               // optional API URL override
})
// response: { result, msg, errors }
```

The helper builds the full rqo (source via `create_source`, `prevent_lock: true`) and posts it through `data_manager`. Permission errors arrive as the standard `permissions_denied` response. For streaming (NDJSON) use `data_manager.request_fetch_stream` directly (see `tool_export`).

!!! note "`prevent_lock` is vestigial"
    There is no per-session write-lock to release — request state is scoped per-request via `AsyncLocalStorage` (see `engineering/REWRITE_SPEC.md`), so a long tool request never blocks the user's other tabs. The field is still accepted by the RQO schema (`src/core/concepts/rqo.ts`) for wire compatibility with the unchanged client, but the dispatcher does not read it.

## Modal, window and attach modes

`open_tool` routes by `open_as` (from the call or the tool `properties.open_as`, default `modal`). Three values exist — `modal`, `window`, `attach` — and register.json accepts no other ([`properties.open_as`](register_json.md#propertiesopen_as)):

- **modal** — the tool renders inside a Dédalo modal; CSS is awaited before first paint; on close, `on_close_actions('modal')` is called if you define it, otherwise the caller is refreshed.
- **window** — the caller state is LZString-compressed into the URL and the tool opens at `/core/page/?tool={name}&raw_data=...`; the caller refreshes on window focus. Size/position via `properties.windowFeatures`.
- **attach** — no modal and no window: the tool decorates its caller in place (a toolbar on a component's map, for instance). Only for component tools: register.json must set `show_in_component: true` and `show_in_inspector: false`.

### The attach lifecycle

An `attach` tool runs **init → build → attach**; `render()` is never called, so it needs no `edit()` view. Core loads the tool instance and its CSS in parallel, calls `build(true)`, then `attach()`. The tool implements two methods:

- **`attach()`** — async. Puts the tool's UI on `self.caller` (its node, its map, its toolbar) and returns a truthy value on success. It must be safe to call again: core calls it once more after every re-render of the caller.
- **`detach()`** — async. Removes everything `attach()` added — nodes, listeners, map layers — and must not fail when that surface is already gone (the caller's DOM may have been replaced before it runs).

``` js
tool_x.prototype.attach = async function() {
	const self = this
	const node = self.caller.node
	if (!node) return false
	self.bar = self.bar || build_bar(self)   // your own builder
	node.appendChild(self.bar)
	return true
}

tool_x.prototype.detach = async function() {
	const self = this
	self.bar?.remove()                       // tolerates an already-removed node
	return true
}
```

Core owns everything around those two calls; the tool does not wire any of it:

| Event | What core does |
|---|---|
| The tool button is pressed (mouse, or Enter / Space on the focused button) | Loads and attaches the tool. While loading, the button carries `aria-busy="true"` and the class `loading`; a further click is ignored. |
| The tool button is pressed while attached | Toggles the tool off: `detach()`, then `destroy()`. |
| The caller's DOM goes away (`destroy_<caller.id>`, also sent at the start of every refresh) | `detach()` straight away, so the tool never stays on a dead surface. The tool is destroyed only when the caller itself is destroyed. |
| The caller re-renders (`render_<caller.id>`) | `attach()` on the new DOM (after `detach()` if the tool was still on the old one). A re-render during the first `attach()` is handled after it. |
| Loading, `build` or `attach()` fails (or `attach()` returns a falsy value) | The error is shown once, through the client's standard error path; nothing is left attached. |

Every attach and detach of one tool on one caller runs in order, one at a time.

Attachment belongs to one live caller instance, not to the record: two instances of the same component (an edit form and a hover window, say) each attach their own copy of the tool, and changing the caller's language in place does not lose it.

While the tool is attached its button carries `aria-pressed="true"`, and the caller's root node carries `data-tools-attached` — the names of its attached tools, space-separated — for styling and for tests.

Use `attach` for a tool whose whole job is to add controls to its caller. Before it existed such a tool opened as a modal with nothing in it and closed it straight away, which showed as a flash on screen.

## Labels

UI strings declared in register.json `labels` are retrieved with language fallback (current → default → any):

``` js
const text = self.get_tool_label('my_first_label') || 'Fallback text'
```

## Events

Use the global `event_manager` for cross-component communication (e.g. `upload_file_done_{id}` from `service_upload` — see the template). Push subscriptions into `self.events_tokens` so `destroy()` unsubscribes them.

## Assets and multi-root tools

Tool JS modules, CSS and icons resolve per tool: tools living in a `DEDALO_ADDITIONAL_TOOLS` root are loaded from their configured URL (`DEDALO_TOOLS_URLS` map / `tool_base_url()` util); in-repo tools keep the historical `DEDALO_TOOLS_URL` paths. This is transparent to tool code — never hardcode tool asset URLs; the framework builds them.
