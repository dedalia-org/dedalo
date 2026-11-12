# MARC21 import (`tool_import_marc21`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_import_marc21.md)

Load a MARC21 binary file (`.mrc`) exported from a library catalogue into a Dédalo section, mapping its fields and subfields to components.

!!! info "This needs an administrator to configure the field map first"
    A cataloguer drops the file and runs the import, but the mapping from MARC fields to Dédalo components lives in the tool's configuration. Setting that map up is an administrator task — see *Before you can use it* below and the [developer reference](../../development/tools/reference/tool_import_marc21.md).

## What it's for

MARC21 is the standard interchange format for library catalogues. If your institution already holds bibliographic records in an ILS (Koha, Sierra, Symphony, Aleph…), you can export them as MARC21 and load them into Dédalo instead of re-keying every record.

Concrete scenario: a museum library has thousands of monograph records in its ILS. It exports them to `catalogo.mrc` and opens the import tool on its Publications section. The tool reads each MARC record, uses a chosen control field (for example **907 $a**) as the stable identifier to decide update-versus-create, then walks the configured field map — title from **245**, ISBN from **020**, imprint from **260/264**, and so on — writing each value into the matching component.

## When to use it

- You have a one-shot or recurring bulk load of bibliographic data already available as MARC21.
- The target section has a MARC field map configured for it.

When NOT to use it:

- To load Dédalo's own `dedalo_raw` exports back, use [CSV import](using_import_dedalo_csv.md).
- For a Zotero bibliography (RDF/XML), use [Zotero import](using_import_zotero.md).
- For an arbitrary RDF/OWL graph, use [RDF import](using_import_rdf.md).

## Before you can use it

The import is driven by a **field map** the tool reads from its configuration, not by anything you set at import time. The map is a flat list of rules — each rule names a MARC field (and optional subfield) and the target component `tipo`. One rule names the field used as the record identifier.

An administrator copies the reference configuration into the Tools configuration section and reshapes it there before the tool can map correctly. Until a valid map exists for the section, the tool parses the file but has nothing to write into. This is a setup step; the [developer reference](../../development/tools/reference/tool_import_marc21.md) documents the exact shape.

## Where to find it

The tool attaches to **sections** and surfaces on Publications-style sections once your profile is authorised for it and the section carries the tool in its configuration. It opens in **its own window**.

## Using it, step by step

1. **Export the MARC21 file** from your ILS as a `.mrc` binary.
2. **Open the tool** on the target section.
3. **Drop or select** the `.mrc` file onto the drop zone.
4. **Fill the Values form** if the configuration renders one — those values are applied alongside the mapped fields.
5. **Click IMPORT.** The tool parses each record, applies the field map, and creates or updates records. Because the run can be long, the request is given an extended timeout — wait for it to finish.
6. **Read the result message**, which reports created, updated and failed counts.

## Tips and gotchas

!!! tip "Choose a stable identifier field"
    The rule that names the identifier field (for example **907 $a**) is what lets a re-import update the same records instead of duplicating them. Point it at a control field your ILS keeps stable across exports.

!!! warning "Some advanced mapping transforms are not applied"
    The engine implements the core rules — field, subfield, subfield joining with a separator, a conditional subfield match, and the identifier field. Several transforms that a reference configuration may list are **not implemented today** and are silently skipped: concatenating a value across several fields, taking the leftmost N characters, parsing a value into a date, mapping a raw code to a locator, setting companion components, and the explicit skip-on-empty flag. A configuration that relies on them stores the raw extracted value untransformed. Confirm with your administrator that your map only uses supported rules — the [developer reference](../../development/tools/reference/tool_import_marc21.md) lists them precisely.

!!! warning "Verify a sample before a large load"
    Run a small file first and inspect the created records. A large ILS export is easier to correct while it is a handful of records than after thousands are written.

## Related

- **[CSV import](using_import_dedalo_csv.md)** — CSV import, including Dédalo's own `dedalo_raw` exports.
- **[Zotero import](using_import_zotero.md)** — Zotero RDF/XML bibliographic import into Publications.
- **[RDF import](using_import_rdf.md)** — RDF/OWL graph import from a linked-data vocabulary.
- **[Media file import](using_import_files.md)** — media ingest (shares the drop-zone pattern).
- **[Importing data](../importing_data.md)** — the per-component import-data contract.
- **[Exporting data](../exporting_data.md)** — the export side.
- **[Developer reference](../../development/tools/reference/tool_import_marc21.md)** — the parser, the field-map keys and their implementation status.
