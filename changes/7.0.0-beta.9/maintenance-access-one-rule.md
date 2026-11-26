---
title: The Maintenance area now needs a profile grant — global administrators and developers with Maintenance at level 2, and the superuser.
type: security
audience: admin
date: 2026-11-22
breaking: true
wc: WC-2026-11-22-maintenance-access-predicate
---
Who could use the Maintenance area depended on where you asked: the menu offered it to
administrators and developers, the panel itself opened for any global administrator whatever
their profile said, and a developer could see an entry that then refused. One rule now opens
every door — the menu entry, the page, and every panel action: the superuser always, plus a
global administrator or a developer whose profile grants the Maintenance area at level 2
(read and write). The role alone no longer opens it, and neither does the grant alone.

**Action needed:** give the profiles of the administrators who use Maintenance the Maintenance
area at level 2 (profile permissions, under Administration). An administrator without it no
longer sees the area. Details:
[Who may use Maintenance](./core/areas/area_maintenance.md).
