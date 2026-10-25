---
title: Aborting an install (`--abort`) no longer fails with a deadlock when something else is connected to its database.
type: fixed
audience: admin
date: 2026-10-24
---
When `--abort` (or a reinstall over an aborted install) resets the install's database, any
other session still connected to that database — a server left running, an open `psql`, a
monitoring tool — could hold a table the reset had to drop. The reset then failed with
`deadlock detected`, or waited indefinitely behind a session idle in a transaction.

The reset now ends every other session on **that database only** (never another database,
never the installer's own lock) before it starts, waits until they are gone, and runs again
when the server still picks it as a deadlock victim or a lock wait times out — up to four
times, each attempt one transaction that rolls back whole. If it still cannot finish, it
stops with a line naming the reason and any session the installer's database role is not
allowed to end ([Troubleshooting](./install/troubleshooting.md)); when it completes despite
such a session, its result line names that session too.
