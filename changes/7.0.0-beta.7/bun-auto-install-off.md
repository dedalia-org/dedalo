---
title: Bun no longer fetches packages by name outside the lockfile.
type: security
audience: admin
date: 2026-10-20
---
Running a Bun command in a checkout where `bun install` had not been run let
Bun's auto-install download any imported package straight from the registry by
name, ignoring `bun.lock` — so neither the pinned versions nor their integrity
hashes applied. Auto-install is now off in the engine and in each publication
package: a missing install stops with `Cannot find package`, and dependencies
come only from `bun install` against the lockfile.
