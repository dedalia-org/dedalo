---
title: Thesaurus and ontology tree terms are always shown as text; markup typed into a term no longer runs.
type: security
audience: user
date: 2026-11-12
wc: WC-2026-11-12-tree-term-escaped
---
A term in the thesaurus or ontology tree that contains characters such as `<`, `>` or `&` used to be interpreted as HTML by every user who opened the tree, so a term edited to hold markup could run code in their session. The term now displays exactly the characters that were typed. Untranslated terms are still highlighted as before. Values computed by calculation widgets are likewise shown as plain text.
