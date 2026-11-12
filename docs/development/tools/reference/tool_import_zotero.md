# tool_import_zotero

Imports a Zotero bibliographic export into a Dédalo Publications section (rsc205), mapping Zotero fields to components.

## What it does / why & when to use it

Zotero is one of the most widely used reference managers in academic and heritage research. This tool parses Zotero's **RDF/XML** export (a `.rdf`/XML file, `<z:Item>` elements with Dublin Core predicates like `dc:title`) using the same parser as [tool_import_rdf](tool_import_rdf.md), and ingests the matched fields into a Dédalo section — typically a Publications section (rsc205) — so a bibliography does not have to be re-keyed by hand.

Concrete scenario: a museum's research department keeps the bibliography of an exhibition catalogue in Zotero. They export the collection as RDF/XML and open the import tool on the Publications section, configure a field-map (a list of `{predicate, component_tipo}` entries — e.g. `dc:title` → the title component), and import. For each parsed Zotero `<z:Item>` subject, the tool applies the map: every predicate that has a matching entry writes its literal or resource value into that component, on a newly created (or already-targeted) record, through the same write path the CSV and MARC21 imports use.

Use it for bulk ingest of references already curated in Zotero, once a predicate→component map has been configured for the target section. For round-tripping Dédalo's own exports use [tool_import_dedalo_csv](tool_import_dedalo_csv.md); for library MARC21 records use [tool_import_marc21](tool_import_marc21.md); for arbitrary RDF/OWL graphs use [tool_import_rdf](tool_import_rdf.md).

## How it works

### Server

`tools/tool_import_zotero/server/index.ts` — this tool's `import_files` action writes, through the same shared executor the other import tools use. The single remotely callable action, `import_files`:

1. **WRITE gate.** Declaratively gated `permission: 'targets', minLevel: 2` on `(section_tipo, tipo)` AND on `(section_tipo, <component_tipo>)` for every `config.main` field-map entry — the components the import actually writes.
2. **Config.** Reads the field-map from `tool_config.config.main` as an array of `{predicate, component_tipo}` entries (`readFieldMap`). Missing or empty map → refused (`Missing Zotero field-map`).
3. **File filter.** Keeps only staged files under the per-user upload temp dir; each is read as **RDF/XML text**.
4. **Parse + map.** `parseRdfXml` (`src/core/tools/rdf_xml.ts`) extracts subjects/predicates from the RDF/XML; `applyRdfMap` resolves each subject's predicates against the field-map into a `MappedRecord` (`{component_tipo, value}` pairs) — a flat predicate→component mapping: no dedicated author-name flattening, `issued`/`accessed` date parsing, container-title Series/Collection resolve-or-create, type→typology lookup, or ISBN/ISSN→standard-number-typology handling; a plain predicate maps straight to a component value.
5. **Execute.** `importMappedRecords` (the shared executor, `src/core/tools/import_execute.ts`) resolves target vs. new records per mapped subject and writes through `createSectionRecord`/`saveComponentData`.
6. Returns `{result, msg, errors, created, updated, failed}`.

PDF import with first-page identifying-image extraction (an `archive` field naming an uploaded PDF) is **not implemented** — the field-map only maps a predicate straight to a component value; there is no PDF-specific handling or image-extraction step in `tools/tool_import_zotero/server/index.ts`. There is likewise no dedicated update-vs-create resolution keyed off a bibliographic identifier field — the shared executor's own record-matching rules apply instead (see [Importing data](../../../using/importing_data.md)), and there is no manual temp-data merge step.

`import_files` is listed in `backgroundRunnable`; the client always sends `background_running: true` (see [Server contract](../server_contract.md) for how this runs without a CLI fork).

### Client

`tools/tool_import_zotero/js/` wires the standard tool lifecycle through `tool_common`. `init()` derives `key_dir = caller.tipo + '_' + caller.section_tipo`. `build()` deliberately skips the generic ddo_map autoload (`load_ddo_map: () => []`) and instead builds two services: `service_upload` in multi-file mode (`multiple: true` — the file upload / drop zone for the JSON + PDFs) and `service_tmp_section` (the manual "Values" inputs, filtered to ddo_map role `input_component`). `render_tool_import_zotero.js` draws the drop zone, the Values block and an **IMPORT** button; clicking it gathers `service_tmp_section.get_components_data()`, builds the request via `create_source(self, 'import_files')` and calls `data_manager.request()` with a 3600 s timeout and a single retry, then shows the success/error message and reloads. The tool opens as a separate **window** (`properties.open_as: "window"`). Styling lives in `css/tool_import_zotero.less`.

## Actions & options

`apiActions = { import_files: { permission: 'targets', minLevel: 2, targets: importZoteroTargets, handler: importFiles } }` — only `import_files` is declared:

| Action | Permission | Key options it reads |
| --- | --- | --- |
| `import_files` | declarative `permission: 'targets', minLevel: 2` on `(section_tipo, tipo)` + every field-map component | `section_tipo` (target section, **required**, gated), `tipo` (caller component/portal tipo), `section_id` (current section), `tool_config` (carries `config.main`, the field-map array — see below), `files_data` (uploaded file descriptors — an RDF/XML export), `key_dir` (upload directory id) |

**Config shape — `tool_config.config.main`, an array of flat entries:**

| Field | Purpose |
| --- | --- |
| `predicate` | The RDF predicate to match (e.g. `dc:title`), read from each parsed subject. |
| `component_tipo` | The Dédalo component the matched predicate's value is written to. |

## How it is registered & surfaced

`tools/tool_import_zotero/register.json` is a **column-keyed dump** (`string`/`relation`/`misc`/… keyed by component tipo — a seeded matrix-row snapshot, not a hand-authored file); `importTools()` passes it through as-is (see [register.json reference](../register_json.md)). The essentials it declares:

- `name` (dd1326): `tool_import_zotero`, `version` (dd1327): `2.0.3`, `dedalo_version_min` (dd1328): `6.0.0`, developer (dd1644): "Dédalo team", label (dd799): "Import Zotero" (multi-language).
- **affected_models** (relation via dd1337 → dd153 section_id 1): `section` — the tool attaches to sections.
- **active** (dd1354 → dd64 section_id 1 = Yes): registered active.
- **show_in_inspector** (dd1331 → dd64 section_id **2** = No): not flagged for the inspector panel; the tool is surfaced through the section's tool config / ddo_map rather than an inspector button. **show_in_component** (dd1332 → dd64 section_id **1** = Yes): can render inline on the component.
- `properties` (dd1335): `{ "open_as": "window", "windowFeatures": null }` — opens in its own window.
- `default_config` (dd1633): the ontology's seeded default configuration for this tool (mirrored in `sample_config.json`). The field-map array `import_files` actually reads is `config.main` — see *Actions & options* above. Per the comment in `sample_config.json`, do not edit dd1633 directly — copy a **full** configuration into the Tools configuration section (dd996, "Development → Tools → Tools configuration") and edit there.
- UI labels (dd1372): `file_processor`, `target_componet`, `quality`, retrieved client-side via `get_tool_label(...)`.

Because surfacing is element-driven (`getElementTools`, `src/core/tools/registry.ts`), the tool appears on Publications-style sections (rsc205 in the reference config) once the user's profile is authorized for it and the element carries the tool in its config.

## Examples

Client-side request built by the IMPORT button — `files_data` must be an RDF/XML export:

``` js
const source = create_source(self, 'import_files') // → tool_import_zotero.import_files
const rqo = {
    dd_api  : 'dd_tools_api',
    action  : 'tool_request',
    source  : source,
    options : {
        tipo                 : self.caller.tipo,
        section_tipo         : self.caller.section_tipo, // e.g. 'rsc205' (Publications) — gated
        section_id           : self.caller.section_id,
        tool_config          : self.tool_config,        // carries config.main (the field-map array)
        files_data           : self.files_data,          // an RDF/XML Zotero export
        key_dir              : self.key_dir
    }
}
data_manager.request({ body: rqo, retries: 1, timeout: 3600 * 1000 })
```

A TS field-map entry mapping the Dublin Core title predicate to a title component:

``` json
{ "predicate": "dc:title", "component_tipo": "rsc140" }
```

PDF import with first-page identifying-image extraction (an `archive` field naming an uploaded PDF) is not implemented — see the note above.

## Related

- [tool_import_marc21](tool_import_marc21.md) — MARC21 library-catalogue import (shares the shared-executor write path).
- [tool_import_dedalo_csv](tool_import_dedalo_csv.md) — CSV import / Dédalo export round-trips.
- [tool_import_rdf](tool_import_rdf.md) — the sibling RDF/XML import tool this one's parser and mapper are shared with (`src/core/tools/rdf_xml.ts`) — but unlike `tool_import_rdf`'s `get_rdf_data`, this tool's `import_files` actually writes.
- [tool_import_files](tool_import_files.md) — media file ingest (shares the multi-file upload-queue pattern).
- [tool_export](tool_export.md) and [Exporting data](../../../using/exporting_data.md) — the export side.
- [Importing data](../../../using/importing_data.md) — the per-component import-data contract.
- Source: `tools/tool_import_zotero/server/index.ts`; RDF parser + mapper: `src/core/tools/rdf_xml.ts`; shared executor: `src/core/tools/import_execute.ts`.
- [Creating new tools](../creating_tools.md), [Server contract](../server_contract.md), [register.json reference](../register_json.md), [Security](../security.md)
