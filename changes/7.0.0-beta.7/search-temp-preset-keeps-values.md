---
title: The search panel keeps the values you typed when the page reloads.
type: fixed
audience: user
date: 2026-10-16
---
The search panel saves what you are building as you go, so a reload brings it back. That
automatic save could store only the fields of the search and drop their values: after a
reload the panel showed the right fields, all empty, and the search had to be typed again.
This happened when the panel's working copy carried the *save values* switch set to *No*,
a switch that belongs to named presets and cannot be changed on that working copy.

The automatic save now always keeps the values. The *save values* switch still decides,
as before, whether a named preset you save stores its values or only its fields (a
template).
