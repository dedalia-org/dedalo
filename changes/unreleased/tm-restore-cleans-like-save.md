---
title: Restoring a version from the Time Machine cleans the value like a normal save
type: fixed
audience: user
date: 2026-11-17
wc: WC-2026-11-17-tm-restore-value-gates
---

Restoring an earlier version of a field — or of a whole record — from the **Time Machine** wrote the stored history value back exactly as it was recorded. A version recorded before the engine cleaned that kind of value came back uncleaned: a rich text could return with scripts or event handlers a translation service had produced, and a number could return in a format its field no longer uses.

Now a restore passes the same checks as a normal save. Rich text is cleaned, a number is formatted as its field declares, and a version the engine cannot store safely is refused, leaving the current value unchanged: a number whose field definition is broken, or a password entry that is not stored as a hash (an entry from before passwords were hashed) — such an entry is never turned back into a working password. A version that was already clean restores exactly as before, and the other languages of a translated field are never touched. The history entry itself is not modified: the preview still shows it as it was recorded.
