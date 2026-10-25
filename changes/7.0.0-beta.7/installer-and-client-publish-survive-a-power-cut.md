---
title: The installer's configuration and the published client now survive a power cut
type: fixed
audience: admin
date: 2026-10-21
---
Three install and start-up writes were safe against a crashed process but not against
a power cut or a kernel crash.

- **The `.env` the installer writes** (the only copy of the generated salt and the
  database password) is now forced to disk before the installer records that step as
  done. So is the pre-install backup that `--abort` restores, and so is the restored
  file itself. Before, a power cut could bring the `.env` back empty while the
  installer's own record said it had been written. A failed write no longer leaves a
  staged copy of the secrets next to it either.
- **The client a container publishes for nginx** is now written to disk in full before
  the switch to it. At every start the engine also re-checks the published files
  against the client it runs, so a copy damaged by a power cut is republished instead
  of being served until the next update. A republish no longer empties the live copy
  first, which used to cause a short burst of 404s.
- **The seed restore** no longer passes the database dump through a predictable file
  name in the shared temporary directory. Before, another local user on a multi-user
  Linux host could plant that file and add SQL to what the installer ran. The dump now
  goes to a fresh private directory.
