---
title: Searching the ontology or a thesaurus no longer stops working until the page is reloaded.
type: fixed
audience: user
date: 2026-11-13
---
One failed search — a server refusal, a network timeout, an error drawing the result tree — left the ontology / thesaurus tree unable to search again, and "Show all" pressed while a search was still running was silently ignored. The tree now recovers on its own and runs the requests in order. In Safari, the browser's local store can drop its connection while the tab is in the background; the application now reconnects instead of failing until a reload.
