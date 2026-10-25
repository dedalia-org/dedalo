---
title: A prerelease build now calls itself by its tag (`7.0.0-beta.7`), and its data version is published beside it.
type: changed
audience: admin
date: 2026-10-15
wc: WC-2026-10-15-release-identity-from-tag
---
Before, a build made from a beta tag reported the bare version of the release it
precedes (`7.0.0`), so a beta could not be told apart from the stable release in
`/health`, the About panels or the **Update code** panel. Now the program names
itself by its git tag: `7.0.0` for a stable release, `7.0.0-beta.7` (or `-alpha.N`,
`-rc.N`) for a prerelease, `7.0.0.dev` for any untagged build.

The **data** version is unchanged and still the bare `7.0.0`: databases, updates and
code servers keep comparing that. API consumers get it beside the name —
`page_globals.dedalo_data_version`, and `/health` and the update status carry a new
`release_kind` (`stable`, `prerelease` or `dev`) — so nothing needs to parse a
version out of the name. A beta asking a code server for updates keeps sending the
bare data version, which every code server, older ones included, understands.

A code server reads the release name from the tag when it builds an archive, which
needs **git 2.35 or newer** on the code server: with an older git, *Build release*
now refuses (before, the archive was built and every installation of it called
itself a developer build).
