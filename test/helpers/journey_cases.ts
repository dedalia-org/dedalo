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
		/** a read-only query on the suite database (journeys check what was RECORDED) */
		select(query: string, params: unknown[]): Promise<Record<string, unknown>[]>;
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
		editorUsername: string;
		editorProfile: number;
		deniedSection: string;
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

/**
 * In-page API call through the client's own transport, answering the response's
 * DATA (envelope v2 `response_data`); a refusal throws with its code. Setup a user
 * could also do from the browser console.
 */
async function pageApiData(page: Page, rqo: object): Promise<unknown> {
	return await page.evaluate(async (body: { action?: string }) => {
		const transport = '/dedalo/core/common/js/data_manager.js'; // the page's own modules
		const errors = '/dedalo/core/common/js/api_error.js';
		const { data_manager } = (await import(transport)) as {
			data_manager: { request: (o: object) => Promise<unknown> };
		};
		const { request_failed, response_data } = (await import(errors)) as {
			request_failed: (a: unknown) => boolean;
			response_data: (a: unknown) => unknown;
		};
		const answer = await data_manager.request({ use_worker: false, body });
		if (request_failed(answer))
			throw new Error(
				`${body.action} refused: ${(answer as { error?: { code?: string } })?.error?.code}`,
			);
		return response_data(answer);
	}, rqo);
}

/** The test TLD's self-portal (test3 → test3, default view, list column test52). */
const REORDER_PORTAL = 'test80';
/** A row's drop / tap point: its test52 cell (text, no control; a phone card row has no box of its own). */
const REORDER_CELL = '.wrapper_component.test52';

/** Create one record of `sectionTipo` through the create door; its section_id. */
async function pageCreate(page: Page, sectionTipo: string): Promise<number> {
	const id = Number(
		await pageApiData(page, {
			action: 'create',
			source: {
				typo: 'source',
				type: 'section',
				model: 'section',
				tipo: sectionTipo,
				section_tipo: sectionTipo,
				section_id: null,
				mode: 'edit',
				lang: 'lg-eng',
			},
		}),
	);
	if (!Number.isInteger(id) || id < 1)
		throw new Error(`create returned no section_id for ${sectionTipo}`);
	return id;
}

/**
 * Centre of the `index`-th row's element (`part`: '' = the row itself, or a selector
 * inside it), in the CURRENT scroll position (never scrolls: two points read for one
 * gesture must share it — scroll first with `scrollRowsIntoView`).
 */
async function rowPoint(
	page: Page,
	portal: string,
	index: number,
	part: string,
): Promise<{ x: number; y: number }> {
	const point = await page.evaluate(
		(selector: string, i: number, inner: string) => {
			const rows = document.querySelectorAll(selector);
			const row = rows[i] as HTMLElement | undefined;
			const el = (inner ? row?.querySelector(inner) : row) as HTMLElement | null | undefined;
			if (!el) return 'missing';
			const r = el.getBoundingClientRect();
			if (r.bottom <= 0 || r.top >= innerHeight || r.width === 0 || r.height === 0)
				return `off screen (top ${Math.round(r.top)}, height ${Math.round(r.height)}, viewport ${innerHeight})`;
			return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
		},
		`${portal} > .list_body > .content_data > .section_record`,
		index,
		part,
	);
	if (typeof point === 'string')
		throw new Error(`row ${index}${part ? ` ${part}` : ''} of the portal: ${point}`);
	return point;
}

/**
 * Bring the portal's first rows to the middle of the viewport (before reading row
 * points), then wait until the row has SETTLED — its top is the same two frames apart
 * (a smooth scroll or a late layout still moving it would hand rowPoint a stale point).
 */
async function scrollRowsIntoView(page: Page, portal: string): Promise<void> {
	const selector = `${portal} > .list_body > .content_data > .section_record:nth-child(2)`;
	await page.$eval(selector, (el) => el.scrollIntoView({ block: 'center' }));
	await page.waitForFunction(
		(sel: string) =>
			new Promise<boolean>((resolve) => {
				const el = document.querySelector(sel);
				if (!el) {
					resolve(false);
					return;
				}
				const top = el.getBoundingClientRect().top;
				requestAnimationFrame(() =>
					requestAnimationFrame(() => resolve(el.getBoundingClientRect().top === top)),
				);
			}),
		{ timeout: 10_000 },
		selector,
	);
}

/** Open record A and type `value` into its text component, NOT blurred (no save yet). */
async function typeIntoText(
	page: Page,
	url: JourneyContext['url'],
	fixture: JourneyContext['fixture'],
	value: string,
): Promise<string> {
	const input = `.wrapper_component.${fixture.textComponent}.edit input`;
	await page.goto(url(fixture.editSection, 'edit', fixture.recordInA), {
		waitUntil: 'networkidle0',
		timeout: 60_000,
	});
	await scrollTo(page, input);
	await page.click(input, { count: 3 });
	await page.keyboard.press('Backspace');
	await page.type(input, value);
	return input;
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
			const input = await typeIntoText(page, url, fixture, value);
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

	// The grant is the profile's component_security_access value, saved the way the
	// widget saves it (set_data, the whole array). A permission cache that survives the
	// write lets the editor in after the revoke — the bug this journey exists for.
	admin_grant_propagates: {
		personas: ['root'],
		writes: true,
		async run({ page, context, persona, origin, fixture, server }) {
			const section = fixture.deniedSection;
			const original = (await server.readValue(
				'matrix_profiles',
				'dd234',
				fixture.editorProfile,
				'misc',
				'dd774',
			)) as { tipo: string; section_tipo: string; value: number }[] | null;
			if (!Array.isArray(original) || original.length === 0)
				throw new Error('the editor profile carries no grants (fixture missing)');
			const saveGrants = async (value: object[]) => {
				const answer = await pageApi(page, {
					action: 'save',
					source: {
						tipo: 'dd774',
						section_tipo: 'dd234',
						section_id: fixture.editorProfile,
						model: 'component_security_access',
						lang: 'lg-nolan',
					},
					data: { changed_data: [{ action: 'set_data', value }] },
				});
				if (answer.ok !== true) throw new Error(`root's grant save refused: ${answer.error?.code}`);
			};
			await page.goto(`${origin}/dedalo/core/page/`, {
				waitUntil: 'networkidle0',
				timeout: 60_000,
			});
			const editorContext = await context.browser().createBrowserContext();
			try {
				const editor = await editorContext.newPage();
				await formLogin(editor, origin, fixture.editorUsername, persona.password);
				if (!(await isLogged(editor))) throw new Error('the editor could not log in');
				const editorOpens = async () =>
					(
						await pageApi(editor, {
							action: 'start',
							dd_api: 'dd_core_api',
							options: { search_obj: { t: section, m: 'list' }, menu: false },
						})
					).ok === true;
				if (await editorOpens()) throw new Error(`the editor opens ${section} before any grant`);
				await saveGrants([...original, { tipo: section, section_tipo: section, value: 2 }]);
				try {
					if (!(await editorOpens()))
						throw new Error(`the editor is still refused ${section} after the grant`);
				} finally {
					await saveGrants(original);
				}
				if (await editorOpens())
					throw new Error(`the editor still opens ${section} after the revoke (stale permissions)`);
			} finally {
				await editorContext.close();
			}
		},
	},

	two_tabs_logout: {
		personas: ['editor'],
		writes: false,
		async run({ page, context, url, fixture }) {
			const other = await context.newPage();
			try {
				for (const tab of [page, other])
					await tab.goto(url(fixture.editSection, 'list'), {
						waitUntil: 'networkidle0',
						timeout: 60_000,
					});
				await page.bringToFront(); // a background tab paints nothing visible
				await page.waitForSelector('.quit.top_item', { visible: true, timeout: 15_000 });
				await Promise.all([
					page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30_000 }).catch(() => {}),
					page.click('.quit.top_item'),
				]);
				await idle(page);
				// the other tab still shows the list; its next request must be refused
				const answer = await pageApi(other, {
					action: 'read',
					source: {
						tipo: fixture.editSection,
						section_tipo: fixture.editSection,
						model: 'section',
						mode: 'list',
					},
					sqo: { section_tipo: [fixture.editSection], limit: 1 },
				});
				if (answer.ok === true)
					throw new Error('the second tab still reads data after logout in the first');
			} finally {
				await other.close();
			}
		},
	},

	activity_and_tm_attribution: {
		personas: ['editor'],
		writes: true,
		async run({ page, url, fixture, server, persona }) {
			const maxId = async (table: string) =>
				Number(
					(await server.select(`SELECT coalesce(max(id), 0) AS max FROM ${table}`, []))[0]?.max,
				);
			const before = await maxId('matrix_time_machine');
			const activityBefore = await maxId('matrix_activity');
			await typeIntoText(page, url, fixture, `zzcrawl attribution ${Date.now()}`);
			await page.keyboard.press('Tab'); // blur → save
			await idle(page);
			const tm = await server.select(
				'SELECT user_id FROM matrix_time_machine WHERE id > $1 AND section_tipo = $2 AND section_id = $3 AND tipo = $4',
				[before, fixture.editSection, fixture.recordInA, fixture.textComponent],
			);
			if (tm.length === 0) throw new Error('the save left no Time Machine row');
			const wrong = tm.filter((row) => String(row.user_id) !== String(persona.userId));
			if (wrong.length > 0)
				throw new Error(`Time Machine credits user ${wrong[0]?.user_id}, not ${persona.userId}`);
			const activity = await server.select(
				"SELECT relation->'dd543'->0->>'section_id' AS user_id FROM matrix_activity WHERE id > $1 AND (string->'dd546'->0->>'value' = $2 OR string->'dd546'->0->>'value' = $3)",
				[activityBefore, fixture.textComponent, fixture.editSection],
			);
			if (activity.length === 0) throw new Error('the save left no Activity row');
			if (!activity.some((row) => String(row.user_id) === String(persona.userId)))
				throw new Error(`no Activity row credits user ${persona.userId}`);
		},
	},

	// beforeunload prompts only while an edit is unsaved: a clean page leaves silently
	// Leaving with an unsaved edit must never LOSE it: the page either warns (its
	// beforeunload handler asks) or commits the edit on the way out. The tab is really
	// closed (beforeunload run), then the server is read — headless Chrome does not draw
	// the native prompt, so the handler's verdict is collected in the page.
	unsaved_changes_warning: {
		personas: ['editor'],
		writes: true,
		async run({ context, url, fixture, server }) {
			const leave = async (typed: string | null): Promise<{ asked: boolean; stored: string }> => {
				const tab = await context.newPage();
				let asked = false;
				tab.on('dialog', (dialog) => {
					if (dialog.type() === 'beforeunload') asked = true;
					void dialog.accept().catch(() => {});
				});
				await tab.exposeFunction('__zzcrawlAsked', () => {
					asked = true;
				});
				await tab.evaluateOnNewDocument(() => {
					window.addEventListener('beforeunload', (event) => {
						if (event.defaultPrevented || event.returnValue)
							(window as unknown as { __zzcrawlAsked: () => void }).__zzcrawlAsked();
					});
				});
				if (typed !== null) await typeIntoText(tab, url, fixture, typed);
				else
					await tab.goto(url(fixture.editSection, 'edit', fixture.recordInA), {
						waitUntil: 'networkidle0',
						timeout: 60_000,
					});
				const closed = new Promise<void>((resolve) => tab.once('close', () => resolve()));
				await tab.close({ runBeforeUnload: true });
				await Promise.race([closed, new Promise((r) => setTimeout(r, 10_000))]);
				await new Promise((r) => setTimeout(r, 2_000)); // an in-flight save lands or dies
				const stored = JSON.stringify(
					await server.readValue(
						'matrix_test',
						fixture.editSection,
						fixture.recordInA,
						'string',
						fixture.textComponent,
					),
				);
				return { asked, stored };
			};
			if ((await leave(null)).asked)
				throw new Error('leaving a page with no edit warned about unsaved data');
			const value = `zzcrawl unsaved ${Date.now()}`;
			const { asked, stored } = await leave(value);
			if (!asked && !stored.includes(value))
				throw new Error(
					'closing the tab with a typed, unsaved value neither warned nor saved it (lost)',
				);
		},
	},

	// Two typed saves, then the Time Machine restores the FIRST: the request is the one
	// tool_time_machine's "Apply and save" button sends (apply_value, its matrix_id).
	restore_component_value: {
		personas: ['root'], // the editor holds no tool_time_machine grant,
		writes: true,
		async run({ page, url, fixture, server }) {
			const stamp = Date.now();
			const first = `zzcrawl restore A ${stamp}`;
			const second = `zzcrawl restore B ${stamp}`;
			for (const value of [first, second]) {
				await typeIntoText(page, url, fixture, value);
				await page.keyboard.press('Tab'); // blur → save
				await idle(page);
			}
			const read = async () =>
				JSON.stringify(
					await server.readValue(
						'matrix_test',
						fixture.editSection,
						fixture.recordInA,
						'string',
						fixture.textComponent,
					),
				);
			if (!(await read()).includes(second)) throw new Error('the second save did not land');
			const rows = await server.select(
				'SELECT id, lang FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 AND data::text LIKE $4 ORDER BY id DESC LIMIT 1',
				[fixture.editSection, fixture.recordInA, fixture.textComponent, `%${first}%`],
			);
			const row = rows[0];
			if (row === undefined) throw new Error('the first save left no Time Machine row to restore');
			const answer = await pageApi(page, {
				dd_api: 'dd_tools_api',
				action: 'tool_request',
				source: {
					action: 'apply_value',
					model: 'tool_time_machine',
					tipo: fixture.textComponent,
					section_tipo: fixture.editSection,
					section_id: fixture.recordInA,
				},
				options: {
					section_id: fixture.recordInA,
					section_tipo: fixture.editSection,
					tipo: fixture.textComponent,
					lang: row.lang,
					matrix_id: row.id,
				},
			});
			if (answer.ok !== true) throw new Error(`apply_value refused: ${answer.error?.code}`);
			const after = await read();
			if (!after.includes(first) || after.includes(second))
				throw new Error(`after the restore the server holds ${after.slice(0, 160)}`);
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

	// root's username link was inert until 2026-11-02 — root had no way into its own
	// account panel (password, UI preferences) although the server allowed both.
	// Every field must render (an empty-context read draws an error panel, not a
	// wrapper) at the level the panel promises: name and email editable, the
	// identity fields read-only, and for root the image (media ids need a positive
	// section_id) and the password (no re-authenticated change yet) read-only
	root_opens_own_account_panel: {
		personas: ['root'],
		writes: false,
		async run({ page, url, fixture }) {
			await page.goto(url(fixture.editSection, 'list'), {
				waitUntil: 'networkidle0',
				timeout: 60_000,
			});
			await page.waitForSelector('.logged_user_name.top_item', { visible: true, timeout: 15_000 });
			await page.click('.logged_user_name.top_item');
			await page.waitForSelector('.active_style_switcher', { timeout: 20_000 });
			await idle(page);
			const panel = await page.evaluate(async () => {
				const columns = [...document.querySelectorAll('.components_container > .component_column')];
				const rendered = columns.filter((c) =>
					c.querySelector(':scope > .wrapper_component'),
				).length;
				const errors = document.querySelectorAll('.components_container .api_error_panel').length;
				const spec = '/dedalo/core/common/js/instances.js'; // the page's own module, not a repo path
				const { get_all_instances } = (await import(spec)) as {
					get_all_instances: () => unknown[];
				};
				const levels: Record<string, number> = {};
				// biome-ignore lint/suspicious/noExplicitAny: live client instances
				for (const i of get_all_instances() as any[])
					if (i.caller?.model === 'tool_user_admin' && i.section_tipo === 'dd128')
						levels[i.tipo] = i.permissions;
				const styles = document.querySelectorAll(
					'.active_style_switcher input[name="active_style"]',
				).length;
				return { columns: columns.length, rendered, errors, levels, styles };
			});
			if (panel.columns === 0 || panel.rendered !== panel.columns || panel.errors > 0)
				throw new Error(
					`${panel.rendered}/${panel.columns} fields rendered, ${panel.errors} error panels`,
				);
			const want: Record<string, (n: number) => boolean> = {
				dd452: (n) => n >= 2, // full name
				dd133: (n) => n === 1, // password (root)
				dd134: (n) => n >= 2, // email
				dd132: (n) => n === 1, // username
				dd1725: (n) => n === 1, // profile
				dd522: (n) => n === 1, // image (root)
			};
			for (const [tipo, ok] of Object.entries(want))
				if (!ok(panel.levels[tipo] ?? -1))
					throw new Error(`${tipo} level ${panel.levels[tipo]} (${JSON.stringify(panel.levels)})`);
			if (panel.styles < 2) throw new Error(`active style switcher offers ${panel.styles} styles`);
		},
	},

	// portal_reorder: the row box's portal drag (WC-2026-10-30-section-record-row-box)
	// as a user does it, on BUILT records: a host test3 record with three linked
	// test3 records in the self-portal test80 (default view). Desktop: a native drag
	// of row 1's handle onto row 0 (Chrome's own drag, intercepted and replayed by
	// CDP — the real dragstart / dragover / drop of the page). Phone (360px, touch
	// emulation, `pointer: coarse`): tap row 2's handle, tap row 0 (touch_pick).
	// Each move is checked in the STORED array, not on screen.
	portal_reorder: {
		personas: ['root'],
		writes: true,
		async run({ page, url, fixture, server }) {
			const section = fixture.editSection; // test3
			const portal = `.wrapper_component.component_portal.${REORDER_PORTAL}.edit`;
			const sweep = await server.armSweep(section);
			try {
				await page.goto(url(section, 'list'), { waitUntil: 'networkidle0', timeout: 60_000 });
				const host = await pageCreate(page, section);
				const linked: number[] = [];
				for (let i = 0; i < 3; i++) linked.push(await pageCreate(page, section));
				await pageApiData(page, {
					action: 'save',
					source: {
						tipo: REORDER_PORTAL,
						section_tipo: section,
						section_id: host,
						model: 'component_portal',
						lang: 'lg-nolan',
						mode: 'edit',
					},
					data: {
						changed_data: [
							{
								action: 'set_data',
								value: linked.map((id) => ({
									type: 'dd151',
									section_tipo: section,
									section_id: String(id),
									from_component_tipo: REORDER_PORTAL,
								})),
							},
						],
					},
				});
				const stored = async (): Promise<number[]> => {
					const value = (await server.readValue(
						'matrix_test',
						section,
						host,
						'relation',
						REORDER_PORTAL,
					)) as { section_id: string | number }[] | null;
					return (value ?? []).map((locator) => Number(locator.section_id));
				};
				// polled to a deadline: `idle` swallows a network-idle timeout, so a save that
				// starts late or runs long must not read as a wrong stored order
				const expectStored = async (expected: number[], what: string) => {
					const deadline = Date.now() + 10_000;
					let now = await stored();
					while (JSON.stringify(now) !== JSON.stringify(expected) && Date.now() < deadline) {
						await new Promise((resolve) => setTimeout(resolve, 100));
						now = await stored();
					}
					if (JSON.stringify(now) !== JSON.stringify(expected))
						throw new Error(
							`${what}: stored ${now.join(',')}, expected ${expected.join(',')} (after 10 s)`,
						);
				};
				await expectStored(linked, 'the linked set');
				const [a, b, c] = linked as [number, number, number];

				// desktop: native drag of row 1's handle onto row 0
				await page.goto(url(section, 'edit', host), { waitUntil: 'networkidle0', timeout: 60_000 });
				await scrollTo(page, `${portal} .section_record .drag`);
				await scrollRowsIntoView(page, portal);
				await page.setDragInterception(true);
				try {
					const from = await rowPoint(page, portal, 1, '.drag');
					const to = await rowPoint(page, portal, 0, REORDER_CELL);
					await page.mouse.move(from.x, from.y);
					await page.mouse.dragAndDrop(from, to);
				} finally {
					await page.setDragInterception(false);
				}
				await idle(page);
				await expectStored([b, a, c], 'after the desktop drag');

				// phone: tap the handle of row 2, then tap row 0
				await page.setViewport({ width: 360, height: 740, isMobile: true, hasTouch: true });
				await page.goto(url(section, 'edit', host), { waitUntil: 'networkidle0', timeout: 60_000 });
				const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
				if (!coarse) throw new Error('touch emulation did not make the pointer coarse');
				await scrollTo(page, `${portal} .section_record .drag`);
				await scrollRowsIntoView(page, portal);
				const handle = await rowPoint(page, portal, 2, '.drag');
				await page.touchscreen.tap(handle.x, handle.y);
				await page.waitForSelector('.touch_pick_bar', { timeout: 10_000 });
				await scrollRowsIntoView(page, portal);
				const place = await rowPoint(page, portal, 0, REORDER_CELL);
				await page.touchscreen.tap(place.x, place.y);
				await idle(page);
				await expectStored([c, b, a], 'after the phone tap-tap');
			} finally {
				await sweep();
			}
		},
	},
};

/** Catalogued journeys not written yet — each a coverage gap, stated. */
export const JOURNEYS_PENDING: Record<string, string> = {
	session_expiry_relogin: 'needs a server-side session TTL seam to expire a session mid-page',
	change_own_password: 'tool_user_admin password change, then form login with the new one',
	switch_application_and_data_lang: 'labels change, untranslated values stay italic',
	search_filter_per_model: 'one search per component model through the filter panel operators',
	search_preset_save_reuse: 'save a search preset and re-apply it',
	sort_and_paginate: 'sort by each list column; first/next/last/jump; edit-mode prev/next',
	thesaurus_search_expands: 'tree search must expand the ancestors of the hits',
	duplicate_record: 'duplicate from the inspector; the copy keeps the project',
	recover_deleted_record: 'tool_time_machine recovers a deleted record',
	autocomplete_link_unlink: 'type, pick, save; then remove the link',
	portal_new_linked_record: 'create a linked record from inside a portal',
	dataframe_edit: 'edit a dataframe frame paired to its main item',
	thesaurus_add_move_reorder: 'add a child, move a node, reorder siblings',
	media_upload_view_download:
		'tool_upload image/av/pdf, thumbnail, viewer, download; out-of-project media 404',
	concurrent_edit: 'two personas edit one record; the conflict is noticed and no update is lost',
	diffusion_publish:
		'tool_diffusion publishes a scratch record to the suite MariaDB; its media becomes reachable',
	keyboard_only_navigation: 'tab order reaches the main actions of list and edit pages',
	server_down_mid_session: 'stopping the server mid-page shows an error panel, not a blank page',
};
