# CSV import (`tool_import_dedalo_csv`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_import_dedalo_csv.md)

Import a CSV file into a section, creating or updating one record per row and conforming each cell to the target component. This is the tool that loads a `dedalo_raw` export back into Dédalo — as typed input, conformed cell by cell; it is not a restore (see [The archive door](../exporting_data.md#the-archive-door) for that).

## What it's for

Most cataloguing corrections are faster in a spreadsheet than one record at a time. You export a section, fix the transcriptions, dates or codes in bulk, and bring the file back in. Because every row carries its own `section_id`, the records you edited are updated in place — nothing is duplicated.

Concrete scenario: a numismatics team exports the *Types* section (`numisdata3`) with the export tool in the `dedalo_raw` format, cleans up the legend transcriptions and date ranges in a spreadsheet, and re-imports the file here. Each Type record is matched by its `section_id` and updated; empty cells clear the component they sit under (in the default *Replace* mode); and the whole batch stays reversible from its bulk-process record (every import records its undo log; there is no option to turn it off).

The same tool also accepts hand-authored CSVs — a plain number, a date like `2023/10/26`, or a comma-separated list of related ids — so you can prepare data outside Dédalo without learning the internal JSON shapes. The full per-component format catalogue lives in [Importing data](../importing_data.md).

## When to use it

- You exported a section, edited it in a spreadsheet, and want the changes back in Dédalo.
- You are seeding a section with data prepared outside Dédalo, keyed by `section_id`.
- You need to clear the same component across many records (leave its column empty, in *Replace* mode).
- You want to **add** values to what records already hold — more related records, one more map point, a further paragraph — without touching what is stored (*Append* mode, see [Adding instead of replacing](#adding-instead-of-replacing)).

When NOT to use it:

- To ingest media files (images, audio, video, PDFs), use [Media file import](using_import_files.md) instead.
- To import a library MARC21 catalogue, a Zotero bibliography, or an RDF graph, use the format-specific importers: [MARC21 import](using_import_marc21.md), [Zotero import](using_import_zotero.md), [RDF import](using_import_rdf.md).

## Where to find it

The tool surfaces on **sections** — its target is always a whole section, because it writes records keyed by `section_id`. Open it from the section's tools, and it opens in **its own window**.

The filename can name the target section: a file called `types_clean-numisdata3.csv` is auto-detected as targeting `numisdata3`. If the name does not carry a section tipo, the tool falls back to the section you opened it from, and you can override the target by hand in the file card.

## Using it, step by step

1. **Prepare the CSV.** The first row is a header of component `tipo`s, and one column must be `section_id` (by convention the first). Every following row is a record. Save the file as UTF-8 without a BOM. See [Importing data](../importing_data.md) for the exact cell formats.
2. **Open the tool** on the target section and **drop or select** the CSV file. Dédalo stages it and shows a file card.
3. **Confirm the target section.** The card shows the auto-detected `section tipo` and the resolved section name. Correct it if the detection is wrong.
4. **Check the column mapping.** The columns mapper lists every CSV column with its detected model and label, a *Selected* checkbox, a *Mapped to* component selector, and a sample value. A column whose header matches a component `tipo` is ticked and mapped automatically; adjust any that did not match.
5. **Set number decimals if needed.** When a column maps to a `component_number`, a decimal selector appears — choose `.` or `,` to match your spreadsheet.
6. **Choose each column's mode.** *Replace* (the default) overwrites the component with the cell; *Append* adds the cell's values to the stored ones. The selector only appears on columns whose component can take an addition — see [Adding instead of replacing](#adding-instead-of-replacing).
7. **Preview.** Use the preview toggle on each card to see sample rows, or the parse errors if the file has malformed JSON cells.
8. **Edit the process title** if you want the bulk-process record to carry a recognisable name.
9. **Tick the file's checkbox** to select it for import and click **Import**. Every import can be reverted afterwards as one run — there is no switch to turn that off.
10. **Watch progress.** A live progress bar shows the current file, row and component, with running created / updated / failed / warning counts. When it finishes, each file shows its report.

## Options

| Option | What it does |
| --- | --- |
| Section tipo | The target section for the file. Auto-detected from the filename, overridable per file. |
| Selected (per column) | Whether that column is imported. Unmapped columns and the `section_id` column are skipped. |
| Mapped to (per column) | The target component the column writes into. Re-resolved from the ontology on the server. |
| Decimal (number columns) | The decimal separator (`.` or `,`) used to parse a `component_number` column. |
| Mode (per column) | *Replace* (default): the cell replaces the component's data. *Append*: the cell's values are added to the stored ones (*Add as new layer* on a geolocation column). Hidden on columns that cannot append. |
| Process title | The label of the bulk-process record that tracks (and reverts) the run. |

## Adding instead of replacing

By default a column **replaces** what the component holds. Set a column's *Mode* to **Append** and its values are **added** after the stored ones instead; nothing already stored is changed, reordered or rewritten. Use it to enrich records from a spreadsheet that knows nothing of what is already in Dédalo — a second list of related people, one more find-spot, a further transcription paragraph.

What an append does depends on the component:

| Component | What *Append* does |
| --- | --- |
| Text, email, number, date, URI (`component_input_text`, `component_email`, `component_number`, `component_date`, `component_iri`) | Adds each value as a new item, in the language of the cell. Other languages are untouched. |
| Related records (`component_portal`, `component_check_box`, `component_filter`, `component_filter_master`, `component_relation_related`, `component_relation_parent`, `component_dataframe`) | Adds each link after the existing ones. The limit on how many links the component takes (its `data_limit` property) still applies: going over it fails the whole row. |
| Geolocation (`component_geolocation`) | **Add as new layer**: each drawn layer, or a flat `lat, lon` point, becomes a new layer with the next free layer number. The stored layers and the map centre stay exactly as they were. A point or layer already stored — including a point equal to the stored map centre — is skipped. On a record with no geolocation yet, the cell's first point or map is stored as is and the rest of the cell is added to it as layers. |
| Formatted text (`component_text_area`, and the legacy `component_input_text_large`, `component_html_text`) | Adds the cell as a new paragraph at the end of the text, in the cell's language. A cell that carries tags (`[index-…]`, `[tc-…]`, `[geo-…]`…) **fails the whole row** — nothing of that row is written, its other columns included: tags are tied to the index and the positions they mark, which an addition cannot keep. |

**Where append is not offered.** The *Mode* selector is hidden — and the server refuses an append sent anyway, **before anything is written** — on:

- media components (image, audio/video, PDF, 3D, SVG) — the file is the value; use [Media file import](using_import_files.md);
- single-choice components (`component_select`, `component_radio_button`, `component_select_lang`, `component_publication`, `component_relation_model`) — only one value is ever read, so a second cannot be added;
- components whose value is one document rather than a list (`component_json`, `component_password`, `component_security_access`, `component_filter_records`);
- computed components, whose value is not stored on the record: `component_info`, `component_state`, `component_calculation`, `component_inverse`, `component_external`, `component_relation_children` (children are computed from each child's *parent* link — import the parent on the child records instead) and `component_relation_index` (computed from the records that point here);
- the `section_id` column, and the record's creation and modification stamps (`dd199`, `dd200`, `dd201`, `dd197`).

**Duplicates are skipped, and reported.** A value the component already holds is not added again: a link to the same record, the same text in the same language, the same date, the same layer shape. Each column reports a warning such as *3 already present, not added*. Importing the same file twice therefore changes nothing the second time.

**Multi-language cells keep each item's translations together.** A cell that carries several languages at once (`{"lg-spa":["Denario"],"lg-eng":["Denarius"]}`) adds each language's value as a translation of **one** item, sharing one item id. When one language's value is already stored, it is skipped and the other languages' values are added as the missing translations of that same stored item. When the languages **disagree** — one language's value matches a stored item, but another language of that item already holds a different value — the **whole row fails** with nothing written: adding the new value would split one item across two ids. Correct the cell, or import the languages that differ in *Replace* mode. Formatted text never fails this way: each language's paragraph is added to that language's own text, and a language with no text yet starts one.

**An empty cell changes nothing.** In append mode an empty cell — or an empty language group such as `{"lg-spa":[]}` — is skipped; it never clears data, unlike *Replace*. An empty value inside a cell (the `""` of `{"lg-spa":"","lg-eng":"x"}`) is skipped too: append never adds a blank entry.

**Dataframe columns follow their main column.** When a [dataframe](../../core/components/component_dataframe.md) column is imported next to an appended main column, each frame is paired with the item it belongs to after the append — with the existing item when that value was skipped as a duplicate. Frames already present are skipped, and a frame that would exceed the dataframe's limit fails the row. Put the dataframe column in *Append* mode too: a *Replace* dataframe column fails the row when its frames belong to an *Append* main column of the same row, or when the record already stores frames of that main column (a *Replace* column rewrites the whole dataframe; left empty, it clears it). The same goes for a *Replace* column whose embedded frames belong to an *Append* column. A *Replace* dataframe column next to an *Append* column it holds no frames of imports as usual.

**Repeated rows accumulate.** Two rows with the same `section_id` both append, in file order.

Example, on the `test` section `test3` — the developers' playground, present in the test suite's database (`bun run test:client:server` serves it), not in an installation — (`test80` is its `component_portal` to `test3` records, `test100` its `component_geolocation`, `test17` its `component_text_area`), all three columns in *Append* mode:

```text
section_id;test80;test100;test17
1;4,6;39.4625, -0.3762;Second campaign, 2025.
```

Record 1 gains links to records 4 and 6 (unless it already had them), a new Point layer, and a paragraph `<p>Second campaign, 2025.</p>` at the end of its text in the current data language.

!!! info "An append can be reverted exactly"
    An append only adds, but it is still a write, and it is recorded like any other: each change stores the value it replaced (hidden from the history list) next to the usual time-machine entry holding the value after it. Reverting the run from its bulk-process record puts back exactly what each component held before, the values the append kept included — also where the time machine had no earlier entry for that component. The record's *Modified by* and *Modified date* are the exception: they show the revert as the latest change (unless your file wrote them as columns, in which case they come back too). An append that adds nothing records nothing. See [Reverting a batch run](using_time_machine.md#reverting-a-batch-run).

## Tips and gotchas

!!! tip "Start from a raw export"
    Exporting a section in `dedalo_raw` format keeps each cell's structure through a spreadsheet edit: start from a raw export, edit only the cells you mean to change, and a value is far harder to reshape by accident. It is still an import, not a restore — every cell is re-conformed as typed input (`component_text_area` markup is rewritten, `component_geolocation` item ids are dropped, empty cells clear values, relation `section_id`s are checked for shape only). A lossless copy of a section is the [archive door](../exporting_data.md#the-archive-door).

!!! warning "An empty cell clears data (Replace mode)"
    In *Replace* mode an empty cell is imported as `null` and **clears** the existing value of that component for the record (and for the current data language, when the component is translatable). To leave a component untouched, omit its column entirely, or set the column to *Append* — in append mode an empty cell changes nothing.

!!! warning "Headers must match exactly"
    Each CSV header must match its mapped column name exactly, including suffixes like `tch56_dmy` (date format) or `tch191_rsc723` (relation target). A column whose header does not match is **silently skipped** — no data is imported and no error is raised. Review the mapping before launching.

!!! tip "Read the report before moving on"
    The report separates **failed** cells (rejected, the record kept its previous value) from **warnings** (written, but worth a look — for example a language code that is valid but not in the project's configured languages). The *created* and *updated* lists are the actual `section_id`s, and you can copy them straight into a search to inspect what changed.

!!! tip "Time machine is your undo"
    Every import is recorded under its bulk-process record: each change keeps the value it replaced, so the whole run can be reverted exactly in one action. A value someone edited after the import is left alone by the revert and reported, never overwritten — see [Reverting a batch run](using_time_machine.md#reverting-a-batch-run).

## Related

- **[Data export](using_export.md)** — the export counterpart; its `dedalo_raw` format produces the CSV this tool loads back.
- **[Media file import](using_import_files.md)** — ingest media files and their records, not CSV record data.
- **[MARC21 import](using_import_marc21.md)**, **[RDF import](using_import_rdf.md)**, **[Zotero import](using_import_zotero.md)** — format-specific importers.
- **[Bulk component edit](using_propagate_component_data.md)** — search-driven bulk edits with the same bulk-process and time-machine reversion model.
- **[Time machine](using_time_machine.md)** — how the reversible snapshots this tool writes are reviewed and rolled back.
- **[Importing data](../importing_data.md)** — the per-component CSV format catalogue, the `dedalo_data` wrapper, and empty-cell semantics.
- **[Exporting data](../exporting_data.md)** — the export side, and the archive door for a lossless copy.
- **[Developer reference](../../development/tools/reference/tool_import_dedalo_csv.md)** — actions, options and the import engine.
