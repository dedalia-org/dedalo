---
title: A CSV the import tool cannot read now shows as a card you can delete.
type: fixed
audience: user
date: 2026-11-13
wc: WC-2026-11-13-csv-staged-file-read-error-card
---
In **Import CSV**, a staged file the server cannot read — larger than the 64 MB limit, not a text file, damaged — was reported only as a red line above the file list: you could see why it was refused, but there was no card for it and no way to remove it from the panel.

Now the file is listed with its name, the reason it cannot be read and a **delete** button. It has no checkbox, no section and no column mapper, because there is nothing to import from it; deleting it works as for any other staged file.
