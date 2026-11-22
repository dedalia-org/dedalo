# Time machine (`tool_time_machine`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_time_machine.md)

Browse the full change history of a record or a single field and restore any earlier version — including undoing a whole batch edit in one action.

## What it's for

Dédalo keeps **every** user change to a record's data as a history entry. The time machine is the window into that history: for one field or one whole record you can see when it changed, who changed it, and what the value was — then restore the version you want. It is your safety net for the everyday mistake (a wrong date typed last week) and for the big one (a batch run that mis-set a field across hundreds of records).

Concrete heritage scenario: a cataloguer notices the *dating* of a coin issue was changed to the wrong century. They open the time machine on the *Date* field, see the change list, select the entry from before the bad edit — the previous value shows in the preview pane — and press **Apply and save**. The date is restored, and the restore itself is logged as a new history entry. Separately, an administrator finds that a propagation run mis-set a field across 400 records; they open the tool on any affected record, pick the entry carrying that run's batch id, and **Revert the bulk process** — every record the run touched rolls back at once.

## When to use it

- Someone needs to **see the edit history** of a record or a field — when, who, what value.
- You need to **roll back** a mistaken edit to an earlier value.
- An administrator needs to **undo a whole batch run** (for example a [Propagate component data](using_propagate_component_data.md) run) across every record it changed.
- It is **not** a diff/merge tool and not a general undo stack — it restores a chosen past snapshot wholesale into the live record.

## Where to find it

The time machine attaches to record elements — both individual **components** and whole **section records**. It opens in **its own window**. Open it from a component to work on that one field's history, or from a section record to work on the whole record at once.

## Using it, step by step

1. **Open the time machine** on the field or record whose history you want to see. A scrollable **history list** shows the change entries, most recent first, with when / who / which field.
2. For a single component or record, the window shows two panes side by side: a **Now** pane with the current value, and a **preview** pane.
3. **Pick an entry.** Click a history row's preview (eye) icon. The historical value loads into the preview pane, read-only, so you can compare it against **Now** before committing.
4. **Apply and save.** When you are sure, press **Apply and save** — the live value is overwritten from the snapshot you selected. Restoring a whole section record restores all its components at once, and recovers any files that were deleted with it. While one of the record's audio/video fields is being built or uploaded, the restore is refused with *"A version build is already running for this file. Wait until it finishes and try again"* and nothing is restored; try again when the job has finished. The recovered record leaves the time machine's list of deleted records (its entries stay in its history), and the section's list opens again without the search or page you had left on it. The restore is itself recorded as a new history entry. For a single field, Dédalo first checks whether the restore would change anything: if the selected entry is the same as the current value (an empty entry onto an empty field included), it asks for no confirmation and writes nothing — no new history entry, no change to the record's modification date, no activity entry — and the window shows *The selected version is the same as the current value. Nothing was restored* and stays open. Otherwise it asks you to confirm the overwrite first.
5. **Revert a batch (administrators).** If the entry you picked belongs to a batch run, an administrator additionally sees **Revert the bulk process**. Pressing it rolls back every record that run changed to its pre-run value, in one operation, then shows a summary of what was reverted and what was not — see [Reverting a batch run](#reverting-a-batch-run). Non-administrators see a notice to contact an administrator instead.

!!! note "Fields with a dataframe"
    A field with a [dataframe](../../core/components/component_dataframe.md) — for example the *Informants* of an oral-history interview, each with its *Role* — keeps the two together in its history, in two kinds of entry: an entry of a **language** holds that language's value, and an entry marked **lg-nolan** holds the value that has no language (a field that is not translatable — and every field that links records, such as a list of informants, which never has languages — or the base form of a name that has transliterations — *Augustus*, beside *Αύγουστος* in Greek) and **all** the frames. Changing a frame adds one lg-nolan entry to the **field's** history (the dataframe has none of its own), never a copy per language, and the history of a language shows its own entries and the lg-nolan entries together. It does not matter whether the value or the frame was saved first: the preview of any entry shows the whole state at that moment — the language's value as it was and the frames as they were. Restoring a language entry puts that language's value back with the frames as they stood at that moment; restoring an lg-nolan entry puts its frames (and its value without language) back. The field's other languages, and the frames that belong to another field sharing the same dataframe, are left as they are; a frame of an item that has been deleted since is never put back. For a name with transliterations, the history lists the base-form entries and those of the language you are working in (work in Greek to see *Αύγουστος*); the preview of a transliteration entry shows the base form and the frames as they were, and restoring it puts the transliteration back. The preview and the history list show each frame and its own values (a *Role*, a rating and its colour) as they were at that change, not as they are now, even if the frame's record was edited or emptied since. The same holds for the history of a whole record: the entry of a deleted record shows its frames' values as they were when it was deleted. In the time machine a frame's button only shows: clicking it opens nothing and it offers no **+**, because what it shows is the past, not the record as it is now — edit a frame from the record itself. A dataframe an lg-nolan entry (or an entry from Dédalo v6 that carries frames) holds no frames for was empty at that time, so restoring that entry — or reverting a batch run to it — makes that dataframe lose this field's frames (frames of another field sharing it stay). Restoring a language entry puts back the frames as they stood at that moment, so a dataframe that held no frames of this field then loses this field's frames (frames of another field sharing it stay).

## Options

| Control | What it does |
| --- | --- |
| History list | The change entries for the element, newest first — when, who, which field changed, and its value. For a field that links records (related terms, a portal), each entry shows up to the first 10 linked records; open the preview (eye) icon to see the whole value. |
| Preview (eye) icon | Loads the chosen historical value into the read-only preview pane for comparison with **Now**. |
| Annotation column | Shows the **text** of the annotation attached to each history entry, if any. In the tool this column is read-only; annotations are written from the record inspector's history block, where the same column is a note icon that opens the annotation editor. |
| Language selector | Chooses which language of the value to view and restore. Shown only for text fields that hold one value per language; a field that links records has no languages, so it has no selector. |
| **Apply and save** | Overwrites the live value with the selected snapshot (a component, or a whole record and its files). |
| **Revert the bulk process** | Administrator-only: undoes an entire batch run across every record it touched. |

## Reverting a batch run

Every batch run — a [CSV import](using_import_dedalo_csv.md), a [bulk component edit](using_propagate_component_data.md), an [update cache](using_update_cache.md) run, a MARC21 or Zotero import, and a revert itself — records, with each change it makes, the exact value that change replaced. Those recorded values are not shown in the history list; the list shows the usual entry holding the value after the change. **Revert the bulk process** puts the recorded values back.

What the revert does, field by field:

- **A field the run changed, and nobody touched since** — restored to what it held before the run as a normal save stores it (a value from before the engine cleaned that kind of value comes back cleaned), including a value the time machine had never recorded before and an empty field the run filled. In a translatable text field only the language the run wrote is restored; the other languages stay as they are. A field that links records has no languages: it is restored whole, whatever language the run was working in.
- **A field already back at its pre-run value** — left as it is and counted as *already at the pre-run value*.
- **A field someone edited after the run** — **left alone**: the revert never overwrites a later edit. It is listed as skipped (*changed_since_run*). The same happens when another change was made to the field in the middle of the run (*interleaved_write*), and when undoing the run would remove an item someone gave a dataframe value after the run.
- **A field and its dataframe** — reverted together or not at all, language by language: every language the run changed and the field's frames come back as they were before the run. A dataframe shared by several fields only has the frames of the reverted field put back; the others stay as they are.
- **A record the run created** — deleted, but only when the whole revert of that record succeeded, the record holds nothing the run did not write besides what every new record of its section starts with (its project, its default values), and no other record refers to it. Otherwise it is kept and listed (*created_record_kept*).
- **A record a run deleted** (a record created by a run and deleted by that run's revert, when you revert the revert) — restored together with the field that pointed at it, including links other records had to it, and listed as not exact: its media files are moved back from the deleted folder (a file uploaded since is kept), but its published copies are not republished. If that field cannot be reverted (someone edited it since), the record stays deleted and is listed (*cascade_delete_not_reverted*). A dataframe target the run *emptied* (a slot set to empty its targets on unlink — no setting deletes them) gets its data written back into the kept record. If the record is still there but someone edited it since, it is left as it is and listed the same way; when the edit is in the very value the run wrote, that field is listed too (*changed_since_run*). The field that points at it is still reverted. If the record is already back as it was (you are reverting the same run a second time), nothing is done and nothing is listed. While an audio/video field of such a record is being built or uploaded, the record is not brought back: it is listed as failed (and the field that points at it is not reverted either) — revert again once the job has finished. A record that came back but whose media files could not all be moved back is listed as not exact (*media_not_restored*); the files that stayed out are still in the deleted folder and the server log names each one.
- **A record's creation date or author** (imported from a CSV) — restored, and the record's summary date and author are recalculated from it; listed as not exact (*metadata_twin*).
- **A record's *Modified by* and *Modified date*** — not restored: every change, the revert's own included, updates them, so after a revert they show the revert as the record's latest change. They come back only when the run wrote them itself (CSV columns for them).

When it finishes, a summary lists how many fields (or field groups, such as a field and its dataframe) were reverted, how many fields were already at their pre-run value, every item skipped with its reason, every item restored by inference or with side effects, and the id of the revert itself — which is a batch run of its own, so you can revert the revert.

!!! warning "Runs made before the 2026-09-27 update are reverted by inference"
    A run made before the update did not record what it replaced. Its revert still takes each value from the history entry just before the run, as it always did: that is exact only where such an entry exists and is current. Where the run's entry is a field's **only** history, the field is emptied only if the run created the record, and skipped (*no_pre_batch_state*) otherwise. The summary marks every value restored this way as inferred, so you know which records to check.

!!! note "A running batch cannot be reverted"
    A revert of a run that is still in progress is refused until the run ends, and two reverts of the same run cannot run at once.

## Tips and gotchas

!!! tip "Compare before you restore"
    Always check the preview against the **Now** pane before pressing **Apply and save** — a restore puts back the selected entry's lane — one language of a text field (the other languages stay), or a field without languages whole, with its frames — it does not merge that lane with its current value.

!!! warning "Restoring overwrites the current value"
    **Apply and save** and **Revert the bulk process** overwrite live data. Both are reversible (each restore is itself logged as new history). **Apply and save** replaces the restored language (or the whole field, for a field without languages) and its frames as they stood at that entry; a batch revert skips, and reports, every field edited after the run. Reverting a batch and applying a component restore both need write permission on the record; reverting a batch needs an administrator role, and reverting a field with a dataframe also needs write permission on the dataframe.

!!! note "A restored value is checked like a saved one"
    **Apply and save** and **Revert the bulk process** pass every value they put back through the same checks as a normal save: rich text is cleaned of scripts and event handlers, a number is formatted as its field declares, and a value the engine cannot store safely — such as a password entry stored as plain text — is refused, leaving the current value as it is. A batch revert refuses only the field concerned (or the record, when it was restoring a whole record), lists it as skipped (*failed*), and goes on with the rest of the run. An entry recorded long ago can therefore land slightly cleaner than the preview shows it; the history entry itself is never modified.

    A password entry from a Dédalo v6 installation — stored encrypted, before passwords were stored as hashes — is put back exactly as it was recorded. It is not a usable password until the [v6 passwords are converted](../../install/migrating_from_v6.md), so restoring or undeleting a user record from before the upgrade does not lock that conversion out.

!!! info "How batch undo links up"
    A batch tool stamps every write in one run with the same id, and records with each write the value it replaced. That id is what the time machine's **Revert the bulk process** follows to find and roll back every affected record — so a single mistaken [propagation](using_propagate_component_data.md) is undone as one unit, not record by record.

## Related

- **[Propagate component data](using_propagate_component_data.md)** and **[CSV import](using_import_dedalo_csv.md)** — batch tools whose runs the time machine can revert as a whole.
- **[Export](using_export.md)** — export the change history itself for offline review.
- **[Developer reference](../../development/tools/reference/tool_time_machine.md)** — internals, API actions and options.
