---
title: An open-ended Id range (5... or ...5) in search no longer returns every record.
type: fixed
audience: user
date: 2026-11-12
wc: WC-2026-11-12-section-id-open-between
---
Searching the Id field with only one side of a range (`5...` or `...5`) ignored the
range and returned the whole section, and inside a combined search the condition
disappeared. The bound you type is now enforced: `5...` no longer returns ids below 5, and `...5`
none above 5. See [component_section_id](./core/components/component_section_id.md).
