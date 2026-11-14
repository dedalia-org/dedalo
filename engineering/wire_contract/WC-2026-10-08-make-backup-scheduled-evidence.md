# WC-2026-10-08-make-backup-scheduled-evidence — make_backup's value says whether a scheduler has ever delivered a dump

- **Date:** 2026-10-08.
- **Decision:** the make_backup widget value gains `last_scheduled_backup`, so
  the panel can say "No scheduler, backups are manual" instead of only showing
  an ageing date.

## Why

The engine schedules no backup (`DEDALO_BACKUP_TIME_RANGE`'s catalog entry):
the nightly job is the operating system's (`deploy/dedalo-backup.timer`, the
compose `backup` service, or the operator's own cron). An install with none of
them showed "38 days old" and nothing else, and the operator read it as
automatic backups that had stopped working.

## Shape before (PHP)

`get_widget_value` for `make_backup`:
`{dedalo_db_management, backup_path, file_name, mysql_db}`.

## Shape after (TS)

The same, plus `last_scheduled_backup: string | null` — the name of the newest
`*.backup` in the backup directory that is a SCHEDULED dump of the configured
database (`<stamp>.<db>.postgresql_<label>.custom.backup`, the naming of
`deploy/dedalo-db-backup.sh`), not a panel one
(`…postgresql_<user>[_forced]_dbv<v>.custom.backup`). `null`: none ever
landed. It is evidence, not configuration: a timer installed but not yet fired
reads null; one that died long ago still reads found (its age is the status
line's job). Another database's dumps never count.

The client renders a `.dd_note.state_warning` above the button on `null`,
linking https://dedalo.dev/docs/v7/administration/backup/#automatic-backup.
Additive: a client that ignores the key behaves as before.

## Gate reconciliation

No parity gate covers this widget value; no fixture is affected, no
re-harvest. The classifier is gated in `test/unit/ops_backup.test.ts`
(`newestScheduledBackupName`).
