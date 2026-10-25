---
title: A record restored from an archive no longer shows the history of a deleted record that had the same id.
type: fixed
audience: user
date: 2026-10-21
---
Restoring an archive re-creates each record with the id it had when it was archived. If
this installation once held a different record with that id, deleted since, the restored
record's history used to list that deleted record's changes as if they were its own, and
they could be restored onto it. A restored record's history now starts with the restore,
as it already did for records imported with an explicit id. The deleted record's history
is kept.
