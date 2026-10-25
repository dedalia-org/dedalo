---
title: Turning a list page no longer jumps the layout
type: fixed
audience: user
date: 2026-10-20
---

Every paginated list (section lists, portals, the inspector's *Latest changes*
and *Component history*) replaced its rows instantly, and the new page is often
a different height: a value that took one line on one page takes six on the
next. The block snapped to the new height in one frame, so the page content
below it jumped — on a phone, the whole form under your finger.

The rows container now grows or shrinks over the page turn (200 ms, the same
motion as the rest of the interface), and it is clipped while it does, so no row
paints over the paginator. Users who ask their system for reduced motion get the
instant swap instead. The paginator's own dim is deferred too: a fast page turn
no longer blinks the arrows, and a slow one still fades.
