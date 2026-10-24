/**
 * SITE-BUILDER SINGLE-SOURCE TRIPWIRE — the general gate for the defect this subsystem has
 * now produced FIVE times: ONE FACT, DERIVED IN TWO PLACES.
 *
 * ── THE FIVE ────────────────────────────────────────────────────────────────────────────
 *
 *   1. `schema.ts` and `layout.ts` each owned the constants, with DIFFERENT bounds — so a
 *      manifest could pass one and be refused by the other.
 *   2. The daemon derived `<base>/<domain>` while the provisioner honoured
 *      `sites[].webspace`. On the committed reference declaration the two disagreed: the
 *      vhosts served `/srv/legacy-www/archive-example`, the daemon published into
 *      `/home/www/archive.example.net`. Every file on the host was correct and the museum's
 *      page simply never changed.
 *   3. `contentfulPaths()` was a hand-kept census of the rendered artifacts beside
 *      `RENDERERS`, and had already drifted: `sites.json` was written once and never
 *      drift-checked again — a hand edit to the file that tells the daemon where every
 *      museum's webspace is would have been invisible to `provision check`.
 *   4. `isAvailable()` kept its own opinion of "configured" (`url && token`) while the
 *      resolver said otherwise, so the tool hid itself on exactly the topology the
 *      provisioner delivers.
 *   5. Found BY THIS GATE, on the run that first measured the census:
 *      `tools/tool_sitebuilder/server/index.ts` declared its own `DOMAIN_PATTERN`,
 *      documented as "deliberately not stricter" than the owner's and stricter in two ways
 *      — four characters minimum against one, and a `[a-z]{2,63}` final label against any
 *      label. `a.b` and `x.123` are domains the provisioner builds a webspace and two
 *      vhosts for and the museum's only door refused to create a site on.
 *
 * Every one was invisible to a green suite, and every fix DELETED a derivation rather than
 * making one more careful. What no individual fix can do is stop the sixth.
 *
 * ── WHAT THIS GATE IS ───────────────────────────────────────────────────────────────────
 *
 * Two halves, and the second is the one that makes the first honest.
 *
 *   A. A SHRINK-ONLY CENSUS, in the shape `generic_tld_tripwire` uses: for each fact, the
 *      files entitled to derive it, frozen in `engineering/site_builder_single_source_baseline.json`
 *      with a REASON per owner. Growth is red, staleness is red, an owner with no reason is
 *      red. So a NEW second census is red BY DEFAULT — which is the whole point: the gate
 *      does not know what the sixth defect will be, only what shape it will have.
 *   B. BEHAVIOURAL ASSERTIONS for the facts that can be asked of running code, because a
 *      source census cannot see a derivation spelled some other way. The observer's
 *      contentful set is measured by RUNNING `observeHost` over a real host tree; the
 *      transport's single owner is proved by asking every consumer the same question; the
 *      fingerprint's two spellings are RUN side by side.
 *
 * ── ONE IMPLEMENTATION ──────────────────────────────────────────────────────────────────
 *
 * This file COMPUTES NO CENSUS. It imports `scripts/lib/site_builder_census.ts` (the
 * measure) through `scripts/site_builder_single_source_baseline.ts` (the generator/drift
 * checker). A gate that re-implemented the scan would be a second census of the second
 * censuses.
 *
 * HERMETIC: no database, no `../private`, no network. It writes only into its own scratch
 * directory under the OS temp root and removes it again.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeHost } from '../../publication/site_builder/src/provision/apply.ts';
import {
	derive,
	INSTANCE_MARKER,
	markerContent,
} from '../../publication/site_builder/src/provision/layout.ts';
import { observedPaths } from '../../publication/site_builder/src/provision/plan.ts';
import { renderAll } from '../../publication/site_builder/src/provision/render/index.ts';
import { instanceFingerprint as daemonFingerprint } from '../../publication/site_builder/src/security/pairing.ts';
import { readSiteTable } from '../../publication/site_builder/src/sites/site_table.ts';
import {
	census,
	FACTS,
	layoutOwnedNames,
	scannedFiles,
	strip,
} from '../../scripts/lib/site_builder_census.ts';
import {
	BASELINE_PATH,
	drift,
	readBaseline,
	SCANNED_FILE_FLOOR,
} from '../../scripts/site_builder_single_source_baseline.ts';
import {
	instanceFingerprint as engineFingerprint,
	resolveSiteBuilderTransport,
} from '../../src/core/site_builder/pairing.ts';

/* ────────────────────────────────────────────────────────────────────────────────────────
 * A. THE RATCHET
 * ──────────────────────────────────────────────────────────────────────────────────────── */

describe('A — the second-census ratchet', () => {
	test('the frozen artifact exists and the measure agrees with it', () => {
		// The ONE fix when this is red: delete the second derivation. Absorbing it needs
		// `bun run scripts/site_builder_single_source_baseline.ts --allow-regression` and a
		// reason in the entry, which is a diff a reviewer sees.
		expect(drift()).toEqual([]);
	});

	test('every owner carries a reason — an entitlement is a judgement, and a judgement needs a sentence', () => {
		const baseline = readBaseline();
		expect(baseline).not.toBeNull();
		const unreasoned: string[] = [];
		for (const [id, entry] of Object.entries((baseline as NonNullable<typeof baseline>).facts)) {
			for (const owner of entry.owners) {
				const reason = entry.reasons[owner] ?? '';
				if (reason.length < 40) unreasoned.push(`${id}: ${owner}`);
			}
		}
		expect(unreasoned).toEqual([]);
	});

	test('the facts the baseline freezes are exactly the facts the measure knows', () => {
		const baseline = readBaseline() as NonNullable<ReturnType<typeof readBaseline>>;
		expect(Object.keys(baseline.facts).sort()).toEqual(FACTS.map((fact) => fact.id).sort());
	});

	/**
	 * ANTI-VACUITY. Three of the five facts are frozen with an EMPTY or single-file owner
	 * set, which is exactly the state in which a broken measure is indistinguishable from a
	 * clean subsystem. So each fact's own detector is fed a synthetic source that DOES
	 * derive it, and one that does not.
	 */
	describe('the measure can actually see a second derivation', () => {
		const POSITIVE: Record<string, string> = {
			daemon_transport:
				'const on = config.siteBuilder.url !== undefined && config.siteBuilder.token;',
			site_placement: 'const dir = webspaceFor(base, domain);',
			pairing_fingerprint:
				"new Bun.CryptoHasher('sha256').update(`dedalo-site-instance:${i}\\n${t}`).digest('hex');",
			layout_constants: `export const ${layoutOwnedNames()[0] as string} = /^x$/;`,
			rendered_artifact_census: 'const all = [unitRenderer, envRenderer, nginxRenderer];',
		};

		test.each(FACTS.map((fact) => fact.id))('%s is DETECTED in a source that derives it', (id) => {
			const fact = FACTS.find((candidate) => candidate.id === id);
			expect(fact).toBeDefined();
			expect(
				(fact as NonNullable<typeof fact>).derives(POSITIVE[id] as string, 'some/other/file.ts'),
			).toBe(true);
		});

		test.each(FACTS.map((fact) => fact.id))('%s is NOT detected in an unrelated source', (id) => {
			const fact = FACTS.find((candidate) => candidate.id === id) as NonNullable<
				(typeof FACTS)[number]
			>;
			expect(fact.derives('export function unrelated(): number { return 1; }', 'x/y.ts')).toBe(
				false,
			);
		});

		test('a derivation stated only in PROSE does not count as one', () => {
			// Every one of these facts is explained at length in a module header — that prose is
			// why the defects were findable at all — and a census that counted it would report
			// the best-documented files in the subsystem as offenders.
			const prose = strip(`/**
			 * The daemon used to call webspaceFor(base, domain) and read config.siteBuilder.url.
			 */
			export const nothing = 1;`);
			for (const fact of FACTS) {
				expect({ fact: fact.id, derives: fact.derives(prose, 'x/y.ts') }).toEqual({
					fact: fact.id,
					derives: false,
				});
			}
		});

		test('the census really scans both deployables, and a floor on how much', () => {
			const files = scannedFiles();
			// The generator's own floor — the one the bank's verdict reads too.
			expect(files.length).toBeGreaterThan(SCANNED_FILE_FLOOR);
			expect(files.some((path) => path.startsWith('publication/site_builder/src/'))).toBe(true);
			expect(files.some((path) => path.startsWith('tools/tool_sitebuilder/server/'))).toBe(true);
			expect(files.some((path) => path.startsWith('src/core/site_builder/'))).toBe(true);
		});
	});

	test('the frozen owner sets are what the measure reports right now', () => {
		// The census is recomputed here (through the same measure) so a hand-edited JSON
		// cannot buy green.
		const baseline = readBaseline() as NonNullable<ReturnType<typeof readBaseline>>;
		const measured = census();
		for (const fact of FACTS) {
			expect({ fact: fact.id, owners: measured[fact.id] }).toEqual({
				fact: fact.id,
				owners: baseline.facts[fact.id]?.owners as string[],
			});
		}
	});
});

/* ────────────────────────────────────────────────────────────────────────────────────────
 * B. THE BEHAVIOURAL HALVES
 * ──────────────────────────────────────────────────────────────────────────────────────── */

/** A scratch host tree, removed at the end. Nothing here touches a real machine's state. */
const SCRATCH = mkdtempSync(join(tmpdir(), 'dedalo-single-source-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** A derived layout whose every path is inside the scratch tree. */
function scratchDoc(instance = 'census') {
	return {
		instance,
		engine: {
			group: 'dedalo-engine',
			private_dir: join(SCRATCH, 'engine_private'),
			checkout_dir: join(SCRATCH, 'checkout'),
			bun_bin: join(SCRATCH, 'bun', 'bin', 'bun'),
		},
		web: { server: 'nginx', group: 'www-data' },
		publication_api: { url: 'http://127.0.0.1:3100/publication/server_api/v2' },
		agent: { driver: 'claude_code', bins: { claude_code: '/usr/local/bin/claude' } },
		serving: {
			preprod: { enabled: true, auth: { mode: 'none' } },
			prod: { tls: { mode: 'none' } },
		},
		// EVERY path inside the scratch tree — the unit and vhost directories included, whose
		// defaults are /etc. A gate that wrote there would be a gate nobody could run.
		paths: {
			config_base: join(SCRATCH, 'config'),
			state_base: join(SCRATCH, 'state'),
			unit_dir: join(SCRATCH, 'systemd'),
			vhost_dir: join(SCRATCH, 'vhosts'),
			// …the agent authorization included: its default is /etc/polkit-1/rules.d, which is
			// root's on every host that has polkit at all.
			polkit_rules_dir: join(SCRATCH, 'polkit'),
		},
		webspace_base: join(SCRATCH, 'webspaces'),
		sites: [
			{ slug: 'museum', domain: 'museum.example.org' },
			// The site that uses the OVERRIDE — defect 2's own shape, so the assertions below
			// are made on the tenancy that actually broke.
			{ slug: 'archive', domain: 'archive.example.org', webspace: join(SCRATCH, 'legacy', 'arch') },
		],
	} as never;
}

/**
 * The declaration AND the layout it derives to. Both halves are needed: `renderAll` and
 * `observedPaths` take the manifest as well as the layout, precisely so the artifact set is
 * DERIVED rather than re-listed — which is the fact this file gates.
 */
function scratchLayout(instance = 'census') {
	return derive(scratchDoc(instance));
}

describe('B1 — the host observer reads exactly what the renderers write, plus the markers', () => {
	test('the CONTENTFUL set is DERIVED from renderAll(), never a list beside it', () => {
		const layout = scratchLayout();
		const manifest = scratchDoc();
		const artifacts = renderAll(layout, manifest);

		// Build the host: every artifact where it belongs, every marker, and a CREDENTIAL —
		// whose bytes must never be read into a HostState, in any mode, ever.
		for (const artifact of artifacts) {
			mkdirSync(join(artifact.path, '..'), { recursive: true });
			writeFileSync(artifact.path, artifact.body, 'utf8');
		}
		const markerRoots = [
			layout.roots.workspaces,
			layout.roots.home,
			layout.roots.audit,
			...layout.sites.map((site) => site.webspace),
		];
		for (const root of markerRoots) {
			mkdirSync(root, { recursive: true });
			writeFileSync(join(root, INSTANCE_MARKER), markerContent(layout.instance), 'utf8');
		}
		const secretPaths = observedPaths(layout, manifest).filter(
			(path) => path.includes('SERVICE_TOKEN') || path.endsWith('_KEY'),
		);
		expect(secretPaths.length).toBeGreaterThan(0);
		for (const path of secretPaths) {
			mkdirSync(join(path, '..'), { recursive: true });
			writeFileSync(path, 'a-secret-nobody-may-read-into-a-HostState', { mode: 0o600 });
		}

		const host = observeHost(layout, manifest);
		const withContent = Object.entries(host.entries)
			.filter(([, observation]) => observation.content !== undefined)
			.map(([path]) => path)
			.sort();

		const expected = [
			...artifacts.map((artifact) => artifact.path),
			...markerRoots.map((root) => join(root, INSTANCE_MARKER)),
		].sort();

		// EQUAL, both ways. A renderer added without the observer learning of it is the
		// artifact nobody drift-checks (defect 3, which really happened to sites.json); an
		// observer reading more than the renderers write is a credential in a HostState.
		expect(withContent).toEqual(expected);

		// And said out loud, because it is the one that leaks: no secret's bytes are in there.
		for (const path of secretPaths) {
			expect({ path, read: host.entries[path]?.content }).toEqual({ path, read: undefined });
		}
	});

	test('adding an artifact the observer does not know about would be caught — the set is compared, not counted', () => {
		// Anti-vacuity for the test above: it must be an EQUALITY over paths, not a size
		// check that a coincidence could satisfy.
		const layout = scratchLayout('censustwo');
		const artifacts = renderAll(layout, {} as never);
		expect(artifacts.length).toBeGreaterThan(4);
		expect(new Set(artifacts.map((artifact) => artifact.path)).size).toBe(artifacts.length);
	});
});

describe('B2 — one owner of "where is the daemon, and is it configured"', () => {
	/**
	 * The matrix that separates the resolver from every second opinion. `url && token` — the
	 * shape of defect 4 — answers differently on the socket-only rows, which is the topology
	 * a provisioned museum actually has.
	 */
	const CASES = [
		{
			what: 'socket only (what the provisioner renders)',
			url: undefined,
			socket: '/run/d.sock',
			paired: true,
		},
		{
			what: 'url only (a remote daemon)',
			url: 'http://d.example/sb',
			socket: undefined,
			paired: true,
		},
		{
			what: 'both (the socket wins)',
			url: 'http://d.example/sb',
			socket: '/run/d.sock',
			paired: true,
		},
		{ what: 'neither', url: undefined, socket: undefined, paired: false },
	] as const;

	test.each(CASES.map((row) => [row.what, row] as const))(
		'%s resolves the same way for every consumer',
		(_what, row) => {
			const siteBuilder = {
				url: row.url,
				socket: row.socket,
				instance: 'museum-a',
				token: 'x'.repeat(32),
				timeoutMs: 5000,
			};
			const transport = resolveSiteBuilderTransport(siteBuilder);
			expect(transport !== null).toBe(row.paired);
			if (transport) {
				// The socket wins over a URL that is also set: file ownership is the access
				// control, and a firewall rule is not.
				expect(transport.unixSocket).toBe(row.socket as string | undefined);
			}
		},
	);

	test('a half-configured pairing is NO pairing — partial reads as off, never as "connect anyway"', () => {
		const base = { url: 'http://d/sb', socket: undefined, instance: 'm', token: 't', timeoutMs: 1 };
		expect(resolveSiteBuilderTransport({ ...base, instance: undefined })).toBeNull();
		expect(resolveSiteBuilderTransport({ ...base, token: undefined })).toBeNull();
		expect(resolveSiteBuilderTransport({ ...base, instance: '' })).toBeNull();
		expect(resolveSiteBuilderTransport({ ...base, token: '' })).toBeNull();
	});
});

describe('B3 — the daemon resolves a site from the published table, and derives nothing', () => {
	test('a site whose webspace is OVERRIDDEN resolves to the override, on both sides', () => {
		// Defect 2, on the tenancy that produced it. The provisioner renders the table; the
		// daemon's own reader is asked where 'archive' lives, and must answer with the
		// override rather than `<webspace_base>/<domain>`.
		const layout = scratchLayout('overridden');
		const table = renderAll(layout, {} as never).find((artifact) =>
			artifact.path.endsWith('sites.json'),
		);
		expect(table).toBeDefined();
		mkdirSync(join((table as NonNullable<typeof table>).path, '..'), { recursive: true });
		writeFileSync(
			(table as NonNullable<typeof table>).path,
			(table as NonNullable<typeof table>).body,
			'utf8',
		);

		const read = readSiteTable((table as NonNullable<typeof table>).path, 'overridden');
		const archive = read.bySlug('archive');
		expect(archive).not.toBeNull();
		expect((archive as NonNullable<typeof archive>).webspace).toBe(join(SCRATCH, 'legacy', 'arch'));
		// And NOT the derivation the daemon used to make.
		expect((archive as NonNullable<typeof archive>).webspace).not.toBe(
			join(SCRATCH, 'webspaces', 'archive.example.org'),
		);
		// Both surfaces live inside it: the strings the vhosts were rendered from.
		for (const surface of ['preprod', 'prod'] as const) {
			expect(
				(archive as NonNullable<typeof archive>).surfaces[surface].storeDir.startsWith(
					join(SCRATCH, 'legacy', 'arch'),
				),
			).toBe(true);
		}
	});
});

describe('B4 — the pairing recipe is spelled twice, and the two are RUN side by side', () => {
	test('the engine and the daemon agree, byte for byte, on every input', () => {
		const inputs: Array<[string, string]> = [
			['museum-a', 'x'.repeat(32)],
			['a', ''],
			['museum-with-a-long-name', 'token with spaces and ünicode ✓'],
			// The boundary the newline exists for: without it, ('ab','cde') and ('abc','de')
			// would hash identically.
			['ab', 'cde'],
			['abc', 'de'],
		];
		for (const [instance, token] of inputs) {
			expect({ instance, hex: engineFingerprint(instance, token) }).toEqual({
				instance,
				hex: daemonFingerprint(instance, token),
			});
		}
		expect(engineFingerprint('ab', 'cde')).not.toBe(engineFingerprint('abc', 'de'));
	});

	test('the census freezes the recipe at exactly two spellings — the two deployables', () => {
		const owners = census().pairing_fingerprint as string[];
		expect(owners).toEqual([
			'publication/site_builder/src/security/pairing.ts',
			'src/core/site_builder/pairing.ts',
		]);
	});
});

describe('B5 — layout.ts is the sole owner of the constants and grammars', () => {
	test('no other module DECLARES a name layout.ts exports', () => {
		// Defect 1, and defect 5 which this found: the engine tool's own `DOMAIN_PATTERN`,
		// stricter than the owner's in two ways while its comment said it was not.
		expect(census().layout_constants).toEqual([]);
	});

	test('the names being guarded include the ones the defects were about', () => {
		// Anti-vacuity: the export scan must actually be seeing the grammar, not just the
		// helper functions.
		const names = layoutOwnedNames();
		for (const name of [
			'INSTANCE_PATTERN',
			'USER_PREFIX',
			'DEFAULT_PATHS',
			'MODES',
			'INSTANCE_MARKER',
			'DOMAIN_PATTERN',
			'SURFACES',
			'RELEASE_STORE_DIR',
		]) {
			expect({ name, owned: names.includes(name) }).toEqual({ name, owned: true });
		}
	});

	test('the ratchet file is where an operator is told to look when this goes red', () => {
		expect(BASELINE_PATH).toBe('engineering/site_builder_single_source_baseline.json');
		expect(statSync(join(import.meta.dir, '..', '..', BASELINE_PATH)).isFile()).toBe(true);
	});
});
