# paginator

> The client-side pagination widget — a small JavaScript instance that turns a
> caller's `limit` / `offset` / `total` into navigation controls and republishes
> the user's clicks as offset-change events the caller listens for.

> See also: [SQO](../sqo.md) · [Sections](../sections/index.md) ·
> [section (class reference)](../sections/section.md) ·
> [component_portal](../components/component_portal.md)

This page is the **subsystem reference** for the paginator. The paginator is
**client-only** — it has no server-side counterpart. It lives entirely under
`client/dedalo/core/paginator/js/` and is driven by a *caller* (a section list,
a portal, a time-machine service, a dd_grid, …). The pagination *numbers* it
displays come from the caller's [SQO](../sqo.md) (`limit` / `offset`) and
from a server `count` action; the paginator itself never talks to the API.

## Role

The paginator is a **dumb-by-design navigation widget**. It does not own the
data, the query, or the records. It is given a `caller` at `init()` time and from
then on it:

1. **reads** the caller's pagination state — `caller.rqo.sqo.limit` and
   `caller.rqo.sqo.offset` — and the record count via `caller.get_total()`;
2. **derives** the page model (total pages, current page, first/prev/next/last
   offsets, the "showing X–Y of Z" range);
3. **renders** the controls (first/prev/next/last buttons, a go-to-page input, a
   records-displayed label, optional *show all* / *reset*);
4. **republishes** every user action as an `event_manager` event keyed to the
   paginator's id (`paginator_goto_<id>`, `paginator_show_all_<id>`,
   `reset_paginator_<id>`). The caller subscribes to these, mutates its own SQO,
   and re-navigates.

```text
caller (section list / portal / time_machine / dd_grid)
   │  init({ caller, mode })
   ▼
paginator  ── reads ──►  caller.rqo.sqo.limit / .offset
   │         ── reads ──►  caller.get_total()  ──► API { action:'count' }
   │
   │  user clicks "next" / types a page / "show all"
   ▼
event_manager.publish('paginator_goto_<id>', new_offset)
   │
   ▼
caller's handler ── sets caller.rqo.sqo.offset ── re-navigate / refresh
```

It sits **beside** the list/edit views, not inside the data model. Where
[`section`](../sections/section.md) owns the records and the navigation SQO, the
paginator is the thin presentation layer that visualises *where in that result
set the user currently is* and emits the intent to move.

!!! note "No inheritance — it borrows render prototypes"
    The paginator is a plain constructor function (`export const paginator =
    function(){…}`), not a class and not an `extends`. Instead of inheriting, it
    **assigns prototype methods** from three render modules and from the shared
    `common` module (see [Files & structure](#files--structure)). Its
    `render()` / `refresh()` come straight from `common.prototype`.

## Responsibilities

- **Hold the page model** — `total`, `total_pages`, `page_number`,
  `page_row_begin` / `page_row_end`, and the four navigation offsets
  (`offset_first` / `offset_prev` / `offset_next` / `offset_last`).
- **Fetch the total** — `get_total()` delegates to `caller.get_total()` (the
  server `count`), de-duplicating concurrent calls behind a single pending
  promise.
- **Derive everything else** — `_update_pagination_props(total)` recomputes the
  whole model from `limit`, `offset` and `total` after each total fetch.
- **Render a view** — `edit` (full), `mini`, or `micro`, chosen by the caller's
  `mode` at `init()`.
- **Translate clicks into intent** — `paginate()`, `go_to_page_json()`,
  `navigate_to_next_page()` / `navigate_to_previous_page()`, `show_all()`,
  `reset_paginator()`, each publishing an event the caller acts on.
- **Lifecycle hygiene** — register every subscription token in `events_tokens`
  and unsubscribe them in `destroy()`.

## Data model

The pagination model is the classic **limit / offset / total** triple. The
source of truth for `limit` and `offset` is the **caller's SQO**
(`caller.rqo.sqo`), not the paginator — the paginator only mirrors them onto its
own `self.limit` / `self.offset` during `_update_pagination_props()`. `total`
comes from the server `count` action. A component portal aligns its SQO with the
server's page on build: it copies `total`, `offset` and `limit` from
`data.pagination`, so the paginator divides by the page size the server used.
Edit-mode component configs always carry a page size (the
[request_config default](../request_config.md#the-component-edit-default-is-on-the-wire));
a missing `limit` would collapse the paginator to a single, hidden page.

| property | meaning | source |
| --- | --- | --- |
| `limit` | records per page (SQO `limit`) | `get_limit()` → `caller.rqo.sqo.limit` |
| `offset` | records to skip (SQO `offset`) | `get_offset()` → `caller.rqo.sqo.offset` |
| `total` | total matching records | `get_total()` → `caller.get_total()` |
| `total_pages` | `ceil(total / limit)` (or `1`/`0` when `limit===0`) | derived |
| `page_number` | current 1-based page | `get_page_number(limit, offset)` |
| `page_row_begin` / `page_row_end` | the "showing X–Y" range | derived |
| `offset_first` | `0` | derived |
| `offset_prev` | `offset > limit ? offset - limit : 0` | derived |
| `offset_next` | `offset + limit` | derived |
| `offset_last` | `limit * (total_pages - 1)` | derived |

All derivations live in `_update_pagination_props(total)`. They are defensive:
`total`, `limit` and `offset` are coerced to non-negative numbers, `NaN` becomes
`0`, and `total_pages` guards against division by zero (a `limit` of `0` means
"one page of everything", i.e. *show all*).

!!! info "`limit === 0` is the *show all* sentinel"
    When the *show all* control fires, the caller sets its SQO `limit` to `0`
    (see [`component_portal`](../components/component_portal.md)'s
    `paginator_show_all_` handler). The paginator then computes `total_pages` as
    `1` and the navigation collapses to a single page. `reset_paginator(limit)`
    restores the previous limit. This differs from the server-side SQO `limit`
    clamp described in [SQO → limit](../sqo.md): the `0`/`all` sentinel is a
    *client* convenience that server-internal callers honour, while a client
    `limit` arriving over the HTTP API is clamped to
    `DEDALO_SEARCH_CLIENT_MAX_LIMIT`.

### The total is fetched, not paginated

The paginator never asks for a page of records; the **caller** owns the record
fetch. The paginator only needs the *count*. `caller.get_total()` (for a section,
`section.prototype.get_total`) builds a simplified SQO — it clones the caller's
SQO and **deletes `limit`, `offset`, `select`, `order`, `generated_time`** — and
sends `{ action: 'count' }` to the API, caching the result on `caller.total`.
Both `paginator.get_total()` and `section.get_total()` wrap the call in a single
pending-promise guard so rapid re-renders coalesce into one request.

## Files & structure

```text
client/dedalo/core/paginator/
├── css/
│   └── paginator.less              # .paginator, .edit/.mini/.micro views, *_icon buttons
└── js/
    ├── paginator.js                # constructor, model, get_total, paginate, navigation API
    ├── render_paginator.js         # `edit` view (full): nav buttons + go-to-page input + records label
    ├── render_paginator_mini.js    # `mini` view: nav buttons + "X-Y of Z"
    └── render_paginator_micro.js   # `micro` view: compact, + show_all / reset (portals, mosaics)
```

The constructor wires the render modules onto its prototype rather than
extending a base class:

```js
// client/dedalo/core/paginator/js/paginator.js
paginator.prototype.edit         = render_paginator.prototype.edit
paginator.prototype.edit_in_list = render_paginator.prototype.edit
paginator.prototype.list         = render_paginator.prototype.edit // same as edit
paginator.prototype.tm           = render_paginator.prototype.edit
paginator.prototype.mini         = render_paginator_mini.prototype.mini
paginator.prototype.micro        = render_paginator_micro.prototype.micro
paginator.prototype.render       = common.prototype.render
paginator.prototype.refresh      = common.prototype.refresh
```

So the **mode chosen at `init()`** (`edit` / `list` / `tm` / `mini` / `micro`)
selects which render method `common.prototype.render()` ends up invoking. The
three full-render modes (`edit`, `list`, `tm`) all map to the same
`render_paginator` `edit` view; portals and mosaics use `micro`.

### View differences

| view | used by | contents | shows *show all* / *reset* |
| --- | --- | --- | --- |
| `edit` (full) | section list / edit views | first/prev/next/last buttons, **go-to-page** number input, "Page N of M", "Showing X–Y of Z" | no |
| `mini` | compact lists | nav buttons + "X–Y of Z"; **hidden when `total_pages < 2`** | no |
| `micro` | portals, dd_grid, mosaics | total badge, nav buttons, "page–pages"; **hidden when `total_pages < 2` unless `show_all_status` is set** | yes (`limit > 1` and `show_interface.show_all`) |

!!! note "Scaffold-then-fill in the `edit` view"
    The `edit` view renders the controls *before* the total is known. It pushes
    `{name, callback}` pairs into an `active_values` array and, inside a
    `dd_request_idle_callback`, calls `get_total()` and then fires each callback
    with the freshly computed `self[name]`. This is why the full paginator shows
    "Loading data …" then updates in place — the DOM exists immediately and the
    count backfills.

## Public API

Grouped by concern. None of these are static (the paginator is an instance, not
a class). All event publishes are keyed to `self.id`, which is
`'paginator_' + caller.id`.

### Lifecycle

| method | purpose |
| --- | --- |
| `init(options)` | One-time setup. Requires `options.caller`; reads `options.mode` (falls back to `caller.mode`) and optional `options.show_interface` (merged over the `{ show_all:true }` default). Sets `self.id = 'paginator_' + caller.id`, guards against a double-init, and moves `status` `initializing → initialized`. Returns `true`. |
| `build()` | Inherits `self.permissions` from the caller, sets `status = 'built'`, and publishes `built_<id>`. Returns `true`. |
| `render(options)` | From `common.prototype.render`; dispatches to the view method matching the instance `mode` (`edit` / `mini` / `micro` / …). `options.render_level` may be `'full'` (wrapper) or `'content'` (content_data only, for refresh). |
| `refresh()` | From `common.prototype.refresh`; re-renders content in place. |
| `destroy()` | Unsubscribes every token in `events_tokens`. Returns `{ delete_self }`. |

### Pagination model

| method | purpose |
| --- | --- |
| `get_total()` | Async. Returns the total count via `caller.get_total()`, behind a single `_total_promise` guard, then calls `_update_pagination_props(total)`. |
| `get_limit()` | Returns `caller.rqo.sqo.limit` (warns if `undefined`). |
| `get_offset()` | Returns `caller.rqo.sqo.offset` (warns if `undefined`). |
| `get_page_number(item_per_page, offset)` | Returns the 1-based current page; returns `1` when `item_per_page <= 0`. |
| `get_page_row_end(page_row_begin, item_per_page, total_records)` | Returns the last displayed row index, clamped to `total_records`. |
| `_update_pagination_props(total)` | *private.* Recomputes `total`, `total_pages`, `page_number`, the row range and the four navigation offsets. |

### Navigation (publishes events the caller acts on)

| method | publishes | purpose |
| --- | --- | --- |
| `paginate(offset)` | `paginator_goto_<id>` (payload: `offset`) | The core "go to this offset" action. Guards on caller/paginator `status` being ready, adds a `loading` class while the caller refreshes, and measures the caller's `.list_body` so the page-turn height change can be animated (see below). |
| `go_to_page_json(page)` | (via `paginate`) | Validates `1 ≤ page ≤ total_pages` and `page !== current`, converts page → offset (`(page-1) * limit`), then calls `paginate()`. |
| `navigate_to_next_page()` | (via `go_to_page_json`) | Page `+ 1`. |
| `navigate_to_previous_page()` | (via `go_to_page_json`) | Page `- 1`. |
| `show_all()` | `paginator_show_all_<id>` | Asks the caller to load every record (caller sets `limit = 0`). |
| `reset_paginator(limit)` | `reset_paginator_<id>` (payload: `limit`) | Asks the caller to restore the given `limit` after a *show all*. |

!!! warning "The paginator does not change its own offset"
    `paginate()` deliberately does **not** write `self.offset`. It only publishes
    the event; the caller's handler is the single writer of
    `caller.rqo.sqo.offset` and then re-navigates, which re-renders the
    paginator with the new state. Keeping one writer avoids the paginator and the
    caller drifting out of sync.

### The page turn is animated

The new page is often a different height than the old one (a value that took one
line on one page takes six on the next). Replacing the rows used to snap the
caller's `.list_body` to the new height in one frame, which moved the content
below it — on a phone, the whole form under the user's finger.

`paginate()` measures `.list_body` before publishing the event. When the caller
publishes `render_<caller.id>`, a **one-shot** listener removes the `loading`
class and animates the container from the measured height to the new one
(200 ms, `--transition-base`), clipped while it runs so no row paints over the
paginator. A page turn of equal height, a hidden list, or a user who asked for
reduced motion gets the instant swap.

The listener is one-shot on purpose: a repeating one would replay the stale
`height_from` on every later render of the caller (a save, a mode change).

The paginator's own `loading` dim is deferred (350 ms) in CSS, so a fast page
turn no longer blinks the controls; the pointer lock is still immediate.

## How it fits with the rest of Dédalo

- **[SQO](../sqo.md)** — `limit` / `offset` are SQO fields; the paginator reads
  them from `caller.rqo.sqo` and the navigation events ultimately mutate them.
  The total comes from the SQO `count` action (server count), not from
  `full_count` on the data query.
- **[section / section list](../sections/section.md)** — a section list view is
  the most common caller. `section.js` creates the paginator
  (`new paginator(); init({caller:self, mode:self.mode})`), subscribes to
  `paginator_goto_<id>` and routes it through `section.update_pagination(offset)`
  → `section.navigate(...)`. The section's list views (`view_default_list`,
  `view_base_list`, `view_thesaurus_list`, the user-preset views,
  `view_default_edit`) call `paginator.build()` then `paginator.render()`.
- **[component_portal](../components/component_portal.md)** — uses the `micro`
  view and is the only caller wiring **all three** events: `paginator_goto_`
  (set offset + navigate), `paginator_show_all_` (set `offset=0`, `limit=0`),
  and `reset_paginator_` (restore the saved limit). It seeds the paginator's
  `total`/`offset` from the component's `data.pagination` block.
- **time_machine service / dd_grid** — additional callers that subscribe to
  `paginator_goto_` to page their own result sets.
- **[event_manager](../events.md)** — the decoupling layer. The paginator and its
  caller never hold direct references for navigation; they communicate purely
  through `paginator_goto_<id>` / `paginator_show_all_<id>` /
  `reset_paginator_<id>` and the caller's `render_<caller.id>` event (a one-shot
  subscription drops the `loading` class and smooths the page-turn height).

## The caller contract

Any object can be a paginator caller if it provides:

| caller member | used for |
| --- | --- |
| `caller.id` | composing `self.id = 'paginator_' + caller.id` |
| `caller.mode` | default view mode at `init()` |
| `caller.rqo.sqo.limit` / `.offset` | the page model source |
| `caller.get_total()` | async total count |
| `caller.permissions` | inherited in `build()` |
| `caller.status` / `caller.model` | `paginate()` readiness guard (`status==='rendered'`, except `model==='time_machine'`) |
| `caller.node` | the element that gets the `loading` class during `paginate()`; its `.list_body` is the height that gets smoothed |
| event `render_<caller.id>` | published by the caller after refresh; the one-shot listener clears `loading` and animates the page-turn height |

## Examples

### A caller wiring a paginator (section list pattern)

```js
import {paginator} from '../../paginator/js/paginator.js'
import {event_manager} from '../../common/js/event_manager.js'

// inside the section/portal build()
if (self.paginator===null) {
    self.paginator = new paginator()
    self.paginator.init({
        caller : self,        // must expose rqo.sqo.limit/offset + get_total()
        mode   : self.mode    // 'list' | 'edit' | 'mini' | 'micro'
    })

    // the caller is the single writer of the offset
    const paginator_goto_handler = (offset) => {
        self.update_pagination(offset) // sets self.rqo.sqo.offset, then navigates
    }
    self.events_tokens.push(
        event_manager.subscribe('paginator_goto_'+self.paginator.id, paginator_goto_handler)
    )
}
```

### Rendering it into the list

```js
self.paginator.build()
const paginator_wrapper = await self.paginator.render() // dispatches to the mode's view
list_wrapper.appendChild(paginator_wrapper)
```

### The page model after a total fetch

```text
limit = 10, offset = 20, total = 57
→ total_pages   = ceil(57/10) = 6
→ page_number   = ceil(20/10)+1 = 3
→ page_row_begin= 21,  page_row_end = 30
→ offset_first  = 0
→ offset_prev   = 10   (offset - limit)
→ offset_next   = 30   (offset + limit)
→ offset_last   = 50   (limit * (total_pages-1))
```

## Related

- [SQO](../sqo.md) — `limit` / `offset` / `count`, the query the paginator pages
  over.
- [section (class reference)](../sections/section.md) — the canonical caller;
  `update_pagination()`, `get_total()`, `navigate()`.
- [Sections concept](../sections/index.md) — what a section list is.
- [component_portal](../components/component_portal.md) — the `micro` caller that
  wires *show all* / *reset*.
- [events](../events.md) — the `event_manager` publish/subscribe layer the
  navigation contract is built on.
