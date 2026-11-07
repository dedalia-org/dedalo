# How a code update works

> See also: [Updating code](updating_code.md) · [The update run](index.md#the-update-run)

The panel self-update (`update_code` widget, `src/core/update/code_update.ts`) always performs a **clean, rename-based swap**: the release is downloaded, verified and prepared in a quarantine directory, the current tree is moved aside as a backup, and the new tree becomes the live tree in one rename. There is no in-place "incremental" overlay any more — an overlay could not delete files a release removed, and left nothing to roll back to.

The swap is the `code` phase of an [update run](index.md#the-update-run): the run's preflight, backup and journal come before it, and the release's ontology, schema, data and ancillary phases after it. This page describes what the `code` phase does, what it refuses, and how rollback works — the operator-facing walkthrough is in [Updating code](updating_code.md).

## The phases

The panel shows a phase track while the update runs. The phases, in order:

| Phase | What happens |
|---|---|
| `download` | The release archive is fetched from the configured code server (TLS, size-capped, the URL must be on a configured server). |
| `verify` | The archive's sha256 is checked against the declared checksum, the file is confirmed to be a ZIP, and every archive entry is pre-validated — no absolute paths, no traversal, no symlink entries. |
| `extract` | The archive is extracted into a quarantine directory under the backup root — never over the live tree. |
| `deps` | The release's dependencies are installed **in the quarantine**, with the running Bun, against the release's own lockfile. |
| `preflight` | The quarantine tree is boot-tested once (a smoke boot): it must start, answer a health check, and shut down cleanly. A release that cannot even start never replaces a working one. |
| `swap` | The rollback sentinel is written, the live tree is renamed into the backup directory, and the quarantine tree is renamed into place. `.git` is carried over from the old tree. |
| `restart` | The server restarts itself so the supervisor boots the new code. The run's journal keeps the `code` phase open across the restart; the new code settles it at start and runs the remaining phases. |
| `health` | The **browser** polls the server's health endpoint until the new version answers (or reports a rollback / a server that did not come back). |

Nothing before the `swap` phase touches the live tree: dependencies are installed and the new tree is boot-tested in quarantine first, so any failure up to and including `preflight` leaves the installation exactly as it was.

!!! note "What the smoke boot does — and does not — prove"
    The pre-flight boot proves the new tree parses, starts, and answers one request. It deliberately does **not** run the release's database migrations (the run's `schema` phase applies them after the swap, in the new code), and it says nothing about behaviour under load.

## Preconditions — the update refuses, it does not warn

Before anything is downloaded, the update **refuses** unless all of the following hold:

- the operator is the **superuser** (`root`);
- the server is in **maintenance mode** (see [maintenance status](../maintenance_status.md)) — the version window keeps the Update button disabled without it (with the switch beside it), and the run holds it from its preflight until it ends;
- a **recent database backup** exists (inside `DEDALO_BACKUP_TIME_RANGE`) and is proven restorable — the run records its path, because it is the dump a `NEEDS_DB_RESTORE` names;
- the database is on the data version the running code declares: a pending data update is run first.

The backup requirement is the only one an operator can waive. When the newest backup is stale — or there is none at all — the version modal offers an **Update without a recent database backup** checkbox above the Update button; ticking it puts `waive_backup: true` in the update request, the confirmation restates the waiver, and the server logs it loudly with the requesting user. The checkbox is not rendered when the backup is fresh, since there would be nothing to waive.

Because the waiver exists, the database backup is decided in the version window, not on the readiness panel: the panel never says "Update blocked" for a run the updater will accept with a waiver, and an update submitted **without** the waiver still refuses outright.

The waiver covers the **database** backup only. The code backup is the swap itself — the outgoing tree is renamed aside, not copied — and is never optional.

## What else makes the update refuse

Each of these refuses with a message naming the problem, and changes nothing:

- **Runtime data inside the code tree** — media, state or session files resolving under the install directory would be silently carried into the backup by the swap. The refusal names the offending path and, where one exists, the environment key that moves it (for example `MEDIA_PATH` or `DEDALO_ONTOLOGY_RECOVERY_PATH`).
- **The backup directory inside the code tree** — its own swap would move it. Point `DEDALO_BACKUP_PATH` outside the tree.
- **Unknown entries at the tree root** — any top-level file or directory that the release does not ship and the engine does not account for would vanish into the backup. Move it out (or delete it) first. Operating-system metadata is exempt (`.DS_Store`, `Thumbs.db`, `desktop.ini`): it holds nothing, no release ships it, and a tree browsed from a macOS or Windows file manager grows it again by itself — so it rides into the backup with the old tree instead of refusing the update. Files the *installed* release shipped and the new one no longer does are exempt too: each update records the top-level entries of the release it installs, so on the next update a retired release file (for example `.vscode`, shipped until early October 2026) moves into the backup instead of refusing. An install taken before that record existed refuses once over such a file; remove it by hand that one time.
- **Secret-shaped files under shipped directories** — untracked certificates, keys or `.env*` files nested inside the tree (for example under `deploy/certs/`) refuse for the same reason.
- **A containerised (image) deployment** — when the code tree lives inside a container image, a swap lands in the container's writable layer and is discarded on the next recreation. Such installs update by replacing the image, not through this panel. The shipped image marks itself for this (`/etc/dedalo/image_tree`); a bind-mounted checkout inside a container, or any container that does not bake the code in, is fine.
- **Not enough free disk space** — measured *before the download*, so a full disk costs nothing to discover. The readiness panel applies the same rule in advance (*Enough free disk space*, measured in the background). An update needs room for a second copy of the code tree: the archive, the extracted release, and that release's own freshly installed `node_modules`. The check measures the live tree (minus `.git`, which the swap moves rather than copies) and compares it with the space available where the update stages. If either side cannot be measured the update proceeds — the server log says the check was disarmed.
- **A Bun version mismatch** — the release's `.bun-version` pin must match the running runtime; install the pinned Bun first ([Updating the Bun runtime](../../install/bun_runtime.md)), then retry.
- **No supervisor declared** — the process environment lacks `DEDALO_SUPERVISED=true`, which only the process manager that restarts the server may set; see [Updating code](updating_code.md#panel-self-update).
- **A failed dependency install or a failed smoke boot** of the quarantine tree.
- **A checksum mismatch, a malformed archive, or an unsafe archive entry.**

!!! warning "A disk that fills up during `deps`"
    Before this check existed, a full disk surfaced as a wall of `NoSpaceLeft` / `FileNotFound` extraction errors from the dependency install, several minutes into the update. That failure now names itself ("The disk filled up while installing the release dependencies"), and nothing was swapped — the live tree is untouched. Free space and retry.

    Restore points are the usual culprit: each one keeps a whole previous tree, `node_modules` included. Delete the ones you no longer need from the code backup directory.

## What is backed up

The swap moves the whole previous tree into the code backup directory — `DEDALO_BACKUP_PATH` (default `../backups/code`) — as `dedalo_<previous version>[_<digest>]_<timestamp>/` — the version is the release name the replaced code called itself (`7.0.0-beta.7`, `7.0.0`, `7.0.1-dev`), the digest the first seven characters of the archive it was installed from — including its `node_modules`, so the backed-up tree is bootable offline, with no network and no dependency install. The backup directory must be on the same filesystem as the install so the renames are atomic; the update refuses otherwise.

`../private/` — your configuration and secrets — lives outside the code tree entirely and is never touched.

## Rollback

Before the first rename, the update writes a **rollback sentinel** (`last_code_update.json` in the backup root) with status `pending`, naming the backup directory the swap is about to create. The sentinel flips to `confirmed` only when the run reaches `VERIFIED` after every phase of the release: until then the supervisor's rollback stays armed. When a database phase of a release that is not declared `compatible` starts, the run flips the sentinel to `needs_restore` first, and no supervisor rolls back from then on ([the update run](index.md#when-a-phase-fails)).

- **With the shipped systemd units** (main service, watchdog and rollback units — see the files under `deploy/`), a new tree that fails to come up is rolled back **automatically**: the supervisor restores the previous tree from the backup directory and starts it again. This works because the backup keeps its own `node_modules`. It depends on the root-run scripts: the watchdog and rollback units run `dedalo-ts-watchdog.sh` and `dedalo-code-rollback.sh` from a root-owned directory outside the code tree, because the tree is exactly what is missing or broken when they are needed — `/opt/dedalo/instances/<i>/bin/` on an instance installed by the installer, which places them, and the root bin directory you chose (`/opt/dedalo/bin/` in the example) on a [host set up by hand](../../install/manual_host.md#the-units). The supervisor's moves, like the update's own, stay inside the instance directory that holds the code. A code update does not refresh those copies ([Upgrading](../../install/upgrading.md#per-route)). Without them the watchdog fails with `status=203/EXEC` and nothing rolls back.
- **A run that fails after the swap, within one data model** (`ROLLED_BACK_CODE`), turns `/health` red on the new tree, and the same watchdog and rollback script put the previous tree back. A run that ends in `NEEDS_DB_RESTORE` is never rolled back automatically: a human restores the database backup together with the previous code.
- **Under any other supervisor** (a plain restart loop, pm2, …), there is no automatic rollback. You still have the full previous tree in the backup directory; the manual procedure is to stop the server, move the backup directory back to the install path, and start the server again.

If the swap itself fails midway, the update restores the previous tree in place and reports that nothing changed; in the rare case where the restore also fails, both trees are preserved (the old one in the backup directory, the new one parked in staging) and the panel tells you operator recovery is required — see the server log.

## Restoring a restore point

Rollback as described above is the *supervisor's*, and only for a swap that
never confirmed itself. An update that succeeded and is now to be undone is a
**restore** (`src/core/update/code_restore.ts`), driven from the panel — the
operator walkthrough is in
[Updating code](updating_code.md#restoring-a-previous-code-version).

A restore is the update run backwards, out of the update's own machinery: the
same run lock (a restore and an update can never interleave), the same swap
preconditions, the same sentinel-guarded rename, the same phase frames. It
differs in three ways:

- **It is a move, not a copy.** The restore point is consumed by the swap, and
  the outgoing tree is renamed aside as a new restore point
  (`dedalo_<running release>[_<digest>]_<timestamp>/`). A restore is therefore
  itself undoable, and it does not need room for a second copy of the tree.
- **`download`, `verify`, `extract` and `deps` are reported *skipped*.** There
  is nothing to fetch or install: a restore point carries its own
  `node_modules`.
- **It is a destructive maintenance action, not a run.** It needs the
  superuser, maintenance mode, a fresh proven database backup (the request may
  carry `waive_backup: true`, logged with the user; the restore modal offers no
  such checkbox), no update run in flight, and the update lock
  ([precondition classes](index.md#which-maintenance-actions-need-the-superuser-maintenance-mode-and-a-backup)).
  A version change also needs its own explicit confirmation (below).

### The database is not restored

Restoring code does not revert migrations already applied. A restore point
that holds other code than the running one is **refused** unless the request
carries an explicit confirmation (`confirm_downgrade`, the modal's checkbox),
and the waiver is logged loudly with the requesting user — the same idiom as
`waive_backup`. Other code means another release name (`7.0.0-beta.5` against
a running `7.0.0-beta.7` counts, although both are data version `7.0.0`), or
the same release name installed from another archive (both digests known and
different — two developer builds). The same release from the same archive, or
from an archive that cannot be told apart because one side has no digest, asks
for no confirmation.

Each restore point lists its release name as `version` and the data version
its source declares as `data_version`; the rollback sentinel's `version` and
`previousVersion` are release names too (before 2026-10-30 all three were the
data version).

!!! danger "An acknowledged downgrade is not a repaired one"
    The confirmation only records that the hazard was understood. The
    installation will run the older code against the newer database schema.
    Restoring the matching database backup is a separate operation — see
    [Backup](../backup.md).

### The pre-flight boot, and when there is none

A restore point is a tree nobody has executed since the day it was moved aside,
so it is boot-tested **before** the live tree moves: it is started once in
isolation and must answer a health check, exactly like a release in quarantine.

The check is conditional on the held tree honouring the smoke-boot flag, which
landed on 2026-08-23. A tree cut before that date ignores the flag and would run
its **full** boot — migrations against the shared production database,
schedulers, diffusion runners, watchers, media provisioning — as a second live
instance beside the process still serving. Such a copy is therefore restored
**without** the pre-flight boot: the `preflight` phase is reported *skipped*,
never a passed `done`, and the reason is written to the server log naming the
copy. Refusing instead would make the feature unusable on precisely the
installations that need it, since every restore point in existence predates the
flag.

### What makes a restore refuse

Each of these refuses with a message naming the problem, and changes nothing:

- **Not the superuser, not in maintenance mode, no fresh proven database
  backup, or an update run in flight.**
- **A malformed restore point name** — the request names a restore point, never
  a path. A name carrying `/`, `\`, a `..` segment or a NUL byte, or one that
  does not begin with `dedalo_`, is refused before it is ever joined to a
  directory.
- **An unknown restore point** — the name must be in the listing the panel
  rendered. One that is not there is not a restore point, including one that
  existed on disk and has since gone.
- **The copy is incomplete** — no `package.json` or no `node_modules`:
  restoring it would leave the installation unable to start. The panel already
  disables the button for this.
- **The copy declares no Dédalo version** — its own version file cannot be
  read, so its provenance is unknown. Also disabled in the panel.
- **The copy pins a different Bun** — the swap hands the tree to the *running*
  runtime, and the pre-flight boot uses that same runtime, so a pin mismatch
  cannot be caught later. It is not waivable: install the pinned Bun, restart
  Dédalo onto it, then retry. Also disabled in the panel.
- **A version change without the confirmation** — see above.
- **A secret-shaped file the restored copy does not ship** — the first rename
  carries the *whole* live tree into the new restore point, so a `certs/`
  directory, a `.env.local` or a `deploy/*.pem` absent from the copy being
  restored would land in the backup and the restored tree would come up without
  them. Anywhere in the tree, its root included.

    Note that a restore does **not** apply the update's *unknown entries at the
    tree root* gate ([above](#what-else-makes-the-update-refuse)). That gate
    asks whether the incoming tree ships each of the live tree's root entries,
    which only makes sense while the incoming tree is the newer one. Restoring
    goes the other way: every file a later release added at the root is, by
    definition, missing from an older copy, so the gate would refuse every
    backward restore across such a release — and it is the ordinary case, not
    an error.
- **The backup root inside the code tree, or on another filesystem** — the
  renames must be atomic, as for an update.
- **A leftover staging directory**, or **an update or another restore already
  running** — both share one run lock.
- **A failed pre-flight boot** of the restore point, where one was run.
- **A failed swap** — the previous tree is put back in place and nothing
  changed; if that repair also fails, both trees are preserved and the panel
  reports that operator recovery is required.

!!! warning "One case the rollback sentinel cannot decide"
    The sentinel identifies the restored tree by the digest of the archive the
    restore point was installed from. A copy with no install stamp — a
    development checkout renamed aside by its first update — that also declares
    the version already running leaves the two trees indistinguishable: either
    one would confirm the sentinel at boot. The restore proceeds and writes a
    line to the server log saying so. If such a swap half-applies, do not trust
    a *confirmed* status; compare the trees.

## Confirming the update

After the restart, confirm success by **both** values in the panel's readout changing: the engine **version** and the **build stamp** (the release's commit date — a real per-release value, so an unchanged stamp means old code is still running). The panel then prompts for a reload: the browser still holds the previous client code, and only logging in again loads the new one. If you dismiss the prompt, a persistent "Reload required" note with its own button remains.

For a **developer build** the version cannot change (it is installed over the same version), so the value to watch is **Installed archive** — the digest of the archive that was installed. The rollback sentinel records the same digest, which is how a restarted install proves it is running the new tree and not the restored old one.
