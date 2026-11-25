---
title: A code update renames retired configuration keys itself instead of failing.
type: fixed
audience: admin
date: 2026-11-23
---
Updating an installation whose `../private/.env` still held a renamed setting (for example
`DATA_LANG_SYNC`, `APPLICATION_LANG`, `DATA_LANG` or `PROJECTS_DEFAULT_LANGS`, which the
installer itself wrote) failed at the pre-swap boot check, naming one key per attempt. The update
now appends each new name to `../private/.env` with the old line's value — the old line is kept,
nothing is edited or removed — and the new release does the same at its first start when the
installation's updater is older than this change. A renamed setting that is set in the process
environment (a systemd unit, a container) cannot be renamed by the engine: the update is refused,
naming every such key at once. See
[Defining application language](./administration/configuration/config.md#defining-application-language).
