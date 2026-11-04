# UI building blocks

> The client-side **UI building blocks** of Dédalo's back-office: the page shell,
> the navigation menu, the section inspector, the paginator, ontology-driven
> buttons, record-level widgets and the LESS/theme design system.

> See also: [Architecture overview](../architecture_overview.md) ·
> [Components](../components/index.md) · [Sections](../sections/index.md) ·
> [CSS / LESS architecture](css_architecture.md)

## The client UI architecture in one paragraph

Dédalo's golden rule is **the server describes, the client draws** (see the
[architecture overview](../architecture_overview.md#the-datum-contract)).
The server never emits HTML for a record: it instantiates a section/component
from the ontology and ships a single `{context, data}` datum — `context` is the
*description* (model, label, permissions, css, tools, buttons, view, config) and
`data` is the *values*. The browser turns that datum into DOM. The subsystems in
this domain are the pieces that *consume* the datum and build the interface
around it. Almost all of them are **client-only** (pure JS + LESS) with no
server-side counterpart of their own — they read state another subsystem
already resolved server-side, render it, and re-publish user intent as
`event_manager` events:

- **`page`** is the single top-level instance (`window.dd_page`). It runs the
  server `start` action once, mounts the `menu` plus the active
  `section`/`area_*`/`section_tool`, and owns the global chrome (navigation,
  history, theme, notifications, the dynamic per-element CSS registry).
- **`menu`** is the only one of these with a dedicated server-side resolver
  (`getMenuTreeDatalist()`, `src/core/api/handlers/menu.ts`): it builds the
  permission-filtered navigation datalist (areas + sections the user may open)
  and the top utility bar; the client renders the tree and publishes
  `user_navigation` for `page` to act on.
- **`inspector`**, **`paginator`** and the **`buttons`** render layer are
  presentation layers over data the [section](../sections/index.md) instance
  already holds: the inspector reads the caller section's `context`/`data`/
  `tools`; the paginator reads the caller's SQO `limit`/`offset` plus the server
  `count`; buttons are ontology `button_*` nodes the server resolves into a
  `buttons` context array.
- **`widgets`** compute *derived* data (no storage of their own) inside a
  `component_info` host, and **`themes`** is the LESS design system (tokens,
  light/dark palettes, mixins, assets) every other UI surface is painted with.

## UI subsystems

| subsystem | doc | purpose |
| --- | --- | --- |
| **page** | [page.md](page.md) | The top-level client **page shell** (`window.dd_page`): boots the app from the server `start` action, mounts the menu + active section/area/tool, and owns navigation, browser history, theme, notifications and the dynamic CSS registry. |
| **menu** | [menu.md](menu.md) | The back-office **main navigation menu** — the permission-filtered tree of ontology areas/sections the user may reach, plus the top utility bar (user, language, theme, AI assistant, inspector toggle). The one subsystem here with a dedicated server-side resolver (`src/core/api/handlers/menu.ts`). |
| **command palette** | [command_palette.md](command_palette.md) | The <kbd>⌘</kbd>+<kbd>K</kbd> / <kbd>Ctrl</kbd>+<kbd>K</kbd> **search box**: jump to any menu section or open the current section's tools without browsing the menu; recent sections listed. Client-only; built from what the page already loaded. |
| **inspector** | [inspector.md](inspector.md) | The section edit view's right-hand **side panel**: record/component metadata, inspector tool buttons, project assignment, relations, Time Machine history and a live save/activity feed. Client-only; the caller section is its single source of truth. |
| **paginator** | [paginator.md](paginator.md) | The **pagination widget** that turns a caller's `limit`/`offset`/`total` into first/prev/next/last controls (`edit`/`mini`/`micro` views) and republishes clicks as offset-change events the caller acts on. Client-only; never talks to the API itself. |
| **buttons** | [buttons.md](buttons.md) | The ontology-driven **UI action** family — `button_*` nodes (New, Delete, import/tool triggers) a section declares as children, that the server resolves into a `buttons` context array the client turns into clickable buttons. |
| **widgets** | [widgets.md](widgets.md) | Reusable server+client pieces that **compute** derived data (via an IPO config) from a record's other components and are hosted inside a [`component_info`](../components/component_info.md) field. (Distinct from the unrelated `area_maintenance/widgets/` admin panels.) |
| **themes** | [themes.md](themes.md) | The **design-system / theming layer**: the LESS sources in `client/dedalo/core/page/css/`, the `:root` design tokens (light + dark palettes), the `data-theme="dark"` switch, and the `client/dedalo/core/themes/default/` static assets (icons, fonts, logos). |

## How this domain fits together

- **[Architecture overview](../architecture_overview.md)** — the
  server-describes / client-draws split and the `{context, data}` datum that
  every subsystem here consumes; `page.build()` is the client end of the
  [request lifecycle](../architecture_overview.md#the-request-lifecycle).
- **[Sections](../sections/index.md)** — the section is the central UI caller:
  it constructs the inspector, owns the paginator, declares the buttons, and is
  the "main" element `page` mounts and rebuilds on every navigation.
- **[Components](../components/index.md)** — the data-bearing fields a section
  renders; their `context.tools` flow into the inspector (`show_in_inspector`),
  their `context.css` flows through `page`'s dynamic CSS registry, and
  `component_info` is the host that runs `widgets`.
- **[CSS / LESS architecture](css_architecture.md)** — the companion to
  [themes.md](themes.md): the `main.less` import layering, the design tokens and
  mixins, and the per-component LESS contract every UI surface is built on.
