---
title: A code update is now one journaled update run that also applies the ontology, schema, data and tool steps, and confirms only after verifying them.
type: changed
audience: admin
date: 2026-10-30
breaking: false
wc: WC-2026-10-30-update-run
---
**Update code** in the maintenance panel now starts an update run. The server reads the code server's release list itself, plans every step of every release between the installed version and the chosen one, and records the run in a journal under the private directory. Maintenance mode stays on from the start of the run until it is confirmed. After the new code starts, the run applies the ontology, the database migrations, the data update and the tools in release order. It then verifies the result, and only then confirms the update. A run that is interrupted resumes from its journal on the next start. If a step fails within one data model, the previous code is restored automatically. If the run has already moved the database to a new data model, it stops and names the backup to restore. `bun run update status`, `check`, `plan <release>` and `abort` show and manage runs from the command line. See [Updating code](./management/updates/updating_code.md).
