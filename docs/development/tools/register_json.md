# register.json reference

Every tool ships a `register.json` in its root directory. It is read by `importTools()` (`src/core/tools/register.ts`) — driven by the area_maintenance "Register tools" widget — and reconciled against the registered-tools section (dd1324, table `matrix_tools`).

The machine-readable source of truth for **hand-authored** files is the JSON Schema at `src/core/tools/register.schema.json` (mirrored by the Zod schema `authoringRegisterSchema` in `src/core/tools/register_schema.ts`). Point your editor at it for autocomplete and validation:

``` json
{ "$schema": "../../src/core/tools/register.schema.json", "...": "..." }
```

The same rules are enforced at registration by `importTools()`: an invalid authoring file is refused with explicit errors in the import report.

## Three formats you will meet

`detectFormat()` (`register.ts`) recognizes three shapes:

| Shape | Detected by | Status |
| --- | --- | --- |
| **Column-keyed dump** | top-level `data`/`string`/`relation`/… keys | Pass-through — validated and used as-is. **All 34 in-repo `register.json` files are this shape**: matrix-row dumps of a "Tools development" (dd1340) record, produced by the inspector's *Download register file* button — see [Creating new tools](creating_tools.md#4-export-the-register-file). Never hand-edited: the record is edited and re-exported. |
| **Authoring** (flat, hand-written) | top-level `name` key | Converted to the column-keyed shape before validation/import. This is the format `scripts/create_tool.ts` writes for a **new** tool. |
| **Legacy v6** | top-level `components` key | **Not supported this wave** — none of the 34 in-repo tools use it, so this has not blocked any real port; `register.ts` reports it and does not import it. |

Both supported shapes are legitimate ways to register a new tool: author the record in dd1340 and export it (the shipped tools' route), or hand-write the **authoring** format below (what the scaffolder gives you, and the portable one — `affected_models` are names resolved to dd1342 locators at import). What you must not do is hand-edit an exported dump.

## Minimal authoring file

``` json
{
	"$schema": "../../src/core/tools/register.schema.json",
	"name": "tool_myorg_mytool",
	"version": "1.0.0",
	"label": { "lg-eng": "My tool" },
	"affected_models": ["section"]
}
```

This is exactly what `bun run scripts/create_tool.ts --name=... --label=... --models=...` writes for you.

## Fields (authoring format)

| Field | Type | Description |
| --- | --- | --- |
| `name` | string, **required** | Tool name, `^tool_[a-z0-9_]+$`, must equal the directory name |
| `version` | string, **required** | Semantic version, e.g. `1.0.0` |
| `label` | object, **required** | Display label keyed by lang code (`lg-eng`, `lg-spa`...), at least one language. The client falls back across languages |
| `description` | object | Free description per lang |
| `developer` | string | Author name(s) |
| `dedalo_version_min` | string | Minimum compatible Dédalo version |
| `affected_models` | string[] | Models the tool applies to, e.g. `["section"]`, `["component_input_text","component_text_area"]`, or `["all_components"]` |
| `affected_tipos` | string[] | Optional restriction to specific ontology tipos (e.g. `["rsc36"]`). Empty/absent = no restriction |
| `show_in_inspector` | bool | Tool button in the section inspector panel |
| `show_in_component` | bool | Tool button inline on matching components |
| `require_translatable` | bool | Only offer the tool on translatable components |
| `always_active` | bool | Available to every user regardless of the tools-profile grant |
| `active` | bool | Active status after registration (default `true`) |
| `properties` | object\|null | UI/behavior hints: `{"open_as": "modal"}` or `{"open_as": "window", "windowFeatures": {...}}`, optional `events` (keyboard shortcuts), optional `tool_config` with `ddo_map` |
| `labels` | array | UI strings: `[{"lang": "lg-eng", "name": "key", "value": "Text"}, ...]`, retrieved in JS via `get_tool_label('key')` |
| `ontology` | array\|null | Optional tool ontology extension nodes |
| `config` | object\|null | Runtime configuration definition. Properties flagged `"client": true` are exposed to the browser (`getToolClientConfig`) — never put secrets there |
| `default_config` | object\|null | Factory default configuration; per-install overridable in the Tools configuration section (dd996) |

Every field maps to a fixed ontology tipo (`TOOL_NAME`, `TOOL_VERSION`, `CONFIG`, `DEFAULT_CONFIG`, `PROPERTIES`, `LABELS`, `AFFECTED_MODELS`, `AFFECTED_TIPOS`, `ACTIVE`, …) declared once in `src/core/tools/ontology_map.ts` — use those constants in any code reading registry data, never literal `dd1326`-style strings.

## Where the data lands

At registration the file is reconciled into a record of the "Registered Tools" section (dd1324, `matrix_tools`). `importTools()` defaults to **dry-run** (see [Server contract](server_contract.md)): it reports, per tool, whether the registry already reflects the file's declared identity, without writing. The area_maintenance *Register tools* widget is the exception — its own action always performs a real import, so the button an administrator presses does write. A code update also re-registers every tool, keeping each one's Active value as the administrator left it.

!!! warning "The registry is what runs, not the file"

    Dédalo serves a tool's metadata — label, description, configuration,
    affected models, the version shown to users — from the **registry record**,
    never by re-reading `register.json` at runtime. Editing the file therefore
    changes nothing until the tool is registered again.

    The *Register tools* panel in
    [area_maintenance](../../core/areas/area_maintenance.md) is where this
    becomes visible. It shows two version columns per tool — **Installed** (the
    registry) and **Version** (what the file on disk declares) — and flags every
    tool where the two disagree, where a directory exists with no registry
    record, or where a record survives a directory that is gone. Press *Register
    tools* to reconcile; the first two states are exactly what it fixes. The
    third is not: no directory means the importer has nothing to read, so either
    the record is deleted or the tool's files are restored.

    So: **bump `version` when you change a tool's registered metadata**, and
    re-register. A version left untouched makes a stale registry look correct.

## Legacy v6 format

Files with a top-level `components`/`relations` key (raw v6 record dumps) are **not supported this wave** — `register.ts` detects the shape but does not convert it. None of the 34 in-repo tools are in this shape, so no in-repo tool is affected; a genuinely legacy v6 file would need converting to the column-keyed or authoring format before it can be imported.
