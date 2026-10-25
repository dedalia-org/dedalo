---
title: The change history of a password field no longer shows the stored password hash.
type: security
audience: user
date: 2026-10-22
wc: WC-2026-09-30-password-hash-never-served
---
The *Value* column of a record's change history showed, for each past change of a password field,
the stored (encrypted) password itself, to administrators and to any user allowed to read that
field. It now shows the mask `****************`, as the field does everywhere else. Restoring a
past password from the Time Machine is unchanged.
