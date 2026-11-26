---
title: "Publication API v2: AV fragments on a database without the AV tables answer 400, not 500."
type: fixed
audience: developer
date: 2026-11-24
---
`…/records/{id}/av-fragments` and `av-indexation-fragment` join the tables and columns named by the `AV_*` settings. On a publication without them (a numismatic one, say, whose `audiovisual` table has no `image` column) MariaDB's *table doesn't exist* / *unknown column* reached the client as a 500 *An unexpected error occurred*. It is now a 400 naming what is missing (see [Search and fragments](./diffusion/publication_api/v2/search_and_fragments.md)).
