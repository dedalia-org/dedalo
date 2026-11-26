---
title: "The install seed can be built from an ontology master's latest release — from the command line or the maintenance panel."
type: added
audience: developer
date: 2026-11-25
wc: WC-2026-11-26-build-database-version-panel
---
Building the install seed with the latest ontology used to mean copying the exported release files
from the ontology master by hand into `install/import/ontology/<major.minor>/`. `--from` takes the
name of an `ONTOLOGY_SERVERS` entry, downloads that master's published release with the same
checks an ontology update uses (configured origin, size caps, sha256 of every file — a file without
a published digest refuses the pull), compiles from it, and replaces the release directory only
once the new seed passed its verification install — a build that fails or is stopped before then changes nothing. Review the
diff and commit the release files with the seed and its manifest.

The maintenance panel's *Build database version* action builds from the same choices: this
server's own ontology export (on an ontology master), a configured master, or the release
shipped with the code. It checks first that it can run (the database user may create databases,
the PostgreSQL tools are present, no other build is running, the source answers, there is disk
space), names the fix for each failed check, runs in the background, and writes the result to
`<private>/seed_builds/` instead of the code directory, with download buttons for the seed and its manifest.

**Action needed:** export the release on the master first; the pull takes what it last exported.
