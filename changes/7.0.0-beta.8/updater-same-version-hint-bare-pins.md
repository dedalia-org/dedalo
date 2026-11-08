---
title: The updater's same-version refusal suggests the skip flag only for a stack pinned at a bare version.
type: fixed
audience: admin
date: 2026-10-26
---
Before: a refused update that went back to an older version suggested `--skip-version-check` for every stack, including one already pinned to a prerelease or a developer build, where the suggestion did not apply.
Now: the suggestion appears only when the stack is pinned at a bare `X.Y.Z` version, the case of a beta built before `7.0.0-beta.7`. A stack pinned to a prerelease or `-dev` build is refused without it.
