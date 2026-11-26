---
title: Uploading a PDF fills its transcription field again, and the OCR option works.
type: fixed
audience: user
date: 2026-11-11
breaking: false
wc: WC-2026-11-11-pdf-transcription-restored
---
Since the move to the version 7 engine, uploading a PDF built its web copy and cover but
left the related transcription field (for example the text beside a document's PDF in
Resources) empty, so the document's text could not be searched. Ticking **OCR** in the
upload panel did nothing.

Now an uploaded PDF fills its transcription field with the PDF's text, one page marker per
page, in the language you are working in. If that field already had text in that language,
it is replaced and the upload tells you so; the previous text stays in the record's history
(Time Machine). A scanned PDF with no text layer writes nothing and says so.

With **OCR** ticked, the text is recognised in the background in the language you pick and
written into the web copy of the PDF; the original file you uploaded is never modified. The
transcription is filled when recognition finishes. The panel only offers OCR, and only the
languages, this server can actually recognise.

**Update cache** and the media versions panel now fill a transcription only when it is
empty; they never replace text you have corrected, and a bulk revert undoes what they
filled.

**Action for administrators:** PDFs uploaded since the version 7 engine was installed have
empty transcriptions. To fill them, run **Update cache** on the PDF field of each section
that holds PDFs; only empty transcriptions are filled. Nothing is done automatically. The
installer now installs the OCR language packs for your working languages; on an existing
server install them yourself (Debian/Ubuntu `tesseract-ocr-<language>`, RHEL family
`tesseract-langpack-<language>`, plus the `osd` pack).
