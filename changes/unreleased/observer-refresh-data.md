---
title: Changing or clearing the person of a biographical milestone clears the milestone again.
type: fixed
audience: user
date: 2026-11-13
wc: WC-2026-11-13-observer-refresh-data
---
In a person's biography the *Biographical milestone* field offers only the milestones of
the person chosen next to it. Since the move to this engine, picking a different person — or
removing the person — left the previously chosen milestone in place: a value the field would
no longer offer, still stored, published and searchable. Now, as before the move, changing
the person clears the milestone (one Time Machine entry, by the user who saved); saving the
same person again leaves it alone, and an already-empty milestone is not touched. Only a save
of the person field does this: duplicating a record, undeleting one or restoring a past
version from the Time Machine keeps the milestone it carries, and a CSV import row that sets
the person and the milestone together keeps its milestone whatever the column order. For
administrators: the observer rule behind this (`refresh_data`, condition `on_empty`) accepts
exactly that one action; anything else is refused, counted and logged — see
[observers](./core/system/observers.md#clearing-a-dependent-value-refresh_data).
