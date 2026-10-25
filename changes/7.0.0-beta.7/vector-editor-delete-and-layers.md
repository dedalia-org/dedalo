---
title: The image vector editor now deletes shapes and layers reliably
type: fixed
audience: user
date: 2026-10-23
---
Deleting a selected shape with Delete/Backspace did nothing when several shapes
were selected or when focus was on the image-quality selector. Deleting a vector
layer could leave it in the saved drawing, and the raster layer's trash button
could duplicate its contents. Delete now works for single and multiple selections
from the quality selector, the base photograph cannot be deleted by accident, a
deleted layer is removed from the saved drawing, and the raster trash empties the
annotations while keeping the photograph. See
[component_image](./core/components/component_image.md).
