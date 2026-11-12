# Zotero import (`tool_import_zotero`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_import_zotero.md)

Import a Zotero bibliography exported as RDF/XML into a Dédalo Publications section (`rsc205`), mapping each reference's fields to components.

!!! info "An administrator configures the field map first"
    A researcher exports from Zotero and runs the import, but the mapping from Zotero fields to Dédalo components lives in the tool's configuration. Setting it up is an administrator task.

## What it's for

Zotero is one of the most widely used reference managers in academic and heritage research. This tool parses a Zotero RDF/XML export and ingests the matched fields into a section — typically Publications — so a curated bibliography does not have to be re-keyed by hand.

Concrete scenario: a museum's research department keeps the bibliography of an exhibition catalogue in Zotero. They export the collection as RDF/XML, open the import tool on the Publications section, and — with a field map configured (for example `dc:title` to the title component) — import. For each Zotero item, every predicate that has a matching map entry writes its value into the paired component on a new (or already-targeted) record, through the same write path the CSV and MARC21 imports use.

## When to use it

- You have references curated in Zotero and want them in a Dédalo Publications section.
- A predicate-to-component map has been configured for the target section.

When NOT to use it:

- To load Dédalo's own `dedalo_raw` exports back, use [CSV import](using_import_dedalo_csv.md).
- For a library MARC21 catalogue, use [MARC21 import](using_import_marc21.md).
- To fetch a single external resource's graph by IRI, use [RDF import](using_import_rdf.md) — it shares this tool's parser but resolves one live IRI rather than importing a file.

## Before you can use it

The import reads a **field map** from the tool's configuration — a flat list of entries, each pairing an RDF predicate (such as `dc:title`) with the target component `tipo`. If the map is missing or empty, the import is refused. An administrator copies a full configuration into the Tools configuration section and edits it there before the tool can write.

## How to export from Zotero

In Zotero, select the collection or items, choose *Export…*, and pick a **RDF** format (the export is RDF/XML). Save the file; that is what you drop into the tool. A plain Zotero JSON or a bibliography in another citation style is not the RDF/XML this tool parses.

## Where to find it

The tool attaches to **sections** and surfaces on Publications-style sections once your profile is authorised for it and the section carries the tool in its configuration. It opens in **its own window**.

## Using it, step by step

1. **Export your Zotero collection** as RDF/XML.
2. **Open the tool** on the Publications section.
3. **Drop or select** the RDF/XML export onto the drop zone.
4. **Fill the Values form** if the configuration renders one — those values apply alongside the mapped fields.
5. **Click IMPORT.** The tool parses each item, applies the field map, and creates or updates records. The run is given a long timeout — wait for the success or error message, after which the view reloads.

## Tips and gotchas

!!! warning "The mapping is flat — no bibliographic post-processing"
    Each predicate maps straight to a component value. There is **no** dedicated author-name flattening, issued/accessed date parsing, container-title resolve-or-create, item-type-to-typology lookup, or ISBN/ISSN-to-standard-number handling. If you need those, prepare the data accordingly or fix it after import.

!!! warning "Attached PDFs are not imported"
    Importing a PDF named by a Zotero attachment field, and extracting a first-page identifying image from it, is **not implemented**. The field map only maps a predicate to a component value. To attach PDFs to records, use [Media file import](using_import_files.md) after the bibliographic import.

!!! tip "Check a small export first"
    Import a handful of references, confirm the map lands the fields where you expect, then run the full collection.

## Related

- **[MARC21 import](using_import_marc21.md)** — MARC21 library-catalogue import (shares the same write path).
- **[CSV import](using_import_dedalo_csv.md)** — CSV import, including Dédalo's own `dedalo_raw` exports.
- **[RDF import](using_import_rdf.md)** — the sibling RDF/XML tool whose parser this one reuses; that one fetches a live IRI, this one imports a file and writes records.
- **[Media file import](using_import_files.md)** — media ingest, including PDFs, after the references are in.
- **[Importing data](../importing_data.md)** — the per-component import-data contract.
- **[Exporting data](../exporting_data.md)** — the export side.
- **[Developer reference](../../development/tools/reference/tool_import_zotero.md)** — the `import_files` action, the field-map shape and the shared executor.
