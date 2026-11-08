---
title: Thesaurus/ontology tree — a term dropped onto a closed term no longer hides that term's other children, and reordering works after showing non-descriptors.
type: fixed
audience: user
date: 2026-11-03
breaking: false
---
Two more tree refreshes left a node's children list out of step with what it showed (the same
family as the Duplicate fix):

- **Drag-drop onto a closed, never-opened term**: the term then showed only the dropped child —
  its existing children never loaded, even when opened, and the dropped child got order 1.
  The target now loads its real children from the server after the move.
- **Showing non-descriptors on a closed term** loaded and drew its children without keeping
  the list, so reordering any of them failed with
  `[ts_object.save_order] Self not found in parent's children data`. The list is now kept.
