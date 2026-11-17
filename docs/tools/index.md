# Tools user guide

> See also: [Importing data](../core/importing_data.md) · [Exporting data](../core/exporting_data.md) · [Developer tool catalog](../development/tools/reference/index.md)

Tools are the buttons that extend Dédalo with focused, task-shaped jobs — import a batch of files,
export a section to a spreadsheet, translate a field, transcribe an interview, revert a mistake.
This section is the **user guide**: what each tool is for, when to reach for it, and how to run it
step by step in the interface. For the internals — the API actions, registration and security
contracts — see the [developer tool catalog](../development/tools/reference/index.md).

## How tools appear

A tool attaches itself to a section, a component or an area without that element having to know about
it. Depending on how it is registered, its button surfaces in one of a few places:

- **On the section toolbar** — section-wide tools (export, print, import, propagate…).
- **In the inspector panel** — tools that act on the selected record or element.
- **Inline on a component** — tools that act on one field (translate, rotate an image, indexation…).
- **In the username menu** — the personal tools (your own account panel).

Some tools open in their own window; some run long jobs in the background and report progress. Each
page below says exactly where its tool shows up and what it needs. Many tools require a permission
level or an administrator/developer role — the page notes when that is the case.

## Import

Bring data into Dédalo from outside files and other installations.

- **[Auction import](using_numisdata_acquisition.md)** — paste a public coin-auction URL (jesusvico.com, biddr.com, aureo.com, numisbids.com, sixbid.com), review every lot found, then import it into a Numismatic Object section.
- **[CSV import](using_import_dedalo_csv.md)** — import a CSV (notably a `tool_export` **Dédalo Raw** export, edited in a spreadsheet) back into a section, cell by cell, with languages preserved.
- **[File import](using_import_files.md)** — ingest a batch of uploaded media files into a media section, reading metadata and matching or creating records.
- **[Journal article import](using_bibliography_acquisition.md)** — paste a journal's OAI-PMH/OJS URL, review every article found, then import it into the Publications section.
- **[MARC21 import](using_import_marc21.md)** — load a `.mrc` bibliographic catalogue and map its fields to components.
- **[RDF import](using_import_rdf.md)** — import an RDF/OWL graph, mapping classes and properties to components.
- **[Zotero import](using_import_zotero.md)** — import a Zotero bibliography export into the Publications section.

## Export and publishing

Get data and media out of Dédalo, and prepare it for print or the public site.

- **[Export](using_export.md)** — turn the current selection of a section into a spreadsheet-style flat table (CSV/XLSX/…), or a raw CSV the CSV import tool loads back (a backup is [the archive door](../core/exporting_data.md#the-archive-door), not an export).
- **[Print](using_print.md)** — design a paginated report layout for a section and print it (or save the layout as a reusable template).
- **[Diffusion](using_diffusion.md)** — inspect how a section is mapped to the public diffusion targets.
- **[PDF extractor](using_pdf_extractor.md)** — pull the text out of PDF files so it can be indexed and searched.

## Media

Work with the image, audio and video files attached to records.

- **[Media versions](using_media_versions.md)** — manage the qualities and versions of a media file: rebuild, delete, rotate, fix headers.
- **[Posterframe](using_posterframe.md)** — capture a thumbnail from an audio/video file at a chosen moment.
- **[Image rotation](using_image_rotation.md)** — rotate and crop an image across all its quality levels.
- **[Upload](using_upload.md)** — the post-upload step that files a freshly uploaded file into storage.
- **[QR](using_qr.md)** — the sample/base tool (developer reference).

## Maps

Work with the map component: geographic data, layers and map exports.

- **[UCA Maps](using_uca_maps.md)** — inspect, style and export map objects, add basemaps and WMS layers, upload shapefiles, GeoJSON, KML and georeferenced images, look up Catastro parcels and administrative units, search modern and ancient places, keep a legend, and download the map as an image.

## Thesaurus and ontology

Organise records into hierarchies and shape the schema.

- **[Hierarchy generator](using_hierarchy.md)** — build a custom ontology or virtual section from existing real sections.
- **[Cataloging](using_cataloging.md)** — drag and drop records from source sections into a target hierarchy.
- **[Ontology](using_ontology.md)** — parse ontology section records into the runtime table *(developer/administrator)*.
- **[Ontology parser](using_ontology_parser.md)** — inspect and rebuild the runtime ontology *(developer/administrator)*.
- **[Label authoring](using_dd_label.md)** — author a tool's multi-language interface labels.

## Transcription and indexation

Turn audio/video and documents into searchable, indexed text.

- **[Transcription](using_transcription.md)** — extract PDF text and automatically transcribe audio, with subtitle output.
- **[Subtitles](using_subtitles.md)** — edit and generate subtitles tied to an audiovisual transcription.
- **[Indexation](using_indexation.md)** — index a component's text against thesaurus terms.
- **[Timecode shift](using_tc.md)** — shift every timecode tag in a transcription by an offset.
- **[Transcript print](using_tr_print.md)** — produce a printable transcript or VTT subtitle file.
- **[Epigraphy transcription](using_numisdata_epigraphy.md)** — transcribe coin legends and epigraphic elements using glyph sets.

## Data operations

Batch edits, history and maintenance across many records at once.

- **[Identify](using_identify.md)** — find the records most likely to be the same type as the one you have open, with the reason for every candidate.
- **[Propagate component data](using_propagate_component_data.md)** — replace, add or delete a component's data across every record that matches a search.
- **[Time machine](using_time_machine.md)** — browse the full change history of a record or component and revert to any past state.
- **[Update cache](using_update_cache.md)** — regenerate or clean component caches in bulk *(administrator)*.
- **[Order coins](using_numisdata_order_coins.md)** — group and sort numismatic objects by weight, diameter and type.

## Language

Translate data between the project's languages.

- **[Translate](using_lang.md)** — automatically translate a component from one language to another.
- **[Translate to many languages](using_lang_multi.md)** — translate a component into several target languages at once.

## Account, AI and system

- **[User panel](using_user_admin.md)** — your personal account panel, from the username menu.
- **[AI assistant](using_assistant.md)** — the in-app chat assistant for search, navigation and confirmed edits.
- **[Site builder](using_sitebuilder.md)** — build a public website over the published data.
- **[Error report](using_error_report.md)** — report and inspect application errors *(administrator/developer)*.
- **[Tool template](using_dev_template.md)** — the scaffold every new tool is copied from *(developer)*.

## Building your own tool

Everything above ships with Dédalo. To build a new one, start from the developer guide:
**[Creating new tools](../development/tools/creating_tools.md)**.
