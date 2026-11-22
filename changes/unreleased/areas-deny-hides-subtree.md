---
title: A denied area now hides everything under it, in the menu and in the profile permissions.
type: changed
audience: admin
date: 2026-11-22
wc: WC-2026-11-22-areas-deny-subtree
---
Denying an area (the `AREAS_DENY` setting, or the area configuration panel in the maintenance
area) used to hide only the denied area itself: what was under it stayed in the profile
permissions, and under a denied top-level area the whole branch stayed listed. Now a denied
area is hidden together with its whole subtree — its child areas and the sections they
hold, at any depth — and the menu and the profile permissions always hide the same things.

With the shipped default (`["dd137","rsc1","hierarchy20"]`) this means the private value lists
(the Yes/No list and its siblings) and the resources base section are no longer offered in the
profile permissions. Grants already saved on them are kept.

The root, administration and maintenance areas can never be hidden: a setting that names one
of them is ignored, so a mistaken value can no longer lock you out of the page where it is
changed.

**Action needed:** none, unless you relied on granting a section that sits under a denied area —
then remove that area from the list. Details:
[What an area denial means](./administration/configuration/administration.md#what-an-area-denial-means).
