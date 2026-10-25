---
title: The installer's downloaded ontology files survive a power cut
type: fixed
audience: admin
date: 2026-10-21
---
The installer fetches the chosen ontology files before it touches the database, and
records that step as done. The files were not forced to disk, so a power cut right
after that step could lose them, and resuming the installation then refused with a
"changed outside the installer" error that only recreating the installation would
clear. The files and their checklist are now written to disk safely before the step
counts as done, and each file appears under its final name only once it has been
checked.
