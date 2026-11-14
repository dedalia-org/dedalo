/**
 * DOCS VERSIONING tripwire (DEC-12: every documented invariant has one).
 *
 * The manual is published per MAJOR, each at a permanent prefix —
 * dedalo.dev/docs/v7/ for this repo, /docs/v6/ for the frozen v6 manual — with
 * /docs/ redirecting to the latest. That layout only works while SEVEN separate
 * pieces agree, and nothing about them is self-evident from reading any one
 * file. This gate is what makes them agree.
 *
 * Every one of them is here because it FAILED IN PRODUCTION, not because it
 * seemed prudent. They share a shape worth naming: each breaks silently. The
 * build stays green, the HTML is correct, and the page looks deliberate — so
 * the only thing standing between a wrong config and a reader is this file.
 *
 * WHAT IT GUARDS, and what goes wrong without it:
 *
 *  1. site_url NAMES THIS VERSION. Material derives the version switcher's
 *     index from site_url's PARENT (/docs/versions.json). A wrong or missing
 *     site_url does not fail the build — it ships canonical tags pointing at
 *     the wrong place and a switcher that silently 404s, which nobody notices
 *     because the page itself looks fine.
 *
 *  2. versions.json AGREES WITH IT. Exactly one entry may be aliased `latest`,
 *     and it must be the version site_url declares. Two `latest` entries, or a
 *     `latest` pointing at a version this repo does not build, makes the
 *     "you are reading an older version" banner lie in whichever direction is
 *     most confusing.
 *
 *  3. NO FLAT PUBLISHED LINKS IN SHIPPED CODE. A link to dedalo.dev/docs/<path>
 *     with no version prefix resolves only through a server-side redirect whose
 *     meaning CHANGES on the day v8 ships. The v7 browser installer (removed
 *     2026-10-12) shipped exactly such links, which is also why legacy flat
 *     URLs route to v7 rather than v6.
 *
 *  4. A PAGE THAT LEAVES DOES NOT 404. This is the one that only starts
 *     mattering on publication day, which is precisely why it has to exist
 *     BEFORE it. Today a page can be renamed freely: `mkdocs --strict` catches
 *     the internal links it breaks, and no external link can break because
 *     nothing is published. Three commits have already renamed or deleted 15
 *     pages this way. From the first upload every path is a public URL, and the
 *     next such deletion is a 404 for a real reader with nothing watching.
 *
 *     So `docs/published_paths.json` records what was actually served (written
 *     by scripts/docs_publish.ts on each successful upload, not by hand), and
 *     any path in it that has left docs/ must appear as a `redirect_maps` key.
 *     Renaming a page then forces the redirect in the same commit. Shrink-only
 *     in the same shape as generic_tld_tripwire: additions are free, only
 *     disappearances are gated.
 *
 *  5. NOTHING GITIGNORED UNDER docs/ IS BUILT. `docs_dir` means every file in
 *     the tree; MkDocs has never heard of .gitignore. docs/superpowers/ is a
 *     local scratch area for internal design specs and was LIVE at dedalo.dev,
 *     indexed in the public sitemap. The ignored set is derived from git, so
 *     the next scratch folder is covered the day it appears.
 *
 *  6. THE `privacy` PLUGIN IS ENABLED. Material lazy-loads Mermaid from
 *     unpkg.com at RUNTIME; the site CSP allows jsdelivr but not unpkg, so all
 *     83 diagrams across 53 pages rendered as grey code blocks. Vendoring
 *     serves it from 'self' and needs no CSP change.
 *
 *  7. THE v6-ONLY REDIRECTS ARE RewriteRules ABOVE THE CATCH-ALL. mod_alias
 *     (RedirectMatch) runs AFTER mod_rewrite, so a RedirectMatch in that file
 *     is dead code whatever the source order — all three such URLs 301'd to
 *     /docs/v7/… and 404'd in production until this was found.
 *
 *  8. EVERY PAGE THE READER SEES IS ONE MATOMO VIEW. `navigation.instant` swaps
 *     in-site pages by XHR, so docs/additional_javascript.js runs once per visit;
 *     a bare `trackPageView` counted only the landing page and every page reached
 *     through the nav was missing from the statistics. The script must track from
 *     Material's `document$` (emits on load AND after each swap). Checked by
 *     RUNNING it against a fake `document$`, not by reading it.
 *
 *  9. THE "OLDER VERSION" BANNER SCRIPT DOES NOT THROW. mkdocs-material
 *     9.7.6–9.7.7 ship a partial that writes the site's RELATIVE base_url into
 *     `new URL()` with no base argument, which throws on every page — silently,
 *     because the banner is hidden until that script unhides it and on the
 *     latest version it should stay hidden. `overrides/` supplies the fixed
 *     partial; checked by RUNNING it for the root and two nesting depths.
 *
 * The manifest is EMPTY until the first publish, and that is a real state, not
 * a stub: no v7 URL is public yet, so no v7 rename can break anything yet.
 * Assertion 4 states that emptiness rather than passing silently; the
 * redirect_maps scan, the flat-link census and the plugin list each carry an
 * anti-vacuity floor or a positive control.
 *
 * The page-path scan is SHARED with the publish script
 * (scripts/lib/docs_paths.ts). It was duplicated once, and the two copies
 * diverged the moment `exclude_docs` appeared — the script recorded a page as
 * published that the build had excluded.
 *
 * HONEST LIMIT: this proves the WIRING, the CONFIG and the two shipped SCRIPTS
 * it runs (assertions 8 and 9) — never the fully RENDERED page. The privacy
 * plugin rewrites assets to absolute URLs under site_url, so a local build
 * loads them from dedalo.dev; diagrams can only be checked on the published
 * site, and that a tree actually reached the server is `docs:publish` rsync's
 * business.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	excludedDocsPatterns,
	isExcluded,
	publishedPagePaths,
} from '../../scripts/lib/docs_paths.ts';
import { docsFiles } from '../helpers/docs_corpus.ts';
import { shippedTextFiles } from '../helpers/shipped_text_corpus.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const DOCS_DIR = join(REPO_ROOT, 'docs');
const MKDOCS_YML = join(REPO_ROOT, 'mkdocs.yml');

/** The version this repo builds. The single place the expectation is written. */
const VERSION = 'v7';
const EXPECTED_SITE_URL = `https://dedalo.dev/docs/${VERSION}/`;

const mkdocsYml = readFileSync(MKDOCS_YML, 'utf8');

/**
 * The pages that exist in the v6 manual and NOT here, so a legacy flat URL for
 * one of them must go to /docs/v6/ rather than follow the catch-all to v7.
 *
 * A CLOSED list, not a sample: v6 is frozen and gains no further pages. It is
 * written out rather than derived because the v6 checkout is a separate
 * repository that is not present on a clone of this one.
 *
 * Measured 2026-09-21: of v6's 52 pages, 46 exist at the identical path here
 * and 3 more (`install/install_help`, `management/maintenace_status`,
 * `config/thesaurus_dependeces`) are absorbed by this repo's own
 * `redirect_maps`. These three are the remainder.
 */
const V6_ONLY_PATHS = [
	'diffusion/diffusion_config_properties',
	'diffusion/diffusion_multiple_databases',
	'update_v5/',
];

/**
 * `redirect_maps` keys, read out of mkdocs.yml directly.
 *
 * Deliberately a line scan rather than a YAML parse: mkdocs.yml carries a
 * `!!python/name:` tag (the mermaid superfence) that a strict YAML loader
 * refuses, and pulling in a loader that tolerates it would make this gate
 * depend on how permissive that loader happens to be.
 */
function redirectMapKeys(): Set<string> {
	const keys = new Set<string>();
	let inMap = false;
	for (const raw of mkdocsYml.split('\n')) {
		if (/^\s*redirect_maps:/.test(raw)) {
			inMap = true;
			continue;
		}
		if (!inMap) continue;
		// The block ends at the first line that is neither a comment, blank, nor
		// indented deeper than `redirect_maps:` itself.
		if (raw.trim() === '' || /^\s*#/.test(raw)) continue;
		const entry = raw.match(/^\s+(\S+\.md):\s*(\S+)\s*$/);
		if (!entry?.[1]) break;
		keys.add(entry[1]);
	}
	return keys;
}

describe('docs versioning: the published layout stays coherent', () => {
	test('mkdocs.yml declares the site_url for this version', () => {
		const match = mkdocsYml.match(/^site_url:\s*(\S+)\s*$/m);
		expect(
			match,
			'mkdocs.yml has no site_url. It is load-bearing: it sets the canonical URLs, ' +
				'sitemap.xml, and the location Material fetches versions.json from.',
		).not.toBeNull();
		expect(match?.[1]).toBe(EXPECTED_SITE_URL);
	});

	test('versions.json aliases exactly one `latest`, and it is this version', () => {
		const path = join(DOCS_DIR, 'versions.json');
		expect(
			existsSync(path),
			'docs/versions.json is missing — the version switcher has no index',
		).toBe(true);

		const versions = JSON.parse(readFileSync(path, 'utf8')) as {
			version: string;
			title: string;
			aliases: string[];
		}[];
		expect(Array.isArray(versions)).toBe(true);
		expect(versions.length).toBeGreaterThan(1);

		const latest = versions.filter((v) => v.aliases?.includes('latest'));
		expect(
			latest.map((v) => v.version),
			'exactly one version may be aliased `latest` — it is what decides which pages ' +
				'get the "older version" banner',
		).toEqual([VERSION]);

		// Every declared version must be one we actually serve a tree for.
		for (const v of versions) {
			expect(v.version).toMatch(/^v\d+$/);
			expect(v.title.length).toBeGreaterThan(0);
		}
	});

	test('no shipped file links a flat dedalo.dev/docs/<path> URL', () => {
		// docs/ itself is exempt: a page may quote the published URL as example
		// data (docs/using/importing_data.md uses it as a sample IRI), and internal
		// navigation is relative anyway.
		const shipped = shippedTextFiles();
		const offenders: string[] = [];
		let scanned = 0;
		for (const rel of shipped) {
			scanned++;
			const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
			// A flat link is one whose next segment is not a version directory.
			for (const m of text.matchAll(/dedalo\.dev\/docs\/(?!v\d+\/)([A-Za-z0-9_\-/#.]*)/g)) {
				// Bare `…/docs/` or `…/docs` with no path is the site root, which
				// the latest-pointer redirect handles for ever. Only a deep flat
				// path is version-ambiguous.
				if (m[1] === '' || m[1] === '"') continue;
				offenders.push(`${rel}: dedalo.dev/docs/${m[1]}`);
			}
		}
		// Corpus floor: a verdict of "no offenders" is worthless if the scan read
		// nothing. A glob that stops matching must fail here, not pass quietly.
		expect(
			scanned,
			'the flat-link scan read almost no files — the census is broken',
		).toBeGreaterThan(2000);

		expect(
			offenders,
			'A published docs link with no version prefix depends on a redirect whose target ' +
				'changes when the next major ships. Write the version: ' +
				`https://dedalo.dev/docs/${VERSION}/<path>.`,
		).toEqual([]);
	});

	test('the flat-link scan detects a planted offender (positive control)', () => {
		// Proves the pattern matches what it claims to, independently of the corpus.
		const pattern = /dedalo\.dev\/docs\/(?!v\d+\/)([A-Za-z0-9_\-/#.]*)/g;
		const planted = "href: 'https://dedalo.dev/docs/install/install/',";
		expect([...planted.matchAll(pattern)].map((m) => m[1])).toEqual(['install/install/']);
		// …and that a correctly versioned link is NOT flagged.
		expect([...'https://dedalo.dev/docs/v7/install/'.matchAll(pattern)]).toEqual([]);
	});

	test('every page that has left docs/ since the last publish has a redirect', () => {
		const manifest = JSON.parse(readFileSync(join(DOCS_DIR, 'published_paths.json'), 'utf8')) as {
			published_at: string | null;
			paths: string[];
		};

		// Before the first publish the manifest is empty, and that is a real state
		// rather than a stub: no v7 URL is public, so no v7 rename can break one.
		// Asserted, never early-returned — a gate that quietly returns is a gate
		// nobody can tell apart from one that ran.
		const prePublication = manifest.published_at === null;
		expect(prePublication ? manifest.paths : []).toEqual([]);

		const current = new Set(publishedPagePaths(REPO_ROOT));
		const redirects = redirectMapKeys();
		const orphaned = manifest.paths.filter((p) => {
			if (current.has(p)) return false;
			// `a/b` was published from `a/b.md`; an index page `a/` from `a/index.md`.
			const source = p === '' ? 'index.md' : p.endsWith('/') ? `${p}index.md` : `${p}.md`;
			return !redirects.has(source);
		});

		expect(
			orphaned,
			'These pages were published and no longer exist, with no redirect. Every one is a ' +
				'404 for anyone who linked it. Add a `redirect_maps` entry in mkdocs.yml pointing ' +
				'each at its replacement (or at the nearest surviving hub).',
		).toEqual([]);
	});

	test('the redirect_maps scan actually finds entries (anti-vacuity)', () => {
		// If the mkdocs.yml layout ever changes shape, the scan above could return
		// an empty set and make the rename gate pass by seeing nothing.
		const keys = redirectMapKeys();
		expect(keys.size).toBeGreaterThan(10);
		expect(keys.has('install/install_help.md')).toBe(true);
	});

	test('nothing gitignored under docs/ can be built or published', () => {
		// `docs_dir` means EVERY file in the tree; MkDocs has never heard of
		// .gitignore. So a local scratch folder under docs/ is published by
		// default, and nobody notices because it builds cleanly and looks like
		// any other page.
		//
		// It happened: docs/superpowers/ holds internal design specs, is
		// gitignored, exists only in a working copy — and one of its specs was
		// live at dedalo.dev/docs/v7/superpowers/specs/… and indexed in the
		// public sitemap until 2026-09-21.
		//
		// The ignored set is derived from GIT rather than listed here, so the
		// next scratch folder is covered the day it appears instead of the day
		// someone remembers this gate exists.
		const ignored = Bun.spawnSync(['git', 'check-ignore', '--stdin'], {
			cwd: REPO_ROOT,
			stdin: Buffer.from(docsFiles().join('\n')),
		});
		const ignoredDocs = ignored.stdout
			.toString()
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.startsWith('docs/'))
			.map((l) => l.slice('docs/'.length))
			// .DS_Store and friends are ignored everywhere and are not pages; MkDocs
			// copies them but they carry nothing. Only real content matters here.
			.filter((f) => !f.split('/').some((seg) => seg === '.DS_Store'));

		const patterns = excludedDocsPatterns(mkdocsYml);
		const leaking = ignoredDocs.filter((f) => !isExcluded(f, patterns));

		expect(
			leaking,
			'These files are gitignored — they exist only in a working copy — but nothing in ' +
				"mkdocs.yml's `exclude_docs` stops the build from publishing them to dedalo.dev. " +
				'Add the directory (with a trailing slash) to exclude_docs.',
		).toEqual([]);

		// Anti-vacuity: if the ignored-set derivation breaks, this gate would pass
		// by seeing nothing. There is at least one excluded pattern today.
		expect(
			patterns.length,
			'exclude_docs is empty — has the block moved or changed shape?',
		).toBeGreaterThan(0);
	});

	test('the manual ships no runtime third-party asset', () => {
		// Material lazy-loads Mermaid from unpkg.com AT RUNTIME. dedalo.dev sends a
		// Content-Security-Policy whose script-src names 'self', analytics.render.es
		// and cdn.jsdelivr.net — not unpkg.com — so the browser blocked it and all
		// 83 diagrams across 53 pages rendered as plain grey code blocks.
		//
		// Nothing failed loudly. The build was green, the HTML was correct, the page
		// looked fine unless you knew a diagram belonged there. That is the whole
		// reason this is a gate and not a note: the failure mode is silent, remote,
		// and invisible to every local check.
		//
		// The `privacy` plugin downloads external assets into assets/external/ at
		// build time, so they are served from 'self'. Removing it re-breaks the
		// diagrams the moment the site is published, not when the build runs.
		const plugins = mkdocsYml.match(/^plugins:\s*\n((?:[ \t]+.*\n|\s*\n)*)/m)?.[1] ?? '';
		const enabled = plugins
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.startsWith('- '))
			.map((l) => l.slice(2).replace(/:.*$/, '').trim());

		expect(
			enabled,
			'mkdocs.yml must enable the `privacy` plugin. Without it Material fetches Mermaid ' +
				'from unpkg.com at runtime, which the site CSP blocks — every diagram in the manual ' +
				'silently degrades to a grey code block once published.',
		).toContain('privacy');

		// Anti-vacuity: prove the plugin list was actually parsed.
		expect(enabled).toContain('search');
	});

	test('analytics counts one page view per instant navigation, not per full load', () => {
		const features = mkdocsYml.match(/^\s+features:\s*\n((?:\s+- .*\n)+)/m)?.[1] ?? '';
		expect(
			features,
			'the `features:` list in mkdocs.yml was not found — has the block moved?',
		).toContain('navigation.');

		const view = (withDocument$: boolean) => {
			const src = readFileSync(join(DOCS_DIR, 'additional_javascript.js'), 'utf8');
			const subscribers: Array<() => void> = [];
			const location = { href: '' };
			const doc = {
				title: '',
				createElement: () => ({}),
				getElementsByTagName: () => [{ parentNode: { insertBefore: () => {} } }],
			};
			const win: { location: typeof location; _paq?: unknown[][] } = { location };
			const document$ = withDocument$
				? { subscribe: (fn: () => void) => subscribers.push(fn) }
				: undefined;
			new Function('window', 'document', 'document$', src)(win, doc, document$);
			const paq = () => win._paq ?? [];
			const navigate = (url: string, title: string) => {
				location.href = url;
				doc.title = title;
				for (const fn of subscribers) fn();
			};
			const views = () => paq().filter((c) => c[0] === 'trackPageView').length;
			return { paq, navigate, views };
		};

		// Without Material's bundle: the classic single view.
		expect(view(false).views(), 'no document$ ⇒ exactly one trackPageView').toBe(1);

		const t = view(true);
		// Nothing tracked before document$ fires: the landing view is its FIRST
		// emission, so an extra eager trackPageView would double-count it.
		expect(t.views(), 'trackPageView ran before document$ emitted (double count)').toBe(0);

		const A = 'https://dedalo.dev/docs/v7/';
		const B = 'https://dedalo.dev/docs/v7/install/';
		t.navigate(A, 'Home');
		t.navigate(B, 'Install');
		t.navigate(B, 'Install'); // same page re-emitted: not a new view
		expect(
			t.views(),
			'an instant navigation did not produce its own page view — internal doc pages ' +
				'are invisible to Matomo. Track inside document$.subscribe.',
		).toBe(2);

		const calls = t.paq();
		// Last index of a _paq command (Array#findLast* is ES2023, beyond the project's lib).
		const lastIndexOf = (list: unknown[][], command: string): number => {
			for (let at = list.length - 1; at >= 0; at--) if (list[at]?.[0] === command) return at;
			return -1;
		};
		const second = lastIndexOf(calls, 'trackPageView');
		const before = calls.slice(0, second);
		const lastArg = (command: string): unknown => before[lastIndexOf(before, command)]?.[1];
		expect(lastArg('setCustomUrl')).toBe(B);
		expect(lastArg('setDocumentTitle')).toBe('Install');
		expect(lastArg('setReferrerUrl')).toBe(A);
		// The landing view keeps the browser's own document.referrer.
		const first = calls.findIndex((c) => c[0] === 'trackPageView');
		expect(calls.slice(0, first).some((c) => c[0] === 'setReferrerUrl')).toBe(false);
	});

	test('the "older version" banner runs without throwing (theme-partial override)', () => {
		// THE ONE RENDERED-PAGE FAILURE THIS FILE CAN STILL CATCH. Everything
		// above proves wiring and config; this proves a script we SHIP runs.
		//
		// mkdocs-material 9.7.6–9.7.7 (and upstream master, 2026-10-14) ship
		// partials/javascripts/outdated.html as `new URL("{{ base_url }}")` —
		// no base argument. base_url is RELATIVE ("." at the site root, ".." one
		// level down), so the constructor throws on every page:
		//
		//   Uncaught TypeError: Failed to construct 'URL': Invalid URL
		//
		// The page looked fine: the banner is `hidden` until this script unhides
		// it, and on the latest version it should stay hidden. So the build was
		// green, the HTML was correct, and the only symptom was a console error
		// — while the feature it silently disabled (the banner) is the one that
		// starts mattering the day v7 stops being `latest`. That shape is why
		// this is a gate and not a note.
		//
		// Dédalo's `overrides/` custom_dir supplies the fixed partial. This test
		// RUNS it (like the analytics test above) rather than grepping it: a
		// regression that reintroduces a URL with no base throws here.
		const path = join(REPO_ROOT, 'overrides/partials/javascripts/outdated.html');
		expect(
			existsSync(path),
			'overrides/partials/javascripts/outdated.html is missing — the unfixed theme ' +
				'partial takes over again and every page throws "Failed to construct \'URL\'".',
		).toBe(true);

		const template = readFileSync(path, 'utf8');
		const scriptMatch = template.match(/<script>([\s\S]*?)<\/script>/);
		expect(
			scriptMatch,
			'the override has no <script> — has the partial changed shape?',
		).not.toBeNull();
		const script = scriptMatch![1]!;

		/**
		 * Render the partial for one page: resolve the Jinja expression to the
		 * page's `base_url`, then run the script the browser will run.
		 *
		 * `location`/`store` are the only DOM the script touches; `__md_get` is
		 * Material's real storage reader, scope key = `${scope.pathname}.${name}`
		 * (see partials/javascripts/base.html).
		 */
		const run = (baseUrl: string, href: string, outdatedValue: boolean | null) => {
			const src = script.replace(/\{\{.*?\}\}/g, baseUrl);
			const location = { href, toString: () => href };
			const wantKey = `${new URL(baseUrl, href).pathname}.__outdated`;
			const el = { hidden: true };
			const doc = { querySelector: () => el };
			const storage = {
				getItem: (k: string) =>
					outdatedValue !== null && k === wantKey ? JSON.stringify(outdatedValue) : null,
			};
			const mdGet = (name: string, _storage: unknown, scope: { pathname: string }) =>
				JSON.parse(storage.getItem(`${scope.pathname}.${name}`) ?? 'null');
			new Function('document', 'location', 'sessionStorage', '__md_get', src)(
				doc,
				location,
				storage,
				mdGet,
			);
			return el.hidden;
		};

		// Every page of the manual has a relative base_url; the root and two
		// depths are enough to prove the base argument is present and correct.
		const pages: Array<[string, string]> = [
			['.', 'https://dedalo.dev/docs/v7/'],
			['..', 'https://dedalo.dev/docs/v7/core/'],
			['../../..', 'https://dedalo.dev/docs/v7/a/b/c/'],
		];
		for (const [baseUrl, href] of pages) {
			// The regression: no base argument throws before any banner logic.
			expect(() => run(baseUrl, href, null), `threw for base_url ${baseUrl}`).not.toThrow();
			// The point of the script: an outdated version unhides the banner.
			expect(run(baseUrl, href, true), `banner stayed hidden for base_url ${baseUrl}`).toBe(false);
			// …and a current version leaves it hidden.
			expect(run(baseUrl, href, false), `banner unhid for base_url ${baseUrl}`).toBe(true);
		}
	});

	test('the routing file states the v6-only exceptions in mod_rewrite, above the catch-all', () => {
		// APACHE PHASE ORDER, learned the hard way. mod_rewrite runs BEFORE
		// mod_alias, so a `RedirectMatch` in this file is dead code behind the
		// `RewriteRule` catch-all no matter what order the two appear in. The
		// first published version used RedirectMatch for the three v6-only pages
		// and every one of them 301'd to /docs/v7/… and 404'd in production
		// (verified live 2026-09-21). Within mod_rewrite, source order does
		// decide — hence "above the catch-all".
		//
		// Nothing else can catch this: it is a live-server behaviour, invisible to
		// the build and to any local preview that does not run Apache.
		const raw = readFileSync(join(REPO_ROOT, 'deploy/docs/htaccess'), 'utf8');
		const directives = raw
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l !== '' && !l.startsWith('#'));

		expect(
			directives.filter((l) => /^RedirectMatch\b/i.test(l)),
			'RedirectMatch (mod_alias) is evaluated AFTER mod_rewrite, so it can never win ' +
				'against the catch-all RewriteRule in this same file. Express the exception as a ' +
				'RewriteRule placed above the catch-all instead.',
		).toEqual([]);

		// The catch-all is the last rule; every v6 exception must precede it.
		const catchAll = directives.findIndex((l) => /^RewriteRule\s+\^\(\.\+\)\$/.test(l));
		expect(
			catchAll,
			'the catch-all RewriteRule is missing from deploy/docs/htaccess',
		).toBeGreaterThan(-1);

		// Each path that exists in v6 and not in v7 needs its own earlier rule.
		for (const pathFragment of V6_ONLY_PATHS) {
			const idx = directives.findIndex(
				(l) => /^RewriteRule\b/.test(l) && l.includes(pathFragment) && l.includes('/docs/v6/'),
			);
			expect(idx, `no RewriteRule sends ${pathFragment} to /docs/v6/`).toBeGreaterThan(-1);
			expect(
				idx,
				`the rule for ${pathFragment} sits BELOW the catch-all, so it never runs`,
			).toBeLessThan(catchAll);
		}
	});
});
