---
title: Code updates of a git-checkout install no longer refuse over `.claude` and `CLAUDE.md`
type: fixed
audience: admin
date: 2026-10-21
---

An install made with `git clone` holds two files that no release ships, `.claude` and `CLAUDE.md`. The code updater saw them as unknown files and refused every update with "Unknown entries at the code-tree root". The updater now reads the files a release leaves out from the release's own `.gitattributes`. Those files move into the backup with the old code, and the update proceeds.

**One manual step for checkout installs on an earlier release:** the refusal is checked by the code that is already running, so the next update still refuses once. Before updating, delete the two links from the install directory: `rm .claude CLAUDE.md`. They are tracked by git, so `git checkout -- .claude CLAUDE.md` restores them.
