---
title: "A code server can publish a prerelease (`Build prerelease`), and a published release is never rebuilt."
type: added
audience: admin
date: 2026-10-18
wc: WC-2026-10-15-release-identity-from-tag
---
The *serve code* panel has a third button, *Build prerelease*, beside *Build release*.
It builds the newest prerelease tag (for example `v7.0.1-beta.2`) that is newer than the
newest release tag, into `<X>/<X.Y>/7.0.1-beta.2.zip` with its `.sha256` file. The
*Prerelease tag* row names the tag before you press the button. When there is no such
tag, the row says so and offers no button. *Build release* still builds only stable
`vX.Y.Z` tags.

A built release or prerelease cannot be built again. If its `.zip` and `.sha256` are
already on disk, the build is refused and the files are not changed. To publish
different code, tag a new release. Before the code server publishes an archive, it
checks that the archive gives the tag's name as its version. A tag made without `-a`
(a lightweight tag) fails this check, so the build is refused. A prerelease tag made
before this check existed (up to `v7.0.0-beta.6`) cannot pass it either, so the panel
does not offer it; the first prerelease that can be built is one tagged after it.

For developers: the pre-push hook now refuses a lightweight release tag. It also asks
for a full green gate for a prerelease tag, in the same way as for a stable tag.
`bun run push:release-tag` now takes the pushed tag object as a third argument.
