---
title: Image quality selector now appears only on hover or on an active component; touch screens keep it visible.
type: changed
audience: user
date: 2026-10-24
breaking: false
---
Before, the quality chip ("1.5MB ▴▾") sat permanently on top of the image in the edit view, overlaying the picture's top-right corner. Now it stays hidden while the component rests: it appears when the pointer is over the component, when the component is active (clicked), or when it takes keyboard focus, and it fades back out.

The chip is still keyboard-reachable (it keeps its place in the tab order, and focusing it reveals it), and at rest it no longer intercepts clicks in that corner of the image. On touch screens — which have no hover — the chip keeps working as before, always visible.

Applies to the edit view of `component_image` only.
