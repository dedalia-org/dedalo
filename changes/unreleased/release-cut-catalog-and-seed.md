---
title: A release tag needs its catalog entry and its seed.
type: changed
audience: developer
date: 2026-10-30
---
Pushing a release tag is refused unless the tagged commit lists the release in `install/update/catalog.json` and carries an install seed compiled for the commit's data version. Without the catalog entry, no master would ever offer the release.
