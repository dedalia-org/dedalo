# Propagate component data (`tool_propagate_component_data`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_propagate_component_data.md)

Set, add or remove one field's value across every record that matches your current filter — one edit applied to the whole selection, tracked as a single batch you can undo later.

## What it's for

You often need the *same* change on many records at once: the same conservation status on every coin of a mint, the same rights statement on a whole photo collection, a retired keyword stripped from every interview that still carries it. Editing each record by hand is slow and error-prone. This tool takes the value you compose once in a single component and **propagates it to that same component across every record in your current selection**.

Concrete heritage scenario: a numismatics cataloguer filters the *Coins* section down to the 800 issues of one mint, all catalogued with an empty *Conservation* field. They open the tool on *Conservation*, set the correct term once, and press **Replace** — the value lands on all 800 records in one background pass. Later the institution retires a deprecated keyword; with the same tool in **Delete** mode they remove that one term from every record that still has it, leaving each record's other keywords untouched.

## When to use it

- The same component value must be **set, appended, or removed** across a set of records you can define with a section filter.
- Reach for it after a search: filter the section to exactly the records you want to change, then propagate.
- **Do not** use it for a one-off edit — open the record and edit it directly.
- **Do not** use it to copy one field into a *different* field, or to transform values — it writes a component back to the same component. To *regenerate* stored/derived data without changing it, use [Update cache](using_update_cache.md).

## Where to find it

The tool attaches to the components it can edit. While a section is in **edit** mode, a **Propagate** button appears on a matching component — both in the section **inspector** panel and inline on the component itself. It does not appear in list/read mode. You compose the value in a temporary copy of that component, so the widget you edit is exactly the one you already know.

## Using it, step by step

1. **Filter the section** to the records you want to change. The tool acts on your current selection, so the search you run *is* the scope. Everything visible under that filter is in range.
2. Put the section into **edit** mode and open **Propagate** on the component you want to change (from the inspector or inline on the component).
3. **Compose the value** in the component widget the tool shows you. This is a temporary, standalone copy of the field, seeded with the value you were editing — fill it in exactly as you would on a normal record.
4. **Choose the mode** with the button row:
   - **Replace** — overwrite the component's existing value with the new one.
   - **Add** — append your value(s) to a multi-value component, skipping any already present. (Hidden for single-value components.)
   - **Delete** — remove the given value(s) from a multi-value component.
5. **Confirm.** The tool shows the field name and the number of records that will be affected, and asks you to confirm. If **no filter** is applied — so the action would touch *every* record in the section — it asks a second, stronger confirmation.
6. The run executes in the **background** and reports progress while it works. When it finishes you get a summary (records processed, any per-record warnings).

## Options

| Control | What it does |
| --- | --- |
| **Replace** | Overwrites the component's current value in the chosen language with the value you composed. |
| **Add** | Appends your value(s) to a multi-value component, skipping items already present. Not available for single-value components. |
| **Delete** | Removes the given value(s) from a multi-value component. For relation components it matches by locator, so only the exact linked record is removed. |
| Language | The value is read and written in the current data language. |

## Tips and gotchas

!!! tip "Filter first, check the count"
    The record count shown before you confirm is your safety net — it is the number of records the change will touch. If it is far from what you expected, cancel and refine your search. Your filter is never altered by running the tool; you return to the same selection you started from.

!!! warning "This writes to many records at once"
    Propagation changes real data across your whole selection. Running it with no filter applies to **every** record in the section — the tool warns you, but read the count before confirming. You need write permission on the section and component. Very large selections run as a background job and can take a while.

!!! tip "You can undo the whole batch"
    Every write in one run is stamped with the same batch id and records the value it replaced, so the entire propagation is reversible as a unit, exactly. If a run set the wrong value, open the [Time machine](using_time_machine.md) on any affected record, find that batch, and **revert the bulk process** — every record the run touched is rolled back in one action (an administrator role is required to revert a batch). A record someone edited after the run is left alone and reported — see [Reverting a batch run](using_time_machine.md#reverting-a-batch-run).

## Related

- **[Time machine](using_time_machine.md)** — browse a record's history and revert a mistaken edit, including undoing a whole propagation run.
- **[Update cache](using_update_cache.md)** — regenerate a component's stored/derived data in bulk without changing the value.
- **[Export](using_export.md)** — the read-side bulk operation over the same kind of section selection.
- **[Developer reference](../../development/tools/reference/tool_propagate_component_data.md)** — internals, API action and options.
