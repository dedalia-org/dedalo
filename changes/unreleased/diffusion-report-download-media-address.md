---
title: "Publication: the Download button of a file publication's report works when media is served from another address."
type: fixed
audience: admin
date: 2026-11-22
wc: WC-042
---
After a file publication (RDF, XML, JSON…), the report's **Download** button opened the merged
file or the zip at the application's own address. On an installation whose media is served
from another address (`DEDALO_MEDIA_WEB_BASE` set), the download failed. The report now links
the files at the media address, like every other media link the application shows, and the
button opens it as given. The published files are not affected.

**Action needed:** none.
