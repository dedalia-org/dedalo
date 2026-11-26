---
title: A Word or OpenDocument file uploaded to a PDF field is no longer published as its PDF.
type: fixed
audience: user
date: 2026-11-11
breaking: false
---
A PDF field keeps the authored document (`.doc`, `.odt`, `.pages`…) and its PDF
version side by side in the original quality, as in v6. Before, uploading only
the authored document copied its bytes into the web PDF, which no viewer could
open; uploading it next to an earlier PDF rebuilt the web copy and covers from
that earlier PDF without saying so.

Now only a PDF feeds the web copy, thumbnail and covers. Uploading an authored
document leaves them as they are, and the upload reports either which PDF still
drives them or that the record has no PDF yet. To update what the record shows,
upload the new PDF.

Records that already received an authored document alone may hold a web file
that is not a PDF: re-upload a PDF of the document to replace it.
