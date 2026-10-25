---
title: The Docker and Trial installer installs the image of its own release — `7.0.0-beta.7` for a beta — and a stack built from an earlier beta needs `--skip-version-check` once on its next image update.
type: changed
audience: admin
date: 2026-10-15
breaking: true
wc: WC-2026-10-15-release-identity-from-tag
---
The installer now knows which release it is from the git tag of the checkout or
release archive it runs from, and says so in its header and on the System check:
`7.0.0`, `7.0.0-beta.7 (prerelease)`, or `7.0.0.dev (development build)` for a
commit with no release tag. That decides the image of a Docker or Trial install:

- **A stable release or a prerelease** installs the image tagged with its own name.
  A beta asks the registry for `:7.0.0-beta.7`, never for `:7.0.0` — after the
  stable release that tag is a different image. The Review still asks the registry
  before `yes` and refuses an official image that is not published yet, with
  **Build** and **Custom** offered.
- **A development build** has no official image: **Build** is preselected, and
  **Official** is refused on the Image screen without asking any registry.

A local build is tagged and labelled with that name, and `.dedalo.env` pins it as
`DEDALO_VERSION` (`7.0.0-beta.7`, or `7.0.0-dev` for a development build).

The image updater (`deploy/dedalo-image-update.sh`) accepts prerelease versions and
orders them as releases are ordered: `7.0.0-beta.6` < `7.0.0-beta.7` < `7.0.0-rc.1` <
`7.0.0`. In `build` mode it checks out `v7.0.0-beta.7` for a prerelease (or the ref you
name with `--ref`) and refuses a commit that is not that release — a tag that is not
annotated, or names another version — before anything is built; a local build's version
label is always what the engine inside it reports. `--skip-version-check` now also waives
a step back within one data version, and never one to an older data version. A running
engine that cannot read a prerelease version is asked about its data version instead
(`7.0.0-dev` for `7.0.0-beta.7`), so a skipped `X.Y.Z` is still refused.

**Action needed** for a stack installed from a beta up to 7.0.0-beta.6 with **Build**:
it is pinned at the bare `DEDALO_VERSION=7.0.0`, and a prerelease comes before its
stable release, so the move to `7.0.0-beta.7` reads as a downgrade. Its update script
is still the old beta's, which refuses any prerelease version, so first move the
stack's checkout to the new release (`git fetch --tags && git checkout v7.0.0-beta.7`),
then run that one update with `--skip-version-check`; later updates need nothing. See
[a stack installed from a beta before 7.0.0-beta.7](./install/docker.md#a-stack-installed-from-a-beta-before-700-beta7).
