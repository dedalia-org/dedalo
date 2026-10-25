---
title: The installer says what to do when the checkout's dependencies are missing.
type: fixed
audience: admin
date: 2026-10-20
---
`bun run scripts/install.ts` in a checkout where `bun install` had not been run
stopped at once with `Cannot find package 'zod'`, which named neither the cause
nor the fix. It now refuses with one sentence: run `bun install` in the checkout
first. Nothing is written. `sh install.sh` is unchanged and still installs the
dependencies itself. See
[Running the installer without `install.sh`](./install/installer_reference.md#running-the-installer-without-installsh).
