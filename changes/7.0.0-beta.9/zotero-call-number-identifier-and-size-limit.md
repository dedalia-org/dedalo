---
title: "Zotero import: an export over 64 MB is refused."
type: changed
audience: user
date: 2026-11-13
wc: WC-2026-11-13-csv-ingest-size-ceiling
---
An export larger than 64 MB — the same limit as a CSV import — is refused when the import
runs, with a line naming the file, its size and the limit, and is left where it was staged.
Export the library in parts.
