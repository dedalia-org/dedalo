---
title: A node with two children of one model always resolves to the first by order.
type: fixed
audience: admin
date: 2026-11-21
---
When an ontology node holds two children of the same model — two section maps under one
section, two list definitions under one field — the engine now always uses the first one by
order number (a child with no order number comes last; equal numbers resolve by identifier).
Before, some reads took whichever the database returned first, so the section map or the
list columns in use could change after an ontology update without the ontology having
changed. The same order now decides which field is "the first of its model" inside a
section: the first in form order, where it used to be the lowest identifier.
