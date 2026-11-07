# page

> The client-side **page shell** — the top-level JavaScript instance that boots Dédalo's back-office UI, requests its context from the server `start` action, mounts the menu plus the active section/area/tool, and owns the global page chrome (navigation, theme, notifications, dynamic CSS).

> See also: [Architecture overview](../architecture_overview.md) · [CSS / LESS architecture](css_architecture.md) · [Sections](../sections/index.md) · [Components](../components/index.md)

This page is the **developer reference** for the `page` subsystem under
`client/dedalo/core/page/`. Unlike `section` or a component, **`page` has no
server-side model** — it is a purely **client** model (HTML + JS + the
aggregated CSS bundle). The server contributes only the `start` API action
that returns the page's *context*; the `page` JS instance turns that context
into the rendered application.

## Role

`page` is the JavaScript model that owns the whole browser application after the
HTML document loads. It is instanced exactly like any other client model —
`get_instance({model:'page'})` dynamically imports
`client/dedalo/core/page/js/page.js` — but it sits *above* sections, areas,
tools and the menu: those are the elements `page` builds *inside itself*.

Where it sits relative to its neighbours:

| element | role |
| --- | --- |
| **`page`** *(this subsystem)* | The single top-level UI instance. Holds the page **context** (a mixed array of element sources such as `menu`, `section`, `area_*`, `section_tool`), instantiates each one, renders them into the page DOM, and owns the global chrome: menu navigation, browser history, keyboard shortcuts, theme, notifications and the dynamic CSS registry. There is one `page` per loaded document, exposed as `window.dd_page`. |
| **`menu`** | A page element that normally stays mounted across navigations (it is `destroyable=false`). Publishes `user_navigation` events that `page` consumes. |
| **`section` / `area_*` / `section_tool`** | The "main" page element — the record list/edit view, a thesaurus/graph/ontology area, or a tool-configured section. Built and destroyed by `page` on every navigation. |

The server has no `page` model: the `start` action handler in
`src/core/api/handlers/dd_core_api.ts` assembles the page context (the login
context when not logged, via `buildLoginContext()`; otherwise the `menu`
element plus the section/area/tool resolved from the URL, via
`buildStructureContext()`) and returns it as `result.context` along with an
`environment` payload (`buildEnvironment()`, `src/core/resolve/environment.ts`).
The `page` instance consumes both.

!!! note "No inheritance from a server base"
    On the client, the `page` constructor borrows a few prototype methods
    from the shared client `common` and from `render_page` (see
    [Instantiation & lifecycle](#instantiation--lifecycle)), but there is no
    server-side class to extend — `page` has no server-side model at all.

## Responsibilities

- **Bootstrap** — `client/dedalo/core/page/index.html` is the application document; `js/index.js`
  is the entry module that sets `window.page_globals`, instances the `page`,
  calls `build(true)` (the `start` request) and `render()`, then swaps the
  result into `#main`.
- **Context build** — request the page context from the server `start` action,
  validate the `environment` payload (`set_environment`), and surface
  start/environment errors into `page_globals.api_errors`.
- **Element orchestration** — instantiate each context element via
  `instantiate_page_element()`, build and render each one (with per-element
  spinners), and track them in `self.ar_instances`.
- **Navigation** — handle menu-driven `user_navigation`: confirm unsaved data,
  destroy the outgoing main element while keeping `menu`, refresh into the new
  source, push browser history, and clean component locks.
- **Global chrome / events** — register window/document listeners (`popstate`,
  `beforeunload`, `keydown`, `mousedown`) and subscribe to UI events
  (`activate_component`, `dedalo_notification`, `render_page`, `render_instance`,
  `notification`, `quit`, `change_lang`, `api_response_errors`).
- **Notifications** — render the maintenance / recovery / `dedalo_notification`
  banners and the inspector "bubble" notification container.
- **Activity tray** — `js/job_tray.js` mounts the user's own background work into
  `#floating_dock`: media conversions, imports and publications alike, each with
  progress, elapsed time and its OUTCOME. It reads one aggregated server model
  (`dd_utils_api::get_activity`, live plus recently-finished) and then follows
  each row over that row's OWN push stream, so neither job system's wire had to
  change. A row can be cancelled while it runs (media only — the diffusion
  cancel is admin-scoped and stays in Maintenance) and dismissed once terminal;
  failures never auto-fade. Absence from the server's answer is never read as
  success — an earlier version did, and painted failed publications green. It lives in the
  document-level dock rather than in the page wrapper on purpose — the wrapper is
  rebuilt on every navigation, and a tray that died with it would lose sight of a
  transcode the moment the user moved elsewhere, which is the blindness it exists
  to cure. Following is done through `js/job_follow.js`, whose `cancel()` **closes
  the stream** — a follower that only muted its callbacks would keep one of the
  browser's six per-origin connections for the whole job (see
  [data_manager](../client/data_manager.md)); a surface that opens several uses
  `create_job_follower_group()` and releases them all in its teardown. The page
  renders for the **login element** too, so the tray mounts only when
  `page_globals.is_logged` is true and reads nothing while anonymous: "the
  user's own work" has no meaning without a user, and its refused read used to
  raise the re-login overlay on top of the login form (see
  [login](../system/login.md)).
- **Dynamic CSS** — own the runtime CSS-rule registry (`js/css.js`): inject,
  deduplicate, batch and garbage-collect per-element rules into a single
  `<style id="elements_style_sheet">` sheet.
- **Theme** — early flash-free theme application (`js/head-init.js`) and the
  light/dark theme API (`js/theme.js`).
- **File cache** — a Web Worker (`js/worker_cache.js`) that, on login, force-reloads
  the list of core/tool JS+CSS files so client caches refresh on version changes.
- **CSS aggregation** — `css/main.less` is the single LESS entrypoint that
  `@import`s every layout, service, area, section, component and widget stylesheet
  into the one compiled `css/main.css` the page loads.

## Key concepts / page context

The `page` instance does not hold record data; it holds a **context array** of
element *sources*. Each entry describes one page element to instantiate:

- `model` — `menu`, `section`, `area_thesaurus`, `area_graph`, `area_ontology`,
  `section_tool`, etc.
- `tipo` / `section_tipo` / `section_id` / `mode` / `lang` / `view` — the
  standard instance coordinates.
- `config`, `request_config`, `properties` — optional element configuration
  (e.g. `section_tool` config, a restored navigation SQO).

The two systemic pieces around the context:

- **`page_globals`** — the global object created in `index.js` (api_errors,
  request_message, `csrf_token`), then enriched by `set_environment()` with the
  server environment (version, data_version, langs, `is_logged`, `recovery_mode`,
  `maintenance_mode`, `dedalo_notification`, `user_id`, …). Many `page` behaviours
  branch on these flags. It does NOT carry the label dictionary: its
  `labels_version` drives a separate `load_labels()` fetch of `get_label`.
- **`self.ar_instances`** — the live child instances. On navigation, elements
  whose `model` is in the keep-list (`['menu']`) are flagged `destroyable=false`
  and reused; everything else is destroyed to free memory and events.

!!! warning "Page builds once; elements re-build on navigation"
    `page.build(true)` is meant to run **once** (the first `start`). Calling it
    again when `self.context` already exists logs an error. Subsequent navigation
    rebuilds only the main element via `navigate()` → `refresh()`, never the page
    shell.

## Files & structure

```text
client/dedalo/core/page/
├── index.html              # application document: #main, head-init, importmap, index.js (no static main.css link)
├── js/
│   ├── index.js            # bootstrap: page_globals, get_instance('page'), build(true), render(), mount #main
│   ├── page.js             # the `page` model: init/build/navigate/destroy, events, instantiate_page_element
│   ├── render_page.js      # the render layer: edit(), get_content_data(), maintenance/recovery/notification banners
│   ├── css.js              # dynamic CSS-rule registry: set_element_css, process_rule, prune_rules, ...
│   ├── job_tray.js         # the activity tray: the user's own running jobs (media + publication), mounted in #floating_dock
│   ├── theme.js            # light/dark theme API (localStorage 'dedalo_theme'), publishes 'theme_changed'
│   ├── head-init.js       # synchronous head script: data-theme + versioned main.css before paint
│   └── worker_cache.js     # Web Worker: on login, force-reload core/tool JS+CSS files (HTTP cache fallback)
└── css/
    ├── main.less           # single LESS entrypoint — @imports every stylesheet in the app
    ├── main.css            # compiled bundle the page loads (generated; ~445 KB)
    └── layout/             # the page's own layout layer (imported first by main.less)
        ├── reset.less  vars.less  vars_tokens.less  theme_dark.less  theme_tokens.less
        ├── functions.less  fonts.less
        ├── general.less   # html/body/#main, .loading/.hide, maintenance/recovery/notification containers
        ├── progress_bar.less  buttons.less  layout.less  list.less
        ├── floating_dock.less  job_tray.less   # the one bottom-right corner and its tenants
        └── page.less      # the `.page` wrapper rules (content_data, bubbles_notification_container)
```

### The CSS bundle (`main.less` → `main.css`)

`css/main.less` is the **only entrypoint** into the application stylesheet, and
`index.html` loads its compiled output `css/main.css`. The import order is
load-bearing — layout tokens and mixins must be defined before any component or
widget uses them:

```less
// 1. layout core (tokens, mixins, page chrome)
@import './layout/reset';
@import './layout/vars';         // @color_* LESS aliases (compile-time only)
@import './layout/vars_tokens';  // the :root CSS custom properties — main.less ONLY
@import './layout/theme_tokens'; // @font_*/@size_* LESS vars (emits nothing)
@import './layout/theme_dark';   // :root[data-theme="dark"] overrides
@import './layout/functions';
@import './layout/fonts';
@import './layout/general';
@import './layout/progress_bar';
@import './layout/buttons';
@import './layout/layout';
@import './layout/page';
@import './layout/list';
@import './layout/ontology_server';

// 2. services & commons  (install, inspector, paginator, search, menu, dd_grid, services, tool_common)
// 3. login, relation_list, all area_* bundles
// 4. section, section_record, ts_object, section_group, section_tab
// 5. every component_* bundle           // each component's LESS, never compiled on its own
// 6. every widgets/* bundle
```

Each component ships its style as `component_xxx/css/component_xxx.less` and is
**not** compiled by itself — it is folded into `main.css` through this list (see
[Components › File nomenclature](../components/index.md#file-nomenclature)).
The full layering rules, tokens and the per-component LESS contract live in
[CSS / LESS architecture](css_architecture.md).

### Themes (light / dark)

Theming is CSS-custom-property driven, not a separate stylesheet:

- `layout/vars_tokens.less` defines the light palette as `--color_*` properties
  on `:root`; `layout/vars.less` maps the legacy `@color_*` LESS variables onto
  `var(--color_*)`, so every existing rule is theme-aware without edits. Only
  `main.less` imports `vars_tokens.less` — see `docs/core/ui/themes.md`.
- `layout/theme_dark.less` overrides those same properties under
  `:root[data-theme="dark"]`.
- `js/head-init.js` runs synchronously in `<head>` and sets
  `data-theme="dark"` from `localStorage.dedalo_theme` *before first paint* to
  avoid a flash of the wrong theme. It also writes the main stylesheet link,
  `css/main.css?v=<css_version>`, using the version the server sent on the last
  boot (`?v=init` when none is stored). After the `start` request, `index.js`
  switches to the server's current `page_globals.css_version` before anything
  renders, so a code update reaches the browser whatever cache headers the web
  server sends. Tool stylesheets use the same version (`tool_css_url`).
- `js/theme.js` is the runtime API (`get_theme` / `set_theme` / `toggle_theme`),
  persists to `localStorage.dedalo_theme`, and publishes `theme_changed`. The
  menu's theme switcher imports it (`client/dedalo/core/menu/js/view_default_edit_menu.js`).

## Instantiation & lifecycle

`page` is instanced like any client model — there is no constructor signature
beyond the empty `page()` factory; state is set in `init()`. The bootstrap in
`index.js` is the canonical lifecycle:

```js
// client/dedalo/core/page/js/index.js (essentials)
import {get_instance} from '../../common/js/instances.js'

window.page_globals = { api_errors:[], request_message:null, csrf_token:null }

// 1. instance the page model (dynamically imports client/dedalo/core/page/js/page.js → init())
const page_instance = await get_instance({ model:'page' })

// 2. build: run the server `start` request and store result.context + environment
await page_instance.build(true)

// 3. render: produce the .wrapper.page DOM and its content_data
const wrapper_page = await page_instance.render()

// 4. mount into #main
document.getElementById('main').appendChild(wrapper_page)
```

Prototype wiring (in `page.js`) — `page` borrows from the shared client `common`
and from `render_page`:

```js
page.prototype.edit    = render_page.prototype.edit   // builds the .wrapper.page DOM
page.prototype.render  = common.prototype.render        // generic render → calls edit()
page.prototype.refresh = common.prototype.refresh
page.prototype.destroy = common.prototype.destroy       // (overridden below to remove window events)
```

Lifecycle stages, in order:

1. **`init(options)`** — set `model='page'`, `mode='edit'`, copy
   `options.context` / `options.menu_data`, subscribe to all UI events, call
   `add_events()` (window/document listeners), `set_custom_css()` (adds
   `os-windows` / `os-macintosh` to `<body>`), and publish itself as
   `window.dd_page`. Has a duplicate-init guard.
2. **`build(autoload=true)`** — issue the `start` RQO
   (`{action:'start', options:{search_obj, menu}}`), validate
   `api_response.result` and `api_response.environment`, run `set_environment()`,
   then `await load_labels(page_globals.dedalo_application_lang,
   page_globals.labels_version)` (`common/js/labels.js` — fetches the UI-label
   dictionary from `/api/v1/labels` and sets the global `get_label`; a failure
   stops the build through `set_page_error`), then set
   `self.context = api_response.result.context`. On the first start only.
3. **`render()` → `edit()`** — build the `.wrapper.page` node, the `content_data`
   container, and the `bubbles_notification_container`; `get_content_data()`
   instantiates/builds/renders each context element (with spinners) and publishes
   `render_page` when all are done.
4. **`navigate(options)`** — on `user_navigation`, swap the main element.
5. **`destroy()`** — remove window/document listeners then call the inherited
   `common.destroy`.

## Public API / key methods

Real, verified members of `client/dedalo/core/page/js/page.js`, `render_page.js`, `css.js`
and `theme.js`, grouped by concern. None are static (these are client modules);
the *exported?* column marks ES-module exports usable by other files.

### page lifecycle (`page.js`)

| method | exported? | purpose |
| --- | --- | --- |
| `page.prototype.init(options)` | (prototype) | Set instance state, subscribe to events, register global listeners, expose `window.dd_page`. Guards against duplicate init. |
| `page.prototype.build(autoload=false)` | (prototype) | Run the server `start` request, validate `result`+`environment`, set `self.context`. Intended to run once. |
| `page.prototype.edit(options)` | (via `render_page`) | Build the `.wrapper.page` DOM, `content_data` and `bubbles_notification_container`. `render_level:'content'` returns only `content_data`. |
| `page.prototype.render()` / `refresh()` | (via `common`) | Generic render/refresh; `refresh` is how `navigate()` rebuilds the main element. |
| `page.prototype.destroy(delete_self, delete_dependencies, remove_dom)` | (prototype) | Remove `popstate`/`beforeunload`/`keydown`/`mousedown` listeners, then call `common.destroy`. |
| `page.prototype.add_events()` | (prototype) | Register the window/document listeners (browser history, unsaved-data guard, keyboard shortcuts, click-to-deactivate). Also binds the [command palette](command_palette.md) (<kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>K</kbd>). |
| `instantiate_page_element(self, source)` | ✓ | Build a child instance (section/menu/area/tool) from a context source; assembles instance options, sets `id_variant`, attaches `caller`. |

### navigation & selection (`page.js`)

| method | exported? | purpose |
| --- | --- | --- |
| `navigate(user_navigation_options)` | (module-private) | Menu navigation: unsaved-data check, destroy outgoing element (keep `menu`), refresh into new source, push history, clear locks. Guarded by `navigation_in_progress`. |
| `page.prototype.restore_section_selection(section_tipo)` | (prototype) | Re-activate the last selected component for a section, from local-DB `last_section_selection_*`. |
| `page.prototype.set_document_title(title)` | (prototype) | Set `document.title` (called by section/area). |
| `page.prototype.delete_cache()` | (prototype) | Remove `page_cache_*` local-DB entries (fired on `quit` / `change_lang`). |

### render layer (`render_page.js`)

| method | exported? | purpose |
| --- | --- | --- |
| `render_page.prototype.edit(options)` | (prototype, exported via `render_page`) | The page wrapper builder (see above). |
| `get_content_data(self)` | (module-private) | Build `content_data`; short-circuits to the update-data widget on version mismatch; prepends recovery/maintenance banners; renders each context element with `ui.load_item_with_spinner`; publishes `render_page` on completion. |
| `render_notification_msg(self, dedalo_notification)` | ✓ | Render/replace/remove the top `notification_container` banner; dedupes identical messages. |

### dynamic CSS (`css.js`)

| method | exported? | purpose |
| --- | --- | --- |
| `set_element_css(key, value)` | ✓ | Turn an element's ontology `css` object into scoped rules (e.g. `.oh1_rsc75.wrapper_component`) and queue them. |
| `prune_rules(condition_fn)` | ✓ | Delete injected rules matching a predicate (used by `page`'s `dd_garbage_collector` once the registry exceeds 500 rules). |
| `get_inserted_rules()` | ✓ | Return the `inserted_rules` `Map` (the rule registry). |
| `get_elements_style_sheet()` | ✓ | Lazily create and return the single `<style id="elements_style_sheet">` sheet. |

`process_rule`, `queue_style_update`, `flush_style_updates` and
`safe_insert_rule` are module-private helpers that recurse the CSS object, batch
inserts on `requestAnimationFrame`, and deduplicate by selector.

### theme (`theme.js`)

| method | exported? | purpose |
| --- | --- | --- |
| `get_theme()` | ✓ | Return `'light'` or `'dark'` from `localStorage.dedalo_theme`. |
| `set_theme(t)` | ✓ | Apply/remove `data-theme="dark"` on `<html>`, persist, publish `theme_changed`. |
| `toggle_theme()` | ✓ | Flip between light and dark. |
| `THEME_KEY` (const) | ✓ | The localStorage key, `'dedalo_theme'`. |

## Unsaved-work guard

The page owns the last line of defence between a half-typed record and a closed
tab: the derived flag `window.unsaved_data`. It is read by
`check_unsaved_data()` and by the page's own `beforeunload` listener, which
sets `event.returnValue` so the browser shows its native "leave site?" dialog.
`check_unsaved_data()` first runs the auto-save sweep (every component still
carrying `changed_data` is saved). Navigation and modal close then show the
discard prompt for whatever the sweep could NOT store — a save the server
refused, or a draft that is deliberately never auto-saved (component_password
commits only through its own Save). Component activation, a click outside every
component and the `beforeunload` listener call it with `{flush_only: true}`:
they flush and never prompt, so moving between fields raises no dialog.

### The flag is DERIVED, never assigned

`client/dedalo/core/common/js/events.js` owns it and recomputes it from three
sources. No other file may write it — a direct assignment is silently
overwritten by the next recompute.

| source | armed by | retired by | what it covers |
| --- | --- | --- | --- |
| component-instance registry | `register_unsaved_instance(instance)` | `deregister_unsaved_instance(instance)` | a component whose current value differs from its `db_data` snapshot (the verdict in `set_changed_data`) |
| uncommitted-typing registry | `register_uncommitted_input(node)` | `deregister_uncommitted_input(node)` | a field being typed into **right now**, before its view commits the value |
| coarse assertion | `set_before_unload(true)` | `set_before_unload(false)` | keystroke guards with no component instance to register |

An entry may only ever retire **itself**. This is the point of the registries:
one component reverting its own edit must not disarm the guard for every other
dirty component on the page. Only `reset_unsaved_data()` clears everything, and
only from `check_unsaved_data`'s one resolution — "the user accepted the loss".
The auto-save sweep never resets: each successful save retires its own entry,
and what remains was not flushed, so it must reach the prompt (until 2026-09-30
the sweep reset the whole registry and such changes were dropped silently).

### Why typing has its own registry

A component only learns about an edit when its view **commits** a value.
`component_text_area` debounces on keystrokes, so it registers itself while the
user is still typing. Every view built on the native `change` event —
`component_input_text`, `component_date`, `component_number`,
`component_password`, `component_email`, `component_geolocation` and the rest —
commits only on **blur**, and reloading or closing a tab never blurs the focused
field. Without the typing registry those components never reached the guard at
all: the flag stayed `false`, `beforeunload` returned early, and the typed text
was dropped with no prompt, no save and no log line.

So `events_init()` (called once from `index.js`) attaches one document-level,
**capture-phase** listener trio:

- `input` → arm the field, before any commit.
- `change` → retire the field. Capture phase runs *before* the view's own
  handler, so the component's verdict is what survives.
- `focusout` → retire the field. Covers type-then-revert, where `change` never
  fires at all.

Only real editors of a component in **edit** mode arm it: the nearest component
wrapper decides, so search forms and list filters do not. A portal's search box
(`.wrapper_service_autocomplete`) is rendered straight into the edit portal's
wrapper, so it is excluded by name — a typed query is not record data, and
closing a window after only searching must not ask to discard changes.

!!! warning "Only edit-mode record fields are guarded"
    A field is guarded when its **nearest** `.wrapper_component` ancestor carries
    the `edit` mode class. List cells, search forms and a lookup/autocomplete box
    nested inside an edit-mode portal (it lives in its own search-mode wrapper)
    are not unsaved record data, and typing in them must not arm the guard —
    otherwise every lookup would prompt on reload.

Entries whose node has left the document — a save or a refresh re-renders the
component and throws the old input away — are pruned on every recompute, so a
detached field cannot pin the guard armed forever.

### The `beforeunload` step

The handler **blurs the active element before reading the flag**. That makes the
focused field commit synchronously: a genuine edit registers its component
instance (guard armed, prompt shown, and the auto-save sweep can see the value),
while a typed-then-reverted value deregisters itself and produces no false
prompt.

!!! note "Gates"
    The registry contract and the wiring shape are pinned by
    `test/unit/client_unsaved_registry.test.ts` (no server, no browser). The
    end-to-end property — *typing into an edit-mode field of any component model
    arms the guard before any commit* — is pinned per model by the browser suite
    `test_unsaved_guard`, driven off the client test `elements.js` list so a new
    component model inherits the gate automatically. Models with no typable edit
    field are declared there by name with a reason.

## How it fits with the rest of Dédalo

- **Server `start` action** — `page.build()` calls the Dédalo API `start` action
  (the `start` handler in `src/core/api/handlers/dd_core_api.ts`), which
  returns the page context (login context, or `menu` + the resolved
  section/area/tool) and the `environment` payload. See the
  [Architecture overview › request lifecycle](../architecture_overview.md#the-request-lifecycle)
  and [RQO](../rqo.md).
- **Sections & areas** — the main page element is usually a
  [section](../sections/index.md) (or an `area_*`); `page` builds it through
  `instantiate_page_element()` and rebuilds it on every navigation, while the
  `menu` element persists (it is kept in the navigation keep-list).
- **Components** — each component's `css` context flows into
  [`set_element_css`](#dynamic-css-cssjs), and components publish the
  `activate_component` / `notification` events `page` listens for. See
  [Components](../components/index.md).
- **CSS / LESS bundle** — every component, area and widget stylesheet is
  aggregated by `css/main.less`; the layering contract is documented in
  [CSS / LESS architecture](css_architecture.md).
- **request_config** — restored navigation SQOs and `section_id` filters ride in
  on the context element's `request_config`; see [request_config](../request_config.md).

## Examples

### The minimal bootstrap

```js
// index.js, condensed — the entire app entry
const page_instance = await get_instance({ model:'page' })
await page_instance.build(true)                  // -> server `start`
const wrapper_page = await page_instance.render() // -> .wrapper.page DOM
document.getElementById('main').appendChild(wrapper_page)
```

### Driving a navigation from elsewhere

`page` listens for `user_navigation`; any element (typically the menu) publishes
a source to switch the main page element:

```js
import {event_manager} from '../../common/js/event_manager.js'

event_manager.publish('user_navigation', {
    source : { model:'section', tipo:'rsc170', section_tipo:'rsc170', mode:'list' },
    sqo    : null,
    event_in_history : false
})
```

### Injecting scoped CSS for a component

```js
import {set_element_css} from '../../page/js/css.js'

// key is usually `${section_tipo}_${tipo}`; selectors are scoped under it
set_element_css('oh1_rsc75', {
    '.wrapper_component' : { 'grid-column' : 'span 7' },
    '>.content_data'     : { 'min-height'  : '8rem' }
})
```

### Toggling the theme

```js
import {toggle_theme, get_theme} from '../../page/js/theme.js'

toggle_theme()        // light <-> dark, persisted to localStorage.dedalo_theme
get_theme()           // 'light' | 'dark'
```

!!! note "Accuracy notes"
    - `page` is **client-only**; it has no server-side model. The server side
      of the page is the `start` API action, not a class.
    - `js/index.js` references `worker_cache.js` only indirectly — the worker is
      launched on login (`client/dedalo/core/login/js/login.js`) and by the update-code
      maintenance widget, not by the page bootstrap.
    - `main.css` is a build artifact compiled from `main.less`; the repository
      tooling that runs the LESS compilation is outside the `client/dedalo/core/page/` tree and
      is not documented here.

## Related

- [Architecture overview](../architecture_overview.md) — server-build vs
  client-render, the request lifecycle, the `{context,data}` datum.
- [CSS / LESS architecture](css_architecture.md) — the `main.less`
  layering, tokens, mixins and the per-component LESS contract.
- [Sections](../sections/index.md) · [Components](../components/index.md) —
  the elements `page` builds inside itself.
- [RQO](../rqo.md) — the request format used by the `start` build call.
- [request_config](../request_config.md) — how restored SQOs/filters reach a
  navigated element.
