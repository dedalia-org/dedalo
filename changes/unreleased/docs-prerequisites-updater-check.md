---
title: The Docker install guide lists the curl, unzip, sha256sum and cosign prerequisites, and documents the updater's --check dry run.
type: changed
audience: admin
date: 2026-10-26
---
The [Docker install guide](./install/docker.md) now lists `curl`, `unzip` and `sha256sum` among the host tools, with the install commands for Debian, Ubuntu and the RHEL family, and gives the release-binary steps for `cosign`, checked against the release's checksums file. The update section documents `--check`, the read-only dry run of an image update.
