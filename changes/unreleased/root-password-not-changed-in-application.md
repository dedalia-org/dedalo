---
title: The `root` password can no longer be changed from inside the application
type: security
audience: admin
date: 2026-11-21
wc: WC-2026-11-21-root-password-write-refused
---

Until now `root` could type a new password for its own account in the application, like any other user. A session is not proof of the person: an unattended `root` session, or a tool running as `root`, could replace the installation's most privileged password without knowing the current one.

Now no part of the application writes that password — not the user form, not an import, not a tool, not a Time Machine restore of the `root` record — whoever is logged in, `root` included. The attempt is refused with a message and nothing is changed. `root` still edits its own name, email and image. The password is changed with the manual procedure, which needs access to the server and the database: see [Changing the root password](./administration/users_and_permissions.md#changing-the-root-password). Nothing changes for any other account, the conversion of v6 passwords converts `root`'s too as before, and there is nothing to do on update.
