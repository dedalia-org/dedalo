# Diffusion (`tool_diffusion`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_diffusion.md)

Diffusion is the panel that publishes a section's records to its configured public targets — a MariaDB database behind a website, an RDF graph, or XML, Markdown, CSV and JSON files. It reads the section's diffusion definition, shows the subsystem's health, and launches the publish for the records you select.

## What it's for

Dédalo keeps your *work* data — the records you catalogue and correct every day — separate from the *published* data a public site serves. Diffusion is the operator-facing front end that copies work data out to those published targets. The tool itself does not transform or write anything: it shows the controls, then asks the diffusion system to run the publish for the records you chose.

Concrete scenario: an oral-history archive keeps its interviews, informants and indexation in Dédalo and serves them on a public site backed by a published MariaDB database. A cataloguer finishes correcting a batch of *Interviews*, filters that list, opens Diffusion on it, sets **depth levels** to 2 so each interview publishes together with the informant and place records it links to, and presses *Publish the selected records*. The panel streams progress and shows a per-table result — rows affected, time, and success, partial or fail.

## When to use it

- You need to publish or re-publish a section's records to the live public target(s).
- You want to check whether the diffusion subsystem is reachable before a big publish.
- You want to tune how many relation **levels** are published with each record.
- You need to clear **pending deletions** — records deleted while a target was offline, whose deletion never reached the target.

When *not* to use it:

- To download a spreadsheet — use [Export](using_export.md); for a backup of a section set, the archive door in [Exporting data](../exporting_data.md#the-archive-door).
- To produce a printed document — use [Print](using_print.md).

## Where to find it

Diffusion is a **section toolbar** button, but it does not appear on every section. It shows **only on a section that has a diffusion definition** in the ontology, and **never on individual components**. It opens **as a modal**. As with any tool, a non-superuser must have it granted on their profile.

## Using it, step by step

1. Filter the section list down to the records you want to publish (in edit mode, the tool targets the single record you have open).
2. Open **Diffusion** from the section toolbar. The panel loads the section's diffusion configuration, the subsystem health banner and any active processes.
3. Check the **status banner** — it reports the diffusion subsystem's readiness per format.
4. Set the **depth levels**. Level 1 publishes just this section's records; higher levels also publish the records they link to through relations. This value is remembered in your browser.
5. Optionally toggle **skip publication-state check** if you need to publish records regardless of their publication state.
6. Press the **publish** button for the selected records. The panel streams a per-table result: table name, rows affected, total time, and a success / partial / fail marker.
7. If the panel shows **pending deletions**, press **Retry** to re-attempt those delete propagations against the target.

## Options

| Control | What it does |
| --- | --- |
| Depth levels | How many relation levels are published with each record. 1 = this section only. Higher levels pull in linked records; cost grows quickly with depth. Remembered per browser. |
| Skip publication-state check | Publishes the selected records without checking each record's publication state first. |
| Publish selected records | Enqueues the publish job for the current selection and streams progress. |
| Retry (pending deletions) | Re-attempts delete propagation for records whose earlier deletion never reached a target. |

## Tips and gotchas

!!! warning
    **Depth levels are exponential.** Each extra level pulls in every record linked from the previous level, so a level-3 or level-4 publish can touch a very large number of records and take a long time. Start low and raise it only when you need the linked records published too.

!!! tip
    If a target was offline when records were deleted, the deletions queue up as **pending deletions**. Come back to the panel and press **Retry** once the target is reachable so the public data stays consistent.

!!! note "A target is missing from the panel"
    An administrator can withdraw diffusion elements from publication in the tool's configuration (the `EXCLUDE_DIFFUSION_ELEMENTS` key of `tool_diffusion` in **Tools configuration**). A withdrawn element shows no panel, and the server refuses to start a publication to it whichever way it is requested — a request sent by other means, a requeue from the maintenance panel, or the automatic restart of an interrupted run (that run is marked failed instead). A publication that was already queued before the element was withdrawn still runs. Records already published to it can still be unpublished. See the [tool_diffusion developer reference](../../development/tools/reference/tool_diffusion.md#excluding-diffusion-elements-exclude_diffusion_elements).

!!! note
    Diffusion does not do the writing itself — the diffusion system and its API own every data operation. The panel only reads the configuration and launches the work.

## Related

- **[Export](using_export.md)** — the other way data leaves Dédalo: a user-shaped file download rather than publishing to a live target.
- **[Developer reference](../../development/tools/reference/tool_diffusion.md)** — availability rule, the diffusion API actions and internals.
- **[Diffusion (system overview)](../../core/system/diffusion.md)** and **[The diffusion engine](../../diffusion/native_engine.md)** — how the subsystem publishes and what each target format means.
