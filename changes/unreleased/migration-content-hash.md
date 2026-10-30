---
title: Database migrations are frozen by content hash.
type: changed
audience: developer
date: 2026-10-30
---
Each schema migration is now recorded together with the hash of the exact file that ran. If an applied migration file is changed later, the server refuses to migrate and says which file differs. The fix is to restore the file and ship the change as a new migration. Every migration file is listed in `install/db/migrations.lock.json` with its hash, its class and its release. The class is `compatible` (the previous code still runs on the new schema) or `incompatible`. A migration is `compatible` only when it is provably additive, such as an index, a new table or a nullable column. An `incompatible` migration can only ship in a minor release.
