---
title: "Diffusion: a value MariaDB refuses names the record instead of stopping the run with an unexpected error."
type: fixed
audience: admin
date: 2026-11-24
---
When a MariaDB target in strict mode refused a published value (too long for its column, out of range, or of the wrong type), the whole run stopped with *An unexpected error stopped the diffusion run* and no clue which record caused it. It now stops as `diffusion.value_rejected`, naming the table, column, `section_id`, language and the type the ontology declares. Published columns are never retyped: after widening a field in the ontology, `ALTER` the live column or drop the table and re-publish (see [Native engine](./diffusion/native_engine.md)).
