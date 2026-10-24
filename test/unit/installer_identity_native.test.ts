/**
 * THE INSTALLER'S RELEASE IDENTITY (src/core/install/installer_identity.ts; design
 * RELEASE_IDENTITY §2.4/§2.5, owner Q1/Q6, 2026-10-15).
 *
 * WHAT IS MEASURED (outcomes):
 *  - unpinned, the installer IS the running tree's identity (build_stamp.ts RELEASE_IDENTITY);
 *  - the image version and the accepted set derive from the identity's kind: stable `X.Y.Z`,
 *    prerelease `X.Y.Z-beta.N` (never the bare triple), dev `X.Y.Z-dev`; the explicit `-dev`
 *    tag of the same data version is the one other accepted tag (§2.4);
 *  - the plan: Official preselected for stable/prerelease, Build for dev; Official refused on
 *    its own question for dev; another tag refused naming the accepted ones;
 *  - the header label says the kind;
 *  - THE SEAM CANNOT REACH AN INSTALLATION: outside a test process (a real child with
 *    NODE_ENV=production) a set DEDALO_INSTALL_RELEASE_IDENTITY refuses the installer — and
 *    inside one, an identity of another data version is refused. Control: the same child
 *    without the key answers the tree's identity.
 *  - GATE 12, THE DOCS AGREE WITH THE CODE: the docker.md table of identity → image tag →
 *    Official is re-derived row by row (imageTagOf, installerVersionLabel, the dev refusal);
 *    no install page or screen text still says official images are stable-only; quickstart
 *    and the reference point at the table; the Q4 note (a beta Build's bare `7.0.0` pin needs
 *    ONE --skip-version-check) is there, and its reason holds (the comparator orders a
 *    prerelease BEFORE the bare release).
 *
 * DB-FREE, network-free.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { acceptedImageVersions, imageVersionOf } from '../../src/core/install/host/stack/layout.ts';
import { buildInstallPlan } from '../../src/core/install/install_plan.ts';
import {
	INSTALLER_IDENTITY_SEAM,
	installerIdentity,
	installerVersionLabel,
} from '../../src/core/install/installer_identity.ts';
import { OPTION_TEXT, QUESTION_TEXT } from '../../src/core/install/screen_text.ts';
import { RELEASE_IDENTITY } from '../../src/core/update/build_stamp.ts';
import { compareReleaseIdentities, imageTagOf } from '../../src/core/update/release_identity.ts';
import { DEDALO_VERSION } from '../../src/core/update/version.ts';
import { PINNED_IDENTITY, withInstallerIdentity } from '../helpers/installer_identity.ts';
import { escapeRegExp } from '../helpers/regex_escape.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const TRIAL = { route: 'trial', entity: 'trial_museum' };
const PLAN_OPTIONS = { rootPassword: 'Sentinel-Root-Kestrel-91', requireRootPassword: true };
/** The data version docs/install/docker.md uses in its examples (not necessarily the current one). */
const DOCS_EXAMPLE_TRIPLE = '7.0.0';

describe('the identity decides the image and the source', () => {
	test('unpinned: the installer is the running tree', () => {
		expect(process.env[INSTALLER_IDENTITY_SEAM]).toBeUndefined();
		expect(installerIdentity()).toBe(RELEASE_IDENTITY);
	});

	const CASES = [
		{
			pinned: PINNED_IDENTITY.stable,
			kind: 'stable',
			tag: DEDALO_VERSION,
			accepted: [DEDALO_VERSION, `${DEDALO_VERSION}-dev`],
			source: 'official',
			label: DEDALO_VERSION,
		},
		{
			pinned: PINNED_IDENTITY.prerelease,
			kind: 'prerelease',
			tag: PINNED_IDENTITY.prerelease,
			accepted: [PINNED_IDENTITY.prerelease, `${DEDALO_VERSION}-dev`],
			source: 'official',
			label: `${PINNED_IDENTITY.prerelease} (prerelease)`,
		},
		{
			pinned: PINNED_IDENTITY.dev,
			kind: 'dev',
			tag: `${DEDALO_VERSION}-dev`,
			accepted: [`${DEDALO_VERSION}-dev`],
			source: 'build',
			label: `${PINNED_IDENTITY.dev} (development build)`,
		},
	] as const;

	for (const c of CASES) {
		test(`${c.kind} (${c.pinned}): image ${c.tag}, accepted ${c.accepted.join(' | ')}, ${c.source} preselected`, async () => {
			await withInstallerIdentity(c.pinned, () => {
				expect(installerIdentity().kind).toBe(c.kind);
				const plan = buildInstallPlan(TRIAL, PLAN_OPTIONS);
				expect(plan.errors).toEqual([]);
				expect(plan.answers.image_source).toBe(c.source);
				expect(imageVersionOf(plan.answers)).toBe(c.tag);
				expect(acceptedImageVersions()).toEqual([...c.accepted]);
				expect(installerVersionLabel()).toBe(c.label);
				// a tag that is not this installer's is refused on its question, naming the accepted ones
				for (const other of [DEDALO_VERSION, `${DEDALO_VERSION}-beta.6`, '9.9.9'].filter(
					(tag) => !(c.accepted as readonly string[]).includes(tag),
				)) {
					const refused = buildInstallPlan(
						{
							...TRIAL,
							image_source: 'custom',
							image_repository: 'registry.example.org/d',
							image_version: other,
						},
						PLAN_OPTIONS,
					).fieldErrors.filter((error) => error.key === 'image_version');
					expect(refused.map((error) => error.message).join('\n')).toContain(
						`(${c.accepted.join(' or ')})`,
					);
				}
				// Official chosen explicitly: refused on its question for a dev build only
				const official = buildInstallPlan({ ...TRIAL, image_source: 'official' }, PLAN_OPTIONS);
				expect(official.fieldErrors.some((error) => error.key === 'image_source')).toBe(
					c.kind === 'dev',
				);
			});
		});
	}

	test('a beta never installs the bare data version: the stable tag is refused for a prerelease installer', async () => {
		await withInstallerIdentity(PINNED_IDENTITY.prerelease, () => {
			expect(acceptedImageVersions()).not.toContain(DEDALO_VERSION);
		});
	});
});

describe('the seam cannot reach an installation', () => {
	/** A fresh bun child asked for the installer identity (or the refusal), in `nodeEnv`. */
	function childIdentity(nodeEnv: string, pinned: string | null): { code: number; out: string } {
		const env: Record<string, string> = {
			PATH: process.env.PATH ?? '/usr/bin:/bin',
			NODE_ENV: nodeEnv,
		};
		if (pinned !== null) env[INSTALLER_IDENTITY_SEAM] = pinned;
		const run = Bun.spawnSync(
			[
				process.execPath,
				'-e',
				`const m = await import(${JSON.stringify(join(REPO_ROOT, 'src/core/install/installer_identity.ts'))});
try { console.log('ID ' + m.installerIdentity().version); } catch (e) { console.log('REFUSED ' + (e.publicMessage ?? e.message)); }`,
			],
			{ cwd: REPO_ROOT, env },
		);
		return { code: run.exitCode, out: run.stdout.toString().trim() };
	}

	test('outside a test process a set key REFUSES the installer (never honoured, never silently ignored)', () => {
		const refused = childIdentity('production', PINNED_IDENTITY.prerelease);
		expect(refused.out).toStartWith('REFUSED ');
		expect(refused.out).toContain(`${INSTALLER_IDENTITY_SEAM} is a test seam`);
		// CONTROL: the same child unpinned answers the tree's identity; pinned in a test process, the pin
		expect(childIdentity('production', null).out).toBe(`ID ${RELEASE_IDENTITY.version}`);
		expect(childIdentity('test', PINNED_IDENTITY.prerelease).out).toBe(
			`ID ${PINNED_IDENTITY.prerelease}`,
		);
	});

	test('inside a test process, an identity of another data version (or none) is refused', async () => {
		for (const bad of ['6.9.0', '6.9.0-beta.1', `${DEDALO_VERSION}-pre.1`, 'latest']) {
			await withInstallerIdentity(bad, () => {
				expect(() => installerIdentity()).toThrow('is not a release identity of this data version');
			});
		}
	});
});

describe('gate 12: the install docs say what the installer does', () => {
	const read = (doc: string): string => readFileSync(join(REPO_ROOT, doc), 'utf8');
	const DOCS = [
		'docs/install/docker.md',
		'docs/install/quickstart.md',
		'docs/install/installer_reference.md',
	];

	test('docker.md: every row of the identity table is the code’s own derivation', async () => {
		const docker = read('docs/install/docker.md');
		// The docs name an example data version (DOCS_EXAMPLE_TRIPLE); the seam only pins identities of
		// THIS data version. The table is re-read with the example triple as the current one, so the gate
		// checks the identity → tag → Official MAPPING and survives every version bump (cf. 259e6dc419).
		const section = docker
			.slice(
				docker.indexOf('### Which official image the installer asks for'),
				docker.indexOf("### Dédalo's registries"),
			)
			.replace(new RegExp(`\\b${escapeRegExp(DOCS_EXAMPLE_TRIPLE)}\\b`, 'g'), DEDALO_VERSION);
		expect(section).toContain(`a stable release (\`${DEDALO_VERSION}\`)`);
		const rows = section
			.split('\n')
			.filter((line) => /^\| a (stable release|prerelease|development build) /.test(line));
		expect(rows.length).toBe(3);
		for (const row of rows) {
			const [, who, tag, official] = row.split('|').map((cell) => cell.trim());
			const identity = /\(`([^`]+)`\)/.exec(who ?? '')?.[1] ?? '';
			await withInstallerIdentity(identity, () => {
				expect({ identity, tag }).toEqual({ identity, tag: `\`${imageTagOf(identity)}\`` });
				expect(imageVersionOf(buildInstallPlan(TRIAL, PLAN_OPTIONS).answers)).toBe(
					imageTagOf(identity),
				);
				if (installerIdentity().kind === 'dev') {
					expect(official).toContain('no registry is asked');
					expect(official).toContain('**Build** is preselected');
					expect(buildInstallPlan(TRIAL, PLAN_OPTIONS).answers.image_source).toBe('build');
				} else {
					expect(official).toContain(`\`:${imageTagOf(identity)}\``);
				}
				// the header the section quotes is the installer's own label
				expect(section).toContain(`\`${installerVersionLabel()}\``);
			});
		}
	});

	test('no install page or screen text still says official images are for stable releases only; the pages point at the table', () => {
		const STALE = /stable releases only|STABLE releases only|a beta needs a local build/i;
		for (const doc of DOCS)
			expect({ doc, stale: STALE.test(read(doc)) }).toEqual({ doc, stale: false });
		const screen = JSON.stringify({ QUESTION_TEXT, OPTION_TEXT });
		expect(STALE.test(screen)).toBe(false);
		for (const doc of ['docs/install/quickstart.md']) {
			expect(read(doc)).toContain('docker.md#which-official-image-the-installer-asks-for');
		}
		// the released beta.6 note still lands somewhere (the old anchor is kept)
		expect(read('docs/install/docker.md')).toContain(
			'<a id="official-images-are-stable-releases-only"></a>',
		);
	});

	test('Q4: a beta Build’s bare 7.0.0 pin updates to the first prerelease-named image with ONE --skip-version-check — and the reason holds', () => {
		const docker = read('docs/install/docker.md');
		const note = docker.slice(
			docker.indexOf('### A stack installed from a beta before 7.0.0-beta.7'),
		);
		expect(note.length).toBeGreaterThan(200);
		const body = note.slice(
			0,
			note.indexOf('\n### ', 10) === -1 ? undefined : note.indexOf('\n### ', 10),
		);
		expect(body).toContain('DEDALO_VERSION=7.0.0`');
		expect(body).toContain('--version 7.0.0-beta.7 --skip-version-check');
		expect(body).toContain('once');
		// why: a prerelease orders BEFORE the bare release of its triple, so the move reads as a downgrade
		expect(compareReleaseIdentities('7.0.0-beta.7', '7.0.0')).toBe(-1);
		expect(body).toContain('reads as a downgrade');
	});
});
