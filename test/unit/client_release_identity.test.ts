/**
 * CLIENT READERS OF THE RELEASE IDENTITY (release identity design gates 3 + 4,
 * client half; common/js/release_identity.js).
 *
 * `page_globals.dedalo_version` became the engine's RELEASE IDENTITY
 * (`7.0.0-beta.6` on a tagged build). Three client readers used to split it on
 * dots and read numbers, which the `.dev` form survived only because `.dev` is
 * a 4th segment:
 *   - render_page.js compared `7.0.0-beta` with the data version `7.0.0` →
 *     EVERY page rendered the update-data widget instead of the app;
 *   - update_ontology.js read [7,0,NaN,6] → an ontology needing 7.0.1 passed
 *     as supported (NaN compares false both ways);
 *   - update_code.js / render_update_ontology.js sent it as the asker's
 *     version → a master (and every OLDER master: three integers only) refused
 *     it as 'Invalid version number'.
 *
 * What this gate holds:
 *   1. the leaf's outcomes: its data triple equals the SERVER's for every
 *      identity of the shared ordering fixture, and it refuses every
 *      non-identity; the ontology requirement check answers correctly for
 *      prerelease / dev / stable identities;
 *   2. no client source reads the identity numerically or sends it as a
 *      version any more (the regression shape, scanned over client/ + tools/).
 *
 * Honest limit: layer 2 proves the call shape. The page's version gate and
 * the code-update ask are EXECUTED in client_release_identity_wire.test.ts
 * (gates 3 and 4: render_page and update_code run against stubbed leaves).
 *
 * DB-less, network-less → hermetic tier.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
	code_satisfies,
	data_version_of,
} from '../../client/dedalo/core/common/js/release_identity.js';
import { parseReleaseVersion } from '../../src/core/update/release_identity.ts';

const ROOT = join(import.meta.dir, '..', '..');
const ORDERING = JSON.parse(
	readFileSync(join(ROOT, 'test/fixtures/release_identity/ordering.json'), 'utf8'),
) as {
	ascending: string[];
	dev: string[];
	dev_below_stable: [string, string][];
	not_identities: string[];
};

describe('data_version_of — the client mirror of the one grammar', () => {
	// the developer identities are listed among the ascending ones (they are identities too)
	const identities = [...ORDERING.ascending];

	test('the fixture is not empty (anti-vacuity)', () => {
		expect(identities.length).toBeGreaterThan(20);
		expect(ORDERING.not_identities.length).toBeGreaterThan(10);
	});

	test("every release identity of the shared fixture → the SERVER's data triple; a developer one → ''", () => {
		for (const identity of identities) {
			const server = parseReleaseVersion(identity);
			expect(server, identity).not.toBeNull();
			const expected = server?.dev ? '' : (server?.triple.join('.') ?? '');
			expect(data_version_of(identity), identity).toBe(expected);
		}
	});

	test("every non-identity → '' (the server refuses them too)", () => {
		for (const value of ORDERING.not_identities) {
			expect(parseReleaseVersion(value), value).toBeNull();
			expect(data_version_of(value), value).toBe('');
		}
		expect(data_version_of(undefined)).toBe('');
		expect(data_version_of(null)).toBe('');
	});
});

describe("code_satisfies — an ontology's minimum code version against the running identity", () => {
	test.each([
		['7.0.1', '7.0.0-beta.6', false], // the NaN that used to wave this through
		['7.0.1', '7.0.0.dev', false],
		['7.0.0', '7.0.0-beta.6', true],
		['7.0.0', '7.0.0', true],
		['6.9.0', '6.10.0', true], // numeric, not lexical
		['6.10.0', '6.9.0', false],
		['7.0', '7.0.3-rc.1', true], // a shorter requirement
		['7.1', '7.0.3', false],
		['7.0.0', 'nonsense', false], // an unreadable code version is never "supported"
		['7.x', '7.0.0', false],
	] as const)('requires %p, running %p → %p', (required, running, expected) => {
		expect(code_satisfies(required, running)).toBe(expected);
	});
});

/** Every shipped client .js (client/ + tools/), tests excluded. */
function clientSources(): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			if (name === 'node_modules' || name === 'test' || name === 'vendor') continue;
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (name.endsWith('.js') && !name.endsWith('.min.js')) out.push(path);
		}
	};
	walk(join(ROOT, 'client', 'dedalo'));
	walk(join(ROOT, 'tools'));
	return out;
}

describe('no client source reads the release identity as numbers or sends it as a version (gate 4, client half)', () => {
	const sources = clientSources();
	// `dedalo_version` (page_globals' identity) split on dots, or posted as a
	// request's `version`. `data_version_of(page_globals.dedalo_version)` is the
	// door; a value read for display or as an opaque cache key is untouched.
	const NUMERIC_READ = /\bdedalo_version\??\.split\s*\(/;
	const SENT_AS_VERSION = /\bversion\s*:\s*page_globals\.dedalo_version\b/;

	test('the scan reads the client tree (anti-vacuity) and finds its door in use', () => {
		expect(sources.length).toBeGreaterThan(200);
		const users = sources.filter((path) =>
			readFileSync(path, 'utf8').includes("/common/js/release_identity.js'"),
		);
		expect(users.map((path) => relative(ROOT, path)).sort()).toEqual([
			'client/dedalo/core/area_maintenance/widgets/update_code/js/update_code.js',
			'client/dedalo/core/area_maintenance/widgets/update_ontology/js/render_update_ontology.js',
			'client/dedalo/core/area_maintenance/widgets/update_ontology/js/update_ontology.js',
			'client/dedalo/core/page/js/render_page.js',
		]);
	});

	test('the regression shapes are absent', () => {
		const offenders = sources
			.filter((path) => {
				const src = readFileSync(path, 'utf8');
				return NUMERIC_READ.test(src) || SENT_AS_VERSION.test(src);
			})
			.map((path) => relative(ROOT, path));
		expect(offenders).toEqual([]);
	});

	test('the shapes the scan looks for are the ones that broke (positive control)', () => {
		expect(NUMERIC_READ.test(`page_globals?.dedalo_version?.split('.')`)).toBe(true);
		expect(NUMERIC_READ.test(`page_globals.dedalo_version.split('.').map(Number)`)).toBe(true);
		expect(SENT_AS_VERSION.test('version\t: page_globals.dedalo_version,')).toBe(true);
	});
});
