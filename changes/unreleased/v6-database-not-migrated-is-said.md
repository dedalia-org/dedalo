---
title: Starting v7 on a Dédalo v6 database now says the database is not migrated
type: fixed
audience: admin
date: 2026-11-19
wc: WC-2026-11-19-data-version-unreachable
---

A v7 server started on a database that was still at a 6.x data version gave the wrong advice everywhere. The start-up log said a data update was pending and to run *Update data*; the health check stayed green; and the *Update data* panel said "Data format is updated: 6.9.1". None of it could work: the move from v6 to v7 is done on the v6 installation, before v7 ever starts.

The server now recognises a database from an earlier major version that none of its updates starts from. The log says `[boot] DATABASE NOT MIGRATED` and points to the migration guide, `/health` answers 503 with `"data_version": {"state": "unreachable"}`, the *Update data* panel shows the same sentence instead of "updated", and a code update is refused for that reason. Run Phase A of [Migrating from v6](./install/migrating_from_v6.md) on the v6 installation, then start v7 again.

If the server answers a code update's restart check in that state, the *Update code* panel now says the server is back on a database it cannot update, instead of waiting and then reporting that the server did not come back.
