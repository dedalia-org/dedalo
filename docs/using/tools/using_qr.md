# QR (`tool_qr`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_qr.md)

QR turns the records selected in a section into a printable A4 sheet of QR codes — one card per record, each encoding a link straight back to that record's page in Dédalo.

!!! warning "This is a sample/developer tool"
    `tool_qr` ships as a **worked example**, not a supported production feature. It exists to show how a tool reads a section's selection and renders something custom, and how a tool can be attached to a section through a configured button. Treat it as a reference implementation; it is not enabled out of the box, and its behaviour may change.

## What it's for

Where it is configured, QR produces physical labels that link back to the catalogue. Each card carries a QR code, a small identifying image, the record's id and a label. Scanning a card on a phone reopens that exact record.

Concrete scenario: a museum stores numismatic objects in warehouse trays. A cataloguer filters the inventory section down to one tray's worth of coins, opens the QR sheet, prints it, and cuts out the labels. Each physical coin slot now carries a QR sticker with a thumbnail and inventory number; scanning it jumps straight to that coin's record — exactly the "print labels for easy location in the warehouse" use the tool was written to demonstrate.

## When to use it

- As a starting point when a developer needs a tool that reads a section's current selection and renders a custom, printable view client-side.
- As a demonstration of surfacing a tool through a section button rather than by attaching it to a component model.

If you actually need to get a section's data *out* — to a spreadsheet or a re-importable file — use [Export](using_export.md), not QR. If you need a designed, paginated report, use [Print](using_print.md).

## Where to find it

QR is not attached to any component by default. It surfaces only when an administrator or developer has configured a section (typically via a button) to offer it, naming the tool and supplying the columns it should render. It opens in its own window over a section list, loading the whole current selection (it ignores pagination so every selected record is drawn).

## Using it, step by step

1. In a section that has QR configured, filter the list down to the records you want on the sheet.
2. Open the QR tool from its configured button. It opens in a new window and draws one card per selected record on an A4 canvas.
3. Each card shows the record's identifying image, its id, a label, and the QR code linking to the record's page.
4. Use the orientation selector to switch the sheet between portrait and landscape.
5. Print the window (the tool header, info bar and footer are hidden in print, and cards avoid page breaks). Cut out the labels.

## Options

| Control | What it does |
| --- | --- |
| Portrait / landscape selector | Flips the A4 sheet orientation for printing. |
| Configured columns | Which record fields become the card's image and label are set in the tool's configuration, not in the running UI. |

Because it is a sample, QR has no user-facing settings beyond orientation. What each card shows, an optional URL host override, and an optional entity logo are set in the tool's configuration by whoever wired it to the section — see the developer reference.

## Tips and gotchas

!!! tip
    Filter the section down to exactly the records you want before opening QR — it draws the entire current selection, with no pagination, so a broad filter produces a very long sheet.

!!! info
    QR runs entirely in the browser and has no server actions; the QR images are generated client-side. For how it is configured on a section and what the card configuration looks like, see the [developer reference](../../development/tools/reference/tool_qr.md).

## Related

- **[Export](using_export.md)** — the tool to reach for when you need a section's data out as a file, not as printed labels.
- **[Print](using_print.md)** — design a full paginated report layout for a section.
- **[Developer reference](../../development/tools/reference/tool_qr.md)** — how the sample is registered, surfaced through a section button, and rendered client-side.
