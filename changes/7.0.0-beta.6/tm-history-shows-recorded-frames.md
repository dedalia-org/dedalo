---
title: A field's history now shows the dataframe it had at that moment.
type: fixed
audience: user
date: 2026-09-28
wc: WC-2026-09-27-bulk-revert-undo-log
---
In the [Time machine](./using/tools/using_time_machine.md) preview, an entry of a field with a
[dataframe](./core/components/component_dataframe.md) now shows the frames the field had at
that moment — the role of each informant, the certainty of each value — instead of
today's, together with the field's value as it stood then, and the field's own values no
longer list the frames among them. Entries recorded by Dédalo v6 show their frames too: in
an entry that carries frames, a dataframe it holds none for shows empty — which is what a
restore leaves there; a v6 language entry with no frames at all shows the frames recorded
before it.
