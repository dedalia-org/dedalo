---
title: Turning pages in *Latest changes* no longer fails with a permission error for users who are not administrators.
type: fixed
audience: user
date: 2026-10-23
wc: WC-2026-10-23-own-lock-cleanup-ungated
---
A user allowed to see a section's change history could open the inspector's *Latest changes*,
but moving to the next page of the list answered with a permission error. History lists are
read-only, so they no longer take part in field locking at all, and paging through them works for
every user the profile allows.
