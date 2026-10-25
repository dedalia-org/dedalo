---
title: Building the ontology recovery file no longer stops the server when the disk is full, and the file survives a power cut
type: fixed
audience: admin
date: 2026-10-21
---
The ontology recovery file (*Maintenance → Build database version*) is the safety net an
ontology update relies on.

- **A full disk or a read-only private directory** while the file was being written used
  to stop the whole server process, or leave the request waiting forever. The build now
  fails like any other failed build: it reports the error, keeps the previous recovery
  file as it was, and leaves no partial file behind.
- **A power cut right after a successful build** could leave an empty or partial recovery
  file under its final name. The file is now forced to disk before it replaces the
  previous one, and so is the replacement itself.
