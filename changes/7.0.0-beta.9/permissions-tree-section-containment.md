---
title: The profile permissions no longer offer fields that are not part of the section.
type: fixed
audience: admin
date: 2026-11-22
wc: WC-2026-11-22-permissions-tree-containment
---
The permissions of a profile listed, inside a section, fields that the section does not show:
fields parked in a layout container under a group, fields under an area or semantic node placed
in the section, and the fields of a section nested inside it. Granting the section also granted
them. The permissions now list exactly the fields that belong to the section — the same ones its
edit form, search and import use — and a nested section is listed without its own fields (it is
granted on its own).

**Action needed:** none.
