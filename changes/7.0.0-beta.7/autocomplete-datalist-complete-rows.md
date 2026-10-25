---
title: The autocomplete result list no longer opens as a blank band
type: fixed
audience: user
date: 2026-10-24
---
An autocomplete field painted its dropdown the moment the search answered, but
before the matched records had been built: every result was an empty row. On a
slow render the open list became a tall blank panel over the form, with rows
appearing one by one — which read as broken layout.

Rows are now appended only once their record is rendered, in result order, and
the picker answers only when the whole list is ready: the open list is either
empty or complete, never a band of blank rows. A row that fails to render is
skipped and named in the console instead of leaving another blank band. The fix
is in `core/services/service_autocomplete/js/view_default_autocomplete.js`.
