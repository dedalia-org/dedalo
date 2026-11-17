/**
 * THE CLIENT-LIB REGISTRY — the single allowlist of third-party browser
 * libraries the client may load, and the only place their filesystem roots are
 * declared.
 *
 * Every lib is served at `/dedalo/lib/<id>/<subpath>` and resolves to exactly one
 * root below. There is no filesystem `client/dedalo/lib/` any more: a lib comes
 * either from the package manager (`bun install` → node_modules/) or from the
 * committed `vendor/` tree. Nothing is fetched at install time.
 *
 * SECURITY — this registry IS the chokepoint. `node_modules/` also holds the
 * SERVER's own dependencies (the Anthropic SDK, zod, the MCP SDK, Puppeteer…).
 * The serving route must key on an id in this table and NEVER map a request path
 * into node_modules directly, or the whole dependency tree becomes web-readable.
 *
 * Versions are PINNED EXACTLY in package.json (no `^`), because the pins were
 * chosen by byte-comparing each file against the previously-vendored copy: 18 of
 * the 20 files the client loads are byte-identical to what shipped before. The two
 * that are not: `highlightjs` (differs only by the build hash in its banner — same
 * release) and `chai` (the old copy was a CDN UMD build; since chai 6 the package is
 * ESM-only and the harness imports it through its import map — test-harness-only either way).
 *
 * INTEGRITY — the two sources are guarded by two different mechanisms, and BOTH
 * must exist. An `npm` lib is pinned by the lockfile's `sha512-` integrity; a
 * `vendor` lib has no lockfile line at all, so its bytes are pinned by a tree
 * digest in `vendor/vendor_manifest.json`, recomputed by
 * `scripts/vendor_verify.ts` on every `bun test` and in hermetic CI. A dependency
 * shape that gets NEITHER — a bare archive URL in package.json, which bun records
 * without integrity — is refused by
 * `test/unit/dependency_integrity_tripwire.test.ts`; a lib published only as an
 * archive URL is vendored (with a manifest row), never installed.
 *
 * Adding a lib: add an entry here, add the dep to package.json (or drop it in
 * `vendor/` with a `reason` AND a vendor_manifest.json row), and point `probe` at a
 * file that must exist. The client_libs tripwire GETs every probe — a lib that is
 * missing, misplaced, or renamed by an upstream reshuffle fails loudly instead of
 * 404ing in the browser.
 */

import { resolve } from 'node:path';
import { projectRoot } from '../../config/env.ts';
import { readString } from '../../config/readers.ts';

/**
 * Where a lib's bytes come from. Drives the tripwire and the docs, not the routing.
 *
 * TWO sources, two roots — and nothing else. There is no install-time fetch step, no
 * postinstall hook, no download cache:
 *   npm     → node_modules/…   installed by `bun install`, gitignored
 *   vendor  → vendor/…         COMMITTED to git
 *
 * A `bun install` is the whole setup story, and a clone is self-contained: no network
 * beyond the package registry, nothing to materialise, nothing that can be half-built.
 */
export type LibSource =
	/** A pinned package.json dependency — Dependabot/CVE alerts apply. */
	| 'npm'
	/** COMMITTED under vendor/. No installable package exists; needs a `reason`. */
	| 'vendor';

export interface ClientLib {
	/** Filesystem root, relative to the repo root. */
	readonly base: string;
	readonly source: LibSource;
	/**
	 * A file that MUST resolve under `base` — the tripwire fetches it. Pick the
	 * file the client actually loads, so an upstream layout change is caught.
	 */
	readonly probe: string;
	/**
	 * Only served when DEDALO_DEV_MODE=true. These are devDependencies, so they are
	 * absent after `bun install --frozen-lockfile --production` on a deploy host —
	 * serving them in production would 404 anyway; gating them says so on purpose.
	 */
	readonly devOnly?: boolean;
	/** Why this lib is not package-manager-tracked. Required for vendor/fetched. */
	readonly reason?: string;
	/**
	 * One human line for the npm version table in
	 * docs/development/vendored_library_versions.md, which is GENERATED from this
	 * registry + package.json (`bun run libs:gen`; byte-gated by
	 * client_lib_versions_doc_tripwire). Version and package are derived, never
	 * written here.
	 */
	readonly note?: string;
}

/**
 * id → lib. The id is the URL segment and is deliberately DECOUPLED from the
 * package name, so swapping the underlying package (jsoneditor →
 * vanilla-jsoneditor) never touches a client file.
 */
export const CLIENT_LIBS: Readonly<Record<string, ClientLib>> = {
	// --- package-manager tracked ------------------------------------------------
	three: {
		base: 'node_modules/three',
		source: 'npm',
		probe: 'build/three.module.js',
		note: '`examples/jsm/` reached via the client import map.',
	},
	d3: {
		base: 'node_modules/d3',
		source: 'npm',
		probe: 'dist/d3.min.js',
		note: 'The version does not appear in the URL.',
	},
	jsoneditor: { base: 'node_modules/vanilla-jsoneditor', source: 'npm', probe: 'standalone.js' },
	leaflet: { base: 'node_modules/leaflet', source: 'npm', probe: 'dist/leaflet.js' },
	geoman: {
		base: 'node_modules/@geoman-io/leaflet-geoman-free',
		source: 'npm',
		probe: 'dist/leaflet-geoman.min.js',
		note: "Was bundled *inside* leaflet's `dist/`; now its own dep.",
	},
	turf: {
		base: 'node_modules/@turf/turf',
		source: 'npm',
		probe: 'turf.min.js',
		note: "Was bundled *inside* leaflet's `dist/`; now its own dep.",
	},
	split: {
		base: 'node_modules/split.js',
		source: 'npm',
		probe: 'dist/split.es.js',
		note: 'Used by the indexation tool.',
	},
	iro: { base: 'node_modules/@jaames/iro', source: 'npm', probe: 'dist/iro.min.js' },
	'codex-tooltip': {
		base: 'node_modules/codex-tooltip',
		source: 'npm',
		probe: 'dist/tooltip.js',
	},
	highlightjs: {
		// The `highlight.js` package's es/ entry is a bundler stub that chains into a
		// CommonJS lib/ — unusable in a browser without a bundler. @highlightjs/cdn-assets
		// ships the SAME release as browser-ready ESM, which is what the client loads.
		base: 'node_modules/@highlightjs/cdn-assets',
		source: 'npm',
		probe: 'es/core.min.js',
		note: 'Not `highlight.js` — see below.',
	},
	onnxruntime: {
		// Transformers.js runs its models on onnxruntime-web, whose WASM binaries it
		// otherwise fetches from a CDN at inference time. Since the transformers
		// bundle is vendored (above) this is the ONLY onnxruntime-web the lockfile
		// holds — pinned explicitly because the registry only serves what the
		// lockfile names, and because the WASM build must match the runtime that
		// loads it (wasmPaths → /dedalo/lib/onnxruntime/dist/).
		//
		// PINNED TO A -dev BUILD ON PURPOSE (the stated reason the latest-stable
		// policy asks for): the vendored bundle compiles in onnxruntime-web's JS
		// core, so this pin is EXACTLY the version that transformers.js release
		// declares — the pair upstream built and tested, rather than a newer
		// "stable" glue under an older core that nobody tested together.
		// onnxruntime_alignment_tripwire holds bundle = package.json = bun.lock, so
		// a lone Dependabot bump of this package is red: it moves with a re-vendor.
		base: 'node_modules/onnxruntime-web',
		source: 'npm',
		// The glue the bundle actually loads (its loader names .asyncify, never .jsep).
		probe: 'dist/ort-wasm-simd-threaded.asyncify.wasm',
		note: "Transformers.js's WASM runtime; the only `onnxruntime-web` the lockfile holds.",
	},
	qrcode: {
		// EasyQRCodeJS (tool_qr). Until P2-5-residue (CLI-12) this was a 4.6.1 copy
		// committed under tools/tool_qr/lib/ — served to browsers with no lockfile
		// line, no digest, no advisory watch. The dist is on the registry, so it is
		// a pin: the UMD bundle binds `QRCode` on globalThis when imported.
		base: 'node_modules/easyqrcodejs',
		source: 'npm',
		probe: 'dist/easy.qrcode.min.js',
		note: 'The QR tool. Was a copy committed under its own `lib/` directory with no digest.',
	},
	'dom-to-image': {
		// dom-to-image-more: renders a DOM subtree (a Leaflet map, its tiles and
		// vectors) to a PNG/JPEG Blob in the browser. The UMD dist binds
		// `domtoimage` on the global object, so it is loaded as a classic script.
		base: 'node_modules/dom-to-image-more',
		source: 'npm',
		probe: 'dist/dom-to-image-more.min.js',
		note: 'Renders a map view to an image for download.',
	},
	svgedit: {
		// Was a vendored ~7.2.x-era build (2.0 MB) with no upstream package. 7.4.2 is a
		// verified drop-in: same default export, all 29 methods + 3 properties
		// vector_editor.js uses, and an identical add→serialise→read-back round trip —
		// including `xlink:href`, which the stored layer JSON depends on (the 7.2.7
		// "prefer href to xlink href" change does NOT rewrite it).
		base: 'node_modules/@svgedit/svgcanvas',
		source: 'npm',
		probe: 'dist/svgcanvas.js',
		note: 'Replaced a vendored ~7.2.x build. See below.',
	},

	// --- dev-only (client test harness; devDependencies) -------------------------
	mocha: {
		base: 'node_modules/mocha',
		source: 'npm',
		probe: 'mocha.js',
		devOnly: true,
		note: 'Client test harness.',
	},
	// chai 5 dropped the UMD bundle: `index.js` is a self-contained ESM bundle (no bare
	// specifiers), loaded through the harness import map. See client/dedalo/test/client/.
	chai: {
		base: 'node_modules/chai',
		source: 'npm',
		probe: 'index.js',
		devOnly: true,
		note: 'Client test harness.',
	},

	// --- COMMITTED under vendor/ (5 trees; digest-pinned, see the header) ---------
	transformers: {
		// The in-browser AI runtime (tool_transcription's speech recognition,
		// tool_lang's translation, the remove_background processor). It USED to be
		// imported straight from a CDN by each tool — which made "local, private
		// inference" depend on a third party being reachable, and leaked to that
		// third party WHEN a record was being transcribed. Served from here, an
		// air-gapped archive works and nothing leaves the building.
		base: 'vendor/transformers',
		source: 'vendor',
		probe: 'dist/transformers.js',
		reason:
			'The npm package is a Node-side bundle first: its `dependencies` pull onnxruntime-node (211 MB of native binaries, unpacked at install by adm-zip) and sharp/@img (16 MB of libvips) into every `bun install --production` of every installation and of every code-update quarantine — while the engine imports NONE of it (no src/tools/publication module names @huggingface/transformers; the browser is the only consumer, through this registry). That never-executed native closure was also the only path to two of the three HIGH advisories the dependency baseline accepted (adm-zip, sharp). A browser-only bundle has no install-time Node dependency at all, so dist/transformers.js — the ONE file any client imports — is committed under vendor/ (P1-23 / DEAD-12, 2026-09-04): byte-identical to the 4.2.0 lockfile install it replaces, archive sha256 recorded in vendor/vendor_manifest.json, feed-watched by vendor_advisory_tripwire; the 567 MB stops shipping, and production_import_tripwire keeps a never-imported production dependency from coming back. Its onnxruntime WASM glue is NOT in this tree: every importer pins env.backends.onnx.wasm.wasmPaths to /dedalo/lib/onnxruntime/dist/ (the `onnxruntime` row below, an explicit npm pin), which no_remote_code_tripwire enforces.',
	},
	ckeditor: {
		base: 'vendor/ckeditor',
		source: 'vendor',
		probe: 'build/ckeditor.js',
		reason:
			'Custom Dédalo webpack build of CKEditor 5 42.0.1 (a bespoke ddEditor class plus the dedalo_image_tags and reference plugins). The build project no longer exists in any checkout — build/ckeditor.js.map is the only surviving copy of that plugin source, which is why the map is committed too. Not reproducible from npm.',
	},
	'json-view': {
		base: 'vendor/json-view',
		source: 'vendor',
		probe: 'jsonview.bundle.js',
		reason: 'pgrabovets/json-view is distributed via GitHub/jsDelivr only; never published to npm.',
	},

	'lz-string': {
		base: 'vendor/lz-string',
		source: 'vendor',
		probe: 'lz-string.js',
		reason:
			'lz-string ships UMD only (libs/lz-string.js declares a top-level `var LZString` and exports through define/module/angular — no ESM entry, no `module` field in any release up to 1.5.0). A classic <script> would make it a global; an ES module import cannot reach a module-scoped var, and this client is all modules. So the registry copy is unusable as served, and the tree under vendor/ is the 1.5.0 npm dist (archive sha256 recorded in vendor/vendor_manifest.json) with ONE declared patch: `var LZString =` → `export const LZString =` and the UMD tail removed. The patch is stated in the manifest row and covered by its tree digest. Until P2-5-residue (CLI-12) this was a 1.4.5 copy with the same patch committed under client/dedalo/core/common/js/utils/ with no digest and no advisory watch.',
	},

	pdfjs: {
		base: 'vendor/pdfjs',
		source: 'vendor',
		probe: 'web/viewer.html',
		reason:
			"npm's pdfjs-dist ships the pdf.js COMPONENT library (web/pdf_viewer.mjs), not the standalone viewer app — and component_pdf iframes web/viewer.html, the whole Mozilla app. That exists only in the pdfjs-<version>-dist.zip GitHub release, which bun cannot install (it takes a tarball URL, but not a .zip). Committed from the sha256-verified 6.2.108 release — archive digest 7bf642d5…e95ba, the full digest GitHub publishes for the asset, recorded in vendor/vendor_manifest.json. Bumped from 5.7.284 on 2026-08-28 for GHSA-hq66-cqwq-w95j / CVE-2026-16633 (HIGH, arbitrary JavaScript execution on opening a malicious PDF, >= 5.6.83 < 6.2.108); 6.2.108 is also the npm dist-tag latest, so the advisory fix and this project's latest-stable law were one move. The tree is the archive MINUS 5 files — 9.0 MB of sourcemaps and the 1.0 MB demo PDF that view_default_edit_pdf.js disables anyway by clearing defaultUrl — and byte-identical to it otherwise: 404 of 409 files, verified against a fresh download 2026-08-28. 3.5 MB gzipped. The mount also forces enableScripting:false (the advisory's own stated workaround) behind disablePreferences:true, so the mitigation survives a revert of the bump; gated by test/unit/vendor_advisory_tripwire.test.ts, which also refuses a row whose declared version is not in these bytes.",
	},
} as const;

/**
 * True when the client test harness (and its dev-only libs) may be served. Read
 * per-call, not memoized at module load, so a test can flip DEDALO_DEV_MODE.
 */
export function isDevMode(): boolean {
	return readString('DEDALO_DEV_MODE') === 'true';
}

/** Absolute filesystem root for a lib id, or null when the id is not registered. */
export function libRoot(id: string): string | null {
	const lib = CLIENT_LIBS[id];
	if (lib === undefined) return null;
	return resolve(projectRoot, lib.base);
}
