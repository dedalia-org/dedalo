# Zotero import (`tool_import_zotero`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_import_zotero.md)

Import a Zotero library exported as **CSL JSON** into a Dédalo Publications section (`rsc205`): each reference becomes a record, its PDF (when you upload it with the export) lands in the record's PDF field, and the PDF's first page becomes the record's identifying image.

!!! info "The field map is the tool's configuration"
    A researcher exports from Zotero and runs the import. Which Zotero field lands in which Dédalo field is set in the tool's configuration — the shipped default maps the Publications section, and an administrator adapts it in the Tools configuration.

## What it's for

Zotero is one of the most widely used reference managers in academic and heritage research. This tool reads a Zotero CSL JSON export and writes each reference into a section — typically Publications — so a curated bibliography does not have to be re-keyed by hand.

Concrete scenario: a museum's research department keeps the bibliography of an exhibition catalogue in Zotero. They export the collection as CSL JSON with its PDFs, open the import tool on the Publications section, drop the `.json` file and the PDFs, and import. Each reference's title, authors, dates, type, journal or series, ISBN/ISSN and DOI are written; the journal or series is linked to its record in the Series list (created the first time it appears); the PDF and its cover are attached.

## When to use it

- You have references curated in Zotero and want them in a Dédalo Publications section.
- You want to re-import later: a second import of the same references **updates** the records the first one created, instead of duplicating them.
- You want to decide which record number a reference gets: write it in Zotero's **Call Number** field (see [Choosing the record number](#choosing-the-record-number-the-call-number)).

When NOT to use it:

- To load Dédalo's own `dedalo_raw` exports back, use [CSV import](using_import_dedalo_csv.md).
- For a library MARC21 catalogue, use [MARC21 import](using_import_marc21.md).
- To fetch a single external resource's graph by IRI, use [RDF import](using_import_rdf.md).

## How to export from Zotero

In Zotero, select the collection or items, choose *Export…*, and pick the **CSL JSON** format. To bring the PDFs, keep them next to the export and upload them in the same drop as the `.json` file: a reference's PDF is the file its `archive` field names. Any other export format (Zotero RDF, BibTeX, RIS) is refused per file with a message — export again as CSL JSON.

## Where to find it

The tool attaches to **sections** and surfaces on Publications-style sections once your profile is authorised for it and the section carries the tool in its configuration. It opens in **its own window**.

## Using it, step by step

1. **Export your Zotero collection** as CSL JSON.
2. **Open the tool** on the Publications section.
3. **Drop or select** the `.json` export and, if you have them, the PDFs.
4. **Fill the Values form** if the configuration shows one — those values are written into every imported record.
5. **Click IMPORT.** When the run ends, the tool shows its report: how many records were created and updated, and every line it has to tell you about (see below). Click the panel to reload.

## Reading the report

The import never stops at the first problem: a reference it can read is written, and everything it could not do is listed.

- **Refused fields** — a value the record could not take, named with the record and field. The record keeps its stored value for that field. Examples: a date written as text ("circa 1900"), a Zotero item type the configuration's typology list does not know, a journal name held by two Series records.
- **Created at / updated at their call-number id** — the record numbers of the references whose call number chose their record: the ones created at that number, and the ones that updated the record already there.
- **Warnings** — shown first, in your language, when you have to act: a call number above the highest record number there is, or a reference that names a record you may not change (see [Choosing the record number](#choosing-the-record-number-the-call-number)). Each one says how many references it concerns and which values or record numbers.
- **Refused references** — a reference that was not imported because of its call number or of the record it names, listed by its Zotero key with the reason. The rest of the export is imported.
- **File errors** — an export that is not CSL JSON, or not valid JSON, or larger than 64 MB (split the library and import the parts).
- **Attachments** — a PDF that was not uploaded with the export, or whose cover could not be rendered.
- **Notices** — what was not imported and why: Zotero fields the map does not name (listed once), the end of a date range when the target date is not a range, a Zotero "season" that is not a time of day.

## How a reference finds its record

A reference is matched by its **Zotero key** (the last part of its Zotero URI, stored in the code field): found → that record is updated; not found → a new record is created. If two references of one import carry the same key, or two records already hold it, nothing is imported and the report says so — fix the file or the duplicate codes first.

The key is looked for in the **whole section**, not only among the records of your projects: a Zotero key belongs to one record, whoever may edit it. If the record that holds a reference's key is one you may not change, the reference is refused — no second record is created with the same key — and a warning names that record by its number. Ask whoever manages the record for access, or ask them to import the reference. An administrator, who may change every record, is not affected.

## Choosing the record number: the call number

Zotero has no field for an identifier you can edit, so Dédalo reads the record number from Zotero's **Call Number** field (`call-number` in the export). Write there the number of the Dédalo record the reference belongs to:

- **A record with that number exists** → it is updated, and from then on it holds the reference's Zotero key.
- **No record has that number** → a record is created with exactly that number. This is also what happens when the record was deleted: import the reference again and it comes back at the same number.
- **No call number** → the Zotero key decides, as described above.

The call number must be a whole number written with digits only, from 1 to 2147483647 — `42`, not `042`, `42a`, `4.2` or `B-42`. A reference whose call number is anything else is **not imported** and is listed under refused references with the value it carried; correct it in Zotero, or clear it to let the Zotero key decide.

2147483647 is the highest number a record can have, and it is the only limit: any call number up to it is taken as written. A whole number **above** it is refused too, and the import warns you, naming each such value and the limit.

A reference is also refused, and the record left untouched, when:

- the record with that number already holds **another** Zotero key — an import never turns one reference's record into another's;
- the reference's Zotero key is already held by a **different** record than the one its call number names — the import cannot tell which one you mean. This holds for any record of the section, including one outside your projects: the report names it by its number;
- an earlier reference of the same import carries the same call number;
- the record with that number exists and you may not change it — the reference is listed as refused, never as updated, and a warning names the record.

!!! warning "A call number is a record number: check it before importing"
    The number you write is the record that is written. The import refuses to overwrite a record that belongs to another Zotero reference, but a record that holds no Zotero key yet — one created by hand — is updated with the reference's values. The usual permissions apply: a reference whose record you may not change is refused, and creating a record needs the permission to create in the section.

A record created at a number above the section's last one moves the section's counter up to it: the next record created by hand continues from there. Within one import the references that carry a call number are written first, so a reference without one never takes a number another reference of the same export names — whatever their order in the file. The report keeps the file's order.

To read the record number from another Zotero field, an administrator changes `field_to_section_id` in the tool's configuration to that field's name; removing the setting leaves the Zotero key as the only identity.

## Undoing an import

Every import is one entry in **Processes**. Reverting it undoes the values it wrote and removes the records it created — including the Series records it created for new journal names. PDFs and cover images are files, not values: remove them from the record if needed.

## Tips and gotchas

!!! tip "Check a small export first"
    Import a handful of references, confirm the fields land where you expect, then run the full collection.

!!! warning "The export file is consumed"
    After a run, the `.json` export is removed from your upload area. Upload it again to re-run.

## Related

- **[MARC21 import](using_import_marc21.md)** — MARC21 library-catalogue import (same write path).
- **[CSV import](using_import_dedalo_csv.md)** — CSV import, including Dédalo's own `dedalo_raw` exports.
- **[Media file import](using_import_files.md)** — media ingest without bibliographic data.
- **[Importing data](../importing_data.md)** — the per-component import-data contract.
- **[Developer reference](../../development/tools/reference/tool_import_zotero.md)** — the `import_files` action, the configuration shape and the doors it asks.
