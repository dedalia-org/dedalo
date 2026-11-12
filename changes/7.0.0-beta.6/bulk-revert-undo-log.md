---
title: Reverting a batch run now restores exactly what the run replaced, and says what it could not.
type: fixed
audience: user
date: 2026-09-27
wc: WC-2026-09-27-bulk-revert-undo-log
---
**Revert the bulk process** used to guess each value's state before the run from the
history just older than it. Where that history was missing — values stored before the time
machine recorded them, written with it off, or appended to by a CSV import — the revert
**emptied** the field instead of restoring it; where a later edit had been made with the
time machine off, it rolled that edit back. Every batch run (CSV import, bulk component
edit, update cache, MARC21 and Zotero imports, and a revert itself) now records, with each
change, the exact value it replaced, so the revert puts that value back. A field someone
edited after the run is **left alone** and reported, never overwritten; records the run
created are removed only when nothing else refers to them, and records the run deleted
come back together with every link that pointed at them. Reverting an old import never
touches a record that a later import created again at the same id. When the revert finishes, a
summary lists what was reverted, what was skipped and why, and the id of the revert, which
can itself be reverted; reverting the same run a second time changes nothing and says
so. Re-importing an unchanged file, or repeating the same bulk replace, records nothing,
portal links included, and the dataframe frames of those links stay attached. Runs made
before this update are still reverted the old way, with its known fixes, and the summary
marks those values as inferred; a frame edited after such a run is left alone and reported, and
the dataframe frames of an old run that saved several languages of a field are restored together
instead of being refused as changed. The CSV import no longer
has a *Save time machine history on import* switch: every import can be reverted. A revert,
a single-field restore or a record recovery of a hierarchical term field now also updates
its broader-term search index, so a search for a broader term finds the restored value (and
no longer the value it replaced) without waiting for a later save. See
[Time machine](./using/tools/using_time_machine.md).
