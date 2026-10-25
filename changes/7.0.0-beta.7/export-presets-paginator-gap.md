---
title: Tool Export — the presets panel no longer shows a blank band between its header and the presets.
type: fixed
audience: user
date: 2026-10-18
breaking: false
---
The Export tool's presets panel kept an empty pagination block (39px of blank
space) between the "Export presets" header and the first row, and between the
header and the "no presets" message on an empty list. The collapsed paginator
now takes no space; a preset list long enough to paginate still renders its
pagination.
