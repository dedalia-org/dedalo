---
title: The container updater reports a refused re-install of the pinned release as its own outcome, same_version, instead of downgrade_refused.
type: fixed
audience: admin
date: 2026-10-27
---
Before: asking the updater for the release the stack already runs was refused as `downgrade_refused`, which read as a step back.
Now: it is refused as `same_version` in the outcome file, and the message says the version is the pinned one. Only `-dev` builds are re-installed at the same version. A step back is still `downgrade_refused`.
