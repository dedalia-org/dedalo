---
title: SQL the engine runs through psql no longer appears on the psql command line
type: security
audience: admin
date: 2026-10-23
---
Several maintenance and installation doors (ontology import and export, ontology
update snapshots, thesaurus export, the restore door, the installer's probes and
the seed compiler) passed their SQL to `psql` as a command-line argument. Any
local user could read those statements in the process list while they ran, and on
Linux a statement over 128 KiB failed to start at all (`E2BIG`). The SQL now
reaches `psql` on its standard input; the command line carries only connection
and output options. The terminal installer's host-preparation plan keeps its
short catalog probes on the command line, where its Review shows them.
