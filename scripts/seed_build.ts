/**
 * Compile the install seed from the repository sources (src/core/install/seed_build.ts).
 *
 *   bun run seed:build                 → install/db/dedalo_install.pgsql.gz + its manifest
 *   bun run seed:build --out <file>    → <file> + <file>.manifest.json (a trial compile)
 *   bun run seed:build --from <name>   → compile from the ontology release of the ONTOLOGY_SERVERS
 *                                        master <name> (src/core/install/ontology_release_pull.ts),
 *                                        pulled into a scratch dir under the compile's lock; without
 *                                        --out the VERIFIED release replaces install/import/ontology/
 *                                        (seed_panel.ts stagedRelease), so a failed build changes nothing
 *
 * The same compiler the maintenance widget's "Build install version" runs. It
 * needs a Postgres cluster and a user with CREATEDB (the configured connection's
 * host/port/user/password); it reads no installation's database.
 */

import { resolve } from 'node:path';
import { isDedaloError } from '../src/core/errors/index.ts';
import type { ReleasePullResult } from '../src/core/install/ontology_release_pull.ts';
import { buildInstallVersion } from '../src/core/install/seed_build.ts';
import { stagedRelease } from '../src/core/install/seed_panel.ts';

function flagValue(name: string): string | undefined | null {
	const at = process.argv.indexOf(name);
	if (at === -1) return undefined;
	return process.argv[at + 1] ?? null;
}
const outFile = flagValue('--out');
const fromServer = flagValue('--from');
if (outFile === null || fromServer === null) {
	console.error('usage: bun run seed:build [--from <ONTOLOGY_SERVERS name>] [--out <file>]');
	process.exit(2);
}

const reportPull = (pulled: ReleasePullResult) => {
	for (const warning of pulled.warnings) console.log(`  ! ${warning}`);
};
const staged = stagedRelease(
	fromServer === undefined ? { kind: 'shipped' } : { kind: 'master', name: fromServer },
	{ promote: outFile === undefined, onPulled: reportPull },
);

try {
	const result = await buildInstallVersion({
		...(outFile === undefined ? {} : { outFile: resolve(outFile) }),
		releaseDir: staged.releaseDir,
		...(staged.prepareRelease ? { prepareRelease: staged.prepareRelease } : {}),
		...(staged.promoteRelease ? { promoteRelease: staged.promoteRelease } : {}),
	});
	for (const step of result.steps) console.log(`  ${step}`);
	for (const finding of result.findings) console.log(`  ! ${finding}`);
	const promoted = staged.promoted();
	if (promoted !== null && promoted.removed.length > 0) {
		console.log(`  removed from the release dir: ${promoted.removed.join(', ')}`);
	}
	console.log(`${result.msg} (${result.file_size})`);
	staged.dispose();
	process.exit(0);
} catch (error) {
	staged.dispose();
	if (!isDedaloError(error)) throw error;
	const readout = (error.extend ?? {}) as { steps?: string[]; findings?: string[] };
	for (const step of readout.steps ?? []) console.log(`  ${step}`);
	for (const finding of readout.findings ?? []) console.log(`  ! ${finding}`);
	console.error(error.publicMessage ?? error.code);
	process.exit(1);
}
