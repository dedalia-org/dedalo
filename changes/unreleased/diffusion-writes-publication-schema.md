---
title: "Diffusion writes the `publication_schema` table again, so `resolve_inverse_relations=true` works on v7 publications."
type: fixed
audience: admin
date: 2026-11-24
---
Version 6 wrote a `publication_schema` table when a diffusion element was saved in the ontology. Version 7 stopped writing it, so on every database it published `resolve_inverse_relations=true` (and v1's `resolve_portal`) had no map to read. Each run of an `sql` element now writes the table. Its `dd_relations` lists every section the element publishes with its table. The element's `properties.diffusion.publication_schema` is kept as written, and its own `dd_relations` entries take precedence. A malformed map stops the plan with a named error. A `publication_schema` still at the top level of `properties` (the v6 location) is read when `diffusion` has none, with a warning to move it. Each run merges its entries over the stored row, so elements sharing a database and field maps a v6 install wrote are kept. Existing databases get the table on their next run (see [Native engine](./diffusion/native_engine.md)).
