# How do I backup and restore the Dédalo data?

> See also: [Backup best practices](backup_best_practises.md) · [Management and maintenance](index.md)

Dédalo manages two databases. The main one is the work system, which holds the full dataset with the ontology and all the data. The second is the publishing system, a copy that holds only the public data. To create a backup, you must back up both systems.

The work-system (PostgreSQL) backup below is TS-native: `src/core/area_maintenance/backup.ts`
spawns the server's own `pg_dump` (version-matched against the running
PostgreSQL server, probing versioned Homebrew installs) into `../private/backups/db`,
behind the "Make Backup" maintenance panel (`make_backup` widget in
`src/core/area_maintenance/widgets/make_backup.ts`). The publishing-system
(MariaDB/MySQL) backup is **out of scope by design**: MariaDB is the diffusion
engine's responsibility, not the work server's, so the panel's MySQL file list
is always empty. Use the manual `mysqldump` steps below for the publishing
system.

!!! warning "The complete backup set"
    The work-system database alone is **not** a backup. The complete set is: the
    matrix database, the vector database (if you enabled semantic search), the
    **media originals**, `../private/` (the secrets and the state), and every
    site-builder instance on the host (if you run the
    [site builder](../tools/using_sitebuilder.md)). The nightly backup units
    cover all five — see [The nightly backup](#the-nightly-backup).

!!! note "Recreating a publication database with work data"
    Publishing system is a copy and is possible recreate it doing a publication in work system. But some times will be necessary a copy because the work system is not ready to publish his data.

## The nightly backup

Every installation that runs under systemd has a nightly backup job; the
compose stacks have their `backup` service ([Docker › Backups](../install/docker.md#backups-from-a-container)).

**An instance installed by the installer** runs, as the instance user,
`dedalo-backup@<i>.service` with its `dedalo-backup@<i>.timer`, writing to the
instance's backup directory (`/home/ded_<i>/backups` by default). With
`--backup-site-builder`, the site-builder store runs as root in its own unit,
`dedalo-backup-site-builder@<i>.service`, with no access to the instance's
`.env`. The install's last step (`host_backup_verify`) ran the set once and
checked that **every** expected store succeeded before it enabled the timer.
Check it at any time:

```shell
systemctl list-timers 'dedalo-backup@*'
cat /home/ded_<i>/backups/state/LAST_OK          # the stores of the last good run
journalctl -u dedalo-backup@<i> -n 50
```

**A host set up by hand** uses the reference units `deploy/dedalo-backup.service`
and `.timer` ([A host set up by hand › The units](../install/manual_host.md#the-units)).
The set runs as the service user; it pulls in `deploy/dedalo-backup-site-builder.service`,
which copies the site-builder store as root, in a unit of its own: it reads no
`EnvironmentFile`, runs its scripts from the root-owned root bin directory, and
writes to `/var/backups/dedalo-site-builder`. A failed run fires
`dedalo-backup-alert@.service`, which runs as the service user.

Each unit declares the stores it promises (`DEDALO_BACKUP_EXPECTED_STORES`), and
a run that leaves one of them without a status fails, so a truncated store list
cannot report success.

## Backup the work system

Work system use PostgreSQL database, doing a backup of this database you will create the full copy of your data.

You can perform a backup in different ways:

### Automatic backup

You can change the backup configuration — directory, cadence and other parameters — by editing Dédalo's [backup](../config/config.md#backup-variables) settings in `../private/.env`.

!!! warning "Gap: no automatic trigger on save"
    `initBackupSequence()` (`src/core/area_maintenance/backup.ts`) implements
    the throttle window (an 8-hour minimum between non-forced dumps, per
    `DEDALO_BACKUP_TIME_RANGE`) and a stable file-naming scheme, but nothing in
    the save/write path calls it automatically yet — it only runs when the
    "Make backup" button (or its API action) is invoked. Until this is wired
    in, treat backups as **manual/cron only** (see below).

### Manual backup

But in some times you will need do a backup manually to fix a specific point. It can be useful to update major version or change the server.

To create a full copy of Dédalo work system manually, follow this:

1. Login as global administrator or root account
2. Enter into Maintenance panel:

    > System administration -> Maintenance

3. Locate the "Make Backup" panel
4. Press the "Make backup" button.
5. Wait to be finished.

The panel will indicate the directory of the copy, it will be storage into bk directory in the server and it will be named with the date, name of the database, as:

> 2023-09-09_205044.my_dedalo_db.postgresql_1_forced_dbv6-0-0.backup

The file lands in `../private/backups/db` (`getBackupDir()` in
`src/core/area_maintenance/backup.ts`), and the name carries a `.custom.`
infix before the extension (custom `pg_dump -F c` format, e.g.
`2026-07-04_205044.my_dedalo_db.postgresql_-1_forced_dbv7-0-0.custom.backup`)
— otherwise the naming follows `<date>.<db>.postgresql_<user>[_forced]_dbv<version>`.
The user-id segment is always `-1` (superuser), since the maintenance panel is
a global-admin/root-only surface.

### Making a manual backup in the server shell

If you want create a backup using the server shell, you can easily backup full Dédalo data using the following command.

```shell
pg_dump -h /tmp -p 5432 -U "dedalo_database_user" -F c -b dedalo_database_name  > "../dedalo_backup_database.backup"
```

You can see `pg_dump` official documentation [here](https://www.postgresql.org/docs/current/app-pgdump.html).

## Restore a backup for the work system

A restore is a procedure the engine owns. Do not run `pg_restore` by hand
against a live database: `pg_restore` continues past errors by default, so a
run whose copy of one table failed leaves that table's OLD rows beside restored
neighbours, and nothing you can see distinguishes it from a successful restore.
The engine's restore door does the whole procedure in the right order, refuses
at the first thing that is wrong, and leaves your database exactly as it was
whenever it refuses.

You need shell access to the server with administration privileges, and the
database user Dédalo connects with needs the `CREATEDB` privilege (the door
builds the restored database beside the current one and swaps them by name):

```sql
ALTER ROLE dedalo_database_user CREATEDB;
```

The commands below name an instance `<i>` installed by the installer; on a host
set up by hand, use its unit `dedalo-ts`, its code `<instance directory>/master_dedalo`
and its runtime `<root bin directory>/bun` ([The layout](../install/manual_host.md#the-layout)).

1. Stop the engine, and the watchdog timer that would restart it:

    ```shell
    systemctl stop dedalo-ts@<i>.service dedalo-ts-watchdog@<i>.timer
    ```

    The door refuses while anything is still connected to the database — it
    tells you which connection, by process id.

2. Run the door with the backup file:

    ```shell
    cd /home/ded_<i>/dedalo
    sudo -u ded_<i> /opt/dedalo/bun/<pin>/bun scripts/restore.ts /home/ded_<i>/backups/db/2026-08-29_033000.dedalo_<i>.custom.backup
    ```

    What it does, in order: it reads the WHOLE file to prove it is a complete
    dump (a file cut short by a failed backup passes every cheaper check);
    checks that nothing is connected; restores into a new, empty database in
    one transaction that either lands completely or not at all; renames your
    current database to `<name>_pre_restore_<stamp>` and the restored one to
    `<name>`; runs the reconcile checks a restore needs (the media counters are
    repaired, the rest are reported); writes a report to
    `<backups>/restores/<stamp>.json`; and switches maintenance mode on so an
    engine started early lets only superusers in.

    Exit status `0` means restored with nothing left to decide; `2` means
    restored, and the report lists checks HELD for your decision (the
    `reconcile` panel in the maintenance area, or `bun scripts/reconcile.ts`);
    `1` means it refused or failed — and your database is untouched.

3. Restore the media files from a backup generation older than the problem
   (see below), rebuild the derivatives with the *update cache* tool, and start
   the engine again. Switch maintenance mode off from the maintenance area once
   you have read the report.

4. When the restored system is accepted, drop the previous copy — it is a full
   second database on the same disk:

    ```sql
    DROP DATABASE my_dedalo_db_pre_restore_20260829_033000;
    ```

    (or pass `--drop-previous` to the door to skip keeping it).

To restore into a database with a different name — for a rehearsal, or a fresh
server — pass `--database other_name`; when that database does not exist yet
the door simply creates it, and nothing is renamed. This is a REHEARSAL, and
the door treats it as one: it verifies, restores and swaps, but it does not
run the reconcile checks and does not switch maintenance mode on — both belong
to the database in your `.env`, the one the running engine serves, so a
rehearsal is safe while the engine is up. Its verdict is the record count in
`other_name`, which you read yourself; drop that database when you are done.
Rehearse a restore quarterly this way: a backup that has never been restored
is a hypothesis.

## Backup of media files

Media files are the most large data to be backup, usually it will be a large list of image, audiovisual, pdf, and other documents. If your Dédalo project has large audiovisual files, or thousands or millions image files, you will expect a server with large storage (TBs instead GBs) and your backup storage need to be set to retain almost 3 copies of the media files.

The [nightly backup](#the-nightly-backup) (or the `backup` service of the
compose stacks) already copies the media originals as
dated generations: each night's copy is a directory named by its timestamp in
which unchanged files are hard links into the previous night's, so fourteen
generations cost little more disk than one, and a file deleted by mistake is
still in every generation older than the mistake. The number kept is the
`--keep` value of the job. To restore, copy the generation you want back over
the media directory — never the newest one if the newest one already contains
the mistake.

If you write your own script instead, keep the same rule: never a single
mirror that deletes on the destination what was deleted at the source (`rsync
--delete` into one directory is ONE copy, and it follows the mistake). Use
dated `rsync --link-dest` generations, or filesystem snapshots.

### Creating an incremental script for media files

You can use rsync with a cron or other backup solution to create a incremental script.

```shell
rsync -avzui --human-readable --links --progress --log-file="../my_backup_scrip_log$(date +%Y%m%d%H%M%S).log" -e "ssh -p 33333" "../dedalo/media" my_user@my_backup_sever.dedalo.dev:/backup/my_host/daily
```

!!! note "ssh access to backup host"
    If you want to run the script automatically, maybe you will need to create a ssh keys access to backup system to log it directly without password. You can set it following this [instructions](https://help.ubuntu.com/community/SSH/OpenSSH/Keys) or [this](https://www.digitalocean.com/community/tutorials/how-to-set-up-ssh-keys-on-rocky-linux-8).

And you can create a con job to execute it as:

```cron
00 01 * * * ../dd_backup_rsync/my_backup_daily.sh
```

You can read about rsync [here](https://rsync.samba.org)

You can add more scripts to create a weekly or monthly backups in the same way.

## Backup the publishing system

The publishing system uses the MariaDB/MySQL database. By backing up this database, you will create a copy of the data that was published, a copy of the public data.

!!! warning "Gap: no publishing-system backup button"
    MariaDB is the diffusion **engine's** database, not the work server's —
    the maintenance panel's `get_dedalo_backup_files` action always reports an
    empty `mysql_backup_files` list, and there is no "Make a publishing backup"
    action registered (`make_backup` in
    `src/core/area_maintenance/widgets/make_backup.ts` only implements
    `make_psql_backup`/`get_dedalo_backup_files`). Use the manual `mysqldump`
    steps below.

### Manual backup

To create a full copy of Dédalo publishing system manually, follow this:

1. Login as global administrator or root account
2. Enter into Maintenance panel:

    > System administration -> Maintenance

3. Locate the "Make Backup" panel
4. Press the "Make a publishing backup" button.
5. Wait to be finished.

The panel will indicate the directory of the copy, it will be storage into bk directory in the server and it will be named with the date, name of the database, as:

> 2023-09-09_205044.mysql_dump_my_publishing_database.sql

### Making a manual backup in the server shell

 The simplest way to make a full copy of the MariaDB/MySQL database is to run the mysqldump command with this set of parameters:

```shell
mysqldump -u publishing_bd_user_name -p -v my_publishing_database > mysql_dump_my_publishing_database.sql
```

!!! note "Using MariaDB"
    If you are using a MariaBD > 11.0, you will need to use `mariadb-dump` instead `mysqldump`

Optional: if you want to compress the backup:

```shell
tar zcf mysql_dump_my_publishing_database-$(date +%Y-%m-%d-%H.%M.%S).sql.tar.gz mysql_dump_my_publishing_database.sql
```

## Restore a backup of publishing system

You can use Adminer or other database tools to import the file that you previously created, or restore the DB backup by running the following command:

```shell
mysql -u publishing_bd_user_name -p -v  mysql_dump_my_publishing_database < mysql_dump_my_publishing_database.sql
```

## Backup of site-builder instances

If you run the [site builder](../tools/using_sitebuilder.md), each of its
instances on the host is part of the backup set: its declaration and secrets,
its workspaces and each site's webspace. The store runs as root in its own unit
(`dedalo-backup-site-builder@<i>.service` on an installer instance, asked for
with `--backup-site-builder`; `deploy/dedalo-backup-site-builder.service` on a
host set up by hand), never beside an instance's `.env`; on a host with no
site-builder instance it copies nothing. The destination holds root-owned
secrets, so treat it like the `../private/` copy. A host running several Dédalo
instances backs the site-builder instances up from **one** instance only, since
the store covers the whole host (see [several instances](../install/multi_instance.md)).

## Backup a Dédalo config files

Config files store your environment, database configuration access, API access and other important information. Backup the config files ensure you that this information will be preserved in case of server failure, and it that could be necessary to restore a backup because the password encryption system need a keys stored into the config files.

The most important situations will happen in  case you lose the configuration files could be:

- you can loose the access to the database user, and will need use a pw reset in postgreSQL or MariaDB
- you will need to rebuild all Dédalo passwords
  
Both situations are reversible but are not simple processes.

Configuration files do not change every day and usually only change when new features are required or some changes are set into the work system, so it's not mandatory to create a daily backup, but it's high recommendable create a script to automate the backup process. We recommended a monthly backup of the config files.

For transfer the files to the backup server consider compress the files in this way:

```shell
tar cvfz dedalo_configuration.tar.gz ../dedalo/config
```

Dédalo keeps its per-install configuration and secrets outside the code tree
entirely, in `../private/` (a sibling of the install tree — see the
`check_config` widget's `computeCheckConfig`, in
`src/core/area_maintenance/widgets/check_config.ts`, which reports these exact
sources): `.env` (credentials/config), `ts_state.json` (maintenance mode,
notification and menu overrides) and the sessions database.
Back these up together, e.g. `tar cvfz dedalo_configuration.tar.gz ../private`.
