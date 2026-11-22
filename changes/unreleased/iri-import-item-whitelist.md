---
title: "Importing URIs as JSON: a property the URI field does not know is refused by name, the URL loses its surrounding spaces, and an empty item is refused."
type: changed
audience: user
date: 2026-11-22
wc: WC-2026-11-11-iri-import-label-frame
---
A URI (`component_iri`) cell written as JSON is now checked item by item, whichever form
you use (a plain array or one array per language):

- An item may carry `iri`, `id`, `lang`, the deprecated `title`, and `label_id`. **Any other
  property refuses the cell** and the import report names it. Before, it was stored on the
  value, where nothing ever reads it.
- The `iri` loses its surrounding spaces in the plain array form too, as it already did in the
  per-language form.
- `id` must be a whole number of 1 or more; `title` and `lang` must be text.
- An empty item (`{}`), or one with neither an `iri` nor a `title`, is refused instead of being
  stored as an empty value.
- In the per-language form an item with only a `title` is now accepted, like in the plain form.

A raw export of the field still imports back unchanged.

**Action needed:** if your import files add their own properties to URI items, remove them.
Details: [Importing data — URI](./using/importing_data.md#uri).
