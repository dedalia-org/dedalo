---
title: An image's drawing envelope is removed with the record's last file, not with one quality
type: fixed
audience: user
date: 2026-10-23
---
Every image is displayed through a small SVG envelope that wraps the record's
web-quality picture. Removing the record's files never removed that envelope, so
with every quality deleted the editor kept loading a wrapper whose picture was
gone and the browser painted its broken-image icon — in the edit view and in the
media versions panel.

The envelope now follows the record's files, with the same rule the files
themselves follow: it is moved to a `deleted` folder (recoverable, exactly like a
deleted quality file) **only when the record has no file left in any quality** —
no original, no retouched master, no web size, no thumbnail, no alternative
format. Deleting one quality, even the web size, leaves the envelope where it is,
because the record still holds a picture.

A record emptied before this fix keeps its leftover envelope until it is
regenerated: one **Regenerate files** click in the media versions tool clears it,
and the record then shows the normal empty placeholder.
