/**
 * TRIPWIRE: the app Content-Security-Policy stays XSS-safe and boot-consistent
 * (XSS-02, 2026-07-28 audit).
 *
 * (1) SECURITY-CRITICAL: `script-src` carries NEITHER `'unsafe-inline'` NOR
 *     `'unsafe-hashes'`. That absence is what makes an injected inline handler
 *     (`<img onerror=…>`), inline `<script>` or `javascript:` URL non-executing
 *     — the whole compensating control for stored XSS through CKEditor
 *     rich-text (component_text_area). A future "just add 'unsafe-inline' to fix
 *     a widget" edit re-opens the class; it fails here first.
 * (2) BOOT-CONSISTENT: the `'sha256-…'` in `script-src` equals a fresh hash of
 *     the ONE inline script the page ships (index.html's importmap). If that
 *     block is edited without updating the hash, the browser refuses the
 *     importmap and the app does not boot — caught here, not in production.
 * (3) The CSP is actually applied (present in SECURITY_HEADERS).
 * (4) FEATURE-CONSISTENT (2026-08-08, WC-2026-08-08-csp-connect-src-update-masters):
 *     `connect-src` carries every update master this install is configured to
 *     pull from, and `script-src`/`object-src` carry none of them. Both update
 *     panels interrogate a master FROM THE BROWSER, so a missing origin refuses
 *     the fetch before it leaves and the panel reports a network failure while
 *     the server-to-server probe beside it still says READY. The derivation is
 *     also pinned on SYNTHETIC entries, because a master is configured on a
 *     CLIENT box and not on a MASTER box — i.e. the config-derived half goes
 *     vacuous exactly where this engine is developed.
 * (5) TILES COME FROM THE SERVER (map tile proxy): `img-src` admits no OpenStreetMap or
 *     Carto host and is pinned as an EXACT list (`'self'`, `data:`, `blob:`, the media origin,
 *     `DIRECT_TILE_HOSTS`: a scheme-wide `https:`, a wildcard or any other host fails, and the
 *     check that says so is itself driven on synthetic lists), and the tile hosts it still
 *     names (`DIRECT_TILE_HOSTS`) are EXACTLY the
 *     hosts the client still draws from directly — so a host leaves the policy in the
 *     change that moves its last direct use, and a direct use cannot appear without a
 *     host the policy was never given. Read from the client source, not from a list, and
 *     from EVERY non-library script of `client/` and `tools/` (a tool lands its own client
 *     code under `tools/<tool>/js`): the AST of each file that builds a Leaflet tile, WMS or
 *     image layer, whatever the quote style, template literal, concatenation or variable
 *     that spells the address. The scope is the constructor, not the file: an address a layer
 *     is handed that the scan cannot read — a call, a member, a variable it cannot resolve — is
 *     a failure, because the policy cannot be proved for it, and a layer built on the proxy
 *     (`get_tile_url`) is the one form that needs no host.
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';
import { Glob } from 'bun';
import { config } from '../../src/config/config.ts';
import {
	APP_CSP,
	buildEmbedDirectives,
	DIRECT_TILE_HOSTS,
	deriveUpdateMasterOrigins,
	MEDIA_CSP_EMBED_SOURCE,
	MEDIA_CSP_ORIGIN,
	SECURITY_HEADERS,
	UPDATE_MASTER_CSP_ORIGINS,
} from '../../src/core/api/static_asset.ts';

import { type AstNode, nameOf, walkAst } from '../helpers/ast_walk.ts';

const ROOT = join(import.meta.dir, '..', '..');

/** The one directive's source list, e.g. script-src → ["'self'", "blob:", …]. */
function directive(csp: string, name: string): string[] {
	const seg = csp.split(';').find((s) => s.trim().startsWith(`${name} `));
	return seg ? seg.trim().slice(name.length).trim().split(/\s+/) : [];
}

/**
 * What is wrong with an `img-src` source list: every source that is not one the policy is
 * BUILT from, and every tile host it lacks. The allowed set is closed — `'self'` (which admits
 * the same-origin tile proxy), `data:`, `blob:`, the configured media origin and the direct
 * tile hosts — and a scheme-wide source (`https:`, `http:`), a wildcard or any other host is a
 * problem wherever it sits. A source repeated beyond its single place is reported too.
 */
function imgSrcProblems(
	sources: readonly string[],
	mediaOrigin: string,
	tileHosts: readonly string[],
): string[] {
	const allowed = new Set<string>([
		"'self'",
		'data:',
		'blob:',
		...(mediaOrigin === '' ? [] : [mediaOrigin]),
		...tileHosts,
	]);
	const seen = new Set<string>();
	const problems: string[] = [];
	for (const source of sources) {
		if (!allowed.has(source) || seen.has(source)) problems.push(source);
		seen.add(source);
	}
	for (const host of tileHosts) {
		if (!seen.has(host)) problems.push(`missing ${host}`);
	}
	return problems;
}

describe('XSS-02 — enforcing app CSP', () => {
	test('script-src forbids unsafe-inline / unsafe-hashes (the stored-XSS control)', () => {
		const scriptSrc = directive(APP_CSP, 'script-src');
		expect(scriptSrc.length).toBeGreaterThan(0);
		expect(scriptSrc).not.toContain("'unsafe-inline'");
		expect(scriptSrc).not.toContain("'unsafe-hashes'");
	});

	test('no third-party origin in script-src / connect-src (no-remote-code, RC-01)', () => {
		// script-src: ABSOLUTE — code loads from this app origin only, ever.
		for (const src of directive(APP_CSP, 'script-src')) {
			expect(src.includes('://'), `script-src must not allow a remote origin: ${src}`).toBe(false);
		}
		// connect-src tolerates exactly two CONFIG-DERIVED classes, never a
		// hardcoded one: the install's OWN media host (DEDALO_MEDIA_WEB_BASE —
		// split-origin installs fetch the transcription WAV from it) and the
		// update masters it is configured to pull from (ONTOLOGY_SERVERS /
		// CODE_SERVERS — both panels interrogate them FROM THE BROWSER). Anything
		// else with a scheme is a third party and fails here.
		const tolerated = new Set(
			[MEDIA_CSP_ORIGIN, ...UPDATE_MASTER_CSP_ORIGINS].filter((origin) => origin !== ''),
		);
		for (const src of directive(APP_CSP, 'connect-src')) {
			if (tolerated.has(src)) continue;
			expect(src.includes('://'), `connect-src must not allow a remote origin: ${src}`).toBe(false);
		}
	});

	test('every configured update master reaches connect-src — and never script-src', () => {
		// The failure this pins is silent and total: without the master's origin
		// in connect-src the browser refuses the fetch before it leaves, and the
		// update panel dies with `Max retries reached, request failed` while the
		// server-to-server reachability probe beside it still reports the master
		// READY (observed live 2026-08-08). Deriving the list is what keeps a
		// configured master and a reachable master the same set.
		const configured = [...config.ontologyIo.servers, ...config.update.codeServers].filter(
			(entry) => /^https?:\/\//.test(entry.url),
		);
		expect(UPDATE_MASTER_CSP_ORIGINS.length).toBe(
			new Set(configured.map((entry) => new URL(entry.url).origin)).size,
		);
		const connectSrc = directive(APP_CSP, 'connect-src');
		const scriptSrc = directive(APP_CSP, 'script-src');
		for (const origin of UPDATE_MASTER_CSP_ORIGINS) {
			expect(connectSrc, `connect-src must carry the configured master ${origin}`).toContain(
				origin,
			);
			// A master hands us ONTOLOGY DATA. It must never be able to hand us code.
			expect(scriptSrc).not.toContain(origin);
			expect(directive(APP_CSP, 'object-src')).not.toContain(origin);
		}
	});

	test('the master-origin derivation holds on SYNTHETIC entries (box-independent)', () => {
		// A master IS configured on a client box and NOT on a master box, so the
		// assertions above go vacuous exactly where this engine is developed.
		// These pin the rules themselves.
		expect(
			deriveUpdateMasterOrigins([
				{ url: 'https://master.dedalo.dev/dedalo/core/api/v1/json/' },
				{ url: 'http://192.168.1.7:4000/dedalo/core/api/v1/json/' },
			]),
		).toEqual(['https://master.dedalo.dev', 'http://192.168.1.7:4000']);

		// The PATH is dropped: a source carrying one would narrow the policy to
		// that single endpoint and break every other call to the same master.
		expect(deriveUpdateMasterOrigins([{ url: 'https://m.example/a/b/c' }])).toEqual([
			'https://m.example',
		]);

		// Two entries on one host (ontology + code master) collapse to one source.
		expect(
			deriveUpdateMasterOrigins([
				{ url: 'https://m.example/dedalo/core/api/v1/json/' },
				{ url: 'https://m.example/core/api/v1/json/' },
			]),
		).toEqual(['https://m.example']);

		// The port is part of the origin — a master on :4000 does not admit :80.
		expect(deriveUpdateMasterOrigins([{ url: 'http://m.example:4000/x' }])).toEqual([
			'http://m.example:4000',
		]);

		// Nothing unreachable, non-network or malformed widens the policy.
		expect(
			deriveUpdateMasterOrigins([
				{ url: '/relative/path' },
				{ url: '' },
				{ url: 'file:///etc/passwd' },
				{ url: 'javascript:alert(1)' },
				{ url: 'data:text/html,x' },
				{ url: 'not a url at all' },
				{ url: 'https://' },
			]),
		).toEqual([]);
	});

	test('object-src is EXACTLY self + the path-scoped envelope prefix (MEDIA-03)', () => {
		// component_image's default edit view hosts the server-generated SVG
		// envelope as <object type="image/svg+xml"> (client
		// component_image/js/view_default_edit_image.js render_image_node), so
		// `object-src 'none'` rendered every edit-view image blank. What replaces
		// it must stay EXACT, not merely "not obviously bad": <object> opens a
		// nested browsing context, so any source added here is a place an SVG's
		// script can execute. An allowlist, deliberately — a denylist here passed
		// `data:`, `blob:`, `https:` and `*.host.example` unmoved (each is one
		// whitespace-split token containing neither '*' alone nor '://'), i.e. it
		// would have been green for exactly the widenings it advertised guarding.
		// The header selection this leans on is gated corpus-independently by
		// media_serving.test.ts::svgSafetyHeaders (the MEDIA-03 route cases there
		// need an .svg on disk and SKIP without one).
		const objectSrc = directive(APP_CSP, 'object-src');
		expect(objectSrc).toEqual(
			MEDIA_CSP_EMBED_SOURCE === '' ? ["'self'"] : ["'self'", MEDIA_CSP_EMBED_SOURCE],
		);
		if (MEDIA_CSP_EMBED_SOURCE !== '') {
			// Path-scoped to the envelope folder — never the bare media host, which
			// also serves uploader-supplied svg/ files. A trailing '/' is what makes
			// CSP treat it as a prefix rather than one exact file. (Since MEDIA-03
			// those uploader files are served `attachment` + sandboxed by the
			// generated rules too, but the scoping is the control that does not
			// depend on the web server being configured correctly.)
			expect(MEDIA_CSP_EMBED_SOURCE.startsWith(`${MEDIA_CSP_ORIGIN}/`)).toBe(true);
			expect(MEDIA_CSP_EMBED_SOURCE.endsWith(`${config.media.image.folder}/`)).toBe(true);
			expect(objectSrc).not.toContain(MEDIA_CSP_ORIGIN);
		}
	});

	test('the embed directives agree on a SYNTHETIC split-origin media host', () => {
		// BOX-INDEPENDENT, and that is the whole point of this case: under `bun test`
		// media is same-origin, so MEDIA_CSP_EMBED_SOURCE is '' and every assertion
		// about the split-origin shape below is vacuous on this machine. The
		// pre-existing object-src gate had the same blind spot, which is exactly how
		// frame-src and object-src came to disagree without anything going red.
		const synthetic = 'https://media.example/dedalo/media/image/';
		const built = buildEmbedDirectives(synthetic);
		expect(built.frameSrc).toBe(`frame-src 'self' blob: ${synthetic}`);
		expect(built.objectSrc).toBe(`object-src 'self' ${synthetic}`);
		// THE INVARIANT: whatever off-origin source one embed directive admits, the
		// other admits too. An <object> loading a document opens a nested browsing
		// context, which Chrome checks against BOTH — so a source in one and not the
		// other is a policy that contradicts itself, and the symptom is a blank image
		// in every component_image edit view on a split-origin install.
		const offOrigin = (directiveText: string): string[] =>
			directiveText.split(' ').filter((source) => source.includes('://'));
		expect(offOrigin(built.frameSrc)).toEqual([synthetic]);
		expect(offOrigin(built.frameSrc)).toEqual(offOrigin(built.objectSrc));
		// And never the bare host: the uploader-supplied population lives under svg/,
		// which this prefix excludes.
		expect(built.frameSrc).not.toContain(' https://media.example ');
		// Same-origin install: no off-origin source anywhere, and no dangling space.
		const empty = buildEmbedDirectives('');
		expect(empty.frameSrc).toBe("frame-src 'self' blob:");
		expect(empty.objectSrc).toBe("object-src 'self'");
	});

	test('frame-src carries the SAME envelope source as object-src (2026-08-24)', () => {
		// MEASURED IN CHROME, not reasoned: an `<object>` that loads a document opens
		// a nested browsing context, and Chrome checks it against `frame-src` as well
		// as `object-src`. With the prefix in object-src ONLY, a split-origin install
		// reported
		//   Framing 'http://<media host>/' violates … "frame-src 'self' blob:"
		// and every image in the component_image edit view rendered blank — the exact
		// symptom `object-src 'none'` used to produce. A policy whose two embed
		// directives disagree is a policy that contradicts itself, and the
		// contradiction is invisible until a split-origin install opens an image.
		const frameSrc = directive(APP_CSP, 'frame-src');
		const objectSrc = directive(APP_CSP, 'object-src');
		expect(frameSrc).toEqual(
			MEDIA_CSP_EMBED_SOURCE === ''
				? ["'self'", 'blob:']
				: ["'self'", 'blob:', MEDIA_CSP_EMBED_SOURCE],
		);
		// The invariant, stated as such: whatever media source either one admits,
		// both admit — and it is never the bare host.
		const mediaOf = (sources: string[]): string[] =>
			sources.filter((source) => source.includes('://'));
		expect(mediaOf(frameSrc)).toEqual(mediaOf(objectSrc));
		if (MEDIA_CSP_EMBED_SOURCE !== '') {
			expect(frameSrc).not.toContain(MEDIA_CSP_ORIGIN);
		}
	});

	test('the configured media origin reaches media/img/connect — and never script', () => {
		if (MEDIA_CSP_ORIGIN === '') {
			// Same-origin install: 'self' covers media; nothing to add anywhere.
			// Any absolute origin still in the policy must then be an update
			// master — the only other config-derived source (asserted above).
			for (const name of ['media-src', 'img-src', 'script-src', 'object-src']) {
				for (const src of directive(APP_CSP, name)) {
					expect(src.includes('://'), `${name} must carry no absolute origin: ${src}`).toBe(false);
				}
			}
			return;
		}
		for (const name of ['media-src', 'img-src', 'connect-src']) {
			expect(
				directive(APP_CSP, name),
				`${name} must carry the configured media origin (split-origin installs play no media without it)`,
			).toContain(MEDIA_CSP_ORIGIN);
		}
		expect(directive(APP_CSP, 'script-src')).not.toContain(MEDIA_CSP_ORIGIN);
	});

	test('the importmap hash matches index.html (edit without rehash = no boot)', () => {
		const html = readFileSync(join(ROOT, 'client/dedalo/core/page/index.html'), 'utf8');
		const match = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
		const importmap = match?.[1];
		expect(importmap, 'index.html must ship exactly one importmap').toBeString();
		const fresh = `sha256-${createHash('sha256')
			.update(importmap ?? '')
			.digest('base64')}`;
		expect(
			APP_CSP.includes(`'${fresh}'`),
			`APP_CSP script-src must carry the importmap hash '${fresh}'`,
		).toBe(true);
	});

	test('the CSP is actually served', () => {
		expect(SECURITY_HEADERS['Content-Security-Policy']).toBe(APP_CSP);
	});

	test('img-src admits no OpenStreetMap or Carto host: those tiles come through the same-origin proxy', () => {
		const imgSrc = directive(APP_CSP, 'img-src');
		for (const migrated of [
			'*.tile.openstreetmap.org',
			'*.tile.osm.org',
			'tile.openstreetmap.org',
			'*.basemaps.cartocdn.com',
		]) {
			expect(imgSrc, migrated).not.toContain(migrated);
		}
		expect(imgSrc.some((src) => /openstreetmap|osm\.org|cartocdn/.test(src))).toBe(false);
		expect(imgSrc, "'self' is what admits the proxy's same-origin tiles").toContain("'self'");
	});

	test('img-src is EXACTLY self, data:, blob:, the media origin and DIRECT_TILE_HOSTS — no scheme-wide source, wildcard or other host rides along', () => {
		const imgSrc = directive(APP_CSP, 'img-src');
		expect(imgSrcProblems(imgSrc, MEDIA_CSP_ORIGIN, DIRECT_TILE_HOSTS)).toEqual([]);
		expect(imgSrc).toEqual([
			"'self'",
			'data:',
			'blob:',
			...(MEDIA_CSP_ORIGIN === '' ? [] : [MEDIA_CSP_ORIGIN]),
			...DIRECT_TILE_HOSTS,
		]);
		expect([...DIRECT_TILE_HOSTS]).toEqual(['server.arcgisonline.com', 'dh.gu.se']);
		for (const host of DIRECT_TILE_HOSTS) expect(host.includes('*'), host).toBe(false);
		expect(Object.isFrozen(DIRECT_TILE_HOSTS)).toBe(true);
		// …and none of them reaches a directive that runs code
		for (const name of ['script-src', 'worker-src', 'connect-src', 'frame-src', 'object-src']) {
			for (const host of DIRECT_TILE_HOSTS)
				expect(directive(APP_CSP, name), name).not.toContain(host);
		}
	});

	test('the img-src check refuses what the proxy removed: a scheme-wide source, a wildcard, a scheme-qualified or stray host', () => {
		const sound = ["'self'", 'data:', 'blob:', ...DIRECT_TILE_HOSTS];
		expect(imgSrcProblems(sound, '', DIRECT_TILE_HOSTS)).toEqual([]);
		// the page loading images from anywhere: the exact thing the proxy took out of the policy
		for (const wide of ['https:', 'http:', 'ws:', '*', '*.example.org', 'https://example.org']) {
			const widened = [...sound, wide];
			expect(imgSrcProblems(widened, '', DIRECT_TILE_HOSTS), wide).toEqual([wide]);
			// …wherever in the list it sits
			expect(imgSrcProblems([wide, ...sound], '', DIRECT_TILE_HOSTS), `${wide} first`).toEqual([
				wide,
			]);
		}
		// a host the client no longer draws from, a missing one, and a repeated one
		expect(imgSrcProblems([...sound, 'tile.openstreetmap.org'], '', DIRECT_TILE_HOSTS)).toEqual([
			'tile.openstreetmap.org',
		]);
		expect(imgSrcProblems(sound.slice(0, -1), '', DIRECT_TILE_HOSTS)).toEqual(['missing dh.gu.se']);
		expect(imgSrcProblems([...sound, 'dh.gu.se'], '', DIRECT_TILE_HOSTS)).toEqual(['dh.gu.se']);
		// the media origin is admitted only where it is configured
		expect(
			imgSrcProblems(
				["'self'", 'data:', 'blob:', 'https://media.example.org', ...DIRECT_TILE_HOSTS],
				'https://media.example.org',
				DIRECT_TILE_HOSTS,
			),
		).toEqual([]);
		expect(
			imgSrcProblems(
				["'self'", 'data:', 'blob:', 'https://media.example.org', ...DIRECT_TILE_HOSTS],
				'',
				DIRECT_TILE_HOSTS,
			),
		).toEqual(['https://media.example.org']);
	});

	test('the hosts EVERY client script draws map layers from directly are exactly DIRECT_TILE_HOSTS, and no layer’s address is beyond proof', () => {
		const direct = new Set<string>();
		const unprovable: string[] = [];
		let filesWithLayers = 0;
		for (const file of clientScriptFiles()) {
			const text = readFileSync(join(ROOT, file), 'utf8');
			if (!LAYER_WORDS.test(text)) continue;
			const found = layerAddresses(text);
			if (found.layers > 0) filesWithLayers++;
			for (const host of found.hosts) direct.add(host);
			for (const where of found.unprovable) unprovable.push(`${file}:${where}`);
		}
		expect(unprovable, 'an address a layer is built on that this gate cannot read').toEqual([]);
		expect([...direct].sort()).toEqual([...DIRECT_TILE_HOSTS].sort());
		// Anti-vacuity: the scan does find the layers it is about…
		expect(filesWithLayers).toBeGreaterThan(0);
		expect(direct.size).toBeGreaterThan(0);
		// …and a proxied layer is not a literal address at all: the OSM hosts appear nowhere in
		// the geolocation client but as the attribution LINK, which is an <a href>, not an image.
		const source = readFileSync(
			join(ROOT, 'client/dedalo/core/component_geolocation/js/component_geolocation.js'),
			'utf8',
		)
			.split('\n')
			.filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
			.join('\n');
		expect(source).not.toMatch(/\{s\}\.tile|tile\.openstreetmap\.org|tile\.osm\.org|cartocdn/);
		expect(source).toContain("'/api/v1/map_tile'");
	});

	test('the layer scan reads every spelling of an address, and refuses the ones it cannot prove', () => {
		const hostsOf = (code: string) => layerAddresses(code).hosts.sort();
		// any quote style, a template literal, a concatenation, a protocol-relative address
		expect(hostsOf('L.tileLayer("https://a.example.org/{z}/{x}/{y}.png")')).toEqual([
			'a.example.org',
		]);
		expect(hostsOf('L.tileLayer(`https://b.example.org/${z}/{x}/{y}.png`)')).toEqual([
			'b.example.org',
		]);
		expect(hostsOf("new L.TileLayer.WMS('https://c.example.org/wms', {})")).toEqual([
			'c.example.org',
		]);
		expect(hostsOf('L.tileLayer.wms("//d.example.org/wms")')).toEqual(['d.example.org']);
		expect(hostsOf("L.imageOverlay('https://e.example.org/i.png', bounds)")).toEqual([
			'e.example.org',
		]);
		expect(hostsOf("new L.tileLayer('https://f.example.org/' + 'x/{z}')")).toEqual([
			'f.example.org',
		]);
		// a variable, a conditional, and a variable declared later than its use
		expect(
			hostsOf(
				"const u = ready ? 'https://g.example.org/{z}' : self.get_tile_url({builtin:'osm'}); L.tileLayer(u)",
			),
		).toEqual(['g.example.org']);
		expect(hostsOf("L.tileLayer(late); const late = 'https://h.example.org/{z}'")).toEqual([
			'h.example.org',
		]);
		// the proxy is the one form that needs no host, and neither does a comment, a string
		// that merely mentions a layer, or something that is not a layer
		expect(layerAddresses("L.tileLayer(self.get_tile_url({builtin:'osm'}))")).toEqual({
			layers: 1,
			hosts: [],
			unprovable: [],
		});
		expect(
			layerAddresses(
				"// L.tileLayer('https://i.example.org/{z}')\nfoo.wms('https://j.example.org')",
			),
		).toEqual({
			layers: 0,
			hosts: [],
			unprovable: [],
		});
		// an address the scan cannot read is a failure, not a pass
		for (const code of [
			'L.tileLayer(someUrl)',
			'L.tileLayer(config.url)',
			'L.tileLayer(buildUrl())',
			'L.tileLayer(`${base}/{z}/{x}/{y}.png`)',
			"L.tileLayer(flag ? 'https://k.example.org/{z}' : other)",
			'L.imageOverlay(url_of(record), bounds)',
		]) {
			expect(layerAddresses(code).unprovable.length, code).toBe(1);
		}
	});
});

// ---------------------------------------------------------------------------
// The layer scan
// ---------------------------------------------------------------------------

/** The Leaflet constructors that load an image from an address they are handed. */
const LAYER_CONSTRUCTORS: ReadonlySet<string> = new Set([
	'tileLayer',
	'TileLayer',
	'imageOverlay',
	'ImageOverlay',
	'videoOverlay',
	'VideoOverlay',
]);

/** `tileLayer.wms` / `TileLayer.WMS`: the last name alone says nothing, the chain must include a tile layer. */
const WMS_NAMES: ReadonlySet<string> = new Set(['wms', 'WMS']);

/** A cheap text filter before the parse: a file that never names a layer constructor has none. */
const LAYER_WORDS = /tileLayer|TileLayer|imageOverlay|ImageOverlay|videoOverlay|VideoOverlay/;

/** The scripts the page or a tool loads: every .js of client/ and tools/ except libraries and the client's own tests. */
function clientScriptFiles(): string[] {
	const found: string[] = [];
	for (const pattern of ['client/**/*.js', 'tools/**/*.js']) {
		for (const file of new Glob(pattern).scanSync({ cwd: ROOT })) {
			const path = relative(ROOT, join(ROOT, file));
			const skipped =
				/(?:^|\/)(?:lib|node_modules)\//.test(path) || path.startsWith('client/dedalo/test/');
			if (!skipped) found.push(path);
		}
	}
	return found;
}

/** What one layer's address is: the proxy, a host, the page's own origin, or beyond proof. */
type AddressKind =
	| { readonly kind: 'proxy' }
	| { readonly kind: 'self' }
	| { readonly kind: 'host'; readonly host: string }
	| { readonly kind: 'unprovable' };

const PROVEN_PROXY: AddressKind = { kind: 'proxy' };
const UNPROVABLE: AddressKind = { kind: 'unprovable' };

/** The names along a callee: `L.tileLayer.wms` → ['L', 'tileLayer', 'wms']. */
function calleeNames(callee: AstNode): string[] {
	if (callee.type === 'Identifier') return [nameOf(callee)];
	if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
		return [...calleeNames(callee.object as AstNode), nameOf(callee.property)];
	}
	return [];
}

/** True when `callee` builds a Leaflet layer from an address. */
function isLayerConstructor(callee: AstNode): boolean {
	const names = calleeNames(callee);
	const last = names.at(-1) ?? '';
	if (LAYER_CONSTRUCTORS.has(last)) return true;
	return WMS_NAMES.has(last) && names.some((name) => name === 'tileLayer' || name === 'TileLayer');
}

/** The host a literal address starts with, 'self' for a same-origin path, or null for text with no address. */
function literalAddress(text: string): AddressKind {
	if (/^(?:https?:)?\/\//i.test(text)) {
		const host = URL.parse(text.startsWith('//') ? `https:${text}` : text)?.hostname;
		return host === undefined ? UNPROVABLE : { kind: 'host', host };
	}
	return /^[/A-Za-z0-9._-]/.test(text) ? { kind: 'self' } : UNPROVABLE;
}

/** Every `VariableDeclarator` init of `name` in the program. */
function initsOf(program: AstNode, name: string): AstNode[] {
	const inits: AstNode[] = [];
	walkAst(program, [], (node) => {
		const id = node.id as AstNode | undefined;
		if (node.type === 'VariableDeclarator' && id?.type === 'Identifier' && nameOf(id) === name) {
			if (node.init) inits.push(node.init as AstNode);
		}
	});
	return inits;
}

/** What the address expression `node` is: every branch it can take, none of them beyond proof. */
function classifyAddress(node: AstNode, program: AstNode, seen: Set<string>): AddressKind[] {
	switch (node.type) {
		case 'StringLiteral':
			return [literalAddress(node.value as string)];
		case 'TemplateLiteral': {
			const head = (node.quasis as { value: { cooked: string } }[])[0]?.value.cooked ?? '';
			return [head === '' ? UNPROVABLE : literalAddress(head)];
		}
		case 'BinaryExpression':
			return node.operator === '+'
				? classifyAddress(node.left as AstNode, program, seen)
				: [UNPROVABLE];
		case 'ConditionalExpression':
			return [
				...classifyAddress(node.consequent as AstNode, program, seen),
				...classifyAddress(node.alternate as AstNode, program, seen),
			];
		case 'LogicalExpression':
			return [
				...classifyAddress(node.left as AstNode, program, seen),
				...classifyAddress(node.right as AstNode, program, seen),
			];
		case 'CallExpression':
			return calleeNames(node.callee as AstNode).at(-1) === 'get_tile_url'
				? [PROVEN_PROXY]
				: [UNPROVABLE];
		case 'Identifier':
			return classifyIdentifier(nameOf(node), program, seen);
		default:
			return [UNPROVABLE];
	}
}

/** An identifier is what every declaration of it in the file says; none found is beyond proof. */
function classifyIdentifier(name: string, program: AstNode, seen: Set<string>): AddressKind[] {
	if (seen.has(name)) return [UNPROVABLE];
	const inits = initsOf(program, name);
	if (inits.length === 0) return [UNPROVABLE];
	const next = new Set(seen).add(name);
	return inits.flatMap((init) => classifyAddress(init, program, next));
}

/** The layers `code` builds: how many, the hosts it draws from directly, and where an address is beyond proof. */
function layerAddresses(code: string): { layers: number; hosts: string[]; unprovable: string[] } {
	const program = parse(code, { sourceType: 'module', errorRecovery: false })
		.program as unknown as AstNode;
	const out = { layers: 0, hosts: new Set<string>(), unprovable: [] as string[] };
	walkAst(program, [], (node) => {
		if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return;
		if (!isLayerConstructor(node.callee as AstNode)) return;
		out.layers++;
		const first = (node.arguments as AstNode[])[0];
		const kinds = first === undefined ? [UNPROVABLE] : classifyAddress(first, program, new Set());
		const line = (node.loc as { start: { line: number } } | undefined)?.start.line ?? 0;
		for (const kind of kinds) {
			if (kind.kind === 'host') out.hosts.add(kind.host);
			if (kind.kind === 'unprovable') out.unprovable.push(String(line));
		}
	});
	return { layers: out.layers, hosts: [...out.hosts], unprovable: out.unprovable };
}
