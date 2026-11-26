---
title: Local AI translation no longer reports success when the translation could not be saved
type: fixed
audience: user
date: 2026-11-13
---

With the **Local AI translator** engine (in *Translation* and *Translate all languages*), a translation whose save failed — an expired session, a concurrent edit, a server error — still showed *Translation completed* and was counted as done in the *Translate all* summary, although the text never reached the database.

Now the result is reported only once the save confirms it: a failed save names the reason, the unsaved text stays marked as unsaved on the component, and *Translate all* lists that language as failed. A cancelled run is no longer counted as translated either.
