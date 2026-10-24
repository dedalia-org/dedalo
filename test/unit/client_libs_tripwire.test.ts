/**
 * CLIENT-LIB TRIPWIRE (DEC-12) — the third-party browser libraries resolve, and
 * the registry is the only way to reach them.
 *
 * WHY THIS EXISTS. Until 2026-07-12 the libs were a 118 MB gitignored directory
 * that no gate ever touched: the service worker (`client/dedalo/core/sw.js`) and
 * the precache manifest builder (`src/core/api/dedalo_files.ts`) both EXCLUDE
 * `/lib/`, so libs are only ever fetched lazily by a component that needs one.
 * Consequence: the whole tree sat at the WRONG PATH (`client/lib/` instead of
 * `client/dedalo/lib/`) with every `/dedalo/lib/*` request 404ing, and the suite
 * stayed green. A missing lib must be a RED GATE, not a blank widget.
 *
 * The load-bearing assertion is `every lib URL the client references resolves`.
 * It scans the client + tools source, resolves each `lib/…` reference IN URL SPACE
 * (tools are served from the repo `tools/` root, so filesystem resolution would be
 * wrong), and requires each one to come back 200 through the real request handler.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, posix, resolve } from 'node:path';
import { CLIENT_LIBS } from '../../src/core/client_libs/registry.ts';
import { handleRequest } from '../../src/server.ts';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const context = { requestId: 'test', startedAt: 0 };

async function get(path: string): Promise<Response> {
	return handleRequest(new Request(`http://localhost${path}`), context);
}

// The client test harness (mocha/chai) is only served in dev mode, and its
// packages are devDependencies. Serve them for the duration of this gate.
process.env.DEDALO_DEV_MODE = 'true';

// ---------------------------------------------------------------------------
// Source scan: every lib URL the client/tools actually reference
// ---------------------------------------------------------------------------

const SCAN_ROOTS = ['client/dedalo/core', 'client/dedalo/test', 'tools'];
const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.html', '.json']);

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			// A tool's OWN lib/ dir (tools/<tool>/js/lib/…) is a different URL space,
			// served by serveToolsRequest — not a client lib. Never scan into node_modules.
			if (entry === 'node_modules') continue;
			walk(full, out);
		} else if (SCAN_EXTENSIONS.has(extname(entry).toLowerCase())) {
			out.push(full);
		}
	}
	return out;
}

/**
 * The URL a source file is served at. Client files live under client/dedalo/ and
 * serve at /dedalo/…; tool files live at the repo `tools/` root and serve at
 * /dedalo/tools/… . Getting this right is the whole point of resolving in URL
 * space: `../../../lib/x` from a tool means something different on disk.
 */
function fileToUrl(absPath: string): string | null {
	const rel = absPath.slice(REPO_ROOT.length + 1);
	if (rel.startsWith('client/dedalo/')) return `/dedalo/${rel.slice('client/dedalo/'.length)}`;
	if (rel.startsWith('tools/')) return `/dedalo/tools/${rel.slice('tools/'.length)}`;
	return null;
}

/** Every quoted string in `source` that mentions `lib/`, excluding comment lines. */
function libStringsIn(source: string): string[] {
	const found: string[] = [];
	for (const line of source.split('\n')) {
		const trimmed = line.trimStart();
		// Skip comment lines: `// …` and the `* …` continuation of a block comment.
		// (A trailing comment on a code line is fine — the code half still scans.)
		if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
		for (const m of line.matchAll(/['"`]([^'"`]*\blib\/[^'"`]*)['"`]/g)) {
			const value = m[1];
			if (value !== undefined) found.push(value);
		}
	}
	return found;
}

/**
 * Resolve a reference found in `fileUrl` to the /dedalo/lib/… URL it denotes, or
 * null when it is not a client-lib reference at all (a tool-local `./lib/…`, an
 * unrelated string, an absolute http URL…).
 */
function toLibUrl(fileUrl: string, ref: string): string | null {
	if (ref.startsWith('http://') || ref.startsWith('https://')) return null;
	let url: string;
	if (ref.startsWith('/dedalo/lib/')) url = ref;
	// DEDALO_ROOT_WEB is '/dedalo' (src/core/resolve/environment.ts) — the client
	// concatenates it with '/lib/…'.
	else if (ref.startsWith('/lib/')) url = `/dedalo${ref}`;
	else if (ref.startsWith('.')) url = posix.resolve(posix.dirname(fileUrl), ref);
	else return null;
	if (!url.startsWith('/dedalo/lib/')) return null;
	// posix.resolve() drops a trailing slash; keep it, because it is what marks a
	// DIRECTORY reference (the `three/addons/` import-map prefix) as not fetchable.
	if (ref.endsWith('/') && !url.endsWith('/')) url += '/';
	// The bare prefix itself is not a reference to any lib — sw.js and
	// dedalo_files.ts both carry the literal '/lib/' as a precache EXCLUSION filter.
	if (url === '/dedalo/lib/') return null;
	return url;
}

const references: { fileUrl: string; ref: string; url: string }[] = [];
for (const root of SCAN_ROOTS) {
	for (const file of walk(join(REPO_ROOT, root))) {
		const fileUrl = fileToUrl(file);
		if (fileUrl === null) continue;
		for (const ref of libStringsIn(readFileSync(file, 'utf8'))) {
			const url = toLibUrl(fileUrl, ref);
			if (url !== null) references.push({ fileUrl, ref, url });
		}
	}
}

describe('client libs — the registry resolves every lib the client loads', () => {
	test('the source scan actually found references (guards against a silently empty gate)', () => {
		// If a refactor moves the client, this gate must fail loudly rather than
		// pass by scanning nothing — the exact failure mode it exists to prevent.
		expect(references.length).toBeGreaterThan(20);
	});

	test('every lib URL referenced by the client or tools serves 200', async () => {
		const broken: string[] = [];
		for (const { fileUrl, ref, url } of references) {
			// Directory references (import-map prefixes like `…/jsm/`) are not fetchable
			// on their own; assert their id is registered and probe the id instead.
			const id = url.slice('/dedalo/lib/'.length).split('/')[0] ?? '';
			if (CLIENT_LIBS[id] === undefined) {
				broken.push(`${fileUrl}: "${ref}" → unregistered lib id "${id}"`);
				continue;
			}
			// A DIRECTORY reference (an import-map prefix, or a loader's decoder path
			// like `<root>/lib/three/examples/jsm/libs/draco/`) is not fetchable on its
			// own — but it still has to EXIST, or the assets under it 404 at runtime.
			// Checking the id alone left `.../libs/draco/` covered by nothing: rename
			// that folder upstream and every Draco-compressed glTF stops loading with a
			// green suite. Resolve it on disk under the lib's own base instead.
			if (url.endsWith('/')) {
				const lib = CLIENT_LIBS[id];
				const tail = url.slice(`/dedalo/lib/${id}/`.length);
				const dir = join(REPO_ROOT, lib.base, tail);
				if (tail !== '' && !(existsSync(dir) && statSync(dir).isDirectory())) {
					broken.push(`${fileUrl}: "${ref}" → ${url} → no such directory (${lib.base}/${tail})`);
				}
				continue;
			}
			const response = await get(url);
			if (response.status !== 200) {
				broken.push(`${fileUrl}: "${ref}" → ${url} → HTTP ${response.status}`);
				continue;
			}
			const bytes = await response.arrayBuffer();
			if (bytes.byteLength === 0) broken.push(`${fileUrl}: "${ref}" → ${url} → EMPTY`);
		}
		expect(broken).toEqual([]);
	});

	test("every registry entry's probe serves 200 with real bytes", async () => {
		const broken: string[] = [];
		for (const [id, lib] of Object.entries(CLIENT_LIBS)) {
			const response = await get(`/dedalo/lib/${id}/${lib.probe}`);
			if (response.status !== 200) {
				broken.push(`${id}: probe ${lib.probe} → HTTP ${response.status}`);
				continue;
			}
			if ((await response.arrayBuffer()).byteLength === 0) {
				broken.push(`${id}: probe ${lib.probe} → EMPTY`);
			}
		}
		expect(broken).toEqual([]);
	});

	test('every non-npm lib names WHY it cannot be package-manager tracked', () => {
		for (const [id, lib] of Object.entries(CLIENT_LIBS)) {
			if (lib.source === 'npm') continue;
			// The never-narrow law: a lib escapes package-manager tracking only with a
			// substantive reason recorded at the declaration, not in a doc.
			expect(lib.reason ?? '', `${id} (source=${lib.source}) must carry a reason`).not.toBe('');
			expect((lib.reason ?? '').length, `${id}: reason is too thin`).toBeGreaterThan(40);
		}
	});
});

// ---------------------------------------------------------------------------
// Import-map API surface: the SYMBOLS a client file takes out of a lib
// ---------------------------------------------------------------------------

/**
 * Every in-repo page that declares an `<script type="importmap">`. DISCOVERED, not
 * listed: hardcoding the page set made the "a new mapping cannot escape this gate"
 * claim false the moment a second page declared one — and two already had
 * (`client/dedalo/test/client/{index,frame}.html`), so the gate was checking one
 * page's `three` while the client harness quietly ran on another's.
 */
function importmapPages(): string[] {
	const found: string[] = [];
	for (const root of SCAN_ROOTS) {
		for (const file of walk(join(REPO_ROOT, root))) {
			if (extname(file).toLowerCase() !== '.html') continue;
			if (readFileSync(file, 'utf8').includes('type="importmap"')) found.push(file);
		}
	}
	return found;
}

/** One import-map entry: the specifier, the page that declared it, its target. */
interface MapEntry {
	specifier: string;
	/** true for a trailing-slash PREFIX mapping (`three/addons/` → a directory). */
	prefix: boolean;
	page: string;
	target: string;
	/** The /dedalo/lib/… URL the target resolves to, or null when it does not. */
	url: string | null;
}

function importmapEntries(): MapEntry[] {
	const out: MapEntry[] = [];
	for (const page of importmapPages()) {
		const html = readFileSync(page, 'utf8');
		const pageUrl = fileToUrl(page);
		for (const block of html.matchAll(/<script\s+type="importmap"\s*>([\s\S]*?)<\/script>/g)) {
			const map = JSON.parse(block[1] ?? '{}') as { imports?: Record<string, string> };
			for (const [specifier, target] of Object.entries(map.imports ?? {})) {
				out.push({
					specifier,
					prefix: specifier.endsWith('/'),
					page: pageUrl ?? page,
					target,
					// A page's import map resolves against the PAGE, which is what
					// fileToUrl gives us. pageUrl is only null for a file outside both
					// URL spaces — recorded as an unresolved entry below, never skipped.
					url: pageUrl === null ? null : toLibUrl(pageUrl, target),
				});
			}
		}
	}
	return out;
}

/**
 * The names an ES module exports.
 *
 * BOTH forms, because three's own tree uses both: the bundle re-exports through
 * `export { … }` blocks while the addons (`stats.module.js`, the loaders) use
 * declaration form and `export default`. Reading only the blocks reported every
 * legitimate import from an addon as missing.
 */
function exportedNames(source: string): Set<string> {
	const names = new Set<string>();
	for (const block of source.match(/export\s*\{([\s\S]*?)\}/g) ?? []) {
		for (const part of block.replace(/export\s*\{|\}/g, '').split(',')) {
			const halves = part.trim().split(/\s+as\s+/);
			const name = (halves[1] ?? halves[0] ?? '').trim();
			// `export { x as default }` names the default slot, not a named export.
			if (name !== '' && name !== 'default') names.add(name);
		}
	}
	// Declaration form: `export const X`, `export class X`, `export function X`,
	// `export async function X`, `export let/var X`.
	for (const match of source.matchAll(
		/\bexport\s+(?:async\s+)?(?:const|let|var|class|function\*?)\s+([A-Za-z_$][\w$]*)/g,
	)) {
		if (match[1] !== undefined) names.add(match[1]);
	}
	return names;
}

/** Strip line and block comments so a commented-out import is not read as code. */
function stripComments(source: string): string {
	// Order matters: block first, then line. Strings containing `//` survive because
	// the replacement keeps the line structure and a false positive here can only
	// HIDE an import (the anti-vacuity guard below is what catches wholesale loss).
	return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}
/**
 * ONE import statement's use of an import-map specifier.
 *
 * `importPath` is the FULL specifier as written (`three`, or
 * `three/addons/loaders/GLTFLoader.js`), which is what decides the module URL for
 * a prefix mapping — so it is carried per statement, not per mapping.
 */
interface ImportUse {
	importPath: string;
	/** Named bindings — the ones whose existence can be checked against exports. */
	named: string[];
	/** true when the statement also takes the default export (needs no name check). */
	usesDefault: boolean;
	/**
	 * Set when the import form makes symbol use UNCHECKABLE from the statement:
	 * `import * as X` and `import(…)`, where symbols are reached as properties
	 * later. A removed property is then `undefined` rather than a load error — a
	 * silent wrong value instead of a loud crash — so these are reported, not
	 * passed over. Holds the form as written, for the message.
	 */
	unverifiable: string | null;
}

/** Every import of `specifier` (or, for a prefix mapping, of anything under it). */
function importUsesOf(source: string, specifier: string, prefix: boolean): ImportUse[] {
	const quoted = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	// A PREFIX mapping matches any module path under it (`three/addons/loaders/X.js`);
	// an exact mapping matches only itself, or the ES-resolution rules would let
	// `three-foo` masquerade as `three`.
	const spec = prefix ? `${quoted}[^'"]*` : quoted;
	const uses: ImportUse[] = [];

	// Static import: `import <clause> from '<spec>'`, where <clause> is any legal
	// combination of a default binding, a namespace binding and a named clause.
	// Matching the clause permissively and classifying it here is what catches the
	// mixed forms (`import THREE, { X } from …`) a `{…}`-only pattern skipped.
	for (const match of source.matchAll(
		new RegExp(`\\bimport\\s+([^;'"]*?)\\s*from\\s*['"](${spec})['"]`, 'g'),
	)) {
		const clause = (match[1] ?? '').trim();
		const importPath = match[2] ?? specifier;
		const braces = clause.match(/\{([\s\S]*?)\}/);
		const named: string[] = [];
		if (braces?.[1] !== undefined) {
			for (const raw of braces[1].split(',')) {
				const name =
					raw
						.trim()
						.split(/\s+as\s+/)[0]
						?.trim() ?? '';
				if (name !== '') named.push(name);
			}
		}
		uses.push({
			importPath,
			named,
			// A bare identifier at the head of the clause is the default binding.
			usesDefault: /^[A-Za-z_$][\w$]*\s*(?:,|$)/.test(clause),
			unverifiable: /(^|,)\s*\*\s+as\s/.test(clause) ? `import * as … from '${importPath}'` : null,
		});
	}

	// Dynamic import: whatever it yields is destructured or property-accessed
	// elsewhere, so the statement alone cannot say which symbols are used.
	for (const match of source.matchAll(new RegExp(`\\bimport\\s*\\(\\s*['"](${spec})['"]`, 'g'))) {
		const importPath = match[1] ?? specifier;
		uses.push({
			importPath,
			named: [],
			usesDefault: false,
			unverifiable: `import('${importPath}')`,
		});
	}

	// A bare side-effect import (`import 'three'`) binds nothing: nothing to check,
	// and nothing uncheckable either.
	return uses;
}

/** One file's use of one import-map entry, with the file kept for the message. */
interface Usage {
	fileUrl: string;
	entry: MapEntry;
	use: ImportUse;
	/** The module URL this specific import resolves to; null = unresolved mapping. */
	url: string | null;
}

/**
 * For a PREFIX mapping the module URL depends on the import path, so it is
 * computed per import statement rather than per mapping.
 */
function moduleUrlFor(entry: MapEntry, importPath: string): string | null {
	if (entry.url === null) return null;
	return entry.prefix ? entry.url + importPath.slice(entry.specifier.length) : entry.url;
}

/**
 * Walk the source tree ONCE, testing every mapping against each file.
 *
 * DEDUPED on (file, import path, resolved URL): several pages declare the same
 * `three` / `three/addons/` mapping, and a file is not owned by one page, so the
 * same import would otherwise be reported once per page. The URL is part of the
 * key ON PURPOSE — two pages mapping one specifier to DIFFERENT modules (a harness
 * pointed at `three.webgpu.js`, say) is exactly the disagreement worth checking
 * twice, and it survives this.
 */
function collectUsages(entries: MapEntry[]): Usage[] {
	const usages: Usage[] = [];
	const seen = new Set<string>();
	for (const root of SCAN_ROOTS) {
		for (const file of walk(join(REPO_ROOT, root))) {
			if (!['.js', '.mjs'].includes(extname(file).toLowerCase())) continue;
			const fileUrl = fileToUrl(file);
			if (fileUrl === null) continue;
			// Comments are stripped so a commented-out migration line
			// (`// import { sRGBEncoding } from 'three'`) or a JSDoc example cannot fail
			// CI on a client that is correct — the sibling libStringsIn scan skips
			// comment lines for the same reason.
			const source = stripComments(readFileSync(file, 'utf8'));
			for (const entry of entries) {
				if (!source.includes(entry.specifier)) continue;
				for (const use of importUsesOf(source, entry.specifier, entry.prefix)) {
					const url = moduleUrlFor(entry, use.importPath);
					const key = `${fileUrl}\u0000${use.importPath}\u0000${url ?? ''}`;
					if (seen.has(key)) continue;
					seen.add(key);
					usages.push({ fileUrl, entry, use, url });
				}
			}
		}
	}
	return usages;
}

describe('client libs — the symbols the client imports still exist', () => {
	/**
	 * WHY THIS EXISTS (2026-08-08). The resolution gate above proves a lib URL
	 * serves 200; it says NOTHING about the module's API surface. three r152
	 * renamed the colour-space constants and `client/dedalo/core/component_3d/js/
	 * viewer/viewer.js` kept importing `sRGBEncoding`, which r185 no longer
	 * exports. `three.module.js` still served 200, every gate stayed green, and the
	 * whole 3D viewer module failed to load in the browser — so component_3d
	 * rendered only its static posterframe and `create_posterframe()` bailed with
	 * "3D viewer is not set", meaning a 3D upload silently never got a posterframe.
	 *
	 * A named import of a symbol the served module does not export is a HARD
	 * module-load failure, not a deprecation warning: it takes down every importer
	 * at once and it is invisible until someone opens the right widget. Since
	 * dependencies here track the latest stable by policy, an upstream rename is a
	 * ROUTINE event — so it needs a gate, not vigilance.
	 *
	 * BOTH HALVES OF A MAPPING. The first cut checked only exact specifiers and
	 * skipped the `three/addons/` PREFIX — which is where 10 of viewer.js's 11 three
	 * imports go, so the gate written for this outage would not have caught the same
	 * outage one import line over.
	 */
	const entries = importmapEntries();
	const usages = collectUsages(entries);

	test('every import-map entry resolves to a registered lib (no silent drops)', () => {
		// An unresolvable entry is NOT skipped: it would be a mapping whose symbols go
		// unverified forever while the gate reports green. Fail with the specifier
		// named, so closing it stays a decision someone makes on purpose.
		const unresolved = entries
			.filter((entry) => entry.url === null)
			.map(
				(entry) =>
					`${entry.page}: "${entry.specifier}" → "${entry.target}" does not resolve to a /dedalo/lib/ URL`,
			);
		expect(unresolved).toEqual([]);
	});

	test('the scan found the mappings and real imports (guards against a silently empty gate)', () => {
		// Without this, an empty `broken` proves only that nothing was FOUND. Moving
		// viewer.js out of the scan roots, or reformatting its imports into a shape the
		// matcher misses, would otherwise leave the gate green having checked zero
		// symbols — the exact failure mode it exists to prevent.
		expect(entries.map((entry) => entry.specifier)).toContain('three');
		expect(entries.some((entry) => entry.prefix)).toBe(true);
		const named = usages.reduce((total, usage) => total + usage.use.named.length, 0);
		expect(named).toBeGreaterThan(20);
		// The addons half specifically — the hole the first cut left open.
		expect(usages.some((usage) => usage.entry.prefix && usage.use.named.length > 0)).toBe(true);
	});

	test('no client file reaches an import-map lib through an uncheckable import form', () => {
		// `import * as THREE` / `await import('three')` resolve a REMOVED symbol to
		// `undefined` instead of failing the load, so the widget renders with a wrong
		// value and no error anywhere — strictly worse than the crash this gate
		// catches, and invisible to it. There are none today; a new one must be a
		// deliberate decision, not a silent gap.
		const uncheckable = usages
			.filter((usage) => usage.use.unverifiable !== null)
			.map((usage) => `${usage.fileUrl}: ${usage.use.unverifiable}`);
		expect(uncheckable).toEqual([]);
	});

	test('every named import from an import-map lib is exported by the served module', async () => {
		const broken: string[] = [];
		// One fetch + parse per module URL, however many files import it.
		const exportsByUrl = new Map<string, Set<string> | null>();
		for (const usage of usages) {
			if (usage.url === null) continue; // already failed loudly, above
			if (usage.use.named.length === 0) continue; // default-only: nothing to name-check
			let exported = exportsByUrl.get(usage.url);
			if (exported === undefined) {
				const response = await get(usage.url);
				exported = response.status === 200 ? exportedNames(await response.text()) : null;
				exportsByUrl.set(usage.url, exported);
			}
			if (exported === null) {
				broken.push(
					`${usage.fileUrl}: '${usage.use.importPath}' → ${usage.url} does not serve 200`,
				);
				continue;
			}
			for (const name of usage.use.named) {
				if (!exported.has(name)) {
					broken.push(
						`${usage.fileUrl}: imports { ${name} } from '${usage.use.importPath}' — not exported by ${usage.url}`,
					);
				}
			}
		}
		expect(broken).toEqual([]);
	});
});

describe('client libs — the registry is a chokepoint, not a passthrough', () => {
	test('an unregistered id 404s', async () => {
		expect((await get('/dedalo/lib/zod/package.json')).status).toBe(404);
		expect((await get('/dedalo/lib/nvd3/build/nv.d3.min.js')).status).toBe(404);
	});

	test("the SERVER's own dependencies are not reachable", async () => {
		// node_modules holds the Anthropic SDK, the MCP SDK, zod, Puppeteer… A
		// prefix-based passthrough would publish the whole dependency tree.
		for (const path of [
			'/dedalo/lib/@anthropic-ai/sdk/package.json',
			'/dedalo/lib/zod/package.json',
			'/dedalo/lib/puppeteer/package.json',
			'/dedalo/lib/@modelcontextprotocol/sdk/package.json',
		]) {
			expect((await get(path)).status, path).toBe(404);
		}
	});

	test('traversal out of a lib root 404s', async () => {
		for (const path of [
			'/dedalo/lib/three/../../../package.json',
			'/dedalo/lib/three/../zod/package.json',
			'/dedalo/lib/three/%2e%2e/%2e%2e/package.json',
			'/dedalo/lib/ckeditor/../../src/server.ts',
		]) {
			expect((await get(path)).status, path).toBe(404);
		}
	});

	test('a non-servable extension inside a real lib 404s', async () => {
		// three ships .ts type declarations; they are not browser assets.
		const response = await get('/dedalo/lib/three/src/Three.d.ts');
		expect(response.status).toBe(404);
	});
});

// ---------------------------------------------------------------------------
// PACKAGING: a registered lib must survive the install that ships it
// ---------------------------------------------------------------------------

/**
 * WHY THIS EXISTS (2026-08-21). The registry says WHERE a lib's bytes are; it
 * cannot say whether the deployed image HAS them. The container installs with
 * `bun install --frozen-lockfile --production`, which drops every
 * devDependency — so `mocha` and `chai` (both `devOnly`) were simply absent,
 * and every harness script came back as the route's JSON 404 envelope. The
 * browser reports that as "MIME type ('application/json') is not executable",
 * which names neither the missing package nor the flag that dropped it.
 *
 * The two halves of the invariant, and the direction each one fails in:
 *   devOnly  ⇒ devDependency — otherwise the production image carries a test
 *              harness it must never serve.
 *   npm, not devOnly ⇒ dependency — otherwise `--production` drops a lib the
 *              CLIENT LOADS AT RUNTIME and the widget 404s in production only,
 *              which is the worst place to find out.
 *
 * The `dev` build target is what puts the devDependencies back; the assertions
 * below pin its two load-bearing properties, because both are invisible until a
 * deploy goes wrong: the reinstall must NOT carry `--production` (or the target
 * is a no-op), and `production` must be the LAST stage (Docker builds the last
 * stage when none is named — if `dev` ever drifted to the end, every untargeted
 * build would silently ship the test harness).
 */

const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};

/** node_modules/<name> → the package name a lib's base points at. */
function packageNameOf(base: string): string | null {
	if (!base.startsWith('node_modules/')) return null;
	const rest = base.slice('node_modules/'.length).split('/');
	// Scoped packages are two segments (@huggingface/transformers).
	return rest[0]?.startsWith('@') ? `${rest[0]}/${rest[1]}` : (rest[0] ?? null);
}

describe('client libs — packaging: the install that ships a lib keeps it', () => {
	test('a devOnly lib is a devDependency, and a runtime lib is not', () => {
		const wrong: string[] = [];
		for (const [id, lib] of Object.entries(CLIENT_LIBS)) {
			if (lib.source !== 'npm') continue; // vendor/ is committed; no install drops it
			const name = packageNameOf(lib.base);
			if (name === null) {
				wrong.push(`${id}: source=npm but base is not under node_modules/ (${lib.base})`);
				continue;
			}
			const isDev = packageJson.devDependencies?.[name] !== undefined;
			const isRuntime = packageJson.dependencies?.[name] !== undefined;
			if (!isDev && !isRuntime) {
				wrong.push(`${id}: "${name}" is in NEITHER dependencies nor devDependencies`);
			} else if (lib.devOnly === true && !isDev) {
				wrong.push(`${id}: devOnly, so "${name}" must be a devDependency, not a runtime one`);
			} else if (lib.devOnly !== true && !isRuntime) {
				wrong.push(
					`${id}: served in production, so "${name}" must be a dependency — a devDependency is dropped by \`bun install --production\` and the lib 404s on a deploy host`,
				);
			}
		}
		expect(wrong).toEqual([]);
	});

	test('the Dockerfile has a dev target that restores the devDependencies', () => {
		const dockerfile = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8');
		const devStage = dockerfile.slice(dockerfile.indexOf('\nFROM runtime AS dev'));
		expect(devStage, 'Dockerfile must define a `dev` stage built on `runtime`').not.toBe('');
		const install = devStage.split('\n').find((line) => line.includes('bun install'));
		expect(install, 'the dev stage must reinstall the dependency tree').toBeDefined();
		// The whole point of the target: a `--production` reinstall restores nothing.
		expect(install ?? '').not.toContain('--production');
	});

	test('the DEFAULT build target is production — the last stage is never `dev`', () => {
		const stages = [
			...readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8').matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gm),
		].map((match) => match[1]);
		expect(stages.length, 'the Dockerfile must be multi-stage with named stages').toBeGreaterThan(
			1,
		);
		// Docker builds the LAST stage when none is named, and both production
		// compose files use a bare `build: .`.
		expect(stages.at(-1)).toBe('production');
	});
});
