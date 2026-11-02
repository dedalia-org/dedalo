/**
 * THE IDENTITY WALK — release identity design gate 15 (§2.8 item 3, 2026-10-18).
 *
 * Every door that moves an install to another version (the tree swap, the
 * panel's image-update request, the host CLI's `check-target`) asks ONE rule,
 * version_walk.ts identityWalkRefusal: within a data triple a NEWER identity
 * is legal with no migration rung (beta.6 → beta.7 → rc.1 → 7.0.0, skipping
 * betas included); across triples the data walk decides (the next rung only)
 * and, where the offer is known, the target is the rung's newest identity on
 * the asker's channel; a prerelease needs the prerelease channel; the dev
 * channel keeps its same-triple exception.
 *
 * ONE fixture (test/fixtures/release_identity/walk_truth_table.json), read by:
 *  1. the rule itself;
 *  2. the REAL host CLI, executed as the host runs it, from an engine tree that
 *     CALLS ITSELF the row's running identity (test/helpers/engine_cli_tree.ts:
 *     an archive-expanded build_info.txt, no seam) — so a prerelease target is
 *     answered by the engine directly, never as `malformed_version`;
 *  3. the CLIENT's post-restart verdict (update_code_phases.js
 *     resolve_health_outcome / resolve_final_frame): for every legal walk to a
 *     named identity, /health answering the target is `updated` and answering
 *     the running identity — the tree a rollback restores — is `rolled_back`.
 *     Within a triple the two share their data version, so a verdict that
 *     matched on the triple would read every such rollback as an update.
 * Plus the CATALOG-ONCE rule: UPDATE_CATALOG is keyed by data triple, so its
 * descriptor runs exactly once across <rung>-beta.7 → <rung>-rc.1 → <rung> —
 * on the first identity of the triple installed. Each hop is an engine tree
 * that CALLS ITSELF that identity (engine_cli_tree.ts), running "update data"
 * in its own process with NO version seam: it reads the installed data version
 * and stamps it through the engine's real doors (matrix_updates). So an engine
 * that keyed the catalog on what it calls itself — or read "installed" off its
 * identity — runs the descriptor again (or never) and turns the leg red.
 *
 * Hermetic but for the catalog leg, which writes the version rows of record on
 * the MARKED suite database (assertTestDatabase, in this process and in every
 * hop) and deletes exactly the rows it appended (above a watermark, naming the
 * rung) afterwards.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	init_phase_state,
	resolve_final_frame,
	resolve_health_outcome,
} from '../../client/dedalo/core/area_maintenance/widgets/update_code/js/update_code_phases.js';
import { privateDir } from '../../src/config/env.ts';
import { readInstalledDataVersionStrict } from '../../src/core/area_maintenance/backup.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { catalogKeyOf, type DataUpdateDescriptor } from '../../src/core/update/catalog.ts';
import type { InstallChannel } from '../../src/core/update/install_stamp.ts';
import { imageTagOf, parseReleaseVersion } from '../../src/core/update/release_identity.ts';
import {
	identityWalkRefusal,
	parseImageTag,
	type WalkRefusal,
} from '../../src/core/update/version_walk.ts';
import { childDriver, driverResult, REPO_ROOT } from '../helpers/child_driver.ts';
import { engineCliAt } from '../helpers/engine_cli_tree.ts';

interface WalkRow {
	name: string;
	running: string;
	target: string;
	channel: InstallChannel;
	offered?: string[];
	verdict: WalkRefusal | null;
}

const TABLE = JSON.parse(
	readFileSync(
		join(import.meta.dir, '..', 'fixtures', 'release_identity', 'walk_truth_table.json'),
		'utf8',
	),
) as { rows: WalkRow[] };

const ALL_REFUSALS: readonly WalkRefusal[] = [
	'downgrade_or_same_version',
	'version_skip',
	'not_newer_release',
	'channel_refused',
	'not_newest_of_rung',
];

const SCRATCH = mkdtempSync(join(tmpdir(), 'dedalo_identity_walk_'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe('the truth table is a table (anti-vacuity)', () => {
	test('rows of every shape: legal and refused, every refusal id, every channel, offers', () => {
		const rows = TABLE.rows;
		expect(rows.length).toBeGreaterThanOrEqual(30);
		expect(rows.filter((row) => row.verdict === null).length).toBeGreaterThanOrEqual(12);
		expect(new Set(rows.map((row) => row.verdict).filter((v) => v !== null))).toEqual(
			new Set(ALL_REFUSALS),
		);
		expect(new Set(rows.map((row) => row.channel))).toEqual(
			new Set(['master', 'prerelease', 'dev']),
		);
		expect(rows.filter((row) => row.offered !== undefined).length).toBeGreaterThanOrEqual(3);
		// every identity in it is one (a typo would otherwise throw as "garbage" and look like a refusal)
		for (const row of rows) {
			for (const identity of [row.running, row.target, ...(row.offered ?? [])]) {
				expect(parseReleaseVersion(identity), `${row.name}: ${identity}`).not.toBeNull();
			}
		}
		expect(new Set(rows.map((row) => row.name)).size).toBe(rows.length);
	});
});

describe('reader 1: the rule (version_walk.ts identityWalkRefusal)', () => {
	for (const row of TABLE.rows) {
		test(row.name, () => {
			const verdict = identityWalkRefusal(row.running, row.target, row.channel, row.offered);
			expect(verdict?.refusal ?? null).toBe(row.verdict);
			// a refusal always carries the operator sentence the swap door throws
			if (verdict !== null) expect(verdict.reason.length).toBeGreaterThan(10);
		});
	}

	test('garbage is never ordered: it throws, it is not a verdict', () => {
		for (const [running, target] of [
			['7.0.0', '7.0.1-pre.1'],
			['7.0.0-beta.6', '7.0.01'],
			['seven', '7.0.1'],
		]) {
			expect(() => identityWalkRefusal(running as string, target as string)).toThrow(RangeError);
		}
	});
});

/** The rows the CLI can be asked: a tag's own channel is the row's (the CLI derives it), no offer. */
const CLI_ROWS = TABLE.rows.filter(
	(row) =>
		row.offered === undefined && parseImageTag(imageTagOf(row.target))?.channel === row.channel,
);

describe('reader 2: the REAL host CLI, from an engine that calls itself the running identity', () => {
	const trees = new Map<string, string>();
	function cliOf(identity: string): string {
		let cli = trees.get(identity);
		if (cli === undefined) {
			cli = engineCliAt(join(SCRATCH, `engine_${trees.size}`), identity);
			trees.set(identity, cli);
		}
		return cli;
	}

	test('the CLI leg covers both verdicts, prerelease targets and a prerelease running engine', () => {
		expect(CLI_ROWS.length).toBeGreaterThanOrEqual(18);
		expect(CLI_ROWS.some((row) => row.verdict === null)).toBe(true);
		expect(CLI_ROWS.some((row) => row.verdict !== null)).toBe(true);
		expect(CLI_ROWS.some((row) => row.verdict === null && row.channel === 'prerelease')).toBe(true);
		expect(CLI_ROWS.some((row) => parseReleaseVersion(row.running)?.prerelease)).toBe(true);
		expect(CLI_ROWS.some((row) => row.verdict === 'not_newer_release')).toBe(true);
	});

	for (const row of CLI_ROWS) {
		const tag = imageTagOf(row.target);
		test(`${row.name}: check-target ${tag} from ${row.running}`, () => {
			const run = Bun.spawnSync([process.execPath, cliOf(row.running), 'check-target', tag], {
				stdout: 'pipe',
				stderr: 'pipe',
			});
			expect(
				{ code: run.exitCode, out: run.stdout.toString().trim() },
				run.stderr.toString(),
			).toEqual({ code: row.verdict === null ? 0 : 3, out: row.verdict ?? '' });
		}, 30000);
	}
});

describe('reader 3: the client tells the new tree from the rolled-back one', () => {
	const LEGAL = TABLE.rows.filter((row) => row.verdict === null);
	const NEW = 'a'.repeat(64);
	const OLD = 'b'.repeat(64);

	test('the leg covers same-triple walks (the case a triple match gets wrong)', () => {
		const sameTriple = LEGAL.filter(
			(row) =>
				!row.target.endsWith('-dev') &&
				parseReleaseVersion(row.running)?.triple.join('.') ===
					parseReleaseVersion(row.target)?.triple.join('.'),
		);
		expect(sameTriple.length).toBeGreaterThanOrEqual(6);
	});

	// a developer build's identity is its archive's to say: the job names the
	// data triple and the DIGEST decides (the dev-channel rule, unchanged)
	for (const row of LEGAL.filter((legal) => legal.target.endsWith('-dev'))) {
		test(row.name, () => {
			const triple = row.target.slice(0, -'-dev'.length);
			const state = { ...init_phase_state(triple, NEW), mode: 'polling' };
			expect(resolve_health_outcome(state, row.target, NEW).outcome).toBe('updated');
			expect(resolve_health_outcome(state, row.running, OLD).outcome).toBe('rolled_back');
		});
	}

	for (const row of LEGAL.filter((legal) => !legal.target.endsWith('-dev'))) {
		test(row.name, () => {
			// the live path: the click/restart frame carry the identity
			const live = { ...init_phase_state(row.target), mode: 'polling' };
			expect(resolve_health_outcome(live, row.target).outcome).toBe('updated');
			expect(resolve_health_outcome(live, row.running).outcome).toBe('rolled_back');
			// the resume path: the expectation comes from the job's final envelope —
			// code_update.ts `{version: <triple>, release?: <identity>}`
			const triple = parseReleaseVersion(row.target)?.triple.join('.') as string;
			const envelope = {
				ok: true,
				data: { version: triple, ...(row.target === triple ? {} : { release: row.target }) },
			};
			const ending = resolve_final_frame(init_phase_state(null), {
				is_running: false,
				data: envelope,
			});
			expect(ending).toEqual({ outcome: 'updated', version: row.target });
			const resumed = { ...init_phase_state(ending?.version ?? null), mode: 'polling' };
			expect(resolve_health_outcome(resumed, row.target).outcome).toBe('updated');
			expect(resolve_health_outcome(resumed, row.running).outcome).toBe('rolled_back');
		});
	}
});

describe('the catalog-once rule: the descriptor runs on the FIRST identity of its triple', () => {
	// The suite database's REAL data version (matrix_updates, the engine's own
	// reader) is the walk's start; the descriptor is its next minor rung, and
	// every hop installs an identity of that rung.
	let start: number[] = [];
	let rung: number[] = [];
	let watermark = 0;
	const driver = childDriver('dedalo-identity-catalog-once');

	beforeAll(async () => {
		await assertTestDatabase('release_identity_walk_native:catalog_once');
		start = await readInstalledDataVersionStrict();
		expect(start.length, 'the suite database carries no data version row').toBe(3);
		// a data change rides a MINOR or MAJOR release (catalog.ts validateUpdateDescriptor:
		// updateData on a patch is refused), so the rung is the next minor
		rung = [start[0] as number, (start[1] as number) + 1, 0];
		const rows = (await sql`SELECT COALESCE(MAX(id), 0) AS id FROM matrix_updates`) as {
			id: number;
		}[];
		watermark = Number(rows[0]?.id ?? 0);
	});

	// Only the rows THIS leg's runs appended (above the watermark, naming the rung).
	afterAll(async () => {
		if (rung.length === 3) {
			await sql`DELETE FROM matrix_updates
				WHERE id > ${watermark} AND data->>'dedalo_version' = ${rung.join('.')}`;
		}
		driver.dispose();
	});

	/**
	 * ONE hop: an engine tree that CALLS ITSELF `identity` (its build stamp
	 * names the tag, its version.ts the rung — an archive of that release) runs
	 * the operator's "update data" in its own process, with NO version seam:
	 * the engine reads the installed data version, and stamps it, through its
	 * real doors on the suite database. Only the catalog and the script are the
	 * gate's (the real catalog's rungs are not this one).
	 */
	async function runHop(
		identity: string,
		countFile: string,
	): Promise<{ identity: string; ok: boolean }> {
		const tree = join(
			engineCliAt(join(SCRATCH, `catalog_${identity}`), identity),
			'..',
			'..',
			'..',
		);
		// the copied sources resolve their packages from the checkout's install
		symlinkSync(join(REPO_ROOT, 'node_modules'), join(tree, 'node_modules'));
		const descriptor: DataUpdateDescriptor = {
			versionMajor: rung[0] as number,
			versionMedium: rung[1] as number,
			versionMinor: rung[2] as number,
			updateFromMajor: start[0] as number,
			updateFromMedium: start[1] as number,
			updateFromMinor: start[2] as number,
			updateData: true,
			runScripts: [{ info: 'the rung migration', scriptId: 'fixture.count', stopOnError: true }],
		};
		const module = (path: string) => JSON.stringify(join(tree, path));
		const source = `
import { appendFileSync } from 'node:fs';
import { DEDALO_ENGINE_VERSION } from ${module('src/core/update/build_stamp.ts')};
import { updateVersion } from ${module('src/core/update/engine.ts')};
import { assertTestDatabase } from ${module('src/core/test_data/test_database_marker.ts')};
await assertTestDatabase('release_identity_walk_native:catalog_once_hop');
const out = await updateVersion({ run_scripts_0: true }, {
	catalog: { ${JSON.stringify(catalogKeyOf(descriptor))}: ${JSON.stringify(descriptor)} },
	scripts: {
		'fixture.count': async () => {
			appendFileSync(${JSON.stringify(countFile)}, 'ran\\n');
			return { ok: true, msg: 'migrated' };
		},
	},
	logPath: ${JSON.stringify(join(SCRATCH, 'update.log'))},
	reconcileMirrors: async () => ({ repaired: 0, shrinksSkipped: 0 }),
	// the copied tree's data version is this checkout's: the rung's own release is the code it simulates
	codeDataVersion: ${JSON.stringify(rung)},
});
console.log('RESULT ' + JSON.stringify({ identity: DEDALO_ENGINE_VERSION, ok: out.ok }));
process.exit(0);
`;
		const run = await driver.run(`hop_${identity}.ts`, source, { DEDALO_PRIVATE_DIR: privateDir });
		expect(run.exitCode, run.stderr).toBe(0);
		return driverResult<{ identity: string; ok: boolean }>(run.stdout, run.stderr);
	}

	test('start → rung-beta.7 → rung-rc.1 → rung: ONE run, on the first identity; every later ask finds nothing', async () => {
		const triple = rung.join('.');
		const walk = [start.join('.'), `${triple}-beta.7`, `${triple}-rc.1`, triple];
		const countFile = join(SCRATCH, 'catalog_once.count');
		const hops: { identity: string; ok: boolean }[] = [];
		for (let step = 1; step < walk.length; step++) {
			const identity = walk[step] as string;
			// each hop is a legal identity walk (the swap door's own verdict)…
			const channel = parseReleaseVersion(identity)?.prerelease ? 'prerelease' : 'master';
			expect(identityWalkRefusal(walk[step - 1] as string, identity, channel)).toBeNull();
			// …and after each install the operator presses "update data" anyway
			hops.push(await runHop(identity, countFile));
		}
		// every hop's engine really called itself its identity (no vacuous trees)
		expect(hops.map((hop) => hop.identity)).toEqual(walk.slice(1));
		const ran = existsSync(countFile) ? readFileSync(countFile, 'utf8').split('\n').length - 1 : 0;
		expect(ran).toBe(1);
		expect(hops.map((hop) => hop.ok)).toEqual([true, false, false]);
		// the version of record is the DATA triple the engine stamped, never an identity
		expect(await readInstalledDataVersionStrict()).toEqual(rung);
	}, 120000);
});
