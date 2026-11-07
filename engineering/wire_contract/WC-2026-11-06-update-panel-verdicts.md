# WC-2026-11-06-update-panel-verdicts — update_code consumer checks: `disk_space` and `root_entries` decide, runtime-data names its key

- **Date:** 2026-11-06. TS-native panel (`src/core/update/status.ts`
  `consumerStatus`); PHP has no twin.
- **`disk_space`** was always `unknown` with `detail` = available bytes. It is now
  the PIPELINE'S verdict (`checkUpdateSpace`'s rule, disk_space.ts) read through
  a shared background measurement (`checkUpdateSpaceWithin`: one `du` per tree,
  bounded wait = the panel's `waitMs`, settled result reused 10 min; free bytes
  read live): `ok` / `blocked` with `detail` `"<available>/<required>"` (bytes),
  else `unknown` with `detail` `measuring` | `unmeasurable` |
  `superuser_required` (only the superuser's panel pays for a walk, like
  `backup_fresh`). `scope` is still the staging parent. The pipeline still
  measures fresh when it spends disk.
- **`root_entries`**: `installedRootEntriesOf` (install_stamp.ts) falls back from
  the install stamp to the tree's own release-root list
  (`engineering/release_root_entries.json`, held to `git archive`'s root EXACTLY
  by `release_root_entries_tripwire`), so unstamped trees decide too. The state for
  leftover operator entries is `blocked` (was `warn`): the swap refuses them
  (`refuseUnaccountedLiveEntries`). `unknown` remains only for a tree with
  neither record. The swap's retired-entry evidence reads the same fallback.
- **`runtime_data_outside_tree`** `detail` entries gain the config key:
  `<id> (<ENV_KEY>): <path>` (was `<id>: <path>`; hard-coded paths unchanged).
- **`engine` gains two ADDITIVE fields** (2026-11-07): `date` — ISO date of the
  running code (the build stamp `build`, else a checkout's HEAD commit date via
  `git log -1 --format=%cI`, null when neither answers); `install_source` — the
  release URL the install stamp recorded (`source_url`), null on a checkout. The
  panel shows `date · posture · source host` under the version.
- **Client** (`render_update_status.js`): parses the `disk_space` detail (a bare
  byte count from an older server still renders), state-specific notes
  (`update_code_note_<id>_<state>`) and `update_code_fix_<id>` steps on blocked rows.
- **Gates:** `test/unit/update_status_native.test.ts` (verdicts, measuring,
  unmeasurable, superuser-only walk, manifest fallback),
  `test/unit/release_root_entries_tripwire.test.ts` (the list),
  `client/dedalo/test/client/js/test_update_code.js`.
