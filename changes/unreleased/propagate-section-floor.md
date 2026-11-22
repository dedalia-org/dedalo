---
title: "Propagate component data now requires access to the section, not only to the field."
type: security
audience: user
date: 2026-11-22
wc: WC-2026-09-30-write-door
---
Before, a user who could edit one field but had no access to its section could still
propagate a value into that field across the section's records. Propagation now asks the same
questions as editing a record by hand: access to the section, write permission on the field,
and — record by record — whether the record is within the user's projects. A record the user
may not edit is listed in the run's warnings and left untouched; the rest of the run goes on.

The same check now guards the transcription tools: a transcript saved by the automatic
transcription, and the timecode shift of a transcription, are written only where the user may
edit the record.

**Action needed:** none. Details:
[Propagate component data](./using/tools/using_propagate_component_data.md).
