---
title: The Update-code panel says when the database's data version blocks a code update
type: changed
audience: admin
date: 2026-11-20
wc: WC-2026-11-19-data-version-unreachable
---

A code update is refused unless the database is at the data version the running code declares. The *Update code* panel did not show that: it could read "Ready to update", and the reason arrived only as the refusal after you pressed Update.

The panel now has a **Data version** line among its checks. When the versions differ the update is shown as blocked, with the reason and what to do: run *Update data* first, restore a matching backup, or — for a database of an earlier major version, such as a Dédalo v6 database under v7, which no update of this engine starts from — run the migration on that earlier installation ([Migrating from v6](./install/migrating_from_v6.md)). The version window shows the same reason beside its disabled Update button.

For API consumers: `consumer.checks[]` of the `update_code` panel value gains `{ id: "data_version", state, detail: "<state>/<installed>/<code>" }`.
