---
title: Tools that open in a dialog appear about half a second sooner on slow connections.
type: changed
audience: user
date: 2026-10-29
---
The first time a tool opened in a dialog on a page, its stylesheet only started loading after its code had finished, adding one extra network round trip to the wait. Both now load at the same time, which saves about 0.6 s per first open on a slow connection (measured on Slow 4G: for example 2.96 s → 2.40 s for the posterframe tool). Tools that open in their own window are unchanged.
