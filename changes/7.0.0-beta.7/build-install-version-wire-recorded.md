---
title: "Build database version: the install-seed build's answer and panel values are documented"
type: changed
audience: developer
date: 2026-10-21
wc: WC-2026-10-09-build-install-version-owned-mode
---
*Maintenance → Build database version → Build install version* compiles the install seed
from the repository's own sources (since 7.0.0-beta.6). Its answer (the step readout and file size on success; a `maintenance.action_failed`
error carrying the same readout on a refusal) and the panel's three values (now the seed
sources, the scratch database pattern and the seed file, never the installation's database
name) are now recorded in the wire contract, for anyone scripting against the maintenance
API.
