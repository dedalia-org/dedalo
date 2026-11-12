# tool_import_marc21

Parses uploaded MARC21 binary files (`.mrc`) and maps their fields/subfields to Dédalo components per an ontology-driven configuration, matching existing records or creating new ones.

## What it does / why & when to use it

MARC21 is the de-facto interchange format for library catalogues. Heritage institutions that already hold their bibliographic data in an ILS (Koha, Sierra, Symphony, Aleph...) routinely export it as MARC21 records. `tool_import_marc21` lets a cataloguer load those `.mrc` files directly into a Dédalo Publications section instead of re-keying every record by hand.

Concrete scenario: a museum library has 4 000 monograph records in its ILS. It exports them to `catalogo.mrc` and opens the import tool on the Publications section. The tool reads each MARC record, uses control field **907 $a** as the stable identifier to decide *update vs. create*, then walks a configurable field map — title from **245**, edition from **250**, imprint/editor/date from **260/264**, ISBN from **020**, summary from **520**, subject headings (indexations) concatenated from the **6xx** block, item holdings from **945**, language and material type from **998** — and writes each value into the matching Dédalo component, with multi-language and date handling along the way.

Use it for any one-shot or recurring bulk ingest of bibliographic data already available as MARC21. For round-tripping Dédalo's own exports use [tool_import_dedalo_csv](tool_import_dedalo_csv.md); for arbitrary RDF/OWL graphs use [tool_import_rdf](tool_import_rdf.md); for Zotero JSON use [tool_import_zotero](tool_import_zotero.md).

## How it works

### Server

`tools/tool_import_marc21/server/index.ts` (+ `src/core/tools/marc21.ts`) implements a from-scratch ISO 2709 parser (no 3rd-party library) plus `applyMarcMap` → the shared import executor, scratch-twin verified (a synthetic MARC record + map produces the mapped record, then deleted — no orphans). The single remotely callable action is `import_files`.

1. **WRITE gate.** Declaratively gated `permission: 'targets', minLevel: 2` on the caller pair AND every component the `config.map` binds (the `id` entry's ddo_map code component included), enforced before the handler runs. A missing `section_tipo` or empty `files_data` returns an error response immediately.
2. **Config shape.** `readMarcMap` reads the marc21 map from `tool_config.config.main` as **one flat array** of `{name, value}` entries: it treats the entry named `field_to_section_id` as the id anchor and every other entry as a field-mapping rule. `tool_config.config` must carry exactly that one `main` array — a config shaped with `main` and a separate `map` block will not map correctly, because `readMarcMap` never reads a `map` key. Build (or reshape) the config to the single flat-array shape before relying on a production marc21_map.
3. **Per-file parse.** Each staged `.mrc` file (path-confined under the user's upload temp dir) is read and parsed with `parseMarc` (`src/core/tools/marc21.ts`), a from-scratch ISO 2709 reader.
4. **Per-record mapping.** `applyMarcMap` extracts and transforms each mapped field (subfield/joined/control-field extraction, `field_to_section_id` resolution) into a `MappedRecord`.
5. **Execute.** `importMappedRecords` (the shared executor, `src/core/tools/import_execute.ts`) resolves target vs. new records and writes through `createSectionRecord`/`saveComponentData` — the same executor the other import tools use.
6. Returns `{result, msg, errors, created, updated, failed}`.

Only `import_files` is dispatchable; the parser, mapper and executor are plain functions, not separately exposed actions.

### Client

`tools/tool_import_marc21/js/` wires the standard tool lifecycle (`init`/`build`/`edit`/`render` via `tool_common`). `init()` derives `key_dir = caller.tipo + '_' + caller.section_tipo`. `build()` skips the generic ddo_map autoload and instead builds two services: `service_upload` in multi-file mode (`multiple: true` — the file upload drop zone) and `service_tmp_section` (the manual "Values" inputs for ddo_map role `input_component`). `render_tool_import_marc21.js` draws the drop zone, the values block and an **IMPORT** button; clicking it gathers `service_tmp_section.get_components_data()`, builds the request via `create_source(self, 'import_files')` and calls `data_manager.request()` with a long timeout (3600 s, 1 retry). The tool opens as a separate window (`properties.open_as: "window"`). Styling lives in `css/tool_import_marc21.less`.

## Actions & options

`apiActions = { import_files: { permission: 'targets', minLevel: 2, targets: importMarc21Targets, handler: importFiles } }`.

| Action | Permission | Key options it reads |
| --- | --- | --- |
| `import_files` | declarative `permission: 'targets', minLevel: 2` on `(section_tipo, tipo)` + `(section_tipo, <every config.map tipo>)` | `section_tipo` (target section, **required**), `tipo` (portal/component context), `section_id` (current section), `tool_config` (carries `ddo_map` + the `config.main` marc21 map array — see the shape divergence above), `files_data` (uploaded `.mrc` file objects), `components_temp_data` (manual "Values" inputs), `key_dir` (upload directory id) |

`import_files` is the only remotely callable action. It is **not** in `backgroundRunnable`; the long-running work runs synchronously behind the client's extended request timeout.

The behaviour of the import is driven by the tool **configuration**, not by the request options. **Rule keys actually implemented by `applyMarcMap`/`extractMarcValues` (`src/core/tools/marc21.ts`):**

| Key | Meaning | TS status |
| --- | --- | --- |
| `field` | MARC field tag, e.g. `"245"` | ✅ |
| `subfield` | Specific subfield code (`"a"`); omit to concatenate all subfields | ✅ |
| `component_tipo` | Target Dédalo component tipo (the value is written here) | ✅ |
| `subfield_separator` | Separator when joining all subfields of a field | ✅ |
| `marc21_conditional` | `{subfield, value}` — only extract when that sibling subfield equals `value` (e.g. 945 holdings where `$j == 193`) | ✅ |
| `field_to_section_id` | `{field, subfield}` (e.g. 907 $a) used to identify a record for update vs. create | ✅ (read as the one `config.main` entry named `field_to_section_id`) |

**Rule keys with no implementation in `marc21.ts` today** — a config using any of these silently loses that transform (the field still extracts, but untransformed):

| Key | Intended meaning | TS status |
| --- | --- | --- |
| `field_multiple` + `row_separator` | Concatenate values across several fields with this separator (e.g. the 6xx indexation block) | ⬜ not implemented |
| `partial_left_content` | Take the leftmost N chars, parsed as integer (e.g. a 4-digit year) | ⬜ not implemented |
| `date_format: "year"` | Wrap the value as a `dd_date` start year | ⬜ not implemented |
| `dd_data_map` | Map a raw code to a Dédalo locator (e.g. 998 $f language code → a `lg1` section reference) | ⬜ not implemented |
| `dd_action` | Companion components to set when the main value is populated (e.g. set the standard-number type when an ISBN is present) | ⬜ not implemented |
| `skip_on_empty` | Do not store when the extracted value is empty | ⬜ not implemented (extraction already filters empty values, but the explicit flag/semantics aren't modeled) |

Config anchors beyond `field_to_section_id` (`code`, `section`, `project`, `pdf`, `identifying_image`, `transcription`, `transcription_review`, `field_standard_number`) that would drive companion writes (PDF/image/standard-number handling) have no implementation in `marc21.ts` or the shared import executor — only the plain field→component mapping is applied.

## How it is registered & surfaced

`tools/tool_import_marc21/register.json` is a **column-keyed dump** (`string`/`relation`/`misc`/… keyed by component tipo — a seeded matrix-row snapshot, not a hand-authored file); `importTools()` passes it through as-is (see [register.json reference](../register_json.md)). The essentials it declares:

- `name` (dd1326): `tool_import_marc21`, `version` (dd1327): `2.0.4`, `dedalo_version_min` (dd1328): `6.0.0`, developer (dd1644): "Dédalo team".
- **affected_models** (relation via dd1337 → dd153 section_id 1): `section` — the tool attaches to sections.
- **active** (dd1354 → dd64 section_id 1 = Yes): registered active.
- **show_in_inspector** (dd1331 → dd64 section_id 2 = No): **not** flagged for the inspector panel in this register; the tool is surfaced through the section's tool config / ddo_map rather than an inspector button. `show_in_component` (dd1332) is absent → defaults false.
- `properties` (dd1335): `{ "open_as": "window", "windowFeatures": null }` — opens in its own window.
- `default_config` (dd1633): a MARC reference config carrying separate `main` and `map` blocks (mirrored in `sample_config.json`). **This is the two-block shape `readMarcMap` does not read** (see *Config shape* above) — do not use it as-is. Per the comment in the config, do not edit dd1633 directly either: copy it into the Tools configuration section (dd996), reshape it to the single flat `main` array, and edit there.
- UI labels (dd1372): `file_processor`, `target_componet`, `quality`, retrieved client-side via `get_tool_label(...)`.

Because surfacing is element-driven (`getElementTools`, `src/core/tools/registry.ts`), the tool appears on Publications-style sections (rsc205 in the reference config) once the user's profile is authorized for it and the section carries the tool in its config.

## Examples

Client-side request built by the IMPORT button (`render_tool_import_marc21.js`) — the RQO sent to `dd_tools_api`:

``` js
const source = create_source(self, 'import_files') // → tool_import_marc21::import_files(options)
const rqo = {
    dd_api  : 'dd_tools_api',
    action  : 'tool_request',
    source  : source,
    options : {
        tipo                 : self.caller.tipo,
        section_tipo         : self.caller.section_tipo, // e.g. 'rsc205' (Publications) — WRITE-gated
        section_id           : self.caller.section_id,
        tool_config          : self.tool_config,        // carries ddo_map
        files_data           : self.files_data,          // uploaded *.mrc descriptors
        components_temp_data : self.service_tmp_section.get_components_data(),
        key_dir              : self.key_dir
    }
}
data_manager.request({ body: rqo, retries: 1, timeout: 3600 * 1000 })
```

A single `map` rule (from the reference config) that ingests the title statement, MARC field 245, into the title component `rsc140`:

``` json
{ "info": "Title mention", "field": "245", "tipo": "rsc140" }
```

A conditional holdings rule (945 $a, only when sibling $j equals 193 — ✅ supported on TS) and a year-from-imprint rule (**⬜ `partial_left_content`/`date_format` are not implemented on TS** — the extracted string would be stored as-is, not parsed into a `dd_date`):

``` json
{ "info": "Topographic", "field": "945", "subfield": "a", "tipo": "rsc359",
  "marc21_conditional": { "subfield": "j", "value": "193" } }

{ "info": "Publication date", "field": "260", "subfield": "c", "tipo": "rsc224",
  "partial_left_content": 4, "date_format": "year" }
```

## Related

- [tool_import_dedalo_csv](tool_import_dedalo_csv.md) — CSV import / Dédalo export round-trips
- [tool_import_rdf](tool_import_rdf.md) — RDF/OWL graph import
- [tool_import_zotero](tool_import_zotero.md) — Zotero JSON bibliographic import
- [tool_import_files](tool_import_files.md) — media file ingest (shares the multi-file upload-queue pattern)
- [tool_export](tool_export.md) and [Exporting data](../../../using/exporting_data.md) — the export side
- [Importing data](../../../using/importing_data.md) — the per-component import-data contract
- [Creating new tools](../creating_tools.md), [Server contract](../server_contract.md), [register.json reference](../register_json.md), [Security](../security.md)
- Source: `tools/tool_import_marc21/server/index.ts`; MARC parser + mapper: `src/core/tools/marc21.ts`; shared executor: `src/core/tools/import_execute.ts`.
