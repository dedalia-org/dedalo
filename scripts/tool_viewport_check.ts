/**
 * TOOL VIEWPORT CHECK — every probed tool, rendered on a phone, judged.
 *
 * `bun run test:tools:phone [--port <n>] [--shots <dir>] [--headful]`
 *
 * The browser half of test/unit/tool_phone_tripwire.test.ts. Starts its OWN
 * server on the SUITE database (the same verified door as test:client), logs in
 * for real, then opens each tool that has a probe in
 * test/helpers/tool_phone_ratchet.ts the way a user does (the caller's record
 * page, then `open_tool` on the live instance — a modal renders in place, a
 * window tool's popup is followed) at PHONE_VIEWPORT with touch emulation, and judges the contract of
 * tools_common/css/tool_responsive.less:
 *
 *   - no page-level horizontal scroll (scrollWidth ≤ innerWidth),
 *   - every visible, enabled control lies inside the viewport horizontally and
 *     is ≥ PHONE_HIT_TARGET_PX on its shortest side,
 *   - no console error / page error.
 *
 * Verdicts, shrink-only: a PHONE_CASES tool that fails is red; a NOT_YET_PHONE
 * tool whose probe PASSES is red too (move it across). A pending tool that
 * fails is expected and reported. `--shots` writes one PNG per tool.
 *
 * Needs `bun run test:db:setup` once (the suite database).
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type Page } from 'puppeteer';
import { readEnv } from '../src/config/env.ts';
import { compareLocators, type Locator } from '../src/core/concepts/locator.ts';
import { acquireSuiteRunLock } from '../test/helpers/suite_run_lock.ts';
import {
	NOT_YET_PHONE,
	PHONE_CASES,
	PHONE_HIT_TARGET_PX,
	PHONE_VIEWPORT,
	type ToolPhoneProbe,
} from '../test/helpers/tool_phone_ratchet.ts';
import {
	findFreePort,
	localSuiteFingerprint,
	repointProcessToSuiteDatabase,
	resolveSuiteDatabase,
	startClientTestServer,
} from './client_test_server.ts';
import { guardDialogs, onConsoleError, onPageError } from './lib/browser_probe.ts';

const args = Bun.argv.slice(2);
const flag = (name: string): string | undefined => {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
};
const preferredPort = Number.parseInt(flag('--port') ?? '4390', 10);
const shotsDir = flag('--shots');
const headful = args.includes('--headful');
const only = flag('--tool');
const verbose = args.includes('--verbose');
const PHONE_DEVICE = {
	viewport: { ...PHONE_VIEWPORT, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
	userAgent:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};

interface Verdict {
	tool: string;
	expected: 'pass' | 'pending';
	ok: boolean;
	problems: string[];
	notes: string[];
}

// the repoint must precede the first dynamic import that connects
const { suiteDb } = resolveSuiteDatabase();
repointProcessToSuiteDatabase(suiteDb);
acquireSuiteRunLock(suiteDb, 'test:tools:phone'); // one suite run at a time

const { ensureSuiteLoginPassword, SUITE_LOGIN_PASSWORD } = await import(
	'../src/core/test_data/suite_login.ts'
);
await ensureSuiteLoginPassword('root', SUITE_LOGIN_PASSWORD);

const probes: { tool: string; probe: ToolPhoneProbe; expected: 'pass' | 'pending' }[] = [
	...Object.entries(PHONE_CASES).map(([tool, probe]) => ({
		tool,
		probe,
		expected: 'pass' as const,
	})),
	...Object.entries(NOT_YET_PHONE)
		.filter(([, entry]) => entry.probe !== undefined)
		.map(([tool, entry]) => ({
			tool,
			probe: entry.probe as ToolPhoneProbe,
			expected: 'pending' as const,
		})),
].filter((p) => only === undefined || only.split(',').includes(p.tool));

if (probes.length === 0 && !args.includes('--discover') && !args.includes('--overflow')) {
	console.error('no probes to run');
	process.exit(1);
}

const port = await findFreePort(preferredPort);
const server = await startClientTestServer({
	suiteDb,
	expectedFingerprint: await localSuiteFingerprint(),
	port,
	log: (m) => console.log(m),
});

const verdicts: Verdict[] = [];
// Same launch as scripts/client_test_runner.ts: the CI image runs chromium as an
// unprivileged user with no usable sandbox, and PUPPETEER_EXECUTABLE_PATH names it.
const executablePath = readEnv('PUPPETEER_EXECUTABLE_PATH');
const browser = await puppeteer.launch({
	headless: !headful,
	args: ['--no-sandbox', '--disable-setuid-sandbox'],
	...(executablePath ? { executablePath } : { channel: 'chrome' as const }),
});
try {
	// real login, cookie injected over CDP (HttpOnly) — as client_test_runner
	const { login } = await import('../src/core/security/auth.ts');
	const { SESSION_COOKIE } = await import('../src/core/security/session_store.ts');
	const { MEDIA_AUTH_COOKIE } = await import('../src/core/media/protection.ts');
	const session = await login('root', SUITE_LOGIN_PASSWORD, '127.0.0.1');
	if (!session.ok || session.sessionToken === undefined)
		throw new Error(`login refused: ${session.message}`);
	const { hostname } = new URL(server.origin);
	const sessionCookies = [
		{ name: SESSION_COOKIE, value: session.sessionToken, domain: hostname, path: '/' },
	];
	if (session.mediaAuthCookieValue) {
		sessionCookies.push({
			name: MEDIA_AUTH_COOKIE,
			value: session.mediaAuthCookieValue,
			domain: hostname,
			path: '/',
		});
	}
	await browser.setCookie(...sessionCookies);

	if (shotsDir) mkdirSync(shotsDir, { recursive: true });

	// --overflow <page query>: which elements widen a page past the phone
	// viewport (outermost offenders) — for the entry pages tools open from.
	const overflowQuery = flag('--overflow');
	if (overflowQuery !== undefined) {
		const page = await browser.newPage();
		guardDialogs(page);
		await page.emulate(PHONE_DEVICE);
		// `a|b|c`: visit each in turn (a user's path), report the last
		for (const q of overflowQuery.split('|')) {
			await page.goto(pageUrl(q), { waitUntil: 'networkidle0', timeout: 60_000 });
			await new Promise((r) => setTimeout(r, 1500));
		}
		const report = await page.evaluate((vw: number) => {
			const out: string[] = [
				`scrollWidth ${document.documentElement.scrollWidth} / viewport ${vw} (innerWidth ${window.innerWidth})`,
			];
			const wide = [...document.querySelectorAll('body *')].filter(
				(el) => el.getBoundingClientRect().right > vw + 1,
			);
			const outer = wide.filter(
				(el) => !el.parentElement || el.parentElement.getBoundingClientRect().right <= vw + 1,
			);
			// innermost: wide elements none of whose children are wide — the causes
			const inner = wide.filter(
				(el) => ![...el.children].some((c) => c.getBoundingClientRect().right > vw + 1),
			);
			for (const el of [
				...outer.slice(0, 8),
				...inner.slice(0, 12).map((e) => {
					(e as HTMLElement).dataset.inner = '1';
					return e;
				}),
			]) {
				const r = el.getBoundingClientRect();
				const cs = getComputedStyle(el);
				out.push(
					`${(el as HTMLElement).dataset.inner ? 'INNER ' : ''}${Math.round(r.left)}..${Math.round(r.right)} ${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').trim().split(/\s+/).slice(0, 3).join('.')} min-width:${cs.minWidth} width:${cs.width} white-space:${cs.whiteSpace}`,
				);
			}
			return out;
		}, PHONE_VIEWPORT.width);
		console.log(report.join('\n'));
		if (shotsDir) await page.screenshot({ path: join(shotsDir, 'overflow.png') });
		await page.close();
		probes.length = 0;
	}

	// --discover <section_tipo>/<section_id>: list which tools each live
	// instance of that record offers — the source for new probes.
	const discover = flag('--discover');
	if (discover !== undefined) {
		// <section_tipo>/<section_id> (edit) or <section_tipo>/list
		const [sectionTipo, sectionId] = discover.split('/');
		const mode = sectionId === 'list' ? 'list' : 'edit';
		const page = await browser.newPage();
		guardDialogs(page);
		await page.setViewport({ width: 1400, height: 900 });
		const query =
			mode === 'list'
				? `tipo=${sectionTipo}&mode=list`
				: `tipo=${sectionTipo}&section_id=${sectionId}&mode=edit`;
		await page.goto(`${server.origin}/dedalo/core/page/?${query}&menu=false`, {
			waitUntil: 'networkidle0',
			timeout: 60_000,
		});
		await new Promise((r) => setTimeout(r, 2000));
		const found = await page.evaluate(async () => {
			const spec = '/dedalo/core/common/js/instances.js';
			// biome-ignore lint/suspicious/noExplicitAny: a live instance of the untyped client JS, read inside the page
			const mod = (await import(spec)) as { get_all_instances: () => Array<Record<string, any>> };
			const out: Record<string, unknown> = {};
			for (const inst of mod.get_all_instances()) {
				for (const tool of [...(inst.context?.tools ?? []), ...(inst.tools ?? [])]) {
					out[`${tool.name} <- ${inst.model} ${inst.tipo}`] = {
						tipo: inst.tipo,
						section_tipo: inst.section_tipo,
						section_id: inst.section_id,
						mode: inst.mode,
						model: inst.model,
						lang: inst.lang,
					};
				}
			}
			return out;
		});
		for (const [k, v] of Object.entries(found).sort()) console.log(`${k}  ${JSON.stringify(v)}`);
		await page.close();
		probes.length = 0;
	}

	for (const { tool, probe, expected } of probes) {
		const problems: string[] = [];
		// console.error is INFO, not a verdict: on the suite database a tool
		// logs environment facts (a missing media file, no identify profile, an
		// external service down) that say nothing about the phone layout.
		// An UNCAUGHT error, or the tool rendering its error panel, is a verdict.
		const notes: string[] = [];
		const watch = (p: Page, who: string): void => {
			guardDialogs(p); // a blocking alert would freeze CDP
			onConsoleError(p, (text, where) => notes.push(`${text}${where}`));
			p.on('console', (msg) => {
				if (msg.type() !== 'error') return;
				if (verbose) {
					const arg = msg.args()[0];
					void arg
						?.evaluate((e) => (e instanceof Error ? e.stack : null))
						.then((stack) => {
							if (stack)
								notes.push(
									`stack: ${String(stack)
										.replace(/https?:\/\/[^/]+\/dedalo\//g, '')
										.slice(0, 700)}`,
								);
						})
						.catch(() => {});
				}
			});
			onPageError(p, (text) => problems.push(`pageerror (${who}): ${text.slice(0, 600)}`), true);
		};
		// A FRESH browser context per probe: each tool is judged on a first
		// visit, not on storage an earlier probe left behind (the list view
		// restores its search panel after a record visit, and that panel is
		// wider than a phone — a list/search finding, not the tool's).
		const context = await browser.createBrowserContext();
		let asFixture: { remove: () => Promise<void> } | null = null;
		if (probe.kind === 'method' && probe.as === 'door_reader') {
			// a NON-ADMIN user: the read-door identity fixture, minted and swept
			// around this probe, with its own session in this context
			const fixture = await import('../test/helpers/read_door_identity_fixture.ts');
			await fixture.installReadDoorIdentityFixture();
			asFixture = { remove: () => fixture.removeReadDoorIdentityFixture() };
			const { createSession } = await import('../src/core/security/session_store.ts');
			const { issueSessionMediaKey } = await import('../src/core/media/protection.ts');
			const token = createSession(
				fixture.DOOR_READER_USER_ID,
				'zzdoor_reader',
				false,
				issueSessionMediaKey(),
			);
			await context.setCookie({ name: SESSION_COOKIE, value: token, domain: hostname, path: '/' });
		} else {
			await context.setCookie(...sessionCookies);
		}
		const opener = await context.newPage();
		watch(opener, 'record page');
		await opener.emulate(PHONE_DEVICE);
		let toolPage: Page = opener;
		let built: { sweep: () => Promise<unknown> } | null = null;
		try {
			const opened = await openProbe(opener, tool, probe, (b) => {
				built = b;
			});
			toolPage = opened.page;
			if (toolPage !== opener) {
				watch(toolPage, 'tool window');
				await toolPage.emulate(PHONE_DEVICE);
				await toolPage.reload({ waitUntil: 'networkidle0', timeout: 45_000 });
			}
			const root = opened.root ?? `.wrapper_tool.${tool} > .content_data`;
			await toolPage.waitForSelector(root, { timeout: 30_000 });
			// late async panes: judge what the user sees once the tool settles,
			// not its first paint (the assistant builds its composer after)
			await toolPage.waitForNetworkIdle({ idleTime: 500, timeout: 20_000 }).catch(() => {});
			await new Promise((r) => setTimeout(r, 500));
			// a queue tool opens EMPTY. Queue one scratch file through its own
			// file input — the exact path a user takes to add files — so the
			// per-file ROW is rendered and judged. The row is where such a tool
			// actually breaks (an empty panel can look perfect while every queued
			// row is a clipped desktop grid), and a probe without this step
			// measures nothing but the empty toolbox.
			//
			// This runs on toolPage, so it works in whichever realm the tool
			// rendered (a modal stays in the opener; a window tool's instance
			// lives in its popup). No module import: the input's own change
			// handler does the work.
			if ((probe as { queue_file?: boolean }).queue_file) {
				const queued = await toolPage.evaluate((toolName: string) => {
					const input = document.querySelector<HTMLInputElement>(
						`.wrapper_tool.${toolName} .queue_file_input`,
					);
					if (!input) return 'no .queue_file_input on the opened tool';
					const transfer = new DataTransfer();
					transfer.items.add(
						new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'phone_probe.jpg', {
							type: 'image/jpeg',
						}),
					);
					input.files = transfer.files;
					input.dispatchEvent(new Event('change', { bubbles: true }));
					return 'ok';
				}, tool);
				if (queued !== 'ok') {
					problems.push(`queue_file: ${queued}`);
				} else {
					await toolPage
						.waitForSelector(`.wrapper_tool.${tool} .file-row`, { timeout: 10_000 })
						.catch(() => problems.push('queue_file: no .file-row rendered'));
					await new Promise((r) => setTimeout(r, 300));
				}
			}
			problems.push(...(await judge(toolPage, tool, toolPage === opener, opened.root)));
			if (shotsDir)
				await toolPage.screenshot({ path: join(shotsDir, `${tool}.png`), fullPage: true });
		} catch (err) {
			problems.push(`did not render: ${(err as Error).message.split('\n')[0]}`);
		} finally {
			if (toolPage !== opener) await toolPage.close().catch(() => {});
			await opener.close();
			await context.close();
			if (asFixture) await asFixture.remove();
			if (built) await (built as { sweep: () => Promise<unknown> }).sweep();
		}
		verdicts.push({ tool, expected, ok: problems.length === 0, problems, notes });
	}
} finally {
	await browser.close();
	await server.stop();
}

// report
let red = 0;
for (const v of verdicts) {
	const status =
		v.expected === 'pass'
			? v.ok
				? 'PASS'
				: 'FAIL'
			: v.ok
				? 'FAIL (pending tool passes — move it to PHONE_CASES)'
				: 'pending';
	if (status.startsWith('FAIL')) red++;
	console.log(`\n${status.padEnd(8)} ${v.tool}`);
	for (const p of v.problems.slice(0, 12)) console.log(`    - ${p}`);
	if (v.problems.length > 12) console.log(`    … ${v.problems.length - 12} more`);
	if (v.notes.length > 0 && (verbose || !v.ok)) {
		for (const n of [...new Set(v.notes)].slice(0, verbose ? 30 : 4))
			console.log(`    · console: ${n}`);
	}
}
console.log(`\n${verdicts.length} probed, ${red} red.`);
process.exit(red === 0 ? 0 : 1);

/** Create one scratch record in `sectionTipo` (suite DB only), armed for sweeping. */
async function buildRecord(
	sectionTipo: string,
): Promise<{ id: number; sweep: () => Promise<unknown> }> {
	const { assertTestDatabase } = await import('../src/core/test_data/test_database_marker.ts');
	await assertTestDatabase('tool_viewport_check.buildRecord');
	// the resolver needs the component-model registry, as every entrypoint loads it
	await import('../src/core/components/registry.ts');
	const { getMatrixTableFromTipo } = await import('../src/core/ontology/resolver.ts');
	const { armRunCreatedSweep } = await import('../src/core/test_data/run_created_records.ts');
	const { createSectionRecord } = await import('../src/core/section/record/create_record.ts');
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null)
		throw new Error(`build: '${sectionTipo}' has no matrix table on the suite database`);
	const sweeper = await armRunCreatedSweep(sectionTipo, table);
	const id = await createSectionRecord(sectionTipo, -1);
	return { id, sweep: () => sweeper.sweep() };
}

/** A section_tool node's target section, from the ontology. */
async function sectionToolTarget(sectionTool: string): Promise<string> {
	const { getPropertiesByTipo: getNodeProperties } = await import(
		'../src/core/ontology/resolver.ts'
	);
	const props = (await getNodeProperties(sectionTool)) as {
		config?: { target_section_tipo?: string };
	} | null;
	const target = props?.config?.target_section_tipo;
	if (!target)
		throw new Error(`section_tool '${sectionTool}' declares no config.target_section_tipo`);
	return target;
}

/**
 * THE CLICK PATH — how a user opens the tool (see ToolPhoneProbe for the five
 * kinds). A modal renders into `page`; a window tool's popup is followed.
 */
function pageUrl(query: string): string {
	return `${server.origin}/dedalo/core/page/?${query}`;
}

async function openProbe(
	page: Page,
	tool: string,
	probe: ToolPhoneProbe,
	onBuilt: (b: { sweep: () => Promise<unknown> }) => void,
): Promise<{ page: Page; root?: string }> {
	const openerTarget = page.target();
	const popup = page
		.browserContext()
		.waitForTarget((t) => t.opener() === openerTarget, { timeout: 20_000 })
		.then((t) => t.page())
		.catch(() => null);
	const follow = async (openAs: string): Promise<{ page: Page }> => {
		if (openAs === 'modal') return { page };
		const child = await popup;
		if (!child) throw new Error(`open_as '${openAs}' opened no window`);
		return { page: child };
	};
	const kind = probe.kind ?? 'context';

	if (probe.kind === 'click') {
		await page.goto(pageUrl(probe.url), { waitUntil: 'networkidle0', timeout: 60_000 });
		for (const selector of probe.clicks) {
			await page.waitForSelector(selector, { visible: true, timeout: 20_000 });
			try {
				await page.tap(selector); // a phone taps
			} catch (err) {
				const box = await page.$eval(selector, (el) => {
					const r = el.getBoundingClientRect();
					const cs = getComputedStyle(el);
					return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)} display:${cs.display} visibility:${cs.visibility} pointer-events:${cs.pointerEvents}`;
				});
				const widths = await page.evaluate(
					() =>
						`page ${document.documentElement.scrollWidth}/${window.innerWidth} visual ${window.visualViewport?.width}×${window.visualViewport?.scale}`,
				);
				throw new Error(`cannot tap '${selector}' (${box}; ${widths}): ${(err as Error).message}`);
			}
		}
		const child = await Promise.race([
			popup,
			new Promise<null>((r) => setTimeout(() => r(null), 3000)),
		]);
		return child ? { page: child, root: probe.root } : { page, root: probe.root };
	}

	if (probe.kind === 'module') {
		await page.goto(pageUrl(probe.url), { waitUntil: 'networkidle0', timeout: 60_000 });
		const result = await page.evaluate(
			async (spec: string, fn: string) => {
				const mod = (await import(spec)) as Record<string, () => Promise<unknown>>;
				if (typeof mod[fn] !== 'function') return `${spec} exports no ${fn}()`;
				const opened = await mod[fn]();
				return opened ? 'ok' : `${fn}() returned ${String(opened)}`;
			},
			probe.module,
			probe.fn,
		);
		if (result !== 'ok') throw new Error(result);
		const child = await Promise.race([
			popup,
			new Promise<null>((r) => setTimeout(() => r(null), 3000)),
		]);
		return { page: child ?? page, root: probe.root };
	}

	if (probe.kind === 'method') {
		await page.goto(pageUrl(probe.url), { waitUntil: 'networkidle0', timeout: 60_000 });
		const result = await page.evaluate(
			async (model: string, method: string) => {
				const spec = '/dedalo/core/common/js/instances.js';
				const { get_all_instances } = (await import(spec)) as {
					get_all_instances: () => Array<Record<string, any>>;
				};
				const instance = get_all_instances().find((i) => i.model === model);
				if (!instance || typeof instance[method] !== 'function')
					return `no live ${model} with ${method}()`;
				instance[method]();
				return 'ok';
			},
			probe.model,
			probe.method,
		);
		if (result !== 'ok') throw new Error(result);
		const child = await Promise.race([
			popup,
			new Promise<null>((r) => setTimeout(() => r(null), 3000)),
		]);
		return { page: child ?? page };
	}

	// the record-bearing kinds
	let url: string;
	let find: {
		tipo: string;
		sectionTipo: string;
		sectionId: string | null;
		mode: string;
		via: string;
		button?: string;
	};
	if (probe.kind === 'button') {
		if (probe.build) onBuilt(await buildRecord(probe.build));
		url = `tipo=${probe.section}&mode=list`;
		find = {
			tipo: probe.section,
			sectionTipo: probe.section,
			sectionId: null,
			mode: 'list',
			via: 'button',
			button: probe.button,
		};
	} else if (probe.kind === 'section_tool') {
		let selected: string | null = null;
		if (probe.build === 'target') {
			const b = await buildRecord(await sectionToolTarget(probe.section_tool));
			onBuilt(b);
			selected = String(b.id);
		}
		// `start` reroutes a section_tool URL (dd_core_api.ts): the page element
		// becomes the TARGET section and carries config.tool_context — so the
		// live instance is the target section, found by that config below.
		await page.goto(pageUrl(`tipo=${probe.section_tool}&mode=list&menu=false`), {
			waitUntil: 'networkidle0',
			timeout: 60_000,
		});
		url = '';
		find = {
			tipo: probe.section_tool,
			sectionTipo: probe.section_tool,
			sectionId: selected,
			mode: 'list',
			via: 'section_tool',
		};
	} else {
		const { caller } = probe as Extract<ToolPhoneProbe, { caller: unknown }>;
		let id = caller.section_id === null ? null : String(caller.section_id);
		if ((probe as { build?: string }).build) {
			const b = await buildRecord((probe as { build: string }).build);
			onBuilt(b);
			if (id === 'built') id = String(b.id);
		}
		url =
			caller.mode === 'list' || id === null
				? `tipo=${caller.section_tipo}&mode=list`
				: `tipo=${caller.section_tipo}&section_id=${id}&mode=edit`;
		find = {
			tipo: caller.tipo,
			sectionTipo: caller.section_tipo,
			sectionId: caller.mode === 'list' ? null : id,
			mode: caller.mode,
			via: kind,
		};
	}
	if (url !== '')
		await page.goto(pageUrl(`${url}&menu=false`), { waitUntil: 'networkidle0', timeout: 60_000 });

	// Components build lazily as they enter the viewport (when_in_viewport),
	// and a phone form is tall: scroll the way a user would until the caller
	// instance exists (or the page ends).
	if (find.via !== 'button' && find.via !== 'section_tool') {
		for (let step = 0; step < 40; step++) {
			const present = await page.evaluate(
				async (toolName: string, tipo: string) => {
					const spec = '/dedalo/core/common/js/instances.js';
					const { get_all_instances } = (await import(spec)) as {
						get_all_instances: () => Array<Record<string, any>>;
					};
					return get_all_instances().some(
						(i) =>
							i.tipo === tipo &&
							[...(i.context?.tools ?? []), ...(i.tools ?? [])].some(
								(t: { name: string }) => t.name === toolName,
							),
					);
				},
				tool,
				find.tipo,
			);
			if (present) break;
			const atEnd = await page.evaluate(() => {
				window.scrollBy(0, window.innerHeight * 0.8);
				return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
			});
			await page.waitForNetworkIdle({ idleTime: 300, timeout: 10_000 }).catch(() => {});
			if (atEnd) break;
		}
	}

	// The section_id match obeys the locator law (compareLocators: loose-numeric,
	// stored '05' matches 5) — decided HERE in Node, since the page cannot
	// import src/. The page lists its live candidates; Node picks by instance id.
	const liveIds = await page.evaluate(async (f: typeof find) => {
		const spec = '/dedalo/core/common/js/instances.js';
		const { get_all_instances } = (await import(spec)) as {
			get_all_instances: () => Array<Record<string, any>>;
		};
		return get_all_instances()
			.filter((i) => i.tipo === f.tipo && i.section_tipo === f.sectionTipo && i.mode === f.mode)
			.map((i) => ({
				id: String(i.id),
				section_tipo: String(i.section_tipo),
				section_id: i.section_id,
			}));
	}, find);
	const matchIds = liveIds
		.filter(
			(c) =>
				find.sectionId === null ||
				find.mode === 'list' ||
				compareLocators(
					{ section_tipo: c.section_tipo, section_id: c.section_id } as Locator,
					{ section_tipo: c.section_tipo, section_id: find.sectionId } as Locator,
					['section_tipo', 'section_id'],
				),
		)
		.map((c) => c.id);

	const opened = await page.evaluate(
		async (toolName: string, f: typeof find, ids: string[]) => {
			const instancesSpec = '/dedalo/core/common/js/instances.js';
			const toolSpec = '/dedalo/core/tools_common/js/tool_common.js';
			const { get_all_instances } = (await import(instancesSpec)) as {
				get_all_instances: () => Array<Record<string, any>>;
			};
			const { open_tool } = (await import(toolSpec)) as {
				open_tool: (o: object) => Promise<unknown>;
			};
			const all = get_all_instances();
			// biome-ignore lint/suspicious/noExplicitAny: a live instance of the untyped client JS, read inside the page
			const matches = (i: Record<string, any>) => ids.includes(String(i.id));
			if (f.via === 'button') {
				const section = all.find((i) => matches(i) && i.model === 'section');
				const button = (section?.context?.buttons ?? []).find(
					(b: { tipo: string }) => b.tipo === f.button,
				);
				if (!section || !button?.tools?.[0])
					return { error: `no button '${f.button}' with a tool on live '${f.tipo}'` };
				void open_tool({
					tool_context: button.tools[0],
					caller: section,
					caller_options: { section_tipo: section.section_tipo, button_tipo: button.tipo },
				});
				return { openAs: String(button.tools[0].properties?.open_as ?? 'modal') };
			}
			if (f.via === 'section_tool') {
				const section = all.find(
					(i) => i.model === 'section' && i.mode === 'list' && i.config?.tool_context,
				);
				const tool_context = section?.config?.tool_context;
				if (!tool_context) return { error: `live '${f.tipo}' carries no config.tool_context` };
				if (f.sectionId !== null) section.section_id_selected = Number(f.sectionId);
				void open_tool({ tool_context, caller: section });
				return { openAs: String(tool_context.properties?.open_as ?? 'modal') };
			}
			const offers = (i: Record<string, any>) =>
				[...(i.context?.tools ?? []), ...(i.tools ?? [])].find(
					(t: { name: string }) => t.name === toolName,
				);
			const instance = all.find((i) => matches(i) && offers(i));
			if (!instance) return { error: `no live '${f.tipo}' instance offering ${toolName}` };
			const tool_context = offers(instance);
			// a user taps the tool icon ON the element: it is on screen, and
			// elements that build lazily when visible (the JSON editor
			// tool_dd_label reads) have built
			instance.node?.scrollIntoView?.({ block: 'center' });
			await new Promise((r) => setTimeout(r, 1500));
			void open_tool({ tool_context, caller: instance });
			return { openAs: String(tool_context?.properties?.open_as ?? 'modal') };
		},
		tool,
		find,
		matchIds,
	);
	if ('error' in opened) throw new Error(opened.error as string);
	return follow(opened.openAs as string);
}

/**
 * The phone contract, measured in the page, SCOPED TO THE TOOL: its wrapper and
 * its header. Page chrome (the error-report tab, the developer debug button)
 * and, in modal mode, the record page behind the sheet are not the tool's.
 */
async function judge(
	page: Page,
	tool: string,
	isModal: boolean,
	customRoot?: string,
): Promise<string[]> {
	return await page.evaluate(
		(minTarget: number, toolName: string, modalMode: boolean, rootSel: string | null) => {
			const out: string[] = [];
			const vw = window.innerWidth;
			const roots = [
				...document.querySelectorAll(
					rootSel ?? `.wrapper_tool.${toolName}, .tool_header.${toolName}`,
				),
			];
			if (roots.length === 0) return [`no ${rootSel ?? `.wrapper_tool.${toolName}`} in the page`];
			// the tool's own error panel, or the page-level API error panel
			// (render_api_error.js) rendered inside the tool
			const errorPanel = document.querySelector(
				`.wrapper_tool.${toolName} .content_data_error, .wrapper_tool.${toolName} .tool_error, .wrapper_tool.${toolName} .api_error_panel`,
			);
			if (errorPanel)
				out.push(
					`tool rendered its ERROR panel: ${(errorPanel.textContent ?? '').trim().slice(0, 160)}`,
				);

			const describe = (el: Element): string => {
				const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/).slice(0, 3).join('.');
				const text = (el.textContent ?? '').trim().slice(0, 24);
				return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${text ? ` "${text}"` : ''}`;
			};

			// a control past the edge INSIDE an on-screen horizontal scroller
			// (overflow-x auto/scroll — a table box, the print tool's A4
			// preview) is reachable by panning that box, not the page
			const inContainedScroller = (el: Element): boolean => {
				for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
					const ox = getComputedStyle(a).overflowX;
					if (ox === 'auto' || ox === 'scroll') {
						const r = a.getBoundingClientRect();
						return r.right <= vw + 1 && r.left >= -1;
					}
				}
				return false;
			};
			if (modalMode) {
				// the page behind is the record page; judge the tool's own box
				for (const root of roots) {
					const r = root.getBoundingClientRect();
					if (r.right > vw + 1 || r.left < -1)
						out.push(`tool box off-screen: ${Math.round(r.left)}..${Math.round(r.right)}`);
					if (root.scrollWidth > root.clientWidth + 1) {
						out.push(`tool content wider than its box: ${root.scrollWidth} > ${root.clientWidth}`);
						// name the widest offenders (outermost first) so the fix has an address
						const culprits = [...root.querySelectorAll('*')]
							.filter((el) => el.getBoundingClientRect().right > vw + 1 && !inContainedScroller(el))
							.filter(
								(el) =>
									!el.parentElement || el.parentElement.getBoundingClientRect().right <= vw + 1,
							);
						for (const el of culprits.slice(0, 4)) {
							const r = el.getBoundingClientRect();
							out.push(
								`  overflows at ${Math.round(r.right)}px: ${describe(el)} (w ${Math.round(r.width)}, min-width ${getComputedStyle(el).minWidth})`,
							);
						}
					}
				}
			} else {
				const sw = document.documentElement.scrollWidth;
				if (sw > vw + 1) out.push(`page scrolls sideways: scrollWidth ${sw} > ${vw}`);
			}

			const selector =
				'button, select, input:not([type=hidden]), textarea, [role=button], .button.tool_button';
			const controls = new Set<Element>();
			for (const root of roots) for (const el of root.querySelectorAll(selector)) controls.add(el);
			for (const el of controls) {
				const r = el.getBoundingClientRect();
				if (r.width < 1 || r.height < 1) continue; // not rendered (a hidden file input)
				const style = getComputedStyle(el);
				// DISABLED controls are judged too: a disabled control is the same
				// target the moment it is enabled (the assistant's composer is
				// disabled on a server without the agent, and hid a 32px input)
				if (style.visibility === 'hidden') continue;
				// scrolled out of a contained scroller is fine; off the PAGE is not
				if (r.right > vw + 1 || r.left < -1) {
					if (!inContainedScroller(el))
						out.push(`off-screen (${Math.round(r.left)}..${Math.round(r.right)}): ${describe(el)}`);
				}
				const type = el.getAttribute('type');
				if (type === 'checkbox' || type === 'radio') continue; // judged by their label
				if (Math.min(r.width, r.height) < minTarget - 0.5) {
					out.push(`small target ${Math.round(r.width)}×${Math.round(r.height)}: ${describe(el)}`);
				}
			}
			// SQUEEZED TEXT: a column so narrow its words stand one letter per
			// line ("N/ú/m/e/r/o") passes every geometric check above and is
			// still unreadable. A visible text leaf of 4+ characters rendered
			// narrower than ~1.6 characters and taller than 3 lines is that.
			const leaves = new Set<Element>();
			for (const root of roots) {
				for (const el of root.querySelectorAll('*')) {
					if (el.children.length === 0 && (el.textContent ?? '').trim().length >= 4) leaves.add(el);
				}
			}
			let squeezed = 0;
			for (const el of leaves) {
				const r = el.getBoundingClientRect();
				if (r.width < 1 || r.height < 1) continue;
				const cs = getComputedStyle(el);
				if (cs.visibility === 'hidden' || cs.writingMode.startsWith('vertical')) continue;
				const fs = Number.parseFloat(cs.fontSize) || 16;
				// the CONTENT box: a padded cell hides a one-letter text column
				const contentWidth =
					r.width -
					(Number.parseFloat(cs.paddingLeft) || 0) -
					(Number.parseFloat(cs.paddingRight) || 0);
				if (contentWidth < fs * 1.6 && r.height > fs * 3) {
					if (squeezed++ < 5)
						out.push(
							`squeezed text ${Math.round(r.width)}×${Math.round(r.height)}: ${describe(el)}`,
						);
				}
			}
			if (squeezed > 5) out.push(`… ${squeezed - 5} more squeezed text nodes`);
			return out;
		},
		PHONE_HIT_TARGET_PX,
		tool,
		isModal,
		customRoot ?? null,
	);
}
