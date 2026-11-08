---
title: The reconcile panel no longer reports "OK" when it found images it cannot fix.
type: fixed
audience: admin
date: 2026-10-27
---
Running the rich-text images check when the referenced image files are not in the media web folder reported "OK. the two stores agree (drift 0)", as if no old image link existed, and Apply then changed nothing. The message now says how many references are missing, held or failed, and the report lists each one, so the files can be put back in place before the check is run again.
