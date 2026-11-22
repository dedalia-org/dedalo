---
title: "lg-nolan can no longer be configured as the working data language."
type: fixed
audience: admin
date: 2026-11-22
---
`lg-nolan` is the slot untranslatable data is stored in, not a language anyone works in. Set as
`DEDALO_DATA_LANG`, it used to become the data language of every new session; now it is
overruled by `DEDALO_DATA_LANG_DEFAULT` and reported at startup, the same way a language the
installation does not declare is. Set as `DEDALO_DATA_LANG_DEFAULT`, the server refuses to start
and names the line to fix.
