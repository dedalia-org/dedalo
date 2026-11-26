---
title: A new installation's first update no longer rebuilds every search index.
type: fixed
audience: admin
date: 2026-11-12
---
The installer builds the search indexes (the text search store and the relation index) and now
also records how it built them. Before, the first code update of every new installation found
them unrecorded and rebuilt them in full, which on a large installation took a long time inside
the maintenance window. The installer also checks the record when it verifies or resumes an
installation. Installations made before this update rebuild their indexes once, at their next
update, and are then recorded.
