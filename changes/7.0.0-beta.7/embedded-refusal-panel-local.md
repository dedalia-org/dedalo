---
title: A refused side panel no longer takes over the whole page.
type: fixed
audience: user
date: 2026-10-22
---
When a part of the page that a user may not open — for example a history block in the
inspector — was refused, the whole page switched to the "You don't have permission to access
this page" panel and stayed there: every other block showed the same panel and navigating
elsewhere did not recover. The refusal now stays inside the part that was refused, the rest of
the page keeps working, and moving to another section clears a page-level refusal. See
[errors](./core/system/errors.md).
