---
title: A split search in a linking field finds records that match every part.
type: fixed
audience: user
date: 2026-11-06
---
When you type a search split by `|` in a linking field's search box (for example `hierarchy|20`), each part goes to its own search field, and the results now have to match all of them. Before, the operator selector could be set to match any one part, which returned unrelated records. Typing straight into a single search field still uses the operator you selected.
