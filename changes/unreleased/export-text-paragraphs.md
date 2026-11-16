---
title: Exported text cells read as plain text — paragraphs become line breaks, HTML entities are decoded.
type: fixed
audience: user
date: 2026-11-12
breaking: false
wc: WC-2026-11-12-export-text-cell-clean
---
A rich-text field (a description, a transcription) reached the export files, the preview and the
NDJSON download with its paragraph markup and escaped characters: `<p>Coins &amp; medals</p>`.

Every exported cell is now cleaned as the earlier versions of Dédalo did: each paragraph starts a
new line inside the cell, the outer paragraph marks are removed, and the common HTML entities
(`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&nbsp;` and their numeric forms) become the characters
they stand for. Other markup, such as tags, is left as it is. The raw export format is not cleaned:
it stays an exact copy of the stored value for re-import.
