---
title: Searching through a field without its own configuration uses the same columns as its list.
type: fixed
audience: user
date: 2026-11-21
---
A relation field whose ontology node carries no request configuration, but has a list
definition under it, now resolves its columns from that list definition in every view except
the edit form — search and Time Machine included. Before, only the list view did; in search
the field fell back to its own relation nodes, so it could search other columns — and
sometimes another section — than the ones its list shows. A section without its own
configuration follows the same rule: in search it resolves the columns of its list definition
(a virtual section, those of its real section).
