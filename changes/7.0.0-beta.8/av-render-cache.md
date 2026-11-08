---
title: Audiovisual records load faster and reuse cached media.
type: changed
audience: user
date: 2026-10-29
wc: WC-2026-10-29-posterframe-url-version
---
The audiovisual field no longer downloads its poster image and video again every time a record is shown. Media links now change only when the file itself changes (a new upload, a new transcode or a new poster image), so the browser reuses what it already has. Poster images below the visible part of the page load only when they scroll into view, the quality selector appears only when there is more than one quality to choose, and the player, viewer and search displays load only when they are used.
