---
title: The backup panel now says when backups are manual.
type: added
audience: admin
date: 2026-10-08
wc: WC-2026-10-08-make-backup-scheduled-evidence
---
Dédalo never makes database backups on its own: a nightly job installed with the operating system does (see [Backups](./administration/backup.md)). When no scheduled backup of the database has ever reached the backup directory, the *Make backup* panel in Maintenance now shows *No scheduler, backups are manual.*, with a link to the backup documentation. Before, it showed only the age of the newest backup, which looked like automatic backups that had stopped.
