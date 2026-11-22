---
title: "The References panel no longer opens a column for a section, the exclude marker or the old security field."
type: fixed
audience: admin
date: 2026-11-22
---
A section's list of columns for "records that point here" (its `relation_list`, or the
`relation_list` entry of its section map) may name nodes that are not fields: the section
itself, an `exclude_elements` marker, or the retired security-areas field `dd249`. The
inverse-relations field of a record already skipped them; the References panel and the related
search showed each of them as an empty column. Both now apply the same rule and show only real
fields.

**Action needed:** none.
