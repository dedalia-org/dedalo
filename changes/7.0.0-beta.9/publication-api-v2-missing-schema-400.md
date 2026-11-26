---
title: "Publication API v2: `resolve_inverse_relations=true` on a database without a `publication_schema` table answers 400, not 500."
type: fixed
audience: developer
date: 2026-11-24
---
A publication written without a `publication_schema` table (every database the v7 diffusion engine published before it began writing one) made `resolve_inverse_relations=true` fail with a 500 *An unexpected error occurred*. It now answers the documented 400 problem *publication_schema table not found or empty*; pass an explicit `section_tipo` → table map instead (see [Querying](./diffusion/publication_api/v2/querying.md)).
