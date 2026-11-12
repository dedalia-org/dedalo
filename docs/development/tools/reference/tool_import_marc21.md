# tool_import_marc21

Parses uploaded MARC21 binary files (`.mrc`) and maps their fields/subfields to Dédalo components per an ontology-driven configuration, matching existing records or creating new ones.

## What it does / why & when to use it

MARC21 is the de-facto interchange format for library catalogues. Heritage institutions that already hold their bibliographic data in an ILS (Koha, Sierra, Symphony, Aleph...) routinely export it as MARC21 records. `tool_import_marc21` lets a cataloguer load those `.mrc` files directly into a Dédalo Publications section instead of re-keying every record by hand.

Concrete scenario: a museum library has 4 000 monograph records in its ILS. It exports them to `catalogo.mrc` and opens the import tool on the Publications section. The tool reads each MARC record, uses control field **907 $a** as the stable identifier to decide *update vs. create*, then walks a configurable field map — title from **245**, edition from **250**, imprint/editor/date from **260/264**, ISBN from **020**, summary from **520**, subject headings (indexations) concatenated from the **6xx** block, item holdings from **945**, language and material type from **998** — and writes each value into the matching Dédalo component, with multi-language and date handling along the way.

Use it for any one-shot or recurring bulk ingest of bibliographic data already available as MARC21. For round-tripping Dédalo's own exports use [tool_import_dedalo_csv](tool_import_dedalo_csv.md); for arbitrary RDF/OWL graphs use [tool_import_rdf](tool_import_rdf.md); for Zotero JSON use [tool_import_zotero](tool_import_zotero.md).

## How it works

### Server

`tools/tool_import_marc21/server/index.ts` (+ `src/core/tools/marc21.ts`) implements a from-scratch ISO 2709 parser (no 3rd-party library) plus `applyMarcMap` → the shared import executor, scratch-twin verified (a synthetic MARC record + map produces the mapped record, then deleted — no orphans). The single remotely callable action is `import_files`.

1. **WRITE gate.** Declaratively gated `permission: 'targets', minLevel: 2` on the caller pair and every **Values** field (`input_component` rows of the client `tool_config.ddo_map`), enforced before the handler runs. The field map's components are not known before the run (the map is server configuration), so the shared executor asks the write door for **every mapped field of every record**: a component the caller may not write is reported `IGNORED` and never written. A missing `section_tipo` or empty `files_data` returns an error response immediately.
2. **Config.** `parseMarcConfig` reads the map from the **server**: `getToolConfig('tool_import_marc21')`, i.e. the Tools configuration (dd996) per key over the register default (dd1633). `map` holds the field→component rules; `main` holds the global settings, of which the entry named `field_to_section_id` is the identifier spec. The client-posted `tool_config` is read for its `ddo_map` only — a posted `map`/`main` is ignored. Every rule is validated before a file is read: a missing or empty `map`, a rule without `tipo`, a malformed field or transform, or an **unknown key** refuses the run (`request.invalid_options`) naming the rule (its index and `info`) and the key. A background run reads the configuration when it runs, not when it was queued.
3. **Values form.** The non-empty `input_component` fields of `components_temp_data` become extra fields of every record (after the mapped ones, so a Values value wins). A Values field of a section other than the import section refuses the run before anything is written.
4. **Per-file parse.** Each staged `.mrc` file (path-confined under the user's upload temp dir) is read and parsed with `parseMarc` (`src/core/tools/marc21.ts`), a from-scratch ISO 2709 reader.
5. **Per-record mapping.** `applyMarcMap` extracts each rule's value (`extractMarcValue`), transforms it (`transformMarcValue`) and appends the rule's `dd_action` companions. Text is passed to the executor as **literal** text, never parsed as a JSON cell (a `[1987]` stays the text `[1987]`); dates and locators are passed as JSON and validated by the component's import conform.
6. **Execute.** The identifiers are resolved to records (code lookup), then `importMappedRecords` (the shared executor, `src/core/tools/import_execute.ts`) writes each record in its own transaction, fields in map order — so a component bound by two rules keeps the last non-empty value.
7. Returns `{summary, errors, created, updated, failed}`; on a run that wrote something, the Values form is consumed (cleared).

Only `import_files` is dispatchable; the parser, mapper and executor are plain functions, not separately exposed actions.

### Client

`tools/tool_import_marc21/js/` wires the standard tool lifecycle (`init`/`build`/`edit`/`render` via `tool_common`). `init()` derives `key_dir = caller.tipo + '_' + caller.section_tipo`. `build()` skips the generic ddo_map autoload and instead builds two services: `service_upload` in multi-file mode (`multiple: true` — the file upload drop zone) and `service_tmp_section` (the manual "Values" inputs for ddo_map role `input_component`). `render_tool_import_marc21.js` draws the drop zone, the values block and an **IMPORT** button; clicking it gathers `service_tmp_section.get_components_data()`, builds the request via `create_source(self, 'import_files')` and calls `data_manager.request()` with a long timeout (3600 s, 1 retry). The tool opens as a separate window (`properties.open_as: "window"`). Styling lives in `css/tool_import_marc21.less`.

## Actions & options

`apiActions = { import_files: { permission: 'targets', minLevel: 2, targets: importMarc21Targets, handler: importFiles } }`.

| Action | Permission | Key options it reads |
| --- | --- | --- |
| `import_files` | declarative `permission: 'targets', minLevel: 2` on `(section_tipo, tipo)` + every Values field; each mapped field re-checked per record by the executor | `section_tipo` (target section, **required**), `tipo` (portal/component context), `section_id` (current section), `tool_config` (its `ddo_map` only — the Values form fields), `files_data` (uploaded `.mrc` file objects), `components_temp_data` (manual "Values" inputs), `key_dir` (upload directory id) |

`import_files` is the only remotely callable action. It is `backgroundRunnable` (lane `maintenance`).

The behaviour of the import is driven by the tool **configuration**, not by the request options. **Rule keys** (`src/core/tools/marc21.ts`), applied in this order:

| Key | Meaning |
| --- | --- |
| `tipo` | Target component tipo (**required**) |
| `field` | MARC tag, e.g. `"245"`. Without `field_multiple` only the **first** occurrence of the tag is read |
| `subfield` | Subfield code (`"a"`): the first such subfield of the occurrence; omit to join all subfields |
| `subfield_separator` | Separator when joining all subfields (default a space) |
| `field_multiple` + `row_separator` | `field` may be a list of tags; every occurrence of every listed tag is read, the non-empty ones joined with `row_separator` (default `". "`) — e.g. the 6xx indexation block |
| `marc21_conditional` | `{subfield, value}`: read the first occurrence whose `subfield` equals `value` (e.g. 945 holdings where `$j == 193`); when no occurrence matches, the first occurrence is read. Needs a single-tag `field` and a `subfield` |
| *(always)* | The value is trimmed and trailing spaces, tabs, `,`, `:` and `.` are stripped — except on the `name: "id"` rule, whose value is only trimmed (it is the code a re-import searches for) |
| `partial_left_content` | Positive integer: keep the first run of digits as a number (`"c1987."` → `1987`) |
| `date_format: "year"` | Store the number as a date with that start year. A value with no year above 0 is not written and is listed in `failed` |
| `dd_data_map` | `{code: [data]}`: store the data mapped to the code (e.g. 998 $f language code → a `lg1` locator; `[]` clears). An unmapped code is not written and is listed in `failed`. Cannot combine with `date_format` |
| `dd_action` | `{component tipo: [data]}`: companion values written when the rule produced a value (e.g. the standard-number type when an ISBN is present) |
| `skip_on_empty` | Accepted and inert: an empty value is never written |
| `info`, `name`, `ddo_map` | Documentation; `name: "id"` + `ddo_map` declare the code component the identifier is matched against |

`main` entry `field_to_section_id` — `{field, subfield}` (e.g. 907 $a) — is read the same way (first occurrence, trimmed) and identifies the record to update. `"0"` is a value; only an empty string is empty. Control fields (`001`–`009`) are readable. Any other key refuses the run.

Config anchors beyond `field_to_section_id` (`code`, `section`, `project`, `pdf`, `identifying_image`, `transcription`, `transcription_review`, `field_standard_number`) that would drive companion writes (PDF/image/standard-number handling) have no implementation in `marc21.ts` or the shared import executor — only the plain field→component mapping is applied.

## How it is registered & surfaced

`tools/tool_import_marc21/register.json` is a **column-keyed dump** (`string`/`relation`/`misc`/… keyed by component tipo — a seeded matrix-row snapshot, not a hand-authored file); `importTools()` passes it through as-is (see [register.json reference](../register_json.md)). The essentials it declares:

- `name` (dd1326): `tool_import_marc21`, `version` (dd1327): `2.0.4`, `dedalo_version_min` (dd1328): `6.0.0`, developer (dd1644): "Dédalo team".
- **affected_models** (relation via dd1337 → dd153 section_id 1): `section` — the tool attaches to sections.
- **active** (dd1354 → dd64 section_id 1 = Yes): registered active.
- **show_in_inspector** (dd1331 → dd64 section_id 2 = No): **not** flagged for the inspector panel in this register; the tool is surfaced through the section's tool config / ddo_map rather than an inspector button. `show_in_component` (dd1332) is absent → defaults false.
- `properties` (dd1335): `{ "open_as": "window", "windowFeatures": null }` — opens in its own window.
- `default_config` (dd1633): the MARC reference config, `{main, map, info}` (mirrored in `sample_config.json`), used when the Tools configuration (dd996) does not define a key. Per the comment in the config, do not edit dd1633: copy it into the Tools configuration section (dd996) and edit there — dd996 wins per key, so a dd996 `map` replaces the whole default `map`.
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
        tool_config          : self.tool_config,        // only its ddo_map is read
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

A conditional holdings rule (945 $a from the copy whose $j equals 193) and a year-from-imprint rule (`"c1987."` → a date with start year 1987):

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
- [tool_export](tool_export.md) and [Exporting data](../../../core/exporting_data.md) — the export side
- [Importing data](../../../core/importing_data.md) — the per-component import-data contract
- [Creating new tools](../creating_tools.md), [Server contract](../server_contract.md), [register.json reference](../register_json.md), [Security](../security.md)
- Source: `tools/tool_import_marc21/server/index.ts`; MARC parser + mapper: `src/core/tools/marc21.ts`; shared executor: `src/core/tools/import_execute.ts`.
