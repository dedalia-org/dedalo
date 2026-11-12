---
title: SVG glyphs in text tags now resolve in lists and publications for vector components stored in sub-folders.
type: fixed
audience: user
date: 2026-11-11
breaking: true
wc: WC-2026-11-11-svg-tag-url-full-media-path
---
A text that embeds a vector drawing (an `[svg]` tag, e.g. a countermark or an epigraphy glyph)
showed a broken image in list views and in published pages whenever the drawing's field stores
its files in numbered sub-folders, in a per-record folder, or under a section-specific media
path. The edit view was not affected. The glyph address is now built exactly like the field's
own file address everywhere. Pages published before this update keep the old, broken address:
re-publish the affected sections to refresh them.
