---
title: "Update cache brings old stored formats up to date: legacy time codes in text areas and JSON stored as text."
type: fixed
audience: admin
date: 2026-11-22
wc: WC-2026-11-22-regenerate-facet
---
Running **Update cache** over a text area now rewrites time codes kept in the old form
(`[TC_00:01:02_TC]`) to the current one (`[TC_00:01:02.000_TC]`), and over a JSON field stores
a value kept as text as real JSON. A JSON value that is not valid is left untouched and listed
at the end of the run; the other records are still processed. Records already in the current
form are not written. The run's label is now written in your interface language.

**Action needed:** none. Details: [Update cache](./using/tools/using_update_cache.md).
