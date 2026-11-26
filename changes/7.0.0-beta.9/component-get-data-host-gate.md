---
title: A portal no longer refuses to refresh when one of its target sections is closed to you.
type: fixed
audience: user
date: 2026-11-09
breaking: false
wc: WC-2026-11-09-component-get-data-host-gate
---
A record you can open shows the rows of its portals, even rows that point into a section you
have no permission to open. Before, refreshing that portal, paging it or saving it answered
"no access", although the same rows were on screen.

The portal's own read is now checked like the record it belongs to: you need access to the
record and to the field. It returns exactly the columns and rows the record shows for that
portal, and nothing more, whatever the request asks for. A request that names any other
section, another record or a search filter is still refused.
