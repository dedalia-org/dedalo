# Updating Dédalo

> See also: [Update code](updating_code.md) · [Update ontology](updating_ontology.md) · [Update data](updating_data.md) · [How a code update works](updating_code_options.md)

Dédalo is a free, open-source project and community where the ability to innovate often is key. All code is developed under free and open-source rules.

An installation is updated by **one ordered procedure, the update run**. Code, ontology, database schema, data and the derived surfaces (tools, search stores, media rules) are not separate processes that you run in the right order by hand: they are **phases** of one journaled run, and the run executes them in the order each release declares. This page describes the run. The other pages describe the panels that start it and what each phase does:

1. [Update code](updating_code.md) — the **Update code** panel starts a full run: the code swap and every phase of the release after it.
2. [Update ontology](updating_ontology.md) — the **Update ontology** panel starts an *ontology-only* run: one ontology phase, no code swap, no restart.
3. [Update data](updating_data.md) — the data phase of a run, and the **Update data** panel for an installation whose database is behind its code (for example after a manual `git pull`, which is not a run).

An installation that SERVES updates to others has its own panels for that side: **Serve Ontology** (an ontology master) and **Serve Code** (a code server).

## The update run

### What a release declares

Every release is an entry in `install/update/catalog.json`, shipped with the code. The entry says whether the release keeps the data model (`compat`) and which phases it runs (`steps`). A code server publishes these entries with its release list, so an installation plans a run from the code server's answer, not from its own (older) catalog.

A release that declares no steps runs the default order:

`code` → `ontology` → `schema` → `ancillary`

A `data` phase runs only for a release that declares one, at the place in `steps` where the release puts it. A release may also declare an `ontology` step with a minimum version (`min`) before its `code` step: the run executes such a precondition **before** the code swap. An `ontology` step without `min` runs after the code swap; a release declares at most one of each. Every other step (`schema`, `data`, `ancillary`) comes after `code`; a catalog that declares one before it is refused.

A run walks every catalog release between the installed version and the target, with **one** code swap (the target's): first every ontology precondition, then the code, then each release's remaining phases in release order. The code door accepts only the next version (see [Updating code](updating_code.md)), so a run normally covers one release.

### The ancillary phase

The `ancillary` phase reconciles every derived surface an update may have made stale, in this order:

- `tools` — the tool registry, re-imported from each tool's `register.json`; the active/inactive choice an administrator made for each tool is kept;
- `observer_mirrors` — the mirrored values that observer components keep, only when an `ontology` or `data` phase of this run finished;
- `search_stores` — the search stores: missing structures created, and a populated store re-derived when the release changed how it is derived;
- `media_rules` — the generated web-server rule files for media access, rewritten when their configuration changed.

The first reconciler that fails stops the list and fails the phase.

### What the run holds while it runs

- **The superuser.** The run's preflight refuses any other user.
- **Maintenance mode.** The run switches it on before its backup and holds it until the run ends. When the run ends on its own terms it puts maintenance mode back as you had it; when a human has to act, it leaves it on (the table below).
- **A database backup, or a waiver.** The run needs the newest database dump to be fresh (inside `DEDALO_BACKUP_TIME_RANGE`) and proven restorable. Its path is recorded in the journal: it is the dump a database restore would use. The panels offer **Update without a recent database backup**; the waiver is recorded in the journal with your user.
- **The update lock.** No second run, and no destructive maintenance action (below), can start while a run is in flight.

The journal is `<private>/update/runs/<run_id>.json`, outside the code tree and the database. Every phase is written to it before and after it runs.

### States

A run moves through the states of its own phases, in order. The terminal states end the run; a new run can start only when the newest run is in one of them.

| State | Ends the run | Maintenance mode |
| --- | --- | --- |
| `PLANNED` | no | as you had it |
| `PREFLIGHT_OK` | no | on |
| `BACKED_UP` | no | on |
| `CODE_SWAPPED` | no | on |
| `ONTOLOGY_APPLIED` | no | on |
| `SCHEMA_APPLIED` | no | on |
| `DATA_APPLIED` | no | on |
| `ANCILLARY_APPLIED` | no | on |
| `VERIFIED` | no | on |
| `CONFIRMED` | yes | restored |
| `REFUSED` | yes | unchanged |
| `FAILED_PRE_SWAP` | yes | restored |
| `ROLLED_BACK_CODE` | yes | restored |
| `NEEDS_DB_RESTORE` | yes | on |
| `MANUAL` | yes | left as it is |
| `ABANDONED` | yes | left as it is |

*Restored* means maintenance mode is put back as you had it before the run (it stays on if it was on); *unchanged* means the run never switched it. A run is `CONFIRMED` only after `VERIFIED`, and `VERIFIED` is reached on evidence, not on "the server answered". The run's post-verification checks:

- `schema_clean` — no boot migration pending, and every applied migration matches its recorded hash;
- `data_version` — the database is on the target release's data version;
- `data_model` — that data version is on the target's data model.

### When a phase fails

What happens depends on where the run stands and on what the release declared:

| Failure | Run ends in |
| --- | --- |
| before the code swap | `FAILED_PRE_SWAP` |
| after the swap, only phases of `compatible` releases ran on the database | `ROLLED_BACK_CODE` |
| after the swap, a database phase of an `incompatible` release ran | `NEEDS_DB_RESTORE` |
| after the swap, a database phase of a release that declares no `compat` ran | `NEEDS_DB_RESTORE` |

The database phases are `ontology`, `schema` and `data`. A phase counts as soon as it has started: a failed migration file rolls back, but the files before it in the same phase are committed.

- **Automatic rollback stays within one data model.** On `ROLLED_BACK_CODE` the previous code still fits the database. The run puts maintenance mode back as you had it, marks the new tree red in `/health`, and the supervisor's watchdog and rollback script put the previous tree back.
- **Across a data model, a human restores.** On `NEEDS_DB_RESTORE` the previous code no longer fits the database, so nothing rolls back on its own: the rollback sentinel is marked so that no supervisor acts, and maintenance mode stays on. The journal names the run's backup, the instant after which writes are lost, and the steps: restore the database from that dump, restore the code restore point of the previous release, close the run (`bun run update abort <note>`), and only then leave maintenance mode. Until the run is closed, no new update run starts. A run that took no backup (a waiver) says so; choosing an older dump is your decision, with a larger loss.

!!! warning "A release with database phases and no `compat` is treated as crossing the data model"
    The default steps include the `ontology` and `schema` phases, and a release that declares no steps declares no `compat` either. Once such a release's `ontology` phase has started after the swap, a failure — of that phase or a later one — ends in `NEEDS_DB_RESTORE`, not in an automatic rollback. The `ontology` phase fails when a configured source fails, so check the ontology sources before a code update. With no ontology source configured at all (no `ONTOLOGY_SERVERS` entry, and the installation is not an ontology master), such a release's default `ontology` step is skipped and the skip is recorded in the journal. A declared `ontology` step, and *Update ontology*, still fail without a source.

### Resume on start

A run whose process goes away — the planned restart of the code swap, a crash, a power cut — is resumed from its journal when the server starts again:

- The phase that was running is run again: every phase other than the code swap is safe to repeat.
- The code swap's outcome is read from the tree that booted. If the run's target is running, the run continues. If the previous tree is running (the swap did not land, or the supervisor already put it back), the run ends in `FAILED_PRE_SWAP`.
- A run that stopped before its backup (`PLANNED`, `PREFLIGHT_OK`) changed nothing; it ends (`REFUSED`, `FAILED_PRE_SWAP`) and you start again.
- An unreadable journal resumes nothing and blocks every new run until a human looks at it.
- If another process still holds the update lock when the server starts (a session the database has not yet noticed is dead), the server keeps trying every 30 seconds for two hours before it leaves the run to the next start.
- If a running server loses the update lock (its database connection was cut), the run stops before its next phase and stays in flight; the next start resumes it.
- A `data` phase that is resumed after its change was already committed finds the database at the release's data version and does not run the change again.

A run whose code phase has started owns the new tree's start: the new code starts in maintenance mode with its schema pending, and each release's `schema` phase applies that release's migrations (and any earlier ones still pending), never a later release's. A run whose releases declare no `schema` phase after the code swap — a developer build, or a prerelease to its release — ends with one `schema` phase for the target, so a migration such a build adds is applied.

### The command line

From a terminal in the code tree:

| Command | What it does |
| --- | --- |
| `bun run update status` | The run in flight, or the newest run, and its phases. Reads the journals only, so it works while the server is down. |
| `bun run update check` | Whether the code can be rolled back automatically (the same answer the rollback script gets). |
| `bun run update plan <release>` | A dry run: the phases a run to that release would execute, planned from the first configured code server's release list. No lock, no write. |
| `bun run update abort [note]` | End the run in flight by your decision: `ABANDONED` before the code swap, `MANUAL` after it. Refused while the code phase is running (the swap may have landed — let the next start settle it), and while any process holds the update lock (a server driving the run): stop the server first. It takes that lock through the database, so it refuses when the database cannot be reached. With no run in flight, it closes a `NEEDS_DB_RESTORE` run once you have restored the database. Maintenance mode is left as it is. |

Starting and resuming a run belong to the server: the code phase restarts the server, and the phases after it run in the server's own start. `bun run update apply` and `bun run update resume` refuse and point to the maintenance panel.

### Which maintenance actions need the superuser, maintenance mode and a backup

Every maintenance action declares a precondition class, and the maintenance dispatcher enforces it before the action runs. A *destructive* action needs the superuser, maintenance mode, a fresh proven database backup (or `waive_backup: true` in the request, logged with the user), no update run in flight, and the update lock while it runs. An *update run* action starts a run, whose own preflight, backup and lock apply these same rules, or files the request a Docker host's image updater runs.

| Action | Class |
| --- | --- |
| `move_locator.move_locator` | destructive, unless it is a dry run |
| `move_tld.move_tld` | destructive, unless it is a dry run |
| `move_to_table.move_to_table` | destructive, unless it is a dry run |
| `move_to_portal.move_to_portal` | destructive, unless it is a dry run |
| `move_lang.move_lang` | destructive, unless it is a dry run |
| `update_data_version.update_data_version` | destructive |
| `add_hierarchy.reset_hierarchies` | destructive |
| `update_code.restore_code` | destructive |
| `build_database_version.restore_dd_ontology_recovery_from_file` | destructive |
| `update_code.update_code` | update run: starts a code update run |
| `update_ontology.update_ontology` | update run: starts an ontology-only run |
| `update_code.request_image_update` | update run: files the request the host image updater runs (superuser and maintenance mode; the host takes its own backup) |
| `update_code.cancel_image_update_request` | update run: withdraws that request (superuser) |

A `move_*` action is a dry run unless its request says `dry_run: false`; a dry run is an ordinary administrator action. Building a release on a code server (`serve_code.build_version_from_git_master`) needs the superuser only. Every other maintenance action needs a global administrator.

## How do I know when new versions are released?

The latest Dédalo version is [here](https://github.com/dedalia-org/dedalo/releases). It contains all the latest fixes and improvements.

In the list you can view the changelog for the highlights of each release.

## Server services and dependencies

Dédalo has service dependencies such as PostgreSQL, the Bun runtime and FFmpeg. By default, recent Dédalo versions are compatible with the current stable version of each dependency and its previous version. The Bun runtime itself is pinned per install (`.bun-version`); upgrading it is a deliberate, separately-tested change, not something a code update does for you. On an installer instance the move is [Updating the Bun runtime](../../install/bun_runtime.md).

It is highly recommended to keep server services on the latest stable versions. You can check the version compatibility in our [readme file](https://github.com/dedalia-org/dedalo/blob/master/Readme.md#4-dependencies).

## How code, ontology and data depend on each other

- **The ontology** defines components, sections and their configuration. It carries the data version of the master that exported it, and an installation refuses an ontology exported for another data model (see [Updating ontology](updating_ontology.md)). An ontology change that a release's code needs ships with that release, as its ontology phase.
- **The code** runs on the data model of its release. A code update is refused while the database is not on the data version the running code declares: run the pending data update first.
- **The data** follows the code: a release that changes data declares a `data` step, and the run executes it after the code swap.

The ontology update and the code update are therefore not ordered by you: the run orders them. You can still update the ontology between code updates, with the Update ontology panel.
