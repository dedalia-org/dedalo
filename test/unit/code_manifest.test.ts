/**
 * Code-update DISCOVERY manifest (UPDATE_PROCESS Phase 4) — the linear
 * upgrade-path walk and the release-manifest builder, driven through the
 * INJECTABLE `catalog` parameter.
 *
 * WHY THIS FILE EXISTS: the live `UPDATE_CATALOG` is `Object.freeze({})`, so
 * every assertion made against it is vacuous — the `for` body never runs and
 * `toEqual([])` cannot go red for any implementation. `code_update.test.ts`
 * keeps ONE empty-catalog case as the 7.0.0-is-current fact; the branch
 * coverage of both functions lives here, on synthetic catalogs.
 *
 * Catalog keys are the concatenated target triple ('701' = 7.0.1 — the
 * `catalogKeyOf` convention); `buildCodeUpdateInfo` re-derives that key from
 * the triple, so a mis-keyed catalog loses its descriptor (asserted below).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveReleaseNotes, parseFragment } from '../../scripts/lib/change_log.ts';
import type { CodeOnlyUpdateDescriptor, UpdateDescriptor } from '../../src/core/update/catalog.ts';
import {
	buildCodeUpdateInfo,
	codeReleasePath,
	linearUpgradeTargets,
	readReleaseNotes,
	releaseArchiveNameOf,
} from '../../src/core/update/code_manifest.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

/** A minimal descriptor: only the target triple drives the linear walk. */
function target(
	major: number,
	medium: number,
	minor: number,
	extra: Partial<CodeOnlyUpdateDescriptor> = {},
): UpdateDescriptor {
	return {
		versionMajor: major,
		versionMedium: medium,
		versionMinor: minor,
		// updateFrom* are the DATA-catalog matcher; the code manifest ignores
		// them entirely — pinned to the previous rung only for realism.
		updateFromMajor: major,
		updateFromMedium: medium,
		updateFromMinor: Math.max(0, minor - 1),
		// A code release (the manifest walk ignores updateData too).
		updateData: false,
		...extra,
	};
}

/** '701' — the same key shape `catalogKeyOf`/`buildCodeUpdateInfo` compute. */
function catalogOf(...descriptors: UpdateDescriptor[]): Record<string, UpdateDescriptor> {
	const catalog: Record<string, UpdateDescriptor> = {};
	for (const d of descriptors) {
		catalog[`${d.versionMajor}${d.versionMedium}${d.versionMinor}`] = d;
	}
	return catalog;
}

describe('linearUpgradeTargets (the linear walk, injected catalog)', () => {
	test('next patch within the current minor is advertised, and only once consumed', () => {
		const catalog = catalogOf(target(7, 0, 1));
		expect(linearUpgradeTargets([7, 0, 0], catalog)).toEqual([[7, 0, 1]]);
		// already ON 7.0.1: the patch rung no longer matches (minor+1 = 2) and
		// there is no minor/major boundary — nothing to advertise.
		expect(linearUpgradeTargets([7, 0, 1], catalog)).toEqual([]);
	});

	test('the next minor MASKS the next major boundary (exhaust 7.x before 8.0.0)', () => {
		// The whole point of the walk: a 7.0.0 client must be offered 7.1.0,
		// never 8.0.0, while a 7.x rung still exists.
		const both = catalogOf(target(7, 1, 0), target(8, 0, 0));
		expect(linearUpgradeTargets([7, 0, 0], both)).toEqual([[7, 1, 0]]);
		// drop the 7.x rung and the major boundary becomes visible
		const majorOnly = catalogOf(target(8, 0, 0));
		expect(linearUpgradeTargets([7, 0, 0], majorOnly)).toEqual([[8, 0, 0]]);
	});

	test('patch + minor are both advertised, sorted ascending', () => {
		// Insertion order is deliberately reversed to prove the final sort runs
		// (the client walks the list in order and would install 7.1.0 first).
		const catalog: Record<string, UpdateDescriptor> = {
			'710': target(7, 1, 0),
			'701': target(7, 0, 1),
		};
		expect(linearUpgradeTargets([7, 0, 0], catalog)).toEqual([
			[7, 0, 1],
			[7, 1, 0],
		]);
	});

	test('a short client version defaults the missing medium/minor to 0', () => {
		// `clientVersion[1] ?? 0` / `[2] ?? 0`: a bare [7] must behave as 7.0.0.
		const catalog = catalogOf(target(7, 1, 0));
		expect(linearUpgradeTargets([7], catalog)).toEqual([[7, 1, 0]]);
		const patch = catalogOf(target(7, 0, 1));
		expect(linearUpgradeTargets([7], patch)).toEqual([[7, 0, 1]]);
	});

	test('an empty client version is treated as 0.0.0 (clientMajor ?? 0)', () => {
		// `clientVersion[0] ?? 0`: only a 1.0.0 major boundary is reachable.
		expect(linearUpgradeTargets([], catalogOf(target(1, 0, 0)))).toEqual([[1, 0, 0]]);
		expect(linearUpgradeTargets([], catalogOf(target(7, 0, 0)))).toEqual([]);
	});

	test('off-path releases (behind, or a skipped major) are never advertised', () => {
		// 6.9.9 is behind; 9.0.0 is a major SKIP from 7.x — both must be invisible.
		const catalog = catalogOf(target(6, 9, 9), target(9, 0, 0));
		expect(linearUpgradeTargets([7, 0, 0], catalog)).toEqual([]);
	});

	test('a non-.0 minor and a non-.0.0 major are not boundaries', () => {
		// 7.1.3 / 8.0.1 fail the `=== 0` boundary tests; assertLinearUpgrade
		// would refuse them anyway ("must land on .0").
		const catalog = catalogOf(target(7, 1, 3), target(8, 0, 1));
		expect(linearUpgradeTargets([7, 0, 0], catalog)).toEqual([]);
	});

	test('the same triple under two catalog keys is deduped (D17 fixed 2026-08-09)', () => {
		// A patch rung reachable twice (e.g. a hand-edited/mis-keyed catalog)
		// used to be pushed once per descriptor: the old dedupe guard only
		// covered the nextMinor/nextMajor boundary — and that guard was dead,
		// because a boundary triple can never equal a patch triple. The dedupe
		// now runs over the whole target list, so a rung is advertised once.
		const duplicated: Record<string, UpdateDescriptor> = {
			'701': target(7, 0, 1),
			'701_alias': target(7, 0, 1),
		};
		const result = linearUpgradeTargets([7, 0, 0], duplicated);
		expect(result).toEqual([[7, 0, 1]]);
	});
});

const ROOT = scratchDir('code_manifest');
/** <ROOT>/files/<major>/<major.minor>/<version>.zip — the release layout. */
const FILES_DIR = join(ROOT, 'files');

beforeAll(() => {
	mkdirSync(join(FILES_DIR, '7', '7.0'), { recursive: true });
	writeFileSync(join(FILES_DIR, '7', '7.0', '7.0.1.zip'), 'PK-not-a-real-zip');
	// 7.1.0.zip is deliberately NOT built: an advertised-but-missing release.
	mkdirSync(join(FILES_DIR, '7', '7.1'), { recursive: true });
});
afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

const BASE_INFO = { date: 'now', entity_id: 1, entity: 'e', host: 'h' } as const;

describe('buildCodeUpdateInfo (manifest assembly)', () => {
	test('advertises only the target whose archive EXISTS on disk', () => {
		const catalog = catalogOf(target(7, 0, 1), target(7, 1, 0));
		const info = buildCodeUpdateInfo({
			clientVersion: [7, 0, 0],
			serverVersion: [7, 1, 0],
			codeFilesDir: FILES_DIR,
			publicBaseUrl: 'http://master/code',
			info: { ...BASE_INFO },
			catalog,
		});
		// both 7.0.1 and 7.1.0 are on the linear path, but only 7.0.1.zip exists
		expect(info.files.length).toBe(1);
		const mtime = statSync(join(FILES_DIR, '7', '7.0', '7.0.1.zip')).mtimeMs;
		expect(info.files[0]).toEqual({
			version: '7.0.1',
			url: 'http://master/code/7.0.1/7.0.1.zip',
			date: new Date(mtime).toISOString(),
		});
		// info.version is the SERVER version, not the client's
		// info.channels: every rung this master HONOURED — a release ask, releases
		expect(info.info).toEqual({ version: '7.1.0', ...BASE_INFO, channels: ['master'] });
	});

	test('a -dev build on disk is NEVER advertised to a consumer that did not ask for one', () => {
		// The property behind the two channels, NARROWED on 2026-08-24: a
		// developer build is servable by URL (code_serving.test.ts) but is never
		// OFFERED unless the consumer asked for the dev channel AND this master
		// opted in. Here it does neither, so the manifest stays silent about it.
		const devZip = join(FILES_DIR, '7', '7.1', '7.1.0-dev.zip');
		writeFileSync(devZip, 'PK-dev');
		try {
			const info = buildCodeUpdateInfo({
				clientVersion: [7, 0, 0],
				serverVersion: [7, 1, 0],
				codeFilesDir: FILES_DIR,
				publicBaseUrl: 'http://m',
				info: { ...BASE_INFO },
				catalog: catalogOf(target(7, 0, 1), target(7, 1, 0)),
			});
			// only the published 7.0.1.zip is advertised; no url ever names -dev
			expect(info.files.map((f) => f.version)).toEqual(['7.0.1']);
			for (const f of info.files) expect(f.url.includes('-dev')).toBe(false);
		} finally {
			rmSync(devZip, { force: true });
		}
	});

	// -----------------------------------------------------------------------
	// THE DEV CHANNEL (2026-08-24). Two independent switches must both be on:
	// the consumer ASKS (channel:'dev' — its panel switch) and this master has
	// OPTED IN (DEDALO_CODE_SERVER_DEV_CHANNEL). A public code server that never
	// set the key answers identically no matter what it is asked.
	// -----------------------------------------------------------------------
	describe('the dev channel', () => {
		const devZip = join(FILES_DIR, '7', '7.0', '7.0.0-dev.zip');

		beforeAll(() => {
			writeFileSync(devZip, 'PK-dev');
			writeFileSync(`${devZip}.sha256`, `${'f'.repeat(64)}  7.0.0-dev.zip\n`);
		});
		afterAll(() => {
			rmSync(devZip, { force: true });
			rmSync(`${devZip}.sha256`, { force: true });
		});

		function manifest(options: { channel?: 'master' | 'dev'; devChannelEnabled?: boolean }) {
			return buildCodeUpdateInfo({
				clientVersion: [7, 0, 0],
				serverVersion: [7, 0, 0],
				codeFilesDir: FILES_DIR,
				publicBaseUrl: 'http://m',
				info: { ...BASE_INFO },
				catalog: catalogOf(target(7, 0, 1)),
				...options,
			});
		}

		test('advertises the SAME-VERSION dev build — the whole point of the channel', () => {
			const info = manifest({ channel: 'dev', devChannelEnabled: true });
			const dev = info.files.find((f) => f.url.includes('-dev'));
			expect(dev).toBeDefined();
			// the consumer runs 7.0.0 and is offered 7.0.0 — no version bump, which
			// is exactly what an unreleased branch build has to offer.
			expect(dev?.version).toBe('7.0.0');
			expect(dev?.url).toBe('http://m/7.0.0/7.0.0-dev.zip');
			expect(dev?.channel).toBe('dev');
			// the digest stays mandatory: an archive with no sidecar is not installable
			expect(dev?.sha256).toBe('f'.repeat(64));
		});

		test('the dev build is listed FIRST — a consumer that asked for it means it', () => {
			const info = manifest({ channel: 'dev', devChannelEnabled: true });
			expect(info.files[0]?.url.includes('-dev')).toBe(true);
			// …and the published rung is still offered alongside it
			expect(info.files.map((f) => f.version)).toContain('7.0.1');
		});

		test('a master that did NOT opt in ignores the ask entirely', () => {
			const info = manifest({ channel: 'dev', devChannelEnabled: false });
			expect(info.files.map((f) => f.url).some((u) => u.includes('-dev'))).toBe(false);
		});

		test('an opted-in master still answers a RELEASE-channel ask with releases only', () => {
			const info = manifest({ channel: 'master', devChannelEnabled: true });
			expect(info.files.map((f) => f.url).some((u) => u.includes('-dev'))).toBe(false);
		});

		test('the release manifest is UNCHANGED by the feature: no channel key on a published item', () => {
			const info = manifest({});
			expect(info.files.map((f) => f.version)).toEqual(['7.0.1']);
			expect(Object.hasOwn(info.files[0] as object, 'channel')).toBe(false);
		});
	});

	test('force_update_mode never appears on the wire (WC-2026-08-23-update-mode-clean-only)', () => {
		// The clean-only pipeline retired the key: clean is the ONLY install
		// mode, so the manifest has nothing for the client to branch on. Pin the
		// ABSENCE — a resurrected key would be a silent wire divergence.
		const info = buildCodeUpdateInfo({
			clientVersion: [7, 0, 0],
			serverVersion: [7, 0, 0],
			codeFilesDir: FILES_DIR,
			publicBaseUrl: 'http://m',
			info: { ...BASE_INFO },
			catalog: catalogOf(target(7, 0, 1)),
		});
		expect(info.files.length).toBe(1);
		expect(Object.hasOwn(info.files[0] as object, 'force_update_mode')).toBe(false);
	});

	test('the sha256 SIDECAR is advertised; a missing or malformed one omits the key', () => {
		// The consumer refuses a release without a declared digest (code_update.ts),
		// so the manifest is the ONLY place that hash can come from: build writes
		// `<file>.zip.sha256`, this reads it back. Malformed sidecar → no key, which
		// surfaces as a loud refusal downstream rather than a skipped check.
		const catalog = catalogOf(target(7, 0, 1));
		const args = {
			clientVersion: [7, 0, 0],
			serverVersion: [7, 0, 1],
			codeFilesDir: FILES_DIR,
			publicBaseUrl: 'http://m',
			info: { ...BASE_INFO },
			catalog,
		} as const;
		const sidecar = join(FILES_DIR, '7', '7.0', '7.0.1.zip.sha256');
		const digest = 'b'.repeat(64);
		try {
			writeFileSync(sidecar, `${digest}  7.0.1.zip\n`);
			expect(buildCodeUpdateInfo({ ...args }).files[0]?.sha256).toBe(digest);

			for (const bad of ['', 'not-a-digest  7.0.1.zip\n', `${'B'.repeat(64)}  x\n`]) {
				writeFileSync(sidecar, bad);
				const item = buildCodeUpdateInfo({ ...args }).files[0] as object;
				expect(Object.hasOwn(item, 'sha256')).toBe(false);
			}
		} finally {
			rmSync(sidecar, { force: true });
		}
		expect(Object.hasOwn(buildCodeUpdateInfo({ ...args }).files[0] as object, 'sha256')).toBe(
			false,
		);
	});

	test('a MIS-KEYED catalog still advertises the file (the walk keys on the triple, not the key)', () => {
		// linearUpgradeTargets iterates Object.values, so an odd key still
		// advertises its rung — the key shape is a convention, not a gate.
		const misKeyed: Record<string, UpdateDescriptor> = {
			'7.0.1': target(7, 0, 1),
		};
		const info = buildCodeUpdateInfo({
			clientVersion: [7, 0, 0],
			serverVersion: [7, 0, 0],
			codeFilesDir: FILES_DIR,
			publicBaseUrl: 'http://m',
			info: { ...BASE_INFO },
			catalog: misKeyed,
		});
		expect(info.files.length).toBe(1);
		expect(Object.hasOwn(info.files[0] as object, 'force_update_mode')).toBe(false);
	});

	test('no codeFilesDir (or a missing one) advertises nothing, even with targets', () => {
		// A master that builds no releases must answer an EMPTY files list, not
		// throw — the client treats a throw as "update check failed".
		const catalog = catalogOf(target(7, 0, 1));
		for (const dir of [undefined, join(ROOT, 'does_not_exist')]) {
			const info = buildCodeUpdateInfo({
				clientVersion: [7, 0, 0],
				serverVersion: [7, 0, 0],
				codeFilesDir: dir,
				publicBaseUrl: 'http://m',
				info: { ...BASE_INFO },
				catalog,
			});
			expect(info.files).toEqual([]);
			expect(info.info.version).toBe('7.0.0');
		}
		// and the linear path being empty is equally quiet
		expect(
			buildCodeUpdateInfo({
				clientVersion: [7, 0, 1],
				serverVersion: [7, 0, 1],
				codeFilesDir: FILES_DIR,
				publicBaseUrl: 'http://m',
				info: { ...BASE_INFO },
				catalog,
			}).files,
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// RELEASE NOTES (2026-10-09, WC-2026-10-09-code-manifest-release-notes): a
// PUBLISHED item carries the notes its release froze in the master's
// changes/<version>/release.json; a developer item never does; anything
// missing or malformed leaves the field absent.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// GATE 14 — CHANNEL EXPOSURE (RELEASE_IDENTITY_DESIGN §2.8 items 2-3, owner Q8).
// The ladder master ⊂ prerelease ⊂ dev, each rung needing BOTH the asker's
// token and this master's own switch (DEDALO_CODE_SERVER_PRERELEASE_CHANNEL,
// separate from the dev one). Outcomes over a real archive tree: a 7.0.0
// triple holding beta.6, beta.7 and the stable 7.0.0, and a 7.0.1 rung holding
// ONLY a prerelease — the newest identity on the master, which a stable asker
// must still never see.
// ---------------------------------------------------------------------------
describe('gate 14: the prerelease channel (manifest exposure)', () => {
	const PRE_ROOT = join(ROOT, 'prerelease');
	const PRE_FILES = join(PRE_ROOT, 'files');
	const PRE_CHANGES = join(PRE_ROOT, 'changes');
	const ARCHIVES: readonly [string, string][] = [
		['7.0', '7.0.0-beta.6.zip'],
		['7.0', '7.0.0-beta.7.zip'],
		['7.0', '7.0.0.zip'],
		['7.0', '7.0.1-beta.1.zip'],
		// not an identity in the shared grammar: never listed
		['7.0', '7.0.0-pre.1.zip'],
	];
	const shaOf = (fileName: string) =>
		[...fileName]
			.reduce((sum, char) => sum + char.charCodeAt(0), 0)
			.toString(16)
			.padStart(64, '0');

	beforeAll(() => {
		mkdirSync(join(PRE_FILES, '7', '7.0'), { recursive: true });
		for (const [dir, fileName] of ARCHIVES) {
			const path = join(PRE_FILES, '7', dir, fileName);
			writeFileSync(path, `PK-${fileName}`);
			writeFileSync(`${path}.sha256`, `${shaOf(fileName)}  ${fileName}\n`);
		}
		mkdirSync(join(PRE_CHANGES, '7.0.0-beta.7'), { recursive: true });
		writeFileSync(
			join(PRE_CHANGES, '7.0.0-beta.7', 'release.json'),
			JSON.stringify({
				version: '7.0.0-beta.7',
				date: '2026-10-18',
				notes: { action_needed: [], entries: [{ type: 'fixed', audience: 'user', title: 'B7.' }] },
			}),
		);
	});
	afterAll(() => {
		rmSync(PRE_ROOT, { recursive: true, force: true });
	});

	type Ask = Partial<
		Pick<
			Parameters<typeof buildCodeUpdateInfo>[0],
			'channel' | 'clientRelease' | 'devChannelEnabled' | 'prereleaseChannelEnabled'
		>
	>;
	function manifest(ask: Ask) {
		return buildCodeUpdateInfo({
			clientVersion: [7, 0, 0],
			serverVersion: [7, 0, 0],
			codeFilesDir: PRE_FILES,
			publicBaseUrl: 'http://m',
			info: { ...BASE_INFO },
			catalog: catalogOf(target(7, 0, 1)),
			changesDir: PRE_CHANGES,
			...ask,
		});
	}
	/** What the operator would see: the identity each row installs. */
	const offered = (info: ReturnType<typeof manifest>) =>
		info.files.map((item) => item.release ?? item.version);
	const OPTED_IN = { prereleaseChannelEnabled: true, devChannelEnabled: true } as const;

	test('a MASTER asker never sees a prerelease — not even the newest identity on the master', () => {
		for (const clientRelease of ['7.0.0', undefined, '7.0.0-beta.6']) {
			const info = manifest({ ...OPTED_IN, channel: 'master', clientRelease });
			expect(info.files.some((item) => item.channel === 'prerelease')).toBe(false);
			expect(info.files.some((item) => item.release !== undefined)).toBe(false);
			expect(info.files.some((item) => /-(alpha|beta|rc)\./.test(item.url))).toBe(false);
			expect(info.info.channels).toEqual(['master']);
		}
	});

	test('a master asker BELOW the stable release of its triple is offered that release (a release is no exposure)', () => {
		const info = manifest({ ...OPTED_IN, channel: 'master', clientRelease: '7.0.0-beta.6' });
		expect(offered(info)).toEqual(['7.0.0']);
		// …and one AT it (or not saying) is offered nothing of its own triple
		expect(offered(manifest({ ...OPTED_IN, channel: 'master', clientRelease: '7.0.0' }))).toEqual(
			[],
		);
		expect(offered(manifest({ ...OPTED_IN, channel: 'master' }))).toEqual([]);
	});

	test("a PRERELEASE asker at beta.6 sees beta.7 AND 7.0.0 above it, then the rung's newest prerelease", () => {
		const info = manifest({ ...OPTED_IN, channel: 'prerelease', clientRelease: '7.0.0-beta.6' });
		expect(offered(info)).toEqual(['7.0.0-beta.7', '7.0.0', '7.0.1-beta.1']);
		expect(info.info.channels).toEqual(['master', 'prerelease']);
		const beta7 = info.files[0];
		// version = the DATA triple (every update door parses it), the identity beside it
		expect(beta7).toMatchObject({
			version: '7.0.0',
			release: '7.0.0-beta.7',
			channel: 'prerelease',
			url: 'http://m/7.0.0/7.0.0-beta.7.zip',
			sha256: shaOf('7.0.0-beta.7.zip'),
		});
		// the prerelease's OWN frozen notes, never its triple's
		expect(beta7?.notes?.entries.map((entry) => entry.title)).toEqual(['B7.']);
		// the stable item of the triple is a plain published item
		expect(Object.hasOwn(info.files[1] as object, 'channel')).toBe(false);
		// beta.6 itself (the running identity) and the foreign `-pre.1` are not offered
		expect(info.files.some((item) => item.url.includes('beta.6'))).toBe(false);
		expect(info.files.some((item) => item.url.includes('-pre.'))).toBe(false);
	});

	test('a master that did NOT opt into prereleases never advertises one, whatever is asked', () => {
		for (const channel of ['prerelease', 'dev'] as const) {
			const info = manifest({
				channel,
				clientRelease: '7.0.0-beta.6',
				prereleaseChannelEnabled: false,
				devChannelEnabled: true,
			});
			expect(info.files.some((item) => item.channel === 'prerelease')).toBe(false);
			expect(offered(info)).toEqual(['7.0.0']);
		}
		expect(
			manifest({ channel: 'prerelease', clientRelease: '7.0.0-beta.6' }).info.channels,
		).toEqual(['master']);
	});

	test('THE LADDER: a dev asker sees prereleases too; the two master switches stay separate', () => {
		const both = manifest({ ...OPTED_IN, channel: 'dev', clientRelease: '7.0.0-beta.6' });
		expect(offered(both)).toEqual(['7.0.0-beta.7', '7.0.0', '7.0.1-beta.1']);
		expect(both.info.channels).toEqual(['master', 'prerelease', 'dev']);
		// prerelease switch alone: a dev ask is honoured up to the prerelease rung
		const preOnly = manifest({
			channel: 'dev',
			clientRelease: '7.0.0-beta.6',
			prereleaseChannelEnabled: true,
			devChannelEnabled: false,
		});
		expect(preOnly.info.channels).toEqual(['master', 'prerelease']);
		expect(offered(preOnly)).toEqual(['7.0.0-beta.7', '7.0.0', '7.0.1-beta.1']);
		// a prerelease ask never reaches the developer rung, even with both on
		const preAsk = manifest({ ...OPTED_IN, channel: 'prerelease' });
		expect(preAsk.info.channels).toEqual(['master', 'prerelease']);
		expect(preAsk.files.some((item) => item.channel === 'dev')).toBe(false);
		// dev switch alone: a dev ask honours `dev` WITHOUT `prerelease` — the
		// answer must not claim the betas it did not expose (a "highest rung"
		// of 'dev' would, and the panel would then read "no prereleases here"
		// as "none exist")
		const devOnly = manifest({
			channel: 'dev',
			clientRelease: '7.0.0-beta.6',
			prereleaseChannelEnabled: false,
			devChannelEnabled: true,
		});
		expect(devOnly.info.channels).toEqual(['master', 'dev']);
		expect(devOnly.files.some((item) => item.channel === 'prerelease')).toBe(false);
	});

	test("§2.8.5 bootstrap: a DEVELOPER BUILD asking on dev is offered every tag of its triple (the walk's dev exception)", () => {
		// beta.6 reports its bare triple; it installs 7.0.0-dev.zip and then
		// runs 7.0.0.dev — which may sit before or after any tag of 7.0.0, so
		// each tag-built archive is a legal next step (version_walk.ts
		// sameTripleRefusal), in release order, then the next rung's newest
		const dev = manifest({ ...OPTED_IN, channel: 'dev', clientRelease: '7.0.0.dev' });
		expect(offered(dev)).toEqual(['7.0.0-beta.6', '7.0.0-beta.7', '7.0.0', '7.0.1-beta.1']);
		// each item keeps its OWN kind token: what the tree becomes, never `dev`
		expect(dev.files.find((item) => item.release === '7.0.0-beta.7')?.channel).toBe('prerelease');
		expect(Object.hasOwn(dev.files[2] as object, 'channel')).toBe(false);
		// the prereleases still need THIS master's prerelease switch; the release does not
		const devOnly = manifest({
			channel: 'dev',
			clientRelease: '7.0.0.dev',
			prereleaseChannelEnabled: false,
			devChannelEnabled: true,
		});
		expect(offered(devOnly)).toEqual(['7.0.0']);
		// off the dev ask a .dev is its bare triple: nothing of 7.0.0 is newer,
		// and a master ask never sees a prerelease
		expect(
			offered(manifest({ ...OPTED_IN, channel: 'master', clientRelease: '7.0.0.dev' })),
		).toEqual([]);
		expect(
			offered(manifest({ ...OPTED_IN, channel: 'prerelease', clientRelease: '7.0.0.dev' })),
		).toEqual(['7.0.1-beta.1']);
		// a .dev of ANOTHER triple is no claim about this asker (askerIdentity)
		expect(offered(manifest({ ...OPTED_IN, channel: 'dev', clientRelease: '7.0.9.dev' }))).toEqual([
			'7.0.1-beta.1',
		]);
	});

	test('an untrusted release claim places the asker at its bare triple — never higher exposure, never a throw', () => {
		// a claim of ANOTHER triple — below it would make every archive of 7.0.0
		// "above" the asker — is no claim about this asker at all
		for (const clientRelease of [
			'6.0.0-beta.1',
			'6.9.9',
			'9.9.9-beta.1',
			'7.0.0-beta.6; rm -rf /',
			'7.0.0-pre.1',
			42,
			null,
		]) {
			const info = manifest({ ...OPTED_IN, channel: 'prerelease', clientRelease });
			// nothing of the 7.0.0 triple (the bare triple = its stable release)
			expect(offered(info)).toEqual(['7.0.1-beta.1']);
		}
	});

	test("a rung's STABLE release outranks its prereleases: one item per rung, the newest identity", () => {
		const stable = join(PRE_FILES, '7', '7.0', '7.0.1.zip');
		writeFileSync(stable, 'PK-7.0.1');
		writeFileSync(`${stable}.sha256`, `${shaOf('7.0.1.zip')}  7.0.1.zip\n`);
		try {
			const info = manifest({ ...OPTED_IN, channel: 'prerelease', clientRelease: '7.0.0' });
			expect(offered(info)).toEqual(['7.0.1']);
		} finally {
			rmSync(stable, { force: true });
			rmSync(`${stable}.sha256`, { force: true });
		}
	});

	test('readReleaseNotes reads a prerelease identity and refuses anything outside the grammar', () => {
		expect(readReleaseNotes(PRE_CHANGES, '7.0.0-beta.7')?.entries).toHaveLength(1);
		for (const bad of ['../7.0.0-beta.7', '7.0.0-beta.7/..', '7.0.0-pre.1', '07.0.0']) {
			expect(readReleaseNotes(PRE_CHANGES, bad)).toBeNull();
		}
	});
});

describe('release notes on the manifest', () => {
	const CHANGES = join(ROOT, 'changes');
	const devZip = join(FILES_DIR, '7', '7.0', '7.0.0-dev.zip');
	const fragment = (slug: string, front: string) =>
		parseFragment(`changes/7.0.1/${slug}.md`, `---\n${front}\n---\nBody.\n`);
	// the notes the release command would freeze, from REAL parsed fragments
	const NOTES = deriveReleaseNotes([
		fragment(
			'rename-key',
			'title: Rename DEDALO_X to DEDALO_Y.\ntype: changed\naudience: admin\ndate: 2026-10-01\nbreaking: true',
		),
		fragment(
			'faster-search',
			'title: Search is faster.\ntype: fixed\naudience: user\ndate: 2026-10-02',
		),
	]);
	const snapshot = (version: string, extra: Record<string, unknown>) => {
		mkdirSync(join(CHANGES, version), { recursive: true });
		writeFileSync(
			join(CHANGES, version, 'release.json'),
			JSON.stringify({
				version,
				date: '2026-10-05',
				from: 'v7.0.0',
				to: `v${version}`,
				commits: 3,
				wire_contract: [],
				...extra,
			}),
		);
	};

	beforeAll(() => {
		snapshot('7.0.1', { notes: NOTES });
		// a snapshot for the DEV item's version too: it must still carry no notes
		snapshot('7.0.0', { notes: NOTES });
		writeFileSync(devZip, 'PK-dev');
	});
	afterAll(() => {
		rmSync(CHANGES, { recursive: true, force: true });
		rmSync(devZip, { force: true });
	});

	function manifest(changesDir: string | undefined, channel: 'master' | 'dev' = 'master') {
		return buildCodeUpdateInfo({
			clientVersion: [7, 0, 0],
			serverVersion: [7, 0, 1],
			codeFilesDir: FILES_DIR,
			publicBaseUrl: 'http://m',
			info: { ...BASE_INFO },
			catalog: catalogOf(target(7, 0, 1)),
			channel,
			devChannelEnabled: true,
			changesDir,
		});
	}

	test('the derivation under test is not empty (anti-vacuity)', () => {
		expect(NOTES.action_needed).toEqual(['Rename DEDALO_X to DEDALO_Y.']);
		expect(NOTES.entries.length).toBe(2);
	});

	test('a published item carries {date, …notes}, exactly as the release froze them', () => {
		const item = manifest(CHANGES).files.find((f) => f.version === '7.0.1');
		expect(item?.notes).toEqual({ date: '2026-10-05', ...NOTES });
	});

	test('a developer item NEVER carries notes, even with a snapshot for its version', () => {
		const files = manifest(CHANGES, 'dev').files;
		const dev = files.find((f) => f.channel === 'dev');
		expect(dev).toBeDefined();
		expect('notes' in (dev ?? {})).toBe(false);
		// …while the published item in the same answer does (positive control)
		expect(files.find((f) => f.channel === undefined)?.notes).toBeDefined();
	});

	test('no changesDir, no snapshot, or a snapshot without notes: the field is absent', () => {
		expect('notes' in (manifest(undefined).files[0] ?? {})).toBe(false);
		expect('notes' in (manifest(join(ROOT, 'nowhere')).files[0] ?? {})).toBe(false);
		snapshot('7.0.1', {});
		try {
			expect('notes' in (manifest(CHANGES).files[0] ?? {})).toBe(false);
		} finally {
			snapshot('7.0.1', { notes: NOTES });
		}
	});

	test('a malformed snapshot never throws and never half-serves', () => {
		const broken: unknown[] = [
			{ action_needed: 'x', entries: [] },
			{ action_needed: [], entries: [{ type: 'fixed', audience: 'user' }] },
			{ action_needed: [1], entries: [] },
			null,
		];
		try {
			for (const notes of broken) {
				snapshot('7.0.1', { notes });
				expect(readReleaseNotes(CHANGES, '7.0.1')).toBeNull();
			}
			writeFileSync(join(CHANGES, '7.0.1', 'release.json'), '{');
			expect(readReleaseNotes(CHANGES, '7.0.1')).toBeNull();
			// a version that is not a triple is never joined into a path
			expect(readReleaseNotes(CHANGES, '../7.0.1')).toBeNull();
		} finally {
			snapshot('7.0.1', { notes: NOTES });
		}
	});
});

describe('codeReleasePath (filename-grammar gate + layout)', () => {
	test('a well-formed release name resolves to <dir>/<major>/<major.minor>/<file>', () => {
		expect(codeReleasePath(FILES_DIR, [7, 0, 1], '7.0.1.zip')).toBe(
			join(FILES_DIR, '7', '7.0', '7.0.1.zip'),
		);
	});

	test('the -dev channel resolves through the SAME confinement (servable, never advertised)', () => {
		// `code_build_plan.ts` names non-master builds `<v>-dev.zip`; the grammar
		// admits exactly that fixed token so code_serving.ts can serve a developer
		// build for manual testing. The suffix is a fixed sanitized token — no
		// ref bytes reach the path, so confinement is unchanged.
		expect(codeReleasePath(FILES_DIR, [7, 0, 1], '7.0.1-dev.zip')).toBe(
			join(FILES_DIR, '7', '7.0', '7.0.1-dev.zip'),
		);
		for (const bad of ['7.0.1-devx.zip', '7.0.1-dev.tar', '../7.0.1-dev.zip', '7.0.1-DEV.zip']) {
			expect(codeReleasePath(FILES_DIR, [7, 0, 1], bad)).toBeNull();
		}
	});

	test('a PRERELEASE archive resolves in its triple dir; only the shared grammar does (design §2.8)', () => {
		for (const name of ['7.0.1-beta.1.zip', '7.0.1-rc.12.zip', '7.0.1-alpha.0.zip']) {
			expect(codeReleasePath(FILES_DIR, [7, 0, 1], name)).toBe(join(FILES_DIR, '7', '7.0', name));
		}
		expect(releaseArchiveNameOf('7.0.1-beta.2.zip')).toEqual({
			triple: '7.0.1',
			kind: 'prerelease',
			identity: '7.0.1-beta.2',
		});
		expect(releaseArchiveNameOf('7.0.1.zip')).toEqual({
			triple: '7.0.1',
			kind: 'stable',
			identity: '7.0.1',
		});
		expect(releaseArchiveNameOf('7.0.1-dev.zip')).toEqual({
			triple: '7.0.1',
			kind: 'dev',
			identity: null,
		});
		for (const bad of [
			'7.0.1-pre.1.zip', // foreign label
			'7.0.1-beta.01.zip', // non-canonical
			'07.0.1.zip',
			'7.0.1-beta.zip',
			'7.0.1-beta.1-dev.zip',
			'7.0.1-beta.1.zip.partial',
			'7.0.1.dev.zip',
			'../7.0.1-beta.1.zip',
			'7.0.1-BETA.1.zip',
		]) {
			expect(codeReleasePath(FILES_DIR, [7, 0, 1], bad), bad).toBeNull();
		}
	});

	test('anything that is not <n.n.n>.zip is refused (traversal, extension, non-numeric)', () => {
		// The regex is the ONLY gate that fires in practice — the directory
		// segments are built from numbers, so the resolve/startsWith confinement
		// check below it is unreachable via this entry point.
		for (const name of ['../../etc/passwd', '7.0.1.tar', 'a.b.c.zip', '7.0.1.zip.sh', '']) {
			expect(codeReleasePath(FILES_DIR, [7, 0, 1], name)).toBeNull();
		}
		// a traversal DISGUISED as a release name is still rejected by the regex
		expect(codeReleasePath(FILES_DIR, [7, 0, 1], '../7.0.1.zip')).toBeNull();
	});

	// The three cases below drive the SECOND gate — the resolve/startsWith
	// confinement — which the filename regex above can never reach. The triple
	// is typed `readonly number[]`, so only a caller that passes non-numeric
	// segments (a mis-parsed client version, a future caller that forwards
	// user input as the triple) gets there; the cast makes that reachable.
	// Without these, the whole `startsWith` line has zero assertion coverage
	// and any weakening of it stays green.
	function pathWithTriple(dir: string, triple: readonly unknown[], name: string): string | null {
		return codeReleasePath(dir, triple as readonly number[], name);
	}

	test('a triple segment that ESCAPES the release dir is refused', () => {
		// dir = join('/base', '..', '...') -> '/tmp/...' : fully outside the
		// configured release dir. Catches deletion of the confinement check.
		expect(pathWithTriple('/tmp/dedalo_base', ['..', ''], '7.0.1.zip')).toBeNull();
		expect(pathWithTriple('/tmp/dedalo_base', ['../../etc', 'x'], '7.0.1.zip')).toBeNull();
	});

	test('a SIBLING dir sharing the release dir as a string PREFIX is refused', () => {
		// The classic prefix hole: '/tmp/dedalo_base_evil/...' startsWith
		// '/tmp/dedalo_base' as a plain string, but is NOT inside it. Only the
		// trailing-separator form of the check rejects it — this case goes red
		// the moment `${resolve(dir)}${sep}` degrades to `resolve(dir)`.
		expect(pathWithTriple('/tmp/dedalo_base', ['../dedalo_base_evil', 0], '7.0.1.zip')).toBeNull();
		// same hole reached without '..' in the second segment
		expect(pathWithTriple('/tmp/dedalo_base', ['../dedalo_base_x', 9], '7.0.1.zip')).toBeNull();
	});

	test('a RELATIVE codeFilesDir is resolved on BOTH sides before comparing', () => {
		// The candidate is always absolute (resolve of the joined path); if the
		// prefix were compared unresolved ('rel_base') the check would reject
		// every legitimate release under a relative config value.
		const got = pathWithTriple('rel_base', [7, 0, 1], '7.0.1.zip');
		expect(got).toBe(join(process.cwd(), 'rel_base', '7', '7.0', '7.0.1.zip'));
	});
});
