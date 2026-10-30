---
name: dedalo-tools-ts
description: Use when creating a new Dédalo v7 tool (tools/tool_<name>/) or adapting an existing one — scaffolding with scripts/create_tool.ts, register.json / the dd1340 → dd1324 registration, a server/index.ts apiActions permission kind, the tool client (wire_tool, tool_request, open_tool, open_as modal/window, ddo_map/tool_config, get_tool_label), tool CSS (identity colour, tool_header, css:tool-colors), making a tool work on a phone or touch screen, or when a tool "does not appear", "opens blank", throws "tool_request is not a function" / "view_window: caller is required", or a tool_* tripwire fails.
---

# Creating and adapting Dédalo tools

## Overview

A tool is `tools/tool_<name>/` — `register.json`, `server/index.ts`, `js/`, `css/`, `img/icon.svg` — attached to components, sections or areas by its registration. **The manual is the procedure**; this skill routes you into it and carries what the manual does not say. Read, in order: `docs/development/tools/creating_tools.md` (end-to-end), then `server_contract.md`, `js_lifecycle.md`, `register_json.md`, `security.md`, `phone_layout.md` in the same directory.

## Create or adapt?

| Request | Path |
|---|---|
| New capability, no tool does it | Name: `tool_<tld>_<feature>` for a tool meant to be shared between installs; a core tool shipped in this repo uses `tool_<feature>`. Scaffold: `bun run scripts/create_tool.ts --name=tool_<tld>_<feature> --label="…" --models=<model,…>` (copies `tools/tool_dev_template`, generates its colours, enters it in the phone ratchet as pending). |
| Change how an existing tool opens, attaches or is labelled | Registration change (below), not code. |
| Change behaviour / UI of an existing tool | Edit its `js/` + `server/`; read the tool's page in `docs/development/tools/reference/` first. |

## Registration: the record is the truth

- Metadata (labels, `open_as`, affected models/tipos, flags, config) is authored in **Tools development** (`dd1340`), exported with *Download register file* into `register.json`, and served from **Registered tools** (`dd1324`) after *Register tools* runs. Editing `register.json` alone changes nothing users see.
- *Register tools* WRITES dd1324 (`importTools({dryRun:false})`), and so does every code update (the run's ancillary phase, keeping each tool's stored Active value). `TOOLS_ENABLE_REGISTRY_IMPORT` is retired (WC-2026-10-30-tools-registry-import-switch-retired): a bare `importTools()` is a dry run, so "I re-registered and nothing changed" means a caller forgot `dryRun:false`, or the tool's register.json is invalid (see the report's `errors`).
- A dev/suite database may have **no `dd1340` rows at all**; the registered records live in `dd1324` (`matrix_tools`). Check before assuming the authoring flow is available.
- Tool UI strings are **tool-local** (`dd1372` labels, read with `self.get_tool_label('key')`), never `src/core/labels/master.json`. Edit them with `tool_dd_label`; with no `dd1340` record, use the authoring format's `labels` field (`docs/development/tools/register_json.md`).
- Bump the version (`dd1327` / `version`) on every registration change: the *Register tools* panel shows file-vs-registry drift by version.
- `open_as` lives in properties (`dd1335`); `modal` is the default.

## Server: pick the permission kind by what the action touches

`server/index.ts` exports `tool: ToolServerModule` with `name` === directory name. Each `apiActions` entry declares `permission` and `minLevel` (1 = read, 2 = write) — full rule in the comment above it in `src/core/tools/module.ts`. Read data through the engine's read path, never SQL (`docs/development/tools/server_contract.md`).

| The action reads/writes… | `permission` |
|---|---|
| a component of one record | `'record_tipo'` |
| a record | `'record'` |
| a component, any record | `'tipo'` |
| a section | `'section'` |
| targets inside a payload (sqo, ddo_map, pinned constant) | `'targets'` |
| developer-only machinery | `'developer'` |
| nothing gateable | `null` + `gatedInHandler` reason (named exemption, `tool_permission_census_tripwire`) |

## Client traps

- `wire_tool(ctor, render)` provides render/destroy/refresh/**tool_request**/edit/list. Other `tool_common` methods you need, assign yourself.
- `build()` work that is async must be **awaited inside its try/catch**. An un-awaited promise escapes it, and the tool never renders and shows no error panel.
- A **window** tool rebuilds its caller from the URL with `get_instance(model)`: the caller must be a real, importable element. A launcher with no live element passes its home area (e.g. `{model:'area_maintenance', tipo:'dd88', …}`), never an invented model and never nothing (`view_window: caller is required`).
- DOM text goes through `text_content`, not `inner_html` (`render_escape_tripwire` counts sinks per file).
- Tool JS has **no cache-bust**: hard-reload before deciding a change "didn't work".

## CSS

- Identity colour: `--tool_<name>` in the tool's `.less` → `bun run css:tool-colors` → `bun run css:build`. The sheet must `@import (once)` the core `vars`.
- Never paint `.tool_header` or put text on the raw hue (`.tool_action_button()` mixin). Full rules: creating_tools.md § Colour and styling.
- Every `@media` width names a `@width_break_point_*` token.

## Phone (required for every tool)

Contract, shared rules and gestures: `docs/development/tools/phone_layout.md`. A drag has a touch twin: drag-onto-target → `common/js/touch_pick.js` (same payload, same drop handler); drag-sort → `tools_common/js/phone_reorder.js`. Prove it: add a probe in `test/helpers/tool_phone_ratchet.ts` (a component or section tool uses the default `context` kind — `test3('<tipo>', '<model>')`; `bun run test:tools:phone --discover test3/1` lists which live elements offer which tools), run `bun run test:tools:phone --tool <name> --shots <dir>`, **read the screenshot**, then move the tool from `NOT_YET_PHONE` to `PHONE_CASES`.

## Done means

- [ ] Server action test through the dispatcher on the SUITE db (`test/unit/tools_dispatch.test.ts` pattern; generic `test` TLD, built situation, refused-caller case). REQUIRED: dedalo-ts-testing.
- [ ] Client suite: a `test_tool_<name>.js` registered in `client/dedalo/test/client/js/test_registry.js`. Every added suite raises the banked `suite_floor` (`engineering/client_gate_inventory.json`): after a green run, `bun run scripts/client_test_runner.ts --update`.
- [ ] `bun test test/unit/tool_*` + `render_escape_tripwire` + `labels_tripwire` + `census_derivation_tripwire`; `bunx tsc --noEmit`; `bun run test:client`; `bun run test:tools:phone`.
- [ ] Reference page `docs/development/tools/reference/tool_<name>.md` + catalog row (REQUIRED: dedalo-docs-authoring); changelog fragment for any change a user or admin sees, registration-only changes included (`bun run changelog new <slug>`).
