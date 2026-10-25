---
title: Ontology and thesaurus search: the result highlight and the loading state are now in sync.
type: fixed
audience: user
date: 2026-10-17
---

Searching in the Ontology and Thesaurus areas showed a confusing sequence: the
loading state ended before the results were highlighted, so the page looked
finished and only afterwards the matched term popped in and the page scrolled,
sometimes re-centering even when the term was already on screen.

Now the whole sequence is one coherent transition: the loading dim lasts until
the matched terms are highlighted, the page scrolls only when the first match
is out of view (and never shifts sideways without need), a brief pulse marks
the highlighted term even when no scroll happens, and the search panel's Apply
button shows a busy state while the search runs.
