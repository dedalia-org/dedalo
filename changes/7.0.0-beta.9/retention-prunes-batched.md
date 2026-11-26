---
title: The activity-log and publication-ledger retention prunes now run in small committed batches.
type: fixed
audience: admin
date: 2026-11-12
---
With `DEDALO_ACTIVITY_RETENTION_DAYS` or `DEDALO_DIFFUSION_LEDGER_RETENTION_DAYS` set, the
daily prune used to remove every expired row in one database statement. On a very large log
(tens of millions of rows) that statement ran for minutes, and under a statement time limit it
was cancelled and undone — every day, so the log never shrank.

The prune now removes the expired rows 10 000 at a time, each batch saved on its own. A very
large first prune makes steady progress, a batch that is interrupted loses nothing that came
before it, and stopping the server ends the prune between two batches. Rows still owing an
unpublish to a public site are still never removed.
