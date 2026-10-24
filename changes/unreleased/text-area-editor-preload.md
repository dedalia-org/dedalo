---
title: Opening a rich-text field no longer downloads the editor on the first click.
type: changed
audience: user
date: 2026-10-24
---
Clicking into a description, transcription or any other rich-text field used to
start the download and parsing of the editor itself, so the first click sat
there for a moment before the cursor appeared.

The editor's engine is now fetched in the background while the edit form
settles — once per page, only when the form actually shows an editable
rich-text field — and the first click only creates the editor for that field.
Fields are still not loaded until used, so a form with many text areas does not
carry one editor per field. On a metered connection (browser "data saver") the
background fetch is skipped.
