---
title: The search panel opens in one smooth step instead of stuttering in.
type: changed
audience: user
date: 2026-10-29
---
Opening the search panel used to show a loading line, then the empty panel, then each saved filter row popping in one by one, pushing the list down each time — most noticeable on slow connections. Now the panel's data loads in parallel, starts loading as soon as the pointer rests on the Search button, and the panel fades in once, complete (a row slower than 1.5 s fills in afterwards). Nothing extra loads with the page, so lists and counters are unaffected.
