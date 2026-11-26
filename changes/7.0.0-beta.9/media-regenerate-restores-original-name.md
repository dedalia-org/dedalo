---
title: Regenerating a media file now restores its original file name the same way from both tools.
type: fixed
audience: user
date: 2026-11-13
wc: WC-2026-11-12-media-provenance-repair-one-kernel
---
When a media record had lost its original file name, **Regenerate files** in Media versions did not restore it from the record's "Original file name" field, while **Update cache** did, but on the wrong language's file for translatable media and with the extension in upper case. Both tools now restore it the same way: on the file of the language you are working in, with the stored normalized name in lower case, and only when the name is missing — a name already recorded is never replaced.
