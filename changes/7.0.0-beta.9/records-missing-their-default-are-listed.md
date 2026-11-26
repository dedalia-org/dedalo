---
title: Maintenance lists the records that lack a field's default value; the manual states when a default is written.
type: added
audience: admin
date: 2026-11-21
wc: WC-2026-08-09-record-birth-defaults
---
A field's default value (`dato_default` in the ontology) is written when a record is
**created**, and only then. Version 6 also wrote it the first time an existing record was opened
in the edit form; version 7 does not — reading a record never changes it. So records created in
version 6 that were never opened, and records that existed before a default was added to their
section, keep that field empty. The manual said the edit form applied the default; it now says
what happens ([Ontology authoring](./core/ontology/authoring.md#dato_default--a-default-is-written-when-the-record-is-created)).

**Maintenance → Reconcile** has a new check, `record_missing_defaults`, that lists those records
per section and field (how many, and the first record numbers). It only reports — it never
writes. To fill the records you choose, filter the section to them and use
[Propagate component data](./using/tools/using_propagate_component_data.md).
