---
title: Videos on some servers no longer show a 2-second duration in the edit view and the versions tool.
type: fixed
audience: user
date: 2026-11-19
wc: WC-2026-11-19-media-url-version-key
---
On servers whose Apache loads the H.264 streaming module, an audiovisual record played only its
first seconds in the record and in *Media versions*, although the file itself was complete. Media
links now carry their version under a key that module does not read, so the whole video plays.
