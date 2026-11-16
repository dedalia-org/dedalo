---
title: Layout-only panels (`section_group_div`) render again without a header.
type: fixed
audience: user
date: 2026-11-12
---
An edit form group whose ontology model is `section_group_div` is meant to be a
plain layout block. It was shown as a labelled, collapsible panel with a header,
like any other group. It now renders as an unlabelled block again, and its
contents are always shown, even if the panel had been collapsed before this
update. See [section_group](./core/sections/section_group.md).
