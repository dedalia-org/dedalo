---
title: Searching a number in an autocomplete whose fields include the record id no longer fails.
type: fixed
audience: user
date: 2026-11-26
---
Typing a number into an autocomplete (or any search) that looks in the record id **and**
in text fields at the same time — the id field listed first — answered with a server
error instead of results. The same could happen whenever one search compared the same
value as a number, a date or an id in one field and as text in another. Each field now
compares its own copy of the typed value, so mixed searches return results in any field
order.
