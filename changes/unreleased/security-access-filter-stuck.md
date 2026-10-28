---
title: The permissions tree filter no longer freezes after several searches.
type: fixed
audience: admin
date: 2026-10-27
---
In a profile's access permissions, typing several searches in a row in the tree filter could leave the page slow and unresponsive, with areas stuck on "Checking...". Each search left background work behind for the areas of the searches it replaced, and that work kept running after the tree had changed. Background work for a replaced search is now dropped, and the per-search scans of the permission list are cached, so the filter stays responsive however many searches you type. The tree now also waits until you pause typing before it updates, instead of redrawing on every keystroke.
