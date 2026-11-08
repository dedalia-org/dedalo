---
title: Nested reads carry a verified caller chain; the client's `show` and search query are checked; a level-two `self` in a client map is refused with a notice.
type: changed
audience: developer
date: 2026-11-04
wc: WC-2026-11-04-rqo-source-callers, WC-2026-11-04-stage1-authorized-sqo-scrub, WC-2026-11-04-ddo-self-first-level-only, WC-2026-11-04-subdatum-own-level-residual-divergences
---
A request that targets a nested element directly (the next page of a nested portal, the autocomplete inside its cell) may send `rqo.source.callers`, the chain of elements it is nested under; the server verifies every link against the ontology and the user's grants and ignores a chain that does not verify. The `show`/`search` a client sends is checked against the user's grants and its search query is cleaned before use. In a `ddo_map` a client sends, `section_tipo: "self"` is accepted only on a first-level ddo; below that the ddo is skipped with an `ontology.ddo_self_refused` notice in the response, and a ddo `section_tipo` may now be a source array (what this means for installed definitions is in the administrator entry on the same rule). A nested element's own permission level, as stamped on its context, is the user's level on that component, no longer the level read from whichever record came first; the remaining differences from the previous engine's per-component permission cases are recorded in the wire contract. See [Self-resolution](./core/request_config.md#self-resolution-and-dynamic-section_tipo-sources).
