---
title: Exported text cells no longer carry the editor's tag marks.
type: changed
audience: user
date: 2026-11-13
wc: WC-2026-11-13-export-tag-marks-plain-text, WC-2026-11-13-export-media-cell-type
---
A text with indexation, time-code, person or note tags exported its raw tag marks inside the
cell (`[index-n-58-…]`, `[TC_00:01:02_TC]`, …). Those marks are now removed: the cell holds the
plain text, and the tagged items themselves are exported through their own components as before.
Previous exports that need the clean text should be run again.

Media columns keep the engine's cell types: an image cell is drawn as an image in the HTML
download, an audiovisual or 3D cell and a PDF or SVG cell hold the file's URL as text.
