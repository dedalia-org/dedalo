---
title: Zenon search results show author names without the role labels.
type: changed
audience: user
date: 2026-11-13
wc: WC-2026-08-06-external-search-request
---
When you search a Zenon-backed field, the list of results showed the authors as the catalogue
API labels them — `primary: Ripollès Alegre, P. P. (Pere Pau) | corporate: DAI` — role keys
that are not translated and mean nothing to a reader choosing a reference.

The result list now shows the names only, in order: `Ripollès Alegre, P. P. (Pere Pau) - DAI`.
The record itself still shows the authors with their roles, as before.
