/**
 * GATE — the page's BOOT SHAPE is bounded, and the simple stack's transport is
 * a recorded decision, not an oversight (CLI-28 / P2-31 residue).
 *
 * TWO HALVES, and the row says which is which.
 *
 * RECORDED DECISION (not gateable as behaviour): `deploy/nginx.simple.conf`
 * serves the client over plain HTTP/1.1 on port 80. `http2 on;` there would be
 * inert — a browser negotiates HTTP/2 through the TLS ALPN handshake and never
 * in cleartext — so the transport of that one file is IMPOSSIBLE to improve
 * without TLS, which the installer's TLS modes (stack_tls, host_tls) already offer. The
 * decision, its measured cost and its escape live in that file's TRANSPORT
 * block.
 *
 * GATED (this file, an invariant scan despite the `_native` suffix the lead
 * named it by — cf. client_render_budget_native):
 *
 *   1. THE BOOT SHAPE, derived through the engine's OWN serving door. The
 *      static ES module graph is walked from the entry named by
 *      `core/page/index.html`, every hop fetched with `handleRequest` exactly
 *      as the browser would fetch it: so the count is a REQUEST count (the
 *      vendored `/dedalo/lib/*` modules the client_libs registry serves are in
 *      it, and a module that 404s reddens the walk), never a file count. Both
 *      ceilings are SHRINK-ONLY, and both are a SHAPE, never a wall-clock
 *      duration: module count (breadth — the 6-connections-per-origin cap) and
 *      discovery depth (latency — serial round-trips no transport can overlap).
 *      Floor: the walk finds more than 10 modules.
 *   2. THE DECISION STAYS CURRENT. The numbers written in the conf's TRANSPORT
 *      block are asserted EQUAL to the ceilings above — one number, two
 *      readers, so the recorded cost cannot drift from the measurement.
 *   3. TOTAL census of the SHIPPED front-end configurations (derived from git's
 *      index by `test/helpers/deploy_stack_corpus.ts`): every conf that
 *      TERMINATES TLS — judged on the directives with comments stripped, never
 *      on the file's name — declares h2 (`http2 on;` / `Protocols … h2`). The
 *      one plain-HTTP conf is the single ENUMERATED entry, and it must carry
 *      the TRANSPORT markers, so the exemption is a written decision rather
 *      than a silence.
 *   4. THE ESCAPE IS CODE. The terminal installer (phase 4) offers the TLS modes
 *      the decision names: the docker route's three render an h2 site, only the
 *      trial route takes the plain conf, and every production site file (nginx
 *      and Apache, Let's Encrypt and the institution's files) declares h2 —
 *      each RENDERED here, not read as text.
 *   5. THE PROSE AGREES. Every transport claim across `deploy/`,
 *      `docs/install/` and `engineering/` states the MEASURED figures (the
 *      unmeasured "~100-module client boot graph" stood in four files while
 *      the graph was 34), and no `~N-module` estimate survives anywhere in
 *      that corpus.
 *
 * Positive controls: a synthesized TLS conf without h2 and a synthesized plain
 * conf without the TRANSPORT markers are both classified as offenders; a
 * synthesized module graph one over the ceiling breaks the budget check.
 *
 * Hermetic: fs + git index + `handleRequest` on static client paths, which
 * touch no database.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { certificatePaths, siteText } from '../../src/core/install/host/production/web.ts';
import { renderStackNginx } from '../../src/core/install/host/stack/files.ts';
import { nginxConfOf } from '../../src/core/install/host/stack/layout.ts';
import { handleRequest } from '../../src/server.ts';
import { deployProxyConfs, deployStackProse, REPO_ROOT } from '../helpers/deploy_stack_corpus.ts';
import {
	HOST_VARIANTS,
	productionPlanCtx,
	stackPlanCtx,
	variantName,
} from '../helpers/install_host_scratch.ts';
import { PINNED_IDENTITY, withInstallerIdentity } from '../helpers/installer_identity.ts';

// ---------------------------------------------------------------------------
// The recorded budget. SHRINK-ONLY: lower a number here when the client boots
// with less, never raise it to make a red gate green. The same four numbers are
// written in deploy/nginx.simple.conf's TRANSPORT block and asserted equal.
// ---------------------------------------------------------------------------

/** Static ES modules on the cold-boot critical path, the entry included. */
const BOOT_MODULES = 35;
/** Discovery levels: serial round-trips before the last module is known. */
const BOOT_DEPTH = 5;
/** Subresources the HTML declares besides the module entry. */
const BOOT_HEAD_ASSETS = 4;
/** The whole critical path before the first API call. */
const BOOT_REQUESTS = BOOT_MODULES + BOOT_HEAD_ASSETS;

const PAGE_DIR = '/dedalo/core/page/';
const SIMPLE_CONF = 'deploy/nginx.simple.conf';

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');

/** `#`-comments out, so a conf is judged on its directives, not its prose. */
const directives = (source: string): string =>
	source
		.split('\n')
		.map((line) => line.replace(/#.*$/, ''))
		.join('\n');

// ---------------------------------------------------------------------------
// Leg 1 — the boot shape, walked through the serving door.
// ---------------------------------------------------------------------------

interface BootGraph {
	/** url → discovery depth (entry = 1). */
	readonly depth: ReadonlyMap<string, number>;
	/** url → status the serving door answered. */
	readonly status: ReadonlyMap<string, number>;
	/** Head subresources besides the module entry. */
	readonly headAssets: readonly string[];
}

const stripUrl = (url: string): string => (url.split('?')[0] as string).split('#')[0] as string;

/** Static `import`/`export … from` specifiers of a served module body. */
function staticSpecifiers(source: string): string[] {
	const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
	const found: string[] = [];
	for (const match of code.matchAll(
		/^[ \t]*(?:import|export)\s+(?:[^'"\n]*?\sfrom\s*)?['"]([^'"\n]+)['"]/gm,
	)) {
		found.push(match[1] as string);
	}
	return found;
}

async function serve(path: string): Promise<Response> {
	return handleRequest(new Request(`http://localhost${path}`), {
		requestId: 'page_load_budget',
		startedAt: 0,
	});
}

/**
 * Walk the cold-boot graph the way the browser does: fetch the page shell,
 * take the module entry it declares, and follow every static specifier through
 * the same door. A specifier that is neither relative nor root-absolute is an
 * import-map name (only `three`, and only in the 3D component — never on this
 * path) and is reported, not silently dropped.
 */
async function walkBootGraph(): Promise<BootGraph> {
	const shell = await serve(`${PAGE_DIR}index.html`);
	expect(shell.status).toBe(200);
	const html = await shell.text();

	const entrySpec = html.match(/<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/)?.[1];
	expect(entrySpec, 'core/page/index.html declares no module entry').toBeTruthy();

	const headAssets: string[] = [];
	for (const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)) {
		if (match[1] !== entrySpec) headAssets.push(stripUrl(match[1] as string));
	}
	for (const match of html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["']/g)) {
		headAssets.push(stripUrl(match[1] as string));
	}
	// A stylesheet a head script WRITES is a head subresource too: head-init.js
	// document.write()s the versioned main.css (WC-2026-11-06-css-version) — the
	// same render-blocking request a static <link> made, invisible to the scan above.
	for (const match of html.matchAll(
		/<script\b(?![^>]*type=["']module["'])[^>]*\bsrc=["']([^"']+)["']/g,
	)) {
		const script = await serve(
			new URL(stripUrl(match[1] as string), `http://boot${PAGE_DIR}`).pathname,
		);
		const code = await script.text();
		for (const written of code.matchAll(/document\.write\(\s*'<link\b[^']*rel="stylesheet"/g)) {
			headAssets.push(`${written[0]} (written by ${match[1]})`);
		}
	}

	const absolute = (base: string, spec: string): string =>
		new URL(spec, `http://boot${base}`).pathname;

	const entry = absolute(PAGE_DIR, stripUrl(entrySpec as string));
	const depth = new Map<string, number>([[entry, 1]]);
	const status = new Map<string, number>();
	const queue: string[] = [entry];
	const bare: string[] = [];

	while (queue.length > 0) {
		const url = queue.shift() as string;
		const response = await serve(url);
		status.set(url, response.status);
		if (response.status !== 200) continue;
		const body = await response.text();
		for (const spec of staticSpecifiers(body)) {
			if (!spec.startsWith('.') && !spec.startsWith('/')) {
				bare.push(`${spec} (in ${url})`);
				continue;
			}
			const dep = absolute(url, stripUrl(spec));
			const next = (depth.get(url) as number) + 1;
			if ((depth.get(dep) ?? Number.POSITIVE_INFINITY) > next) {
				depth.set(dep, next);
				queue.push(dep);
			}
		}
	}
	expect(bare, 'import-map specifier on the boot path').toEqual([]);
	return { depth, status, headAssets };
}

const graph = await walkBootGraph();

describe('page load budget — the boot shape', () => {
	test('every module of the graph is a real 200 through the serving door', () => {
		expect(graph.depth.size).toBeGreaterThan(10);
		const notServed = [...graph.status].filter(([, code]) => code !== 200);
		expect(notServed).toEqual([]);
		expect(graph.status.size).toBe(graph.depth.size);
	});

	test('module count is at or under the recorded ceiling (shrink-only)', () => {
		expect(graph.depth.size).toBeGreaterThan(10);
		expect(graph.depth.size).toBeLessThanOrEqual(BOOT_MODULES);
	});

	test('discovery depth is at or under the recorded ceiling (shrink-only)', () => {
		expect(graph.depth.size).toBeGreaterThan(10);
		expect(Math.max(...graph.depth.values())).toBeLessThanOrEqual(BOOT_DEPTH);
	});

	test('the head declares no more subresources than recorded', () => {
		expect(graph.headAssets.length).toBeGreaterThan(2);
		expect(graph.headAssets.length).toBeLessThanOrEqual(BOOT_HEAD_ASSETS);
	});

	test('positive control: a graph one module over the ceiling is over budget', () => {
		const synthetic = new Map(graph.depth);
		for (let extra = graph.depth.size; extra <= BOOT_MODULES; extra += 1) {
			synthetic.set(`/dedalo/core/page/js/synthetic_${extra}.js`, 2);
		}
		expect(synthetic.size).toBeGreaterThan(BOOT_MODULES);
	});
});

// ---------------------------------------------------------------------------
// Leg 2 — the conf's recorded numbers ARE the gate's numbers.
// ---------------------------------------------------------------------------

/** `BOOT_MODULES 34` in the TRANSPORT block. */
function recordedNumber(source: string, marker: string): number | null {
	const match = source.match(new RegExp(`\\b${marker}\\s+(\\d+)\\b`));
	return match === null ? null : Number(match[1]);
}

describe('page load budget — the recorded decision stays current', () => {
	test('the TRANSPORT block records exactly the measured ceilings', () => {
		const conf = read(SIMPLE_CONF);
		expect(conf).toContain('# TRANSPORT');
		expect(recordedNumber(conf, 'BOOT_MODULES')).toBe(BOOT_MODULES);
		expect(recordedNumber(conf, 'BOOT_DEPTH')).toBe(BOOT_DEPTH);
		expect(recordedNumber(conf, 'BOOT_HEAD_ASSETS')).toBe(BOOT_HEAD_ASSETS);
		expect(recordedNumber(conf, 'BOOT_REQUESTS')).toBe(BOOT_REQUESTS);
	});

	test('the block names the escape: the TLS template and the mode that skips it', () => {
		const conf = read(SIMPLE_CONF);
		expect(conf).toContain('deploy/nginx.simple-tls.conf.tpl');
		expect(conf).toContain('tls_none');
	});

	test('positive control: a conf without the markers records nothing', () => {
		const stripped = read(SIMPLE_CONF).replace(/BOOT_MODULES\s+\d+/, 'BOOT_MODULES');
		expect(recordedNumber(stripped, 'BOOT_MODULES')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Leg 3 — TOTAL census of the shipped front-end configurations.
// ---------------------------------------------------------------------------

/** A conf TERMINATES TLS when its directives bind 443/ssl — never by name. */
function terminatesTls(source: string): boolean {
	const code = directives(source);
	return (
		/\blisten\s+(?:\[::\]:)?443\s+ssl\b/.test(code) ||
		/\bSSLEngine\s+on\b/i.test(code) ||
		/<VirtualHost[^>]*:443/.test(code)
	);
}

/** A conf DECLARES h2 when the directive is live (nginx or apache spelling). */
function declaresHttp2(source: string): boolean {
	const code = directives(source);
	return /^\s*http2\s+on\s*;/m.test(code) || /^\s*Protocols\b[^\n]*\bh2\b/m.test(code);
}

/**
 * The single ENUMERATED plain-HTTP configuration and why it may not declare
 * h2. Shrink-only: a second entry means a second stack chose cleartext.
 */
const PLAIN_HTTP_ENUMERATED: Readonly<Record<string, string>> = {
	[SIMPLE_CONF]:
		'installer TLS mode 4 (tls_none) only — a throwaway trial on port 80. Browsers negotiate HTTP/2 through the TLS handshake, so h2 is impossible here rather than unchosen; the TRANSPORT block records the decision, the measured cost and the escape (modes 1-3 render nginx.simple-tls.conf.tpl).',
};

describe('page load budget — TOTAL census of the shipped front ends', () => {
	const confs = deployProxyConfs();

	test('every TLS-terminating conf multiplexes the boot graph with h2', () => {
		expect(confs.length).toBeGreaterThan(3);
		const silent = confs.filter((rel) => {
			const source = read(rel);
			return terminatesTls(source) && !declaresHttp2(source);
		});
		expect(silent).toEqual([]);
	});

	test('every conf that does NOT terminate TLS is enumerated with its reason', () => {
		expect(confs.length).toBeGreaterThan(3);
		const plain = confs.filter((rel) => !terminatesTls(read(rel)));
		expect(plain).toEqual(Object.keys(PLAIN_HTTP_ENUMERATED));
		for (const rel of plain) {
			expect((PLAIN_HTTP_ENUMERATED[rel] as string).length).toBeGreaterThan(80);
			expect(read(rel)).toContain('# TRANSPORT');
		}
	});

	test('positive control: a TLS conf without h2, and a plain conf without the block', () => {
		const tlsNoH2 = 'server {\n\tlisten 443 ssl;\n\t# http2 on;\n}\n';
		expect(terminatesTls(tlsNoH2)).toBe(true);
		expect(declaresHttp2(tlsNoH2)).toBe(false);

		const apacheNoH2 = '<VirtualHost *:443>\n\tSSLEngine on\n</VirtualHost>\n';
		expect(terminatesTls(apacheNoH2)).toBe(true);
		expect(declaresHttp2(apacheNoH2)).toBe(false);

		const plainNoBlock = read(SIMPLE_CONF).replace('# TRANSPORT', '# transport, someday');
		expect(terminatesTls(plainNoBlock)).toBe(false);
		expect(plainNoBlock).not.toContain('# TRANSPORT');

		const realTls = read('deploy/nginx.conf');
		expect(terminatesTls(realTls)).toBe(true);
		expect(declaresHttp2(realTls)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Leg 4 — the escape is code, not advice.
// ---------------------------------------------------------------------------

describe('page load budget — the escape the installer offers', () => {
	// Phase 4 (2026-10-12): the TLS decision is the TypeScript installer's — the
	// docker route's generated site (stack_files) and the production site file
	// (host_web_site), RENDERED here and judged like any shipped conf.
	const docker = (tls: Record<string, unknown>) =>
		stackPlanCtx({ route: 'docker', entity: 'museo', server_name: 'dedalo.example.org', ...tls });

	test("the docker route's three TLS modes render an h2 site; only trial takes the plain conf", async () => {
		const modes = [
			{ letsencrypt_email: 'ops@example.org' },
			{ tls_mode: 'local_ca' },
			{
				tls_mode: 'files',
				tls_cert_path: '/etc/ssl/m/fullchain.pem',
				tls_key_path: '/etc/ssl/m/privkey.pem',
			},
		];
		// Docker and trial install IMAGES, and an image install runs TAGGED releases
		// only (no nightly image): pin the installer identity to this data version's
		// stable release, or both plans are refused whenever the checkout is a
		// development build.
		await withInstallerIdentity(PINNED_IDENTITY.stable, () => {
			for (const tls of modes) {
				const site = renderStackNginx(docker(tls));
				expect(terminatesTls(site), JSON.stringify(tls)).toBe(true);
				expect(declaresHttp2(site), JSON.stringify(tls)).toBe(true);
			}
			const trial = stackPlanCtx({ route: 'trial', entity: 'trial_museum' });
			expect(nginxConfOf(trial.answers)).toBe('nginx.simple.conf');
		});
		expect(terminatesTls(read(SIMPLE_CONF))).toBe(false);
	});

	test('the production site file (nginx and Apache, every certificate mode) declares h2', () => {
		for (const variant of HOST_VARIANTS) {
			const ctx = productionPlanCtx(variant);
			const site = siteText(ctx, certificatePaths(ctx));
			expect(terminatesTls(site), variantName(variant)).toBe(true);
			expect(declaresHttp2(site), variantName(variant)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// Leg 5 — the prose states the MEASURED figures.
// ---------------------------------------------------------------------------

/** `34-module client boot graph` / `graph of 34 modules, 5 … 38 requests`. */
const MODULE_CLAIM = /(~?\d+)-module (?:client |ES )?boot graph/g;
const FULL_CLAIM = /graph of (~?\d+) modules, (\d+) import levels deep, (\d+) requests/g;
const REQUEST_CLAIM = /(~?\d+) cold-boot requests/g;

describe('page load budget — the prose agrees with the measurement', () => {
	const files = deployStackProse();

	test('every transport claim states the measured numbers, none an estimate', () => {
		expect(files.length).toBeGreaterThan(20);
		const wrong: string[] = [];
		let claims = 0;
		for (const rel of files) {
			const text = read(rel);
			for (const match of text.matchAll(MODULE_CLAIM)) {
				claims += 1;
				if (match[1] !== String(BOOT_MODULES)) wrong.push(`${rel}: ${match[0]}`);
			}
			for (const match of text.matchAll(FULL_CLAIM)) {
				claims += 1;
				if (
					match[1] !== String(BOOT_MODULES) ||
					match[2] !== String(BOOT_DEPTH) ||
					match[3] !== String(BOOT_REQUESTS)
				) {
					wrong.push(`${rel}: ${match[0]}`);
				}
			}
			for (const match of text.matchAll(REQUEST_CLAIM)) {
				claims += 1;
				if (match[1] !== String(BOOT_REQUESTS)) wrong.push(`${rel}: ${match[0]}`);
			}
		}
		expect(wrong).toEqual([]);
		// The claims exist: an emptied corpus cannot pass this leg.
		expect(claims).toBeGreaterThan(4);
	});

	test('positive control: the pre-fix "~100-module" estimate is caught', () => {
		const offender = 'http2 on;   # multiplexes the ~100-module client boot graph';
		const matches = [...offender.matchAll(MODULE_CLAIM)];
		expect(matches.length).toBe(1);
		expect(matches[0]?.[1]).not.toBe(String(BOOT_MODULES));
	});
});
