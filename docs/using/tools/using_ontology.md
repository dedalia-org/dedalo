# Ontology tool (`tool_ontology`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_ontology.md)

Re-syncs the ontology records you just edited into the runtime table that drives the live data model, so your changes take effect.

!!! warning "This is a developer/administrator tool"
    `tool_ontology` rewrites the rows that describe every section and component in your installation. Both the action and its button are hard-gated to developers/superusers — an ordinary cataloguer will not see it, and calling it without developer rights is refused. If you are not maintaining the ontology itself, you do not need this tool.

## What it's for

Dédalo's data model is ontology-driven: every section and component is described by ontology records. At runtime, though, Dédalo does not read those editorial records directly — it reads a fast, flattened projection of them held in the `dd_ontology` runtime table. When a developer edits an ontology record, the editorial record changes but that projection does **not** update automatically. Until it is re-synced, the change is invisible to the running application.

`tool_ontology` performs exactly that re-sync. It takes the ontology record (or records) you are looking at, re-parses them, and writes the result into `dd_ontology`. After a successful run it clears the relevant caches, so the change is visible immediately with no page reload.

A concrete example: an ontology engineer adds a new "countermark position" select to the *Coin* section in the ontology editor and saves it. The new component is still invisible because no runtime row describes it yet. The engineer opens `tool_ontology` on that record, presses **Process** (or Ctrl+S), and the new component immediately appears in the *Coin* edit form and in the thesaurus tree.

## When to use it

- Right after editing ontology records — one record, or a whole section — when you need the runtime model to reflect them.
- To repair or regenerate a branch of the ontology after a larger refactor.

For dumping ontology definitions to JSON, restoring from a snapshot, or repairing drift between the runtime table and its source across whole hierarchies, use [tool_ontology_parser](using_ontology_parser.md) instead.

## Where to find it

The tool surfaces on ontology elements — inline on the matching **component** (used for single-record edit mode) and in the section **inspector** panel (used for batch/list mode). It appears only on ontology tipos and only for developers. It opens **as a modal**, and binds **Ctrl+S** to the Process action.

## Using it, step by step

1. Edit and save your ontology record(s) in the ontology editor as usual.
2. **Single record:** open the tool inline on the component you changed and press **Process** (or Ctrl+S). Dédalo re-syncs just that record.
3. **A whole section / batch:** open the tool from the section inspector with no single record selected. Dédalo re-syncs **every** record of that section — this is a full scan, not just the records your current list view is filtering to.
4. Read the result message. On a batch, a record that fails to sync is skipped without losing the others (partial success), and the failing records are named in the messages.
5. The change is live immediately — the caches are cleared for you.

!!! warning "List mode processes the whole section"
    When you run the tool in batch mode, it re-syncs every record of the section, ignoring any list filter you have applied. There is no way to narrow a batch to "just the records I am looking at" — plan accordingly on large sections.

## Related

- **[tool_ontology_parser](using_ontology_parser.md)** — inspect and rebuild the runtime ontology against its source across whole hierarchies, and export to JSON.
- **[tool_hierarchy](using_hierarchy.md)** — builds new hierarchies and virtual sections rather than syncing existing ontology records.
- **[Developer reference](../../development/tools/reference/tool_ontology.md)** — the single action, its two modes, the permission gate, and internals.
- The [ontology](../../core/ontology/index.md) documentation — the model this tool maintains.
