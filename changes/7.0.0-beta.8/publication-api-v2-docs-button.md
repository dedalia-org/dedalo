---
title: The Publication server API panel can open the v2 API documentation.
type: added
audience: admin
date: 2026-10-30
---
The "Open Swagger UI" buttons of Maintenance → Publication → Publication server API open the
legacy v1 documentation, a separate application Dédalo does not serve: on an installation whose web server
does not route `/dedalo/publication/` to it they answered "not found". A new optional setting,
`DEDALO_PUBLICATION_API_V2_URL` (the v2 API address, `BASE_PATH` included), adds an
"Open API v2 docs" button that opens the v2 API's own documentation page (`<address>/docs`).
The v1 buttons are unchanged.
