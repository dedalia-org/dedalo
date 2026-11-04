---
title: The Bun-runtime procedure finds an instance whose name contains dots.
type: fixed
audience: admin
date: 2026-11-04
---
On a host whose instance is named after its domain — `dedalo-ts@example.org`, not
`dedalo-ts@prado` — the block that reads the instance name stopped at the first dot
and printed nothing, so every later command in
[Updating the Bun runtime](./install/bun_runtime.md) ran against an empty name.
It now reads the whole name, dots included.
