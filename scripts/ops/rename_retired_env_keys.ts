/**
 * THE RELEASE'S RETIRED-KEY RENAME ENTRY (2026-11-23) — the stable door the
 * code updater spawns from the QUARANTINE tree, pre-swap, against the LIVE
 * private `.env`: the running updater is the old code and cannot know what this
 * release retired, so this tree's own RETIRED_ENV_KEYS decides.
 *
 *   bun run scripts/ops/rename_retired_env_keys.ts <path of the live .env>
 *
 * Appends `<replacement>=<raw value>` for each retired key set in that file
 * whose replacement is set nowhere; never edits a line
 * (src/config/env_retired_rename.ts). Output: ONE JSON line
 * `{"appended":[{retired,replacement,value}],"refused":[{retired,replacement,blocker}]}`.
 * Exit 0 when the file was judged (refusals included), 1 otherwise.
 * KEEP THE PATH AND THE OUTPUT SHAPE: an updater of any later release calls
 * them in this tree (src/core/update/code_update.ts renameRetiredEnvKeysPreSwap).
 */

import { renameRetiredEnvKeys } from '../../src/config/env_retired_rename.ts';

const envPath = Bun.argv[2];
if (envPath === undefined || envPath === '') {
	console.error('rename_retired_env_keys: the path of the .env to judge is required');
	process.exit(1);
}
console.log(JSON.stringify(renameRetiredEnvKeys(envPath)));
