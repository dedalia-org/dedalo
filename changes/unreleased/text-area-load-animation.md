---
title: A long text area stays inside its field — idle or active — and no longer widens itself on load.
type: fixed
audience: user
date: 2026-11-03
breaking: false
---
Opening a record whose text area holds a lot of text (the "Información pública" field of a coin
record) showed the field growing wider than its column for a moment — the text painting over
the neighbouring column — and then snapping back in a couple of steps, which reads as an
animation.

Cause: the toolbar and the editor share one grid cell, and that grid's column was `auto`: its
minimum width is the widest item's min-content, and the toolbar item is the editor's balloon
toolbar — about 900px of buttons in one row before it folds. On activation the column grew to
that minimum (measured 822 → 914px on the field), the editor grew with it, and once the editor
folded its buttons the column stepped back to the field's width.

The column is now `minmax(0, 1fr)`: it can never be wider than the field, and the toolbar
clips/scrolls inside it. Measured across the same load: the field and its content box stay at
822px from the first frame, the editor at 809px — no balloon, no snap.

Also removed in the same pass: the 600 ms fade the "this field has a value" tint carried, and
the hover tint's transition running on activation, so a field that comes back active with the
page paints its surface at once instead of fading in.

The same containment now holds while the field is **idle**. A text area's editor is a scroll
container, so its min-content height is zero and it can never grow the row it lives in: an
idle long text simply painted over the component below (the map) exactly as the active one
did. Idle fields now take the field's height too and scroll inside it; short texts look
unchanged, they just sit on a box that reaches the field's bottom.
