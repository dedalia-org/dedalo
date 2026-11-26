---
title: Importing a URI with a label now saves the label, and a text label is found or created.
type: fixed
audience: user
date: 2026-11-11
breaking: false
wc: WC-2026-11-11-iri-import-label-frame
---
Before, a URI imported with a label id (`8, https://dedalo.dev`, or `label_id` in a JSON cell)
was stored without its label: the label never appeared. A URI imported with a label text
(`Dédalo, https://dedalo.dev`) was refused.

Now both forms save the label exactly as the editor does. A text label is matched against the
existing labels ignoring case, accents and surrounding white space (spaces, tabs, line breaks, non-breaking spaces), as a whole value. When several
labels match, the one with the lowest id is used and the import reports the others. When none
matches, a new label is created in your default project. Importing the same file again creates
no second label.

Some cells are now refused and reported instead of imported: a label id that does not exist, a
label without a URI, and a label you have no permission to create. Saving a URI value that carries
`label_id` directly (for example through the API) is refused too: the label belongs to the URI's
label field. See [Importing data](./using/importing_data.md#uri).
