---
title: An interrupted Docker image update now rolls back instead of leaving the stack pinned to an unverified version.
type: fixed
audience: admin
date: 2026-10-30
breaking: false
---
Stopping `deploy/dedalo-image-update.sh` after it re-pinned `DEDALO_VERSION` now puts the previous version back and reports *interrupted*. If it was killed outright, a `.dedalo-image-update.pin` file blocks later runs until `--recover` (which the host updater runs on its own) rolls back. A request for the version already installed is reported as *same version*, and a cancel can no longer race the host updater's claim.
