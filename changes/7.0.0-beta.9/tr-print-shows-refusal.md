---
title: The transcription print tool shows why it cannot open instead of staying blank.
type: fixed
audience: user
date: 2026-11-10
---
When the server refused the request that resolves a transcription's tags (for example because the
user may not read the transcription field or its section), the print tool waited forever and showed
an empty window. It now shows the error message, with the request reference an administrator can
look up in the server log.
