---
title: A published code release is now built from a release tag (`vX.Y.Z`); developer builds come from `master`.
type: changed
audience: admin
date: 2026-09-29
wc: WC-2026-09-29-code-release-channel-refs
---
On a code server, **Serve Code**'s *Build release* button used to archive the tip of the `master` branch, and *Build developer release* whatever other branch the server had checked out. Now a published release is always a tagged version: *Build release* archives the newest `vX.Y.Z` tag of this engine in the build checkout (prerelease tags such as betas are not releases, earlier-engine `v6` tags are never candidates, and a tag whose version file disagrees with its name is refused), and *Build developer release* archives the tip of `master` — the latest integrated code, before its release. The branch the server has checked out no longer matters.

What to do on a code server: tag each release commit (`git tag v7.0.1`, pushed to the remote) and fetch tags into the build checkout (`git fetch --tags`) before building; until a tag exists the panel reports that nothing can be published. While v7 is in beta this is the expected state: installations receive v7 code only as developer builds. See [Updating code](./administration/updates/updating_code.md).
