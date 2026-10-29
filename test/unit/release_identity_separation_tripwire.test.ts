/**
 * THE TWO VERSIONS STAY APART (release identity design gate 9;
 * WC-2026-10-15-release-identity-from-tag).
 *
 * The engine has two versions and they answer different questions:
 *  - the DATA version (`version.ts` DEDALO_DATA_VERSION,
 *    `7.0.0`) compares, migrates, names a code-server file and crosses to an
 *    older peer;
 *  - the RELEASE IDENTITY (`build_stamp.ts` RELEASE_IDENTITY /
 *    DEDALO_ENGINE_VERSION, `7.0.0-beta.6` | `7.0.0` | `7.0.0.dev`) is what the
 *    program calls itself.
 * Mixing them is how C3i-F1 happened in the other direction (a beta calling
 * itself `7.0.0`), and how a prerelease string once sent every page to the
 * update-data widget. This gate holds the separation on FLOW, not spelling
 * (test/helpers/release_identity_flow.ts: identity taint from the one producer,
 * data aliases from the one pin, both closed over the whole engine):
 *
 *  1. DATA-VERSION CONSUMERS never read the identity — the deliberate list of
 *     design §1 (publication host, tool min-version, seeds / matrix_updates,
 *     install-plan engine checks, boot confirm, the update walk / catalog, the
 *     code server's file names). Whole module where the module is pure data;
 *     the named functions where a module also displays (status.ts) or imports
 *     an install-step table the image steps taint (the executors).
 *  2. A module that imports an identity VALUE and the data version is a
 *     DECISION: it is declared in MIXED with why, both ways exact — a new one
 *     is red until someone says which of its sites reads which.
 *  3. DISPLAY SITES display the identity: what flows into each emitted value
 *     reaches the identity producer and never a data-version alias.
 *  4. THE CLIENT never reads `dedalo_version` (page_globals / info_data — the
 *     identity) as numbers: not split, Number()/parseInt'd, RegExp-parsed,
 *     nor ordered — read as a member, a `['dedalo_version']` member or a
 *     destructured binding; directly, through `String()`, a template literal,
 *     a string method (`.trim()`, `.replace(…)`, `.slice(…)` …), `|| ''`, or
 *     through a local it was bound to. Comparisons go through
 *     client/dedalo/core/common/js/release_identity.js or
 *     `page_globals.dedalo_data_version`.
 *  5. Positive controls: every evasion the model claims to see (re-export
 *     rename, `export *`, namespace member, dynamic destructure, a helper
 *     function, an extensionless or `.js` specifier, an unresolvable import,
 *     a hoisted mixed value, a numeric client read through an alias or a
 *     string transform) is shown red on synthetic sources.
 *
 * Pure source analysis (transpile + scan), no DB, no network → hermetic tier.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	buildFlowModel,
	clientNumericReads,
	clientSources,
	DATA_SEED,
	type DisplaySite,
	engineSources,
	IDENTITY_SEED,
	identityReadsOf,
	identityValueImports,
	REPO_ROOT,
	readsDataVersion,
	siteValues,
} from '../helpers/release_identity_flow.ts';

/** Design §1 "deliberately DATA-version consumers". `functions` narrows a mixed module to its data sites. */
const DATA_CONSUMERS: ReadonlyArray<{
	module: string;
	why: string;
	functions?: readonly string[];
}> = [
	{
		module: 'src/core/publication_host/host_status.ts',
		why: 'release ids are `<data version>_<digest7>`; lockstep with the publication host',
	},
	{
		module: 'src/core/area_maintenance/widgets/publication_hosts.ts',
		why: 'hands the publication host the data version as engineVersion',
	},
	{
		module: 'src/core/publication_host/api_reconcile.ts',
		why: 'reconciles published API bundles by data version',
	},
	{ module: 'src/core/publication_host/api_bundles.ts', why: 'names API bundles by data version' },
	{
		module: 'src/core/publication_host/kit_build.ts',
		why: 'stamps the publication kit with the data version',
	},
	{
		module: 'src/core/tools/register.ts',
		why: "compares a tool's dedalo_version_min with the data version",
	},
	{ module: 'src/core/install/seed_build.ts', why: 'writes the seed matrix_updates row' },
	{
		module: 'src/core/install/db_restore.ts',
		why: 'checks a restored seed against the data version',
	},
	{ module: 'src/core/install/seed_manifest.ts', why: 'the seed manifest engine_version' },
	{
		module: 'src/core/install/ontology_install.ts',
		why: 'staged ontology manifests match the data version',
	},
	{ module: 'src/core/archive/extract.ts', why: 'archive manifests carry the data version' },
	{
		module: 'src/core/install/run_files_core.ts',
		why: 'the plan file engine_version the resume check compares',
	},
	{
		module: 'src/core/install/executor.ts',
		why: 'resume refuses a plan of another data version (INSTALL_STEPS is image-tainted, so the module is mixed)',
		functions: ['resumeRun'],
	},
	{
		module: 'src/core/install/host/host_executor.ts',
		why: 'host resume refuses a plan of another data version (its step tables are image-tainted)',
		functions: ['resumeRun'],
	},
	{ module: 'src/core/update/boot_confirm.ts', why: 'confirms the booted code by data version' },
	{
		module: 'src/core/update/version_walk.ts',
		why: 'the walk is a pure rule: each door hands it the running identity, it imports none (the data walk is on triples)',
	},
	{ module: 'src/core/update/catalog.ts', why: 'UPDATE_CATALOG is keyed by triple' },
	{
		module: 'src/core/update/engine.ts',
		why: 'the migration engine writes matrix_updates by data version',
	},
	{
		module: 'src/core/update/code_build_plan.ts',
		why: "the code server's directory / file names come from the tag's version.ts",
	},
	{ module: 'src/core/update/code_manifest.ts', why: "the code server's manifest file grammar" },
	{
		module: 'src/core/update/code_build.ts',
		why: 'builds an archive from the tag, never from the running identity',
	},
	{
		module: 'src/core/update/status.ts',
		why: 'the code-server status (advertised rungs, the tag/version.ts verdict) is data; consumerStatus displays the identity',
		functions: [
			'codeServerStatus',
			'advertisedRungs',
			'declaredVersionAtRef',
			'releaseVersionCheck',
			'tagVersionVerdict',
		],
	},
	{
		module: 'src/core/api/handlers/dd_utils_api.ts',
		why: "the code server parses an asker's version as a data triple (older masters too)",
		functions: ['authorizeUpdateManifest'],
	},
];

/**
 * Modules that import an identity VALUE and a data-version alias — each says
 * which of its sites is which. Exact both ways: a stale entry is red too.
 */
const MIXED: ReadonlyMap<string, string> = new Map([
	[
		'src/core/api/handlers/login_context.ts',
		"login About: 'Code version' = identity (display site below), 'Data version' = DEDALO_DATA_VERSION",
	],
	[
		'src/core/resolve/environment.ts',
		'page_globals / info_data: dedalo_version = identity (display sites below), dedalo_data_version = DEDALO_DATA_VERSION',
	],
	[
		'src/core/update/status.ts',
		'consumerStatus: engine_version = identity (display site), version = data; the code-server half is a data consumer (above)',
	],
	[
		'src/core/install/installer_identity.ts',
		'the installer identity, validated against the data version its seam may name',
	],
	[
		'src/core/install/executor.ts',
		'INSTALL_STEPS reaches the image steps (identity image tag); resumeRun is a data consumer (above)',
	],
	[
		'src/core/update/code_update.ts',
		'the identity walk starts from the running identity (design §2.8 item 3); the backup dir / sentinel previousVersion name the data version boot_confirm compares',
	],
]);

/** Where the program says its own name. */
const DISPLAY_SITES: readonly DisplaySite[] = [
	{
		module: 'src/server.ts',
		fn: 'handleRequest',
		key: 'version',
		within: /buildHealthPayload\(\{/,
	},
	{ module: 'src/core/resolve/environment.ts', fn: 'versionFacts', key: 'dedalo_version' },
	{ module: 'src/core/resolve/environment.ts', fn: 'buildInfoData', key: 'dedalo_version' },
	{
		module: 'src/core/api/handlers/login_context.ts',
		fn: 'buildLoginContext',
		key: 'value',
		within: /"Code version"/,
	},
	{ module: 'src/core/update/status.ts', fn: 'consumerStatus', key: 'engine_version' },
	{ module: 'src/core/install/probes.ts', fn: 'systemCheck', key: 'version' },
	{ module: 'src/core/install/installer_identity.ts', fn: 'installerVersionLabel' },
	{ module: 'src/core/install/host/stack/layout.ts', fn: 'imageVersionOf' },
	{ module: 'src/core/install/host/stack/layout.ts', fn: 'acceptedImageVersions' },
	{ module: 'src/core/update/image_update_request.ts', fn: 'requestRecord', key: 'from_version' },
	{
		module: 'tools/tool_error_report/server/index.ts',
		fn: 'buildSendReportHandler',
		key: 'dedalo_version',
	},
];

/**
 * Display CONSTANTS: a module-scope value that names the program to the outside
 * (no function, no key a DisplaySite could anchor on). The exported binding
 * must carry the identity and its module read no data-version alias at all.
 */
const DISPLAY_CONSTANTS: ReadonlyArray<{ module: string; name: string; why: string }> = [
	{
		module: 'src/core/harvest/identity.ts',
		name: 'HARVEST_USER_AGENT',
		why: "the harvest door's User-Agent names the software that sent the request (owner Q10)",
	},
];

/**
 * Client `<object>.dedalo_version` reads that are NOT the release identity and
 * may be read as numbers, keyed `<file>#<object>` → why. EMPTY today; stale
 * entries are red. (update_data_version's `value.dedalo_version` is the data
 * triple — src/core/area_maintenance/widgets/update_data_version.ts — but it
 * is not read numerically, so it needs no entry.)
 */
const CLIENT_NOT_IDENTITY: ReadonlyMap<string, string> = new Map();

const model = buildFlowModel(engineSources());

describe('the flow model reads the engine (anti-vacuity)', () => {
	test('it parsed the engine and closed both relations from their one seed', () => {
		expect(model.modules.size).toBeGreaterThan(800);
		expect(model.identityLocals.get(IDENTITY_SEED.module)?.has(IDENTITY_SEED.name)).toBe(true);
		expect(model.dataLocals.get(DATA_SEED.module)?.has(DATA_SEED.name)).toBe(true);
		// The two names the engine actually uses, DERIVED — neither is written into the model.
		expect(
			model.exportCarriesIdentity('src/core/update/build_stamp.ts', 'DEDALO_ENGINE_VERSION'),
		).toBe(true);
		expect(model.exportCarriesIdentity('src/core/update/build_stamp.ts', 'RELEASE_IDENTITY')).toBe(
			true,
		);
		expect(model.exportIsDataAlias('src/core/update/version.ts', 'DEDALO_DATA_VERSION')).toBe(true);
		// …and they stay apart: the identity is not data, the data is not the identity.
		expect(model.exportIsDataAlias('src/core/update/build_stamp.ts', 'DEDALO_ENGINE_VERSION')).toBe(
			false,
		);
		expect(model.exportCarriesIdentity('src/core/update/version.ts', 'DEDALO_DATA_VERSION')).toBe(
			false,
		);
		// The grammar and comparator are pure: a data consumer may use them.
		expect(
			model.exportCarriesIdentity('src/core/update/release_identity.ts', 'parseReleaseVersion'),
		).toBe(false);
		expect(
			model.exportCarriesIdentity(
				'src/core/update/release_identity.ts',
				'compareReleaseIdentities',
			),
		).toBe(false);
		// Imports resolve the way Bun resolves them: an extensionless specifier is
		// followed, not dropped (a dropped binding is one no leg can see).
		expect(
			model.modules
				.get('tools/tool_sitebuilder/server/index.ts')
				?.imports.find((b) => b.local === 'resolveSiteBuilderTransport')?.from,
		).toBe('src/core/site_builder/pairing.ts');
	});
});

describe('1. data-version consumers never read the release identity', () => {
	for (const consumer of DATA_CONSUMERS) {
		const scope = consumer.functions ? ` (${consumer.functions.join(', ')})` : '';
		test(`${consumer.module}${scope}`, () => {
			const facts = model.modules.get(consumer.module);
			expect(facts, `${consumer.module} is gone — update the list`).toBeDefined();
			if (consumer.functions) {
				const declared = new Set(facts?.chunks.flatMap((chunk) => chunk.names));
				const missing = consumer.functions.filter((fn) => !declared.has(fn));
				expect(
					missing,
					`${consumer.module}: renamed or removed data sites — update the list`,
				).toEqual([]);
			} else {
				// A whole-module verdict needs every dynamic import resolved.
				expect(
					facts?.unresolvedDynamic,
					`${consumer.module}: a computed import() the model cannot follow`,
				).toBe(0);
			}
			expect(
				identityReadsOf(model, consumer.module, consumer.functions),
				`${consumer.module} is a DATA-version consumer (${consumer.why}). It must compare / name / migrate with version.ts DEDALO_DATA_VERSION, never the release identity — a prerelease or dev identity is not a version it can order. Each line is a read and the chain down to the producer:`,
			).toEqual([]);
		});
	}
});

describe('2. every module that reads both versions is a declared decision', () => {
	test('the census equals MIXED exactly', () => {
		const producers = new Set([
			'src/core/update/build_stamp.ts',
			'src/core/update/release_identity.ts',
		]);
		const both = [...model.modules.keys()]
			.filter((path) => !producers.has(path))
			.filter(
				(path) => identityValueImports(model, path).length > 0 && readsDataVersion(model, path),
			)
			.sort();
		expect(both.length).toBeGreaterThan(0);
		expect(
			both,
			'A module imports the release identity AND the data version. Say which of its sites reads which: add it to MIXED with the reason (and its display site to DISPLAY_SITES or its data functions to DATA_CONSUMERS) — or drop the read it should not have. A MIXED entry no longer reading both is stale.',
		).toEqual([...MIXED.keys()].sort());
	});
});

describe('3. display sites name the identity, never the data version', () => {
	for (const site of DISPLAY_SITES) {
		test(`${site.module} ${site.fn}${site.key ? ` → ${site.key}` : ' → return'}`, () => {
			const values = siteValues(model, site);
			expect(values.length, 'the site emits no value the model can read — moved?').toBeGreaterThan(
				0,
			);
			for (const value of values) {
				expect(
					value.data,
					`\`${value.expression}\` displays the DATA version as the program's name — a beta would call itself the stable release (C3i-F1). Use the release identity (build_stamp.ts).`,
				).toEqual([]);
				expect(
					value.identity,
					`\`${value.expression}\` does not reach the release identity`,
				).not.toEqual([]);
			}
		});
	}
});

describe('3b. display constants carry the identity, and only the identity', () => {
	for (const constant of DISPLAY_CONSTANTS) {
		test(`${constant.module} ${constant.name}`, () => {
			expect(
				model.modules.has(constant.module),
				`${constant.module} is gone — update the list`,
			).toBe(true);
			expect(
				model.exportCarriesIdentity(constant.module, constant.name),
				`${constant.name} does not reach the release identity (${constant.why})`,
			).toBe(true);
			expect(
				readsDataVersion(model, constant.module),
				`${constant.module} reads the DATA version — ${constant.name} would call a beta by the stable release it precedes (${constant.why})`,
			).toBe(false);
		});
	}
});

describe('4. the client never reads the identity as numbers', () => {
	const sources = clientSources();
	const reads = sources.map((file) => ({
		file,
		...clientNumericReads(readFileSync(join(REPO_ROOT, file), 'utf8')),
	}));

	test('the scan sees the identity where the client reads it (anti-vacuity)', () => {
		expect(sources.length).toBeGreaterThan(200);
		const seen = reads.flatMap((r) => r.sources.map((s) => `${r.file}#${s.object}`));
		expect(seen.length).toBeGreaterThan(15);
		expect(seen).toContain('client/dedalo/core/page/js/render_page.js#page_globals');
		expect(seen).toContain('client/dedalo/core/menu/js/view_default_edit_menu.js#info_data');
	});

	test('no numeric read of page_globals / info_data dedalo_version', () => {
		const offenders = reads.flatMap((r) =>
			r.numeric
				.filter((hit) => !CLIENT_NOT_IDENTITY.has(`${r.file}#${hit.object}`))
				.map((hit) => `${r.file}:${hit.line} ${hit.detail}`),
		);
		expect(
			offenders,
			"`dedalo_version` is the RELEASE IDENTITY ('7.0.0-beta.6' splits into ['7','0','0-beta','6']). Read the data triple instead: page_globals.dedalo_data_version, or data_version_of / code_satisfies / needs_data_update from client/dedalo/core/common/js/release_identity.js.",
		).toEqual([]);
	});

	test('CLIENT_NOT_IDENTITY has no stale entry', () => {
		const numeric = new Set(
			reads.flatMap((r) => r.numeric.map((hit) => `${r.file}#${hit.object}`)),
		);
		expect([...CLIENT_NOT_IDENTITY.keys()].filter((key) => !numeric.has(key))).toEqual([]);
	});
});

describe('5. positive controls — every evasion the model claims to see is red', () => {
	const fakes = new Map<string, string>([
		[
			'src/core/update/release_identity.ts',
			'export function resolveReleaseIdentity(t: readonly number[]) { return { version: `${t.join(".")}.dev` }; }\nexport function parseReleaseVersion(v: string) { return v; }',
		],
		['src/core/update/version.ts', 'export const DEDALO_DATA_VERSION = [7, 0, 0];'],
		[
			'src/core/update/build_stamp.ts',
			"import { resolveReleaseIdentity } from './release_identity.ts';\nimport { DEDALO_DATA_VERSION } from './version.ts';\nexport const RELEASE_IDENTITY = resolveReleaseIdentity(DEDALO_DATA_VERSION);\nexport const DEDALO_ENGINE_VERSION: string = RELEASE_IDENTITY.version;",
		],
		[
			'src/zz/relay.ts',
			"export { DEDALO_ENGINE_VERSION as CODE } from '../core/update/build_stamp.ts';",
		],
		['src/zz/star.ts', "export * from './relay.ts';"],
		[
			'src/zz/helper.ts',
			"import { RELEASE_IDENTITY } from '../core/update/build_stamp.ts';\nexport function label() { return `v${RELEASE_IDENTITY.version}`; }",
		],
		['src/zz/c_named.ts', "import { CODE } from './star.ts';\nexport const x = CODE;"],
		[
			'src/zz/c_namespace.ts',
			"import * as stamp from '../core/update/build_stamp.ts';\nexport function f() { return stamp.DEDALO_ENGINE_VERSION; }",
		],
		[
			'src/zz/c_dynamic.ts',
			"export async function f() { const { DEDALO_ENGINE_VERSION: v } = await import('../core/update/build_stamp.ts'); return v; }",
		],
		[
			'src/zz/c_call.ts',
			"import { label } from './helper.ts';\nexport function f() { return label(); }",
		],
		[
			'src/zz/c_unused.ts',
			"import { RELEASE_IDENTITY } from '../core/update/build_stamp.ts';\nexport const n = 1;",
		],
		[
			'src/zz/c_clean.ts',
			"import { DEDALO_DATA_VERSION } from '../core/update/version.ts';\nimport { parseReleaseVersion } from '../core/update/release_identity.ts';\nexport function f() { return parseReleaseVersion(DEDALO_DATA_VERSION); }",
		],
		[
			'src/zz/display.ts',
			"import { DEDALO_DATA_VERSION } from '../core/update/version.ts';\nimport { DEDALO_ENGINE_VERSION, RELEASE_IDENTITY } from '../core/update/build_stamp.ts';\nimport { mixedLabel } from './mixed_helper';\nconst SHOWN = RELEASE_IDENTITY.kind === 'prerelease' ? DEDALO_DATA_VERSION : DEDALO_ENGINE_VERSION;\nfunction mixedShown() { return RELEASE_IDENTITY.kind === 'prerelease' ? DEDALO_DATA_VERSION : DEDALO_ENGINE_VERSION; }\nconst VIA = mixedShown();\nexport function bad() { const shown = DEDALO_DATA_VERSION; return { version: shown }; }\nexport function good() { return { version: DEDALO_ENGINE_VERSION, data_version: DEDALO_DATA_VERSION }; }\nexport function hoisted() { return { version: SHOWN }; }\nexport function helper() { return { version: VIA }; }\nexport function imported() { return { version: mixedLabel() }; }",
		],
		[
			'src/zz/mixed_helper.ts',
			"import { DEDALO_DATA_VERSION } from '../core/update/version.ts';\nimport { RELEASE_IDENTITY } from '../core/update/build_stamp.ts';\nexport function mixedLabel() { return RELEASE_IDENTITY.kind === 'stable' ? RELEASE_IDENTITY.version : DEDALO_DATA_VERSION; }",
		],
		[
			'src/zz/c_extensionless.ts',
			"import { DEDALO_ENGINE_VERSION as DEDALO_VERSION } from '../core/update/build_stamp';\nexport function f() { return DEDALO_VERSION; }",
		],
		[
			'src/zz/c_js_specifier.ts',
			"import { RELEASE_IDENTITY } from '../core/update/build_stamp.js';\nexport const v = RELEASE_IDENTITY.version;",
		],
	]);
	const fake = buildFlowModel(fakes);

	test('re-export rename + export *, namespace member, dynamic destructure, helper call, bare import: all red', () => {
		for (const module of [
			'c_named',
			'c_namespace',
			'c_dynamic',
			'c_call',
			'c_unused',
			'c_extensionless',
			'c_js_specifier',
		]) {
			expect(identityReadsOf(fake, `src/zz/${module}.ts`), module).not.toEqual([]);
		}
		expect(identityReadsOf(fake, 'src/zz/c_clean.ts')).toEqual([]);
	});

	test('a relative import the model cannot resolve refuses the whole model (fail closed)', () => {
		const blind = new Map(fakes);
		blind.set('src/zz/c_blind.ts', "import { x } from './nowhere';\nexport const y = x;");
		expect(() => buildFlowModel(blind)).toThrow(/src\/zz\/c_blind\.ts → '\.\/nowhere'/);
	});

	test('a display site showing the data version is red; the identity is green', () => {
		const [bad] = siteValues(fake, { module: 'src/zz/display.ts', fn: 'bad', key: 'version' });
		expect(bad?.data).toContain('DEDALO_DATA_VERSION');
		expect(bad?.identity).toEqual([]);
		// The producer handoff (build_stamp hands the triple in) is not a data read.
		const [good] = siteValues(fake, { module: 'src/zz/display.ts', fn: 'good', key: 'version' });
		expect(good?.identity).toContain('DEDALO_ENGINE_VERSION');
		expect(good?.data).toEqual([]);
	});

	test('a display constant built from the data version is red; from the identity, green', () => {
		const constants = buildFlowModel(
			new Map([
				...fakes,
				[
					'src/zz/ua_data.ts',
					"import { DEDALO_DATA_VERSION } from '../core/update/version.ts';\nexport const UA = `dedalo/${DEDALO_DATA_VERSION} (+x)`;",
				],
				[
					'src/zz/ua_identity.ts',
					"import { DEDALO_ENGINE_VERSION } from '../core/update/build_stamp.ts';\nexport const UA = `dedalo/${DEDALO_ENGINE_VERSION} (+x)`;",
				],
			]),
		);
		expect(constants.exportCarriesIdentity('src/zz/ua_data.ts', 'UA')).toBe(false);
		expect(readsDataVersion(constants, 'src/zz/ua_data.ts')).toBe(true);
		expect(constants.exportCarriesIdentity('src/zz/ua_identity.ts', 'UA')).toBe(true);
		expect(readsDataVersion(constants, 'src/zz/ua_identity.ts')).toBe(false);
	});

	test('a value mixing both versions is red even when hoisted: module const, local helper, imported helper', () => {
		for (const fn of ['hoisted', 'helper', 'imported']) {
			const [value] = siteValues(fake, { module: 'src/zz/display.ts', fn, key: 'version' });
			expect(value?.data, fn).toContain('DEDALO_DATA_VERSION');
		}
	});

	test('client: numeric reads through every wrapper and alias are red; the door, display and cache-bust are not', () => {
		const red = [
			"const v = page_globals.dedalo_version.split('.')",
			"const v = page_globals?.dedalo_version?.split('.')",
			"const v = String(page_globals.dedalo_version || '').trim().split('.')",
			"const ver = page_globals.dedalo_version\nconst parts = ver.split('.').map(Number)",
			'if (Number(page_globals.dedalo_version) > 6) {}',
			"if (page_globals.dedalo_version > '7.0.0') {}",
			'const x = parseInt(globals.dedalo_version)',
			'let w\nw = page_globals.dedalo_version\nconst q = +w',
			// the historical strip-then-split idiom, and other string transforms
			"const t = page_globals.dedalo_version.replace('.dev','').split('.').map(Number)",
			"const t = page_globals.dedalo_version.replace(/\\.dev$/, '').split('.')",
			"const t = page_globals.dedalo_version.slice(0, 5).split('.')",
			// destructured, computed member, RegExp parse, template literal
			"const { dedalo_version } = page_globals\nconst p = dedalo_version.split('.')",
			"const { dedalo_version: dv } = page_globals\nif (dv > '7') {}",
			"const p = page_globals['dedalo_version'].split('.')",
			'const m = /^(\\d+)\\.(\\d+)/.exec(page_globals.dedalo_version)',
			'const ok = /^7\\./.test(page_globals.dedalo_version)',
			"const p = `${page_globals.dedalo_version}`.split('.')",
		];
		for (const source of red)
			expect(clientNumericReads(source).numeric.length, source).toBeGreaterThan(0);
		const green = [
			'const ok = data_version_of(page_globals.dedalo_version)',
			"el.textContent = 'v' + page_globals.dedalo_version",
			'const u = `?v=${page_globals.dedalo_version}`',
			'const a = { dedalo_version: 1 }',
			'const release = page_globals.dedalo_version || null',
			'const { dedalo_version } = page_globals\nel.textContent = dedalo_version',
			"const label = page_globals['dedalo_version'] || ''",
		];
		for (const source of green) expect(clientNumericReads(source).numeric, source).toEqual([]);
	});
});
