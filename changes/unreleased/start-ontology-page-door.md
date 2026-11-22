---
title: A link to the Ontology area no longer opens a page that then refuses
type: fixed
audience: admin
date: 2026-11-22
wc: WC-2026-11-22-start-area-page-door
---
The Ontology area opens for the superuser and for global administrators whose profile grants
it. A user who held the grant without being an administrator could still follow a link to it, or
have it as their *Default section*, and got a page that refused everything it tried to load. Such
a link now answers "no access" at once, and such a *Default section* is skipped at login, as for
the Maintenance area.
