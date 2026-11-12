# Backup best practices

> See also: [Backup and restore](backup.md) · [Management and maintenance](index.md)

Before you begin using Dédalo in production, you should set up a backup host, schedule
automated backups, and develop a recovery plan as part of an overall backup strategy.

## Backup requirements and recommendations

The most important data to backup is the work system. It has the full data and media files to be preserved.
The publishing system should also be backed up, but as this part is a copy of the working system data that may be public, a backup is not mandatory, but highly recommended.

Your backup plan has to be focused on:

- backup databases
- backup media files
- backup configuration files

### Secondary host for backup

We recommend that the backup host and your Dédalo instance be geographically distant from each other. This ensures that backups are available for recovery in the face of major disaster or network outage at the primary site.

Storage space for the backup host: ~5x the size of the uncompressed Dédalo installation. Example: If you expect that your media files will require a 1TB, your backup host will need 5TB.

Backing up media files requires the most space, so calculate the size of your media files when configuring the backup space. We recommend keeping about 3 full copies of your media files and creating an incremental script for daily changes.

Use a RAID system for your backup; we recommend RAID 5 or RAID 6. RAID 5 is designed to survive 1 failed hard drive at a time, RAID 6 to survive 2. If your backup is large storage with many hard drives, RAID 6 may be necessary.

### What to backup and how often

priority | What? | How often? | Backup retention |  How to backup?
---| --- | --- | --- | ---
mandatory | Work system database containing all of Dédalo data - postgreSQL | daily backup (full) | Keep last 30 days. Keep last 12 months, keep every year copy | see how to make a [full work system database backup](backup.md#backup-the-work-system)
mandatory | Media files | daily (incremental) | keep daily, keep weekly, keep monthly| create a rsync or similar [scrip to create an incremental backup](backup.md#creating-an-incremental-script-for-media-files)
high | Publishing system database containing public data - MariaDB/MySQL  | monthly backup(full) | Keep for 30 days | see how to make a [full publishing system database backup](backup.md#backup-the-publishing-system)
medium | All config Dédalo files | daily backup | Keep for 30 days | [Create an archive of Dédalo config](backup.md#backup-a-dédalo-config-files) files and copy to backup server
low | Dédalo codebase | monthly backup | Keep for 1 month | create an archive of Dédalo site files and copy to backup server, it is not mandatory because Dédalo code is possible to install again
medium | log files (reverse proxy access logs, the Dédalo server's own process output, PostgreSQL logs, MariaDB/MySQL logs, etc.) | daily backup | Keep for 6-24 months | Copy any new log files to the backup server. Log files are listed in the Logging section.
