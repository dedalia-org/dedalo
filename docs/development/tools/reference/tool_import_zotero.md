# tool_import_zotero

Imports a Zotero **CSL JSON** export into a Dédalo Publications section (rsc205): one record per reference, addressed by its call number when it carries one, else matched by its Zotero key; the reference's PDF and its first-page cover attached.

## What it does / why & when to use it

Zotero is one of the most widely used reference managers in academic and heritage research. This tool reads Zotero's CSL JSON export (a JSON array of CSL items), maps every CSL variable the configuration names onto a component of the imported section, and writes the batch through the shared mapped-import executor — the same write path [tool_import_marc21](tool_import_marc21.md) uses. A reference's `archive` PDF, uploaded in the same drop, is ingested into the record's PDF component after the record commits, and the cover the PDF ingest renders goes into the identifying image.

Use it for bulk ingest and re-ingest of references curated in Zotero. For Dédalo's own exports use [tool_import_dedalo_csv](tool_import_dedalo_csv.md); for MARC21 records use [tool_import_marc21](tool_import_marc21.md); for a live RDF graph use [tool_import_rdf](tool_import_rdf.md).

## How it works

### Server

`tools/tool_import_zotero/server/index.ts` — one remotely callable action, `import_files`:

1. **WRITE gate.** `permission: 'targets', minLevel: 2` on the caller pair `(section_tipo, tipo)` and every `input_component` row of the client `tool_config.ddo_map` (the Values form). The map's components are not pre-gated (the map is server config, read at run time): the executor asks the write door for every field of every record, a Series create asks it for the Series section and its name component, and an attachment asks it for the media component of its committed record.
2. **Config.** `getToolConfig('tool_import_zotero')` — the Tools configuration (dd996) per key over the register default (dd1633). `readZoteroConfig` (`src/core/tools/zotero_map.ts`) validates it and refuses, by name, a missing `map`, a malformed entry, and a map without an `id` entry. A client-posted map is ignored. `assertConfigSection` refuses the run before any read when a map entry or `main.section` names another section than the imported one.
3. **Read.** The batch's `.json` entries, re-confined under the user's staging dir, read through `readIngestTextFile` (UTF-8 law, BOM stripped, a legacy encoding converted with a notice) and `parseCslJson` (`src/core/tools/csl_json.ts`): the top level must be an array of item objects, else the file is one error line.
4. **Map.** `mapCslItem` per item, variables in item order, every value in the target component's stored JSON shape:
    - `id` → the Zotero key (last URI segment) into the code component; the full URI is kept as the key's other spelling for the match.
    - `type` → the `typology` entry's locators; an unknown type is a refused field.
    - `ISBN` / `ISSN` → the number, plus the `standard_type` locators into `main.field_standard_number`; both present → both kept.
    - a **link** entry (its second ddo is a child of the first: `container-title` → Series) → a link the executor resolves.
    - CSL **name** variables (author, editor, translator, container-author…) → one item per name (`literal`, else "given family").
    - CSL **date** variables (issued, accessed, original-date…) → `{start, end?}`: the end kept only for a `date_mode: range` component, a clock-time `season` as the time; a text date (`raw`/`literal`, no `date-parts`) is refused, never stored empty.
    - `DOI` → `https://www.doi.org/<doi>` unless already a URL; any other variable → its text in the component's shape (an IRI component gets `{iri}`, an HTML one a paragraph).
    - `archive` → the attachment request (never a field).
    - the `main.field_to_section_id` variable (default `call-number`) → the record's **address** (below), carried as the text the file holds (`ZoteroMappedRecord.address`). It names a Zotero field: no component is bound to it and nothing is written for it (a map entry of the same name, if an install adds one, is written by its ordinary handler); it is never listed as unmapped.
5. **Identity.** Decided once, before any write (`resolveItems`), in three steps:
    1. **The call number, per item** (`screenAddresses`, `tools/tool_import_zotero/server/call_number_address.ts`). `recordNumberOf` reads it: only a canonical positive int4 — digits, no sign, no leading zero, no fraction, at most 2147483647 — is a record number. Anything else, or a number an earlier item of the run carries, refuses **that item** (`request.invalid_data`). 2147483647 is the import's only limit — an address is taken as written up to it — and a whole number above it (`recordNumberAboveLimit`) refuses the item under its own code, `tool.zotero_call_number_above_limit`, which is also the run's warning (below).
    2. **The Zotero key, for the whole batch** (`resolveMappedCodesInWholeSection`, the batch law MARC21's `resolveMappedCodes` shares): the key — or the full URI — matched EXACTLY in the code component, in the **whole section**; none → create. A key twice in one batch, or held by two records, refuses the run. The search runs with no principal — no projects filter, no per-user record list — because a key identifies one record of the section: a holder the importer cannot see would otherwise get a twin. It answers a `section_id` and nothing the record holds, and marks the match `MappedRecord.unscopedMatch`. This is a named exemption: its callers are allow-listed, each with its reason, by `test/unit/iri_label_unscoped_lookup_tripwire.test.ts`.
    3. **The call number over the key** (`addressRecords`). No call number → the key's answer stands. A call number while the key is held by another record — in the importer's scope or not — → the item is refused (`resource.conflict`), naming both records by `section_id`. Otherwise the record is handed to the executor with `MappedRecord.address`.

    The read itself is bounded: an export over 64 MB (the CSV ceiling) is refused by its size on disk, listed in `errors`, and never opened.

    !!! note "The call number is the one address an import may choose"
        Every other imported identifier — the Zotero key, a MARC21 control number — is a code looked up in a component (`src/core/tools/import_code_lookup.ts`): an external string never chooses a `section_id`. The call number is the named exception, because the operator writes it for that purpose. The executor accepts `MappedRecord.address` only from an action its tool declares in `operatorAddressActions` (see [Server contract](../server_contract.md#the-module)) — this tool's `import_files`, and no other — and refuses the run otherwise. Gates: `test/unit/tool_import_zotero_native.test.ts`, `test/unit/marc_identity_native.test.ts`.
6. **Execute.** `importMappedRecords` (`src/core/tools/import_execute.ts`): one dd800 run, one transaction per record, the write door per field, the Values form appended to every record. An addressed record is settled inside its transaction (`addressedTarget`), on what is true when it is written: no record at the id — never one, or deleted — → the create door, then the explicit-id insert (the counter rises to the id; an id that carries a deleted record's history opens a new generation); a record there → it is first asked of the record door as a whole (`livingRecordRefusal`: section floor and write scope — a record the importer may not write refuses the item with the door's `perm.*` code, and its key is never read), then its stored key is read under the row lock (`readStoredCodesForUpdate`): none is adopted, the item's own is the same reference, any other refuses the item (`resource.conflict`, the record rolled back), and every field is asked of the record door as for a matched record. A record matched by its key past the importer's scope (`unscopedMatch`) is asked of the same record door as a whole (`matchedTarget`, door `import_execute.match`) before any field: refused, the item is refused with the door's `perm.*` code — never reported updated with every field ignored. Addressed records are written before the others, highest id first (`writeOrder`), so the counter id an unaddressed record or a linked record takes is never one the same export names; the report stays in input order. A link (`MappedRecord.links`, `src/core/tools/import_link.ts`) is resolved inside the record's transaction: its name advisory-locked before the record's first write, found by exact name, else created with the run's birth marker and named; a name held by two records refuses the link only.
7. **Attachments.** For each committed record with an `archive`: the file must be an entry of the same upload, staged and confined; `processUploadedFile` + `persistUploadedMedia` into `main.pdf`, then the PDF ingest's rendered cover into `main.identifying_image`. A failure is a report line; the record stays.
8. The consumed `.json` files are deleted; the staging form is cleared when the run wrote something.

`import_files` is `backgroundRunnable` (lane `maintenance`).

### Client

`tools/tool_import_zotero/js/` — `service_upload` (multi-file drop zone: the export and its PDFs) and `service_tmp_section` (the Values form, ddo_map role `input_component`). The IMPORT button posts the request below; `render_import_warnings` renders the run's warnings (the envelope's `notices`, each as its label in the user's language) and `render_import_report` the report — summary, the records created and updated at their call-number id, refused references, refused fields, file errors, attachments, notices — as text under the outcome label.

## Actions & options

| Action | Permission | Key options |
| --- | --- | --- |
| `import_files` | `targets`, level 2: caller pair + Values form fields | `section_tipo` (required), `tipo`, `section_id`, `tool_config` (its `ddo_map` only), `files_data` (`{name, tmp_name}` per staged file), `components_temp_data` (the Values form), `key_dir` |

The response `data`: `summary`, `created`, `updated`, `created_at_id` and `updated_at_id` (the `section_id`s created / updated at their call number), `refused` (`{item, code, message}` per reference the identity rules refused — `code` is `request.invalid_data`, `tool.zotero_call_number_above_limit`, `resource.conflict`, or the record door's `perm.*` code for a record the importer may not change), `failed` (`{section_id, component_tipo, data, msg}` per refused field or rolled-back record), `errors` (per file), `notices`, `attachments`, `bulk_process_id`.

The success envelope's own `notices` (beside `data`, [error system](../../../core/system/errors.md)) carry the run's **warnings** — coded, with a label in the user's language, at most one of each per run:

| Code | When | `details` |
|---|---|---|
| `tool.zotero_call_number_above_limit` | references whose call number is a whole number above 2147483647 | `count`, `limit`, `values` (the first twenty, comma-separated, each cut at 80 characters), `variable` (the configured field) |
| `tool.zotero_record_not_writable` | references that name — by call number or by Zotero key — a record the importer may not change | `count`, `section_ids` (distinct, ascending, the first twenty) |

The client asks for them itself (`notices: 'caller'`) and renders them above the report (`render_import_warnings`).

## Configuration

The shipped default (register dd1633, mirrored in `sample_config.json`) maps CSL variables onto Publications. Excerpt:

``` json
{
  "map": [
    { "name": "id", "ddo_map": [{ "tipo": "rsc137", "section_tipo": "rsc205" }] },
    { "name": "title", "ddo_map": [{ "tipo": "rsc140", "section_tipo": "rsc205" }] },
    { "name": "container-title", "ddo_map": [
        { "tipo": "rsc211", "section_tipo": "rsc205" },
        { "tipo": "rsc214", "parent": "rsc211", "section_tipo": "rsc212" } ] }
  ],
  "main": [
    { "name": "section", "tipo": "rsc205" },
    { "name": "pdf", "tipo": "rsc209" },
    { "name": "identifying_image", "tipo": "rsc228" },
    { "name": "field_standard_number", "tipo": "rsc249" },
    { "name": "field_to_section_id", "value": "call-number" }
  ],
  "typology": [{ "name": "book", "value": [{ "section_id": 1, "section_tipo": "dd810" }] }],
  "standard_type": [{ "name": "ISBN", "value": [{ "section_id": 1, "section_tipo": "dd292" }] }]
}
```

| Key | Purpose |
| --- | --- |
| `map[].name` | The CSL variable. `id` is required: it names the code component a re-import matches on. |
| `map[].ddo_map` | `[0]` the component written (must be in the imported section). A `[1]` whose `parent` is `[0].tipo` makes a link: the text names a record of `[1].section_tipo` by its `[1].tipo` component. |
| `main` | `section`, `pdf`, `identifying_image`, `field_standard_number`, `field_to_section_id` — the CSL variable whose value is the record's `section_id` (shipped: `call-number`). It names a Zotero field, so it needs no `map` entry. `id` is refused there (the key is looked up, never a record number); leaving the setting out makes the Zotero key the only identity. Gate: `tool_import_zotero_native` "the SHIPPED default". |
| `typology` / `standard_type` | CSL type / number kind → the list locators stored. |

Do not edit dd1633: copy the full configuration into the Tools configuration (dd996) and edit it there — every key you set there replaces the register's key of the same name.

## Related

- [tool_import_marc21](tool_import_marc21.md) — the same executor and code resolution.
- [tool_import_files](tool_import_files.md) — media ingest without bibliographic data.
- [tool_import_dedalo_csv](tool_import_dedalo_csv.md) · [tool_import_rdf](tool_import_rdf.md) — the other importers.
- [Importing data](../../../using/importing_data.md) — the per-component import-data contract.
- Source: `tools/tool_import_zotero/server/index.ts`; the call-number rules `tools/tool_import_zotero/server/call_number_address.ts`; reader `src/core/tools/csl_json.ts`; mapper `src/core/tools/zotero_map.ts`; links `src/core/tools/import_link.ts`; executor `src/core/tools/import_execute.ts`.
- [Creating new tools](../creating_tools.md), [Server contract](../server_contract.md), [register.json reference](../register_json.md), [Security](../security.md)
