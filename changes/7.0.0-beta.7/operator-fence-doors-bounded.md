---
title: Phantom-language removal and the public-tier reconcile no longer hang on a busy publication target
type: fixed
audience: admin
date: 2026-10-21
wc: WC-2026-09-30-diffusion-target-fence
---
Removing phantom publication languages and applying the public-tier reconcile
used to wait without limit while a publication run held the target database.
They now wait at most 2 minutes in total, then report the busy target and leave
it untouched: re-run the action when the publication run has finished.

The publication-host kit (`hostagent:pack`) is now written durably, and a failed
pack no longer leaves a temporary file beside it.
