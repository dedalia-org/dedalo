/**
 * THE CLIENT UNDER A PRERELEASE IDENTITY — the page and the code-update ask,
 * executed (release identity design gates 3 and 4, client half;
 * WC-2026-10-15-release-identity-from-tag).
 *
 * A build at tag `v7.0.0-beta.6` calls itself `7.0.0-beta.6`
 * (`page_globals.dedalo_version`) while its data stays `7.0.0`
 * (`page_globals.dedalo_data_version`, beside it). Before this change the two
 * client doors below read the identity as if it were the data version:
 *
 *   GATE 3 — render_page.js split it on dots (`7.0.0-beta` ≠ `7.0.0`), so EVERY
 *   page rendered the update-data widget instead of the app; and its wrapper
 *   class token was the identity with dots swapped, so an identity holding a
 *   space made `classList.add` throw and took the page down.
 *
 *   GATE 4 — update_code.js asked the code master with the identity as
 *   `options.version`; a master's parser (this one's before the hardening, and
 *   every OLDER master's for ever) reads three integers, so `0-beta` → NaN →
 *   'Invalid version number': a beta could never even list its updates.
 *
 * WHAT IS PINNED, BY EXECUTING THE REAL MODULES (their leaf imports stubbed):
 *   - render_page.prototype.edit renders the APP (no update-data widget) for a
 *     prerelease, an rc, a dev identity and a stable one whose data triple
 *     equals the stored data version — with the published `dedalo_data_version`
 *     AND, separately, without it (the derived fallback); it renders the WIDGET
 *     when the code's data triple really differs (control), and nothing for an
 *     anonymous page (no version to judge);
 *   - the wrapper's class token is one valid token for any identity;
 *   - update_code.prototype.get_code_update_info sends `version` that BOTH the
 *     current master (authorizeUpdateManifest, the real door) and the
 *     pre-hardening parser (copied below, verbatim — an older master is code we
 *     can no longer change) accept as the data triple, and `release` = the
 *     identity;
 *   - render_update_ontology's get_update_info (the ontology-update ask) sends
 *     EXACTLY the data triple as `version` — both ontology doors read only
 *     major.minor and would accept the identity too, so the value is the
 *     assertion, acceptance is checked on top.
 *
 *   - view_default_edit_menu's debug bar marks the version badge from
 *     `page_globals.release_kind` (owner Q11): `beta` for a prerelease, `dev`
 *     for a dev build, nothing for a stable release — whatever the identity
 *     string says. The pre-Q11 sniff (`dedalo_version.indexOf('7.0')`) marked
 *     the stable `7.0.0` beta and missed a `9.1.0-rc.1`.
 *
 * The SERVER half (what /health, page_globals and info_data actually publish)
 * is release_identity_served_native.test.ts: this gate writes its own
 * page_globals.
 *
 * Red against the pre-change client (proved 2026-10-15 by restoring the old
 * lines): the page cases render the widget, the class case throws, and the
 * ask carries `7.0.0-beta.6` as `version`, which the legacy parser refuses.
 *
 * DB-less, network-less → hermetic tier. ISOLATED GATE: it substitutes client
 * modules (test/helpers/isolated_gate.ts).
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isIsolatedGateChild, mirrorIsolatedGate } from '../helpers/isolated_gate.ts';

if (!isIsolatedGateChild(import.meta.path)) mirrorIsolatedGate(import.meta.path);
else {
	const CORE = join(import.meta.dir, '..', '..', 'client', 'dedalo', 'core');
	const COMMON = join(CORE, 'common', 'js');
	const MENU = join(CORE, 'menu', 'js');
	const UPDATE_CODE = join(CORE, 'area_maintenance', 'widgets', 'update_code', 'js');
	const UPDATE_ONTOLOGY = join(CORE, 'area_maintenance', 'widgets', 'update_ontology', 'js');

	/** A DOM element just rich enough for render_page; classList validates like the DOM does. */
	class FakeElement {
		tag: string;
		classes: string[] = [];
		children: FakeElement[] = [];
		marker?: string;
		constructor(tag: string) {
			this.tag = tag;
		}
		classList = {
			add: (...tokens: string[]) => {
				for (const token of tokens) {
					// DOMTokenList.add: '' is a SyntaxError, whitespace an InvalidCharacterError.
					if (token === '' || /\s/.test(token)) {
						throw new Error(`InvalidCharacterError: '${token}' is not a valid class token`);
					}
					if (!this.classes.includes(token)) this.classes.push(token);
				}
			},
		};
		appendChild(child: FakeElement) {
			this.children.push(child);
			return child;
		}
		prepend(child: FakeElement) {
			this.children.unshift(child);
		}
		addEventListener() {}
	}

	/**
	 * Every named export of a client module, stubbed `undefined` — spread under
	 * each mock so a stub never TRUNCATES the module it replaces (an import of a
	 * name this gate does not stub still resolves). Read by the transpiler's
	 * scan, never by importing: the real modules need a browser.
	 *
	 * No teardown re-mock: this file runs ALONE in its own process (isolated
	 * gate), and `mock.restore()` would not revert `mock.module` anyway.
	 */
	const exportStubs = (path: string): Record<string, undefined> =>
		Object.fromEntries(
			new Bun.Transpiler({ loader: 'js' })
				.scan(readFileSync(path, 'utf8'))
				.exports.map((name) => [name, undefined]),
		);

	const globals = globalThis as unknown as Record<string, unknown>;
	const SAVED_KEYS = [
		'document',
		'page_globals',
		'requestAnimationFrame',
		'SHOW_DEBUG',
		'get_label',
	] as const;
	const saved: Record<string, unknown> = {};

	/** How many times the update-data widget was rendered. */
	let widgetRenders = 0;
	/** Every body update_code posted. */
	const posted: Record<string, unknown>[] = [];

	type PageEdit = (
		this: Record<string, unknown>,
		options: Record<string, unknown>,
	) => Promise<FakeElement>;
	let pageEdit: PageEdit;
	let getCodeUpdateInfo: (server: unknown, channel: string) => Promise<unknown>;
	let getOntologyUpdateInfo: (server: unknown) => Promise<unknown>;
	let renderDebugInfoBar: (self: { data: { info_data: Record<string, unknown> } }) => FakeElement;
	let authorizeUpdateManifest: (input: Record<string, unknown>) => {
		ok: boolean;
		version?: number[];
	};

	beforeAll(async () => {
		for (const key of SAVED_KEYS) saved[key] = globals[key];
		globals.document = { createElement: (tag: string) => new FakeElement(tag) };
		globals.requestAnimationFrame = () => 0;
		globals.SHOW_DEBUG = false;
		globals.get_label = {};

		const createDom = (o: { element_type?: string; class_name?: string; parent?: FakeElement }) => {
			const node = new FakeElement(o.element_type ?? 'div');
			if (o.class_name) node.classList.add(...o.class_name.split(' '));
			o.parent?.appendChild(node);
			return node;
		};
		mock.module(join(COMMON, 'ui.js'), () => ({
			...exportStubs(join(COMMON, 'ui.js')),
			ui: { create_dom_element: createDom, load_item_with_spinner: async () => null },
		}));
		mock.module(join(COMMON, 'event_manager.js'), () => ({
			...exportStubs(join(COMMON, 'event_manager.js')),
			// subscribe: view_default_edit_menu.js subscribes at import
			event_manager: { publish() {}, subscribe() {} },
		}));
		mock.module(join(COMMON, 'data_manager.js'), () => ({
			...exportStubs(join(COMMON, 'data_manager.js')),
			data_manager: {
				request: async (options: { body: Record<string, unknown> }) => {
					posted.push(options.body);
					return { result: true };
				},
			},
		}));
		mock.module(join(COMMON, 'render_api_error.js'), () => ({
			...exportStubs(join(COMMON, 'render_api_error.js')),
			render_build_failure: () => null,
		}));
		mock.module(join(CORE, 'page', 'js', 'page.js'), () => ({
			...exportStubs(join(CORE, 'page', 'js', 'page.js')),
			instantiate_page_element: async () => null,
		}));
		mock.module(join(CORE, 'page', 'js', 'job_tray.js'), () => ({
			...exportStubs(join(CORE, 'page', 'js', 'job_tray.js')),
			render_job_tray() {},
		}));
		mock.module(join(CORE, 'area_maintenance', 'js', 'render_update_data_maintenance.js'), () => ({
			...exportStubs(join(CORE, 'area_maintenance', 'js', 'render_update_data_maintenance.js')),
			render_update_data_maintenance: async () => {
				widgetRenders++;
				const node = new FakeElement('div');
				node.marker = 'update_data_widget';
				return node;
			},
		}));
		// update_code.js wires prototypes from these at import; their bodies are never called here.
		mock.module(join(CORE, 'widgets', 'widget_common', 'js', 'widget_common.js'), () => ({
			...exportStubs(join(CORE, 'widgets', 'widget_common', 'js', 'widget_common.js')),
			widget_common: { prototype: {} },
		}));
		mock.module(join(CORE, 'area_maintenance', 'js', 'area_maintenance.js'), () => ({
			...exportStubs(join(CORE, 'area_maintenance', 'js', 'area_maintenance.js')),
			area_maintenance: { prototype: {} },
		}));
		// render_update_ontology.js's remaining leaves: read only by code paths
		// this gate never runs (the panel render), so plain export stubs.
		for (const leaf of ['events.js', 'api_error.js']) {
			mock.module(join(COMMON, leaf), () => exportStubs(join(COMMON, leaf)));
		}
		mock.module(join(UPDATE_CODE, 'render_update_code.js'), () => ({
			...exportStubs(join(UPDATE_CODE, 'render_update_code.js')),
			render_update_code: { prototype: {} },
		}));

		// view_default_edit_menu.js's other leaves: only render_debug_info_bar runs,
		// and it reads none of them — plain export stubs keep the browser-bound
		// modules (login, menu tree, theme) out of the process.
		for (const leaf of [
			join(CORE, 'login', 'js', 'login.js'),
			join(MENU, 'render_menu.js'),
			join(MENU, 'render_menu_tree.js'),
			join(MENU, 'render_menu_mobile.js'),
			join(CORE, 'page', 'js', 'theme.js'),
		]) {
			mock.module(leaf, () => exportStubs(leaf));
		}
		({ render_debug_info_bar: renderDebugInfoBar } = (await import(
			join(MENU, 'view_default_edit_menu.js')
		)) as { render_debug_info_bar: typeof renderDebugInfoBar });

		const { render_page } = (await import(join(CORE, 'page', 'js', 'render_page.js'))) as {
			render_page: { prototype: { edit: PageEdit } };
		};
		pageEdit = render_page.prototype.edit;
		const { update_code } = (await import(join(UPDATE_CODE, 'update_code.js'))) as {
			update_code: { prototype: { get_code_update_info: typeof getCodeUpdateInfo } };
		};
		getCodeUpdateInfo = update_code.prototype.get_code_update_info;
		({ get_update_info: getOntologyUpdateInfo } = (await import(
			join(UPDATE_ONTOLOGY, 'render_update_ontology.js')
		)) as { get_update_info: typeof getOntologyUpdateInfo });
		({ authorizeUpdateManifest } = (await import(
			'../../src/core/api/handlers/dd_utils_api.ts'
		)) as never);
	});

	afterAll(() => {
		for (const key of SAVED_KEYS) globals[key] = saved[key];
	});

	/** Render the page under `page_globals`; did it show the app or the update-data widget? */
	async function renderPage(pageGlobals: Record<string, unknown>) {
		globals.page_globals = pageGlobals;
		const before = widgetRenders;
		const self: Record<string, unknown> = { type: 'page', context: [], ar_instances: [] };
		const wrapper = await pageEdit.call(self, {});
		const contentData = wrapper.children[0] as FakeElement;
		const showedWidget = contentData.children.some(
			(child) => child.marker === 'update_data_widget',
		);
		// the two observations must agree, or the stub is not what the page called
		expect(showedWidget).toBe(widgetRenders > before);
		return { wrapper, showedWidget };
	}

	describe('render_page: the app, not the update-data widget, when only the identity differs (gate 3)', () => {
		test.each([
			['7.0.0-beta.6', '7.0.0', '7.0.0'],
			['7.0.0-alpha.1', '7.0.0', [7, 0, 0]],
			['7.0.0-rc.2', '7.0.0', '7.0.0'],
			['7.0.0.dev', '7.0.0', [7, 0, 0]],
			['7.0.0', '7.0.0', [7, 0, 0]],
		])(
			'identity %p, published data %p, stored %p → the app',
			async (identity, published, stored) => {
				const { showedWidget } = await renderPage({
					dedalo_version: identity,
					dedalo_data_version: published,
					data_version: stored,
				});
				expect(showedWidget).toBe(false);
			},
		);

		test.each([
			['7.0.0-beta.6', [7, 0, 0]],
			['7.0.0-rc.1', '7.0.0'],
			['7.0.0.dev', [7, 0, 0]],
		])(
			'WITHOUT the published key: identity %p, stored %p → the app (derived, never dot-split)',
			async (identity, stored) => {
				const { showedWidget } = await renderPage({
					dedalo_version: identity,
					data_version: stored,
				});
				expect(showedWidget).toBe(false);
			},
		);

		test.each([
			['7.0.1-beta.1', '7.0.1', [7, 0, 0]],
			['7.0.1', '7.0.1', '7.0.0'],
		])(
			'CONTROL: identity %p (data %p) over stored %p → the update-data widget',
			async (identity, published, stored) => {
				const { showedWidget } = await renderPage({
					dedalo_version: identity,
					dedalo_data_version: published,
					data_version: stored,
				});
				expect(showedWidget).toBe(true);
			},
		);

		test('CONTROL without the published key: a real mismatch still shows the widget', async () => {
			const { showedWidget } = await renderPage({
				dedalo_version: '7.0.1-beta.1',
				data_version: [7, 0, 0],
			});
			expect(showedWidget).toBe(true);
		});

		test('an anonymous page (no version published) renders, nothing to judge', async () => {
			const { showedWidget } = await renderPage({
				dedalo_version: null,
				dedalo_data_version: null,
				data_version: [7, 0, 0],
			});
			expect(showedWidget).toBe(false);
		});
	});

	describe('render_page: the wrapper carries ONE valid class token for any identity', () => {
		test.each([
			['7.0.0-beta.6', 'version_7_0_0-beta_6'],
			['7.0.0.dev', 'version_7_0_0_dev'],
			['7.0.0', 'version_7_0_0'],
			// not an identity the server emits — the page must still not throw on it
			['7.0.0 beta<6>', 'version_7_0_0_beta_6_'],
		])('%p → %p', async (identity, token) => {
			const { wrapper } = await renderPage({
				dedalo_version: identity,
				dedalo_data_version: '7.0.0',
				data_version: '7.0.0',
			});
			expect(wrapper.classes).toEqual(['wrapper', 'page', token]);
		});
	});

	describe('update_code: the code-update ask from a prerelease is read by every master (gate 4)', () => {
		/**
		 * The 3-part version read of a master BEFORE the hardening — verbatim from
		 * src/core/update/version.ts parseVersionString + authorizeUpdateManifest's
		 * check, as shipped through 7.0.0-beta.6. Older masters run this for ever.
		 */
		const legacyMasterAccepts = (versionRaw: unknown): boolean => {
			const raw = typeof versionRaw === 'string' ? versionRaw : '';
			const version = raw
				.replace(/\.dev$/, '')
				.split('.')
				.map((part) => Number(part));
			return !(version.length < 3 || version.some((n) => !Number.isInteger(n)));
		};
		const currentMasterAccepts = (versionRaw: unknown) =>
			authorizeUpdateManifest({
				isServer: true,
				configuredCodes: ['c0de'],
				allowLocalhost: false,
				presentedCode: 'c0de',
				versionRaw,
				requiredParts: 3,
				serverKind: 'code',
			});

		test('POSITIVE CONTROL: the legacy parser refuses the bare identity (the break this gate guards)', () => {
			expect(legacyMasterAccepts('7.0.0-beta.6')).toBe(false);
			expect(legacyMasterAccepts('7.0.0')).toBe(true);
		});

		test.each([
			[{ dedalo_version: '7.0.0-beta.6', dedalo_data_version: '7.0.0' }, '7.0.0'],
			[{ dedalo_version: '7.0.0-rc.1', dedalo_data_version: '7.0.0' }, '7.0.0'],
			[{ dedalo_version: '7.0.0.dev', dedalo_data_version: '7.0.0' }, '7.0.0'],
			// without the published key the triple is derived from the identity
			[{ dedalo_version: '7.0.0-beta.6' }, '7.0.0'],
		])('page_globals %p → version %p, release = the identity', async (pageGlobals, triple) => {
			globals.page_globals = pageGlobals;
			posted.length = 0;
			await getCodeUpdateInfo({ code: 'c0de', url: 'https://master.invalid/api' }, 'master');
			expect(posted).toHaveLength(1);
			const options = posted[0]?.options as Record<string, unknown>;
			expect(posted[0]?.action).toBe('get_code_update_info');
			expect(options.version).toBe(triple);
			expect(options.release).toBe(pageGlobals.dedalo_version);
			expect(options.channel).toBe('master');
			expect(legacyMasterAccepts(options.version)).toBe(true);
			expect(currentMasterAccepts(options.version)).toEqual({ ok: true, version: [7, 0, 0] });
		});
	});

	describe('update_ontology: the ontology-update ask carries the DATA triple, never the identity', () => {
		/**
		 * The ontology door's version read BEFORE the release identity — verbatim
		 * from authorizeUpdateManifest's two-part branch as shipped through
		 * 7.0.0-beta.6 (older masters run it for ever): major and minor, read
		 * positionally, each an integer.
		 */
		const legacyOntologyMasterAccepts = (versionRaw: unknown): boolean => {
			const raw = typeof versionRaw === 'string' ? versionRaw : '';
			const version = [Number(raw.split('.')[0]), Number(raw.split('.')[1])];
			return !(version.length < 2 || version.some((n) => !Number.isInteger(n)));
		};
		const currentOntologyMasterAccepts = (versionRaw: unknown) =>
			authorizeUpdateManifest({
				isServer: true,
				configuredCodes: ['c0de'],
				allowLocalhost: false,
				presentedCode: 'c0de',
				versionRaw,
				requiredParts: 2,
				serverKind: 'ontology',
			});

		/*
		 * WHY THE EXACT VALUE IS THE ASSERTION: both ontology doors read only
		 * major.minor, so they would ALSO accept '7.0.0-beta.6' — acceptance alone
		 * cannot see the identity leak. The contract (WC-2026-10-15) is that the
		 * ask carries the bare data triple, which is what a server compares the
		 * caller against; the doors' acceptance is asserted on top.
		 */
		test.each([
			[{ dedalo_version: '7.0.0-beta.6', dedalo_data_version: '7.0.0' }, '7.0.0'],
			[{ dedalo_version: '7.0.0-rc.1', dedalo_data_version: '7.0.0' }, '7.0.0'],
			[{ dedalo_version: '7.0.1-dev', dedalo_data_version: '7.0.0' }, '7.0.0'],
			// without the published key the triple is derived from the identity
			[{ dedalo_version: '7.0.0-beta.6' }, '7.0.0'],
			[{ dedalo_version: '7.0.1-alpha.2' }, '7.0.1'],
		])('page_globals %p → version %p', async (pageGlobals, triple) => {
			globals.page_globals = pageGlobals;
			posted.length = 0;
			await getOntologyUpdateInfo({ code: 'c0de', url: 'https://master.invalid/api' });
			expect(posted).toHaveLength(1);
			expect(posted[0]?.action).toBe('get_ontology_update_info');
			const options = posted[0]?.options as Record<string, unknown>;
			expect(options.version).toBe(triple);
			expect(options.code).toBe('c0de');
			expect(legacyOntologyMasterAccepts(options.version)).toBe(true);
			const accepted = currentOntologyMasterAccepts(options.version);
			expect(accepted.ok).toBe(true);
		});
	});

	describe("the menu's version badge reads page_globals.release_kind, never the identity string (Q11)", () => {
		/** The `.dedalo_version` element's classes for a page whose identity / kind are given. */
		const badgeClasses = (identity: string, releaseKind: unknown): string[] => {
			globals.page_globals =
				releaseKind === undefined
					? { dedalo_version: identity }
					: { dedalo_version: identity, release_kind: releaseKind };
			const bar = renderDebugInfoBar({ data: { info_data: { dedalo_version: identity } } });
			const badge = bar.children.find((child) => child.classes.includes('dedalo_version'));
			expect(badge, 'the debug bar renders no version badge').toBeDefined();
			return badge?.classes ?? [];
		};

		test.each([
			['7.0.0-beta.6', 'prerelease', ['dedalo_version', 'beta']],
			['7.0.0-rc.1', 'prerelease', ['dedalo_version', 'beta']],
			['7.0.0.dev', 'dev', ['dedalo_version', 'dev']],
			// a stable 7.0.0 is not beta — the old '7.0' sniff marked it so
			['7.0.0', 'stable', ['dedalo_version']],
		])('identity %p, release_kind %p → %p', (identity, kind, classes) => {
			expect(badgeClasses(identity, kind)).toEqual(classes);
		});

		test('the KIND decides, not the string: a kind that contradicts the identity wins', () => {
			// no '7.0' in it, yet a prerelease — the sniff left it unmarked
			expect(badgeClasses('9.1.0-rc.1', 'prerelease')).toEqual(['dedalo_version', 'beta']);
			// '7.0' in it, yet the server says stable
			expect(badgeClasses('7.0.0-beta.6', 'stable')).toEqual(['dedalo_version']);
		});

		test('an older server (no release_kind) or a foreign value marks nothing and does not throw', () => {
			for (const kind of [undefined, null, '', 'constructor', '__proto__', 'beta']) {
				expect(badgeClasses('7.0.0-beta.6', kind), String(kind)).toEqual(['dedalo_version']);
			}
		});
	});
}
