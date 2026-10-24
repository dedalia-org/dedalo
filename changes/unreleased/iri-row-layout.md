---
title: component_iri edit row lays out on one aligned line
type: fixed
audience: user
date: 2026-10-24
---

The component_iri edit row mixed wrapped widths (30% + 20% + 50% plus the active checkbox forced an overflow) so the label, title and url fields scattered across misaligned lines. The three now share one line with stable proportions when the container is wide, and wrap to neat full-width lines when it is not. The active checkbox also joins the component's hide-at-rest rule: it is only visible on hover, on the active component or on keyboard focus. Checkbox and remove/link icons render inside one flow cluster at the row end (content_actions) that wraps with the row, so the icons no longer overlay the inputs on narrow, wrapped rows.
