---
title: "The update panel can ask for prereleases: choose published releases, prereleases or developer builds."
type: added
audience: admin
date: 2026-10-18
wc: WC-2026-10-15-release-identity-from-tag
---
The *Developer builds* checkbox of the *Update code* panel is now a choice of three:
**Published releases** (the default), **Prereleases** and **Developer builds**. Each
choice also offers what the one before it offers. A prerelease (for example
`7.0.1-beta.2`) is a fixed, checksum-verified build of a version that is not yet stable,
and its row shows that full version. An installation that asks for published releases
is never offered a prerelease.

A code server offers prereleases only when it sets the new
`DEDALO_CODE_SERVER_PRERELEASE_CHANNEL=true`, which is separate from
`DEDALO_CODE_SERVER_DEV_CHANNEL`. When the code server does not offer part of what you
chose (it is not set up for it, or it runs an older Dédalo version), it lists only what it
does offer and the panel names the missing part above the list.

An installation that runs a prerelease is also shown the later prereleases and the
release of its own version, and can install them (see the entry on moving between
prereleases).
