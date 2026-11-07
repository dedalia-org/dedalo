/**
 * get_dedalo_files — the service-worker pre-cache manifest (PHP
 * dd_utils_api::get_dedalo_files, class.dd_utils_api.php:1897).
 *
 * The client SW (service_worker.js / worker_cache.js) calls this on install and whenever a
 * new dedalo_version is detected, then pre-caches every returned URL. PHP walks
 * the real filesystem rather than keeping a static list so newly added files
 * are included automatically; this port keeps that behavior, but walks the
 * trees the TS server actually SERVES so every returned URL resolves here:
 *
 *  - core:        client/dedalo/core (the copied client tree) → /dedalo/core/…
 *  - tools:       the in-repo primary tools root               → /dedalo/tools/…
 *    (PHP scans only DEDALO_TOOLS_PATH; additional roots are likewise not
 *    manifested here.)
 *  - tool_common: PHP serves it from tools/tool_common; the TS client keeps that
 *    machinery at client/dedalo/core/tools_common (WC-006), served at
 *    /dedalo/core/tools_common/ — the manifest emits the TS URL so the SW caches
 *    a fetchable path. It is INSIDE the core tree on disk, so the core walk
 *    skips it (TOOLS_COMMON_REL) and it keeps its own block below: that block
 *    holds the PHP ENTRY ORDER (after core js, before tools) and applies the
 *    TOOLS filter rule PHP applied to it — the core rule would drop its css and
 *    list it in a different place.
 *
 * Filter rules are a 1:1 port of the PHP method (including its case
 * sensitivity quirks and the tools-branch entries all being typed 'js').
 */

import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { readEnv } from '../../config/env.ts';
import { getRoots, TOOL_COMMON_CLIENT_DIR, TOOLS_URL_BASE } from '../tools/paths.ts';
import { DEDALO_ENGINE_VERSION } from '../update/build_stamp.ts';

/** One manifest entry ({type,url}, PHP shape). */
export interface DedaloFileEntry {
	type: 'js' | 'css';
	url: string;
}

/** Absolute root of the copied client core tree (served at /dedalo/core/). */
const CLIENT_CORE_ROOT = resolve(import.meta.dir, '../../../client/dedalo/core');

/** Web bases (PHP DEDALO_CORE_URL and the TS tools_common seam). */
const CORE_URL = '/dedalo/core';
const TOOLS_COMMON_URL = `${CORE_URL}/tools_common`;
/** tools_common's path INSIDE the core tree (it has its own manifest block). */
const TOOLS_COMMON_REL = '/tools_common/';

/**
 * Recursively collect files with an allowed extension under `dir` (PHP
 * get_dir_files, shared/core_functions.php:772). Returns root-relative paths
 * with a leading '/'. PHP's RecursiveDirectoryIterator order is
 * filesystem-dependent; we sort per directory so the manifest is deterministic
 * (differential gates normalize order).
 */
function walkDirFiles(root: string, extensions: readonly string[], relBase = ''): string[] {
	let entries: import('node:fs').Dirent[];
	try {
		entries = readdirSync(relBase === '' ? root : root + relBase, { withFileTypes: true });
	} catch {
		// PHP get_dir_files warns and returns [] on a missing directory.
		return [];
	}
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const files: string[] = [];
	for (const entry of entries) {
		const rel = `${relBase}/${entry.name}`;
		if (entry.isDirectory()) {
			files.push(...walkDirFiles(root, extensions, rel));
			continue;
		}
		if (!entry.isFile()) continue; // fail-closed on symlinks/specials
		const dot = entry.name.lastIndexOf('.');
		const ext = dot === -1 ? '' : entry.name.slice(dot + 1);
		if (extensions.includes(ext)) files.push(rel);
	}
	return files;
}

/** Core path fragments dropped case-INSENSITIVELY (PHP stripos). */
const CORE_EXCLUDED_ANY_CASE: readonly string[] = [
	'/acc/',
	'/old/',
	'/lib/', // libraries
];

/** Core path fragments dropped case-SENSITIVELY (PHP strpos). */
const CORE_EXCLUDED_EXACT_CASE: readonly string[] = [
	'/themes/', // themes directory
	'/ontology/', // old ontology files (no modules)
	'/test/',
	'/plug-ins/',
	'/fonts/',
	'worker_cache.js',
	'/service_worker.js', // the service worker itself
	'/sw.js', // the retired-URL tombstone (core/sw.js)
];

/**
 * Core JS filter (PHP get_dedalo_files, core branch) — exact port, including
 * which checks are case-insensitive (PHP stripos) vs case-sensitive (strpos).
 */
function coreFileUrl(rel: string): string | null {
	const lower = rel.toLowerCase();
	if (
		CORE_EXCLUDED_ANY_CASE.some((needle) => lower.includes(needle)) ||
		CORE_EXCLUDED_EXACT_CASE.some((needle) => rel.includes(needle))
	) {
		return null;
	}
	// only js dirs
	if (!rel.includes('/js/')) return null;
	return CORE_URL + rel;
}

/**
 * Tools filter (PHP get_dedalo_files, tools branch): drop /acc/ /old/ /lib/
 * (case-insensitive), and require the first level under the tool dir to be
 * js/ or css/ (rel = '/<tool>/js/…' → segments ['', '<tool>', 'js', …]).
 * Deeper nesting under js/ is allowed (e.g. tool_common js/processors/…).
 */
function toolFileRelIsIncluded(rel: string): boolean {
	const lower = rel.toLowerCase();
	if (lower.includes('/acc/') || lower.includes('/old/') || lower.includes('/lib/')) {
		return false;
	}
	const segments = rel.split('/');
	return segments[2] === 'js' || segments[2] === 'css';
}

/** The manifest response body (frozen once built — it is shared by every caller). */
export interface DedaloFilesManifest {
	result: readonly DedaloFileEntry[];
	dedalo_version: string;
	msg: string;
}

/**
 * THE MANIFEST IS COMPUTED ONCE, AT BOOT (audit PERF-13).
 *
 * Building it means a recursive `readdirSync` walk of the whole client tree
 * plus a `statSync` per manifested file — thousands of synchronous syscalls,
 * and every one of them stops the single event loop that serves the entire
 * installation. That was happening on an AUTHENTICATED REQUEST PATH
 * (`get_dedalo_files`, which the service worker calls on install and on every
 * version change), so N logged-in browsers arriving after a deploy each bought
 * the whole walk, serialized.
 *
 * The finding's own remedy — "memoise on the mtime signature" — is circular:
 * computing that signature IS the walk. So the walk happens ONCE, at boot
 * (`prewarmDedaloFilesManifest`, called from server.ts), and the served answer
 * is the frozen result. The client bytes cannot change under a running server
 * without a deploy, and a deploy restarts it.
 *
 * DEV MODE RECOMPUTES, EVERY TIME. In development the client files DO change
 * under the running server, and the manifest's `dedalo_version` is the
 * service-worker cache key — a frozen key there would keep a developer's
 * browser on stale JS until restart. `DEDALO_DEV_MODE` is read per call (not
 * captured at module load) so the posture is the one the server is running
 * under, and never a value baked in at import time.
 */
let manifestState: {
	manifest: DedaloFilesManifest | null;
	builds: number;
	/** The frozen clientCssVersion() answer (production posture only). */
	cssVersion: Promise<string> | null;
} = {
	manifest: null,
	builds: 0,
	cssVersion: null,
};

/**
 * Build the manifest by WALKING THE DISK. Never called per request outside dev
 * mode — see the note above.
 */
function walkDedaloFilesManifest(): DedaloFilesManifest {
	const files: DedaloFileEntry[] = [];

	// CORE — css: main.css first to preserve coherence (its /page/css/ path
	// does not match the /js/ rule and would otherwise be skipped).
	files.push({ type: 'css', url: `${CORE_URL}/page/css/main.css` });
	// CORE — js. tools_common is INSIDE this tree on disk but has its OWN block
	// below (PHP entry order + the tools filter rule), so it is skipped here —
	// that skip is what keeps it from being listed twice.
	for (const rel of walkDirFiles(CLIENT_CORE_ROOT, ['js'])) {
		if (rel.startsWith(TOOLS_COMMON_REL)) continue;
		const url = coreFileUrl(rel);
		if (url !== null) files.push({ type: 'js', url });
	}

	// TOOL_COMMON — the relocation seam (see module doc). Filtered with the
	// tools rule by prefixing the tool dir PHP sees ('/tool_common/js/…').
	for (const rel of walkDirFiles(TOOL_COMMON_CLIENT_DIR, ['js', 'css'])) {
		if (toolFileRelIsIncluded(`/tool_common${rel}`)) {
			files.push({ type: 'js', url: TOOLS_COMMON_URL + rel });
		}
	}

	// TOOLS — primary root only (PHP DEDALO_TOOLS_PATH). PHP quirk kept: every
	// tools-branch entry is typed 'js', css files included (the SW only reads
	// url; the type must still match the oracle byte-for-byte).
	const primaryToolsRoot = getRoots()[0]?.path;
	if (primaryToolsRoot !== undefined) {
		for (const rel of walkDirFiles(primaryToolsRoot, ['js', 'css'])) {
			if (toolFileRelIsIncluded(rel)) {
				files.push({ type: 'js', url: TOOLS_URL_BASE + rel });
			}
		}
	}

	return Object.freeze({
		result: Object.freeze(files),
		// dedalo_version: THE SERVICE-WORKER CACHE KEY (service_worker.js names its cache after
		// it and purges every other one). PHP sent DEDALO_VERSION, which only moves
		// on a release — so a client file edited between releases stayed cached
		// FOREVER: the browser kept running the old JS against the new server, and
		// the only thing that ever refreshed it was a fresh login. That is how a
		// deploy leaves a logged-in user on a stale bundle.
		//
		// So the key is the version PLUS a signature of the bytes actually served
		// (newest mtime + file count over the manifested trees). Edit a client file
		// — in dev or by deploying one — and the key changes, the SW drops the old
		// cache and re-fetches. No flag to remember, no login required.
		dedalo_version: `${DEDALO_ENGINE_VERSION}-${clientAssetsSignature(files)}`,
		msg: 'OK. Request done successfully',
	});
}

/**
 * The served manifest: the frozen boot-time answer, or a fresh walk in dev
 * mode. The request path never walks the disk on the production posture.
 */
export function buildDedaloFilesResponse(): DedaloFilesManifest {
	if (readEnv('DEDALO_DEV_MODE') === 'true') {
		const manifest = walkDedaloFilesManifest();
		manifestState = { ...manifestState, manifest: null, builds: manifestState.builds + 1 };
		return manifest;
	}
	const cached = manifestState.manifest;
	if (cached !== null) return cached;
	const manifest = walkDedaloFilesManifest();
	manifestState = { ...manifestState, manifest, builds: manifestState.builds + 1 };
	return manifest;
}

/**
 * Compute the manifest at BOOT so no served request ever pays the walk
 * (server.ts). Idempotent; a no-op once the manifest is frozen.
 */
export function prewarmDedaloFilesManifest(): void {
	if (manifestState.manifest === null) buildDedaloFilesResponse();
	void clientCssVersion();
}

/**
 * How many times the DISK WALK has run in this process — the number the PERF-13
 * gate measures, because "the walk happens once" is a claim about work done,
 * not about how the code is spelled.
 */
export function dedaloFilesManifestBuilds(): number {
	return manifestState.builds;
}

/** Drop the frozen manifest (gates only — boot state is otherwise permanent). */
export function resetDedaloFilesManifest(): void {
	manifestState = { manifest: null, builds: 0, cssVersion: null };
}

/**
 * THE CSS VERSION — the cache-busting key of every stylesheet the client loads
 * (page_globals.css_version → `main.css?v=…`, `<tool>.css?v=…`).
 *
 * WHY THE ENGINE OWNS IT: the client tree is usually served by the institution's
 * web server, whose cache headers we do not control — one without
 * `Cache-Control: no-cache` lets browsers keep a stale main.css for days after a
 * code update (heuristic freshness), and index.html itself can be stale the same
 * way, so no URL written into a static file is a guarantee. The `start` response
 * is the one channel that is fresh on EVERY install; a URL built from it changes
 * exactly when the bytes do, whatever the web server says.
 *
 * A CONTENT hash (16 hex of sha256 over each stylesheet's URL + bytes), not an
 * mtime signature: a rollback that restores older bytes returns the older
 * version — whose URL the browser may still hold, correctly. Covers the sheets
 * whose URLs are built from it: main.css, tools_common css and the css/ of every
 * tool in EVERY tools root (the manifest walks only the primary one). NOT
 * covered: vendored lib/ sheets and component-local ones (component_pdf's
 * pdf.js css) — they are not versioned with it; and, as everywhere in this
 * walk, a symlink inside a tools root (client_publish never publishes one).
 *
 * Posture as the manifest: frozen at boot (prewarm) — a deploy restarts the
 * engine — and recomputed per call in dev mode, where css:build rewrites
 * main.css under the running server. Never rejects: an unreadable file hashes
 * as missing, so a broken stylesheet cannot fail every `start`.
 */
export function clientCssVersion(): Promise<string> {
	if (readEnv('DEDALO_DEV_MODE') === 'true') return computeCssVersion();
	if (manifestState.cssVersion === null) {
		manifestState = { ...manifestState, cssVersion: computeCssVersion() };
	}
	return manifestState.cssVersion as Promise<string>;
}

async function computeCssVersion(): Promise<string> {
	const hash = createHash('sha256');
	for (const [url, path] of versionedStylesheets()) {
		hash.update(url).update('\0');
		try {
			hash.update(await Bun.file(path).bytes());
		} catch {
			hash.update('\0missing');
		}
		hash.update('\n');
	}
	return hash.digest('hex').slice(0, 16);
}

/** [url, disk path] of every stylesheet whose URL carries the css version. */
function versionedStylesheets(): [url: string, path: string][] {
	const files: [url: string, path: string][] = [
		[`${CORE_URL}/page/css/main.css`, `${CLIENT_CORE_ROOT}/page/css/main.css`],
	];
	for (const rel of walkDirFiles(TOOL_COMMON_CLIENT_DIR, ['css'])) {
		files.push([TOOLS_COMMON_URL + rel, TOOL_COMMON_CLIENT_DIR + rel]);
	}
	for (const root of getRoots()) {
		for (const rel of walkDirFiles(root.path, ['css'])) {
			// '/<tool>/css/…' — the only css a tool page loads
			if (rel.split('/')[2] === 'css') files.push([root.url + rel, root.path + rel]);
		}
	}
	return files;
}

/**
 * A cheap content signature of the manifested client assets: the newest mtime
 * across them, plus how many there are (so a pure delete also moves the key).
 * Cheap because the manifest walk already stat'd these directories.
 *
 * mtime, not a content hash: hashing every client file on each manifest request
 * would cost far more than it buys — an edited file always moves its mtime, and
 * a deploy rewrites them. A file restored to an OLDER mtime with the same count
 * is the one case this misses; a login still fixes that.
 */
function clientAssetsSignature(files: readonly DedaloFileEntry[]): string {
	let newest = 0;
	for (const file of files) {
		const path = assetDiskPath(file.url);
		if (path === null) continue;
		try {
			const { mtimeMs } = statSync(path);
			if (mtimeMs > newest) newest = mtimeMs;
		} catch {
			// A vanished file just does not contribute; the count below still moves.
		}
	}
	return `${Math.round(newest)}.${files.length}`;
}

/** Map a manifest URL back to the file on disk (the inverse of the url builders). */
function assetDiskPath(url: string): string | null {
	if (url.startsWith(TOOLS_COMMON_URL)) {
		return TOOL_COMMON_CLIENT_DIR + url.slice(TOOLS_COMMON_URL.length);
	}
	if (url.startsWith(TOOLS_URL_BASE)) {
		const root = getRoots()[0]?.path;
		return root === undefined ? null : root + url.slice(TOOLS_URL_BASE.length);
	}
	if (url.startsWith(CORE_URL)) {
		return CLIENT_CORE_ROOT + url.slice(CORE_URL.length);
	}
	return null;
}
