---
title: The parity test baseline can be re-recorded in the CI image.
type: added
audience: developer
date: 2026-10-29
---
`bun run ci:local --docker --record-parity-baseline` re-records `engineering/parity_baseline.json` inside the CI image, the same way `--record-unit-baseline` does for the unit tests. Recording it on a developer machine froze that machine's own configuration into the baseline. It can be combined with `--record-unit-baseline --new <file>` so a single green run records both.
