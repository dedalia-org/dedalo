---
title: Escape now leaves a text area or JSON field, as it does every other field.
type: fixed
audience: user
date: 2026-11-13
---
Pressing **Escape** inside a rich-text field or a JSON field did nothing, so the field stayed active and its pending changes waited for a click elsewhere. Escape now saves and leaves the field, like in any other field. In a transcription with its player open, Escape still plays and pauses the media and the text stays in edit. Inside the JSON editor, an Escape the editor uses itself (collapsing a selection, closing its search box) is still the editor's: the next press leaves the field.
