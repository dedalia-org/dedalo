---
title: Code updates no longer refuse over a file an older release shipped and a newer one removed.
type: fixed
audience: admin
date: 2026-10-07
wc: WC-2026-10-07-update-code-root-entries-stamp
---
An update from the *Update code* panel refused with "Unknown entries at the code-tree root … `.vscode`" on installs that had taken an older release: the file was shipped by Dédalo itself, then removed from later releases, and the updater could not tell it from a file the administrator had added — nor could it be cleared without shell access. Each update now records the top-level entries of the release it installs, so the next update moves a retired release file into the backup instead of refusing, and the panel's *Code-tree root entries* check reports only files nobody shipped. An install updated before this release still refuses once over such a file: remove it by hand that one time ([what makes an update refuse](./administration/updates/updating_code_options.md#what-else-makes-the-update-refuse)).
