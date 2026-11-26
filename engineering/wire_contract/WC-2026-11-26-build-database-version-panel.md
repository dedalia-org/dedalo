# WC-2026-11-26-build-database-version-panel — the seed panel names its sources, checks first, builds as a job

- **Date:** 2026-11-26.
- **Decision:** user-approved redesign of the build_database_version widget (server + client).
- **Shape before (PHP v6/v7, TS until now):** `get_widget_value` answered three strings
  (`source_db`, `target_db`, `target_file`); `build_install_version` took no options, ran
  synchronously inside the request (up to an hour) and always wrote this tree's vendored seed
  from the shipped release dir.
- **Shape after (TS):**
  - `get_widget_value` keeps the three strings and adds `parts` (`schema`, `migrations` count,
    `core_tlds`), `sources` (`{id, kind, location, release}` per offer — `local_export` on an
    ontology master, one `master:<name>` per `ONTOLOGY_SERVERS` entry (origin only, never the
    code), `shipped`), `default_source`, `targets` (`private` / `checkout`, with `available`),
    `checkout_seed` (the vendored seed's manifest against this checkout: `state`
    current|stale|missing + findings) and `last_build` (the newest private `build.json`).
  - NEW action `seed_preflight` (options `source`, `target`) → `{ok, checks:[{id, ok, detail,
    fix?}]}` — ids `pg_tools`, `database_role` (CREATEDB), `build_lock`, `source`, `output`, `disk`.
  - `build_install_version` takes `source` (`shipped` | `local_export` | `master:<name>`,
    default `shipped`) and `target` (`private` default | `checkout`), re-runs the preflight, and
    answers a mediaJobs poll handle `{pid, pfile}`. Each finished step rides the job `data` as
    `{steps}`; the job result is `{msg, errors?, steps, file_size, target, output, source,
    release, pulled, checks}`.
  - Output `private` = `<private>/seed_builds/<stamp>/` (seed, manifest, `build.json`, the
    copied release under `ontology/`); only the newest successful build is kept. A seed built
    from a copied release records its files under their SHIPPED paths, so it is the committed
    seed's twin once those files are vendored.
  Code: `src/core/install/seed_panel.ts`, `src/core/install/ontology_release_pull.ts`,
  `src/core/area_maintenance/widgets/build_database_version.ts`.
- **Reason:** on an ontology master the panel compiled the SHIPPED release, not the master's
  own newer export; the CREATEDB requirement surfaced only mid-build; a deployed install's code
  tree is replaced by every code update (or read-only in an image), so writing the seed there
  was pointless.
- **Gate reconciliation:** no parity fixture covers this widget; no fixture edit. Gates:
  `test/unit/seed_panel_native.test.ts`, `test/unit/ontology_release_pull.test.ts`; the door
  class table (`update_door_precondition_class_tripwire`) gains `seed_preflight` as `read`.
- **Client (same day):** the panel renders `parts`, `checkout_seed`, `last_build`, the source
  and output pickers and the preflight report (Build enabled only on `ok`; a failed check shows
  its `fix`); a build follows the job (live `steps`, re-attached after a reload) and ends in the
  result or the failure. Nothing is requested before the value loads (collapsed widget).
  `render_build_database_version.js`; gate `client/dedalo/test/client/js/test_build_database_version.js`.
- **Download route (new):** `GET /dedalo/install/seed_build/<file>` — `dedalo_install.pgsql.gz`,
  `dedalo_install.pgsql.gz.manifest.json` or `build.json` of the NEWEST finished private build,
  as an attachment (`no-store`), to a caller who may use the maintenance area now; anything
  else 404. `src/core/install/seed_build_download.ts`; gate
  `test/unit/seed_build_download_native.test.ts`.
- **Retired:** the action `build_matrix_hierarchy_main_sql` (no client caller left; its door
  class entry and the engine-denied boundary row go with it).
- **Review fix (same day):** a non-shipped release is pulled/copied into a scratch dir UNDER the
  cluster lock (`buildInstallVersion` `prepareRelease`), compiled from there, and — for the
  checkout output — promoted into `install/import/ontology/<major.minor>/` only after the
  verify-by-install, still under the lock (`promoteRelease`). Before, the checkout's release dir
  was overwritten before the lock and left in place when the build then failed. Retention prunes
  only OLDER build stamps (`pruneOlderBuilds`). Gates: `seed_panel_native` (lock held elsewhere →
  refused before `prepareRelease` runs; staging; prune).
- **Second review fix (same day):** the job's stop signal reaches the compiler (checked before
  each writing phase — a stopped build promotes and lands nothing); the preflight's lock probe
  READS `pg_locks` instead of taking the lock; a missing psql is a failed check, never a thrown
  preflight; only build-stamp dirs count as builds (`latestPrivateBuild`). Known limit: the
  checkout promotion is a per-file mirror, not one atomic swap — a crash during it shows as a
  STALE manifest (`install_seed_manifest_tripwire`).
- **Release exclusions (owner ruling, same day):** `RELEASE_EXCLUDED_TLDS`
  (`ontology_release_pull.ts`, each with its reason) names packages a master exports that the
  vendored release never carries — first `mht` (an installation's own ontology). A pull skips the
  package and its `files_sha256` digest, keeps its `active_ontologies` entry (the installer offers
  only packages present), removes a stale local copy, and warns. Gates: `ontology_release_pull`,
  `install_seed_drift_tripwire` (no excluded package or digest in the vendored release).
