---
title: The container updater gains a --check dry run that reports whether an update would be accepted, without changing anything.
type: added
audience: admin
date: 2026-10-26
---
`deploy/dedalo-image-update.sh --version <version> --check` runs the version checks, the engine's check and the image check, then stops. It takes no lock, makes no backup, creates no rollback tag, changes no file (`.dedalo.env` included), re-pins nothing, and starts, stops or recreates no container. It pulls no layer: the image is checked by its manifest, and with `DEDALO_IMAGE_VERIFY=cosign` its signature is read from the registry.

When the update would be accepted, it prints `check: would update <from> -> <to>` and exits `0`. When it would be refused, it prints the same refusal a real run gives and exits non-zero. See [Updating the image](./install/docker.md#upgrading).
