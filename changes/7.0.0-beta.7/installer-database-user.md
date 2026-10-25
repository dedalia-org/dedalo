---
title: The installer field *Database role* is now *Database user*.
type: changed
audience: admin
date: 2026-10-20
---
Same field, same value: the PostgreSQL user (a login role) Dédalo connects as and that
owns the database — the name you pass to `psql -U`. The install summary says
*database user* too. Nothing to change on an existing installation.
