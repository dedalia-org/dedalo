# Upgrading

> See also: [Updating code](../management/updates/updating_code.md) · [Production install](production.md) · [Docker](docker.md) · [Troubleshooting](troubleshooting.md) · [Backup](../management/backup.md) · [Migrating a v6 install to v7](migrating_from_v6.md)

How a Dédalo installation moves to a newer release depends on how it was installed. Everything that has to happen to the database happens **inside the server at boot**, whichever way the code arrives. This page covers the code update per route, what is not automatic, boot migrations, retired configuration keys and rollback.

## Before you start

Take the [backups of every store](../management/backup.md). All of them: the matrix database alone is not a backup, and an upgrade is precisely when you find that out. Update the ontology first when the release notes say the code depends on it ([updating ontology](../management/updates/updating_ontology.md)).

## Per route

| Route | How the code is updated |
| --- | --- |
| **Production** | the [code update panel](../management/updates/updating_code.md) in Maintenance, run against the instance's own tree |
| **Docker**, **Trial** | a new image: `./deploy/dedalo-image-update.sh --version <X.Y.Z>` — [Docker › Upgrading](docker.md#upgrading) |
| **Developer** | `git pull`, `bun install`, restart |
| **A host set up by hand** | the code update panel, or by hand — [below](#a-host-set-up-by-hand) |

### Production

The code update panel downloads the release, verifies its checksum, installs its dependencies and boot-tests it in quarantine, then swaps it onto `/home/ded_<i>/dedalo` and exits with code `75` so that systemd starts the new code. The previous tree is kept under `/home/ded_<i>/backups/code`, and the instance's watchdog and rollback units restore it automatically if the new tree never comes up. [How a code update works](../management/updates/updating_code_options.md) has the phases and the rollback contract.

Two things the panel does not do, because it runs as the instance and they belong to root:

- **A release that moves the runtime pin** (`.bun-version`). The panel refuses a release whose pin differs from the running Bun, and the instance's runtime is root-owned at `/opt/dedalo/bun/<pin>/`. The installer has no command that installs a new pin on a live instance today; such a release needs manual work by the system administrator, described in its release notes. [Updating the Bun runtime](bun_runtime.md) is that work, step by step.
- **A release that changes the root-run scripts** (`deploy/*.sh`). Their copies in `/opt/dedalo/instances/<i>/bin/` are not refreshed by a code update, and the installer has no command that refreshes them on a live instance today. The release notes say when a script changed.

Never `bun upgrade` a production runtime: the engine is coupled to version-specific runtime behaviour — JSONB parameter inference above all — and a silent drift there corrupts data rather than slowing things down. The server echoes its runtime at boot and warns loudly when it does not match the pin:

```text
Dédalo TS server starting on Bun 1.4.4 (pinned: 1.4.4)
```

### Developer

```shell
git pull --ff-only
bun install
bun run dev
```

If `.bun-version` changed, install that Bun version first. Rebuild the test database after a schema or seed change (`bun run test:db:setup`).

### A host set up by hand

A host [installed by hand](manual_install.md) — a migrated installation too — can use the code update panel, as long as its service user owns the **instance directory**, the directory that holds the code ([The layout](manual_install.md#the-layout)): the update renames the code tree inside it. When it does not, the panel refuses before it downloads anything (*the service user cannot write the instance directory*).

!!! warning "A host set up by hand before 2026-10-12"
    The manual's earlier layout kept the code directly in a root-owned `/opt/dedalo` (`/opt/dedalo/master_dedalo`), which the service user cannot rename inside. Move it into an instance directory the service user owns, once, with the server stopped: `sudo systemctl stop dedalo-ts dedalo-ts-watchdog.timer`; `sudo install -d -o dedalo -g dedalo -m 0750 /opt/dedalo/app`; `sudo mv /opt/dedalo/master_dedalo /opt/dedalo/private /opt/dedalo/backups /opt/dedalo/app/`; set `DEDALO_BACKUP_DIR`, `DEDALO_BACKUP_PATH` or `DEDALO_PRIVATE_DIR` in `.env` to the new paths if you had set them; then install the root-run scripts and render the units again ([the single-unit set](manual_install.md#the-single-unit-set)) and start the server. The runtime can stay where it is, or move to `/opt/dedalo/bin/bun` with the unit.

Updating by hand is a fetch, a dependency install and a restart, as the service user (the manual's single-instance example paths):

```shell
sudo -u dedalo git -C /opt/dedalo/app/master_dedalo fetch --all --tags
sudo -u dedalo git -C /opt/dedalo/app/master_dedalo checkout <tag-or-sha>
sudo -u dedalo bash -c 'cd /opt/dedalo/app/master_dedalo && /opt/dedalo/bin/bun install --frozen-lockfile --production --ignore-scripts'
sudo systemctl restart dedalo-ts
sudo curl --fail --unix-socket /run/dedalo/dedalo_ts.sock http://localhost/health
```

`--frozen-lockfile` refuses to resolve a dependency tree different from the one that was tested: if it errors, the lockfile and `package.json` disagree — fix that upstream, never drop the flag. Three things are yours on such a host, whichever way the code arrives:

**1. The runtime pin.** Before the new code, compare `.bun-version` (`git diff HEAD..<target-ref> -- .bun-version`). If it moved: on this hand-built layout, install the new runtime into the path the unit names, as root — the one command below; on an installer instance, follow [Updating the Bun runtime](bun_runtime.md), which installs beside the old pin and repoints the unit.

```shell
curl -fsSL https://bun.sh/install | sudo BUN_INSTALL=/opt/dedalo bash -s "bun-v<the new pin>"
/opt/dedalo/bin/bun --version
```

Because `ExecStart` names that absolute path, installing into it *is* the runtime upgrade.

**2. The root-run scripts.** A code update does not refresh the copies in the root bin directory (`/opt/dedalo/bin/`). After an update that changed `deploy/*.sh`:

```shell
cd /opt/dedalo/app/master_dedalo
sudo install -m 0755 deploy/dedalo-code-rollback.sh deploy/dedalo-ts-watchdog.sh \
  deploy/dedalo-backup-step.sh deploy/dedalo-db-backup.sh deploy/dedalo-tree-backup.sh \
  deploy/dedalo-site-builder-backup.sh deploy/dedalo-backup-alert.sh \
  /opt/dedalo/bin/
```

**3. The unit declares supervision.** The unit in `/etc/systemd/system/` is a copy, and no update changes it. A unit installed before 2026-10-08 lacks a line the engine now requires: the code update panel replaces the code only when the process manager declares that it will restart the server.

```shell
systemctl cat dedalo-ts | grep -E 'DEDALO_SUPERVISED|SuccessExitStatus|^Restart='
```

You should see `Environment=DEDALO_SUPERVISED=true`, `SuccessExitStatus=75` and `Restart=always`. If any is missing, add it with a drop-in (`systemctl edit dedalo-ts`):

```ini
[Service]
Environment=DEDALO_SUPERVISED=true
SuccessExitStatus=75
Restart=always
```

Never put `DEDALO_SUPERVISED` in `../private/.env`: that file is read by every launch method, the unsupervised `bun run start` included, so the engine ignores the key there.

## Boot migrations

Read the boot log after every update (`journalctl -u dedalo-ts@<i> -n 50 -o cat` on a production instance).

**Schema migrations are applied at boot.** Ordered SQL files under
`install/db/migrations/` are applied one transaction per file, tracked in a
version table, and are idempotent. You never run a migrate command, and you must
never edit a migration file that has already been applied anywhere.

**The seed is never re-applied.** The restore refuses a non-empty database, and
after the first install the database is not empty. An upgrade cannot silently
reinstall over your data.

!!! note "The boot log is the deploy log"
    Watch for four lines: the runtime pin echo, the core module graph warm-up,
    the migration run, and `listening on unix socket …`. A warm-up failure is a
    **hard boot failure** by design — a visible crash loop beats a silently
    degraded server.

## Retired configuration keys

A **retired** key is not an alias. It configures nothing, and leaving it in place
would silently fall back to the new key's default — the exact silent narrowing
Dédalo refuses to do. So the server **refuses to boot**:

```text
Config key 'DEDALO_PREFIX_TIPOS' is RETIRED: rename that line to
'ACTIVE_ONTOLOGY_TLDS' in ../private/.env. See private/sample.env.
```

| Retired key | Replacement |
| --- | --- |
| `DEDALO_PREFIX_TIPOS` | `ACTIVE_ONTOLOGY_TLDS` |
| `DEDALO_MEDIA_BASE_URL` | `DEDALO_MEDIA_EXPORT_BASE` |

Rename the line. The error names the file and the key, and it is fatal on
purpose: a boot that refuses is a five-minute fix, and a boot that quietly
narrows your active ontologies is a bug report six months later.

!!! note "`../private/.env` is append-only"
    Add a line for a new key, change a value on its existing line, rename a
    retired key — and nothing else: never a second line for a key already there,
    never a deleted line (the [configuration reference](../config/index.md) lists
    the legitimate edits). Every documented key is listed in `install/sample.env` of
    the code you now run, and in the [configuration reference](../config/config.md).
    `../private/sample.env` is the copy taken at install time, so it lacks every key
    added since.

!!! warning "No `ACTIVE_ONTOLOGY_TLDS` in your `.env`? Check `utoponymy` and `nexus`"
    When the key is unset, the engine falls back to the core ontologies:
    `dd, rsc, ontology, ontologytype, hierarchy, lg`. Before the installer chose
    domain ontologies (2026-10), that fallback also carried `utoponymy` and
    `nexus`. Both are ordinary domain ontologies now. If your installation uses
    either and your `.env` has no `ACTIVE_ONTOLOGY_TLDS`, add the key with
    everything you carry, or the ontology update panel stops refreshing them:

    ```dotenv
    ACTIVE_ONTOLOGY_TLDS=["dd","rsc","ontology","ontologytype","hierarchy","lg","oh","utoponymy","nexus"]
    ```

## One-time data update — `section_id` becomes an integer

Installs migrated from v6 **before** the unification step existed store locator
addresses as strings (`"section_id": "7"`); the engine now writes and serves
integers (`"section_id": 7`) and tolerates the old form only during a
transition window. The one-time repair converts the stock:

```shell
# 1. maintenance mode ON, then a fresh backup (the repair writes no undo of its own)

# 2. dry-run — read-only; review the report before anything changes
bun scripts/migrate_section_id_locators.ts --all --user <your dd128 user id>

# 3. apply — converts, re-verifies independently, re-backfills the relation
#    index, and records the section_id_int_normalize marker in matrix_updates
bun scripts/migrate_section_id_locators.ts --all --user <your dd128 user id> --apply

# 4. a repeated dry-run must now report 0 changed rows; maintenance mode OFF
```

What to expect in the dry-run report:

- The **conversion count** is the workload; on a large install it reaches
  millions of values. Convertible means strictly numeric with no leading zero —
  nothing else is ever cast.
- **Findings** are values left alone, by class: external-service remote ids
  (zero-padded or token-shaped — those strings *are* the value), `''` and
  `"null"` junk (deletable only via the explicit
  `--purge-class=empty,null-literal` flag, after you have read the identities),
  and configuration tokens such as `"self"`. Findings are normal; an apply run
  is refused as red only if *convertible* values remain afterwards.

Three deliberate properties of the apply run:

- **It does not touch curation metadata.** No modified-by / modified-date stamp
  moves, and no Time Machine rows are written: a mechanical normalization is
  not an edit, and stamping it would overwrite the real record of who last
  curated each record. Recovery is the backup you took, not an undo trail.
- **`--user` attributes the marker row only** — `matrix_updates` permanently
  records who authorized the sweep. It never appears on any record.
- **It is idempotent.** A re-run converts nothing and changes nothing, so an
  interrupted run is simply run again.

Installs migrated with the current `close_v6_prepare_v7` package need none of
this — the same conversion runs inside the migration itself.

## One-time data update — images inserted into rich text

Since this release, an image inserted from the rich-text editor is named after the record it
is inserted into, so a visitor of a published page can see it exactly while that record is
published. Images inserted before carry their original name and stay visible to logged-in
users only. Two entries of **Maintenance → Reconcile status** bring the old data in line:

| Entry | What a dry run reports | What *Apply* does |
| --- | --- | --- |
| `rich_text_images` | every rich-text image whose file is not named after the record that embeds it, and every referenced file missing from `image/web` | copies the file to a record-named file (one per record that embeds it; the original stays) and points the text at it — a normal save, with a Time Machine entry, so the text is also cleaned as any save cleans it. A text that cannot be saved safely (a non-translatable field holding a language version, or a value with no language) is listed as *held* and left as it is. Root only |
| `web_image_exposure` | files in `image/web` that a visitor can open although the published record their name points at does not use them — typically an old upload whose name happened to end like a record key | renames each one so it is no longer public (`photo_rsc170_45.jpg` → `photo_rsc170_45.legacy.jpg`) and repoints any text that uses it; if some text still uses the old name and cannot be repointed, both names are kept and the file is listed as failed. Root only |

1. Take a backup.
2. Run `rich_text_images` without *Apply* and read the list; missing files are only reported.
   Then apply it.
3. Do the same with `web_image_exposure`. It also runs by itself, as a dry run, every time
   the server starts, so new cases show up in the panel; files less than a day old are held,
   because their text may not have been saved yet.
4. A repeated dry run of each must report 0.

From the command line: `bun scripts/reconcile.ts run rich_text_images` (add `--apply` to
apply). On nginx, reload it once after this update so the new public folder takes effect.

## Verify

```shell
sudo curl --fail --unix-socket /run/dedalo-<i>/dedalo_ts.sock http://localhost/health
```

Then, in the browser: log in, open a record, upload an image, run a search. A green health check proves the process and the database; it does not prove the media toolchain or the web server.

## Rollback

**A failed update** is rolled back automatically on a production instance and on a hand-built host with the shipped units: the rollback unit restores the previous tree from the code backup directory. **A successful update you want to undo** is a restore of a restore point, from the code update panel — [Updating code](../management/updates/updating_code.md#restoring-a-previous-code-version). On a Docker or Trial stack, see [rolling back by hand](docker.md#rolling-back-by-hand). On a host set up by hand you can also check the previous ref out again, reinstall its dependencies and restart.

!!! danger "Migrations are forward-only"
    There are no down-migrations. Rolling the **code** back across a release that added a migration leaves the new schema in place. That is usually harmless (the old code ignores what it does not know about) — but if the migration *changed* something the old code reads, the only correct rollback is **restoring the database backup** you took before the update.

    This is the whole reason the backup comes first.

## What this page is *not* about

Updating the **ontology** and the **data** are in-app operations run from the Maintenance area, not deploy-time steps. They have their own documentation under [Updates](../management/updates/index.md).
