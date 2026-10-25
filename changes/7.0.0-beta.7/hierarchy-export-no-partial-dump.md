---
title: Exporting a thesaurus never leaves or certifies a partial dump
type: fixed
audience: admin
date: 2026-10-21
breaking: false
---
The hierarchy export panel used to stream each thesaurus straight to its final file and judge the export by "the file exists". A dump cut short (a server error, a dropped connection, a full disk) still left a valid-looking file, and `hierarchy.json` then certified it with a checksum, so an installation importing it received a partial thesaurus. Each dump is now written beside its final name and moved into place only when psql succeeded, the file reads to its end, and it holds exactly the rows psql reported; otherwise the panel names the reason and the previous good file is kept. Building `hierarchy.json` also refuses, keeping the previous manifest, when a data file it would list is torn or changed while it was built. A complete but short dump left by an export made before this fix cannot be told apart: export those thesauri again.
