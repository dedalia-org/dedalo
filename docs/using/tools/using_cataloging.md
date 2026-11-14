# Cataloging tool (`tool_cataloging`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_cataloging.md)

A two-pane drag-and-drop workspace: drag loose records from a source section on the left onto a thesaurus tree on the right to file them into a hierarchy.

## What it's for

You often have a pile of flat records that belong in a controlled hierarchy but are not yet filed there. `tool_cataloging` puts the source records (as a mosaic of cards, on the left) next to the target tree (on the right) so you can organize them by hand, visually. When you drop a card onto a tree node, Dédalo creates a new term under that node and links the dragged record into it — turning your loose records into the leaves of a navigable tree.

A concrete example: a numismatic collection has hundreds of coin **types** stored as flat records, and a thesaurus of **mints** organized as a tree. A cataloguer opens this tool, sees the unfiled types as cards on the left and the mint hierarchy on the right, then drags each type onto the mint that struck it. Each drop creates a term under that mint and links the type into it — building the "types inside mints" catalog. Cards already filed into the loaded hierarchy show a highlighted drag handle, so at a glance you can see what is still unfiled.

## When to use it

- You need to assemble records from a source section into a thesaurus or taxonomy tree by hand, visually.
- You are populating a hierarchy that [tool_hierarchy](using_hierarchy.md) has just built.

When NOT to use it: if the hierarchy itself is not yet built or activated, use [tool_hierarchy](using_hierarchy.md) first — this tool fills a tree, it does not create one. If you are linking text fragments to terms rather than whole records, that is a different workspace (the indexation tool).

## Where to find it

The tool is wired onto an element through that element's configuration, which supplies the source section, the target thesaurus, and the term component that receives each dropped record. It opens in **its own window**, split into a left pane (the source mosaic) and a right pane (the thesaurus tree). Because the wiring is per-element, where the button appears depends on how your project configured it.

## Using it, step by step

1. Open the tool. The left pane shows the source records as draggable cards; the right pane shows the target thesaurus tree.
2. Find the record you want to file in the left mosaic. Hover a card to reveal its overlay actions (edit, remove, info) and a richer view of the record.
3. Drag the card onto the tree node it belongs under.
4. On drop, Dédalo creates a **new term** under that node and links the dragged record into it. The tree updates to show the new term, and the card's drag handle switches to the "used" state so you can see it is now filed.
5. Repeat for each record. The activity panel shows save notifications as you go.

## On a phone

A finger cannot drag. On a touch screen, **tap** a record card to pick it — a bar at the bottom of the screen names what you are carrying — then **tap** the thesaurus term to place it. The placement is the same as a drop. **Cancel** in the bar puts it back.

## Tips and gotchas

!!! tip "The highlighted drag handle means already filed"
    A card whose drag handle is highlighted (the `used` state) is already linked into the loaded hierarchy. Use that to tell, at a glance, which records still need filing.

!!! warning "Each drop writes to the database"
    A drop is not a preview — it creates a new term record and saves the link immediately (through Dédalo's normal, permission-gated save path, so you need edit rights on the target section). There is no bulk undo: to reverse a filing you remove the term or the link the ordinary way.

!!! info "It needs a configured target"
    The tool cannot persist a drop unless it has been told which component of the new term should receive the dragged record. If that configuration is missing, drops silently fail — ask whoever configured the tool. The internals are in the [developer reference](../../development/tools/reference/tool_cataloging.md).

## Related

- **[tool_hierarchy](using_hierarchy.md)** — builds and activates the hierarchy that this tool then fills with records.
- **[tool_ontology](using_ontology.md)** — developer tool for syncing edited ontology records.
- **[Developer reference](../../development/tools/reference/tool_cataloging.md)** — the drop flow, the configuration keys, and why it declares no server actions.
