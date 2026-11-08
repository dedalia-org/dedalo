---
title: "Ontology CSS: responsive rules no longer overwrite each other, area styles apply, edits show at once."
type: fixed
audience: user
date: 2026-11-07
wc: WC-2026-11-07-area-css-list-mode
---
CSS written in an ontology node's properties is applied more reliably. When several fields used the same `@media` query, only the last one drawn kept its responsive layout. Now each keeps its own. Selector lists such as `.a, .b` are limited to the element on every branch, not only the first. Number values (`"order": 2`) are accepted. CSS set on an area (thesaurus, maintenance…) now applies; before, it was discarded. An edit to a node's CSS shows on the next page load, with no stale copy left in the server's cache. The old v5 `style`/`mixin` sub-blocks, which never had any effect, are skipped explicitly. How it all works: [Ontology CSS](./core/ontology/ontology_css.md).
