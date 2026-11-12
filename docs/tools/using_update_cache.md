# Update cache (`tool_update_cache`)

> See also: [Tools user guide](index.md) · [Developer reference](../development/tools/reference/tool_update_cache.md)

Regenerate the stored, derived data of a section's components across many records at once — a maintenance pass that re-saves each record so its derived data is rebuilt.

!!! note "This is an administrator tool"
    Update cache re-saves records in bulk to repair derived data. It is a maintenance operation for administrators, not part of everyday cataloguing. If you only want to *change* a value across records, use [Propagate component data](using_propagate_component_data.md) instead.

## What it's for

Some of what a component stores is **derived** when the record is saved — for example the ancestor index an autocomplete component keeps so lookups stay fast, or counter values kept in step. When that derivation logic changes, or records were written by a path that skipped it, the stored data drifts from what a fresh save would produce. Update cache fixes the drift in bulk: it walks every record a filter matches and **re-saves** the components you select, so the normal save path re-runs its derivation for each one. The value the user sees does not change — only its stored/derived form is refreshed.

**External portals are recomputed, not re-saved.** A portal or autocomplete whose list is computed from other records (an *external* portal — for example the coins that point at a type) is rebuilt from the records it mirrors, as its **update** button does, instead of being saved back as it stands. A record whose section does not declare the portal, or a portal whose definition cannot be computed, is listed in the run's errors and counted as *not refreshed*; nothing is written to it.

Concrete heritage scenario: a numismatics collection reworks its mint thesaurus, changing the ancestor chain an autocomplete component depends on. The stored index on thousands of *Coins* records is now stale, so lookups return the old structure. An administrator opens update cache on the *Coins* section, ticks the affected component, and runs it — every matched record is re-saved and its derived data rebuilt, with no record opened by hand.

## When to use it

- After an **ontology or thesaurus change** that affects how a component's derived data is computed.
- To **repair drift** in stored/derived data across a body of records.
- **Not** to change data — it writes each component's current value back to itself. To set, add or remove a value across records, use [Propagate component data](using_propagate_component_data.md).

## Where to find it

Update cache is a **section-level** tool: you open it on a section, and it lists that section's components for you to choose from. The panel shows the section name and its component tree.

## Using it, step by step

1. **Open update cache** on the section you want to maintain. The tool fetches the section's component list and shows it as a checkbox tree; media components and any components an administrator has flagged for easy location are highlighted.
2. **Tick the components** whose stored data you want to regenerate. (Automatic system fields cannot be selected.)
3. Optionally narrow the scope with a **section filter** before opening the tool — the run covers **exactly the records the list matches** (all pages of it, not just the visible one). With no filter, it covers the whole section. The scope the run uses is always the scope the list shows.
4. Press **Update records** (the button shows the record count in scope). The confirmation dialog repeats the record and component counts — what you confirm is what runs.
5. While it runs, the progress line ticks `N of total` with the current record id. The **Stop** button ends the run cooperatively: the record being processed finishes, the rest are left untouched, and the summary reports how far it got.
5. The run executes in the **background** and shows **live progress** — a running counter of records processed — then a final summary of components and records updated. If you close and reopen the panel while a run is still going, the progress view re-attaches to it.

## Options

| Control | What it does |
| --- | --- |
| Component checkboxes | Select which of the section's components to regenerate. |
| **Update records** | Starts the background regeneration over the records in scope; the label shows the count. |
| Regenerate options (media) | Media components may expose extra flags (for example *Delete normalised files*). |

!!! note "Media components"
    Selecting a media component **repairs its media**: the tool rebuilds the standard derivatives (default quality and thumbnail — for images also the display envelope) from the original file where it is present on the server, then re-scans the disk and updates the record's stored file index (`files_info`). This is the fix when an image exists on disk but does not show in the application. Records whose original is not on the server keep their stored index untouched — the tool never removes entries just because the files are not present on this machine (a partial media copy must not erase the record's knowledge of its files). The file index is written from the record as it stands at that moment, so a file someone uploads to the same record while the tool runs is kept, not undone. Records deleted while the tool runs, and records another user keeps busy for more than a few seconds, are reported at the end (nothing is written to them) and the run carries on with the next record. Audio/video derivatives are not re-transcoded here; for higher image tiers, deletes and av versions use [Media versions](using_media_versions.md).

!!! note "PDF components also fill empty transcriptions"
    For a PDF component, the run also copies the PDF's text into the record's linked transcription field — but **only when that field is empty** in your current data language. A transcription that already holds text is never overwritten, even if it differs from the PDF. The text comes from the text layer the PDF already carries; this tool never runs OCR. The final summary counts the transcriptions filled, those kept because they had text, and the PDFs without a text layer (nothing written for them).

    This is how to fill the transcriptions of PDFs that were uploaded before Dédalo did it automatically: run Update cache over the section holding them, with the PDF component ticked. Nothing does this on its own; it is your decision when to run it. See [component_pdf › Transcription and OCR](../core/components/component_pdf.md#transcription-and-ocr).

## Tips and gotchas

!!! warning "This re-saves real records in bulk"
    Update cache writes to every matched record. It does not change the visible value, but it is still a large write operation: it needs write permission on the section, runs as a background job, and can take a long time on big sections. Narrow the scope with a filter when you can.

!!! info "A run can be reverted, and records only what it changed"
    Each run is one bulk process. A record where the component holds no value is skipped, and a re-save that leaves a component exactly as it was writes nothing to its history; one that does change the stored form writes a normal history entry and records the value it replaced, so the whole run can be reverted from the [Time machine](using_time_machine.md#reverting-a-batch-run). The media repair is the exception: the refreshed file index is derived from the files on disk, and files moved aside are not moved back, so that part of a run is not reverted. The PDF transcriptions the run filled **are** part of the run, so a revert empties them again. A recomputed external portal is not reverted either: it is derived from other records, and a revert would only restore the stale list.

!!! tip "Value change vs. cache refresh"
    If you want the value to *change* across records, this is the wrong tool — use [Propagate component data](using_propagate_component_data.md). Update cache only refreshes the stored/derived form of the value that is already there.

## Related

- **[Propagate component data](using_propagate_component_data.md)** — change a component's value across matched records (this tool only re-derives it).
- **[Media versions](using_media_versions.md)** — rebuild media file qualities and versions.
- **[Upload](using_upload.md)** — how a PDF's transcription is written, and replaced, when the PDF is uploaded.
- **[Developer reference](../development/tools/reference/tool_update_cache.md)** — internals, API actions and options.
