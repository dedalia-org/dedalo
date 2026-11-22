---
title: "Publication: a relation's `empty_value` keeps every item's place, and a field's frames publish only for the main field they belong to."
type: fixed
audience: admin
date: 2026-11-22
wc: WC-2026-11-22-diffusion-ddo-empty-value, WC-2026-11-22-diffusion-dataframe-hop
---
Two settings of a publication field's `ddo_map` are now honoured.

- **`empty_value` on a relation.** When an item of the relation leads to nothing (a coin with no
  hoard, for instance), the declared value is published in its place — `["0"]` when the setting
  is `"empty_value": ["0"]` — so every item keeps its position in the published list. Until now
  the setting was ignored and the item simply disappeared from the list, shifting the ones after
  it. Declaring it on a field that is not a relation, or with a value that is not a list, now
  stops the publication with an error naming the field.
- **Frames of one main field.** A frame field (`component_dataframe`) whose `parent` is the main
  field it extends now publishes only the frames of that main field, read from the record that
  holds it, and each published frame carries the number of the item it belongs to (`id_key`) so
  the two can be joined. Until now such a field published nothing. A `parent` that is not a field
  of the same `ddo_map`, or that does not use this frame field, now stops the publication with
  an error.

**Action needed:** none. If a publication now stops with one of these errors, correct the field's
`ddo_map` in the ontology.
