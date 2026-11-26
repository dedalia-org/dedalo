---
title: Restoring a version from the Time Machine cleans the value like a normal save
type: fixed
audience: user
date: 2026-11-17
wc: WC-2026-11-17-tm-restore-value-gates
---

Restoring an earlier version of a field — or of a whole record — from the **Time Machine** wrote the stored history value back exactly as it was recorded. A version recorded before the engine cleaned that kind of value came back uncleaned: a rich text could return with scripts or event handlers a translation service had produced, and a number could return in a format its field no longer uses.

Now a restore passes the same checks as a normal save. Rich text is cleaned, a number is formatted as its field declares, and a version the engine cannot store safely is refused, leaving the current value unchanged: a number whose field definition is broken, or a password entry stored as plain text — such an entry is never written back and never turned into a working password, and the message says so and asks for a new password to be set. A password entry from a Dédalo v6 installation (stored encrypted, before passwords were hashed) is put back exactly as recorded, so a user record from before the upgrade can still be restored and its password [converted](./install/migrating_from_v6.md). A version that was already clean restores exactly as before, and the other languages of a translated field are never touched. The history entry itself is not modified: the preview still shows it as it was recorded.
