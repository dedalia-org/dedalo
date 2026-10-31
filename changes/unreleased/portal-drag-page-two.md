---
title: Dragging a related record on the second page of a portal now moves it where it is dropped.
type: fixed
audience: user
date: 2026-10-31
wc: WC-2026-10-30-section-record-row-box
---
Reordering the records of a portal by drag and drop counted the page twice from the second page on, so a record dragged on page 2 or later was sent to the wrong position (or refused). It now lands exactly where it is dropped, on every page. A drag that is not a portal record — a file, a thesaurus term, a card from a tool — is no longer swallowed by a portal it passes over and reaches the place it was dropped on. When a reorder cannot be confirmed, the message now says so and asks for a reload instead of claiming the new order was not saved. That message, the one for a reorder that was not saved, and the one for a list that changed during the drag are shown in the user's language. A portal no longer highlights a drop place for a record it would refuse, for example a portal whose order is declared in the ontology, so a drop no longer looks accepted and then does nothing.
