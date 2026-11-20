---
title: Every conversion of v6 passwords is recorded in the activity log
type: added
audience: admin
date: 2026-11-20
wc: WC-2026-11-19-maintenance-legacy-passwords-widget
---

Converting the passwords of a migrated v6 installation left no trace of who had done it, or to which accounts.

A conversion that writes — **Convert passwords** in the Maintenance area's **Legacy passwords** panel, or `bun run dedalo:migrate-passwords --execute` — now leaves an entry in the Activity section: who ran it (the administrator logged into the panel; for the command line, `root` from host `cli`, with the operating-system account that typed the command), the section ids of the user records converted, and the counts — examined, converted, skipped, not convertible, still remaining. The entry never holds a password, a hash or the two v6 key values. A dry run (**Check**, or the command without `--execute`) converts nothing and leaves no entry. See [Migrate the passwords](./install/migrating_from_v6.md#62-migrate-the-passwords).
