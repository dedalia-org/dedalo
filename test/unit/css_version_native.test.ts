/**
 * CSS VERSION gate (WC-2026-11-06-css-version).
 *
 * The client tree is served by the institution's web server; without
 * `Cache-Control: no-cache` browsers keep main.css — and index.html — stale for
 * days after a code update. So every stylesheet URL is built from
 * page_globals.css_version, a content hash the ENGINE sends in `start`:
 *  - clientCssVersion is a hash of the stylesheet BYTES (an independent
 *    recomputation must agree), frozen in production, recomputed in dev;
 *  - index.html carries no static main.css link (a constant URL is the bug);
 *  - head-init.js (first paint) and index.js (post-start swap) share one
 *    storage key, one version grammar and one URL shape, or every boot reloads;
 *  - no stylesheet URL is versioned with dedalo_version (null before login,
 *    constant between releases) — tool css goes through tool_css_url.
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { clientCssVersion, resetDedaloFilesManifest } from '../../src/core/api/dedalo_files.ts';
import { getRoots, TOOL_COMMON_CLIENT_DIR } from '../../src/core/tools/paths.ts';

const REPO = resolve(import.meta.dir, '../..');
const CLIENT = join(REPO, 'client/dedalo');
const PAGE = join(CLIENT, 'core/page');

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

async function withDevMode<T>(value: 'true' | 'false', fn: () => Promise<T>): Promise<T> {
	const saved = process.env.DEDALO_DEV_MODE;
	process.env.DEDALO_DEV_MODE = value;
	try {
		return await fn();
	} finally {
		if (saved === undefined) delete process.env.DEDALO_DEV_MODE;
		else process.env.DEDALO_DEV_MODE = saved;
	}
}

/** Every .css under `dir`, sorted per directory (the engine's walk order). */
function cssUnder(dir: string, rel = ''): string[] {
	let entries: import('node:fs').Dirent[];
	try {
		entries = readdirSync(dir + rel, { withFileTypes: true });
	} catch {
		return [];
	}
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return entries.flatMap((e) =>
		e.isDirectory()
			? cssUnder(dir, `${rel}/${e.name}`)
			: e.isFile() && e.name.endsWith('.css')
				? [`${rel}/${e.name}`]
				: [],
	);
}

describe('clientCssVersion (engine)', () => {
	test('is a content hash of every client stylesheet (independent recomputation)', async () => {
		const files: [string, string][] = [
			['/dedalo/core/page/css/main.css', join(PAGE, 'css/main.css')],
			...cssUnder(TOOL_COMMON_CLIENT_DIR).map((rel): [string, string] => [
				`/dedalo/core/tools_common${rel}`,
				TOOL_COMMON_CLIENT_DIR + rel,
			]),
			...getRoots().flatMap((root) =>
				cssUnder(root.path)
					.filter((rel) => rel.split('/')[2] === 'css')
					.map((rel): [string, string] => [root.url + rel, root.path + rel]),
			),
		];
		expect(files.length, 'tool stylesheets are part of the version').toBeGreaterThan(10);
		const hash = createHash('sha256');
		for (const [url, path] of files) {
			hash.update(url).update('\0').update(readFileSync(path)).update('\n');
		}
		const expected = hash.digest('hex').slice(0, 16);

		resetDedaloFilesManifest();
		const actual = await withDevMode('true', () => clientCssVersion());
		expect(actual).toMatch(/^[0-9a-f]{16}$/);
		expect(actual).toBe(expected);
	});

	test('production posture: frozen (one computation, shared promise)', async () => {
		resetDedaloFilesManifest();
		await withDevMode('false', async () => {
			const a = clientCssVersion();
			const b = clientCssVersion();
			expect(a).toBe(b);
			expect(await a).toMatch(/^[0-9a-f]{16}$/);
		});
		resetDedaloFilesManifest();
	});

	test('dev posture: recomputed per call (css:build rewrites main.css under a running server)', async () => {
		resetDedaloFilesManifest();
		await withDevMode('true', async () => {
			const a = clientCssVersion();
			const b = clientCssVersion();
			expect(a).not.toBe(b);
			expect(await a).toBe(await b);
		});
	});
});

// ---------------------------------------------------------------------------
// The two client halves, EXECUTED (not string-matched): head-init.js is a classic
// script, run here against a fake document; sync_main_css is sliced out of
// index.js (a side-effect module that cannot be imported) and run against a fake
// <head>. Each fake implements only the DOM surface the code under test touches —
// a call outside it throws, so the fakes cannot quietly stub a behaviour away.
// ---------------------------------------------------------------------------

const PAGE_URL = 'https://dedalo.test/dedalo/core/page/';
const HEAD_INIT_SRC = readFileSync(join(PAGE, 'js/head-init.js'), 'utf8');
const INDEX_SRC = readFileSync(join(PAGE, 'js/index.js'), 'utf8');

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const memoryStore = (
	seed: Record<string, string> = {},
): Store & { data: Record<string, string> } => {
	const data = { ...seed };
	return {
		data,
		getItem: (k) => data[k] ?? null,
		setItem: (k, v) => {
			data[k] = v;
		},
	};
};
const blockedStore: Store = {
	getItem() {
		throw new Error('SecurityError');
	},
	setItem() {
		throw new Error('SecurityError');
	},
};

/** Run head-init.js; returns what it document.write()s and the <html> attributes. */
function runHeadInit(storage: Store): { written: string[]; attrs: Record<string, string> } {
	const written: string[] = [];
	const attrs: Record<string, string> = {};
	const document = {
		documentElement: {
			setAttribute: (k: string, v: string) => {
				attrs[k] = v;
			},
		},
		currentScript: { src: `${PAGE_URL}js/head-init.js` },
		write: (html: string) => void written.push(html),
	};
	new Function('document', 'localStorage', HEAD_INIT_SRC)(document, storage);
	return { written, attrs };
}

/** The href/version of the link head-init wrote (it must write exactly one). */
function writtenLink(written: string[]): { href: string; version: string; id: string } {
	expect(written.length).toBe(1);
	const tag = written[0] as string;
	return {
		id: tag.match(/\bid="([^"]*)"/)?.[1] ?? '',
		version: tag.match(/\bdata-version="([^"]*)"/)?.[1] ?? '',
		href: tag.match(/\bhref="([^"]*)"/)?.[1] ?? '',
	};
}

class FakeLink {
	id = '';
	rel = '';
	href = '';
	dataset: Record<string, string> = {};
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(private readonly head: FakeHead) {}
	after(node: FakeLink) {
		this.head.insertAt(this.head.nodes.indexOf(this) + 1, node);
	}
	remove() {
		this.head.nodes = this.head.nodes.filter((n) => n !== this);
	}
	removeAttribute(name: string) {
		if (name !== 'id') throw new Error(`fake: removeAttribute(${name})`);
		this.id = '';
	}
}

class FakeHead {
	nodes: FakeLink[] = [];
	failing = new Set<string>();
	insertAt(index: number, node: FakeLink) {
		this.nodes.splice(index, 0, node);
		// the browser fetches on insertion; settle on the next tick
		setTimeout(() => (this.failing.has(node.href) ? node.onerror?.() : node.onload?.()), 0);
	}
	prepend(node: FakeLink) {
		this.insertAt(0, node);
	}
	querySelector(selector: string) {
		if (selector !== 'link[rel="stylesheet"][href*="/core/page/css/main.css"]') {
			throw new Error(`fake: querySelector(${selector})`);
		}
		return (
			this.nodes.find(
				(n) => n.rel === 'stylesheet' && n.href.includes('/core/page/css/main.css'),
			) ?? null
		);
	}
	link(fields: Partial<FakeLink>): FakeLink {
		const node = Object.assign(new FakeLink(this), fields);
		this.nodes.push(node);
		return node;
	}
}

/** index.js's MAIN_CSS block, run against a fake head. */
function loadSyncMainCss(head: FakeHead, storage: Store) {
	const from = INDEX_SRC.indexOf('const MAIN_CSS_KEY');
	const to = INDEX_SRC.indexOf('}//end remember');
	expect(from, 'index.js MAIN_CSS block moved').toBeGreaterThan(-1);
	expect(to).toBeGreaterThan(from);
	const block = INDEX_SRC.slice(from, to + '}//end remember'.length).replaceAll(
		'import.meta.url',
		JSON.stringify(`${PAGE_URL}js/index.js`),
	);
	const document = {
		head,
		getElementById: (id: string) => head.nodes.find((n) => n.id === id) ?? null,
		createElement: (tag: string) => {
			if (tag !== 'link') throw new Error(`fake: createElement(${tag})`);
			return new FakeLink(head);
		},
	};
	const quiet = { error() {} };
	return new Function(
		'document',
		'localStorage',
		'console',
		`${block}\nreturn { sync_main_css, main_css_url, MAIN_CSS_KEY };`,
	)(document, storage, quiet) as {
		sync_main_css(v: unknown): Promise<boolean>;
		main_css_url(v: string | null): string;
		MAIN_CSS_KEY: string;
	};
}

const OLD = 'aaaaaaaaaaaaaaaa';
const NEW = 'bbbbbbbbbbbbbbbb';

describe('head-init.js (executed): first paint always gets a stylesheet', () => {
	test('a stored version → the link at that version, the URL sync_main_css builds', () => {
		const { written } = runHeadInit(memoryStore({ dedalo_css_version: OLD }));
		const link = writtenLink(written);
		expect(link).toEqual({
			id: 'main_css',
			version: OLD,
			href: loadSyncMainCss(new FakeHead(), memoryStore()).main_css_url(OLD),
		});
	});

	test('no stored version → ?v=init (never zero sheets, never a URL cached before)', () => {
		const link = writtenLink(runHeadInit(memoryStore()).written);
		expect(link.version).toBe('init');
		expect(link.href).toBe(`${PAGE_URL}css/main.css?v=init`);
	});

	test('storage blocked → ?v=init, and the theme half survives too', () => {
		expect(writtenLink(runHeadInit(blockedStore).written).version).toBe('init');
	});

	test('a tampered stored value is never written into markup', () => {
		const evil = '"><script>alert(1)</script>';
		const { written } = runHeadInit(memoryStore({ dedalo_css_version: evil }));
		expect(written[0]).not.toContain('<script>');
		expect(writtenLink(written).version).toBe('init');
	});

	test('the shared storage key is the one index.js remembers under', () => {
		const { MAIN_CSS_KEY } = loadSyncMainCss(new FakeHead(), memoryStore());
		const { written } = runHeadInit(memoryStore({ [MAIN_CSS_KEY]: NEW }));
		expect(writtenLink(written).version).toBe(NEW);
	});

	test('theme + active style still applied', () => {
		const { attrs } = runHeadInit(
			memoryStore({ dedalo_theme: 'dark', dedalo_active_style: 'frame' }),
		);
		expect(attrs).toEqual({ 'data-theme': 'dark', 'data-active_style': 'frame' });
	});
});

describe('sync_main_css (executed): the server version wins before render', () => {
	test('stale written sheet → replaced IN PLACE (before tool sheets), version remembered', async () => {
		const head = new FakeHead();
		const storage = memoryStore({ dedalo_css_version: OLD });
		const { sync_main_css, main_css_url } = loadSyncMainCss(head, storage);
		head.link({
			id: 'main_css',
			rel: 'stylesheet',
			href: main_css_url(OLD),
			dataset: { version: OLD },
		});
		head.link({ rel: 'stylesheet', href: '/dedalo/tools/tool_x/css/tool_x.css' });
		expect(await sync_main_css(NEW)).toBe(true);
		expect(head.nodes.map((n) => [n.id, n.href])).toEqual([
			['main_css', main_css_url(NEW)],
			['', '/dedalo/tools/tool_x/css/tool_x.css'],
		]);
		expect(storage.data.dedalo_css_version).toBe(NEW);
	});

	test('head-init ?v=init sheet → swapped to the server version', async () => {
		const head = new FakeHead();
		const { sync_main_css, main_css_url } = loadSyncMainCss(head, memoryStore());
		head.link({
			id: 'main_css',
			rel: 'stylesheet',
			href: main_css_url('init'),
			dataset: { version: 'init' },
		});
		expect(await sync_main_css(NEW)).toBe(true);
		expect(head.nodes.map((n) => n.href)).toEqual([main_css_url(NEW)]);
	});

	test('already current → no request, still remembered', async () => {
		const head = new FakeHead();
		const storage = memoryStore();
		const { sync_main_css, main_css_url } = loadSyncMainCss(head, storage);
		head.link({
			id: 'main_css',
			rel: 'stylesheet',
			href: main_css_url(NEW),
			dataset: { version: NEW },
		});
		expect(await sync_main_css(NEW)).toBe(false);
		expect(head.nodes.length).toBe(1);
		expect(storage.data.dedalo_css_version).toBe(NEW);
	});

	test('a stale pre-head-init index.html: its id-less static link is replaced, not left to win the cascade', async () => {
		const head = new FakeHead();
		const { sync_main_css, main_css_url } = loadSyncMainCss(head, memoryStore());
		head.link({ rel: 'stylesheet', href: '/dedalo/core/page/css/main.css?ckcachebust=2ED789A0' });
		expect(await sync_main_css(NEW)).toBe(true);
		expect(head.nodes.map((n) => n.href)).toEqual([main_css_url(NEW)]);
	});

	test('the new sheet fails to load → the old one stays, nothing remembered', async () => {
		const head = new FakeHead();
		const storage = memoryStore({ dedalo_css_version: OLD });
		const { sync_main_css, main_css_url } = loadSyncMainCss(head, storage);
		head.link({
			id: 'main_css',
			rel: 'stylesheet',
			href: main_css_url(OLD),
			dataset: { version: OLD },
		});
		head.failing.add(main_css_url(NEW));
		expect(await sync_main_css(NEW)).toBe(false);
		expect(head.nodes.map((n) => [n.id, n.href])).toEqual([['main_css', main_css_url(OLD)]]);
		expect(storage.data.dedalo_css_version).toBe(OLD);
	});

	test('no version (start failed) with a sheet present → untouched; with none → the bare sheet', async () => {
		const head = new FakeHead();
		const { sync_main_css, main_css_url } = loadSyncMainCss(head, memoryStore());
		expect(await sync_main_css(undefined)).toBe(true);
		expect(head.nodes.map((n) => n.href)).toEqual([main_css_url(null)]);
		expect(await sync_main_css(null)).toBe(false);
		expect(head.nodes.length).toBe(1);
	});

	test('storage blocked → still swaps (remembering is best-effort)', async () => {
		const head = new FakeHead();
		const { sync_main_css, main_css_url } = loadSyncMainCss(head, blockedStore);
		head.link({
			id: 'main_css',
			rel: 'stylesheet',
			href: main_css_url('init'),
			dataset: { version: 'init' },
		});
		expect(await sync_main_css(NEW)).toBe(true);
		expect(head.nodes.map((n) => n.href)).toEqual([main_css_url(NEW)]);
	});
});

describe('client wiring', () => {
	test('index.html has no static main.css link (a constant URL is what went stale)', () => {
		const html = readFileSync(join(PAGE, 'index.html'), 'utf8');
		expect(html).not.toMatch(/<link[^>]+main\.css/);
		// head-init writes the link with document.write: it must stay a classic,
		// synchronous script, or the link stops blocking first paint
		expect(html).toMatch(/<script src="js\/head-init\.js"><\/script>/);
	});

	test('index.js syncs the sheet after start and before render', () => {
		const index = stripComments(INDEX_SRC);
		const build = index.indexOf('await page_instance.build(true)');
		const sync = index.indexOf('await sync_main_css(window.page_globals?.css_version)');
		const render = index.indexOf('await page_instance.render()');
		expect(build).toBeGreaterThan(-1);
		expect(sync).toBeGreaterThan(build);
		expect(render).toBeGreaterThan(sync);
	});

	test('no stylesheet URL is versioned with dedalo_version; tool css has one spelling, never shadowed', () => {
		const offenders: string[] = [];
		const builders: string[] = [];
		const shadows: string[] = [];
		const walk = (dir: string) => {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				const p = join(dir, e.name);
				if (e.isDirectory()) {
					if (e.name !== 'lib' && e.name !== 'node_modules') walk(p);
				} else if (e.name.endsWith('.js')) {
					const code = stripComments(readFileSync(p, 'utf8'));
					if (/\.css['`][^\n]*dedalo_version/.test(code)) offenders.push(p);
					if (/'\/css\/' \+ [\w.]+ \+ '\.css/.test(code)) builders.push(p.slice(REPO.length + 1));
					// a local binding named like the helper shadows it — and
					// `const tool_css_url = tool_css_url(m)` throws (TDZ) on every tool open
					if (/\b(?:const|let|var)\s+tool_css_url\b|\(\s*tool_css_url\s*[,)=]/.test(code)) {
						shadows.push(p.slice(REPO.length + 1));
					}
				}
			}
		};
		walk(CLIENT);
		walk(join(REPO, 'tools'));
		expect(offenders).toEqual([]);
		expect(builders).toEqual(['client/dedalo/core/common/js/utils/util.js']);
		expect(shadows).toEqual([]);
	});
});
