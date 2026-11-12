---
title: Export and search can pick fields from every section a field points to, not only the first.
type: fixed
audience: user
date: 2026-11-11
breaking: false
wc: WC-2026-11-11-section-elements-target-groups
---
Some fields point to several sections at once. For example, a "Production place" field can point
to every toponymy (Spain, France…) and to an immovables thesaurus with its own fields. When you
opened such a field in the export or search field list, only the first section opened, and the
fields of the others could not be chosen.

The opened column now has a section selector in its header. In Export, sections built on the same
base (all the toponymies) appear as one entry, such as "Thesaurus (12)". A field you pick there
exports its values from every one of those sections in the same column. Sections with their own
fields, such as the immovables thesaurus, have their own entry. In Search, each section is listed
on its own, grouped under its base. When you open the field again, it shows the section you used
last.

An export with such a column no longer stops with an "out of scope" error for users who are not
administrators when some of the linked records are in a section that does not have that field.
