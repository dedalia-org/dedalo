---
title: Deleting an image's last file now clears its vector drawing, so a new upload starts fresh
type: fixed
audience: user
date: 2026-10-23
wc: WC-2026-08-09-image-svg-envelope-preserved
---
Deleting every quality of an image used to remove the rendered SVG overlay but
keep the vector layers in the record; uploading a new image afterwards showed the
old shapes over the new picture. The delete that removes the last file now clears
the stored layers too. The cleared drawing is kept in the Time Machine, so the
previous version can be recovered. See
[component_image](./core/components/component_image.md).
