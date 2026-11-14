---
title: The PostgreSQL socket you give the installer is now the one the server connects through (`DB_SOCKET`).
type: fixed
audience: admin
date: 2026-10-09
breaking: true
---
The installer's socket answer (`--db-socket`) was used by the installer's own connection test and then written as `DEDALO_SOCKET_CONN`, a key the server never read: an installation reachable only through the socket passed the install and then connected to `DB_HOST` instead. The answer is now written as the new key [`DB_SOCKET`](./administration/configuration/config_db.md), and one rule decides the route for everything that connects to the database: the server, the installer's test, the nightly backup and the maintenance tools. When `DB_SOCKET` is set it wins over `DB_HOST`, and a socket that does not exist fails loudly instead of quietly falling back to `localhost`. An existing `.env` that holds `DEDALO_SOCKET_CONN` keeps working: it is now read as the old spelling of `DB_SOCKET`, so check that the directory it names is where your PostgreSQL socket really is before updating. A re-run of the installer writes the value once, under the new name. If you use the nightly backup unit, update `deploy/dedalo-backup.service` from the release so its database backup connects the same way.
