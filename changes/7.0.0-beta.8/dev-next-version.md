---
title: Developer builds are named for the next version, for example 7.0.1-dev.
type: changed
audience: user
date: 2026-10-25
---
Before: an untagged developer build reported its version as `7.0.0.dev`, the name of the release it followed, and its archive was `7.0.0-dev.zip`. Now it reports the next version it is heading to, written with a hyphen (`7.0.1-dev`), and its archive is named the same way. A developer build sorts above every prerelease of its version and below that version's release, so an install running it is offered the stable release `7.0.1` once that exists. Two developer builds of the same line share one name, so the version shown does not change between them; the **Installed archive** value shows which build is running. Moving from a developer build to a release candidate is not offered, and no channel moves an installation to an earlier release: an urgent developer build is followed by the next stable release. A release tag names its own version, so a code-only patch tag such as `7.0.1` over data `7.0.0` reports `7.0.1`, not a developer build.
