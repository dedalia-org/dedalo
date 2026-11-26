---
title: Search filter chips past the first page show their labels.
type: fixed
audience: user
date: 2026-11-21
wc: WC-2026-11-21-resolve-data-injected-value-bound
---
A relation field used as a search filter resolved the label of only its first page of chosen
records (ten, or the field's own page size): the eleventh chip, and every chip on a later page,
appeared empty. Every chosen record now resolves, whatever the page size.

For API consumers: `resolve_data` no longer applies `sqo.limit` / `sqo.offset` to the injected
`source.value` — they are echoed in `pagination` — and a `source.value` of more than 1000
locators is refused (`request.invalid_source`).
