---
title: A field with no sortable value (links, IRIs, media, access rules, passwords) can no longer be used to sort a list.
type: changed
audience: developer
date: 2026-11-13
wc: WC-2026-11-13-sort-non-scalar-refused
---
Before, a search request ordering the results by such a field was accepted and the
order silently fell back to the record id — and ordering by a password field exposed
the relative order of the stored hashes. Now the request is refused with
`search.invalid_sqo` naming the field, and the list header no longer offers a sort
arrow on an IRI column (clicking it never sorted anything). Every field that could be
sorted before still can.
