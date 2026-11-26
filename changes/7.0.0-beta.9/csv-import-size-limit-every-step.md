---
title: A CSV too large to import is refused when it is uploaded, and the import panel shows why a staged file cannot be read
type: fixed
audience: user
date: 2026-11-13
wc: WC-2026-11-13-csv-ingest-size-ceiling
---
The CSV import tool's 64 MB limit was checked only when the file list was shown. Checking or
running the import read a larger file in full, which could exhaust the server's memory for
every user.

Now the same limit applies at every step: an oversized CSV is refused when it is uploaded, and
one already in the import folder is refused before it is read, with a sentence naming the
file, its size and the limit. Split the file and upload the parts.

A staged file the tool cannot read (too large, not a text file, or already damaged) used to
disappear from the list without explanation. The panel now shows why, in red, above the file
list.
