---
title: Graph labels and the thesaurus indexation list show only what the user may read.
type: security
audience: user
date: 2026-11-10
wc: WC-2026-11-10-section-terms-read-door, WC-2026-11-10-indexation-grid-read-door
---
The graph view labels its nodes with each record's display term. That label used to be served to
anyone with read access to the section. It now also requires read access to the component the term
is drawn from and the record inside the user's projects; a node the user may not read keeps its
provisional label, and a short notice says the answer was narrowed.

The thesaurus "show indexations" list quotes a fragment of every transcription that indexes the
term. Each row is now shown only when the user may read the indexing record's section and the text
field the fragment comes from, and the indexing record itself is inside the user's projects. Rows
the user may not read are left out, and the response states how many were withheld. A request that
names a term the user may not read in its list of terms is refused as a whole. Users who already had
those grants see no change.
