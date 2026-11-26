---
title: "An audiovisual record without a stored duration shows its measured duration, or nothing — no longer an invented 00:00:00."
type: fixed
audience: user
date: 2026-11-22
wc: WC-2026-11-22-media-icons-tc
---
The duration shown beside an interview's recordings used to read `00:00:00.000` whenever no
duration was stored, and an upload whose file could not be measured stored that zero. Now the
stored duration is shown; when there is none, the file on the server is measured and its
duration shown (nothing is written by looking at a record); when there is no file, the
duration is left empty. An upload whose file cannot be measured no longer stores a zero.

A `00:00:00.000` that an earlier version already stored is still shown as stored. To store
the durations of recordings that show none, or to replace a stored zero with the real
duration, run [Update cache](./using/tools/using_update_cache.md) with the audiovisual
component ticked (it measures the file on the server; a recording with no file keeps what
is stored).

**Action needed:** none.
