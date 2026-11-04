---
title: The root user can now open their own account panel by clicking their name in the header.
type: fixed
audience: admin
date: 2026-11-02
---
Clicking the username in the header opens the account panel (full name, password, email, image and the active field style). For the root user the name was not clickable, so root had no way to change their name, email or interface preferences from inside Dédalo. It now opens for root as for every other user. Root still sees and changes only their own account. Root's image and password are shown but cannot be changed there: a password change asks for no current password, and root has no emailed recovery, so a session left open could lock the real root out for good. In this panel the user name and profile are now read-only for everyone, administrators included; administrators edit them in the Users section.
