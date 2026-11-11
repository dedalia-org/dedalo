---
title: Search-as-you-type in a field that links to many sections answers several times faster.
type: changed
audience: user
date: 2026-11-11
---
When you type into the search of a field that links to many sections — the ontology's
**Connected to**, which searches every ontology section — the server used to redo the same
column and permission work once for every section it searched, so each keystroke took about
a quarter of a second of server time before any result could appear, and slowed the server
for everyone else meanwhile. That work is now done once per search: on an installation with
226 ontology sections a search answers in about a fifth of the time. The results, and who may
see which columns, are exactly as before.
