/**
 * USER JOURNEYS — the multi-step actions scripts/feature_crawl.ts replays per
 * persona. A crawl only visits; a journey ACTS (types, clicks, confirms) and
 * then checks the outcome on the SERVER, never only on the screen.
 *
 * A journey throws to fail. `writes: true` journeys run only on the suite
 * database (gate mode). A journey that belongs in this catalogue but is not
 * written yet sits in JOURNEYS_PENDING with its reason — never silently absent
 * (feature_crawl_tripwire keeps the two disjoint and every reason substantive).
 *
 * Steps drive the page as a user does (real typing, real clicks, `pierce/` into
 * dd-modal's shadow root). The client's own modules are imported in the page
 * only to READ state a user sees, or for an API call a user can also make from
 * the browser console (the refusal checks: the server must refuse, whatever
 * the UI hides).
 */

import type { BrowserContext, Page } from 'puppeteer';

export type PersonaName = 'root' | 'admin' | 'editor';

export interface JourneyContext {
	/** a fresh page, already logged in as the persona (except `anonymous` journeys) */
	page: Page;
	context: BrowserContext;
	persona: { name: PersonaName; userId: number; username: string; password: string };
	origin: string;
	url(tipo: string, mode: 'list' | 'edit', sectionId?: number): string;
	/** server side, in-process, on the suite database */
	server: {
		readValue(
			table: string,
			sectionTipo: string,
			sectionId: number,
			column: string,
			tipo: string,
		): Promise<unknown>;
		recordExists(table: string, sectionTipo: string, sectionId: number): Promise<boolean>;
		/** delete a record a journey created (suite DB only) */
		sweep(table: string, sectionTipo: string, sectionId: number): Promise<void>;
		/** arm BEFORE an action that creates records; the returned call sweeps every record created since */
		armSweep(sectionTipo: string): Promise<() => Promise<void>>;
	};
	fixture: {
		editSection: string;
		recordInA: number;
		recordInB: number;
		projectA: number;
		projectB: number;
		readonlyComponent: string;
		textComponent: string;
		filterComponent: string;
		createSection: string;
		createFilter: string;
	};
}

export interface Journey {
	personas: PersonaName[];
	writes: boolean;
	/** run in a context WITHOUT the persona's session (login journeys) */
	anonymous?: boolean;
	/** accept native confirm()/alert() — the journey confirms on purpose (crawl pages dismiss) */
	acceptDialogs?: boolean;
	/** error codes the journey provokes on purpose (not findings) */
	expectedApiErrors?: string[];
	run(ctx: JourneyContext): Promise<void>;
}

const idle = (page: Page) =>
	page.waitForNetworkIdle({ idleTime: 400, timeout: 20_000 }).catch(() => {});
const isLogged = (page: Page) =>
	page.evaluate(
		() =>
			(window as unknown as { page_globals?: { is_logged?: boolean } }).page_globals?.is_logged ===
			true,
	);

async function formLogin(page: Page, origin: string, user: string, pass: string): Promise<void> {
	await page.goto(`${origin}/dedalo/core/page/`, { waitUntil: 'networkidle0', timeout: 60_000 });
	await page.waitForSelector('#username', { visible: true, timeout: 15_000 });
	await page.type('#username', user);
	await page.click('.button_enter');
	await page.waitForSelector('#auth', { visible: true, timeout: 15_000 });
	await page.type('#auth', pass);
	await Promise.all([
		page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30_000 }).catch(() => {}),
		page.keyboard.press('Enter'),
	]);
	await idle(page);
}

/** Components build lazily as they scroll into view: scroll until `selector` exists. */
async function scrollTo(page: Page, selector: string): Promise<void> {
	for (let step = 0; step < 40; step++) {
		if (await page.$(selector)) {
			await page.$eval(selector, (el) => el.scrollIntoView({ block: 'center' }));
			return;
		}
		await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8));
		await idle(page);
	}
	throw new Error(`'${selector}' never rendered on the page`);
}

/** Click the first VISIBLE match of `selector`, searching open shadow roots too (dd-modal). */
async function clickVisibleDeep(page: Page, selector: string, timeoutMs = 15_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const clicked = await page.evaluate((sel: string) => {
			const roots: (Document | ShadowRoot)[] = [document];
			for (let i = 0; i < roots.length; i++) {
				const root = roots[i] as Document | ShadowRoot;
				for (const el of root.querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
				for (const el of root.querySelectorAll<HTMLElement>(sel)) {
					const r = el.getBoundingClientRect();
					if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') {
						el.click();
						return true;
					}
				}
			}
			return false;
		}, selector);
		if (clicked) return;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`no visible '${selector}' to click`);
}

/** In-page API call through the client's own transport (session + CSRF), as the console could. */
async function pageApi(
	page: Page,
	rqo: object,
): Promise<{ ok?: boolean; error?: { code?: string } }> {
	return await page.evaluate(async (body: object) => {
		const spec = '/dedalo/core/common/js/data_manager.js'; // the page's own module
		const { data_manager } = (await import(spec)) as {
			data_manager: {
				request: (o: object) => Promise<{ ok?: boolean; error?: { code?: string } }>;
			};
		};
		const answer = await data_manager.request({ use_worker: false, body });
		return { ok: answer?.ok, error: { code: answer?.error?.code } };
	}, rqo);
}

export const JOURNEYS: Record<string, Journey> = {
	login_form: {
		personas: ['root', 'editor'],
		writes: false,
		anonymous: true,
		expectedApiErrors: ['auth.login_failed'],
		async run({ page, origin, persona }) {
			await formLogin(page, origin, persona.username, `${persona.password}-wrong`);
			if (await isLogged(page)) throw new Error('a WRONG password logged in');
			await page.deleteCookie(...(await page.cookies()));
			await formLogin(page, origin, persona.username, persona.password);
			if (!(await isLogged(page))) throw new Error('the right password did not log in');
		},
	},

	logout_ends_session: {
		personas: ['editor'],
		writes: false,
		async run({ page, url, fixture }) {
			await page.goto(url(fixture.editSection, 'list'), {
				waitUntil: 'networkidle0',
				timeout: 60_000,
			});
			await page.waitForSelector('.quit.top_item', { visible: true, timeout: 15_000 });
			await Promise.all([
				page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30_000 }).catch(() => {}),
				page.click('.quit.top_item'),
			]);
			await idle(page);
			await page.goto(url(fixture.editSection, 'edit', fixture.recordInA), {
				waitUntil: 'networkidle0',
				timeout: 60_000,
			});
			if (await isLogged(page)) throw new Error('still logged in after logout');
		},
	},

	edit_save_reload: {
		personas: ['root', 'editor'],
		writes: true,
		async run({ page, url, fixture, server }) {
			const value = `zzcrawl ${Date.now()}`;
			const input = `.wrapper_component.${fixture.textComponent}.edit input`;
			await page.goto(url(fixture.editSection, 'edit', fixture.recordInA), {
				waitUntil: 'networkidle0',
				timeout: 60_000,
			});
			await scrollTo(page, input);
			await page.click(input, { count: 3 });
			await page.keyboard.press('Backspace');
			await page.type(input, value);
			await page.keyboard.press('Tab'); // blur → save
			await idle(page);
			const stored = JSON.stringify(
				await server.readValue(
					'matrix_test',
					fixture.editSection,
					fixture.recordInA,
					'string',
					fixture.textComponent,
				),
			);
			if (!stored.includes(value))
				throw new Error(`typed value not persisted (server holds ${stored.slice(0, 120)})`);
			await page.reload({ waitUntil: 'networkidle0' });
			await scrollTo(page, input);
			const shown = await page.$eval(input, (el) => (el as HTMLInputElement).value);
			if (shown !== value) throw new Error(`after reload the input shows '${shown}'`);
		},
	},

	readonly_save_refused: {
		personas: ['editor'],
		writes: true,
		expectedApiErrors: ['perm.denied'],
		async run({ page, url, fixture, server }) {
			await page.goto(url(fixture.editSection, 'edit', fixture.recordInA), {
				waitUntil: 'networkidle0',
				timeout: 60_000,
			});
			const before = JSON.stringify(
				await server.readValue(
					'matrix_test',
					fixture.editSection,
					fixture.recordInA,
					'string',
					fixture.readonlyComponent,
				),
			);
			const answer = await pageApi(page, {
				action: 'save',
				source: {
					tipo: fixture.readonlyComponent,
					section_tipo: fixture.editSection,
					section_id: fixture.recordInA,
					model: 'component_text_area',
					lang: 'lg-eng',
				},
				data: { changed_data: [{ action: 'update', key: 0, value: 'zzcrawl forbidden write' }] },
			});
			if (answer.ok !== false) throw new Error('a level-1 component accepted a save');
			const after = JSON.stringify(
				await server.readValue(
					'matrix_test',
					fixture.editSection,
					fixture.recordInA,
					'string',
					fixture.readonlyComponent,
				),
			);
			if (after !== before) throw new Error('the refused save changed the stored value');
		},
	},

	create_record_in_own_project: {
		personas: ['editor'],
		writes: true,
		acceptDialogs: true,
		async run({ page, url, fixture, server }) {
			const sweepCreated = await server.armSweep(fixture.createSection);
			try {
				await page.goto(url(fixture.createSection, 'list'), {
					waitUntil: 'networkidle0',
					timeout: 60_000,
				});
				// the list keeps its action buttons behind a "Show buttons" toggle
				if (
					!(await page.$('button.warning.new:not([hidden])')) ||
					!(await page
						.$eval('button.warning.new', (b) => (b as HTMLElement).offsetParent !== null)
						.catch(() => false))
				)
					await page.click('.show_other_buttons_button');
				await page.waitForSelector('button.warning.new', { visible: true, timeout: 20_000 });
				await page.click('button.warning.new');
				// "Are you sure?" — data-role is the dialog's stable hook (ui.js confirm)
				await clickVisibleDeep(page, 'button[data-role="accept"]');
				let id: number | null = null;
				for (let tries = 0; tries < 40 && !id; tries++) {
					await idle(page);
					id = await page
						.evaluate(async (section: string) => {
							const spec = '/dedalo/core/common/js/instances.js'; // the page's own module, not a repo path
							const { get_all_instances } = (await import(spec)) as {
								get_all_instances: () => unknown[];
							};
							// biome-ignore lint/suspicious/noExplicitAny: live client instances
							const s = (get_all_instances() as any[]).find(
								(i) => i.model === 'section' && i.mode === 'edit' && i.section_tipo === section,
							);
							return s && Number(s.section_id) > 0 ? Number(s.section_id) : null;
						}, fixture.createSection)
						.catch(() => null); // the page may be mid-navigation
				}
				if (!id) throw new Error('the new button did not open a new record in edit mode');
				try {
					const filter = JSON.stringify(
						await server.readValue(
							'matrix_test',
							fixture.createSection,
							id,
							'relation',
							fixture.createFilter,
						),
					);
					if (
						!filter.includes(`"section_id":${fixture.projectA}`) &&
						!filter.includes(`"section_id":"${fixture.projectA}"`)
					)
						throw new Error(
							`new record ${id} not assigned to the editor's project (filter: ${filter.slice(0, 160)})`,
						);
					// the editor must be able to delete what they created: inspector → remove → confirm
					await page.click('.inspector .button.block_icon.light.remove');
					// the record-delete dialog ("Delete record"), inside dd-modal
					await clickVisibleDeep(page, 'button.danger.remove');
					for (let tries = 0; tries < 30; tries++) {
						if (!(await server.recordExists('matrix_test', fixture.createSection, id))) break;
						await new Promise((r) => setTimeout(r, 500));
					}
					if (await server.recordExists('matrix_test', fixture.createSection, id))
						throw new Error(`record ${id} still exists after delete was confirmed`);
				} finally {
					await server.sweep('matrix_test', fixture.createSection, id);
				}
			} finally {
				await sweepCreated();
			}
		},
	},

	// TOOL OPERATION as the persona: the export a user downloads must hold
	// exactly the records that user may see (the project filter, end to end)
	tool_export_csv_respects_projects: {
		personas: ['root', 'editor'],
		writes: false,
		async run({ page, url, fixture, persona }) {
			const recordInB = fixture.recordInB;
			await page.goto(url(fixture.editSection, 'list'), {
				waitUntil: 'networkidle0',
				timeout: 60_000,
			});
			const opened = await page.evaluate(async () => {
				const spec = '/dedalo/core/common/js/instances.js'; // the page's own module
				const { get_all_instances } = (await import(spec)) as {
					get_all_instances: () => unknown[];
				};
				const toolSpec = '/dedalo/core/tools_common/js/tool_common.js';
				const { open_tool } = (await import(toolSpec)) as {
					open_tool: (o: object) => Promise<unknown>;
				};
				// biome-ignore lint/suspicious/noExplicitAny: live client instances
				const section = (get_all_instances() as any[]).find(
					(i) =>
						i.model === 'section' &&
						i.mode === 'list' &&
						(i.context?.tools ?? []).some((t: { name: string }) => t.name === 'tool_export'),
				);
				if (!section) return 'the list section offers no tool_export';
				void open_tool({
					tool_context: section.context.tools.find(
						(t: { name: string }) => t.name === 'tool_export',
					),
					caller: section,
				});
				return 'ok';
			});
			if (opened !== 'ok') throw new Error(opened);
			// tool_export opens as a window (register.json open_as)
			const target = await page
				.browserContext()
				.waitForTarget((t) => t.opener() === page.target(), { timeout: 20_000 })
				.catch(() => null);
			const toolPage = (await target?.page()) ?? page;
			await toolPage.waitForSelector('.wrapper_tool.tool_export', { timeout: 30_000 });
			await toolPage.evaluate(() => {
				// capture the file link in the tool's own window
				const w = window as unknown as { __crawl_downloads: string[] };
				w.__crawl_downloads = [];
				document.addEventListener(
					'click',
					(e) => {
						const a = (e.target as Element)?.closest?.('a[download]') as HTMLAnchorElement | null;
						if (a) {
							w.__crawl_downloads.push(a.href);
							e.preventDefault();
						}
					},
					true,
				);
			});
			const built = await toolPage.evaluate(async () => {
				const spec = '/dedalo/core/common/js/instances.js';
				const { get_all_instances } = (await import(spec)) as {
					get_all_instances: () => unknown[];
				};
				const wait = async (ok: () => boolean, what: string, ms = 60_000) => {
					const start = Date.now();
					while (!ok()) {
						if (Date.now() - start > ms) throw new Error(`timed out: ${what}`);
						await new Promise((r) => setTimeout(r, 250));
					}
				};
				// biome-ignore lint/suspicious/noExplicitAny: live tool instance
				let tool: any;
				await wait(() => {
					// biome-ignore lint/suspicious/noExplicitAny: live client instances
					tool = (get_all_instances() as any[]).find(
						(i) => i.model === 'tool_export' && i.export_ui?.button_export,
					);
					return !!tool;
				}, 'tool_export UI');
				// the column pick is drag-and-drop; set the selection its drop handler
				// builds (the Id column), as the test:client export suite does
				const lang = (window as unknown as { page_globals: { dedalo_data_lang: string } })
					.page_globals.dedalo_data_lang;
				const section = tool.caller?.section_tipo ?? 'test3';
				tool.data_format = 'value';
				tool.breakdown = 'default';
				tool.ar_ddo_to_export = [
					{
						id: `${section}_test102_list_${lang}`,
						tipo: 'test102',
						section_tipo: section,
						model: 'component_section_id',
						parent: section,
						lang,
						mode: 'list',
						label: 'test102',
						value_with_parents: false,
						path: [
							{
								section_tipo: section,
								component_tipo: 'test102',
								model: 'component_section_id',
								name: 'test102',
							},
						],
					},
				];
				tool.export_ui.button_export.click();
				const csv = () => tool.export_ui.download_buttons.get('csv') as HTMLButtonElement;
				await wait(() => !!csv() && !csv().disabled, 'export finished (csv button enabled)');
				const w = window as unknown as { __crawl_downloads: string[] };
				csv().click();
				await wait(
					() =>
						w.__crawl_downloads.length > 0 ||
						tool.export_ui.download_status?.classList.contains('error'),
					'csv built',
				);
				const href = w.__crawl_downloads[0];
				if (!href)
					return { error: `csv not built: ${tool.export_ui.download_status?.textContent ?? ''}` };
				const res = await fetch(href, { credentials: 'same-origin' });
				return { status: res.status, text: await res.text() };
			});
			if ('error' in built) throw new Error(built.error as string);
			if (built.status !== 200) throw new Error(`csv download answered ${built.status}`);
			const fields = new Set(
				built.text.split(/[\n;,\t]/).map((f) => f.replace(/^﻿?"|"$/g, '').trim()),
			);
			if (!fields.has(String(fixture.recordInA)))
				throw new Error(`csv lacks own-project record ${fixture.recordInA}`);
			const hasB = fields.has(String(recordInB));
			if (persona.name === 'editor' && hasB)
				throw new Error(`csv leaks other-project record ${recordInB}`);
			if (persona.name === 'root' && !hasB) throw new Error(`root csv lacks record ${recordInB}`);
		},
	},

	filter_offers_own_projects_only: {
		personas: ['editor'],
		writes: false,
		async run({ page, url, fixture }) {
			await page.goto(url(fixture.editSection, 'edit', fixture.recordInA), {
				waitUntil: 'networkidle0',
				timeout: 60_000,
			});
			const offered = await page.evaluate(async (tipo: string) => {
				const spec = '/dedalo/core/common/js/instances.js'; // the page's own module, not a repo path
				const { get_all_instances } = (await import(spec)) as {
					get_all_instances: () => unknown[];
				};
				// biome-ignore lint/suspicious/noExplicitAny: live client instances
				const f = (get_all_instances() as any[]).find((i) => i.tipo === tipo && i.mode === 'edit');
				if (!f) return null;
				// biome-ignore lint/suspicious/noExplicitAny: datalist entries
				return ((f.data?.datalist ?? []) as any[]).map((d) =>
					Number(d.value?.section_id ?? d.section_id),
				);
			}, fixture.filterComponent);
			if (offered === null) throw new Error('no component_filter instance on the edit page');
			if (offered.includes(fixture.projectB))
				throw new Error(`the editor is offered project ${fixture.projectB} they do not belong to`);
			if (!offered.includes(fixture.projectA))
				throw new Error(
					`own project ${fixture.projectA} not offered (offered: ${offered.join(',')})`,
				);
		},
	},
};

/** Catalogued journeys not written yet — each a coverage gap, stated. */
export const JOURNEYS_PENDING: Record<string, string> = {
	session_expiry_relogin: 'needs a server-side session TTL seam to expire a session mid-page',
	two_tabs_logout: 'logout in one tab, the other must refuse on its next request',
	change_own_password: 'tool_user_admin password change, then form login with the new one',
	switch_application_and_data_lang: 'labels change, untranslated values stay italic',
	search_filter_per_model: 'one search per component model through the filter panel operators',
	search_preset_save_reuse: 'save a search preset and re-apply it',
	sort_and_paginate: 'sort by each list column; first/next/last/jump; edit-mode prev/next',
	thesaurus_search_expands: 'tree search must expand the ancestors of the hits',
	duplicate_record: 'duplicate from the inspector; the copy keeps the project',
	recover_deleted_record: 'tool_time_machine recovers a deleted record',
	restore_component_value: 'tool_time_machine restores an earlier value of one component',
	autocomplete_link_unlink: 'type, pick, save; then remove the link',
	portal_new_linked_record: 'create a linked record from inside a portal',
	portal_reorder: 'drag (or phone up/down) reorder of portal rows persists',
	dataframe_edit: 'edit a dataframe frame paired to its main item',
	thesaurus_add_move_reorder: 'add a child, move a node, reorder siblings',
	media_upload_view_download:
		'tool_upload image/av/pdf, thumbnail, viewer, download; out-of-project media 404',
	unsaved_changes_warning: 'leaving with unsaved data prompts (window.unsaved_data + beforeunload)',
	concurrent_edit: 'two personas edit one record; the conflict is noticed and no update is lost',
	admin_grant_propagates:
		"admin grants/revokes through component_security_access; the editor's next request reflects it",
	activity_and_tm_attribution:
		"the run's own actions appear in Activity and Time Machine under the right user",
	diffusion_publish:
		'tool_diffusion publishes a scratch record to the suite MariaDB; its media becomes reachable',
	keyboard_only_navigation: 'tab order reaches the main actions of list and edit pages',
	server_down_mid_session: 'stopping the server mid-page shows an error panel, not a blank page',
};
