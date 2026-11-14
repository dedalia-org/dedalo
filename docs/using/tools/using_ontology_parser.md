# Ontology parser tool (`tool_ontology_parser`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_ontology_parser.md)

Keeps the runtime ontology consistent with its editable source: it shows you what has drifted per hierarchy, rebuilds a hierarchy from that source, and exports the ontology as files for sharing between installations.

!!! warning "This is a developer/administrator tool"
    Every action here is gated to developers/superusers. It reads and rewrites the rows that drive your installation's data model. If you are not maintaining the ontology, you do not need this tool.

## What it's for

The runtime ontology (`dd_ontology`) is a derived projection of the editable ontology source (`matrix_ontology`) — one runtime node per source record. Normal edits keep the two in sync as you save, but bulk imports, restores, failed partial writes, or direct database edits can leave them out of step. When they diverge, the running application no longer matches what the editor shows.

`tool_ontology_parser` is the instrument for seeing and fixing that divergence. It inspects each hierarchy, tells you exactly which nodes are missing, stale, or orphaned, and converges them by rebuilding the hierarchy's runtime nodes from the source (**Regenerate**). It can also export the whole ontology to files, so you can move a definition from one Dédalo installation to another.

A concrete example: an engineer imports an ontology from another Dédalo installation. The editorial records land, but the runtime tree does not match them yet. The engineer opens this tool, ticks the affected hierarchies, presses **Refresh status** to see the drift, then **Regenerate** to re-derive the runtime tree from the imported records.

## When to use it

- After a bulk ontology edit, an import from another installation, or a restore — when you suspect the runtime tree no longer matches its source.
- To publish the ontology as files for dissemination between installations.
- When a single-record re-sync ([tool_ontology](using_ontology.md)) is not enough because whole hierarchies are out of step.

## Where to find it

The tool is restricted to the **Ontology section**, where it appears as the *Ontology parser* action, for developers only.

## Using it, step by step

1. Open the tool. It shows a checkbox tree of ontologies grouped by typology.
2. Tick the hierarchies you want to work on.
3. Press **Refresh status**. The status panel marks each selected hierarchy as in-sync or out of sync, with counts of what drifted. A hierarchy can also be reported *in sync* and still carry a warning — "N records without a tld" — which is a different problem; see below.
4. Choose an action:
   - **Repair TLDs** rewrites the TLD of any record whose declared TLD does not match the section it sits in. This is the only action that edits the ontology *records*, not the derived table.
   - **Regenerate** (rebuild) deletes the hierarchy's runtime nodes and re-derives them from the source. This is the one action that writes the runtime tree.
   - **Export** writes the ontology definition files.
5. Each action asks for its own confirmation, runs, then repaints the status panel so you can verify the result.

## Options

| Action | What it does |
| --- | --- |
| **Refresh status** | Inspects the selected hierarchies and reports drift (missing / stale / orphaned nodes). Read-only. |
| **Repair TLDs** | Rewrites a record's TLD back to its section's. The only action that edits SOURCE records. |
| **Regenerate** | Wipes and rebuilds a hierarchy's runtime nodes from the source, in one transaction per hierarchy. The fix for any drift. |
| **Export** | Writes the ontology definition files (JSON and per-hierarchy dumps) for sharing between installations. |

!!! tip "Look before you rebuild"
    **Refresh status** changes nothing, so run it first — it tells you which nodes are off and by how much. Regenerate is safe to run on an in-sync hierarchy too: it rebuilds inside a single transaction, so anyone using the application keeps seeing the current ontology until the new one is complete.

!!! note "The old *Reconcile* button is gone"
    Earlier versions offered a second, non-destructive button that applied only the differences. It was removed on 2026-08-11. Its one advantage was avoiding a moment where the runtime ontology was empty — and that stopped being possible once Regenerate started rebuilding inside a transaction. Two buttons with the same outcome only made you choose without a reason to.

!!! info "Regenerate does not refresh the export files"
    Regenerate rewrites the **runtime tree** only. The files other installations download —
    the ontology definition files and the LLM map — are refreshed by **Export**, not by a
    rebuild. If you rebuilt in order to publish the result, press Export afterwards.

!!! warning "Regenerate wipes the runtime nodes, not the source"
    A rebuild deletes the hierarchy's runtime nodes and re-derives them from the editable source. The **source records are never touched** — the projection is regenerated from them. It runs in one transaction per hierarchy, so a mid-run failure rolls that hierarchy back cleanly.

!!! info "Two different problems: drift, and records without a TLD"
    **Drift** means the runtime tree disagrees with its source — Regenerate fixes it.

    **"Without a tld"** means the section holds records that carry no TLD at all. A record's
    TLD is what gives it an identity, so such a record cannot become a node: it is invisible
    in the tree, and no amount of rebuilding will change that. It is reported as a warning
    beside the hierarchy rather than as drift, precisely because no button can clear it.

    Two ways to resolve one:

    - the record has content but the **wrong** TLD → **Repair TLDs** corrects it;
    - the record is **empty** (no term, no properties) → open it and fill it in, or delete it.
      Repair deliberately skips these: stamping a TLD on an empty record would only add a
      nameless node to the tree, which is worse than leaving it invisible.

!!! info "A third warning: nodes that break a rule of their model"
    Some component models fix how their nodes must be defined. A URL component
    (`component_iri`) is never translatable: a URL has no language, and its versions in
    other languages are stored as language versions of one value. A `component_iri` node
    marked as translatable — or with the *translatable* field left empty, which counts as
    translatable — is reported as "node(s) break a model rule", and the node is named. This is
    an error in the master ontology: no action here fixes it, and Dédalo does not ignore the
    setting. Report it so the node is corrected in the master ontology (*translatable* set to
    *no*), then update the ontology.

!!! warning "Repair TLDs edits the ontology records themselves"
    Every other action here writes the derived runtime table. Repair writes the **source
    records**. It changes only the TLD field, only where it disagrees with the section, and
    only on records that carry content — but it is a source edit, so read the status panel
    first and run **Regenerate** afterwards to re-derive the runtime tree from the corrected
    records.

## Related

- **[tool_ontology](using_ontology.md)** — the per-record parse/sync used from single-edit and batch modes; the incremental path a normal edit takes.
- **[tool_hierarchy](using_hierarchy.md)** — builds new hierarchies and virtual sections rather than repairing existing ones.
- **[Developer reference](../../development/tools/reference/tool_ontology_parser.md)** — the drift model, the five actions, and internals.
- The [ontology](../../core/ontology/index.md) documentation — the model this tool maintains.
