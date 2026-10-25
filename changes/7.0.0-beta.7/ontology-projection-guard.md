---
title: The ontology tool's "set records" can no longer write a node into another TLD's namespace.
type: fixed
audience: developer
date: 2026-10-21
wc: WC-2026-10-21-ontology-projection-guard
---
A record of `<tld>0` now only ever produces the node `<tld><id>`. A record whose TLD field
names another TLD is reported and skipped instead of overwriting that TLD's node; the tool
refuses sections that hold no ontology nodes (`test3`, `ontology1`, `localontology0`…) with
`request.invalid_options`; in list mode the search must target exactly the tool's section, and
a search with "recursive children" ticked is refused, because it would pick records the search
did not select. On a TLD registry record (`ontology35`), a TLD that still has rows in
`dd_ontology` but whose nodes drifted (for example only its root is left) is now re-derived in
full, not just its root; a TLD already in sync only has its root refreshed, and a TLD with no
rows stays empty — this action does not re-activate a TLD. See
[tool_ontology](./development/tools/reference/tool_ontology.md).
