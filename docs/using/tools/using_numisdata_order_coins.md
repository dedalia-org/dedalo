# Order coins (`tool_numisdata_order_coins`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_numisdata_order_coins.md)

Sort a lot of coins by weight or diameter, drag them into a fixed catalogue order, and mark which coins are originals and which are copies — all in one two-panel window.

## What it's for

When you catalogue numismatic material as a **lot** — a hoard, a tray, a set of related issues — you need to arrange the coins into a deliberate order and record their relationships, not just list them. Order coins gives you a working surface for exactly that: every coin in the lot on the left, the order you are building on the right, and a way to designate originals versus copies so the record set carries those equivalences.

Concrete heritage scenario: a numismatist catalogues a hoard. They open the tool, sort the mosaic by weight to line up die matches, drag the coins into publication order in the right panel, then pick the genuine strikes as *originals* and the duplicates as *copies*. The tool records which copies belong to which original, so the relationships are stored on the records themselves.

## When to use it

- You are **ordering and grouping** the coins of a numismatic lot.
- You need to **mark originals and copies** and record their equivalences.
- It is **specific to the numismatics data model** — it works on coin sections configured for it, not on other kinds of records.

## Where to find it

Order coins is configured on the coin section it applies to and opens in **its own window**. The window has two panels:

- **Left** — a mosaic of every coin in the lot, each tile with sort controls, original/copy radio buttons, and a drag handle.
- **Right** — the ordered sequence you build by dropping coins in.

## Using it, step by step

1. **Open the tool** on the configured coin section. The left panel fills with the lot's coins as a mosaic; the right panel starts empty.
2. **Sort the mosaic (optional).** Use **Order by: Weight** or **Diameter** in the header to re-sort the tiles ascending (coins with no value sort to the end). Toggle the button off to return to the original order. Sorting only rearranges the mosaic to help you work — it does not change the coins.
3. **Build the order.** Drag a coin tile from the left mosaic and drop it into a cell in the right panel. Each drop inserts that coin into the ordered sequence; the panel rebuilds and the dragged tile is marked as used. Repeat until the sequence is complete.
4. **Mark originals and copies.** On the mosaic tiles, use the **Original** / **Copy** radio buttons to select the coins in each group, then press **Set Original / Copy** in the header. The tool records each selected coin's status and links the chosen copies to their originals as equivalences.
5. Saves happen as you go; the activity strip under the header confirms each one.

## Options

| Control | What it does |
| --- | --- |
| **Order by: Weight** | Re-sorts the left mosaic by coin weight, ascending. Toggle off to restore the original order. |
| **Order by: Diameter** | Re-sorts the left mosaic by coin diameter, ascending. Toggle off to restore the original order. |
| Drag a tile → right panel | Inserts the coin into the ordered sequence. |
| Original / Copy radios | Select which coins are originals and which are copies before applying. |
| **Set Original / Copy** | Writes the original/copy status of the selected coins and links the copies to their originals. |

## On a phone

A finger cannot drag. On a touch screen, **tap** a coin to pick it — a bar at the bottom of the screen names what you are carrying — then **tap** the slot in the ordered list to place it. The placement is the same as a drop. **Cancel** in the bar puts it back.

## Tips and gotchas

!!! tip "Sort to find matches, then order"
    Sorting by weight or diameter is a working aid — it lines up similar coins so you can spot die matches and duplicates before you drag them into the final order. It never alters the coins themselves.

!!! tip "Each change is reversible"
    Every write the tool makes — a coin's original/copy status, the equivalence links, the ordering — goes through the normal save path and is recorded in history. If you make a wrong assignment, you can restore the earlier value from the [Time machine](using_time_machine.md).

## Related

- **[Epigraphy transcription](using_numisdata_epigraphy.md)** — the sibling numismatics tool for transcribing coin legends and epigraphic elements.
- **[Time machine](using_time_machine.md)** — review and revert the individual writes this tool makes.
- **[Developer reference](../../development/tools/reference/tool_numisdata_order_coins.md)** — internals, components and registration.
