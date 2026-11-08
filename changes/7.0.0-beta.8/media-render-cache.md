---
title: Images, PDFs, SVGs and 3D models load faster and reuse cached files.
type: changed
audience: user
date: 2026-10-29
wc: WC-2026-10-29-posterframe-url-version
---
Every media field now behaves like the audiovisual one: images, PDFs, SVGs and 3D models are no longer downloaded again each time a record is shown. A file's link changes only when the file itself changes (a new upload, a rotation, a regenerated version or a saved drawing layer), so the browser reuses what it already has. Thumbnails in lists and small previews load only when they scroll into view, the image quality selector appears only when there is more than one quality to choose, and the viewer, search and other rarely used displays load only when they are used.
