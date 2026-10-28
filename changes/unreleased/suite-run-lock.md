---
title: The test suites refuse to run at the same time on one test database.
type: added
audience: developer
date: 2026-10-28
---
`bun test`, `bun run test:client` and `bun run test:crawl` reseed the same test fixtures, so running two of them at once made each fail in confusing ways. Each now takes a lock on the test database first and refuses, naming the run that holds it, while another one is running. A lock left by a run that died is cleared automatically, and a test that starts its own `bun test` inside a run is let through.
