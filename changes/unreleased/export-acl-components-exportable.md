---
title: Permission matrices and record filters can be exported.
type: added
audience: admin
date: 2026-11-13
wc: WC-2026-11-13-export-acl-components-exportable
---
The permission matrix of a profile and the record filter of a user exported an empty cell. They
now export like any other component: each stored item as JSON in the value and grid value
formats, under the same permission as every other column — a user without read access to the
component is refused the column. This is how a profile's permissions travel between two
installations through an export.
