---
title: A failed code-only or same-version update now puts the previous code back by itself.
type: fixed
audience: admin
date: 2026-11-12
wc: WC-2026-10-30-update-run
---
A code update to a release that does not change the data model (a patch with no `compat`), or
to another build of the release you already run (a prerelease to its next prerelease or to its
stable, a nightly reinstall), that failed after the code swap used to stop in
`NEEDS_DB_RESTORE` and ask for a database restore. The database had not changed, so the previous
code now goes back on its own (`ROLLED_BACK_CODE`), as for a `compatible` release. A run that
already ended in `NEEDS_DB_RESTORE` is not changed by this update. See
[When a phase fails](./management/updates/index.md#when-a-phase-fails).
