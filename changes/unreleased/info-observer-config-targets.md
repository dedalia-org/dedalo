---
title: "An information field observing another field now recomputes on the records its `server.config` names."
type: fixed
audience: admin
date: 2026-11-22
---
An information field (`component_info`, and its state and calculation variants) that observes
another field with a `server.config` — `use_observable_dato` (the records the saved field
points at) or `use_inverse_relations` (the records pointing at the saved one) — recomputed on
the record that had just been saved instead, and its history entry was written there. It now
recomputes on the records the configuration names, as every other observer does; with
`use_observable_dato`, the records the saved field stopped pointing at are recomputed too.
Observers configured only with `filter` behave as before.

**Action needed:** none.
