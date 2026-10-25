---
title: "Code updates move between prereleases of one version: beta to later beta, beta to its release."
type: added
audience: admin
date: 2026-10-18
wc: WC-2026-10-15-release-identity-from-tag
---
An installation that runs a prerelease can now install a later prerelease of the same
version, or that version's release, from the *Update code* panel or with
`deploy/dedalo-image-update.sh`: `7.0.0-beta.6` → `7.0.0-beta.7` → `7.0.0-rc.1` →
`7.0.0`. These moves need no data update, and prereleases may be skipped. Moving back
(`7.0.0-beta.7` → `7.0.0-beta.6`, or from `7.0.0` to one of its prereleases) is refused.
A move to the next version still goes one version at a time; its data update runs once,
on the first build of that version you install.

A prerelease needs the *Prereleases* (or *Developer builds*) choice of the panel. On a
container installation the panel can now request a prerelease image too, and the running
engine checks a prerelease version itself instead of refusing it as malformed.

After the restart, the panel reports an update as landed only when the server answers
with the exact version it installed; a server that answers with another build of the
same version is reported as rolled back.

An update is refused, before anything is swapped, when the archive it would download is not
the release it names, or when the downloaded archive calls itself another release.
